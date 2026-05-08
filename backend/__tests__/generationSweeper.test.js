import { describe, expect, it, vi } from 'vitest';
import {
  createGenerationSweeper,
  getAdHeartbeatTime,
  getBatchHeartbeatTime,
  getConductorHeartbeatTime,
} from '../services/generationSweeper.js';

const NOW = Date.parse('2026-05-06T04:00:00.000Z');

function harness({ ads = [], batches = [], runs = [] } = {}) {
  const adUpdates = [];
  const batchUpdates = [];
  const runUpdates = [];
  const settings = new Map();

  const sweeper = createGenerationSweeper({
    now: () => NOW,
    getAds: async () => ads,
    updateAd: async (id, fields) => adUpdates.push({ id, ...fields }),
    getActiveBatches: async () => batches,
    updateBatch: async (id, fields) => batchUpdates.push({ id, ...fields }),
    getActiveConductorRuns: async () => runs,
    updateConductorRun: async (id, fields) => runUpdates.push({ id, ...fields }),
    setSetting: async (key, value) => settings.set(key, value),
    getSetting: async (key) => settings.get(key) || null,
    console: { warn: vi.fn() },
  });

  return { sweeper, adUpdates, batchUpdates, runUpdates, settings };
}

describe('generation sweeper', () => {
  it('uses heartbeat timestamps before creation timestamps', () => {
    expect(getAdHeartbeatTime({
      created_at: '2026-05-06T03:00:00.000Z',
      last_progress_at: '2026-05-06T03:55:00.000Z',
    })).toBe(Date.parse('2026-05-06T03:55:00.000Z'));

    expect(getBatchHeartbeatTime({
      created_at: '2026-05-06T03:00:00.000Z',
      queued_at: '2026-05-06T03:05:00.000Z',
      started_at: '2026-05-06T03:10:00.000Z',
      last_heartbeat_at: '2026-05-06T03:56:00.000Z',
    })).toBe(Date.parse('2026-05-06T03:56:00.000Z'));

    expect(getConductorHeartbeatTime({
      created_at: Date.parse('2026-05-06T03:00:00.000Z'),
      run_at: Date.parse('2026-05-06T03:10:00.000Z'),
      scoring_started_at: Date.parse('2026-05-06T03:57:00.000Z'),
      last_heartbeat_at: '2026-05-06T03:58:00.000Z',
    })).toBe(Date.parse('2026-05-06T03:58:00.000Z'));

    expect(getConductorHeartbeatTime({
      created_at: Date.parse('2026-05-06T03:00:00.000Z'),
      run_at: Date.parse('2026-05-06T03:10:00.000Z'),
      scoring_started_at: Date.parse('2026-05-06T03:57:00.000Z'),
    })).toBe(Date.parse('2026-05-06T03:57:00.000Z'));
  });

  it('marks stale single ads failed with a [STALE] message', async () => {
    const { sweeper, adUpdates } = harness({
      ads: [{
        externalId: 'ad-stale',
        project_id: 'project-1',
        status: 'generating_image',
        created_at: '2026-05-06T03:00:00.000Z',
        last_progress_at: '2026-05-06T03:40:00.000Z',
      }],
    });

    const result = await sweeper();

    expect(result.healed).toHaveLength(1);
    expect(adUpdates).toHaveLength(1);
    expect(adUpdates[0]).toMatchObject({
      id: 'ad-stale',
      status: 'failed',
      failure_stage: 'stale_generation_sweeper',
      last_progress_at: '2026-05-06T04:00:00.000Z',
      completed_at: '2026-05-06T04:00:00.000Z',
    });
    expect(adUpdates[0].error_message).toContain('[STALE]');
  });

  it('does not mark fresh active ads stale when heartbeat is recent', async () => {
    const { sweeper, adUpdates } = harness({
      ads: [{
        externalId: 'ad-fresh',
        project_id: 'project-1',
        status: 'generating_image',
        created_at: '2026-05-06T03:00:00.000Z',
        last_progress_at: '2026-05-06T03:55:00.000Z',
      }],
    });

    const result = await sweeper();

    expect(result.healed).toHaveLength(0);
    expect(adUpdates).toHaveLength(0);
  });

  it('marks stale batches and conductor runs failed', async () => {
    const { sweeper, batchUpdates, runUpdates } = harness({
      batches: [{
        id: 'batch-stale',
        project_id: 'project-1',
        status: 'processing',
        created_at: '2026-05-06T03:00:00.000Z',
        last_heartbeat_at: '2026-05-06T03:39:00.000Z',
      }],
      runs: [{
        externalId: 'run-stale',
        project_id: 'project-1',
        status: 'running',
        run_at: Date.parse('2026-05-06T03:30:00.000Z'),
        created_at: Date.parse('2026-05-06T03:30:00.000Z'),
      }],
    });

    const result = await sweeper();

    expect(result.healed.map(h => h.kind)).toEqual(['batch_jobs', 'conductor_runs']);
    expect(batchUpdates[0]).toMatchObject({
      id: 'batch-stale',
      status: 'failed',
      stale_detected_at: '2026-05-06T04:00:00.000Z',
      last_heartbeat_at: '2026-05-06T04:00:00.000Z',
    });
    expect(batchUpdates[0].error_message).toContain('[STALE]');
    expect(runUpdates[0]).toMatchObject({
      id: 'run-stale',
      status: 'failed',
      terminal_status: 'stale_generation_sweeper',
      error_stage: 'stale_generation_sweeper',
    });
    expect(runUpdates[0].error).toContain('[STALE]');
  });

  it('does not mark a conductor run stale when last_heartbeat_at is fresh even if run_at is old', async () => {
    const { sweeper, runUpdates } = harness({
      runs: [{
        externalId: 'run-fresh-heartbeat',
        project_id: 'project-1',
        status: 'running',
        run_at: Date.parse('2026-05-06T03:40:00.000Z'),
        created_at: Date.parse('2026-05-06T03:40:00.000Z'),
        last_heartbeat_at: '2026-05-06T03:57:00.000Z',
      }],
    });

    const result = await sweeper();

    expect(result.healed).toHaveLength(0);
    expect(runUpdates).toHaveLength(0);
  });

  it('marks a conductor run stale when last_heartbeat_at is also old', async () => {
    const { sweeper, runUpdates } = harness({
      runs: [{
        externalId: 'run-old-heartbeat',
        project_id: 'project-1',
        status: 'running',
        run_at: Date.parse('2026-05-06T03:40:00.000Z'),
        created_at: Date.parse('2026-05-06T03:40:00.000Z'),
        last_heartbeat_at: '2026-05-06T03:44:00.000Z',
      }],
    });

    const result = await sweeper();

    expect(result.healed).toHaveLength(1);
    expect(runUpdates[0]).toMatchObject({
      id: 'run-old-heartbeat',
      status: 'failed',
      terminal_status: 'stale_generation_sweeper',
      error_stage: 'stale_generation_sweeper',
    });
  });

  it('uses active batch heartbeat for conductor runs waiting on Gemini', async () => {
    const { sweeper, runUpdates } = harness({
      batches: [{
        id: 'batch-active',
        project_id: 'project-1',
        status: 'processing',
        created_at: '2026-05-06T03:30:00.000Z',
        last_heartbeat_at: '2026-05-06T03:58:00.000Z',
      }],
      runs: [{
        externalId: 'run-waiting',
        project_id: 'project-1',
        status: 'running',
        terminal_status: 'waiting_on_gemini',
        run_at: Date.parse('2026-05-06T03:30:00.000Z'),
        created_at: Date.parse('2026-05-06T03:30:00.000Z'),
        batches_created: JSON.stringify([{ batch_id: 'batch-active' }]),
      }],
    });

    const result = await sweeper();

    expect(result.healed).toHaveLength(0);
    expect(runUpdates).toHaveLength(0);
  });

  it('persists successful sweep telemetry', async () => {
    const { sweeper, settings } = harness();

    await sweeper();

    expect(settings.get('generation_sweeper_last_success_at')).toBe('2026-05-06T04:00:00.000Z');
    const result = JSON.parse(settings.get('generation_sweeper_last_result_json'));
    expect(result).toMatchObject({
      success: true,
      checked_at: '2026-05-06T04:00:00.000Z',
      threshold_minutes: 10,
    });
  });

  it('uses [STALE-RECOVERY] in manual recovery mode', async () => {
    const { sweeper, adUpdates } = harness({
      ads: [{
        externalId: 'ad-manual',
        project_id: 'project-1',
        status: 'generating_copy',
        created_at: '2026-05-06T03:00:00.000Z',
      }],
    });

    await sweeper({ mode: 'manual-recovery' });

    expect(adUpdates[0]).toMatchObject({
      status: 'failed',
      failure_stage: 'manual_stale_generation_recovery',
    });
    expect(adUpdates[0].error_message).toContain('[STALE-RECOVERY]');
  });
});

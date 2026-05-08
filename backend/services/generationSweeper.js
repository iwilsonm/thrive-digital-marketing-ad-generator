import {
  api,
  getActiveBatchJobs,
  getSetting,
  mutationWithRetry,
  queryWithRetry,
  setSetting,
  updateBatchJob,
  updateConductorRun,
} from '../convexClient.js';

export const GENERATION_SWEEPER_THRESHOLD_MINUTES = 10;
export const GENERATION_SWEEPER_HEALTH_MAX_AGE_MINUTES = 60;

const LAST_SUCCESS_KEY = 'generation_sweeper_last_success_at';
const LAST_RESULT_KEY = 'generation_sweeper_last_result_json';
const LAST_ERROR_KEY = 'generation_sweeper_last_error_json';

const ACTIVE_AD_STATUSES = new Set([
  'generating_copy',
  'generating_image',
  'pending',
  'queued',
  'running',
  'processing',
]);

const ACTIVE_BATCH_STATUSES = new Set([
  'queued',
  'generating_prompts',
  'submitting',
  'processing',
  'saving_results',
]);

const ACTIVE_CONDUCTOR_STATUSES = new Set([
  'running',
  'scoring',
  'repairing',
  'processing',
]);

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesSince(timestampMs, nowMs) {
  if (!Number.isFinite(timestampMs)) return null;
  return Math.max(0, Math.round((nowMs - timestampMs) / 60000));
}

export function getAdHeartbeatTime(ad) {
  return parseTime(ad?.last_progress_at) ?? parseTime(ad?.created_at);
}

export function getBatchHeartbeatTime(batch) {
  return parseTime(batch?.last_heartbeat_at)
    ?? parseTime(batch?.started_at)
    ?? parseTime(batch?.queued_at)
    ?? parseTime(batch?.created_at);
}

function parseJSON(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function getConductorBatchHeartbeatTime(run, batches = []) {
  const terminalStatus = String(run?.terminal_status || '');
  if (!['waiting_on_gemini', 'queued_round', 'building_round'].includes(terminalStatus)) return null;

  const batchInfos = parseJSON(run?.batches_created, []);
  if (!Array.isArray(batchInfos) || batchInfos.length === 0) return null;

  const batchIds = new Set(batchInfos.map((info) => info?.batch_id).filter(Boolean));
  const times = (batches || [])
    .filter((batch) => batchIds.has(batch?.id) || batchIds.has(batch?.externalId))
    .map(getBatchHeartbeatTime)
    .filter(Number.isFinite);

  return times.length > 0 ? Math.max(...times) : null;
}

export function getConductorHeartbeatTime(run, batches = []) {
  return parseTime(run?.last_heartbeat_at)
    ?? parseTime(run?.scoring_started_at)
    ?? getConductorBatchHeartbeatTime(run, batches)
    ?? parseTime(run?.run_at)
    ?? parseTime(run?.created_at);
}

function isOlderThan(timestampMs, cutoffMs) {
  return timestampMs !== null && timestampMs <= cutoffMs;
}

function makeStaleMessage(kind, record, heartbeatMs, nowMs) {
  const age = minutesSince(heartbeatMs, nowMs);
  const ageText = age === null ? 'an unknown number of' : String(age);
  return `[STALE] ${kind} had no progress heartbeat for ${ageText} minutes. The request may have timed out, the worker may have stopped, or the SSE stream may have been interrupted. The item was marked failed so it cannot hang in the queue silently. Retry it from the UI. Previous status: ${record.status || 'unknown'}.`;
}

function makeManualRecoveryMessage(kind, record, heartbeatMs, nowMs) {
  const age = minutesSince(heartbeatMs, nowMs);
  const ageText = age === null ? 'an unknown number of' : String(age);
  return `[STALE-RECOVERY] ${kind} had no progress heartbeat for ${ageText} minutes and was manually marked failed during stuck-generation recovery. Previous status: ${record.status || 'unknown'}.`;
}

function summarizeRecord(kind, record, heartbeatMs, nowMs) {
  return {
    kind,
    id: record.externalId || record.id,
    project_id: record.project_id || null,
    status: record.status || null,
    heartbeat_at: heartbeatMs ? new Date(heartbeatMs).toISOString() : null,
    age_minutes: minutesSince(heartbeatMs, nowMs),
    error_message: record.error_message || record.error || record.failure_reason || null,
  };
}

export function createGenerationSweeper(customDeps = {}) {
  const deps = {
    now: () => Date.now(),
    getAds: async () => await queryWithRetry(api.adCreatives.getAll, {}),
    updateAd: async (id, fields) => {
      await mutationWithRetry(api.adCreatives.update, { externalId: id, ...fields });
    },
    getActiveBatches: getActiveBatchJobs,
    updateBatch: updateBatchJob,
    getActiveConductorRuns: async () => await queryWithRetry(api.conductor.getActiveRuns, {}),
    updateConductorRun,
    setSetting,
    getSetting,
    console,
    ...customDeps,
  };

  return async function sweepStaleGenerations(options = {}) {
    const thresholdMinutes = options.thresholdMinutes ?? GENERATION_SWEEPER_THRESHOLD_MINUTES;
    const mode = options.mode || 'cron';
    const nowMs = deps.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffMs = nowMs - thresholdMinutes * 60 * 1000;
    const healed = [];
    const updateFailures = [];

    const repairPrefix = mode === 'manual-recovery' ? makeManualRecoveryMessage : makeStaleMessage;

    const healAd = async (ad) => {
      const heartbeatMs = getAdHeartbeatTime(ad);
      if (!ACTIVE_AD_STATUSES.has(ad.status || '') || !isOlderThan(heartbeatMs, cutoffMs)) return;
      const message = repairPrefix('Single ad generation', ad, heartbeatMs, nowMs);
      await deps.updateAd(ad.externalId, {
        status: 'failed',
        error_message: message,
        failure_stage: mode === 'manual-recovery' ? 'manual_stale_generation_recovery' : 'stale_generation_sweeper',
        last_progress_at: nowIso,
        completed_at: nowIso,
      });
      healed.push(summarizeRecord('ad_creatives', { ...ad, error_message: message }, heartbeatMs, nowMs));
    };

    const healBatch = async (batch) => {
      const heartbeatMs = getBatchHeartbeatTime(batch);
      if (!ACTIVE_BATCH_STATUSES.has(batch.status || '') || !isOlderThan(heartbeatMs, cutoffMs)) return;
      const message = repairPrefix('Batch generation', batch, heartbeatMs, nowMs);
      await deps.updateBatch(batch.id || batch.externalId, {
        status: 'failed',
        error_message: message,
        stale_detected_at: nowIso,
        last_heartbeat_at: nowIso,
      });
      healed.push(summarizeRecord('batch_jobs', { ...batch, error_message: message }, heartbeatMs, nowMs));
    };

    const healConductorRun = async (run, batches = []) => {
      const heartbeatMs = getConductorHeartbeatTime(run, batches);
      if (!ACTIVE_CONDUCTOR_STATUSES.has(run.status || '') || !isOlderThan(heartbeatMs, cutoffMs)) return;
      const message = repairPrefix('Creative Director run', run, heartbeatMs, nowMs);
      await deps.updateConductorRun(run.externalId, {
        status: 'failed',
        terminal_status: mode === 'manual-recovery' ? 'manual_stale_recovery' : 'stale_generation_sweeper',
        error: message,
        failure_reason: message,
        error_stage: 'stale_generation_sweeper',
        duration_ms: run.run_at ? Math.max(0, nowMs - run.run_at) : undefined,
      });
      healed.push(summarizeRecord('conductor_runs', { ...run, error: message }, heartbeatMs, nowMs));
    };

    try {
      const [ads, batches, conductorRuns] = await Promise.all([
        deps.getAds(),
        deps.getActiveBatches(),
        deps.getActiveConductorRuns(),
      ]);

      for (const ad of ads || []) {
        try { await healAd(ad); }
        catch (err) {
          updateFailures.push({ kind: 'ad_creatives', id: ad.externalId, error: err.message });
          deps.console.warn(`[generation-sweeper] failed to heal ad ${ad.externalId}: ${err.message}`);
        }
      }

      for (const batch of batches || []) {
        try { await healBatch(batch); }
        catch (err) {
          updateFailures.push({ kind: 'batch_jobs', id: batch.id || batch.externalId, error: err.message });
          deps.console.warn(`[generation-sweeper] failed to heal batch ${batch.id || batch.externalId}: ${err.message}`);
        }
      }

      for (const run of conductorRuns || []) {
        try { await healConductorRun(run, batches || []); }
        catch (err) {
          updateFailures.push({ kind: 'conductor_runs', id: run.externalId, error: err.message });
          deps.console.warn(`[generation-sweeper] failed to heal conductor run ${run.externalId}: ${err.message}`);
        }
      }

      for (const entry of healed) {
        deps.console.warn(`[generation-sweeper] healed ${entry.kind} ${entry.id} (${entry.status}, age=${entry.age_minutes}m)`);
      }

      const result = {
        success: updateFailures.length === 0,
        checked_at: nowIso,
        threshold_minutes: thresholdMinutes,
        mode,
        scanned: {
          ads: (ads || []).length,
          batches: (batches || []).length,
          conductor_runs: (conductorRuns || []).length,
        },
        healed,
        update_failures: updateFailures,
      };

      await deps.setSetting(LAST_SUCCESS_KEY, nowIso).catch(() => {});
      await deps.setSetting(LAST_RESULT_KEY, JSON.stringify(result).slice(0, 12000)).catch(() => {});
      if (updateFailures.length === 0) {
        await deps.setSetting(LAST_ERROR_KEY, '').catch(() => {});
      }
      return result;
    } catch (err) {
      const errorResult = {
        success: false,
        checked_at: nowIso,
        threshold_minutes: thresholdMinutes,
        mode,
        error: err.message,
      };
      await deps.setSetting(LAST_ERROR_KEY, JSON.stringify(errorResult).slice(0, 4000)).catch(() => {});
      throw err;
    }
  };
}

export const sweepStaleGenerations = createGenerationSweeper();

export async function getGenerationSweeperHealth(options = {}) {
  const maxAgeMinutes = options.maxAgeMinutes ?? GENERATION_SWEEPER_HEALTH_MAX_AGE_MINUTES;
  const nowMs = Date.now();
  const [lastSuccessAt, lastResultRaw, lastErrorRaw] = await Promise.all([
    getSetting(LAST_SUCCESS_KEY),
    getSetting(LAST_RESULT_KEY),
    getSetting(LAST_ERROR_KEY),
  ]);

  const lastSuccessMs = parseTime(lastSuccessAt);
  const ageMinutes = minutesSince(lastSuccessMs, nowMs);
  let lastResult = null;
  let lastError = null;
  try { lastResult = lastResultRaw ? JSON.parse(lastResultRaw) : null; } catch {}
  try { lastError = lastErrorRaw ? JSON.parse(lastErrorRaw) : null; } catch {}

  return {
    ok: lastSuccessMs !== null && nowMs - lastSuccessMs <= maxAgeMinutes * 60 * 1000,
    last_success_at: lastSuccessAt || null,
    age_minutes: ageMinutes,
    max_age_minutes: maxAgeMinutes,
    last_result: lastResult,
    last_error: lastError,
  };
}

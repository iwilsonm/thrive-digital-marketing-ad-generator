import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetActiveBatchJobs = vi.fn();
const mockGetQueuedBatchJobs = vi.fn();
const mockGetScheduledBatchJobs = vi.fn();
const mockClaimBatchWork = vi.fn();
const mockReleaseBatchWork = vi.fn();
const mockUpdateBatchJob = vi.fn();
const mockQueueScheduledBatchRun = vi.fn();
const mockPollBatchJob = vi.fn();
const mockRunBatch = vi.fn();
const mockResumeBackgroundTestRuns = vi.fn();
const mockStartQueuedTestRuns = vi.fn();

vi.mock('../convexClient.js', () => ({
  getActiveBatchJobs: (...args) => mockGetActiveBatchJobs(...args),
  getQueuedBatchJobs: (...args) => mockGetQueuedBatchJobs(...args),
  getScheduledBatchJobs: (...args) => mockGetScheduledBatchJobs(...args),
  claimBatchWork: (...args) => mockClaimBatchWork(...args),
  releaseBatchWork: (...args) => mockReleaseBatchWork(...args),
  updateBatchJob: (...args) => mockUpdateBatchJob(...args),
  queueScheduledBatchRun: (...args) => mockQueueScheduledBatchRun(...args),
}));

vi.mock('../services/batchProcessor.js', () => ({
  pollBatchJob: (...args) => mockPollBatchJob(...args),
  runBatch: (...args) => mockRunBatch(...args),
}));

vi.mock('../services/conductorEngine.js', () => ({
  resumeBackgroundTestRuns: (...args) => mockResumeBackgroundTestRuns(...args),
  startQueuedTestRuns: (...args) => mockStartQueuedTestRuns(...args),
}));

const batch = (overrides = {}) => ({
  id: 'batch-001',
  status: 'processing',
  scheduled: 0,
  schedule_cron: null,
  gemini_batch_job: 'batches/test',
  created_at: '2026-05-02T00:00:00.000Z',
  started_at: '2026-05-02T00:00:00.000Z',
  last_heartbeat_at: '2026-05-02T00:00:00.000Z',
  ...overrides,
});

describe('batch scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveBatchJobs.mockResolvedValue([]);
    mockGetQueuedBatchJobs.mockResolvedValue([]);
    mockGetScheduledBatchJobs.mockResolvedValue([]);
    mockClaimBatchWork.mockImplementation(async (id) => ({ claimed: true, batch: batch({ id }) }));
    mockReleaseBatchWork.mockResolvedValue({ released: true });
    mockUpdateBatchJob.mockResolvedValue();
    mockQueueScheduledBatchRun.mockResolvedValue({ queued: true });
    mockPollBatchJob.mockResolvedValue('processing');
    mockRunBatch.mockResolvedValue();
    mockResumeBackgroundTestRuns.mockResolvedValue({ checked: 0, resumed: 0, errors: 0 });
    mockStartQueuedTestRuns.mockResolvedValue({ checked: 0, started: 0, queued_remaining: 0, errors: 0 });
  });

  it('requeues stale pre-Gemini batches before failing them', async () => {
    const stale = batch({
      status: 'generating_prompts',
      gemini_batch_job: null,
      last_heartbeat_at: '2000-01-01T00:00:00.000Z',
      retry_count: 0,
    });
    mockGetActiveBatchJobs.mockResolvedValue([stale]);
    mockClaimBatchWork.mockResolvedValue({ claimed: true, batch: stale });

    const { runSchedulerOnce } = await import('../services/scheduler.js');
    await runSchedulerOnce({ source: 'test', owner: 'test-owner' });

    expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-001', expect.objectContaining({
      status: 'queued',
      retry_count: 1,
      stale_detected_at: expect.any(String),
    }));
    expect(mockPollBatchJob).not.toHaveBeenCalled();
  });

  it('marks stale pre-Gemini batches failed after retry limit', async () => {
    const stale = batch({
      status: 'generating_prompts',
      gemini_batch_job: null,
      last_heartbeat_at: '2000-01-01T00:00:00.000Z',
      retry_count: 2,
    });
    mockGetActiveBatchJobs.mockResolvedValue([stale]);
    mockClaimBatchWork.mockResolvedValue({ claimed: true, batch: stale });

    const { runSchedulerOnce } = await import('../services/scheduler.js');
    await runSchedulerOnce({ source: 'test', owner: 'test-owner' });

    expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-001', expect.objectContaining({
      status: 'failed',
      stale_detected_at: expect.any(String),
    }));
    expect(mockPollBatchJob).not.toHaveBeenCalled();
  });

  it('preserves billing error messages through the stale pre-Gemini check', async () => {
    const billingMessage = 'OpenAI account has zero usable quota for gpt-5.2. Top up billing at https://platform.openai.com/account/billing or rotate to a key with usable quota.';
    const stale = batch({
      status: 'generating_prompts',
      gemini_batch_job: null,
      last_heartbeat_at: '2000-01-01T00:00:00.000Z',
      retry_count: 0,
      error_message: billingMessage,
    });
    mockGetActiveBatchJobs.mockResolvedValue([stale]);
    mockClaimBatchWork.mockResolvedValue({ claimed: true, batch: stale });

    const { runSchedulerOnce } = await import('../services/scheduler.js');
    await runSchedulerOnce({ source: 'test', owner: 'test-owner' });

    expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-001', expect.objectContaining({
      status: 'failed',
      error_message: billingMessage,
      stale_detected_at: expect.any(String),
    }));
    const update = mockUpdateBatchJob.mock.calls.find(([id]) => id === 'batch-001')?.[1];
    expect(update.error_message).not.toBe('Batch stalled before Gemini submission. No image job was created, so it is safe to retry.');
    expect(JSON.parse(update.pipeline_state)).toMatchObject({
      stage: 'billing_exhausted_pre_gemini',
    });
    expect(mockPollBatchJob).not.toHaveBeenCalled();
  });

  it('polls processing batches through Gemini when a job exists', async () => {
    const active = batch({ status: 'processing', gemini_batch_job: 'batches/test' });
    mockGetActiveBatchJobs.mockResolvedValue([active]);
    mockClaimBatchWork.mockResolvedValue({ claimed: true, batch: active });

    const { runSchedulerOnce } = await import('../services/scheduler.js');
    await runSchedulerOnce({ source: 'test', owner: 'test-owner' });

    expect(mockPollBatchJob).toHaveBeenCalledWith('batch-001');
    expect(mockReleaseBatchWork).toHaveBeenCalledWith('batch-001', 'test-owner');
  });

  it('resumes background Director test runs after polling completed Gemini batches', async () => {
    const active = batch({ status: 'processing', gemini_batch_job: 'batches/test' });
    mockGetActiveBatchJobs.mockResolvedValue([active]);
    mockClaimBatchWork.mockResolvedValue({ claimed: true, batch: active });
    mockPollBatchJob.mockResolvedValue('completed');
    mockResumeBackgroundTestRuns.mockResolvedValue({ checked: 1, resumed: 1, errors: 0 });

    const { runSchedulerOnce } = await import('../services/scheduler.js');
    const result = await runSchedulerOnce({ source: 'test', owner: 'test-owner' });

    expect(mockPollBatchJob).toHaveBeenCalledWith('batch-001');
    expect(mockResumeBackgroundTestRuns).toHaveBeenCalledTimes(1);
    expect(mockStartQueuedTestRuns).toHaveBeenCalledWith(expect.objectContaining({
      limit: 1,
      owner: 'test-owner',
    }));
    expect(result.conductor).toEqual({ checked: 1, resumed: 1, errors: 0 });
  });

  it('runs only one queued batch per tick and releases its lease', async () => {
    mockGetQueuedBatchJobs.mockResolvedValue([
      batch({ id: 'batch-a', status: 'queued', gemini_batch_job: null }),
      batch({ id: 'batch-b', status: 'queued', gemini_batch_job: null }),
    ]);
    mockClaimBatchWork.mockImplementation(async (id) => ({ claimed: true, batch: batch({ id, status: 'queued' }) }));

    const { runSchedulerOnce } = await import('../services/scheduler.js');
    await runSchedulerOnce({ source: 'test', owner: 'test-owner' });

    expect(mockRunBatch).toHaveBeenCalledTimes(1);
    expect(mockRunBatch).toHaveBeenCalledWith('batch-a');
    expect(mockReleaseBatchWork).toHaveBeenCalledWith('batch-a', 'test-owner');
  });
});

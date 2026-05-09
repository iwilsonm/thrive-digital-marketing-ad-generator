import {
  claimBatchWork,
  getActiveBatchJobs,
  getQueuedBatchJobs,
  getScheduledBatchJobs,
  queueScheduledBatchRun,
  releaseBatchWork,
  updateBatchJob,
} from '../convexClient.js';
import { pollBatchJob, runBatch } from './batchProcessor.js';

const POLL_INTERVAL_MS = 60 * 1000;
const LEASE_MS = 4 * 60 * 1000;
const PRE_GEMINI_STALE_MS = 6 * 60 * 1000;
const SAVING_RESULTS_STALE_MS = 10 * 60 * 1000;
const MAX_BATCH_RUNS_PER_TICK = 1;
const MAX_QUEUED_TEST_STARTS_PER_TICK = 1;
const PRE_GEMINI_RETRY_LIMIT = 2;
const ACTIVE_STATUSES = new Set(['queued', 'generating_prompts', 'submitting', 'processing', 'saving_results']);

let intervalHandle = null;
let tickInProgress = false;
const runningBatchIds = new Set();
const pollingBatchIds = new Set();
const scheduledMinuteRuns = new Set();

const state = {
  initialized: false,
  startedAt: null,
  lastTickAt: null,
  lastPollAt: null,
  lastScheduleScanAt: null,
  lastError: null,
  pollIntervalMs: POLL_INTERVAL_MS,
  activePolls: 0,
  activeRuns: 0,
  scheduledCount: 0,
  queuedCount: 0,
  lastCronResult: null,
  lastConductorResumeAt: null,
  lastConductorResumeResult: null,
};

function localMinuteKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('-');
}

function normalizeCronValue(value, field) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  if (field === 'dow' && parsed === 7) return 0;
  return parsed;
}

function cronFieldMatches(expression, value, min, max, field) {
  if (!expression || expression === '*') return true;

  return expression.split(',').some((part) => {
    const trimmed = part.trim();
    if (!trimmed) return false;

    if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      return Number.isFinite(step) && step > 0 && (value - min) % step === 0;
    }

    const [rangeExpr, stepExpr] = trimmed.split('/');
    const step = stepExpr ? parseInt(stepExpr, 10) : 1;
    if (!Number.isFinite(step) || step < 1) return false;

    if (rangeExpr.includes('-')) {
      const [rawStart, rawEnd] = rangeExpr.split('-');
      const start = normalizeCronValue(rawStart, field);
      const end = normalizeCronValue(rawEnd, field);
      if (start === null || end === null) return false;

      const inRange = start <= end
        ? value >= start && value <= end
        : value >= start || value <= end;
      return inRange && ((value - start + (max - min + 1)) % step === 0);
    }

    const target = normalizeCronValue(rangeExpr, field);
    return target !== null && value === target;
  });
}

export function cronMatchesDate(cronExpression, date = new Date()) {
  if (!cronExpression || typeof cronExpression !== 'string') return false;
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const minuteOk = cronFieldMatches(minute, date.getMinutes(), 0, 59, 'minute');
  const hourOk = cronFieldMatches(hour, date.getHours(), 0, 23, 'hour');
  const monthOk = cronFieldMatches(month, date.getMonth() + 1, 1, 12, 'month');
  const domOk = cronFieldMatches(dayOfMonth, date.getDate(), 1, 31, 'dom');
  const dowOk = cronFieldMatches(dayOfWeek, date.getDay(), 0, 6, 'dow');

  const dayOk = dayOfMonth !== '*' && dayOfWeek !== '*'
    ? domOk || dowOk
    : domOk && dowOk;

  return minuteOk && hourOk && monthOk && dayOk;
}

function isStale(batch, staleMs, now = Date.now()) {
  const heartbeat = batch.last_heartbeat_at || batch.started_at || batch.queued_at || batch.created_at;
  if (!heartbeat) return true;
  const ts = Date.parse(heartbeat);
  return !Number.isFinite(ts) || now - ts > staleMs;
}

function isBillingExhaustedMessage(message) {
  return /BILLING_EXHAUSTED|account has zero usable quota|Top up billing|insufficient_quota|credit balance is too low|enable billing|set up billing/i.test(String(message || ''));
}

async function runClaimedBatch(batchId, source, owner) {
  if (runningBatchIds.has(batchId)) return { started: false, reason: 'already_running' };
  runningBatchIds.add(batchId);
  state.activeRuns = runningBatchIds.size;
  try {
    await runBatch(batchId);
    return { started: true };
  } catch (err) {
    console.error(`[Scheduler] ${source} batch ${batchId.slice(0, 8)} failed:`, err.message);
    return { started: true, error: err.message };
  } finally {
    runningBatchIds.delete(batchId);
    state.activeRuns = runningBatchIds.size;
    await releaseBatchWork(batchId, owner).catch((err) => {
      console.warn(`[Scheduler] Could not release run lease for ${batchId.slice(0, 8)}: ${err.message}`);
    });
  }
}

async function pollActiveBatches(owner) {
  const activeBatches = await getActiveBatchJobs();
  state.lastPollAt = new Date().toISOString();

  const polls = [];
  for (const batch of activeBatches) {
    if (!batch?.id || pollingBatchIds.has(batch.id)) continue;

    const claim = await claimBatchWork(batch.id, owner, LEASE_MS).catch((err) => {
      console.warn(`[Scheduler] Could not claim batch ${batch.id.slice(0, 8)} for polling: ${err.message}`);
      return { claimed: false, reason: 'claim_error' };
    });
    if (!claim.claimed) continue;

    pollingBatchIds.add(batch.id);
    state.activePolls = pollingBatchIds.size;
    polls.push(
      handleClaimedActiveBatch(claim.batch || batch, owner)
        .catch((err) => {
          console.error(`[Scheduler] Poll failed for batch ${batch.id.slice(0, 8)}:`, err.message);
        })
        .finally(() => {
          pollingBatchIds.delete(batch.id);
          state.activePolls = pollingBatchIds.size;
          return releaseBatchWork(batch.id, owner).catch((err) => {
            console.warn(`[Scheduler] Could not release poll lease for ${batch.id.slice(0, 8)}: ${err.message}`);
          });
        })
    );
  }

  await Promise.allSettled(polls);
}

async function handleClaimedActiveBatch(batch, owner) {
  const now = Date.now();
  if (['generating_prompts', 'submitting'].includes(batch.status) && !batch.gemini_batch_job) {
    if (isStale(batch, PRE_GEMINI_STALE_MS, now)) {
      const detectedAt = new Date().toISOString();
      if (isBillingExhaustedMessage(batch.error_message)) {
        await updateBatchJob(batch.id, {
          status: 'failed',
          error_message: batch.error_message,
          stale_detected_at: detectedAt,
          last_heartbeat_at: detectedAt,
          pipeline_state: JSON.stringify({
            stage: 'billing_exhausted_pre_gemini',
            failed_at: detectedAt,
            previous_status: batch.status,
            last_heartbeat_at: batch.last_heartbeat_at || null,
          }),
        });
        return 'failed';
      }
      const retryCount = batch.retry_count || 0;
      if (retryCount < PRE_GEMINI_RETRY_LIMIT) {
        await updateBatchJob(batch.id, {
          status: 'queued',
          error_message: null,
          retry_count: retryCount + 1,
          queued_at: detectedAt,
          stale_detected_at: detectedAt,
          last_heartbeat_at: detectedAt,
          pipeline_state: JSON.stringify({
            stage: 'stale_pre_gemini_retry',
            retried_at: detectedAt,
            retry_count: retryCount + 1,
            previous_status: batch.status,
            last_heartbeat_at: batch.last_heartbeat_at || null,
          }),
        });
        return 'queued';
      }

      await updateBatchJob(batch.id, {
        status: 'failed',
        error_message: 'Batch stalled before Gemini submission. No image job was created, so it is safe to retry.',
        stale_detected_at: detectedAt,
        last_heartbeat_at: detectedAt,
        pipeline_state: JSON.stringify({
          stage: 'stale_pre_gemini',
          failed_at: detectedAt,
          previous_status: batch.status,
          last_heartbeat_at: batch.last_heartbeat_at || null,
        }),
      });
      return 'failed';
    }
    return 'processing';
  }

  if (batch.status === 'saving_results') {
    if (!isStale(batch, SAVING_RESULTS_STALE_MS, now)) return 'processing';
    await updateBatchJob(batch.id, {
      status: 'processing',
      last_heartbeat_at: new Date().toISOString(),
    });
  }

  return await pollBatchJob(batch.id);
}

async function runDueScheduledBatches(now = new Date()) {
  const scheduledBatches = await getScheduledBatchJobs();
  state.lastScheduleScanAt = new Date().toISOString();
  state.scheduledCount = scheduledBatches.length;

  const minuteKey = localMinuteKey(now);
  for (const batch of scheduledBatches) {
    if (!batch?.id || !batch.schedule_cron) continue;
    if (!cronMatchesDate(batch.schedule_cron, now)) continue;
    if (ACTIVE_STATUSES.has(batch.status) || runningBatchIds.has(batch.id)) continue;

    const runKey = `${batch.id}:${minuteKey}`;
    if (scheduledMinuteRuns.has(runKey)) continue;

    const queued = await queueScheduledBatchRun(batch.id, runKey).catch((err) => {
      console.error(`[Scheduler] Could not queue scheduled batch ${batch.id.slice(0, 8)}:`, err.message);
      return { queued: false, reason: 'queue_error' };
    });
    if (queued.queued) {
      scheduledMinuteRuns.add(runKey);
      console.log(`[Scheduler] Queued scheduled batch ${batch.id.slice(0, 8)} (${batch.schedule_cron})`);
    }
  }

  if (scheduledMinuteRuns.size > 2000) {
    const currentKeys = new Set(scheduledBatches.map((batch) => `${batch.id}:${minuteKey}`));
    for (const key of scheduledMinuteRuns) {
      if (!currentKeys.has(key)) scheduledMinuteRuns.delete(key);
    }
  }
}

async function runQueuedBatches(owner) {
  const queuedBatches = await getQueuedBatchJobs();
  state.queuedCount = queuedBatches.length;
  let started = 0;
  let failed = 0;

  for (const batch of queuedBatches) {
    if (started >= MAX_BATCH_RUNS_PER_TICK) break;
    if (!batch?.id || runningBatchIds.has(batch.id)) continue;

    const claim = await claimBatchWork(batch.id, owner, LEASE_MS).catch((err) => {
      console.warn(`[Scheduler] Could not claim queued batch ${batch.id.slice(0, 8)}: ${err.message}`);
      return { claimed: false, reason: 'claim_error' };
    });
    if (!claim.claimed) continue;

    console.log(`[Scheduler] Starting queued batch ${batch.id.slice(0, 8)}`);
    const result = await runClaimedBatch(batch.id, 'queued', owner);
    if (result.started) started += 1;
    if (result.error) failed += 1;
  }

  return { queued: queuedBatches.length, started, failed };
}

async function resumeBackgroundDirectorTests() {
  const { resumeBackgroundTestRuns } = await import('./conductorEngine.js');
  const result = await resumeBackgroundTestRuns();
  state.lastConductorResumeAt = new Date().toISOString();
  state.lastConductorResumeResult = result || { success: true };
  return state.lastConductorResumeResult;
}

async function runQueuedDirectorTests(owner) {
  const { startQueuedTestRuns } = await import('./conductorEngine.js');
  return await startQueuedTestRuns({ owner, limit: MAX_QUEUED_TEST_STARTS_PER_TICK, leaseMs: LEASE_MS });
}

async function schedulerTick(options = {}) {
  if (tickInProgress) return;
  tickInProgress = true;
  const owner = options.owner || `${options.source || 'scheduler'}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

  try {
    await pollActiveBatches(owner);
    const conductorResumeResult = await resumeBackgroundDirectorTests();
    const conductorQueueResult = await runQueuedDirectorTests(owner);
    await runDueScheduledBatches();
    const queueResult = await runQueuedBatches(owner);
    state.lastTickAt = new Date().toISOString();
    state.lastError = null;
    state.lastCronResult = queueResult;
    return { success: true, scheduler: getSchedulerStatus(), queue: queueResult, conductor: conductorResumeResult, conductorQueue: conductorQueueResult };
  } catch (err) {
    state.lastError = err.message;
    console.error('[Scheduler] Tick failed:', err.message);
    return { success: false, error: err.message, scheduler: getSchedulerStatus() };
  } finally {
    tickInProgress = false;
  }
}

export async function runSchedulerOnce(options = {}) {
  return await schedulerTick(options);
}

export function initializeScheduler() {
  if (state.initialized) return getSchedulerStatus();

  state.initialized = true;
  state.startedAt = new Date().toISOString();
  intervalHandle = setInterval(() => {
    void schedulerTick();
  }, POLL_INTERVAL_MS);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  void schedulerTick();
  console.log(`[Scheduler] Initialized batch polling/schedule loop (${POLL_INTERVAL_MS / 1000}s)`);
  return getSchedulerStatus();
}

export function getSchedulerStatus() {
  return {
    ...state,
    activePolls: pollingBatchIds.size,
    activeRuns: runningBatchIds.size,
  };
}

export function registerCronJob(batch) {
  if (!batch?.id) return;
  console.log(`[Scheduler] Registered scheduled batch ${batch.id.slice(0, 8)} (${batch.schedule_cron || 'no cron'})`);
}

export function unregisterCronJob(batchId) {
  if (!batchId) return;
  for (const key of scheduledMinuteRuns) {
    if (key.startsWith(`${batchId}:`)) scheduledMinuteRuns.delete(key);
  }
  console.log(`[Scheduler] Unregistered scheduled batch ${batchId.slice(0, 8)}`);
}

export async function loadScheduledBatches() {
  const scheduledBatches = await getScheduledBatchJobs();
  state.scheduledCount = scheduledBatches.length;
  return scheduledBatches;
}

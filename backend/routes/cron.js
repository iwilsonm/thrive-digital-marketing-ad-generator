// Phase 3 — Cron-only routes invoked by Vercel Cron.
//
// Vercel Cron sends Authorization: Bearer ${CRON_SECRET} automatically when
// CRON_SECRET is set in env vars. We validate with timing-safe compare and
// reject anything else with 401. Also adds a 30-min last-run guard to prevent
// replay storms even with valid secrets.

import { Router } from 'express';
import { runAllProjectsObservation } from '../services/observationTracker.js';
import { runSchedulerOnce } from '../services/scheduler.js';
import { runDirectorCycle } from '../services/conductorEngine.js';
import { sweepStaleGenerations } from '../services/generationSweeper.js';
import { getSetting } from '../convexClient.js';
import { getCronSecret, isValidCronBearer } from '../security.js';

const router = Router();

const LAST_RUN_GUARD_MS = 30 * 60 * 1000; // 30 minutes

async function requireCronSecret(req, res, next) {
  // Prefer Vercel's standard CRON_SECRET, but retain the legacy "Chron" name
  // used in this deployment's older cron code.
  const secret = getCronSecret();
  if (!secret) {
    console.error('[cron] CRON_SECRET/Chron env var not configured — rejecting request');
    return res.status(500).json({ error: 'Cron not configured on this deployment.' });
  }
  if (!isValidCronBearer(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.post('/observation', requireCronSecret, async (req, res) => {
  try {
    const lastRunRaw = await getSetting('phase3_last_cron_run_at');
    if (lastRunRaw) {
      const last = parseInt(lastRunRaw, 10);
      if (Number.isFinite(last) && Date.now() - last < LAST_RUN_GUARD_MS) {
        return res.status(200).json({
          skipped: true,
          reason: `Last run was ${Math.round((Date.now() - last) / 1000)}s ago — too soon. Guard threshold: ${LAST_RUN_GUARD_MS / 1000}s.`,
        });
      }
    }
    const result = await runAllProjectsObservation();
    res.json({ success: true, result });
  } catch (err) {
    console.error('[cron observation] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

async function runBatchCron(req, res) {
  try {
    const result = await runSchedulerOnce({ source: 'vercel-cron' });
    res.json({ success: result?.success !== false, result });
  } catch (err) {
    console.error('[cron batches] failed:', err);
    res.status(500).json({ error: err.message });
  }
}

router.get('/batches', requireCronSecret, runBatchCron);
router.post('/batches', requireCronSecret, runBatchCron);

async function runGenerationSweeperCron(req, res) {
  try {
    const result = await sweepStaleGenerations({ source: 'vercel-cron' });
    res.json({ success: result?.success !== false, result });
  } catch (err) {
    console.error('[cron generation-sweeper] failed:', err);
    res.status(500).json({ error: err.message });
  }
}

router.get('/generation-sweeper', requireCronSecret, runGenerationSweeperCron);
router.post('/generation-sweeper', requireCronSecret, runGenerationSweeperCron);

async function runDirectorCron(req, res) {
  try {
    const result = await runDirectorCycle('planning');
    res.json({ success: true, result: result || [] });
  } catch (err) {
    console.error('[cron director] failed:', err);
    res.status(500).json({ error: err.message });
  }
}

router.get('/director', requireCronSecret, runDirectorCron);
router.post('/director', requireCronSecret, runDirectorCron);

export default router;

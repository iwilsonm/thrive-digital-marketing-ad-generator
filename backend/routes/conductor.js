import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getConductorConfig, upsertConductorConfig, getAllConductorConfigs,
  getConductorAngles, getActiveConductorAngles, createConductorAngle, updateConductorAngle, deleteConductorAngle,
  getConductorRuns, getConductorTestQueue, createConductorRun,
  getConductorPlaybooks, getConductorPlaybook,
  getConductorSlots,
  getAdSetsByProject, getBatchesByProject,
  getProjectOptions,
  getBatchJob,
} from '../convexClient.js';
import { buildDescriptionFromBrief, parseBriefFromDescription } from '../utils/angleParser.js';
import { streamService } from '../utils/sseHelper.js';

const router = Router();
const PIPELINE_STATUS_TTL_MS = 30 * 1000;
let pipelineStatusCache = {
  value: null,
  expiresAt: 0,
  inFlight: null,
};

function safeParseJSON(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isMissingLPAgentError(err) {
  const message = err?.message || '';
  return /landingPages|lpAgentConfig|Could not find public function|Cannot read properties of undefined/.test(message);
}

function resetPipelineStatusCache() {
  pipelineStatusCache = {
    value: null,
    expiresAt: 0,
    inFlight: null,
  };
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(tag => String(tag || '').trim())
    .filter(Boolean)
    .map(tag => tag.slice(0, 40)))];
}

async function computePipelineStatus() {
  const [configs, projects] = await Promise.all([
    getAllConductorConfigs(),
    getProjectOptions(),
  ]);
  const projectMap = new Map(projects.map(project => [project.id, project]));

  const status = await Promise.all(configs.filter(c => c.enabled).map(async (config) => {
    const project = projectMap.get(config.project_id);
    if (!project) return null;

    // Phase 6 — count ad_sets-by-day instead of flex_ads-by-day. Ad sets
    // produced by Director land in 'ready' lifecycle; we approximate
    // posting_day matching via the parent batch's posting_day (linked via
    // batch_jobs.flex_ad_id which now stores the ad_set_id).
    const [adSets, batches, slots] = await Promise.all([
      getAdSetsByProject(config.project_id),
      getBatchesByProject(config.project_id),
      getConductorSlots(config.project_id),
    ]);

    const flexByDay = {};
    const adSetsByDay = {};
    for (const batch of batches) {
      if (!batch.posting_day || !batch.flex_ad_id) continue;
      const matched = adSets.find((s) => s.externalId === batch.flex_ad_id);
      if (matched) {
        adSetsByDay[batch.posting_day] = (adSetsByDay[batch.posting_day] || 0) + 1;
        flexByDay[batch.posting_day] = (flexByDay[batch.posting_day] || 0) + 1; // legacy alias
      }
    }

    const activeBatchesByDay = {};
    for (const batch of batches) {
      if (batch.posting_day && ['queued', 'pending', 'generating_prompts', 'submitting', 'processing', 'saving_results'].includes(batch.status)) {
        activeBatchesByDay[batch.posting_day] = (activeBatchesByDay[batch.posting_day] || 0) + 1;
      }
    }

    const slotsByDay = {};
    for (const slot of slots) {
      const key = slot.posting_day;
      if (!key) continue;
      if (!slotsByDay[key]) slotsByDay[key] = [];
      slotsByDay[key].push({
        slot_index: slot.slot_index,
        angle_name: slot.angle_name,
        status: slot.status,
        attempt_count: slot.attempt_count || 0,
        failure_reason: slot.failure_reason || null,
        produced_flex_ad_id: slot.produced_flex_ad_id || null,
        batch_ids: safeParseJSON(slot.batch_ids, []),
        diagnostics_summary: safeParseJSON(slot.diagnostics_summary, null),
      });
    }

    for (const day of Object.keys(slotsByDay)) {
      slotsByDay[day].sort((a, b) => (a.slot_index || 0) - (b.slot_index || 0));
    }

    return {
      project_id: config.project_id,
      project_name: project.name,
      brand_name: project.brand_name,
      daily_flex_target: config.daily_flex_target, // legacy field; equals daily ad-set target
      daily_ad_set_target: config.daily_flex_target,
      flex_by_day: flexByDay,
      ad_sets_by_day: adSetsByDay,
      active_batches_by_day: activeBatchesByDay,
      slots_by_day: slotsByDay,
    };
  }));

  return { projects: status.filter(Boolean) };
}

function refreshPipelineStatusCache() {
  if (pipelineStatusCache.inFlight) {
    return pipelineStatusCache.inFlight;
  }

  pipelineStatusCache.inFlight = computePipelineStatus()
    .then((value) => {
      pipelineStatusCache.value = value;
      pipelineStatusCache.expiresAt = Date.now() + PIPELINE_STATUS_TTL_MS;
      pipelineStatusCache.inFlight = null;
      return value;
    })
    .catch((err) => {
      pipelineStatusCache.inFlight = null;
      throw err;
    });

  return pipelineStatusCache.inFlight;
}

async function getCachedPipelineStatus() {
  const now = Date.now();
  if (pipelineStatusCache.value && pipelineStatusCache.expiresAt > now) {
    return pipelineStatusCache.value;
  }

  if (pipelineStatusCache.value) {
    refreshPipelineStatusCache().catch((err) => {
      console.error('[Conductor] Pipeline refresh error:', err.message);
    });
    return pipelineStatusCache.value;
  }

  return refreshPipelineStatusCache();
}

// =============================================
// Conductor Config — per-project Director settings
// =============================================

// GET /api/conductor/config?projectId=xxx — query param variant (used by Creative Filter shell script)
router.get('/config', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const config = await getConductorConfig(projectId);
    res.json(config || {});
  } catch (err) {
    console.error('[Conductor] Get config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/config/:projectId
router.get('/config/:projectId', async (req, res) => {
  try {
    const config = await getConductorConfig(req.params.projectId);
    res.json({ config: config || null });
  } catch (err) {
    console.error('[Conductor] Get config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/conductor/config/:projectId
router.put('/config/:projectId', async (req, res) => {
  try {
    // Whitelist allowed fields to prevent arbitrary field injection
    const allowedConfigFields = [
      'enabled', 'daily_flex_target', 'ads_per_batch', 'angle_mode',
      'angle_rotation', 'explore_ratio', 'run_schedule', 'run_schedule_days', 'run_schedule_hour', 'posting_days',
      'score_threshold', 'auto_learn',
      'headline_style', 'primary_text_style', 'template_tag', 'angle_tag_filter', 'default_campaign_id',
      'image_model',
      // Phase 4 — sub-angle derivation + health-biased Director
      'health_bias',
      'sub_angle_derivation_enabled',
      'sub_angle_derivation_mode',
      'sub_angle_derivation_threshold',
      'sub_angle_derivation_min_unique_days',
      'sub_angle_derivation_max_per_run',
      'sub_angle_derivation_cooldown_days',
      'sub_angle_max_depth',
      'sub_angle_exploration_boost_days',
      'sub_angle_lineage_cap_share',
      'sub_angle_min_active_for_health_bias',
      'sub_angle_min_active_for_lineage_cap',
      'sub_angle_per_project_daily_cost_cap_usd',
    ];
    const fields = {};
    for (const key of allowedConfigFields) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (fields.angle_tag_filter !== undefined) {
      fields.angle_tag_filter = String(fields.angle_tag_filter || '').trim().slice(0, 40);
    }
    await upsertConductorConfig(req.params.projectId, fields);
    resetPipelineStatusCache();
    const config = await getConductorConfig(req.params.projectId);
    res.json({ success: true, config });
  } catch (err) {
    console.error('[Conductor] Update config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/configs — all project configs (for pipeline overview)
router.get('/configs', async (req, res) => {
  try {
    const configs = await getAllConductorConfigs();
    res.json({ configs });
  } catch (err) {
    console.error('[Conductor] Get all configs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Conductor Angles — angle library per project
// =============================================

// GET /api/conductor/angles/:projectId
router.get('/angles/:projectId', async (req, res) => {
  try {
    const angles = await getConductorAngles(req.params.projectId);
    res.json({ angles });
  } catch (err) {
    console.error('[Conductor] Get angles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/angles/:projectId/active
router.get('/angles/:projectId/active', async (req, res) => {
  try {
    const angles = await getActiveConductorAngles(req.params.projectId);
    res.json({ angles });
  } catch (err) {
    console.error('[Conductor] Get active angles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/angles/:projectId
router.post('/angles/:projectId', async (req, res) => {
  try {
    const { name, description, prompt_hints, source, status,
      priority, frame, core_buyer, symptom_pattern, failed_solutions,
      current_belief, objection, emotional_state, scene,
      desired_belief_shift, tone, avoid_list, tags } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    // Auto-compute description from structured fields if not provided
    const computedDescription = description || buildDescriptionFromBrief({
      core_buyer, symptom_pattern, objection, scene, desired_belief_shift
    });
    const id = uuidv4();
    // If structured fields are empty but description has labeled data, parse them
    const parsedFields = (!core_buyer && !symptom_pattern && computedDescription)
      ? parseBriefFromDescription(computedDescription)
      : {};
    await createConductorAngle({
      id,
      project_id: req.params.projectId,
      name,
      description: computedDescription,
      prompt_hints,
      source: source || 'manual',
      status: status || 'active',
      priority: priority || parsedFields.priority,
      frame: frame || parsedFields.frame,
      core_buyer: core_buyer || parsedFields.core_buyer,
      symptom_pattern: symptom_pattern || parsedFields.symptom_pattern,
      failed_solutions: failed_solutions || parsedFields.failed_solutions,
      current_belief: current_belief || parsedFields.current_belief,
      objection: objection || parsedFields.objection,
      emotional_state: emotional_state || parsedFields.emotional_state,
      scene: scene || parsedFields.scene,
      desired_belief_shift: desired_belief_shift || parsedFields.desired_belief_shift,
      tone: tone || parsedFields.tone,
      avoid_list: avoid_list || parsedFields.avoid_list,
      tags: normalizeTags(tags),
    });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[Conductor] Create angle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/conductor/angles/:projectId/:angleId
router.put('/angles/:projectId/:angleId', async (req, res) => {
  try {
    // Whitelist allowed fields to prevent arbitrary field injection
    const allowedAngleFields = [
      'name', 'description', 'prompt_hints', 'status', 'source', 'focused',
      'priority', 'frame', 'core_buyer', 'symptom_pattern', 'failed_solutions',
      'current_belief', 'objection', 'emotional_state', 'scene',
      'desired_belief_shift', 'tone', 'avoid_list', 'destination_urls', 'tags',
    ];
    const fields = {};
    for (const key of allowedAngleFields) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (req.body.tags !== undefined) fields.tags = normalizeTags(req.body.tags);
    await updateConductorAngle(req.params.angleId, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('[Conductor] Update angle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/conductor/angles/:projectId/:angleId
router.delete('/angles/:projectId/:angleId', async (req, res) => {
  try {
    // Archive instead of hard delete (preserves history)
    await updateConductorAngle(req.params.angleId, { status: 'archived' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Conductor] Archive angle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Conductor Runs — audit log
// =============================================

// GET /api/conductor/runs/:projectId
router.get('/runs/:projectId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const runs = await getConductorRuns(req.params.projectId, limit);
    res.json({ runs });
  } catch (err) {
    console.error('[Conductor] Get runs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/run-batch-lp/:projectId/:batchId
router.get('/run-batch-lp/:projectId/:batchId', async (req, res) => {
  try {
    const { projectId, batchId } = req.params;
    const batch = await getBatchJob(batchId);
    if (!batch || batch.project_id !== projectId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // Phase 6 — LP Agent removed from this fork entirely.
    // landing_pages table no longer used; this endpoint returns empty pages
    // and a static unavailable reason for any frontend that still queries it.
    const landingPages = [];
    const lpUnavailableReason = 'Landing page generation is not available in ThriveCampaigns.';
    const mappedPages = landingPages.map((page) => {
      const qaReport = safeParseJSON(page.qa_report, {});
      const smokeReport = safeParseJSON(page.smoke_test_report, {});
      const qaIssues = Array.isArray(qaReport?.issues) ? qaReport.issues : [];
      const smokeChecks = Array.isArray(smokeReport?.checks) ? smokeReport.checks : [];

      return {
        id: page.externalId,
        name: page.name || null,
        status: page.status || null,
        angle: page.angle || null,
        narrative_frame: page.narrative_frame || null,
        headline_text: page.headline_text || null,
        subheadline_text: page.subheadline_text || null,
        headline_frame_alignment_status: page.headline_frame_alignment_status || null,
        headline_frame_alignment_reason: page.headline_frame_alignment_reason || null,
        headline_uniqueness_status: page.headline_uniqueness_status || null,
        headline_uniqueness_reason: page.headline_uniqueness_reason || null,
        headline_duplicate_of_lp_id: page.headline_duplicate_of_lp_id || null,
        headline_history_status: page.headline_history_status || null,
        headline_history_reason: page.headline_history_reason || null,
        template_id: page.template_id || null,
        published_url: page.published_url || null,
        error_message: page.error_message || null,
        created_at: page.created_at || null,
        updated_at: page.updated_at || null,
        qa_status: page.qa_status || null,
        qa_score: page.qa_score ?? null,
        qa_issues_count: page.qa_issues_count ?? qaIssues.length,
        qa_summary: qaReport?.summary || null,
        qa_source: qaReport?.source || null,
        qa_issues: qaIssues,
        qa_categories: qaReport?.categories && typeof qaReport.categories === 'object' ? qaReport.categories : null,
        smoke_test_status: page.smoke_test_status || null,
        smoke_test_at: page.smoke_test_at || null,
        smoke_passed: typeof smokeReport?.passed === 'boolean' ? smokeReport.passed : null,
        smoke_failed_count: typeof smokeReport?.failedCount === 'number' ? smokeReport.failedCount : null,
        smoke_checks: smokeChecks,
        smoke_visible_placeholder_matches: Array.isArray(smokeReport?.visiblePlaceholderMatches) ? smokeReport.visiblePlaceholderMatches : [],
        smoke_raw_placeholder_matches: Array.isArray(smokeReport?.rawHtmlPlaceholderMatches) ? smokeReport.rawHtmlPlaceholderMatches : [],
        generation_attempts: page.generation_attempts ?? null,
        fix_attempts: page.fix_attempts ?? null,
        generation_duration_ms: page.generation_duration_ms ?? null,
        gauntlet_batch_id: page.gauntlet_batch_id || null,
        gauntlet_frame: page.gauntlet_frame || null,
        gauntlet_attempt: page.gauntlet_attempt ?? null,
        gauntlet_retry_type: page.gauntlet_retry_type || null,
        gauntlet_score: page.gauntlet_score ?? null,
        gauntlet_score_reasoning: page.gauntlet_score_reasoning || null,
        gauntlet_status: page.gauntlet_status || null,
        gauntlet_image_prescore_attempts: page.gauntlet_image_prescore_attempts ?? null,
        gauntlet_batch_started_at: page.gauntlet_batch_started_at || null,
        gauntlet_batch_completed_at: page.gauntlet_batch_completed_at || null,
      };
    });

    const scoredPages = mappedPages.filter((page) => typeof page.gauntlet_score === 'number');
    const summary = {
      total: mappedPages.length,
      passed: mappedPages.filter((page) => ['passed', 'published', 'passed_dry_run'].includes(page.gauntlet_status) || page.status === 'published').length,
      published: mappedPages.filter((page) => !!page.published_url || page.status === 'published').length,
      failed: mappedPages.filter((page) => ['failed', 'error', 'publish_failed', 'smoke_failed'].includes(page.status) || page.gauntlet_status === 'failed').length,
      headlinePassed: mappedPages.filter((page) =>
        page.headline_frame_alignment_status === 'passed' &&
        page.headline_uniqueness_status === 'passed' &&
        page.headline_history_status !== 'failed'
      ).length,
      avgScore: scoredPages.length > 0
        ? Math.round((scoredPages.reduce((sum, page) => sum + page.gauntlet_score, 0) / scoredPages.length) * 10) / 10
        : null,
      totalImagePrescoreAttempts: mappedPages.reduce((sum, page) => sum + (page.gauntlet_image_prescore_attempts || 0), 0),
      totalGenerationDurationMs: mappedPages.reduce((sum, page) => sum + (page.generation_duration_ms || 0), 0),
    };

    res.json({
      batch: {
        id: batch.id,
        angle_name: batch.angle_name || null,
        lp_primary_id: batch.lp_primary_id || null,
        lp_primary_url: batch.lp_primary_url || null,
        lp_primary_status: batch.lp_primary_status || null,
        lp_primary_error: batch.lp_primary_error || null,
        lp_primary_retry_count: batch.lp_primary_retry_count || 0,
        lp_secondary_id: batch.lp_secondary_id || null,
        lp_secondary_url: batch.lp_secondary_url || null,
        lp_secondary_status: batch.lp_secondary_status || null,
        lp_secondary_error: batch.lp_secondary_error || null,
        lp_secondary_retry_count: batch.lp_secondary_retry_count || 0,
        lp_narrative_frames: safeParseJSON(batch.lp_narrative_frames, []),
        gauntlet_lp_urls: safeParseJSON(batch.gauntlet_lp_urls, []),
      },
      summary,
      landingPages: mappedPages,
      lpUnavailable: !!lpUnavailableReason,
      lpUnavailableReason,
    });
  } catch (err) {
    console.error('[Conductor] Get run batch LP details error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/run/:projectId — manual trigger
router.post('/run/:projectId', async (req, res) => {
  try {
    // Lazy-import to avoid circular deps — conductorEngine imports convexClient
    const { runDirectorForProject } = await import('../services/conductorEngine.js');
    const result = await runDirectorForProject(req.params.projectId, 'manual');
    res.json({ success: true, result });
  } catch (err) {
    console.error('[Conductor] Manual run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/test-run/:projectId — full pipeline: Director → batch → Gemini → Filter → Ready to Post
router.post('/test-run/:projectId', async (req, res) => {
  const { angle_id, ads_per_ad_set, template_tag } = req.body || {};
  const selectedAngleId = typeof angle_id === 'string' ? angle_id.trim() : '';
  if (!selectedAngleId) {
    return res.status(400).json({ error: 'Choose a test angle before starting a Creative Director test run.' });
  }

  const selectedTarget = ads_per_ad_set === undefined || ads_per_ad_set === null || ads_per_ad_set === ''
    ? 5
    : Number(ads_per_ad_set);

  if (!Number.isInteger(selectedTarget) || selectedTarget < 1 || selectedTarget > 20) {
    return res.status(400).json({ error: 'Ads in test ad set must be a whole number from 1 to 20.' });
  }

  streamService(req, res, async (sendEvent) => {
    const { runFullTestPipeline } = await import('../services/conductorEngine.js');
    const result = await runFullTestPipeline(req.params.projectId, sendEvent, {
      angleOverride: selectedAngleId,
      adsPerAdSetTarget: selectedTarget,
      templateTag: template_tag || '',
    });
    if (result.queued) {
      sendEvent({ type: 'queued', ...result });
    } else if (result.pipeline_failed) {
      sendEvent({ type: 'error', message: result.failure_reason, ...result });
    } else if (result.run_in_background) {
      sendEvent({ type: 'background', ...result });
    } else {
      sendEvent({ type: 'complete', ...result });
    }
  });
});

// POST /api/conductor/test-run/cancel/:projectId — cancel active test run
router.post('/test-run/cancel/:projectId', async (req, res) => {
  try {
    const { cancelTestRun } = await import('../services/conductorEngine.js');
    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : null;
    const cancelled = await cancelTestRun(req.params.projectId, { runId });
    res.json({ success: true, cancelled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/test-run/queue/:projectId — durable queued/running test runs
router.get('/test-run/queue/:projectId', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const runs = await getConductorTestQueue(req.params.projectId, limit);
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/test-run/progress/:projectId — poll active test run progress (survives SSE disconnect)
router.get('/test-run/progress/:projectId', async (req, res) => {
  try {
    const { getActiveTestRunSnapshot } = await import('../services/conductorEngine.js');
    const active = await getActiveTestRunSnapshot(req.params.projectId);
    res.json({ active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Conductor Playbooks — per-angle learning memory
// =============================================

// GET /api/conductor/playbooks/:projectId
router.get('/playbooks/:projectId', async (req, res) => {
  try {
    const playbooks = await getConductorPlaybooks(req.params.projectId);
    res.json({ playbooks });
  } catch (err) {
    console.error('[Conductor] Get playbooks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/playbooks/:projectId/:angleName
router.get('/playbooks/:projectId/:angleName', async (req, res) => {
  try {
    const playbook = await getConductorPlaybook(req.params.projectId, req.params.angleName);
    res.json({ playbook: playbook || null });
  } catch (err) {
    console.error('[Conductor] Get playbook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Learning Step — triggered after Filter scoring
// =============================================

// POST /api/conductor/learn — trigger learning analysis for a scored batch
router.post('/learn', async (req, res) => {
  try {
    const { projectId, angleName, scoredAds } = req.body;
    if (!projectId || !angleName) {
      return res.status(400).json({ error: 'projectId and angleName required' });
    }
    // Lazy import to avoid loading anthropic at route registration
    const { runLearningStep } = await import('../services/conductorLearning.js');
    const result = await runLearningStep(projectId, angleName, scoredAds || []);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[Conductor] Learning step error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Pipeline Overview — cross-project posting day status
// =============================================

// GET /api/conductor/pipeline-status
router.get('/pipeline-status', async (req, res) => {
  try {
    res.json(await getCachedPipelineStatus());
  } catch (err) {
    console.error('[Conductor] Pipeline status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

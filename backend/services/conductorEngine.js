/**
 * conductorEngine.js — Dacia Creative Director core logic
 *
 * Runs at 7 AM, 7 PM, and 1 AM ICT. Each run:
 * 1. Iterates enabled projects
 * 2. Determines active posting days (production windows)
 * 3. Calculates flex ad deficit per posting day
 * 4. Creates batches with angle prompts to fill the deficit
 * 5. Logs the run to conductor_runs
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getConductorConfig, upsertConductorConfig,
  getActiveConductorAngles, updateConductorAngle,
  getConductorPlaybook,
  createConductorRun as createConductorRunRaw, updateConductorRun as updateConductorRunRaw, getConductorRuns,
  enqueueConductorTestRun, claimQueuedConductorTestRun, releaseQueuedConductorTestRun, cancelQueuedConductorTestRun,
  getConductorSlotsByPostingDay, createConductorSlot, updateConductorSlot,
  createBatchJob, getBatchJob, updateBatchJob,
  getAdsByBatchId, getAd,
  getAdSetsByProject, getBatchesByProject,
  getProject, getAllConductorConfigs, getSetting, ensureDefaultCampaign, convexClient, api,
} from '../convexClient.js';
import { runBatch, pollBatchJob } from './batchProcessor.js';
import { buildStructuredAnglePrompt, hasStructuredBrief, buildAngleBriefJSON } from '../utils/angleParser.js';
import {
  cleanupImageData,
  generateImagePrompt,
  regenerateImageOnly,
  repairBodyCopy,
  selectInspirationImage,
  selectTemplateImage,
  assertTemplateTagHasActiveTemplates,
  normalizeTemplateTag,
} from './adGenerator.js';
import { copyStorageBlob } from '../utils/adImages.js';
import { resolveImageModel, getImageProvider } from './imageProvider.js';

/**
 * Copy the project's product image into a fresh storage blob owned by the new batch.
 * Returns undefined if the project has no image OR the source blob is dead.
 * Director-triggered batches use this so cleanup of an old batch doesn't wipe the
 * project's product image (see routes/batches.js for the matching path).
 */
async function copyProjectProductImageForBatch(project) {
  if (!project?.product_image_storageId) return undefined;
  try {
    return await copyStorageBlob(project.product_image_storageId);
  } catch (err) {
    console.warn(`[Conductor] Project product image storageId is dead, proceeding without: ${err.message}`);
    return undefined;
  }
}

/**
 * Check if a project's schedule matches the current time (ICT = UTC+7).
 * Returns true if the Director should run for this project right now.
 */
function shouldRunNow(config) {
  if (!config.enabled || config.run_schedule === 'manual_only') return false;

  const now = new Date();
  const ictHour = (now.getUTCHours() + 7) % 24;
  const ictDay = new Date(now.getTime() + 7 * 60 * 60 * 1000).getUTCDay(); // 0=Sun...6=Sat

  // Check if already ran today (same ICT calendar day)
  if (config.last_planning_run) {
    const lastRun = new Date(config.last_planning_run);
    const lastRunIctDate = new Date(lastRun.getTime() + 7 * 60 * 60 * 1000).toISOString().split('T')[0];
    const todayIctDate = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().split('T')[0];
    if (lastRunIctDate === todayIctDate) return false;
  }

  const schedule = config.run_schedule || 'weekdays';
  const targetHour = schedule === 'custom' ? (config.run_schedule_hour ?? 0) : 0; // midnight ICT for presets

  // Check hour match
  if (ictHour !== targetHour) return false;

  // Check day match
  switch (schedule) {
    case 'daily': return true;
    case 'weekdays': return ictDay >= 1 && ictDay <= 5;
    case 'weekly_monday': return ictDay === 1;
    case 'custom': {
      let days = [1, 2, 3, 4, 5]; // default weekdays
      try { days = JSON.parse(config.run_schedule_days || '[]'); } catch {}
      return days.includes(ictDay);
    }
    case 'auto': return ictDay >= 1 && ictDay <= 5; // backward compat: treat as weekdays
    default: return false;
  }
}

/**
 * Run the Director cycle for ALL enabled projects whose schedule matches now.
 * Called by scheduler hourly tick.
 * @param {'planning'|'verification'|'emergency'} runType
 */
export async function runDirectorCycle(runType = 'planning') {
  console.log(`[Director] Starting ${runType} cycle...`);
  const configs = await getAllConductorConfigs();
  const enabledConfigs = configs.filter(c => shouldRunNow(c));

  if (enabledConfigs.length === 0) {
    console.log('[Director] No projects scheduled for this hour. Skipping.');
    return;
  }

  console.log(`[Director] ${enabledConfigs.length} project(s) scheduled to run.`);
  const results = [];
  for (const config of enabledConfigs) {
    try {
      const result = await runDirectorForProject(config.project_id, runType);
      results.push(result);
    } catch (err) {
      console.error(`[Director] Error for project ${config.project_id.slice(0, 8)}:`, err.message);
      results.push({ project_id: config.project_id, error: err.message });
    }
  }

  console.log(`[Director] Cycle complete. Processed ${results.length} project(s).`);
  return results;
}

/**
 * Run the Director for a single project.
 * Also used for manual triggers from the API.
 * @param {string} projectId
 * @param {'planning'|'verification'|'manual'|'emergency'} runType
 */
export async function runDirectorForProject(projectId, runType = 'manual') {
  const startMs = Date.now();
  const runId = uuidv4();

  const config = await getConductorConfig(projectId);
  if (!config) {
    throw new Error('No conductor config for this project. Create one first.');
  }

  const project = await getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  // Create the run record immediately
  await createConductorRun({
    externalId: runId,
    project_id: projectId,
    run_type: runType,
    run_at: startMs,
    status: 'running',
  });

  try {
    const now = new Date();
    const activePostingDays = getActivePostingDays(now);

    if (activePostingDays.length === 0) {
      await updateConductorRun(runId, {
        status: 'completed',
        decisions: 'No active posting days in current production window.',
        posting_days: JSON.stringify([]),
        duration_ms: Date.now() - startMs,
      });
      return { runId, batches_created: 0, message: 'No active posting days' };
    }

    // Sort by deadline (closest first)
    activePostingDays.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

    const allBatches = await getBatchesByProject(projectId);
    const batchesById = new Map((allBatches || []).map(batch => [batch.id, batch]));
    const allBatchesCreated = [];
    const postingDayResults = [];

    for (const pd of activePostingDays) {
      const slots = await ensurePostingDaySlots(projectId, config, pd.date);
      const batchesForDay = [];
      const slotResults = [];

      for (const slot of slots) {
        let workingSlot = slot;
        const directorAdSetTarget = getDirectorAdSetTarget(project, config);
        const slotBatchIds = getSlotBatchIds(slot);
        let latestBatch = slotBatchIds.length > 0 ? batchesById.get(slotBatchIds[slotBatchIds.length - 1]) : null;
        let slotQaProgress = await processCompletedSlotQa({
          slot,
          batchesById,
          projectId,
          targetCount: directorAdSetTarget,
        });

        const finalizeResult = await finalizeSlotIfReady({
          slot,
          batchesById,
          projectId,
          targetCount: directorAdSetTarget,
          progress: slotQaProgress,
        });
        if (finalizeResult.finalized) {
          const producedSlot = { ...slot, ...finalizeResult.slotUpdates };
          await updateConductorSlot(slot.id, finalizeResult.slotUpdates);
          slotResults.push(buildPostingDaySlotResult(producedSlot));
          continue;
        }
        if (finalizeResult.finalizeFailed && finalizeResult.slotUpdates) {
          await updateConductorSlot(slot.id, finalizeResult.slotUpdates);
          workingSlot = { ...slot, ...finalizeResult.slotUpdates };
          slotResults.push(buildPostingDaySlotResult(workingSlot));
          continue;
        }

        latestBatch = slotBatchIds.length > 0 ? batchesById.get(slotBatchIds[slotBatchIds.length - 1]) : null;
        const reconciled = reconcileSchedulerSlot(slot, latestBatch, slotQaProgress, directorAdSetTarget);

        if (hasSlotChanges(slot, reconciled)) {
          await updateConductorSlot(slot.id, reconciled);
          workingSlot = { ...slot, ...reconciled };
        }

        if (workingSlot.status === 'failed') {
          const replacement = await replaceFailedSlot(projectId, config, pd.date, workingSlot, slots);
          if (replacement) {
            workingSlot = replacement;
          }
        }

        const refreshedBatchIds = getSlotBatchIds(workingSlot);
        if (workingSlot.id !== slot.id) {
          slotQaProgress = await processCompletedSlotQa({
            slot: workingSlot,
            batchesById,
            projectId,
            targetCount: directorAdSetTarget,
          });
        }
        const latestKnownBatch = refreshedBatchIds.length > 0 ? batchesById.get(refreshedBatchIds[refreshedBatchIds.length - 1]) : null;
        const hasActiveBatch = latestKnownBatch && ACTIVE_BATCH_STATUSES.has(latestKnownBatch.status);

        if (workingSlot.status !== 'reserved' || hasActiveBatch || workingSlot.produced_flex_ad_id) {
          slotResults.push(buildPostingDaySlotResult(workingSlot));
          continue;
        }

        const angleInfo = await hydrateAngleInfoForSlot(projectId, workingSlot);
        const batchId = uuidv4();

        const approvedSoFar = slotQaProgress?.passedCount || 0;
        const batchSize = approvedSoFar > 0
          ? getDirectorTopUpBatchSize(directorAdSetTarget, approvedSoFar)
          : getInitialDirectorBatchSize(runType, directorAdSetTarget);

        // Build the angle prompt — use structured fields if available, else legacy description
        let anglePrompt;
        if (hasStructuredBrief(angleInfo)) {
          anglePrompt = buildStructuredAnglePrompt(angleInfo);
        } else {
          anglePrompt = angleInfo.description || angleInfo.name || 'General ad creative angle.';
        }
        if (angleInfo.prompt_hints) {
          anglePrompt += `\n\nCREATIVE DIRECTION:\n${angleInfo.prompt_hints}`;
        }

        // Load playbook for this angle if it exists
        const playbook = await getConductorPlaybook(projectId, angleInfo.name);
        anglePrompt += buildPlaybookPromptBlock(playbook, { templateMode: true });

        // Build structured brief JSON for downstream use (scoring, QA, LP generation)
        const angleBriefJSON = hasStructuredBrief(angleInfo)
          ? JSON.stringify(buildAngleBriefJSON(angleInfo))
          : undefined;
        const resolvedImageModel = resolveImageModel(config?.image_model);

        await createBatchJob({
          id: batchId,
          project_id: projectId,
          generation_mode: 'batch',
          batch_size: batchSize,
          angle: anglePrompt,  // Injected into the ad generator's "angle" field
          aspect_ratio: '1:1',
          product_image_storageId: await copyProjectProductImageForBatch(project),
          filter_assigned: true,
          posting_day: pd.date,
          conductor_run_id: runId,
          angle_name: angleInfo.name,
          angle_prompt: anglePrompt,
          angle_brief: angleBriefJSON,
          template_tag: normalizeTemplateTag(config?.template_tag) || undefined,
          image_model: resolvedImageModel,
          image_provider: getImageProvider(resolvedImageModel),
        });

        // Update angle usage stats (skip for fallback angles with no DB record)
        if (angleInfo.externalId !== 'fallback') {
          await updateConductorAngle(angleInfo.externalId, {
            times_used: (angleInfo.times_used || 0) + 1,
            last_used_at: Date.now(),
          });
        }

        const nextBatchIds = [...refreshedBatchIds, batchId];
        await updateConductorSlot(workingSlot.id, {
          status: 'in_progress',
          batch_ids: stringifyJSON(nextBatchIds, '[]'),
          attempt_count: (workingSlot.attempt_count || 0) + 1,
          last_attempt_at: Date.now(),
          failure_reason: '',
        });

        batchesForDay.push({
          batch_id: batchId,
          angle_name: angleInfo.name,
          ad_count: batchSize,
          posting_day: pd.date,
          slot_index: workingSlot.slot_index,
        });
        slotResults.push({
          ...buildPostingDaySlotResult({
            ...workingSlot,
            status: 'in_progress',
            batch_ids: stringifyJSON(nextBatchIds, '[]'),
            attempt_count: (workingSlot.attempt_count || 0) + 1,
            failure_reason: '',
          }),
          created_batch_id: batchId,
        });
      }

      allBatchesCreated.push(...batchesForDay);
      postingDayResults.push({
        date: pd.date,
        deadline: pd.deadline,
        target: config.daily_flex_target,
        action: batchesForDay.length > 0 ? `Created ${batchesForDay.length} batch(es)` : 'slots already reserved or in progress',
        batches: batchesForDay,
        slots: slotResults,
      });
    }

    // Update run record with results
    const updateTimestamp = runType === 'planning' ? 'last_planning_run' : 'last_verify_run';
    await upsertConductorConfig(projectId, { [updateTimestamp]: Date.now() });

    await updateConductorRun(runId, {
      status: 'completed',
      posting_days: JSON.stringify(postingDayResults),
      batches_created: JSON.stringify(allBatchesCreated),
      decisions: `Checked ${activePostingDays.length} posting day(s). Created ${allBatchesCreated.length} batch(es).`,
      duration_ms: Date.now() - startMs,
    });

    console.log(`[Director] Project ${projectId.slice(0, 8)}: Created ${allBatchesCreated.length} batch(es) for ${postingDayResults.length} posting day(s) in ${Date.now() - startMs}ms`);

    // Process batches sequentially to avoid overwhelming the LLM rate limiter.
    // Fire-and-forget all at once caused queue pileup + stale detection cascade.
    for (const b of allBatchesCreated) {
      try {
        console.log(`[Director] Starting batch ${b.batch_id.slice(0, 8)} (${allBatchesCreated.indexOf(b) + 1}/${allBatchesCreated.length})...`);
        await runBatch(b.batch_id);
        // Phase K: LP generation is no longer fired here. The Creative Filter
        // triggers it after assembling a Ready-to-Post flex ad — see
        // /api/projects/:projectId/lp-agent/trigger-from-flex-ad. This lets
        // the LP's angle be derived from the winning flex-ad images instead
        // of from the Director's library angle, and prevents LP generation
        // from starting before the ads exist.
      } catch (err) {
        console.error(`[Director] Batch ${b.batch_id.slice(0, 8)} failed:`, err.message);
      }
    }

    return {
      runId,
      batches_created: allBatchesCreated.length,
      posting_days: postingDayResults,
    };

  } catch (err) {
    await updateConductorRun(runId, {
      status: 'failed',
      error: err.message,
      duration_ms: Date.now() - startMs,
    });
    throw err;
  }
}

/**
 * Determine which posting days have their production window currently open.
 *
 * Production windows (all times ICT = UTC+7):
 * - Monday's ads: Sat 7 PM through Mon 3 AM
 * - Tuesday's ads: Sun 7 PM through Tue 3 AM
 * - Wednesday's ads: Mon 7 PM through Wed 3 AM
 * - Thursday's ads: Tue 7 PM through Thu 3 AM
 * - Friday's ads: Wed 7 PM through Fri 3 AM
 *
 * @param {Date} now - current time
 * @returns {Array<{ date: string, deadline: string, dayName: string }>}
 */
export function getActivePostingDays(now) {
  // Convert to ICT (UTC+7)
  const ictOffset = 7 * 60 * 60 * 1000;
  const ictNow = new Date(now.getTime() + ictOffset);
  const ictHour = ictNow.getUTCHours();
  const ictDay = ictNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  const result = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Check each weekday (Mon=1 through Fri=5) as potential posting days
  for (let postDay = 1; postDay <= 5; postDay++) {
    // Production window opens 2 evenings before (7 PM ICT) and closes 3 AM ICT on posting day
    // "2 evenings before" means: for Monday (1), opens Saturday (6) at 7 PM
    // That's postDay - 2, wrapping around (mod 7)
    const openDay = (postDay - 2 + 7) % 7;

    // Window open: openDay 19:00 ICT
    // Window close: postDay 03:00 ICT
    const windowOpen = getICTDate(ictNow, openDay, 19);
    const windowClose = getICTDate(ictNow, postDay, 3);

    // Adjust: if windowClose is before windowOpen, windowClose is next week
    if (windowClose <= windowOpen) {
      windowClose.setUTCDate(windowClose.getUTCDate() + 7);
    }

    const nowMs = ictNow.getTime();
    if (nowMs >= windowOpen.getTime() && nowMs <= windowClose.getTime()) {
      // This posting day's window is open
      // Calculate the actual posting date (the next occurrence of postDay)
      const postingDate = getNextWeekday(now, postDay);
      result.push({
        date: formatDate(postingDate),
        deadline: new Date(windowClose.getTime() - ictOffset).toISOString(),
        dayName: dayNames[postDay],
      });
    }
  }

  return result;
}

/**
 * Calculate the flex ad deficit for a specific posting day.
 * deficit = target - produced - in_progress_batches
 */
async function calculateDeficit(projectId, postingDay, target) {
  // Phase 6 — count ad_sets in non-terminal lifecycles instead of flex_ads.
  // Each batch produces ONE ad_set in 'ready' lifecycle (was: one flex_ad).
  // We approximate posting_day matching by checking ad_sets whose batch was
  // tagged for this posting day.
  const adSets = await getAdSetsByProject(projectId);
  const batches = await getBatchesByProject(projectId);

  // Count ad_sets that match this posting_day. Director-created ad_sets carry
  // posting_day in their parent batch (linked via batch_jobs.flex_ad_id which
  // we now repurpose to store ad_set_id during the Phase 6 transition).
  const batchesForDay = new Set(
    batches.filter((b) => b.posting_day === postingDay).map((b) => b.flex_ad_id).filter(Boolean)
  );
  const produced = adSets.filter((s) => batchesForDay.has(s.externalId)).length;

  // Count batches still in progress for this posting day
  const inProgress = batches.filter(b =>
    b.posting_day === postingDay &&
    ['queued', 'pending', 'generating_prompts', 'submitting', 'processing', 'saving_results'].includes(b.status)
  ).length;

  const deficit = Math.max(0, target - produced - inProgress);
  return { produced, inProgress, deficit };
}

const MAX_ATTEMPTS_PER_ANGLE_SLOT = 2;
const DIRECTOR_AD_SET_HARD_CAP = 20;
const DIRECTOR_TOP_UP_BUFFER = 2;
const ACTIVE_BATCH_STATUSES = new Set(['queued', 'pending', 'generating_prompts', 'submitting', 'processing', 'saving_results']);

export function getDirectorAdSetTarget(project = {}, config = {}) {
  const projectValue = Number(project?.ads_per_ad_set);
  const configValue = Number(config?.ads_per_batch);
  const raw = Number.isFinite(projectValue) && projectValue > 0 ? projectValue : configValue;
  if (!Number.isFinite(raw) || raw <= 0) return 5;
  return Math.max(1, Math.min(DIRECTOR_AD_SET_HARD_CAP, Math.floor(raw)));
}

export function getDirectorTopUpBatchSize(targetCount, passedCount, buffer = DIRECTOR_TOP_UP_BUFFER) {
  const target = getDirectorAdSetTarget({ ads_per_ad_set: targetCount }, {});
  const passed = Math.max(0, Math.floor(Number(passedCount) || 0));
  const missing = Math.max(0, target - passed);
  if (missing === 0) return 0;
  return Math.min(target, missing + Math.max(0, Math.floor(Number(buffer) || 0)));
}

function getInitialDirectorBatchSize(runType, targetCount) {
  const target = getDirectorAdSetTarget({ ads_per_ad_set: targetCount }, {});
  if (runType === 'emergency') return Math.min(DIRECTOR_AD_SET_HARD_CAP, Math.max(target, 12));
  return target;
}

function getSlotBatchIds(slot) {
  return parseJSON(slot?.batch_ids, []);
}

function slotBatchRecords(slot, batchesById) {
  return getSlotBatchIds(slot)
    .map(batchId => batchesById.get(batchId))
    .filter(Boolean);
}

function buildPassedAdScore(ad) {
  const normalized = Number(ad?.filter_score);
  const overall = Number.isFinite(normalized) ? Math.max(0, Math.min(10, normalized * 10)) : 8;
  return {
    ad_id: ad.id,
    overall_score: overall,
    copy_strength: overall,
    compliance: overall,
    effectiveness: overall,
    image_quality: overall,
    pass: true,
  };
}

async function collectPassedAdsForSlot(slot, projectId) {
  const seen = new Set();
  const passingAds = [];
  for (const batchId of getSlotBatchIds(slot)) {
    const ads = await getAdsByBatchId(batchId);
    for (const ad of ads) {
      if (!ad?.id || seen.has(ad.id)) continue;
      if (ad.project_id !== projectId) continue;
      if (ad.filter_verdict !== 'passed') continue;
      seen.add(ad.id);
      passingAds.push({ ad, score: buildPassedAdScore(ad) });
    }
  }
  return passingAds;
}

async function processCompletedSlotQa({ slot, batchesById, projectId }) {
  const { scoreBatchForInlineFilter } = await import('./creativeFilterService.js');
  const records = slotBatchRecords(slot, batchesById);
  for (const batch of records) {
    if (
      batch.status === 'completed' &&
      batch.filter_assigned &&
      !batch.filter_processed &&
      !batch.flex_ad_id
    ) {
      await scoreBatchForInlineFilter(batch.id, projectId, null);
      batchesById.set(batch.id, {
        ...batch,
        filter_processed: true,
        filter_processed_at: new Date().toISOString(),
      });
    }
  }

  const passingAds = await collectPassedAdsForSlot(slot, projectId);
  return {
    batchIds: getSlotBatchIds(slot),
    passingAds,
    passedCount: passingAds.length,
  };
}

async function finalizeSlotIfReady({ slot, batchesById, projectId, targetCount, progress }) {
  if (slot.produced_flex_ad_id) return { finalized: false };
  if (!progress || progress.passedCount < targetCount) return { finalized: false };

  const { finalizePassingAds } = await import('./creativeFilterService.js');
  const latestBatchId = progress.batchIds[progress.batchIds.length - 1] || null;
  const finalizeResult = await finalizePassingAds({
    passingAds: progress.passingAds,
    projectId,
    batchId: latestBatchId,
    postingDay: slot.posting_day,
    angleName: slot.angle_name,
    targetCount,
  });

  const flexAdId = finalizeResult.flex_ad_id || finalizeResult.ad_set_id || null;
  if (!flexAdId) {
    const reason = finalizeResult.grouping_failed
      ? `qa_target_met_but_grouping_failed_${progress.passedCount}_of_${targetCount}`
      : finalizeResult.copy_error
        ? `qa_target_met_but_copy_failed: ${finalizeResult.copy_error}`
      : finalizeResult.deploy_error
        ? `qa_target_met_but_deploy_failed: ${finalizeResult.deploy_error}`
        : `qa_target_met_but_finalize_failed_${progress.passedCount}_of_${targetCount}`;
    return {
      finalized: false,
      finalizeFailed: true,
      slotUpdates: {
        status: (slot.attempt_count || 0) >= MAX_ATTEMPTS_PER_ANGLE_SLOT ? 'failed' : 'reserved',
        failure_reason: reason,
      },
    };
  }

  await linkFlexAdToBatches([], flexAdId, ...progress.batchIds);
  for (const batchId of progress.batchIds) {
    const existing = batchesById.get(batchId);
    if (existing) batchesById.set(batchId, { ...existing, flex_ad_id: flexAdId });
  }

  return {
    finalized: true,
    slotUpdates: {
      status: 'produced',
      produced_flex_ad_id: flexAdId,
      failure_reason: '',
      diagnostics_summary: stringifyJSON({
        approved_ads: progress.passedCount,
        target_ads: targetCount,
        batch_ids: progress.batchIds,
        ready_to_post_count: finalizeResult.ready_to_post_count || 0,
      }, '{}'),
    },
  };
}

function getBatchDiagnosticsSummary(batch) {
  if (!batch) return null;
  const prompts = parseJSON(batch.gpt_prompts, []);
  const state = getBatchPhaseState(batch);
  const stats = parseJSON(batch.batch_stats, {});
  return {
    headline_candidates: batch.headline_candidates || 0,
    scene_alignment_rejections: batch.scene_alignment_rejections || 0,
    scene_alignment_reason_counts: parseJSON(batch.scene_alignment_reason_counts, {}),
    duplicate_rejections: batch.duplicate_rejections || 0,
    history_rejections: batch.history_rejections || 0,
    selected_headline_count: batch.headline_count || 0,
    usable_prompt_count: prompts.length,
    ads_generated: stats.successful ?? prompts.length,
    batch_status: batch.status,
    batch_phase: state?.step || null,
    batch_phase_message: state?.message || null,
    error_message: batch.error_message || null,
    flex_ad_id: batch.flex_ad_id || null,
    filter_processed: batch.filter_processed || false,
  };
}

function getBatchFailureReason(batch, slotProgress = null, targetCount = null) {
  if (!batch || batch.flex_ad_id) return '';
  if (slotProgress && targetCount && slotProgress.passedCount < targetCount) {
    return `qa_target_not_met_${slotProgress.passedCount}_of_${targetCount}`;
  }
  if (batch.error_message) return batch.error_message;
  const diagnostics = getBatchDiagnosticsSummary(batch);
  if ((diagnostics?.usable_prompt_count || 0) === 0) return 'no_usable_prompts_after_stage1';
  if (batch.status === 'completed' && batch.filter_processed && !batch.flex_ad_id) return 'QA finished, but no Ready-to-Post ad set was created.';
  if (batch.status === 'completed') return 'Generation finished, but no Ready-to-Post ad set was created yet.';
  if (batch.status === 'failed') return 'batch_failed';
  return '';
}

function reconcileSchedulerSlot(slot, latestBatch, slotProgress = null, targetCount = null) {
  if (!latestBatch) {
    return {
      status: slot.status,
      produced_flex_ad_id: slot.produced_flex_ad_id || '',
      failure_reason: slot.failure_reason || '',
      diagnostics_summary: slot.diagnostics_summary || '',
    };
  }

  const diagnosticsSummary = stringifyJSON(getBatchDiagnosticsSummary(latestBatch), '{}');
  if (latestBatch.flex_ad_id) {
    return {
      status: 'produced',
      produced_flex_ad_id: latestBatch.flex_ad_id,
      failure_reason: '',
      diagnostics_summary: diagnosticsSummary,
    };
  }

  if (ACTIVE_BATCH_STATUSES.has(latestBatch.status)) {
    return {
      status: 'in_progress',
      diagnostics_summary: diagnosticsSummary,
    };
  }

  return {
    status: (slot.attempt_count || 0) >= MAX_ATTEMPTS_PER_ANGLE_SLOT ? 'failed' : 'reserved',
    produced_flex_ad_id: '',
    failure_reason: getBatchFailureReason(latestBatch, slotProgress, targetCount),
    diagnostics_summary: diagnosticsSummary,
  };
}

function hasSlotChanges(slot, nextFields) {
  return Object.entries(nextFields).some(([key, value]) => {
    const currentValue = slot[key] ?? '';
    return currentValue !== (value ?? '');
  });
}

function buildPostingDaySlotResult(slot) {
  return {
    slot_index: slot.slot_index,
    angle_name: slot.angle_name,
    status: slot.status,
    attempt_count: slot.attempt_count || 0,
    batch_ids: getSlotBatchIds(slot),
    produced_flex_ad_id: slot.produced_flex_ad_id || null,
    failure_reason: slot.failure_reason || null,
    diagnostics_summary: slot.diagnostics_summary ? parseJSON(slot.diagnostics_summary, null) : null,
  };
}

function buildFallbackAngleInfoForSlot(slot) {
  const name = slot?.angle_name || 'General';
  return {
    name,
    externalId: slot?.angle_external_id || 'fallback',
    description: name === 'General'
      ? 'General ad creative angle.'
      : `Director-selected angle: ${name}`,
    prompt_hints: '',
    times_used: 0,
  };
}

async function hydrateAngleInfoForSlot(projectId, slot) {
  const fallback = buildFallbackAngleInfoForSlot(slot);
  try {
    const angles = await getActiveConductorAngles(projectId);
    const byExternalId = slot?.angle_external_id
      ? angles.find(angle => angle.externalId === slot.angle_external_id)
      : null;
    if (byExternalId) return byExternalId;

    const byName = slot?.angle_name
      ? angles.find(angle => angle.name === slot.angle_name)
      : null;
    return byName || fallback;
  } catch (err) {
    console.warn(`[Director] Failed to hydrate angle "${fallback.name}" for slot ${slot?.id || 'unknown'}: ${err.message}`);
    return fallback;
  }
}

async function ensurePostingDaySlots(projectId, config, postingDay) {
  let slots = await getConductorSlotsByPostingDay(projectId, postingDay);
  const target = config.daily_flex_target || 0;
  if (slots.length >= target) return slots;

  const missing = target - slots.length;
  const existingAngleNames = slots.map(slot => slot.angle_name).filter(Boolean);
  const angles = await selectAngles(projectId, config, missing, existingAngleNames);
  for (let i = 0; i < angles.length; i++) {
    const angleInfo = angles[i];
    await createConductorSlot({
      externalId: uuidv4(),
      project_id: projectId,
      posting_day: postingDay,
      slot_index: slots.length + i,
      angle_name: angleInfo.name,
      angle_external_id: angleInfo.externalId || '',
      status: 'reserved',
      batch_ids: '[]',
      attempt_count: 0,
      failure_reason: '',
      diagnostics_summary: '',
    });
  }
  return await getConductorSlotsByPostingDay(projectId, postingDay);
}

async function replaceFailedSlot(projectId, config, postingDay, slot, allSlots) {
  const excludedAngleNames = allSlots
    .filter(candidate => candidate.id !== slot.id && ['reserved', 'in_progress', 'produced'].includes(candidate.status))
    .map(candidate => candidate.angle_name)
    .filter(Boolean);
  if (slot.angle_name) excludedAngleNames.push(slot.angle_name);

  const replacements = await selectAngles(projectId, config, 1, excludedAngleNames);
  if (replacements.length === 0) return null;

  const replacement = replacements[0];
  const updates = {
    angle_name: replacement.name,
    angle_external_id: replacement.externalId || '',
    status: 'reserved',
    batch_ids: '[]',
    attempt_count: 0,
    failure_reason: '',
    diagnostics_summary: '',
    produced_flex_ad_id: '',
  };
  await updateConductorSlot(slot.id, updates);
  return { ...slot, ...updates };
}

/**
 * Select angles for batch creation based on the project's angle_mode config.
 * Returns an array of angle objects, one per batch needed.
 */

async function selectAngles(projectId, config, count, excludedAngleNames = []) {
  const activeAngles = await getActiveConductorAngles(projectId);
  const filtered = filterAnglesByConfiguredTag(activeAngles, config);
  const selectableAngles = filtered.angles;

  if (filtered.tag && selectableAngles.length === 0) {
    throw new Error(`No active angles are tagged "${filtered.tag}". Update the Angle Tag Filter or tag at least one active angle before running Creative Director.`);
  }

  if (selectableAngles.length === 0) {
    // No angles configured — create a "General" angle as fallback
    return Array(count).fill({
      externalId: 'fallback',
      name: 'General',
      description: 'General ad creative — no specific angle targeting.',
      prompt_hints: '',
      times_used: 0,
    });
  }

  const excluded = new Set((excludedAngleNames || []).filter(Boolean));

  let anglesToUse = selectableAngles;
  const filteredAngles = anglesToUse.filter(angle => !excluded.has(angle.name));
  if (filteredAngles.length > 0) {
    anglesToUse = filteredAngles;
  }

  const mode = config.angle_mode || 'manual';
  const rotation = config.angle_rotation || 'round_robin';

  if (mode === 'manual' || mode === 'mixed') {
    return distributeAngles(anglesToUse, count, rotation, config);
  }

  // Auto mode — for now, use existing angles with round robin
  return distributeAngles(anglesToUse, count, rotation, config);
}

// Priority weights for angle selection — higher = more likely to be selected
const PRIORITY_WEIGHTS = { highest: 4, high: 2, medium: 1, test: 0.25 };

function normalizeAngleTag(tag) {
  return String(tag || '').trim();
}

function angleMatchesTag(angle, tag) {
  const normalized = normalizeAngleTag(tag).toLowerCase();
  if (!normalized) return true;
  return Array.isArray(angle?.tags)
    && angle.tags.some(value => normalizeAngleTag(value).toLowerCase() === normalized);
}

function filterAnglesByConfiguredTag(angles, config) {
  const tag = normalizeAngleTag(config?.angle_tag_filter);
  if (!tag) return { tag: '', angles };
  return {
    tag,
    angles: angles.filter(angle => angleMatchesTag(angle, tag)),
  };
}

function getPriorityWeight(angle) {
  return PRIORITY_WEIGHTS[angle.priority] || PRIORITY_WEIGHTS.medium;
}

// Phase 4 — Compute Phase 4 health bias multiplier and exploration boost.
// Returns the overall multiplier on top of the existing usage/priority weighting.
// Defaults are conservative: if health_bias is off (v1 default), returns 1 + 0.
function getHealthMultiplier(angle, config, allActiveAngleCount) {
  const minActive = config.sub_angle_min_active_for_health_bias ?? 3;
  if (!config.health_bias || allActiveAngleCount < minActive) return 1;
  const passRate = angle.lifetime_pass_rate || 0;
  return 1 + passRate;
}

function getExplorationBoost(angle, config) {
  if (!angle.derived_at) return 0;
  const boostDays = config.sub_angle_exploration_boost_days ?? 14;
  const ageDays = (Date.now() - angle.derived_at) / (24 * 60 * 60 * 1000);
  return Math.max(0, 1 - (ageDays / boostDays));
}

// Phase 4 — Lineage cap. If any single root-lineage's combined weight share
// exceeds `cap_share` AND the active pool is large enough, dampen the lineage
// by 0.5×. Lineage = root angle + all transitive descendants via parent_angle_id.
function applyLineageCap(angles, weights, config) {
  const minActive = config.sub_angle_min_active_for_lineage_cap ?? 5;
  if (angles.length < minActive) return weights;
  const capShare = config.sub_angle_lineage_cap_share ?? 0.6;

  // Build root lookup: each angle → its root ancestor
  const idToAngle = new Map(angles.map((a) => [a.externalId, a]));
  function findRoot(angle, depth = 0) {
    if (depth > 10) return angle;
    if (!angle.parent_angle_id) return angle;
    const parent = idToAngle.get(angle.parent_angle_id);
    if (!parent) return angle;
    return findRoot(parent, depth + 1);
  }

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) return weights;

  const rootShare = new Map();
  for (let i = 0; i < angles.length; i++) {
    const root = findRoot(angles[i]);
    rootShare.set(root.externalId, (rootShare.get(root.externalId) || 0) + weights[i]);
  }

  return weights.map((w, i) => {
    const root = findRoot(angles[i]);
    const share = (rootShare.get(root.externalId) || 0) / totalWeight;
    return share > capShare ? w * 0.5 : w;
  });
}

/**
 * Distribute angles across batches using the specified rotation strategy.
 * Priority-aware: angles with higher priority get selected more often.
 */
function distributeAngles(angles, count, rotation, config = {}) {
  if (angles.length === 0) return [];

  switch (rotation) {
    case 'weighted': {
      // Phase 4: priority + recency, then health-bias multiplier,
      // exploration boost, and lineage cap. Round-robin emit.
      const sorted = [...angles].sort((a, b) => {
        const aWeight = getPriorityWeight(a) * getHealthMultiplier(a, config, angles.length) + getExplorationBoost(a, config);
        const bWeight = getPriorityWeight(b) * getHealthMultiplier(b, config, angles.length) + getExplorationBoost(b, config);
        if (aWeight !== bWeight) return bWeight - aWeight;
        return (a.last_used_at || 0) - (b.last_used_at || 0);
      });
      const result = [];
      for (let i = 0; i < count; i++) {
        result.push(sorted[i % sorted.length]);
      }
      return result;
    }

    case 'random': {
      const result = [];
      for (let i = 0; i < count; i++) {
        // Weighted random: usage × priority × health × + exploration boost
        let weights = angles.map(a => {
          const usageWeight = 1 / (1 + (a.times_used || 0));
          const base = usageWeight * getPriorityWeight(a) * getHealthMultiplier(a, config, angles.length);
          return base + getExplorationBoost(a, config);
        });
        weights = applyLineageCap(angles, weights, config);
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * totalWeight;
        let selected = angles[0];
        for (let j = 0; j < angles.length; j++) {
          r -= weights[j];
          if (r <= 0) { selected = angles[j]; break; }
        }
        result.push(selected);
      }
      return result;
    }

    case 'round_robin':
    default: {
      // Sort by priority (desc) then times_used (asc), then rotate
      const sorted = [...angles].sort((a, b) => {
        const priorityDiff = getPriorityWeight(b) - getPriorityWeight(a);
        if (priorityDiff !== 0) return priorityDiff;
        return (a.times_used || 0) - (b.times_used || 0);
      });
      const result = [];
      for (let i = 0; i < count; i++) {
        result.push(sorted[i % sorted.length]);
      }
      return result;
    }
  }
}

const TEST_RUN_DEFAULT_TARGET = 5;
const TEST_RUN_MAX_ROUNDS = 5;
const TEST_RUN_REFILL_MULTIPLIER = 2;
const TEST_RUN_ORCHESTRATION_FAILURE_STATUS = 'orchestration_failed';
const TEST_RUN_INLINE_GEMINI_WAIT_MS = 60 * 1000;
const TEST_RUN_SCORING_STALE_MS = 10 * 60 * 1000;
const TEST_RUN_ROUND_CAP_TERMINAL_STATUS = 'failed_under_threshold_after_round_cap';
const DIRECTOR_SCORE_THRESHOLD = 7;
const TEST_RUN_CANCELLED_STATUS = 'cancelled';
const ACTIVE_CONDUCTOR_RUN_STATUSES = new Set(['running', 'scoring', 'repairing', 'processing']);

function conductorHeartbeatAt() {
  return new Date().toISOString();
}

async function createConductorRun(fields) {
  return await createConductorRunRaw({
    ...fields,
    last_heartbeat_at: fields.last_heartbeat_at || conductorHeartbeatAt(),
  });
}

async function updateConductorRun(id, fields) {
  return await updateConductorRunRaw(id, {
    ...fields,
    last_heartbeat_at: fields.last_heartbeat_at || conductorHeartbeatAt(),
  });
}

function stringifyJSON(value, fallback = '[]') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseJSON(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isTestRunCancelled(run) {
  return !!run && (
    run.terminal_status === TEST_RUN_CANCELLED_STATUS
    || ((run.failure_reason || run.error || '') === 'Cancelled by user')
  );
}

function getTestPostingDays(angleName) {
  return stringifyJSON([{ date: 'test', action: `Testing angle "${angleName}"` }], '[]');
}

function getGeminiTimeoutMessage(roundNumber) {
  return `Round ${roundNumber}: Gemini is still generating images after 30 minutes. Continuing in background.`;
}

function isGeminiBackgroundWaitFailure(run) {
  const failure = run?.failure_reason || run?.error || '';
  return run?.status === 'failed'
    && (failure.includes('Gemini batch timed out after 30 minutes')
      || failure.includes('Gemini is still generating images after 30 minutes'));
}

function isRecoverableScoringTestRun(run) {
  if (run?.status !== 'scoring') return false;
  if (isTestRunCancelled(run) || isRunTerminallyDeployed(run)) return false;

  // Legacy stuck runs were claimed for scoring while still carrying the prior
  // waiting_on_gemini terminal status. These are safe to recover because the
  // scorer never wrote its own claim timestamp.
  if (!run.scoring_started_at && run.terminal_status === 'waiting_on_gemini') {
    return true;
  }

  const scoringStartedAt = Number(run.scoring_started_at);
  return Number.isFinite(scoringStartedAt)
    && scoringStartedAt > 0
    && Date.now() - scoringStartedAt > TEST_RUN_SCORING_STALE_MS;
}

export function normalizeTestRunAdTarget(value, fallback = TEST_RUN_DEFAULT_TARGET) {
  const parsed = Number(value);
  const fallbackParsed = Number(fallback);
  const raw = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackParsed;
  const safe = Number.isFinite(raw) && raw > 0 ? raw : TEST_RUN_DEFAULT_TARGET;
  return Math.max(1, Math.min(DIRECTOR_AD_SET_HARD_CAP, Math.floor(safe)));
}

function getTestRunTargetFromRun(run) {
  return normalizeTestRunAdTarget(run?.required_passes || run?.ads_per_round || TEST_RUN_DEFAULT_TARGET);
}

function getTestRoundBatchSize(roundNumber, totalAdsPassed, requiredPasses = TEST_RUN_DEFAULT_TARGET) {
  const target = normalizeTestRunAdTarget(requiredPasses);
  if (roundNumber <= 1) return getDirectorTopUpBatchSize(target, 0);
  const remaining = Math.max(target - totalAdsPassed, 1);
  return Math.max(2, Math.min(target, remaining * TEST_RUN_REFILL_MULTIPLIER));
}

async function assertTestRunProviderPreflight(projectId, { templateTag = '' } = {}) {
  const [openAIKey, geminiKey, anthropicKey, project] = await Promise.all([
    getSetting('openai_api_key'),
    getSetting('gemini_api_key'),
    getSetting('anthropic_api_key'),
    getProject(projectId),
  ]);

  const missing = [];
  if (!openAIKey) missing.push('OpenAI');
  if (!geminiKey) missing.push('Gemini');
  if (!anthropicKey) missing.push('Anthropic');
  if (missing.length > 0) {
    throw new Error(`Creative Director test run is blocked before generation: ${missing.join(', ')} API key${missing.length === 1 ? ' is' : 's are'} missing in Settings.`);
  }

  if (!project) {
    throw new Error('Creative Director test run is blocked before generation: project not found.');
  }

  try {
    await ensureDefaultCampaign(project);
  } catch (err) {
    throw new Error(`Creative Director test run is blocked before generation: could not resolve an automation campaign. ${err.message || 'Choose or create a campaign in Ad Automation settings.'}`);
  }

  const normalizedTemplateTag = normalizeTemplateTag(templateTag);
  if (normalizedTemplateTag) {
    try {
      await assertTemplateTagHasActiveTemplates(projectId, normalizedTemplateTag);
    } catch (err) {
      throw new Error(`Creative Director test run is blocked before generation: ${err.message}`);
    }
  }

  try {
    const { chat } = await import('./anthropic.js');
    await chat(
      [{ role: 'user', content: 'Reply with exactly: ok' }],
      'claude-sonnet-4-6',
      {
        max_tokens: 8,
        timeout: 30000,
        maxRetries: 0,
        operation: 'conductor_test_preflight',
        projectId,
      }
    );
  } catch (err) {
    throw new Error(`Creative Director test run is blocked before generation: Anthropic preflight failed. ${err.message || 'Check the Anthropic API key in Settings.'}`);
  }
}

function buildTestProgressValue(roundNumber, step, meta = {}) {
  const roundSpan = Math.max(Math.floor(90 / TEST_RUN_MAX_ROUNDS), 1);
  const base = Math.min((roundNumber - 1) * roundSpan, 90);
  const stepValue = (ratio) => base + Math.max(1, Math.round(roundSpan * ratio));
  switch (step) {
    case 'creating_batch':
      return stepValue(0.11);
    case 'batch_brief':
      return stepValue(0.28);
    case 'batch_headlines':
      return stepValue(0.44);
    case 'batch_body_copy':
      return stepValue(0.61);
    case 'batch_image_prompts':
      return stepValue(0.72);
    case 'batch_submitting':
      return stepValue(0.8);
    case 'batch_submitted':
    case 'gemini_waiting':
      return stepValue(0.84);
    case 'gemini_polling':
      return stepValue(0.84) + Math.round(Math.min((meta.elapsed || 0) / 600, 0.95) * Math.max(stepValue(0.95) - stepValue(0.84), 1));
    case 'gemini_complete':
      return stepValue(1);
    case 'filter_scoring':
      if (meta.scoringProgress?.total) {
        return stepValue(1) + Math.round((meta.scoringProgress.current / meta.scoringProgress.total) * 2);
      }
      return stepValue(1);
    case 'repairing_images':
      return stepValue(1) + 2;
    case 'repairing_copy':
      return stepValue(1) + 3;
    case 'round_complete':
      return Math.min(roundNumber * roundSpan, 90);
    case 'filter_grouping':
      return 92;
    case 'filter_copy_gen':
      return 95;
    case 'filter_deploying':
      return 98;
    case 'filter_complete':
      return 100;
    default:
      return undefined;
  }
}

function withTestProgress(roundNumber, event) {
  const progressValue = buildTestProgressValue(roundNumber, event.step, event);
  return progressValue === undefined ? event : { ...event, progressValue };
}

function getBatchPhaseState(batch) {
  const pipelineState = parseJSON(batch?.pipeline_state, {});
  const batchStats = parseJSON(batch?.batch_stats, {});
  return { pipelineState, batchStats };
}

function formatElapsed(seconds) {
  const elapsed = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function getFriendlyPromptStageMessage(roundNumber, step, { current = 0, total = 0 } = {}) {
  if (step === 'batch_brief') {
    return `Round ${roundNumber}: preparing the selected angle for image generation...`;
  }
  if (step === 'batch_headlines') {
    return `Round ${roundNumber}: planning template-matched ad text...`;
  }
  if (step === 'batch_body_copy') {
    return `Round ${roundNumber}: shaping the creative directions for each ad...`;
  }
  if (step === 'batch_image_prompts') {
    const count = total > 0 ? ` (${Math.min(current, total)}/${total})` : '';
    return `Round ${roundNumber}: building image instructions${count}...`;
  }
  return `Round ${roundNumber}: preparing image generation...`;
}

function getDurablePromptStageMessage(roundNumber, pipelineState) {
  const stage = Number(pipelineState?.stage);
  if (stage === 0) return getFriendlyPromptStageMessage(roundNumber, 'batch_brief');
  if (stage === 1) return getFriendlyPromptStageMessage(roundNumber, 'batch_headlines');
  if (stage === 2) return getFriendlyPromptStageMessage(roundNumber, 'batch_body_copy');
  if (stage === 3) {
    return getFriendlyPromptStageMessage(roundNumber, 'batch_image_prompts', {
      current: Number(pipelineState?.current) || 0,
      total: Number(pipelineState?.total) || 0,
    });
  }
  return `Round ${roundNumber}: preparing image generation...`;
}

function getBatchPromptProgress(roundNumber, pipelineState) {
  const stage = Number(pipelineState?.stage);
  if (stage === 0) {
    return buildTestProgressValue(roundNumber, 'batch_brief');
  }
  if (stage === 1) {
    return buildTestProgressValue(roundNumber, 'batch_headlines');
  }
  if (stage === 2) {
    return buildTestProgressValue(roundNumber, 'batch_body_copy');
  }
  if (stage === 3) {
    const total = Number(pipelineState?.total) || 0;
    const current = Number(pipelineState?.current) || 0;
    if (total > 0) {
      const base = buildTestProgressValue(roundNumber, 'batch_body_copy');
      const max = buildTestProgressValue(roundNumber, 'batch_image_prompts');
      if (typeof base === 'number' && typeof max === 'number') {
        return base + Math.round((Math.min(current, total) / total) * (max - base));
      }
    }
    return buildTestProgressValue(roundNumber, 'batch_image_prompts');
  }
  return buildTestProgressValue(roundNumber, 'creating_batch');
}

function buildPlaybookPromptBlock(playbook, { templateMode = false } = {}) {
  if (!playbook || playbook.version <= 0) return '';

  const lines = [];
  if (templateMode) {
    if (playbook.copy_patterns) lines.push(`\n- Copy approach: ${playbook.copy_patterns}`);
  } else {
    if (playbook.visual_patterns) lines.push(`\n- Visual approach: ${playbook.visual_patterns}`);
    if (playbook.copy_patterns) lines.push(`\n- Copy approach: ${playbook.copy_patterns}`);
    if (playbook.avoid_patterns) lines.push(`\n- AVOID: ${playbook.avoid_patterns}`);
    if (playbook.generation_hints) lines.push(`\n- Key hints: ${playbook.generation_hints}`);
  }

  if (lines.length === 0) return '';

  const sectionLabel = templateMode
    ? 'COPY DIRECTION FROM PREVIOUS ROUNDS:'
    : 'CREATIVE DIRECTION FROM PREVIOUS ROUNDS:';

  return `\n\n${sectionLabel}${lines.join('')}\n\nCurrent pass rate for this angle: ${Math.round((playbook.pass_rate || 0) * 100)}%\nFollow these patterns to maximize quality.`;
}

function getGeminiWaitingProgress(roundNumber, batch, batchStats) {
  const waitingBase = buildTestProgressValue(roundNumber, 'gemini_waiting') || 22;
  const completeBase = buildTestProgressValue(roundNumber, 'gemini_complete') || (waitingBase + 6);
  const total = Number(batchStats?.totalCount) || 0;
  const successful = Number(batchStats?.successfulCount) || 0;
  const failed = Number(batchStats?.failedCount) || 0;
  if (total > 0) {
    const finished = Math.min(successful + failed, total);
    return waitingBase + Math.round((finished / total) * Math.max(completeBase - waitingBase - 1, 1));
  }

  const startedAt = batch?.started_at ? Date.parse(batch.started_at) : NaN;
  if (Number.isFinite(startedAt)) {
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return buildTestProgressValue(roundNumber, 'gemini_polling', { elapsed }) || waitingBase;
  }

  return waitingBase;
}

function getDurableRunPhaseMessage(run, batchInfo, batch, pipelineState, batchStats) {
  const roundNumber = batchInfo?.round || 1;
  const total = Number(batchStats?.totalCount) || 0;
  const successful = Number(batchStats?.successfulCount) || 0;
  const failed = Number(batchStats?.failedCount) || 0;
  const finished = Math.min(successful + failed, total);

  if (!batch) {
    return run?.decisions || 'Test run is still processing in background...';
  }

  if (batch.status === 'pending') {
    return run?.decisions || `Round ${roundNumber}: queued to start image generation...`;
  }

  if (batch.status === 'generating_prompts') {
    return getDurablePromptStageMessage(roundNumber, pipelineState);
  }

  if (batch.status === 'submitting') {
    return `Round ${roundNumber}: sending image instructions to Gemini...`;
  }

  if (batch.status === 'processing') {
    if (total > 0) {
      return `Round ${roundNumber}: Gemini is generating images (${finished}/${total} complete)...`;
    }
    return run?.decisions || `Round ${roundNumber}: Gemini is generating images...`;
  }

  if (batch.status === 'saving_results') {
    return `Round ${roundNumber}: saving generated images...`;
  }

  if (batch.status === 'completed' && run?.status === 'running') {
    return `Round ${roundNumber}: images are ready. Creative Filter QA is starting...`;
  }

  if (batch.status === 'failed') {
    return batch.error_message || `Round ${roundNumber} failed.`;
  }

  return run?.decisions || 'Test run is still processing in background...';
}

function buildDurableRunProgress(run, batchInfo, batch) {
  const roundNumber = batchInfo?.round || 1;
  const { pipelineState, batchStats } = getBatchPhaseState(batch);
  const waitingProgress = getGeminiWaitingProgress(roundNumber, batch, batchStats);
  const promptProgress = getBatchPromptProgress(roundNumber, pipelineState);

  if (!batch) {
    const fallback = run?.terminal_status === 'waiting_on_gemini'
      ? buildTestProgressValue(roundNumber, 'gemini_waiting')
      : buildTestProgressValue(roundNumber, 'creating_batch');
    return Math.max(2, fallback || 2);
  }

  switch (batch.status) {
    case 'pending':
      return Math.max(2, buildTestProgressValue(roundNumber, 'creating_batch') || 2);
    case 'generating_prompts':
      return Math.max(2, promptProgress || 2);
    case 'submitting':
      return Math.max(2, buildTestProgressValue(roundNumber, 'batch_submitting') || 14);
    case 'processing':
      return Math.max(2, waitingProgress);
    case 'saving_results':
      return Math.max(2, buildTestProgressValue(roundNumber, 'gemini_complete') || waitingProgress);
    case 'completed':
      return Math.max(2, buildTestProgressValue(roundNumber, 'gemini_complete') || waitingProgress);
    case 'failed':
      return 0;
    default:
      return Math.max(2, promptProgress || waitingProgress || 2);
  }
}

async function buildDurableActiveTestRun(projectId) {
  const runs = await getConductorRuns(projectId, 10);
  const testRuns = runs.filter((run) => run.run_type === 'test');
  const candidate = testRuns.find((run) => ACTIVE_CONDUCTOR_RUN_STATUSES.has(run.status))
    || testRuns.find(isGeminiBackgroundWaitFailure);

  if (!candidate) return null;

  const batchInfos = parseJSON(candidate.batches_created, []);
  const roundDetails = parseJSON(candidate.rounds_json, []);
  const pending = findPendingBatchInfo(batchInfos, roundDetails);
  const currentBatchInfo = pending?.batchInfo || batchInfos[batchInfos.length - 1] || null;
  const batch = currentBatchInfo?.batch_id ? await getBatchJob(currentBatchInfo.batch_id).catch(() => null) : null;
  const { pipelineState, batchStats } = getBatchPhaseState(batch);
  const phase = getDurableRunPhaseMessage(candidate, currentBatchInfo, batch, pipelineState, batchStats);
  const progress = buildDurableRunProgress(candidate, currentBatchInfo, batch);

  return {
    id: candidate.externalId,
    runId: candidate.externalId,
    projectId,
    status: candidate.status === 'completed' ? 'complete' : candidate.status === 'failed' ? 'error' : 'running',
    progress,
    phase,
    startTime: candidate.run_at || Date.now(),
    result: candidate,
    terminal_status: candidate.terminal_status || null,
    batchId: currentBatchInfo?.batch_id || null,
  };
}

export async function getActiveTestRunSnapshot(projectId) {
  const tracked = getActiveTestRun(projectId);
  if (tracked) return tracked;
  return await buildDurableActiveTestRun(projectId);
}

async function loadTestRunContext(projectId, angleOverride) {
  const config = await getConductorConfig(projectId);
  if (!config) {
    throw new Error('No conductor config for this project. Create one first.');
  }

  const project = await getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  let angleInfo;
  if (angleOverride) {
    const allAngles = await getActiveConductorAngles(projectId);
    const filtered = filterAnglesByConfiguredTag(allAngles, config);
    if (filtered.tag && filtered.angles.length === 0) {
      throw new Error(`No active angles are tagged "${filtered.tag}". Update the Angle Tag Filter or tag at least one active angle before running Creative Director.`);
    }
    angleInfo = filtered.angles.find(a => a.externalId === angleOverride);
    if (!angleInfo) throw new Error('Selected angle not found or not active');
  } else {
    const angles = await selectAngles(projectId, config, 1);
    angleInfo = angles[0];
  }

  let anglePrompt;
  if (hasStructuredBrief(angleInfo)) {
    anglePrompt = buildStructuredAnglePrompt(angleInfo);
  } else {
    anglePrompt = angleInfo.description;
  }
  if (angleInfo.prompt_hints) {
    anglePrompt += `\n\nCREATIVE DIRECTION:\n${angleInfo.prompt_hints}`;
  }

  const playbook = await getConductorPlaybook(projectId, angleInfo.name);
  anglePrompt += buildPlaybookPromptBlock(playbook, { templateMode: true });

  const angleBriefJSON = hasStructuredBrief(angleInfo)
    ? JSON.stringify(buildAngleBriefJSON(angleInfo))
    : undefined;

  return { config, project, angleInfo, anglePrompt, angleBriefJSON };
}

async function createTestBatchRound({
  projectId,
  project,
  runId,
  angleInfo,
  anglePrompt,
  angleBriefJSON,
  batchSize,
  roundNumber,
  emit,
  updateAngleUsage = false,
  queueForScheduler = false,
  templateTag = '',
  imageModel = undefined,
}) {
  const batchId = uuidv4();
  const queuedAt = queueForScheduler ? new Date().toISOString() : undefined;
  const resolvedImageModel = resolveImageModel(imageModel);
  emit(withTestProgress(roundNumber, {
    type: 'progress',
    step: 'creating_batch',
    message: `Round ${roundNumber}: preparing ${batchSize} ads for the selected angle...`,
    roundNumber,
    generatedTarget: batchSize,
  }));

  await createBatchJob({
    id: batchId,
    project_id: projectId,
    generation_mode: 'batch',
    batch_size: batchSize,
    angle: anglePrompt,
    aspect_ratio: '1:1',
    product_image_storageId: await copyProjectProductImageForBatch(project),
    filter_assigned: true,
    posting_day: 'test',
    conductor_run_id: runId,
    angle_name: angleInfo.name,
    angle_prompt: anglePrompt,
    angle_brief: angleBriefJSON,
    template_tag: normalizeTemplateTag(templateTag) || undefined,
    image_model: resolvedImageModel,
    image_provider: getImageProvider(resolvedImageModel),
    status: queueForScheduler ? 'queued' : undefined,
    queued_at: queuedAt,
    last_heartbeat_at: queuedAt,
  });

  if (updateAngleUsage && angleInfo.externalId !== 'fallback') {
    await updateConductorAngle(angleInfo.externalId, {
      times_used: (angleInfo.times_used || 0) + 1,
      last_used_at: Date.now(),
    });
  }

  return {
    batch_id: batchId,
    angle_name: angleInfo.name,
    ad_count: batchSize,
    posting_day: 'test',
    round: roundNumber,
    template_tag: normalizeTemplateTag(templateTag) || '',
  };
}

async function executeTestBatchRound(batchId, roundNumber, emit, shouldCancel = null, progressContext = {}) {
  const roundEmit = (event) => emit(withTestProgress(roundNumber, event));
  const throwIfCancelled = async () => {
    if (!shouldCancel || !shouldCancel()) return;
    const batch = await getBatchJob(batchId).catch(() => null);
    if (batch?.gemini_batch_job) {
      try {
        const { getClient } = await import('./gemini.js');
        const ai = await getClient();
        await ai.batches.cancel({ name: batch.gemini_batch_job });
      } catch (err) {
        console.warn(`[Director] Could not cancel Gemini batch ${batchId.slice(0, 8)}:`, err.message);
      }
    }
    try {
      await updateBatchJob(batchId, { status: 'failed', error_message: 'Cancelled by user' });
    } catch {}
    throw new Error('Cancelled by user');
  };

  const batchAdapter = (event) => {
    if (event.type === 'prompt_progress') {
      const msg = event.message || '';
      let step = 'batch_pipeline';
      if (msg.includes('Step 1')) step = 'batch_brief';
      else if (msg.includes('Step 2')) step = 'batch_headlines';
      else if (msg.includes('Step 3')) step = 'batch_body_copy';
      else if (msg.includes('Step 4')) step = 'batch_image_prompts';
      const current = Number(event.current) || 0;
      const total = Number(event.total) || 0;
      roundEmit({
        type: 'progress',
        step,
        message: getFriendlyPromptStageMessage(roundNumber, step, { current, total }),
        imageProgress: (current && total) ? { current, total } : undefined,
        roundNumber,
        approvedCount: progressContext.approvedSoFar || 0,
        targetCount: progressContext.requiredPasses,
      });
    } else if (event.type === 'status') {
      const map = { submitting: 'batch_submitting', processing: 'batch_submitted' };
      if (map[event.status]) {
        const message = event.status === 'submitting'
          ? `Round ${roundNumber}: sending image instructions to Gemini...`
          : `Round ${roundNumber}: Gemini accepted the image job.`;
        roundEmit({
          type: 'progress',
          step: map[event.status],
          message,
          roundNumber,
          approvedCount: progressContext.approvedSoFar || 0,
          targetCount: progressContext.requiredPasses,
        });
      }
    } else if (event.type === 'error') {
      emit(event);
    }
  };

  await throwIfCancelled();
  await runBatch(batchId, batchAdapter, { shouldCancel });
  await throwIfCancelled();

  roundEmit({
    type: 'progress',
    step: 'gemini_waiting',
    message: `Round ${roundNumber}: Gemini is generating images...`,
    roundNumber,
    approvedCount: progressContext.approvedSoFar || 0,
    targetCount: progressContext.requiredPasses,
  });

  const pollStart = Date.now();

  while (true) {
    await new Promise(r => setTimeout(r, 10000));
    await throwIfCancelled();
    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    if (Date.now() - pollStart > TEST_RUN_INLINE_GEMINI_WAIT_MS) {
      return {
        deferred: true,
        step: 'gemini_waiting',
        message: getBackgroundWaitingMessage(roundNumber),
      };
    }

    const result = await pollBatchJob(batchId);
    if (result === 'completed') {
      roundEmit({
        type: 'progress',
        step: 'gemini_complete',
        message: `Round ${roundNumber}: images are ready after ${timeStr}. Starting Creative Filter QA...`,
        roundNumber,
        approvedCount: progressContext.approvedSoFar || 0,
        targetCount: progressContext.requiredPasses,
      });
      break;
    }
    if (result === 'failed') {
      throw new Error(`Round ${roundNumber} Gemini batch processing failed`);
    }

    const latestBatch = await getBatchJob(batchId).catch(() => null);
    const { batchStats } = getBatchPhaseState(latestBatch);
    const total = Number(batchStats?.totalCount) || 0;
    const successful = Number(batchStats?.successfulCount) || 0;
    const failed = Number(batchStats?.failedCount) || 0;
    const finished = total > 0 ? Math.min(successful + failed, total) : 0;
    const countText = total > 0 ? ` (${finished}/${total} complete)` : '';
    roundEmit({
      type: 'progress',
      step: 'gemini_polling',
      message: `Round ${roundNumber}: Gemini is generating images${countText}... elapsed ${timeStr}`,
      elapsed,
      roundNumber,
      approvedCount: progressContext.approvedSoFar || 0,
      targetCount: progressContext.requiredPasses,
      imageProgress: total > 0 ? { current: finished, total } : undefined,
    });
  }

  return { deferred: false };
}

function buildTestRunSummary({
  angleName,
  roundsUsed,
  totalAdsGenerated,
  totalAdsPassed,
  requiredPasses = TEST_RUN_DEFAULT_TARGET,
  readyToPostCount = 0,
  terminalStatus,
  failureReason = '',
}) {
  const target = normalizeTestRunAdTarget(requiredPasses);
  if (terminalStatus === 'deployed') {
    return `Angle "${angleName}" reached ${target}/${target} passed ads after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${totalAdsGenerated} generated). ${readyToPostCount} Ready to Post ads created.`;
  }
  if (terminalStatus === TEST_RUN_ROUND_CAP_TERMINAL_STATUS || terminalStatus === 'failed_under_threshold_after_54') {
    return `Angle "${angleName}" reached ${totalAdsPassed}/${target} passed ads after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${totalAdsGenerated} generated). Round cap reached with no Ready to Post ad set.`;
  }
  if (terminalStatus === 'cancelled') {
    return `Angle "${angleName}" was cancelled after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${totalAdsGenerated} generated, ${totalAdsPassed}/${target} passed so far).`;
  }
  return failureReason || `Angle "${angleName}" failed before reaching ${target} passed ads.`;
}

function buildPassingAdsMeta(passingAds) {
  return passingAds.map(({ ad, score }) => ({
    ad_id: ad.id,
    overall_score: score?.overall_score ?? 0,
  }));
}

function getFailedHardRequirements(score) {
  const hardRequirements = score?.hard_requirements && typeof score.hard_requirements === 'object'
    ? score.hard_requirements
    : {};
  const failedHardRequirements = Object.entries(hardRequirements)
    .filter(([key, value]) => key !== 'all_passed' && value === false)
    .map(([key]) => key);
  return { hardRequirements, failedHardRequirements };
}

function hasMeaningfulImageIssues(score) {
  const imageIssues = Array.isArray(score?.image_issues) ? score.image_issues.filter(Boolean) : [];
  if (imageIssues.length > 0) return true;
  const weaknessText = Array.isArray(score?.weaknesses) ? score.weaknesses.join(' ') : '';
  return /broken render|broken text|unreadable|distort|artifact|warped|mangled|deformed|placeholder|blank area|wrong product|missing product|impossible|composit/i.test(weaknessText);
}

function classifyScoreFailure(score) {
  const { hardRequirements, failedHardRequirements } = getFailedHardRequirements(score);
  const grammarFailed = failedHardRequirements.includes('spelling_grammar');
  const productFailed = failedHardRequirements.some((key) => ['product_present', 'correct_product'].includes(key));
  const imageFailed = failedHardRequirements.some((key) => ['visual_integrity', 'rendered_text_integrity', 'image_completeness'].includes(key));
  const legacyCopyFailed = failedHardRequirements.some((key) => ['first_line_hook', 'cta_at_end'].includes(key));
  const legacyHeadlineFailed = failedHardRequirements.includes('headline_alignment');
  const imageIssues = hasMeaningfulImageIssues(score);
  const imageQuality = Number(score?.visual_integrity_score ?? score?.image_quality);
  const copyStrength = Number(score?.copy_polish ?? score?.copy_strength);
  const effectiveness = Number(score?.effectiveness);
  const hardPassed = hardRequirements?.all_passed === true;
  const copyFailed = grammarFailed || legacyCopyFailed;
  const imageSignals = imageFailed || imageIssues || (Number.isFinite(imageQuality) && imageQuality > 0 && imageQuality <= 5);

  if (hardPassed) {
    if (Number.isFinite(imageQuality) && Number.isFinite(copyStrength) && imageQuality < copyStrength) {
      return {
        bucket: 'image_only',
        recommended_fix: 'rewrite_image',
        repairable_without_headline: true,
      };
    }
    if (Number.isFinite(copyStrength) && copyStrength > 0 && copyStrength < 6) {
      return {
        bucket: 'copy_only',
        recommended_fix: 'rewrite_body_copy',
        repairable_without_headline: true,
      };
    }
    if (Number.isFinite(effectiveness) && effectiveness < DIRECTOR_SCORE_THRESHOLD && imageSignals) {
      return {
        bucket: 'image_only',
        recommended_fix: 'rewrite_image',
        repairable_without_headline: true,
      };
    }
  }

  if ((!copyFailed && !legacyHeadlineFailed) && (productFailed || imageSignals)) {
    return {
      bucket: 'image_only',
      recommended_fix: 'rewrite_image',
      repairable_without_headline: true,
    };
  }

  if (copyFailed && !(productFailed || imageSignals)) {
    return {
      bucket: 'copy_only',
      recommended_fix: 'rewrite_body_copy',
      repairable_without_headline: true,
    };
  }

  return {
    bucket: 'mixed',
    recommended_fix: copyFailed ? 'rewrite_body_and_image' : 'rewrite_image',
    repairable_without_headline: true,
  };
}

function summarizeRoundFailures(failedAds) {
  const bucketCounts = {};
  const hardRequirementCounts = {};
  const imageThemeCounts = {};
  const themeMatchers = [
    ['missing_product', /missing product|product missing|no product|product absent/i],
    ['wrong_product', /wrong product|different product|competitor/i],
    ['unreadable_text_on_creative', /unreadable text|mangled text|broken text|illegible/i],
    ['broken_render', /broken render|blank area|placeholder|artifact|glitch|incomplete/i],
    ['irrational_image', /irrational|impossible|warped|deformed|mangled anatomy|extra finger|distorted/i],
    ['copy_polish_low', /copy polish|awkward|stiff|generic|grammar|typo/i],
    ['compliance_risk', /compliance|policy|before\/after|medical claim|guarantee/i],
  ];

  for (const failedAd of failedAds) {
    const bucket = failedAd.failure_bucket || 'unknown';
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    for (const key of failedAd.failed_hard_requirements || []) {
      hardRequirementCounts[key] = (hardRequirementCounts[key] || 0) + 1;
    }
    const issueText = [...(failedAd.image_issues || []), ...(failedAd.weaknesses || [])].join(' ');
    for (const [theme, matcher] of themeMatchers) {
      if (matcher.test(issueText)) {
        imageThemeCounts[theme] = (imageThemeCounts[theme] || 0) + 1;
      }
    }
  }

  return {
    total_failed: failedAds.length,
    bucket_counts: bucketCounts,
    hard_requirement_counts: hardRequirementCounts,
    image_theme_counts: imageThemeCounts,
  };
}

function buildFailedAdsMeta(scoredAds) {
  return scoredAds
    .filter(({ score }) => !score?.pass)
    .map(({ ad, score }) => {
      const { hardRequirements, failedHardRequirements } = getFailedHardRequirements(score);
      const failureClassification = classifyScoreFailure(score);

      return {
        ad_id: ad?.id,
        headline: ad?.headline || '',
        body_copy_preview: (ad?.body_copy || '').slice(0, 320),
        overall_score: score?.overall_score ?? 0,
        copy_strength: score?.copy_strength ?? score?.copy_polish ?? null,
        copy_polish: score?.copy_polish ?? score?.copy_strength ?? null,
        compliance: score?.compliance ?? score?.meta_compliance ?? null,
        meta_compliance: score?.meta_compliance ?? score?.compliance ?? null,
        effectiveness: score?.effectiveness ?? null,
        image_quality: score?.image_quality ?? score?.visual_integrity_score ?? null,
        visual_integrity: score?.visual_integrity_score ?? score?.image_quality ?? null,
        visual_contract_match: score?.visual_contract_match ?? null,
        angle_category: score?.angle_category || null,
        failed_hard_requirements: failedHardRequirements,
        hard_requirements: hardRequirements,
        compliance_flags: Array.isArray(score?.compliance_flags) ? score.compliance_flags.filter(Boolean) : [],
        spelling_errors: Array.isArray(score?.spelling_errors) ? score.spelling_errors.filter(Boolean) : [],
        weaknesses: Array.isArray(score?.weaknesses) ? score.weaknesses.filter(Boolean) : [],
        strengths: Array.isArray(score?.strengths) ? score.strengths.filter(Boolean) : [],
        image_issues: Array.isArray(score?.image_issues) ? score.image_issues.filter(Boolean) : [],
        failure_bucket: failureClassification.bucket,
        recommended_fix: failureClassification.recommended_fix,
        repairable_without_headline: failureClassification.repairable_without_headline,
        error: score?.error || null,
      };
    });
}

function normalizeHeadlineDiagnostics(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const laneDistribution = Object.fromEntries(
    Object.entries(raw.lane_distribution || {})
      .map(([lane, count]) => [lane, Number(count) || 0])
      .filter(([, count]) => count > 0)
  );
  const headlineCandidates = Number(raw.headline_candidates);
  const headlineCount = Number(raw.headline_count);
  const duplicateRejections = Number(raw.duplicate_rejections);
  const historyRejections = Number(raw.history_rejections);
  const laneCount = Number(raw.lane_count) || Object.keys(laneDistribution).length;
  const hasDiagnostics =
    Number.isFinite(headlineCandidates) ||
    Number.isFinite(headlineCount) ||
    Number.isFinite(duplicateRejections) ||
    Number.isFinite(historyRejections) ||
    laneCount > 0;

  if (!hasDiagnostics) return null;

  return {
    ...(Number.isFinite(headlineCandidates) ? { headline_candidates: headlineCandidates } : {}),
    ...(Number.isFinite(headlineCount) ? { headline_count: headlineCount } : {}),
    ...(Number.isFinite(duplicateRejections) ? { duplicate_rejections: duplicateRejections } : {}),
    ...(Number.isFinite(historyRejections) ? { history_rejections: historyRejections } : {}),
    ...(laneCount > 0 ? { lane_count: laneCount } : {}),
    ...(Object.keys(laneDistribution).length > 0 ? { lane_distribution: laneDistribution } : {}),
  };
}

function extractHeadlineDiagnostics(batch) {
  if (!batch) return null;
  const pipelineState = parseJSON(batch.pipeline_state, {});
  const directDiagnostics = normalizeHeadlineDiagnostics(pipelineState?.headline_diagnostics || pipelineState);
  if (directDiagnostics) return directDiagnostics;

  const prompts = parseJSON(batch.gpt_prompts, []);
  if (!Array.isArray(prompts) || prompts.length === 0) return null;

  const laneDistribution = prompts.reduce((distribution, promptObj) => {
    const lane = typeof promptObj?.hook_lane === 'string' && promptObj.hook_lane.trim()
      ? promptObj.hook_lane.trim()
      : 'unassigned';
    distribution[lane] = (distribution[lane] || 0) + 1;
    return distribution;
  }, {});

  return normalizeHeadlineDiagnostics({
    headline_count: prompts.length,
    lane_count: Object.keys(laneDistribution).length,
    lane_distribution: laneDistribution,
  });
}

function extractHeadlineDiagnosticsSafe(batch, context = '') {
  try {
    return extractHeadlineDiagnostics(batch);
  } catch (err) {
    console.warn(`[Director] Failed to extract headline diagnostics${context ? ` for ${context}` : ''}:`, err.message);
    return null;
  }
}

function buildCompletedRoundDetail({
  batch,
  batchInfo,
  angleName,
  roundNumber,
  roundScoreResult,
  totalAdsPassed,
  requiredPasses = TEST_RUN_DEFAULT_TARGET,
  repairSummary = null,
}) {
  const target = normalizeTestRunAdTarget(requiredPasses);
  const failedAds = buildFailedAdsMeta(roundScoreResult.scoredAds);
  const roundDetail = {
    round: roundNumber,
    batch_id: batchInfo.batch_id,
    angle_name: angleName,
    ads_generated: batchInfo.ad_count || roundScoreResult.ads_scored,
    ads_scored: roundScoreResult.ads_scored,
    ads_passed: roundScoreResult.ads_passed,
    cumulative_passed: totalAdsPassed,
    status: totalAdsPassed >= target ? 'threshold_reached' : 'below_threshold',
    completed_at: new Date().toISOString(),
    passing_ads: buildPassingAdsMeta(roundScoreResult.passingAds),
    failed_ads: failedAds,
    failure_summary: summarizeRoundFailures(failedAds),
  };

  if (repairSummary && repairSummary.attempted > 0) {
    roundDetail.repair_summary = repairSummary;
    roundDetail.repair_attempts = repairSummary.repair_attempts || [];
  }

  const headlineDiagnostics = extractHeadlineDiagnosticsSafe(
    batch,
    `round ${roundNumber} (${batchInfo.batch_id?.slice(0, 8) || 'unknown batch'})`
  );
  if (headlineDiagnostics) {
    Object.assign(roundDetail, headlineDiagnostics);
  }

  return roundDetail;
}

function updateScoredBatchInfo(batchInfo, roundScoreResult, extra = {}) {
  return {
    ...batchInfo,
    ads_scored: roundScoreResult.ads_scored,
    ads_passed: roundScoreResult.ads_passed,
    ...extra,
  };
}

function getRepairBatchLimit(remainingNeeded) {
  return Math.max(2, Math.min(8, remainingNeeded * 2));
}

function buildImageRepairNotes(score) {
  const notes = [];
  for (const issue of [...(score?.image_issues || []), ...(score?.weaknesses || [])]) {
    if (typeof issue === 'string' && issue.trim()) notes.push(issue.trim());
  }
  if ((score?.hard_requirements || {}).visual_integrity === false || (score?.hard_requirements || {}).image_completeness === false) {
    notes.push('Fix any broken render, placeholder, blank area, unrealistic artifact, or irrational visual detail.');
  }
  if ((score?.hard_requirements || {}).rendered_text_integrity === false) {
    notes.push('Keep the exact headline and body copy visible on the creative with clean, readable, correctly rendered text.');
  }
  if ((score?.hard_requirements || {}).product_present === false) {
    notes.push('Ensure the intended product is clearly present in the ad and positioned where the template implies it should appear.');
  }
  if ((score?.hard_requirements || {}).correct_product === false) {
    notes.push('Show the correct product only. Remove any unrelated or competitor-looking product imagery.');
  }
  if (!notes.some((note) => /headline|body copy|text hierarchy|layout/i.test(note))) {
    notes.push('Keep the exact headline and body copy visible on the creative with clean, readable text hierarchy.');
  }
  if (!notes.some((note) => /template|layout|composition/i.test(note))) {
    notes.push('Preserve a template-led ad layout with strong visual hierarchy and balanced composition.');
  }
  if (!notes.some((note) => /product/i.test(note))) {
    notes.push('Use the product framing and placement that best matches the selected template.');
  }
  return [...new Set(notes)].slice(0, 6);
}

async function loadRepairReferenceImage(projectId, ad) {
  if (ad?.template_image_id) {
    return await selectTemplateImage(ad.template_image_id);
  }
  if (ad?.inspiration_image_id) {
    return await selectInspirationImage(projectId, ad.inspiration_image_id);
  }
  return await selectInspirationImage(projectId, null);
}

async function createCopyRepairVariant({ originalAd, repairedBodyCopy, batchId }) {
  const newAdId = uuidv4();
  await convexClient.mutation(api.adCreatives.create, {
    externalId: newAdId,
    project_id: originalAd.project_id,
    generation_mode: 'copy_repair',
    angle: originalAd.angle || undefined,
    angle_name: originalAd.angle_name || undefined,
    headline: originalAd.headline || undefined,
    body_copy: repairedBodyCopy || undefined,
    hook_lane: originalAd.hook_lane || undefined,
    core_claim: originalAd.core_claim || undefined,
    target_symptom: originalAd.target_symptom || undefined,
    emotional_entry: originalAd.emotional_entry || undefined,
    desired_belief_shift: originalAd.desired_belief_shift || undefined,
    opening_pattern: originalAd.opening_pattern || undefined,
    sub_angle: originalAd.sub_angle || undefined,
    scoring_mode: originalAd.scoring_mode || undefined,
    copy_render_expectation: originalAd.copy_render_expectation || undefined,
    product_expectation: originalAd.product_expectation || undefined,
    image_prompt: originalAd.image_prompt || undefined,
    gpt_creative_output: originalAd.gpt_creative_output || undefined,
    template_image_id: originalAd.template_image_id || undefined,
    inspiration_image_id: originalAd.inspiration_image_id || undefined,
    storageId: originalAd.storageId || undefined,
    aspect_ratio: originalAd.aspect_ratio || '1:1',
    status: 'completed',
    auto_generated: true,
    parent_ad_id: originalAd.id || undefined,
    batch_job_id: batchId,
  });
  return await getAd(newAdId);
}

async function attemptRoundRepairs({
  roundScoreResult,
  projectId,
  batch,
  roundNumber,
  emit,
  requiredPasses = TEST_RUN_DEFAULT_TARGET,
  priorPassed = 0,
}) {
  const failedEntries = (roundScoreResult.scoredAds || [])
    .filter(({ score }) => !score?.pass)
    .map(({ ad, score }) => ({
      ad,
      score,
      ...classifyScoreFailure(score),
    }));

  const target = normalizeTestRunAdTarget(requiredPasses);
  const remainingNeeded = Math.max(target - Math.max(0, Math.floor(Number(priorPassed) || 0)) - roundScoreResult.passingAds.length, 0);
  if (failedEntries.length === 0 || remainingNeeded <= 0) {
    return {
      repairedPassingAds: [],
      repairedScoredAds: [],
      repairSummary: {
        attempted: 0,
        passed: 0,
        image_attempted: 0,
        image_passed: 0,
        copy_attempted: 0,
        copy_passed: 0,
      },
    };
  }

  const project = await getProject(projectId);
  if (!project) {
    return {
      repairedPassingAds: [],
      repairedScoredAds: [],
      repairSummary: {
        attempted: 0,
        passed: 0,
        image_attempted: 0,
        image_passed: 0,
        copy_attempted: 0,
        copy_passed: 0,
      },
    };
  }

  let angleBrief = null;
  if (batch?.angle_brief) {
    try { angleBrief = JSON.parse(batch.angle_brief); } catch {}
  }

  const maxAttempts = getRepairBatchLimit(remainingNeeded);
  const repairedScoredAds = [];
  const repairedPassingAds = [];
  const repairAttempts = [];
  const repairSummary = {
    attempted: 0,
    passed: 0,
    image_attempted: 0,
    image_passed: 0,
    copy_attempted: 0,
    copy_passed: 0,
  };

  const { scoreAd } = await import('./creativeFilterService.js');

  const imageCandidates = failedEntries
    .filter((entry) => entry.bucket === 'image_only')
    .sort((left, right) => (Number(right.score?.overall_score) || 0) - (Number(left.score?.overall_score) || 0));
  const copyCandidates = failedEntries
    .filter((entry) => entry.bucket === 'copy_only' && entry.repairable_without_headline)
    .sort((left, right) => (Number(right.score?.overall_score) || 0) - (Number(left.score?.overall_score) || 0));

  for (const entry of imageCandidates) {
    if (repairSummary.attempted >= maxAttempts) break;
    repairSummary.attempted += 1;
    repairSummary.image_attempted += 1;
    emit?.({
      type: 'progress',
      step: 'repairing_images',
      message: `Round ${roundNumber}: repairing image ${repairSummary.image_attempted} of ${Math.min(imageCandidates.length, maxAttempts)}...`,
    });
    let repairReference = null;
    try {
      repairReference = await loadRepairReferenceImage(projectId, entry.ad);
      const imagePrompt = await generateImagePrompt(
        project,
        entry.ad.headline,
        entry.ad.body_copy,
        entry.ad.emotional_entry || 'recognition',
        repairReference,
        entry.ad.aspect_ratio || '1:1',
        angleBrief,
        {
          hook_lane: entry.ad.hook_lane,
          sub_angle: entry.ad.sub_angle,
          core_claim: entry.ad.core_claim,
          target_symptom: entry.ad.target_symptom,
          emotional_entry: entry.ad.emotional_entry,
          desired_belief_shift: entry.ad.desired_belief_shift,
          opening_pattern: entry.ad.opening_pattern,
        },
        {
          repairNotes: buildImageRepairNotes(entry.score),
        }
      );
      const repairedAd = await regenerateImageOnly(projectId, {
        imagePrompt,
        aspectRatio: entry.ad.aspect_ratio || '1:1',
        parentAdId: entry.ad.id,
        angle: entry.ad.angle,
        angleName: entry.ad.angle_name,
        headline: entry.ad.headline,
        bodyCopy: entry.ad.body_copy,
        scoringMode: entry.ad.scoring_mode,
        copyRenderExpectation: entry.ad.copy_render_expectation,
        productExpectation: entry.ad.product_expectation,
        hookLane: entry.ad.hook_lane,
        coreClaim: entry.ad.core_claim,
        targetSymptom: entry.ad.target_symptom,
        emotionalEntry: entry.ad.emotional_entry,
        desiredBeliefShift: entry.ad.desired_belief_shift,
        openingPattern: entry.ad.opening_pattern,
        subAngle: entry.ad.sub_angle,
        templateImageId: entry.ad.template_image_id,
        inspirationImageId: entry.ad.inspiration_image_id,
      });
      const savedAd = await getAd(repairedAd.id);
      const repairedScore = await scoreAd(savedAd, 'No previous top performers available.', angleBrief, projectId);
      const scoredEntry = { ad: savedAd, score: repairedScore, repaired_from_ad_id: entry.ad.id, repair_mode: 'image_only' };
      repairedScoredAds.push(scoredEntry);
      repairAttempts.push({
        mode: 'image_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: savedAd?.id || null,
        passed: !!repairedScore?.pass,
        overall_score: repairedScore?.overall_score ?? 0,
      });
      if (repairedScore?.pass) {
        repairedPassingAds.push(scoredEntry);
        repairSummary.passed += 1;
        repairSummary.image_passed += 1;
      }
    } catch (err) {
      repairedScoredAds.push({
        ad: { id: entry.ad.id, headline: entry.ad.headline, body_copy: entry.ad.body_copy, angle: entry.ad.angle },
        score: { ad_id: entry.ad.id, overall_score: 0, pass: false, error: err.message },
        repaired_from_ad_id: entry.ad.id,
        repair_mode: 'image_only',
      });
      repairAttempts.push({
        mode: 'image_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: null,
        passed: false,
        overall_score: 0,
        error: err.message,
      });
    } finally {
      cleanupImageData(repairReference);
    }
  }

  for (const entry of copyCandidates) {
    if (repairSummary.attempted >= maxAttempts) break;
    repairSummary.attempted += 1;
    repairSummary.copy_attempted += 1;
    emit?.({
      type: 'progress',
      step: 'repairing_copy',
      message: `Round ${roundNumber}: repairing copy ${repairSummary.copy_attempted}...`,
    });
    try {
      const repairedCopy = await repairBodyCopy(project, {
        headline: entry.ad.headline,
        bodyCopy: entry.ad.body_copy,
        angleBrief,
        failedReasons: entry.score?.weaknesses || [],
        weaknesses: entry.score?.compliance_flags || [],
      });
      const repairedAd = await createCopyRepairVariant({
        originalAd: entry.ad,
        repairedBodyCopy: repairedCopy.body_copy,
        batchId: batch?.id || batch?.externalId || entry.ad.batch_job_id,
      });
      const repairedScore = await scoreAd(repairedAd, 'No previous top performers available.', angleBrief, projectId);
      const scoredEntry = { ad: repairedAd, score: repairedScore, repaired_from_ad_id: entry.ad.id, repair_mode: 'copy_only' };
      repairedScoredAds.push(scoredEntry);
      repairAttempts.push({
        mode: 'copy_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: repairedAd?.id || null,
        passed: !!repairedScore?.pass,
        overall_score: repairedScore?.overall_score ?? 0,
      });
      if (repairedScore?.pass) {
        repairedPassingAds.push(scoredEntry);
        repairSummary.passed += 1;
        repairSummary.copy_passed += 1;
      }
    } catch (err) {
      repairedScoredAds.push({
        ad: { id: entry.ad.id, headline: entry.ad.headline, body_copy: entry.ad.body_copy, angle: entry.ad.angle },
        score: { ad_id: entry.ad.id, overall_score: 0, pass: false, error: err.message },
        repaired_from_ad_id: entry.ad.id,
        repair_mode: 'copy_only',
      });
      repairAttempts.push({
        mode: 'copy_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: null,
        passed: false,
        overall_score: 0,
        error: err.message,
      });
    }
  }

  repairSummary.repair_attempts = repairAttempts;
  return { repairedPassingAds, repairedScoredAds, repairSummary, repairAttempts };
}

async function linkFlexAdToBatches(batchInfos, flexAdId, ...batchIds) {
  if (!flexAdId) return batchInfos;
  const uniqueBatchIds = [...new Set(batchIds.filter(Boolean))];
  if (uniqueBatchIds.length === 0) return batchInfos;

  await Promise.all(uniqueBatchIds.map(async (batchId) => {
    try {
      await updateBatchJob(batchId, { flex_ad_id: flexAdId });
    } catch (err) {
      console.warn(`[Director] Failed to link flex ad ${flexAdId.slice(0, 8)} to batch ${batchId.slice(0, 8)}:`, err.message);
    }
  }));

  return batchInfos.map((info) => (
    uniqueBatchIds.includes(info.batch_id)
      ? { ...info, flex_ad_id: flexAdId }
      : info
  ));
}

function isRunTerminallyDeployed(run) {
  return !!run && (run.status === 'completed' || run.terminal_status === 'deployed');
}

async function getLatestTestRunState(projectId, runId) {
  const runs = await getConductorRuns(projectId, 25);
  return runs.find((candidate) => candidate.externalId === runId) || null;
}

async function throwIfDurableTestRunCancelled(projectId, runId) {
  if (!runId) return;
  const latest = await getLatestTestRunState(projectId, runId);
  if (isTestRunCancelled(latest)) {
    throw new Error('Cancelled by user');
  }
}

async function cancelGeminiBatchIfActive(batch) {
  if (!batch?.gemini_batch_job) return false;
  try {
    const { getClient } = await import('./gemini.js');
    const ai = await getClient();
    await ai.batches.cancel({ name: batch.gemini_batch_job });
    return true;
  } catch (err) {
    console.warn(`[Director] Could not cancel Gemini batch ${batch.id || batch.externalId || ''}:`, err.message);
    return false;
  }
}

async function markTestBatchCancelled(batchId) {
  if (!batchId) return { found: false, geminiCancelled: false };
  const batch = await getBatchJob(batchId).catch(() => null);
  if (!batch) return { found: false, geminiCancelled: false };
  const geminiCancelled = await cancelGeminiBatchIfActive(batch);
  if (!['completed', 'failed', 'superseded'].includes(batch.status)) {
    await updateBatchJob(batchId, {
      status: 'failed',
      error_message: 'Cancelled by user',
      last_heartbeat_at: new Date().toISOString(),
    }).catch(() => {});
  }
  return { found: true, geminiCancelled };
}

async function supersedePendingTestRunBatches(batchInfos, completedBatchIds = [], reason = 'Superseded after test run already deployed.') {
  const completed = new Set(completedBatchIds.filter(Boolean));
  for (const info of Array.isArray(batchInfos) ? batchInfos : []) {
    if (info?.batch_id && !completed.has(info.batch_id)) {
      info.status = 'superseded';
      info.error_message = reason;
    }
  }
  const pendingBatchIds = [...new Set(
    (Array.isArray(batchInfos) ? batchInfos : [])
      .map((info) => info?.batch_id)
      .filter((batchId) => batchId && !completed.has(batchId))
  )];

  await Promise.all(pendingBatchIds.map(async (batchId) => {
    try {
      await updateBatchJob(batchId, {
        status: 'superseded',
        error_message: reason,
      });
    } catch (err) {
      console.warn(`[Director] Failed to supersede batch ${batchId.slice(0, 8)}:`, err.message);
    }
  }));
}

async function finalizeSuccessfulTestRun({
  runId,
  projectId,
  angleName,
  batchInfos,
  roundDetails,
  currentBatchId = null,
  totalAdsGenerated,
  totalAdsScored,
  totalAdsPassed,
  requiredPasses = TEST_RUN_DEFAULT_TARGET,
  finalizeResult,
  durationMs,
  triggerLabel = 'test run',
}) {
  const readyToPostCount = finalizeResult.ready_to_post_count || 0;
  const flexAdId = finalizeResult.flex_ad_id || null;
  const bestRound = [...roundDetails].sort((a, b) => b.ads_passed - a.ads_passed)[0];
  const completedBatchIds = roundDetails.map((detail) => detail.batch_id).filter(Boolean);

  await supersedePendingTestRunBatches(
    batchInfos,
    completedBatchIds,
    'Superseded after test run already reached deployment threshold.'
  );

  batchInfos.splice(
    0,
    batchInfos.length,
    ...(await linkFlexAdToBatches(
      batchInfos,
      flexAdId,
      currentBatchId,
      bestRound?.batch_id,
    ))
  );

  await updateConductorRun(runId, {
    status: 'completed',
    terminal_status: 'deployed',
    error: '',
    failure_reason: '',
    error_stage: '',
    posting_days: getTestPostingDays(angleName),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: roundDetails.length,
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    ready_to_post_count: readyToPostCount,
    flex_ad_id: flexAdId || undefined,
    duration_ms: durationMs,
    decisions: buildTestRunSummary({
      angleName,
      roundsUsed: roundDetails.length,
      totalAdsGenerated,
      totalAdsPassed,
      requiredPasses,
      readyToPostCount,
      terminalStatus: 'deployed',
    }),
  });

  return {
    readyToPostCount,
    flexAdId,
    bestRound,
  };
}

function getBackgroundWaitingMessage(roundNumber) {
  return `Round ${roundNumber}: Gemini is still generating images. Continuing in background.`;
}

async function hydratePassingAdsForRounds(roundDetails, projectId, requiredPasses = TEST_RUN_DEFAULT_TARGET) {
  const target = normalizeTestRunAdTarget(requiredPasses);
  const hydrated = [];
  const cumulativePassingAds = [];
  let recoveredAny = false;
  let scoreBatchForInlineFilterFn = null;

  for (let i = 0; i < roundDetails.length; i++) {
    const round = { ...roundDetails[i], round: roundDetails[i].round || i + 1 };
    const passingMeta = Array.isArray(round.passing_ads) ? round.passing_ads : [];
    let passingAds = [];

    if (round.batch_id && passingMeta.length > 0) {
      const ads = await getAdsByBatchId(round.batch_id);
      const adMap = new Map(ads.map(ad => [ad.id, ad]));
      passingAds = passingMeta
        .map((meta) => {
          const ad = adMap.get(meta.ad_id);
          if (!ad) return null;
          return {
            ad,
            score: {
              ad_id: ad.id,
              overall_score: meta.overall_score ?? 0,
              pass: true,
            },
          };
        })
        .filter(Boolean);
    } else if (
      round.batch_id
      && Number(round.ads_scored) > 0
      && Number(round.ads_passed || 0) === 0
    ) {
      passingAds = [];
    } else if (round.batch_id) {
      if (!scoreBatchForInlineFilterFn) {
        ({ scoreBatchForInlineFilter: scoreBatchForInlineFilterFn } = await import('./creativeFilterService.js'));
      }
      const recovered = await scoreBatchForInlineFilterFn(round.batch_id, projectId, null, {
        roundNumber: round.round,
        totalRounds: TEST_RUN_MAX_ROUNDS,
      });
      round.ads_scored = recovered.ads_scored;
      round.ads_passed = recovered.ads_passed;
      round.passing_ads = buildPassingAdsMeta(recovered.passingAds);
      round.failed_ads = buildFailedAdsMeta(recovered.scoredAds);
      passingAds = recovered.passingAds;
      recoveredAny = true;
    }

    cumulativePassingAds.push(...passingAds);
    round.cumulative_passed = cumulativePassingAds.length;
    round.status = cumulativePassingAds.length >= target ? 'threshold_reached' : 'below_threshold';
    hydrated.push(round);
  }

  return { roundDetails: hydrated, cumulativePassingAds, recoveredAny };
}

function isLegacyAutoPostLogImportMessage(message) {
  return String(message || '').includes("does not provide an export named 'createAutoPostLog'");
}

function isLegacyAutoPostLogImportFailure(run) {
  const combinedMessage = `${run?.failure_reason || ''} ${run?.error || ''}`;
  return run?.terminal_status === TEST_RUN_ORCHESTRATION_FAILURE_STATUS
    && run?.error_stage === 'post_score_round_processing'
    && isLegacyAutoPostLogImportMessage(combinedMessage);
}

function buildRepairRoundDetailsFromBatchInfos(batchInfos) {
  return (Array.isArray(batchInfos) ? batchInfos : [])
    .filter((info) => info?.batch_id)
    .map((info, index) => ({
      round: Number(info.round) || index + 1,
      batch_id: info.batch_id,
      angle_name: info.angle_name || '',
      ads_generated: Number(info.ad_count) || 0,
      ads_scored: 0,
      ads_passed: 0,
      cumulative_passed: 0,
      status: 'repair_scoring',
    }));
}

export async function repairDeployFailedTestRun(projectId, runId) {
  if (!projectId || !runId) {
    throw new Error('Project ID and run ID are required.');
  }

  const runs = await getConductorRuns(projectId, 50);
  const run = runs.find((candidate) => candidate.externalId === runId || candidate.id === runId);
  if (!run) {
    throw new Error(`Test run ${runId} was not found for this project.`);
  }

  if (isRunTerminallyDeployed(run)) {
    return {
      repaired: false,
      status: 'already_deployed',
      runId,
      flexAdId: run.flex_ad_id || null,
      readyToPostCount: run.ready_to_post_count || 0,
    };
  }

  if (run.run_type && run.run_type !== 'test') {
    throw new Error(`Run ${runId} is not a Creative Director test run.`);
  }

  const repairableStatuses = new Set(['deploy_failed', 'grouping_failed', 'copy_failed']);
  const isLegacyImportRepair = isLegacyAutoPostLogImportFailure(run);
  if (!repairableStatuses.has(run.terminal_status) && !isLegacyImportRepair) {
    throw new Error(`Run ${runId} is not in a repairable finalization status.`);
  }

  const requiredPasses = getTestRunTargetFromRun(run);
  const batchInfos = parseJSON(run.batches_created, []);
  const originalRoundDetails = parseJSON(run.rounds_json, []);
  const repairRoundDetails = originalRoundDetails.length > 0
    ? originalRoundDetails
    : (isLegacyImportRepair ? buildRepairRoundDetailsFromBatchInfos(batchInfos) : []);
  const hydrated = await hydratePassingAdsForRounds(repairRoundDetails, projectId, requiredPasses);
  const cumulativePassingAds = hydrated.cumulativePassingAds.slice(0, requiredPasses);

  if (cumulativePassingAds.length < requiredPasses) {
    const angleName = hydrated.roundDetails.find((detail) => detail.angle_name)?.angle_name
      || batchInfos.find((info) => info?.angle_name)?.angle_name
      || 'Unknown angle';
    const totalAdsGenerated = run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0);
    const totalAdsScored = hydrated.roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0);
    const terminalStatus = 'repair_under_target';
    const failureReason = `Recovered and scored existing ads, but only ${cumulativePassingAds.length}/${requiredPasses} passed. Start a new test run to generate the remaining approved ads.`;

    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: terminalStatus,
      error: failureReason,
      failure_reason: failureReason,
      error_stage: 'repair_scoring',
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(hydrated.roundDetails),
      total_rounds: hydrated.roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      total_ads_scored: totalAdsScored,
      total_ads_passed: cumulativePassingAds.length,
      ready_to_post_count: 0,
      duration_ms: Number(run.duration_ms) || undefined,
      decisions: buildTestRunSummary({
        angleName,
        roundsUsed: hydrated.roundDetails.length,
        totalAdsGenerated,
        totalAdsPassed: cumulativePassingAds.length,
        requiredPasses,
        terminalStatus,
        failureReason,
      }),
    });

    return {
      repaired: false,
      status: terminalStatus,
      runId,
      passed: cumulativePassingAds.length,
      requiredPasses,
      failureReason,
    };
  }

  const lastRound = [...hydrated.roundDetails].reverse().find((detail) => detail.batch_id);
  const angleName = lastRound?.angle_name
    || batchInfos.find((info) => info?.angle_name)?.angle_name
    || 'Unknown angle';

  const { finalizePassingAds } = await import('./creativeFilterService.js');
  const finalizeResult = await finalizePassingAds({
    passingAds: cumulativePassingAds,
    projectId,
    batchId: lastRound?.batch_id || batchInfos.find((info) => info?.batch_id)?.batch_id || '',
    postingDay: 'test',
    angleName,
    targetCount: requiredPasses,
  });

  if (finalizeResult.flex_ads_created === 0) {
    let failureReason;
    let terminalStatus;
    if (finalizeResult.grouping_failed) {
      terminalStatus = 'grouping_failed';
      failureReason = `${cumulativePassingAds.length} approved ads were available, but grouping could not create an ad set.`;
    } else if (finalizeResult.copy_error) {
      terminalStatus = 'copy_failed';
      failureReason = `Reached ${cumulativePassingAds.length}/${requiredPasses} passed ads, but final copy generation failed: ${finalizeResult.copy_error}`;
    } else {
      terminalStatus = 'deploy_failed';
      failureReason = `Reached ${cumulativePassingAds.length}/${requiredPasses} passed ads, but deployment failed: ${finalizeResult.deploy_error || 'Unknown deployment error'}`;
    }

    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: terminalStatus,
      error: failureReason,
      failure_reason: failureReason,
      error_stage: 'deploy_repair',
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(hydrated.roundDetails),
      total_rounds: hydrated.roundDetails.length,
      total_ads_generated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      total_ads_scored: run.total_ads_scored || hydrated.roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0),
      total_ads_passed: cumulativePassingAds.length,
      ready_to_post_count: 0,
      duration_ms: Number(run.duration_ms) || undefined,
      decisions: buildTestRunSummary({
        angleName,
        roundsUsed: hydrated.roundDetails.length,
        totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
        totalAdsPassed: cumulativePassingAds.length,
        requiredPasses,
        terminalStatus,
        failureReason,
      }),
    });

    return {
      repaired: false,
      status: terminalStatus,
      runId,
      failureReason,
    };
  }

  const successResult = await finalizeSuccessfulTestRun({
    runId,
    projectId,
    angleName,
    batchInfos,
    roundDetails: hydrated.roundDetails,
    currentBatchId: lastRound?.batch_id || null,
    totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
    totalAdsScored: run.total_ads_scored || hydrated.roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0),
    totalAdsPassed: cumulativePassingAds.length,
    requiredPasses,
    finalizeResult,
    durationMs: Number(run.duration_ms) || (Date.now() - (Number(run.run_at) || Date.now())),
    triggerLabel: 'finalization repair',
  });

  return {
    repaired: true,
    status: 'deployed',
    runId,
    flexAdId: successResult.flexAdId,
    readyToPostCount: successResult.readyToPostCount,
  };
}

function findPendingBatchInfo(batchInfos, roundDetails) {
  const nextIndex = roundDetails.length;
  if (nextIndex >= batchInfos.length) return null;
  return { nextIndex, batchInfo: batchInfos[nextIndex] };
}

async function markTestRunWaitingOnGemini({
  runId,
  angleName,
  roundNumber,
  batchInfos,
  roundDetails,
  totalAdsGenerated,
  totalAdsScored,
  totalAdsPassed,
}) {
  await updateConductorRun(runId, {
    status: 'running',
    terminal_status: 'waiting_on_gemini',
    error_stage: 'gemini_waiting',
    error: '',
    failure_reason: '',
    posting_days: angleName ? getTestPostingDays(angleName) : stringifyJSON([{ date: 'test', action: 'Waiting on Gemini' }]),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: Math.max(roundDetails.length, roundNumber),
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    decisions: getBackgroundWaitingMessage(roundNumber),
  });
}

async function markTestRunBackgroundFailure({
  runId,
  angleName,
  batchInfos,
  roundDetails,
  totalAdsGenerated,
  totalAdsScored,
  totalAdsPassed,
  requiredPasses = TEST_RUN_DEFAULT_TARGET,
  failureReason,
  terminalStatus = 'generation_failed',
  errorStage = undefined,
  durationMs = undefined,
}) {
  await updateConductorRun(runId, {
    status: 'failed',
    terminal_status: terminalStatus,
    error: failureReason,
    failure_reason: failureReason,
    error_stage: errorStage,
    posting_days: angleName ? getTestPostingDays(angleName) : stringifyJSON([{ date: 'test', action: 'Background test run failed' }]),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: Math.max(roundDetails.length, batchInfos.length, 1),
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    ready_to_post_count: 0,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    decisions: buildTestRunSummary({
      angleName: angleName || 'Unknown angle',
      roundsUsed: Math.max(roundDetails.length, batchInfos.length, 1),
      totalAdsGenerated,
      totalAdsPassed,
      requiredPasses,
      terminalStatus,
      failureReason,
    }),
  });
}

async function continueBackgroundTestRun(run) {
  const runId = run.externalId;
  const projectId = run.project_id;
  if (isTestRunCancelled(run)) return true;
  const requiredPasses = getTestRunTargetFromRun(run);
  const batchInfos = parseJSON(run.batches_created, []);
  let roundDetails = parseJSON(run.rounds_json, []);
  const latestRun = await getLatestTestRunState(projectId, runId);
  if (isTestRunCancelled(latestRun)) return true;
  if (isRunTerminallyDeployed(latestRun)) {
    await supersedePendingTestRunBatches(
      batchInfos,
      roundDetails.map((detail) => detail.batch_id).filter(Boolean)
    );
    return true;
  }
  const pending = findPendingBatchInfo(batchInfos, roundDetails);
  if (!pending) {
    return false;
  }

  const { batchInfo } = pending;
  const batch = await getBatchJob(batchInfo.batch_id);
  if (!batch) {
    await markTestRunBackgroundFailure({
      runId,
      angleName: batchInfo.angle_name || '',
      batchInfos,
      roundDetails,
      totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      totalAdsScored: run.total_ads_scored || 0,
      totalAdsPassed: run.total_ads_passed || 0,
      requiredPasses,
      failureReason: `Round ${batchInfo.round || (roundDetails.length + 1)} batch record could not be found.`,
    });
    return true;
  }

  if (batch.status === 'pending') {
    const queuedAt = new Date().toISOString();
    await updateBatchJob(batchInfo.batch_id, {
      status: 'queued',
      queued_at: queuedAt,
      last_heartbeat_at: queuedAt,
    });
    await updateConductorRun(runId, {
      status: 'running',
      terminal_status: 'queued_round',
      decisions: `Round ${batchInfo.round || (roundDetails.length + 1)} is queued for generation.`,
    });
    console.log(`[Director] Queued pending background batch ${batchInfo.batch_id.slice(0, 8)} for test run ${runId.slice(0, 8)}`);
    return true;
  }

  if (['queued', 'generating_prompts', 'submitting', 'processing', 'saving_results'].includes(batch.status)) {
    const roundNumber = batchInfo.round || (roundDetails.length + 1);
    const terminalStatus = batch.gemini_batch_job ? 'waiting_on_gemini' : 'building_round';
    const phaseMessage = batch.gemini_batch_job
      ? getBackgroundWaitingMessage(roundNumber)
      : `Round ${roundNumber} is still building prompts. Continuing in background.`;
    await updateConductorRun(runId, {
      status: 'running',
      terminal_status: terminalStatus,
      error: '',
      failure_reason: '',
      posting_days: getTestPostingDays(batchInfo.angle_name || batch.angle_name || ''),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: Math.max(roundDetails.length, roundNumber),
      total_ads_generated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      total_ads_scored: run.total_ads_scored || 0,
      total_ads_passed: run.total_ads_passed || 0,
      decisions: phaseMessage,
    });
    return false;
  }

  if (batch.status === 'failed') {
    await markTestRunBackgroundFailure({
      runId,
      angleName: batchInfo.angle_name || batch.angle_name || '',
      batchInfos,
      roundDetails,
      totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      totalAdsScored: run.total_ads_scored || 0,
      totalAdsPassed: run.total_ads_passed || 0,
      requiredPasses,
      failureReason: batch.error_message || `Round ${batchInfo.round || (roundDetails.length + 1)} batch failed.`,
      terminalStatus: 'provider_failed',
    });
    return true;
  }

  if (batch.status !== 'completed') {
    return false;
  }

  // Claim this run before the long scoring operation so the next scheduler
  // poll won't pick it up again and create duplicate Ready-to-Post ad sets.
  const scoringStartedAt = Date.now();
  await updateConductorRun(runId, {
    status: 'scoring',
    terminal_status: 'filter_scoring',
    error_stage: 'filter_scoring',
    scoring_started_at: scoringStartedAt,
    decisions: `Round ${batchInfo.round || (roundDetails.length + 1)}: Creative Filter QA is scoring generated ads...`,
  });

  let backgroundErrorStage = 'post_score_round_processing';
  let activeRoundState = null;

  try {
    const { scoreBatchForInlineFilter, finalizePassingAds } = await import('./creativeFilterService.js');
    await throwIfDurableTestRunCancelled(projectId, runId);
    const hydrated = await hydratePassingAdsForRounds(roundDetails, projectId, requiredPasses);
    await throwIfDurableTestRunCancelled(projectId, runId);
    roundDetails = hydrated.roundDetails;
    const cumulativePassingAds = [...hydrated.cumulativePassingAds];

    const roundNumber = batchInfo.round || (roundDetails.length + 1);
    backgroundErrorStage = 'filter_scoring';
    const roundScoreResult = await scoreBatchForInlineFilter(batchInfo.batch_id, projectId, (event) => {
      if (event?.step === 'filter_scoring') {
        updateConductorRun(runId, {
          status: 'scoring',
          terminal_status: 'filter_scoring',
          error_stage: 'filter_scoring',
          decisions: event.message || `Round ${roundNumber}: Creative Filter QA is scoring generated ads...`,
        }).catch((err) => {
          console.warn(`[Director] Could not heartbeat scoring run ${runId.slice(0, 8)}: ${err.message}`);
        });
      }
    }, {
      roundNumber,
      totalRounds: TEST_RUN_MAX_ROUNDS,
      shouldCancel: () => throwIfDurableTestRunCancelled(projectId, runId).then(() => false).catch((err) => {
        if (err.message === 'Cancelled by user') return true;
        throw err;
      }),
    });
    await throwIfDurableTestRunCancelled(projectId, runId);
    backgroundErrorStage = 'post_score_round_processing';
    activeRoundState = {
      batchInfo,
      roundNumber,
      batch: roundScoreResult.batch || batch,
      rawScoreResult: roundScoreResult,
      mergedRoundScoreResult: roundScoreResult,
      repairSummary: null,
      countsApplied: false,
      detailPersisted: false,
    };

    const repairResult = await attemptRoundRepairs({
      roundScoreResult,
      projectId,
      batch: roundScoreResult.batch || batch,
      roundNumber,
      emit: null,
      requiredPasses,
      priorPassed: cumulativePassingAds.length,
    });
    await throwIfDurableTestRunCancelled(projectId, runId);
    activeRoundState.repairSummary = repairResult.repairSummary;
    activeRoundState.mergedRoundScoreResult = {
      ...roundScoreResult,
      passingAds: [...roundScoreResult.passingAds, ...repairResult.repairedPassingAds],
      scoredAds: [...roundScoreResult.scoredAds, ...repairResult.repairedScoredAds],
      ads_passed: roundScoreResult.ads_passed + (repairResult.repairSummary?.passed || 0),
    };

    if (repairResult.repairedPassingAds.length > 0) {
      cumulativePassingAds.push(...repairResult.repairedPassingAds);
    }
    cumulativePassingAds.push(...roundScoreResult.passingAds);
    const totalAdsGenerated = batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0);
    const totalAdsScored = roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0) + roundScoreResult.ads_scored + (repairResult.repairSummary?.attempted || 0);
    const totalAdsPassed = cumulativePassingAds.length;
    activeRoundState.countsApplied = true;
    const angleName = batchInfo.angle_name || batch.angle_name || '';

    const roundDetail = buildCompletedRoundDetail({
      batch: roundScoreResult.batch || batch,
      batchInfo,
      angleName,
      roundNumber,
      roundScoreResult: activeRoundState.mergedRoundScoreResult,
      totalAdsPassed,
      requiredPasses,
      repairSummary: repairResult.repairSummary,
    });
    roundDetails.push(roundDetail);
    activeRoundState.detailPersisted = true;

    batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(batchInfo, roundScoreResult, {
      repair_attempts: repairResult.repairSummary?.attempted || 0,
      repair_passes: repairResult.repairSummary?.passed || 0,
    });

    if (totalAdsPassed >= requiredPasses) {
      backgroundErrorStage = 'filter_finalization';
      await throwIfDurableTestRunCancelled(projectId, runId);
      const finalizeResult = await finalizePassingAds({
        passingAds: cumulativePassingAds,
        projectId,
        batchId: batchInfo.batch_id,
        postingDay: 'test',
        angleName,
        targetCount: requiredPasses,
      });

      if (finalizeResult.flex_ads_created === 0) {
        let failureReason = 'Unknown error during Creative Filter';
        let terminalStatus = 'deploy_failed';
        if (finalizeResult.grouping_failed) {
          failureReason = `${totalAdsPassed} approved ads were available, but grouping could not create an ad set.`;
          terminalStatus = 'grouping_failed';
        } else if (finalizeResult.copy_error) {
          failureReason = `Reached ${totalAdsPassed}/${requiredPasses} passed ads, but final copy generation failed: ${finalizeResult.copy_error}`;
          terminalStatus = 'copy_failed';
        } else if (finalizeResult.deploy_error) {
          failureReason = `Reached ${totalAdsPassed}/${requiredPasses} passed ads, but deployment failed: ${finalizeResult.deploy_error}`;
        }

        await updateConductorRun(runId, {
          status: 'failed',
          terminal_status: terminalStatus,
          error: failureReason,
          failure_reason: failureReason,
          error_stage: backgroundErrorStage,
          posting_days: getTestPostingDays(angleName),
          batches_created: stringifyJSON(batchInfos),
          rounds_json: stringifyJSON(roundDetails),
          total_rounds: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          total_ads_scored: totalAdsScored,
          total_ads_passed: totalAdsPassed,
          ready_to_post_count: 0,
          duration_ms: Date.now() - run.run_at,
          decisions: buildTestRunSummary({
            angleName,
            roundsUsed: roundDetails.length,
            totalAdsGenerated,
            totalAdsPassed,
            requiredPasses,
            terminalStatus,
            failureReason,
          }),
        });
        return true;
      }

      await finalizeSuccessfulTestRun({
        runId,
        projectId,
        angleName,
        batchInfos,
        roundDetails,
        currentBatchId: batchInfo.batch_id,
        totalAdsGenerated,
        totalAdsScored,
        totalAdsPassed,
        requiredPasses,
        finalizeResult,
        durationMs: Date.now() - run.run_at,
        triggerLabel: 'background test run',
      });

      console.log(`[Director] Resumed test run ${runId.slice(0, 8)} completed in background: ${totalAdsPassed}/${requiredPasses} passed`);
      return true;
    }

    if (roundNumber >= TEST_RUN_MAX_ROUNDS) {
      const failureReason = `Reached ${totalAdsPassed}/${requiredPasses} passed ads after ${totalAdsGenerated} generated across ${TEST_RUN_MAX_ROUNDS} rounds. Round cap reached with no Ready to Post ad set.`;
      await updateConductorRun(runId, {
        status: 'failed',
        terminal_status: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
        error: failureReason,
        failure_reason: failureReason,
        error_stage: backgroundErrorStage,
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundDetails.length,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        ready_to_post_count: 0,
        duration_ms: Date.now() - run.run_at,
        decisions: buildTestRunSummary({
          angleName,
          roundsUsed: roundDetails.length,
          totalAdsGenerated,
          totalAdsPassed,
          requiredPasses,
          terminalStatus: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
        }),
      });
      console.warn(`[Director] Background test run ${runId.slice(0, 8)} failed at hard cap`);
      return true;
    }

    backgroundErrorStage = 'building_next_round';
    const latestBeforeNextRound = await getLatestTestRunState(projectId, runId);
    if (isTestRunCancelled(latestBeforeNextRound)) return true;
    if (isRunTerminallyDeployed(latestBeforeNextRound)) {
      await supersedePendingTestRunBatches(
        batchInfos,
        roundDetails.map((detail) => detail.batch_id).filter(Boolean)
      );
      console.log(`[Director] Ignoring stale background continuation for deployed run ${runId.slice(0, 8)}`);
      return true;
    }
    const project = await getProject(projectId);
    if (!project) {
      await markTestRunBackgroundFailure({
        runId,
        angleName,
        batchInfos,
        roundDetails,
        totalAdsGenerated,
        totalAdsScored,
        totalAdsPassed,
        requiredPasses,
        failureReason: 'Project not found while preparing the next round.',
        terminalStatus: TEST_RUN_ORCHESTRATION_FAILURE_STATUS,
        errorStage: backgroundErrorStage,
        durationMs: Date.now() - run.run_at,
      });
      return true;
    }

    const nextBatchSize = getTestRoundBatchSize(roundNumber + 1, totalAdsPassed, requiredPasses);
    const nextBatchInfo = await createTestBatchRound({
      projectId,
      project,
      runId,
      angleInfo: { name: angleName, externalId: 'background' },
      anglePrompt: batch.angle_prompt || batch.angle || batchInfo.angle_prompt || '',
      angleBriefJSON: batch.angle_brief || batchInfo.angle_brief,
      batchSize: nextBatchSize,
      roundNumber: roundNumber + 1,
      emit: () => {},
      updateAngleUsage: false,
      queueForScheduler: true,
      templateTag: run.template_tag || batch.template_tag || '',
      imageModel: batch.image_model,
    });

    batchInfos.push(nextBatchInfo);
    const nextRoundMessage = `Round ${roundNumber} complete: ${totalAdsPassed}/${requiredPasses} approved. Starting top-up round ${roundNumber + 1} with ${nextBatchSize} more ads in background.`;

    await updateConductorRun(runId, {
      status: 'running',
      terminal_status: 'building_round',
      error: '',
      failure_reason: '',
      error_stage: '',
      template_tag: run.template_tag || batch.template_tag || undefined,
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: roundDetails.length + 1,
      total_ads_generated: totalAdsGenerated + nextBatchInfo.ad_count,
      total_ads_scored: totalAdsScored,
      total_ads_passed: totalAdsPassed,
      decisions: nextRoundMessage,
    });

    console.log(`[Director] Resumed test run ${runId.slice(0, 8)} queued round ${roundNumber + 1} for scheduler`);
    return true;
  } catch (err) {
    if (err.message === 'Cancelled by user') {
      await updateConductorRun(runId, {
        status: 'failed',
        terminal_status: TEST_RUN_CANCELLED_STATUS,
        error: 'Cancelled by user',
        failure_reason: 'Cancelled by user',
        error_stage: '',
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: Math.max(roundDetails.length, batchInfos.length, 1),
        total_ads_generated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
        total_ads_scored: run.total_ads_scored || roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0),
        total_ads_passed: run.total_ads_passed || roundDetails.at(-1)?.cumulative_passed || 0,
        ready_to_post_count: 0,
        duration_ms: Date.now() - run.run_at,
        decisions: buildTestRunSummary({
          angleName: batchInfo.angle_name || batch.angle_name || 'Unknown angle',
          roundsUsed: Math.max(roundDetails.length, batchInfos.length, 1),
          totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
          totalAdsPassed: run.total_ads_passed || roundDetails.at(-1)?.cumulative_passed || 0,
          requiredPasses,
          terminalStatus: TEST_RUN_CANCELLED_STATUS,
          failureReason: 'Cancelled by user',
        }),
      });
      return true;
    }

    if (isLegacyAutoPostLogImportMessage(err?.message)) {
      const roundNumber = batchInfo.round || (roundDetails.length + 1);
      await updateConductorRun(runId, {
        status: 'running',
        terminal_status: 'filter_scoring_retry',
        error: '',
        failure_reason: '',
        error_stage: '',
        posting_days: getTestPostingDays(batchInfo.angle_name || batch.angle_name || ''),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: Math.max(roundDetails.length, roundNumber),
        total_ads_generated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
        total_ads_scored: run.total_ads_scored || roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0),
        total_ads_passed: run.total_ads_passed || roundDetails.at(-1)?.cumulative_passed || 0,
        decisions: `Round ${roundNumber}: retrying Creative Filter after a non-critical deployment logging module finished deploying.`,
      });
      console.warn(`[Director] Background test run ${runId.slice(0, 8)} hit legacy auto-post log import during ${backgroundErrorStage}; retrying instead of failing terminally.`);
      return true;
    }

    if (activeRoundState?.rawScoreResult) {
      const priorScored = run.total_ads_scored || roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0);
      const priorPassed = run.total_ads_passed || roundDetails.at(-1)?.cumulative_passed || 0;
      const repairedAttempts = activeRoundState.repairSummary?.attempted || 0;
      const repairedPasses = activeRoundState.repairSummary?.passed || 0;

      if (!activeRoundState.countsApplied) {
        batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(activeRoundState.batchInfo, activeRoundState.rawScoreResult, {
          repair_attempts: repairedAttempts,
          repair_passes: repairedPasses,
        });
      }

      if (!activeRoundState.detailPersisted) {
        const recoveredTotalAdsPassed = priorPassed + (activeRoundState.mergedRoundScoreResult?.ads_passed || activeRoundState.rawScoreResult.ads_passed || 0);
        roundDetails.push(buildCompletedRoundDetail({
          batch: activeRoundState.batch,
          batchInfo: activeRoundState.batchInfo,
          angleName: batchInfo.angle_name || batch.angle_name || '',
          roundNumber: activeRoundState.roundNumber,
          roundScoreResult: activeRoundState.mergedRoundScoreResult || activeRoundState.rawScoreResult,
          totalAdsPassed: recoveredTotalAdsPassed,
          requiredPasses,
          repairSummary: activeRoundState.repairSummary,
        }));
        activeRoundState.detailPersisted = true;
      }

      run.total_ads_scored = priorScored + activeRoundState.rawScoreResult.ads_scored + repairedAttempts;
      run.total_ads_passed = priorPassed + (activeRoundState.mergedRoundScoreResult?.ads_passed || activeRoundState.rawScoreResult.ads_passed || 0);
    }

    await markTestRunBackgroundFailure({
      runId,
      angleName: batchInfo.angle_name || batch.angle_name || '',
      batchInfos,
      roundDetails,
      totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      totalAdsScored: run.total_ads_scored || roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0),
      totalAdsPassed: run.total_ads_passed || roundDetails.at(-1)?.cumulative_passed || 0,
      requiredPasses,
      failureReason: err.message || 'Background test run failed during post-score processing.',
      terminalStatus: TEST_RUN_ORCHESTRATION_FAILURE_STATUS,
      errorStage: backgroundErrorStage,
      durationMs: Date.now() - run.run_at,
    });
    console.error(`[Director] Background test run ${runId.slice(0, 8)} failed during ${backgroundErrorStage}:`, err.message);
    return true;
  }
}

export async function resumeBackgroundTestRuns() {
  const configs = await getAllConductorConfigs();
  const projectIds = [...new Set(configs.map(config => config.project_id))];
  const summary = { checked: projectIds.length, resumed: 0, errors: 0 };

  for (const projectId of projectIds) {
    if (findTrackedTestRun(projectId)) continue;

    const runs = await getConductorRuns(projectId, 10);
    const testRuns = runs.filter((run) => run.run_type === 'test');
    const candidate = testRuns.find((run) => run.status === 'running')
      || testRuns.find(isRecoverableScoringTestRun)
      || testRuns.find(isGeminiBackgroundWaitFailure)
      || testRuns.find(isLegacyAutoPostLogImportFailure);

    if (!candidate) continue;

    try {
      if (isLegacyAutoPostLogImportFailure(candidate)) {
        await repairDeployFailedTestRun(projectId, candidate.externalId);
        summary.resumed += 1;
        continue;
      }
      const handled = await continueBackgroundTestRun(candidate);
      if (handled) summary.resumed += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`[Director] Background resume error for test run ${candidate.externalId.slice(0, 8)}:`, err.message);
    }
  }

  return summary;
}

export async function startQueuedTestRuns({ owner = `conductor-queue:${Date.now()}`, limit = 1, leaseMs = 4 * 60 * 1000 } = {}) {
  const summary = { checked: 0, started: 0, queued_remaining: 0, errors: 0 };

  for (let i = 0; i < limit; i++) {
    const claim = await claimQueuedConductorTestRun(owner, leaseMs).catch((err) => {
      summary.errors += 1;
      console.warn(`[Director] Could not claim queued test run: ${err.message}`);
      return { claimed: false, reason: 'claim_error' };
    });
    if (!claim?.claimed || !claim.run) break;

    summary.checked += 1;
    const run = claim.run;
    try {
      console.log(`[Director] Starting queued test run ${run.externalId.slice(0, 8)} for project ${run.project_id}`);
      await runFullTestPipeline(run.project_id, null, {
        angleOverride: run.queued_angle_id,
        adsPerAdSetTarget: run.required_passes || TEST_RUN_DEFAULT_TARGET,
        templateTag: run.template_tag || '',
        existingRun: run,
      });
      summary.started += 1;
    } catch (err) {
      summary.errors += 1;
      await updateConductorRun(run.externalId, {
        status: 'failed',
        terminal_status: TEST_RUN_ORCHESTRATION_FAILURE_STATUS,
        error: err.message || 'Queued test run failed to start.',
        failure_reason: err.message || 'Queued test run failed to start.',
        error_stage: 'queued_start',
        duration_ms: Date.now() - (run.run_at || Date.now()),
        decisions: err.message || 'Queued test run failed to start.',
      }).catch((updateErr) => {
        console.warn(`[Director] Could not mark queued test run ${run.externalId.slice(0, 8)} failed: ${updateErr.message}`);
      });
      console.error(`[Director] Queued test run ${run.externalId.slice(0, 8)} failed:`, err.message);
    } finally {
      await releaseQueuedConductorTestRun(run.externalId, owner).catch((err) => {
        console.warn(`[Director] Could not release queued test run ${run.externalId.slice(0, 8)} lease: ${err.message}`);
      });
    }
  }

  return summary;
}

/**
 * Run a single test batch for a project — bypasses production windows and deficit checks.
 * Creates one full batch, fires it, and lets the Filter pick it up end-to-end.
 * @param {string} projectId
 */
export async function runTestBatch(projectId, sendEvent, { skipBatchLaunch = false, batchSizeOverride = null, angleOverride = null } = {}) {
  const emit = sendEvent || (() => {});
  const startMs = Date.now();
  const runId = uuidv4();
  const requiredPasses = normalizeTestRunAdTarget(batchSizeOverride || TEST_RUN_DEFAULT_TARGET);

  emit({ type: 'progress', step: 'initializing', message: 'Loading project config...' });

  await createConductorRun({
    externalId: runId,
    project_id: projectId,
    run_type: 'test',
    run_at: startMs,
    status: 'running',
    required_passes: requiredPasses,
    ads_per_round: requiredPasses,
    max_rounds: 1,
  });

  try {
    emit({ type: 'progress', step: 'selecting_angle', message: 'Selecting angle...' });
    const { config, project, angleInfo, anglePrompt, angleBriefJSON } = await loadTestRunContext(projectId, angleOverride);

    emit({ type: 'progress', step: 'building_prompt', message: `Building prompt for "${angleInfo.name}"...` });
    const batchSize = requiredPasses;
    const batchInfo = await createTestBatchRound({
      projectId,
      project,
      runId,
      angleInfo,
      anglePrompt,
      angleBriefJSON,
      batchSize,
      roundNumber: 1,
      emit,
      updateAngleUsage: true,
      imageModel: config?.image_model,
    });

    emit({ type: 'progress', step: 'saving_run', message: 'Saving run record...' });
    await updateConductorRun(runId, {
      status: 'completed',
      terminal_status: 'batch_created',
      posting_days: getTestPostingDays(angleInfo.name),
      batches_created: stringifyJSON([batchInfo]),
      decisions: `Test run: created 1 batch (${batchSize} ads) with angle "${angleInfo.name}".`,
      total_rounds: 1,
      total_ads_generated: batchSize,
      duration_ms: Date.now() - startMs,
    });

    console.log(`[Director] Test run for ${projectId.slice(0, 8)}: Created 1 batch (${batchSize} ads, angle: ${angleInfo.name}) in ${Date.now() - startMs}ms`);

    if (!skipBatchLaunch) {
      emit({ type: 'progress', step: 'launching_batch', message: `Launching batch pipeline for "${angleInfo.name}"...` });
      runBatch(batchInfo.batch_id).catch(err => {
        console.error(`[Director] Test batch ${batchInfo.batch_id.slice(0, 8)} failed:`, err.message);
      });
    } else {
      emit({ type: 'progress', step: 'launching_batch', message: 'Batch created, starting full pipeline...' });
    }

    return {
      runId,
      batches_created: 1,
      batch_id: batchInfo.batch_id,
      angle: angleInfo.name,
      ad_count: batchSize,
    };
  } catch (err) {
    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: 'generation_failed',
      error: err.message,
      failure_reason: err.message,
      duration_ms: Date.now() - startMs,
    });
    throw err;
  }
}

// ── In-memory progress tracking for test runs (survives SSE disconnect) ──────
const activeTestRuns = new Map();

const PIPELINE_STEP_PROGRESS = {
  'initializing': 1, 'selecting_angle': 1, 'building_prompt': 1,
  'creating_batch': 2, 'saving_run': 2, 'launching_batch': 2,
  'batch_brief': 4, 'batch_headlines': 6, 'batch_body_copy': 9,
  'batch_image_prompts': 12, 'batch_submitting': 14, 'batch_submitted': 15,
  'gemini_waiting': 15, 'gemini_complete': 60,
  'filter_scoring': 62, 'repairing_images': 68, 'repairing_copy': 72, 'filter_grouping': 82, 'filter_copy_gen': 86,
  'filter_deploying': 92, 'filter_complete': 95,
};

function findTrackedTestRun(projectId) {
  for (const [id, run] of activeTestRuns) {
    if (run.projectId === projectId && run.status === 'running') {
      return [id, run];
    }
  }
  return null;
}

async function hasDurableActiveTestRun(projectId) {
  const runs = await getConductorRuns(projectId, 10);
  return runs.some((run) => run.run_type === 'test' && ACTIVE_CONDUCTOR_RUN_STATUSES.has(run.status));
}

async function hasDurableActiveConductorRun(projectId, { excludeRunId = null } = {}) {
  const runs = await getConductorRuns(projectId, 20);
  return runs.some((run) =>
    run.externalId !== excludeRunId && ACTIVE_CONDUCTOR_RUN_STATUSES.has(run.status)
  );
}

async function hasDurableQueuedTestRun(projectId) {
  const runs = await getConductorRuns(projectId, 20);
  return runs.some((run) => run.run_type === 'test' && run.status === 'queued');
}

async function enqueueTestRun(projectId, { angleOverride, requiredPasses, templateTag }) {
  const runId = uuidv4();
  const now = new Date();
  return await enqueueConductorTestRun({
    externalId: runId,
    project_id: projectId,
    queued_angle_id: angleOverride,
    required_passes: requiredPasses,
    ads_per_round: getTestRoundBatchSize(1, 0, requiredPasses),
    template_tag: normalizeTemplateTag(templateTag) || undefined,
    max_rounds: TEST_RUN_MAX_ROUNDS,
    now: now.toISOString(),
    run_at: now.getTime(),
  });
}

/**
 * Get the active test run for a project (if any).
 * @param {string} projectId
 * @returns {{ id: string, projectId: string, status: string, progress: number, phase: string, startTime: number, result: object|null }|null}
 */
export function getActiveTestRun(projectId) {
  const tracked = findTrackedTestRun(projectId);
  if (!tracked) return null;
  const [id, run] = tracked;
  return { id, ...run };
}

/**
 * Cancel the active test run for a project.
 * Marks both in-memory tracking and the durable run record so Vercel
 * serverless/background resumes cannot continue after a different request cancels.
 */
export async function cancelTestRun(projectId, { runId = null } = {}) {
  if (runId) {
    const queuedCancel = await cancelQueuedConductorTestRun(runId).catch((err) => {
      console.warn(`[Director] Could not cancel queued test run ${runId.slice(0, 8)}: ${err.message}`);
      return { cancelled: false, reason: 'cancel_error' };
    });
    if (queuedCancel?.cancelled) return true;
  }

  const tracked = findTrackedTestRun(projectId);
  let cancelled = false;
  if (tracked && (!runId || tracked[0] === runId || tracked[1]?.runId === runId)) {
    const [, run] = tracked;
    run.cancelRequested = true;
    run.phase = 'Cancel requested. Stopping active generation work...';
    if (run.currentBatchId) {
      await markTestBatchCancelled(run.currentBatchId);
    }
    cancelled = true;
  }

  const runs = await getConductorRuns(projectId, 10);
  const candidate = runs
    .filter((run) => run.run_type === 'test')
    .find((run) => (!runId || run.externalId === runId) && ['running', 'scoring', 'repairing', 'processing'].includes(run.status) && !isTestRunCancelled(run));

  if (!candidate) return cancelled;

  const batchInfos = parseJSON(candidate.batches_created, []);
  const roundDetails = parseJSON(candidate.rounds_json, []);
  const pending = findPendingBatchInfo(batchInfos, roundDetails);
  const activeBatchInfo = pending?.batchInfo || batchInfos[batchInfos.length - 1] || null;
  if (activeBatchInfo?.batch_id) {
    await markTestBatchCancelled(activeBatchInfo.batch_id);
  }

  const angleName = activeBatchInfo?.angle_name || '';
  const totalAdsGenerated = candidate.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0);
  await updateConductorRun(candidate.externalId, {
    status: 'failed',
    terminal_status: TEST_RUN_CANCELLED_STATUS,
    error: 'Cancelled by user',
    failure_reason: 'Cancelled by user',
    error_stage: '',
    posting_days: angleName
      ? getTestPostingDays(angleName)
      : stringifyJSON([{ date: 'test', action: 'Test run cancelled' }]),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: Math.max(roundDetails.length, batchInfos.length, 1),
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: candidate.total_ads_scored || 0,
    total_ads_passed: candidate.total_ads_passed || 0,
    ready_to_post_count: 0,
    decisions: buildTestRunSummary({
      angleName: angleName || 'Unknown angle',
      roundsUsed: Math.max(roundDetails.length, batchInfos.length, 1),
      totalAdsGenerated,
      totalAdsPassed: candidate.total_ads_passed || 0,
      requiredPasses: getTestRunTargetFromRun(candidate),
      terminalStatus: TEST_RUN_CANCELLED_STATUS,
      failureReason: 'Cancelled by user',
    }),
  });

  return true;
}

// ── Full Test Pipeline (Director → Batch → Gemini → Filter → Ready to Post) ──

/**
 * Run the full test pipeline with a single SSE stream tracking all phases.
 *
 * @param {string} projectId
 * @param {(event: object) => void} sendEvent - SSE event emitter
 * @param {{ angleOverride?: string, adsPerAdSetTarget?: number, templateTag?: string }} options
 * @returns {object} Combined result from Director + Filter phases
 */
export async function runFullTestPipeline(projectId, sendEvent, { angleOverride = null, adsPerAdSetTarget = TEST_RUN_DEFAULT_TARGET, templateTag = '', existingRun = null } = {}) {
  const rawEmit = sendEvent || (() => {});
  const requiredPasses = normalizeTestRunAdTarget(existingRun?.required_passes || adsPerAdSetTarget);
  const normalizedTemplateTag = normalizeTemplateTag(existingRun?.template_tag || templateTag);
  const queuedAngleOverride = existingRun?.queued_angle_id || angleOverride;

  if (!existingRun && (findTrackedTestRun(projectId) || await hasDurableActiveConductorRun(projectId) || await hasDurableQueuedTestRun(projectId))) {
    const queued = await enqueueTestRun(projectId, {
      angleOverride,
      requiredPasses,
      templateTag: normalizedTemplateTag,
    });
    if (queued?.queued) {
      return {
        queued: true,
        runId: queued.run?.externalId,
        queue_position: queued.run?.queue_position,
        status: 'queued',
        phase: `Queued behind the active Creative Director run (position ${queued.run?.queue_position || 1}).`,
        message: `Queued behind the active Creative Director run (position ${queued.run?.queue_position || 1}).`,
      };
    }
    throw new Error('A test run is already in progress for this project. Cancel it or wait for it to finish before starting another.');
  }

  // Track progress in-memory so polling endpoint can serve it after SSE disconnect
  const runProgress = {
    projectId,
    status: 'running',
    progress: 0,
    phase: 'Starting...',
    startTime: existingRun?.started_at ? Date.parse(existingRun.started_at) : Date.now(),
    result: null,
    cancelRequested: false,
    currentBatchId: null,
    runId: null,
    requiredPasses,
  };
  const trackingId = existingRun?.externalId || `pending-${Date.now()}`;
  activeTestRuns.set(trackingId, runProgress);

  const throwIfRunCancelled = async () => {
    if (runProgress.cancelRequested) {
      throw new Error('Cancelled by user');
    }
    if (runId) {
      await throwIfDurableTestRunCancelled(projectId, runId);
    }
  };

  const emit = (event) => {
    rawEmit(event);
    if (event.type === 'progress') {
      if (!runProgress.cancelRequested) {
        runProgress.phase = event.message || runProgress.phase;
        if (typeof event.progressValue === 'number') {
          runProgress.progress = Math.max(runProgress.progress, event.progressValue);
        } else if (event.step && PIPELINE_STEP_PROGRESS[event.step] !== undefined) {
          runProgress.progress = Math.max(runProgress.progress, PIPELINE_STEP_PROGRESS[event.step]);
        } else if (event.step === 'gemini_polling' && event.elapsed) {
          const ratio = Math.min(event.elapsed / 600, 0.95);
          const pct = 15 + Math.round(ratio * 43);
          runProgress.progress = Math.max(runProgress.progress, pct);
        } else if (event.step === 'filter_scoring' && event.scoringProgress) {
          const { current, total } = event.scoringProgress;
          const pct = 62 + Math.round((current / total) * 18);
          runProgress.progress = Math.max(runProgress.progress, pct);
        }
      }
    } else if (event.type === 'complete') {
      runProgress.status = 'complete';
      runProgress.progress = 100;
      runProgress.phase = 'Complete';
      runProgress.result = event;
      setTimeout(() => activeTestRuns.delete(trackingId), 60000);
    } else if (event.type === 'error') {
      runProgress.status = 'error';
      runProgress.progress = 0;
      runProgress.phase = event.message || 'Failed';
      runProgress.result = event;
      setTimeout(() => activeTestRuns.delete(trackingId), 60000);
    }
  };
  let runId = existingRun?.externalId || null;
  let angleName = '';
  const batchInfos = [];
  const roundDetails = [];
  let totalAdsGenerated = 0;
  let totalAdsScored = 0;
  let totalAdsPassed = 0;
  let errorStage = 'initializing';
  let activeRoundState = null;

  try {
    emit({
      type: 'progress',
      step: 'initializing',
      message: `Checking project settings. Target: ${requiredPasses} approved ads.`,
      targetCount: requiredPasses,
    });
    await assertTestRunProviderPreflight(projectId, { templateTag: normalizedTemplateTag });
    runId = runId || uuidv4();
    runProgress.runId = runId;

    if (existingRun) {
      await updateConductorRun(runId, {
        status: 'running',
        terminal_status: 'starting',
        error: '',
        failure_reason: '',
        error_stage: '',
        started_at: conductorHeartbeatAt(),
        required_passes: requiredPasses,
        ads_per_round: getTestRoundBatchSize(1, 0, requiredPasses),
        template_tag: normalizedTemplateTag || undefined,
        max_rounds: TEST_RUN_MAX_ROUNDS,
      });
    } else {
      await createConductorRun({
        externalId: runId,
        project_id: projectId,
        run_type: 'test',
        run_at: runProgress.startTime,
        status: 'running',
        required_passes: requiredPasses,
        ads_per_round: getTestRoundBatchSize(1, 0, requiredPasses),
        template_tag: normalizedTemplateTag || undefined,
        max_rounds: TEST_RUN_MAX_ROUNDS,
      });
    }

    await throwIfRunCancelled();
    errorStage = 'selecting_angle';
    emit({
      type: 'progress',
      step: 'selecting_angle',
      message: 'Preparing selected angle...',
      targetCount: requiredPasses,
    });
    const { config, project, angleInfo, anglePrompt, angleBriefJSON } = await loadTestRunContext(projectId, queuedAngleOverride);
    angleName = angleInfo.name;
    errorStage = 'building_prompt';
    emit({
      type: 'progress',
      step: 'building_prompt',
      message: `Preparing "${angleName}" for image generation. Target: ${requiredPasses} approved ads.`,
      targetCount: requiredPasses,
    });

    const { scoreBatchForInlineFilter, finalizePassingAds } = await import('./creativeFilterService.js');
    const cumulativePassingAds = [];

    for (let roundNumber = 1; roundNumber <= TEST_RUN_MAX_ROUNDS; roundNumber++) {
      await throwIfRunCancelled();
      errorStage = 'creating_batch';
      const batchSize = getTestRoundBatchSize(roundNumber, totalAdsPassed, requiredPasses);
      console.log(`[Director] Test run ${runId.slice(0, 8)} round ${roundNumber}/${TEST_RUN_MAX_ROUNDS}: creating ${batchSize} ads for "${angleName}"`);
      const batchInfo = await createTestBatchRound({
        projectId,
        project,
        runId,
        angleInfo,
        anglePrompt,
        angleBriefJSON,
        batchSize,
        roundNumber,
        emit,
        updateAngleUsage: roundNumber === 1,
        templateTag: normalizedTemplateTag,
        imageModel: config?.image_model,
      });

      batchInfos.push(batchInfo);
      runProgress.currentBatchId = batchInfo.batch_id;
      totalAdsGenerated += batchInfo.ad_count;

      await updateConductorRun(runId, {
        status: 'running',
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundNumber,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        decisions: `Testing "${angleName}" — round ${roundNumber} of ${TEST_RUN_MAX_ROUNDS} started.`,
      });

      const roundExecution = await executeTestBatchRound(
        batchInfo.batch_id,
        roundNumber,
        emit,
        () => runProgress.cancelRequested,
        { approvedSoFar: totalAdsPassed, requiredPasses }
      );
      if (roundExecution?.deferred) {
        const backgroundMessage = getBackgroundWaitingMessage(roundNumber);
        await markTestRunWaitingOnGemini({
          runId,
          angleName,
          roundNumber,
          batchInfos,
          roundDetails,
          totalAdsGenerated,
          totalAdsScored,
          totalAdsPassed,
        });
        activeTestRuns.delete(trackingId);
        return {
          runId,
          angle: angleName,
          rounds_used: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          ads_scored: totalAdsScored,
          ads_passed: totalAdsPassed,
          required_passes: requiredPasses,
          ready_to_post_count: 0,
          terminal_status: 'waiting_on_gemini',
          run_in_background: true,
          background_message: backgroundMessage,
          phase: backgroundMessage,
        };
      }
      await throwIfRunCancelled();

      errorStage = 'filter_scoring';
      const roundScoreResult = await scoreBatchForInlineFilter(
        batchInfo.batch_id,
        projectId,
        (event) => {
          emit(withTestProgress(roundNumber, event));
          if (event?.step === 'filter_scoring') {
            updateConductorRun(runId, {
              status: 'scoring',
              terminal_status: 'filter_scoring',
              error_stage: 'filter_scoring',
              decisions: event.message || `Round ${roundNumber}: Creative Filter QA is scoring generated ads...`,
            }).catch((err) => {
              console.warn(`[Director] Could not heartbeat scoring run ${runId.slice(0, 8)}: ${err.message}`);
            });
          }
        },
        {
          roundNumber,
          totalRounds: TEST_RUN_MAX_ROUNDS,
          requiredPasses,
          priorPassed: totalAdsPassed,
          shouldCancel: () => throwIfRunCancelled().then(() => false).catch((err) => {
            if (err.message === 'Cancelled by user') return true;
            throw err;
          }),
        }
      );
      await throwIfRunCancelled();
      errorStage = 'post_score_round_processing';
      activeRoundState = {
        batchInfo,
        roundNumber,
        batch: roundScoreResult.batch,
        rawScoreResult: roundScoreResult,
        mergedRoundScoreResult: roundScoreResult,
        repairSummary: null,
        countsApplied: false,
        detailPersisted: false,
      };

      const repairResult = await attemptRoundRepairs({
        roundScoreResult,
        projectId,
        batch: roundScoreResult.batch,
        roundNumber,
        emit: (event) => emit(withTestProgress(roundNumber, event)),
        requiredPasses,
        priorPassed: totalAdsPassed,
      });
      activeRoundState.repairSummary = repairResult.repairSummary;
      activeRoundState.mergedRoundScoreResult = {
        ...roundScoreResult,
        passingAds: [...roundScoreResult.passingAds, ...repairResult.repairedPassingAds],
        scoredAds: [...roundScoreResult.scoredAds, ...repairResult.repairedScoredAds],
        ads_passed: roundScoreResult.ads_passed + (repairResult.repairSummary?.passed || 0),
      };

      if (repairResult.repairedPassingAds.length > 0) {
        cumulativePassingAds.push(...repairResult.repairedPassingAds);
      }
      cumulativePassingAds.push(...roundScoreResult.passingAds);
      totalAdsScored += roundScoreResult.ads_scored + (repairResult.repairSummary?.attempted || 0);
      totalAdsPassed = cumulativePassingAds.length;
      activeRoundState.countsApplied = true;
      console.log(`[Director] Test run ${runId.slice(0, 8)} round ${roundNumber}/${TEST_RUN_MAX_ROUNDS}: ${roundScoreResult.ads_passed}+${repairResult.repairSummary?.passed || 0}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${requiredPasses} cumulative`);
      const roundDetail = buildCompletedRoundDetail({
        batch: roundScoreResult.batch,
        batchInfo,
        angleName,
        roundNumber,
        roundScoreResult: activeRoundState.mergedRoundScoreResult,
        totalAdsPassed,
        requiredPasses,
        repairSummary: repairResult.repairSummary,
      });
      roundDetails.push(roundDetail);
      activeRoundState.detailPersisted = true;

      batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(batchInfo, roundScoreResult, {
        repair_attempts: repairResult.repairSummary?.attempted || 0,
        repair_passes: repairResult.repairSummary?.passed || 0,
      });

      if (totalAdsPassed >= requiredPasses) {
        errorStage = 'filter_finalization';
        const finalizeResult = await finalizePassingAds({
          passingAds: cumulativePassingAds,
          projectId,
          batchId: batchInfo.batch_id,
          postingDay: 'test',
          angleName,
          targetCount: requiredPasses,
          onProgress: (event) => emit(withTestProgress(TEST_RUN_MAX_ROUNDS, event)),
        });

        if (finalizeResult.flex_ads_created === 0) {
          let failureReason = 'Unknown error during Creative Filter';
          let terminalStatus = 'deploy_failed';
          if (finalizeResult.grouping_failed) {
            failureReason = `${totalAdsPassed} approved ads were available, but grouping could not create an ad set.`;
            terminalStatus = 'grouping_failed';
          } else if (finalizeResult.copy_error) {
            failureReason = `Reached ${totalAdsPassed}/${requiredPasses} passed ads, but final copy generation failed: ${finalizeResult.copy_error}`;
            terminalStatus = 'copy_failed';
          } else if (finalizeResult.deploy_error) {
            failureReason = `Reached ${totalAdsPassed}/${requiredPasses} passed ads, but deployment failed: ${finalizeResult.deploy_error}`;
          }

          await updateConductorRun(runId, {
            status: 'failed',
            terminal_status: terminalStatus,
            error: failureReason,
            failure_reason: failureReason,
            error_stage: errorStage,
            posting_days: getTestPostingDays(angleName),
            batches_created: stringifyJSON(batchInfos),
            rounds_json: stringifyJSON(roundDetails),
            total_rounds: roundDetails.length,
            total_ads_generated: totalAdsGenerated,
            total_ads_scored: totalAdsScored,
            total_ads_passed: totalAdsPassed,
            ready_to_post_count: 0,
            duration_ms: Date.now() - runProgress.startTime,
            decisions: buildTestRunSummary({
              angleName,
              roundsUsed: roundDetails.length,
              totalAdsGenerated,
              totalAdsPassed,
              requiredPasses,
              terminalStatus,
              failureReason,
            }),
          });

          runProgress.status = 'error';
          runProgress.progress = 0;
          runProgress.phase = failureReason;
          runProgress.result = { failure_reason: failureReason, required_passes: requiredPasses };
          setTimeout(() => activeTestRuns.delete(trackingId), 60000);

          return {
            runId,
            angle: angleName,
            rounds_used: roundDetails.length,
            total_ads_generated: totalAdsGenerated,
            ads_scored: totalAdsScored,
            ads_passed: totalAdsPassed,
            required_passes: requiredPasses,
            ready_to_post_count: 0,
            terminal_status: terminalStatus,
            failure_reason: failureReason,
            rounds: roundDetails,
            pipeline_failed: true,
          };
        }

        errorStage = 'persist_success';
        const successResult = await finalizeSuccessfulTestRun({
          runId,
          projectId,
          angleName,
          batchInfos,
          roundDetails,
          currentBatchId: batchInfo.batch_id,
          totalAdsGenerated,
          totalAdsScored,
          totalAdsPassed,
          requiredPasses,
          finalizeResult,
          durationMs: Date.now() - runProgress.startTime,
          triggerLabel: 'test run',
        });

        console.log(`[Director] Test run ${runId.slice(0, 8)} succeeded after ${roundDetails.length} round(s): ${totalAdsPassed} passed, flex ${successResult.flexAdId || 'none'}`);

        runProgress.status = 'complete';
        runProgress.progress = 100;
        runProgress.phase = 'Complete';
        runProgress.result = { flex_ad_id: successResult.flexAdId, ready_to_post_count: successResult.readyToPostCount, required_passes: requiredPasses };
        setTimeout(() => activeTestRuns.delete(trackingId), 60000);

        return {
          runId,
          angle: angleName,
          rounds_used: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          ads_scored: totalAdsScored,
          ads_passed: totalAdsPassed,
          required_passes: requiredPasses,
          ready_to_post_count: successResult.readyToPostCount,
          flex_ads_created: finalizeResult.flex_ads_created,
          flex_ad_id: successResult.flexAdId,
          terminal_status: 'deployed',
          rounds: roundDetails,
        };
      }

      if (roundNumber < TEST_RUN_MAX_ROUNDS) {
        const nextBatchSize = getTestRoundBatchSize(roundNumber + 1, totalAdsPassed, requiredPasses);
        emit(withTestProgress(roundNumber, {
          type: 'progress',
          step: 'round_complete',
          message: `${totalAdsPassed}/${requiredPasses} approved. Starting top-up round ${roundNumber + 1} with ${nextBatchSize} more ads...`,
          approvedCount: totalAdsPassed,
          targetCount: requiredPasses,
          nextBatchSize,
        }));
      }

      const nextDecisionMessage = roundNumber < TEST_RUN_MAX_ROUNDS
        ? `Round ${roundNumber} complete: ${totalAdsPassed}/${requiredPasses} approved. Starting top-up round ${roundNumber + 1} with ${getTestRoundBatchSize(roundNumber + 1, totalAdsPassed, requiredPasses)} more ads.`
        : `Round ${roundNumber} complete: ${totalAdsPassed}/${requiredPasses} approved.`;

      errorStage = 'persist_round_progress';
      await updateConductorRun(runId, {
        status: 'running',
        error_stage: '',
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundDetails.length,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        decisions: nextDecisionMessage,
      });
      activeRoundState = null;
    }

    const failureReason = `Reached ${totalAdsPassed}/${requiredPasses} passed ads after ${totalAdsGenerated} generated across ${TEST_RUN_MAX_ROUNDS} rounds. Round cap reached with no Ready to Post ad set.`;
    console.warn(`[Director] Test run ${runId.slice(0, 8)} failed at hard cap: ${totalAdsPassed}/${requiredPasses} passed after ${totalAdsGenerated} generated`);

    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
      error: failureReason,
      failure_reason: failureReason,
      error_stage: '',
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      total_ads_scored: totalAdsScored,
      total_ads_passed: totalAdsPassed,
      ready_to_post_count: 0,
      duration_ms: Date.now() - runProgress.startTime,
      decisions: buildTestRunSummary({
        angleName,
        roundsUsed: roundDetails.length,
        totalAdsGenerated,
        totalAdsPassed,
        requiredPasses,
        terminalStatus: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
      }),
    });

    runProgress.status = 'error';
    runProgress.progress = 0;
    runProgress.phase = failureReason;
    runProgress.result = { failure_reason: failureReason };
    setTimeout(() => activeTestRuns.delete(trackingId), 60000);

    return {
      runId,
      angle: angleName,
      rounds_used: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      ads_scored: totalAdsScored,
      ads_passed: totalAdsPassed,
      ready_to_post_count: 0,
      terminal_status: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
      failure_reason: failureReason,
      rounds: roundDetails,
      pipeline_failed: true,
    };
  } catch (err) {
    const failureReason = err.message || 'Test run failed';
    const cancelled = failureReason === 'Cancelled by user' || runProgress.cancelRequested;
    if (!cancelled && activeRoundState?.rawScoreResult) {
      if (!activeRoundState.countsApplied) {
        totalAdsScored += activeRoundState.rawScoreResult.ads_scored + (activeRoundState.repairSummary?.attempted || 0);
        totalAdsPassed += activeRoundState.mergedRoundScoreResult?.ads_passed || activeRoundState.rawScoreResult.ads_passed || 0;
        batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(activeRoundState.batchInfo, activeRoundState.rawScoreResult, {
          repair_attempts: activeRoundState.repairSummary?.attempted || 0,
          repair_passes: activeRoundState.repairSummary?.passed || 0,
        });
        activeRoundState.countsApplied = true;
      }

      if (!activeRoundState.detailPersisted) {
        roundDetails.push(buildCompletedRoundDetail({
          batch: activeRoundState.batch,
          batchInfo: activeRoundState.batchInfo,
          angleName,
          roundNumber: activeRoundState.roundNumber,
          roundScoreResult: activeRoundState.mergedRoundScoreResult || activeRoundState.rawScoreResult,
          totalAdsPassed,
          requiredPasses,
          repairSummary: activeRoundState.repairSummary,
        }));
        activeRoundState.detailPersisted = true;
      }
    }
    const terminalStatus = cancelled
      ? 'cancelled'
      : (totalAdsScored > 0 || errorStage === 'post_score_round_processing' || errorStage === 'filter_finalization' || errorStage === 'persist_round_progress' || errorStage === 'persist_success')
        ? TEST_RUN_ORCHESTRATION_FAILURE_STATUS
        : 'generation_failed';
    if (runId) {
      try {
        await updateConductorRun(runId, {
          status: 'failed',
          terminal_status: terminalStatus,
          error: failureReason,
          failure_reason: failureReason,
          error_stage: cancelled ? undefined : errorStage,
          posting_days: angleName
            ? getTestPostingDays(angleName)
            : stringifyJSON([{ date: 'test', action: cancelled ? 'Test run cancelled before angle selection' : 'Test run failed before angle selection' }]),
          batches_created: stringifyJSON(batchInfos),
          rounds_json: stringifyJSON(roundDetails),
          total_rounds: Math.max(roundDetails.length, batchInfos.length, 1),
          total_ads_generated: totalAdsGenerated,
          total_ads_scored: totalAdsScored,
          total_ads_passed: totalAdsPassed,
          ready_to_post_count: 0,
          duration_ms: Date.now() - runProgress.startTime,
          decisions: buildTestRunSummary({
            angleName: angleName || 'Unknown angle',
            roundsUsed: Math.max(roundDetails.length, batchInfos.length, 1),
            totalAdsGenerated,
            totalAdsPassed,
            requiredPasses,
            terminalStatus,
            failureReason,
          }),
        });
      } catch (updateErr) {
        console.warn('[Pipeline] Failed to update run record after test-run error:', updateErr.message);
      }
    }

    runProgress.status = 'error';
    runProgress.progress = 0;
    runProgress.phase = failureReason;
    runProgress.result = { failure_reason: failureReason, terminal_status: terminalStatus, required_passes: requiredPasses };
    setTimeout(() => activeTestRuns.delete(trackingId), 60000);

    return {
      runId,
      angle: angleName || null,
      rounds_used: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      ads_scored: totalAdsScored,
      ads_passed: totalAdsPassed,
      required_passes: requiredPasses,
      ready_to_post_count: 0,
      terminal_status: terminalStatus,
      failure_reason: failureReason,
      rounds: roundDetails,
      pipeline_failed: true,
    };
  }
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Get an ICT date for a specific day of week and hour, relative to the current week.
 */
function getICTDate(ictNow, dayOfWeek, hour) {
  const d = new Date(ictNow);
  const currentDay = d.getUTCDay();
  let diff = dayOfWeek - currentDay;
  // Look backward up to 6 days to find the right day
  if (diff > 3) diff -= 7;
  if (diff < -3) diff += 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

/**
 * Get the next occurrence of a specific weekday from a given date.
 */
function getNextWeekday(fromDate, targetDay) {
  const d = new Date(fromDate);
  const currentDay = d.getUTCDay();
  let diff = targetDay - currentDay;
  if (diff <= 0) diff += 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/**
 * Format a Date to YYYY-MM-DD string.
 */
function formatDate(d) {
  return d.toISOString().split('T')[0];
}

import { v5 as uuidv5 } from 'uuid';
import { getClient, generateImage } from './gemini.js';
import {
  extractBrief,
  generateHeadlines,
  generateBodyCopies,
  generateImagePrompt,
  generateImagePromptsBatch,
  isSceneLockedAngle,
  selectInspirationImage,
  selectTemplateImage,
  assertTemplateTagHasActiveTemplates,
  reviewPromptWithGuidelines,
  readImageBase64,
  cleanupImageData,
} from './adGenerator.js';
import {
  getProject, getLatestDoc, getBatchJob, updateBatchJob, getSetting,
  uploadBuffer, downloadToBuffer, getRecentHeadlineHistoryByAngle, recordHeadlineHistory,
  claimBatchResultsProcessing, getCompletedDirectorBatchStats,
  // Phase 1 — Staging Page
  getAdSet, createAdSet, ensureDefaultCampaign, findConductorAngleByName, parseAdSetDefaults,
  convexClient, api
} from '../convexClient.js';
import { logGeminiCost } from './costTracker.js';
import { withRetry } from './retry.js';
import {
  buildHeadlineHistoryEntry,
  filterAngleSignalHeadlines,
  filterSceneAlignedHeadlines,
  filterHeadlineCandidatePool,
  normalizeHeadlineText,
  selectDiverseHeadlines,
} from './headlineDiversity.js';
import { chatWithImage } from './openai.js';

// Batch OCR model — simple text extraction from a generated image. Cheap and vision-capable.
const BATCH_OCR_MODEL = 'gpt-4.1-mini';
const BATCH_AD_UUID_NAMESPACE = '9e1c2c75-4b71-4e95-88c7-7605e54a3c03';

async function updateBatchHeartbeat(batchId, fields = {}) {
  return updateBatchJob(batchId, {
    ...fields,
    last_heartbeat_at: new Date().toISOString(),
  });
}

/**
 * Phase 1 — Staging Page. Get-or-create the ad_set this batch's ads belong to.
 * Uses a deterministic externalId (`adset-${batchId}`) so retries land on the same
 * ad_set. Pulls campaign + Meta defaults from the project. Resolves angle by name
 * (batch.angle_name → conductor_angles.externalId).
 *
 * Created in `lifecycle_status: "staging"` so it appears on the Staging Page Pending
 * tab when the user views it. The ad_set is created here rather than at batch
 * creation time so existing batch-creation paths (route handlers + conductor) don't
 * need to be updated synchronously — Phase 1 is non-breaking for those paths.
 */
async function ensureBatchAdSet(batch, project) {
  const adSetId = `adset-${batch.externalId || batch.id}`;
  const existing = await getAdSet(adSetId);
  if (existing) return adSetId;

  const campaignId = await ensureDefaultCampaign(project);
  const angleId = await findConductorAngleByName(project.id, batch.angle_name);
  const defaults = parseAdSetDefaults(project);
  const dateLabel = batch.posting_day
    || (batch.created_at || '').slice(0, 10)
    || new Date().toISOString().slice(0, 10);
  const setName = batch.angle_name
    ? `${batch.angle_name} — ${dateLabel}`
    : `Batch ${(batch.externalId || batch.id || '').slice(0, 8)} — ${dateLabel}`;

  await createAdSet({
    id: adSetId,
    project_id: project.id,
    campaign_id: campaignId,
    angle_id: angleId || undefined,
    name: setName,
    sort_order: 0,
    lifecycle_status: 'staging',
    meta_targeting: defaults.meta_targeting,
    meta_budget_type: defaults.meta_budget_type,
    meta_budget_amount_cents: defaults.meta_budget_amount_cents,
    meta_schedule: defaults.meta_schedule,
    meta_optimization_goal: defaults.meta_optimization_goal,
    meta_billing_event: defaults.meta_billing_event,
  });
  return adSetId;
}

// Drive upload skipped for batch images — Service Account has no storage quota.
// Images are stored in Convex storage and viewable in the UI.

const HEADLINE_HISTORY_DAYS = 90;
const HEADLINE_HISTORY_LIMIT = 200;

/**
 * Extract the actual rendered headline and body copy from a Gemini-generated ad image.
 * Gemini often renders different text than what was requested, causing the Creative Filter
 * to auto-fail ads due to copy/image mismatch. This OCR pass syncs the stored fields
 * with what's actually visible in the image.
 */
async function extractRenderedCopy(imageBuffer, mimeType, projectId) {
  const base64Image = imageBuffer.toString('base64');
  const prompt = `Extract the exact text visible in this ad image. Return ONLY valid JSON with two fields:
- "headline": the headline text (usually larger/bolder text at top or bottom)
- "body_copy": the body/primary text (the longer paragraph text in the ad)

If no headline is visible, set headline to null. If no body copy is visible, set body_copy to null.
Return ONLY the JSON object, nothing else.`;

  const response = await chatWithImage(
    [],
    prompt,
    base64Image,
    mimeType,
    BATCH_OCR_MODEL,
    { operation: 'batch_ocr_extraction', projectId }
  );

  const text = typeof response === 'string' ? response : response?.content?.[0]?.text || '';
  // Extract JSON from response (handle markdown fences)
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    headline: parsed.headline || null,
    body_copy: parsed.body_copy || null,
  };
}

function serializePromptForStorage(prompt) {
  if (!prompt || typeof prompt !== 'object') return prompt;
  return {
    prompt: prompt.prompt,
    headline: prompt.headline || null,
    body_copy: prompt.body_copy || null,
    angle_name: prompt.angle_name || null,
    hook_lane: prompt.hook_lane || null,
    sub_angle: prompt.sub_angle || null,
    scene_anchor: prompt.scene_anchor || null,
    core_claim: prompt.core_claim || null,
    target_symptom: prompt.target_symptom || null,
    emotional_entry: prompt.emotional_entry || null,
    desired_belief_shift: prompt.desired_belief_shift || null,
    opening_pattern: prompt.opening_pattern || null,
    primary_emotion: prompt.primary_emotion || null,
    visual_mode: prompt.visual_mode || null,
    use_product_reference: prompt.use_product_reference !== false,
    visual_reference_type: prompt.visual_reference_type || null,
    visual_reference_id: prompt.visual_reference_id || null,
    scoring_mode: prompt.scoring_mode || null,
    copy_render_expectation: prompt.copy_render_expectation || null,
    product_expectation: prompt.product_expectation || null,
    template_text_contract: prompt.template_text_contract || null,
    visual_copy_plan: prompt.visual_copy_plan || null,
    rendered_text_expectation: prompt.rendered_text_expectation || null,
    visual_text_density: prompt.visual_text_density || null,
    primary_text_context: prompt.primary_text_context || null,
  };
}

function shouldUseDocumentaryVisuals(batch, angleBrief) {
  return false;
}

function buildDirectorScoringContract(batch, documentaryVisuals) {
  if (!batch?.conductor_run_id || documentaryVisuals) return {};
  return {
    scoring_mode: 'template_copy_on_creative',
    copy_render_expectation: 'rendered',
    product_expectation: 'diagnostic',
  };
}

function normalizeImagePromptPackage(value, fallback = {}) {
  if (typeof value === 'string') {
    return {
      prompt: value,
      visual_copy_plan: null,
      template_text_contract: null,
      rendered_text_expectation: fallback.copy_render_expectation || null,
      visual_text_density: null,
    };
  }
  if (!value || typeof value !== 'object') {
    return {
      prompt: '',
      visual_copy_plan: null,
      template_text_contract: null,
      rendered_text_expectation: fallback.copy_render_expectation || null,
      visual_text_density: null,
    };
  }
  return {
    prompt: value.prompt || value.image_prompt || '',
    visual_copy_plan: value.visual_copy_plan || null,
    template_text_contract: value.template_text_contract || null,
    rendered_text_expectation: value.rendered_text_expectation || fallback.copy_render_expectation || null,
    visual_text_density: value.visual_text_density || null,
  };
}

function textFromVisualCopyPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const directFields = [
    plan.headline,
    plan.subhead,
    plan.supporting_text,
    plan.body,
    plan.body_text,
    plan.badge,
    plan.cta,
  ].filter((value) => typeof value === 'string' && value.trim());
  if (directFields.length > 0) return directFields.join('\n');
  if (Array.isArray(plan.zones)) {
    const zoneText = plan.zones
      .map((zone) => zone?.text || zone?.copy)
      .filter((value) => typeof value === 'string' && value.trim());
    if (zoneText.length > 0) return zoneText.join('\n');
  }
  return null;
}

function shouldOcrRenderedCopy(expectation) {
  return ['rendered', 'template_matched'].includes(String(expectation || '').toLowerCase());
}

function toStoredCopyExpectation(expectation, fallback) {
  const normalized = String(expectation || '').toLowerCase();
  if (['none', 'not_required'].includes(normalized)) return 'not_required';
  if (['rendered', 'template_matched'].includes(normalized)) return 'rendered';
  return fallback || null;
}

/**
 * Run a batch job end-to-end.
 * Phase 1: Generate GPT-5.2 prompts (sequential, one per image)
 * Phase 2: Submit to Gemini Batch API
 *
 * Polling for completion is handled by the scheduler.
 *
 * @param {string} batchId
 * @param {(event: object) => void} [onProgress]
 */
export async function runBatch(batchId, onProgress, options = {}) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  let submittedGeminiBatchName = null;

  const throwIfCancelled = async () => {
    if (!shouldCancel || !shouldCancel()) return;
    if (submittedGeminiBatchName) {
      try {
        const ai = await getClient();
        await ai.batches.cancel({ name: submittedGeminiBatchName });
      } catch (err) {
        console.warn(`[BatchProcessor] Could not cancel Gemini batch ${submittedGeminiBatchName}: ${err.message}`);
      }
    }
    try {
      await updateBatchHeartbeat(batchId, { status: 'failed', error_message: 'Cancelled by user' });
    } catch {}
    throw new Error('Cancelled by user');
  };

  await throwIfCancelled();
  const batch = await getBatchJob(batchId);
  if (!batch) throw new Error('Batch job not found');
  if (!['pending', 'queued'].includes(batch.status)) {
    throw new Error(`Batch is already ${batch.status}`);
  }

  await throwIfCancelled();
  const project = await getProject(batch.project_id);
  if (!project) {
    await updateBatchHeartbeat(batchId, { status: 'failed', error_message: 'Project not found.' });
    throw new Error('Project not found');
  }

  // Pre-flight: OpenAI API key must be configured (Stage 1 headline generation depends on it)
  const openaiKey = await getSetting('openai_api_key');
  if (!openaiKey || !openaiKey.trim()) {
    const msg = '[Stage 1] OpenAI API key not configured. Set it in Settings → API Keys.';
    await updateBatchHeartbeat(batchId, { status: 'failed', error_message: msg });
    throw new Error(msg);
  }
  console.info(`[BatchProcessor] Pre-flight: OpenAI API key present (length=${openaiKey.length})`);

  // Load foundational docs in parallel
  const [research, avatar, offer_brief, necessary_beliefs] = await Promise.all([
    getLatestDoc(batch.project_id, 'research'),
    getLatestDoc(batch.project_id, 'avatar'),
    getLatestDoc(batch.project_id, 'offer_brief'),
    getLatestDoc(batch.project_id, 'necessary_beliefs'),
  ]);
  const docs = { research, avatar, offer_brief, necessary_beliefs };

  const docCount = Object.values(docs).filter(d => d && d.content).length;
  if (docCount === 0) {
    const msg = '[Stage 1] Project has no foundational docs. Generate at least one (avatar / offer_brief / research / necessary_beliefs) in the Foundational Docs tab first.';
    await updateBatchHeartbeat(batchId, { status: 'failed', error_message: msg });
    throw new Error(msg);
  }

  try {
    await throwIfCancelled();
    // Phase 1: Generate GPT prompts
    await updateBatchHeartbeat(batchId, { status: 'generating_prompts', started_at: new Date().toISOString() });
    emit({ type: 'status', status: 'generating_prompts', message: `Generating ${batch.batch_size} prompts via GPT-5.2...` });

    const prompts = await generateBatchPrompts(batch, project, docs, onProgress, { throwIfCancelled });

    await throwIfCancelled();
    // Store prompts with headline/body in DB (exclude base64 image data to keep DB size reasonable)
    console.log(`[BatchProcessor] Stage 3 prompts generated; persisting ${prompts.length} prompts to Convex (batch ${batchId.slice(0, 8)})`);
    await updateBatchHeartbeat(batchId, {
      gpt_prompts: JSON.stringify(prompts.map(serializePromptForStorage)),
      status: 'submitting'
    });
    console.log(`[BatchProcessor] Prompts persisted; preparing Gemini Batch submission (batch ${batchId.slice(0, 8)})`);
    emit({ type: 'status', status: 'submitting', message: 'Submitting to Gemini Batch API...' });

    // Load product image if configured (from Convex storage)
    let productImageData = null;
    if (batch.product_image_storageId) {
      try {
        const imgBuffer = await downloadToBuffer(batch.product_image_storageId);
        productImageData = {
          base64: imgBuffer.toString('base64'),
          mimeType: 'image/png'
        };
        console.log(`[BatchProcessor] Product image loaded from Convex (${(imgBuffer.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        console.warn(`[BatchProcessor] Could not load product image from Convex: ${err.message}`);
      }
    }

    // Phase 2: Submit to Gemini Batch API
    await throwIfCancelled();
    const geminiBatchName = await submitGeminiBatch(batchId, prompts, batch.aspect_ratio, project.name, productImageData);
    submittedGeminiBatchName = geminiBatchName;

    await throwIfCancelled();
    await updateBatchHeartbeat(batchId, {
      gemini_batch_job: geminiBatchName,
      status: 'processing'
    });
    emit({ type: 'status', status: 'processing', message: 'Batch submitted to Gemini. Polling for completion...' });

    console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)} submitted. Gemini job: ${geminiBatchName}`);

  } catch (err) {
    const isBillingExhausted = err?.code === 'BILLING_EXHAUSTED';
    const errorMsg = isBillingExhausted ? err.message : `Pipeline failed: ${err.message}`;
    emit({ type: 'error', error: errorMsg });
    console.error(`[BatchProcessor] Batch ${batchId.slice(0, 8)} pipeline failed:`, err.message);
    console.error(`[BatchProcessor] Stack:`, err.stack?.split('\n').slice(0, 3).join('\n'));
    // Side-channel: structured diagnostic for post-mortem inspection (Vercel Hobby doesn't persist logs).
    const diagnostic = {
      stage: 'pipeline',
      failed_at: new Date().toISOString(),
      error_message: err.message,
      error_status: err.status ?? err.statusCode ?? null,
      error_type: err.error?.type ?? err.type ?? null,
      error_code: err.code ?? null,
      provider: err.provider ?? null,
      model: err.model ?? null,
    };
    // Mark batch as failed — retry the status update in case Convex is also having issues
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await updateBatchHeartbeat(batchId, {
          status: 'failed',
          error_message: errorMsg.slice(0, 500),
          pipeline_state: JSON.stringify(diagnostic),
        });
        break;
      } catch (updateErr) {
        console.error(`[BatchProcessor] Failed to mark batch as failed (attempt ${attempt + 1}/3):`, updateErr.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    throw err;
  }
}

/**
 * 4-Stage Pipeline: Generate GPT-5.2 image prompts for all images in a batch.
 *
 * Stage 0: Brief Extraction (1 API call) — condense foundational docs to angle-specific brief
 * Stage 1: Headline + Sub-Angle Generation (1 API call) — scored/ranked headlines with diversity
 * Stage 2: Body Copy Generation (N/5 API calls) — body copy in batches of 5
 * Stage 3: Image Prompt Generation (N API calls) — one per ad with locked copy + template
 *
 * @param {object} batch - The batch job record
 * @param {object} project - The project record
 * @param {{ research?: string, avatar?: string, offer_brief?: string, necessary_beliefs?: string }} docs
 * @param {(event: { type: string, [key: string]: any }) => void} [onProgress]
 * @returns {Promise<Array<{ prompt: string, headline: string, body_copy: string, inspirationTmpPath?: string, inspirationMimeType?: string, templateFileId?: string }>>}
 */
async function generateBatchPrompts(batch, project, docs, onProgress, options = {}) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const batchId = batch.id;
  const angle = batch.angle || null;
  const throwIfCancelled = typeof options.throwIfCancelled === 'function' ? options.throwIfCancelled : async () => {};

  if (batch.template_tag) {
    await assertTemplateTagHasActiveTemplates(batch.project_id, batch.template_tag);
  }

  // Parse structured angle brief if available (set by Director from conductor_angles)
  let angleBrief = null;
  if (batch.angle_brief) {
    try { angleBrief = JSON.parse(batch.angle_brief); } catch {}
  }

  await throwIfCancelled();
  // ========================================
  // STAGE 0: Brief Extraction (1 API call)
  // ========================================
  emit({ type: 'prompt_progress', current: 0, total: batch.batch_size, message: 'Step 1 of 5: Extracting angle-specific brief...' });
  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({ stage: 0, stage_label: 'Step 1 of 5: Extracting brief...' })
  });

  const briefPacket = await extractBrief(project, docs, angle, angleBrief);

  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({ stage: 0, stage_label: 'Step 1 of 5: Brief extracted', brief_length: briefPacket.length })
  });

  await throwIfCancelled();
  let priorHeadlines = [];
  if (batch.angle_name) {
    try {
      const since = new Date(Date.now() - HEADLINE_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
      priorHeadlines = await getRecentHeadlineHistoryByAngle(batch.project_id, batch.angle_name, {
        since,
        limit: HEADLINE_HISTORY_LIMIT,
      });
      console.log(`[BatchProcessor] Loaded ${priorHeadlines.length} historical headlines for angle "${batch.angle_name}"`);
    } catch (err) {
      console.warn(`[BatchProcessor] Failed to load headline history for "${batch.angle_name}": ${err.message}`);
    }
  }

  await throwIfCancelled();
  // ========================================
  // STAGE 1: Headline Generation (1 API call)
  // ========================================
  const headlineCount = Math.ceil(Math.max(batch.batch_size + 10, batch.batch_size * 1.2));
  emit({ type: 'prompt_progress', current: 0, total: batch.batch_size, message: `Step 2 of 5: Generating ${headlineCount} headlines...` });
  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({ stage: 1, stage_label: `Step 2 of 5: Generating headlines...` })
  });

  const headlineResult = await generateHeadlines(project, briefPacket, angle, headlineCount, angleBrief, priorHeadlines);
  const initialCandidates = Array.isArray(headlineResult.headlines) ? headlineResult.headlines : [];
  const sceneAlignedPool = filterSceneAlignedHeadlines(initialCandidates, angleBrief);
  let sceneFallbackUsed = false;
  const sceneHeadlinePool = sceneAlignedPool.survivors.length > 0
    ? sceneAlignedPool.survivors
    : initialCandidates;
  if (sceneAlignedPool.sceneLocked && sceneAlignedPool.survivors.length === 0 && initialCandidates.length > 0) {
    sceneFallbackUsed = true;
    console.warn(`[BatchProcessor] Stage 1 scene alignment filtered every headline for batch ${batchId}; falling back to ranked candidates so generation can continue.`);
  }
  const angleSignalPool = filterAngleSignalHeadlines(sceneHeadlinePool, angleBrief);
  if (angleSignalPool.active) {
    console.log(`[BatchProcessor] Stage 1 angle-signal filter: ${angleSignalPool.survivors.length}/${sceneHeadlinePool.length} survived for angle "${batch.angle_name || angleBrief?.name || 'general'}"`);
  }
  if (angleSignalPool.active && angleSignalPool.survivors.length === 0 && sceneHeadlinePool.length > 0) {
    const full = `[Stage 1] Generated ${initialCandidates.length} headlines for angle "${batch.angle_name || angleBrief?.name || 'general'}" but none reflected the angle's positioning. Tighten the angle's structured fields or check Stage 1 prompt.`;
    const message = full.length > 480 ? full.slice(0, 477) + '...' : full;
    throw new Error(message);
  }
  const initialHeadlinePool = angleSignalPool.active ? angleSignalPool.survivors : sceneHeadlinePool;
  let angleSignalLimited = angleSignalPool.active && angleSignalPool.survivors.length < batch.batch_size;
  if (angleSignalLimited) {
    console.warn(`[BatchProcessor] Stage 1 angle-signal filter left ${angleSignalPool.survivors.length}/${batch.batch_size} usable headlines for angle "${batch.angle_name || angleBrief?.name || 'general'}"; using survivors without regeneration.`);
  }
  const dedupedPool = filterHeadlineCandidatePool(initialHeadlinePool, priorHeadlines);
  let selection = selectDiverseHeadlines(dedupedPool.survivors, batch.batch_size);
  let finalHeadlines = selection.selected;
  let regenCandidateCount = 0;
  let regenDedupedPool = null;
  let regenSceneAlignedPool = null;
  let regenAngleSignalPool = null;

  if (finalHeadlines.length < batch.batch_size && !angleSignalLimited) {
    const shortfall = batch.batch_size - finalHeadlines.length;
    const regenCount = shortfall + Math.max(3, Math.min(6, shortfall));
    console.log(`[BatchProcessor] Stage 1 shortfall: ${shortfall} slots missing after dedup/history filtering, regenerating ${regenCount} candidates`);
    const regenSeedHistory = [
      ...priorHeadlines,
      ...finalHeadlines.map((headline) => ({
        headline: headline.headline,
        hook_lane: headline.hook_lane,
        sub_angle: headline.sub_angle,
        scene_anchor: headline.scene_anchor,
        core_claim: headline.core_claim,
        target_symptom: headline.target_symptom,
        emotional_entry: headline.emotional_entry,
        desired_belief_shift: headline.desired_belief_shift,
        opening_pattern: headline.opening_pattern,
      })),
    ];
    const regenResult = await generateHeadlines(project, briefPacket, angle, regenCount, angleBrief, regenSeedHistory);
    regenCandidateCount = Array.isArray(regenResult.headlines) ? regenResult.headlines.length : 0;
    const selectedNormalized = new Set(finalHeadlines.map((headline) => normalizeHeadlineText(headline.headline)));
    const secondPassPool = [
      ...selection.overflow,
      ...(Array.isArray(regenResult.headlines) ? regenResult.headlines : []),
    ].filter((headline) => !selectedNormalized.has(normalizeHeadlineText(headline.headline)));
    regenSceneAlignedPool = filterSceneAlignedHeadlines(secondPassPool, angleBrief);
    const regenSceneHeadlinePool = regenSceneAlignedPool.survivors.length > 0
      ? regenSceneAlignedPool.survivors
      : secondPassPool;
    if (regenSceneAlignedPool.sceneLocked && regenSceneAlignedPool.survivors.length === 0 && secondPassPool.length > 0) {
      sceneFallbackUsed = true;
      console.warn(`[BatchProcessor] Stage 1 regeneration scene alignment filtered every headline for batch ${batchId}; falling back to ranked candidates.`);
    }
    regenAngleSignalPool = filterAngleSignalHeadlines(regenSceneHeadlinePool, angleBrief);
    if (regenAngleSignalPool.active) {
      console.log(`[BatchProcessor] Stage 1 regeneration angle-signal filter: ${regenAngleSignalPool.survivors.length}/${regenSceneHeadlinePool.length} survived for angle "${batch.angle_name || angleBrief?.name || 'general'}"`);
    }
    const regenHeadlinePool = regenAngleSignalPool.active ? regenAngleSignalPool.survivors : regenSceneHeadlinePool;
    if (regenAngleSignalPool.active && regenAngleSignalPool.survivors.length === 0 && regenSceneHeadlinePool.length > 0) {
      console.warn(`[BatchProcessor] Stage 1 regeneration angle-signal filter rejected all ${regenSceneHeadlinePool.length} candidates for angle "${batch.angle_name || angleBrief?.name || 'general'}"; keeping existing survivors.`);
    }
    regenDedupedPool = filterHeadlineCandidatePool(regenHeadlinePool, regenSeedHistory);
    selection = selectDiverseHeadlines(regenDedupedPool.survivors, batch.batch_size, finalHeadlines);
    finalHeadlines = selection.selected;
  }

  if (finalHeadlines.length === 0) {
    const totalCandidates = initialCandidates.length;
    const sceneRejected = sceneAlignedPool.rejected?.length || 0;
    const sceneSurvived = sceneAlignedPool.survivors?.length || 0;
    const dedupRejected =
      (dedupedPool.rejectedInBatch?.length || 0) +
      (dedupedPool.rejectedByHistory?.length || 0);
    const regenInfo = regenCandidateCount > 0
      ? ` (regen produced ${regenCandidateCount} more, still 0 survived)`
      : '';
    const full = `[Stage 1] All ${totalCandidates} headlines from the LLM filtered out` + regenInfo +
      ` — ${sceneRejected} rejected by scene alignment (${sceneSurvived} survived), ` +
      `${dedupRejected} rejected by history/in-batch dedup. ` +
      `Check the angle's scene constraints or recent headline history.`;
    const message = full.length > 480 ? full.slice(0, 477) + '...' : full;
    throw new Error(message);
  }

  const laneDistribution = finalHeadlines.reduce((distribution, headline) => {
    const lane = headline.hook_lane || 'unassigned';
    distribution[lane] = (distribution[lane] || 0) + 1;
    return distribution;
  }, {});
  const duplicateRejections =
    dedupedPool.rejectedInBatch.length + (regenDedupedPool?.rejectedInBatch.length || 0);
  const historyRejections =
    dedupedPool.rejectedByHistory.length + (regenDedupedPool?.rejectedByHistory.length || 0);
  const sceneAlignmentRejections =
    sceneAlignedPool.rejected.length + (regenSceneAlignedPool?.rejected.length || 0);
  const angleSignalRejections =
    angleSignalPool.rejected.length + (regenAngleSignalPool?.rejected?.length || 0);
  const sceneAlignmentReasonCounts = {
    ...sceneAlignedPool.reasonCounts,
  };
  for (const [reason, count] of Object.entries(regenSceneAlignedPool?.reasonCounts || {})) {
    sceneAlignmentReasonCounts[reason] = (sceneAlignmentReasonCounts[reason] || 0) + count;
  }
  const angleSignalReasonCounts = {
    ...angleSignalPool.reasonCounts,
  };
  for (const [reason, count] of Object.entries(regenAngleSignalPool?.reasonCounts || {})) {
    angleSignalReasonCounts[reason] = (angleSignalReasonCounts[reason] || 0) + count;
  }
  const headlineDiagnostics = {
    scene_locked: isSceneLockedAngle(angleBrief),
    headline_count: finalHeadlines.length,
    headline_candidates: initialCandidates.length + regenCandidateCount,
    scene_alignment_rejections: sceneAlignmentRejections,
    scene_alignment_reason_counts: sceneAlignmentReasonCounts,
    scene_alignment_fallback_used: sceneFallbackUsed,
    angle_signal_filter_active: angleSignalPool.active,
    angle_signal_rejections: angleSignalRejections,
    angle_signal_reason_counts: angleSignalReasonCounts,
    angle_signal_limited: angleSignalLimited,
    duplicate_rejections: duplicateRejections,
    history_rejections: historyRejections,
    lane_count: Object.keys(laneDistribution).length,
    lane_distribution: laneDistribution,
    sub_angle_count: new Set(finalHeadlines.map((headline) => headline.sub_angle).filter(Boolean)).size,
    regen_candidate_count: regenCandidateCount,
  };

  console.log(
    `[BatchProcessor] Stage 1 complete: ${initialCandidates.length + regenCandidateCount} generated, ${sceneAlignmentRejections} scene rejects, ${angleSignalRejections} angle-signal rejects, ${duplicateRejections} intra-batch rejects, ${historyRejections} historical rejects, ${finalHeadlines.length} selected`
  );
  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({
      stage: 1,
      stage_label: `Step 2 of 5: ${finalHeadlines.length} diverse headlines selected`,
      ...headlineDiagnostics,
      headline_diagnostics: headlineDiagnostics,
    })
  });

  await throwIfCancelled();
  // ========================================
  // STAGE 2: Body Copy Generation (N/5 API calls)
  // ========================================
  const totalBodyBatches = Math.ceil(finalHeadlines.length / 5);
  emit({ type: 'prompt_progress', current: 0, total: batch.batch_size, message: `Step 3 of 5: Writing body copy (${totalBodyBatches} batches of 5)...` });
  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({
      stage: 2,
      stage_label: `Step 3 of 5: Writing body copy...`,
      headline_diagnostics: headlineDiagnostics,
    })
  });

  const bodyCopies = await generateBodyCopies(project, briefPacket, finalHeadlines, angleBrief);

  console.log(`[BatchProcessor] Stage 2 complete: ${bodyCopies.length} body copies for ${finalHeadlines.length} headlines`);
  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({
      stage: 2,
      stage_label: `Step 3 of 5: ${bodyCopies.length} body copies generated`,
      body_copy_count: bodyCopies.length,
      headline_diagnostics: headlineDiagnostics,
    })
  });

  if (bodyCopies.length === 0) {
    throw new Error('All body copy generations failed. Check your OpenAI API key and project configuration.');
  }

  await throwIfCancelled();
  // ========================================
  // STAGE 3: Image Prompt Generation (1 per ad)
  // ========================================
  emit({ type: 'prompt_progress', current: 0, total: bodyCopies.length, message: `Step 4 of 5: Creating image prompts (0/${bodyCopies.length})...` });
  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({
      stage: 3,
      stage_label: `Step 4 of 5: Creating image prompts (0/${bodyCopies.length})...`,
      headline_diagnostics: headlineDiagnostics,
    })
  });

  const prompts = [];
  const documentaryVisuals = shouldUseDocumentaryVisuals(batch, angleBrief);
  const scoringContract = buildDirectorScoringContract(batch, documentaryVisuals);

  // Load previously used template IDs for cross-run deduplication
  let usedTemplateIds = [];
  if (batch.used_template_ids) {
    try { usedTemplateIds = JSON.parse(batch.used_template_ids); } catch {}
  }
  // Also load used_template_ids from recent completed batches (cross-batch dedup)
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const recentBatches = await getCompletedDirectorBatchStats(sevenDaysAgo);
    const projectBatches = recentBatches.filter(b => b.project_id === batch.project_id && b.used_template_ids);
    for (const rb of projectBatches) {
      try {
        const ids = JSON.parse(rb.used_template_ids);
        if (Array.isArray(ids)) usedTemplateIds.push(...ids);
      } catch {}
    }
    if (usedTemplateIds.length > 0) {
      usedTemplateIds = [...new Set(usedTemplateIds)]; // deduplicate
      console.log(`[BatchProcessor] Cross-batch dedup: ${usedTemplateIds.length} previously used template IDs loaded`);
    }
  } catch (err) {
    console.warn(`[BatchProcessor] Cross-batch template dedup failed: ${err.message}`);
  }
  const newlyUsedTemplateIds = [];

  // Process image prompts one at a time so each ad gets a unique inspiration image
  const CHUNK_SIZE = 1;
  for (let chunkStart = 0; chunkStart < bodyCopies.length; chunkStart += CHUNK_SIZE) {
    await throwIfCancelled();
    const chunk = bodyCopies.slice(chunkStart, Math.min(chunkStart + CHUNK_SIZE, bodyCopies.length));
    const chunkEnd = chunkStart + chunk.length;

    emit({
      type: 'prompt_progress',
      current: chunkEnd,
      total: bodyCopies.length,
      message: `Step 4 of 5: Creating image prompts ${chunkStart + 1}-${chunkEnd} of ${bodyCopies.length}...`
    });

    await updateBatchHeartbeat(batchId, {
      pipeline_state: JSON.stringify({
        stage: 3,
        stage_label: `Step 4 of 5: Image prompts (${chunkEnd}/${bodyCopies.length})...`,
        current: chunkEnd,
        total: bodyCopies.length,
        headline_diagnostics: headlineDiagnostics,
      })
    });

    let success = false;
    for (let attempt = 1; attempt <= 2 && !success; attempt++) {
      try {
        // Select ONE template image for the entire chunk
        const allExcluded = [...usedTemplateIds, ...newlyUsedTemplateIds];

        let templatePool = [];
        if (batch.template_image_ids) {
          try { templatePool.push(...JSON.parse(batch.template_image_ids).map(id => ({ type: 'uploaded', id }))); } catch {}
        }
        if (batch.inspiration_image_ids) {
          try { templatePool.push(...JSON.parse(batch.inspiration_image_ids).map(id => ({ type: 'drive', id }))); } catch {}
        }

        let imageData;
        let visualReferenceType = null;
        let visualReferenceId = null;
        if (templatePool.length > 0) {
          const pick = templatePool[Math.floor(Math.random() * templatePool.length)];
          if (pick.type === 'uploaded') {
            imageData = await selectTemplateImage(pick.id);
            visualReferenceType = 'uploaded';
            visualReferenceId = pick.id;
          } else {
            imageData = await selectInspirationImage(batch.project_id, pick.id);
            visualReferenceType = 'drive';
            visualReferenceId = pick.id;
          }
        } else if (batch.generation_mode === 'mode2' && batch.template_image_id) {
          imageData = await selectTemplateImage(batch.template_image_id);
          visualReferenceType = 'uploaded';
          visualReferenceId = batch.template_image_id;
        } else if (batch.inspiration_image_id) {
          imageData = await selectInspirationImage(batch.project_id, batch.inspiration_image_id);
          visualReferenceType = 'drive';
          visualReferenceId = batch.inspiration_image_id;
        } else {
          imageData = await selectInspirationImage(batch.project_id, null, {
            excludeIds: allExcluded,
            templateTag: batch.template_tag || '',
          });
          visualReferenceType = batch.template_tag ? 'uploaded' : 'drive';
          visualReferenceId = imageData.fileId || null;
        }

        if (imageData.fileId) {
          newlyUsedTemplateIds.push(imageData.fileId);
        }

        // Batched LLM call: generate image prompts for all ads in chunk at once
        const adSpecs = chunk.map(copy => ({
          headline: copy.headline,
          body_copy: copy.body_copy,
          primary_emotion: copy.primary_emotion || 'curiosity',
          headlineMeta: {
            hook_lane: copy.hook_lane,
            sub_angle: copy.sub_angle,
            scene_anchor: copy.scene_anchor,
            core_claim: copy.core_claim,
            target_symptom: copy.target_symptom,
            emotional_entry: copy.emotional_entry,
            desired_belief_shift: copy.desired_belief_shift,
            opening_pattern: copy.opening_pattern,
          },
        }));

        const imagePrompts = await generateImagePromptsBatch(
          project, adSpecs, imageData,
          batch.aspect_ratio || '1:1',
          angleBrief,
          { documentaryMode: documentaryVisuals, audienceContextSource: docs }
        );

        // Apply prompt guidelines to each prompt individually
        for (let j = 0; j < chunk.length; j++) {
          const promptPackage = normalizeImagePromptPackage(imagePrompts[j], scoringContract);
          let imagePrompt = promptPackage.prompt;
          if (project.prompt_guidelines) {
            imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
          }

          const copy = chunk[j];
          const storedCopyExpectation = toStoredCopyExpectation(
            promptPackage.rendered_text_expectation,
            scoringContract.copy_render_expectation || null
          );
          const visualCopyText = textFromVisualCopyPlan(promptPackage.visual_copy_plan);
          prompts.push({
            prompt: imagePrompt,
            headline: copy.headline,
            body_copy: visualCopyText,
            angle_name: batch.angle_name || null,
            hook_lane: copy.hook_lane || null,
            sub_angle: copy.sub_angle || null,
            scene_anchor: copy.scene_anchor || null,
            core_claim: copy.core_claim || null,
            target_symptom: copy.target_symptom || null,
            emotional_entry: copy.emotional_entry || copy.primary_emotion || null,
            desired_belief_shift: copy.desired_belief_shift || null,
            opening_pattern: copy.opening_pattern || null,
            primary_emotion: copy.primary_emotion || null,
            visual_mode: documentaryVisuals ? 'documentary' : 'template',
            use_product_reference: !documentaryVisuals,
            visual_reference_type: visualReferenceType,
            visual_reference_id: visualReferenceId,
            scoring_mode: scoringContract.scoring_mode || null,
            copy_render_expectation: storedCopyExpectation,
            product_expectation: scoringContract.product_expectation || null,
            template_text_contract: promptPackage.template_text_contract || null,
            visual_copy_plan: promptPackage.visual_copy_plan || null,
            rendered_text_expectation: promptPackage.rendered_text_expectation || null,
            visual_text_density: promptPackage.visual_text_density || null,
            primary_text_context: copy.body_copy || null,
            inspirationTmpPath: imageData.tmpPath,
            inspirationMimeType: imageData.mimeType,
            templateFileId: imageData.fileId || null,
          });
        }
        success = true;

      } catch (err) {
        console.error(`[BatchProcessor] Stage 3 prompts ${chunkStart + 1}-${chunkEnd} attempt ${attempt}/2 failed:`, err.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 3000));
        } else {
          // Push nulls for each ad in the chunk
          for (let j = 0; j < chunk.length; j++) {
            prompts.push(null);
          }
        }
      }
    }

    // Small delay between chunks
    if (chunkEnd < bodyCopies.length) {
      await throwIfCancelled();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Update used_template_ids on the batch record for cross-run tracking
  if (newlyUsedTemplateIds.length > 0) {
    const updatedUsed = [...usedTemplateIds, ...newlyUsedTemplateIds];
    await updateBatchHeartbeat(batchId, { used_template_ids: JSON.stringify(updatedUsed) });
    console.log(`[BatchProcessor] Tracked ${newlyUsedTemplateIds.length} new template IDs (${updatedUsed.length} total used)`);
  }

  // Filter out failed prompts
  const validPrompts = prompts.filter(p => p !== null);
  if (validPrompts.length === 0) {
    throw new Error('All image prompt generations failed. Check your OpenAI API key and project configuration.');
  }

  console.log(`[BatchProcessor] Pipeline complete: ${validPrompts.length}/${bodyCopies.length} prompts generated successfully.`);

  // Clear pipeline_state now that all stages are done
  await updateBatchHeartbeat(batchId, {
    pipeline_state: JSON.stringify({
      stage: 'complete',
      prompts_generated: validPrompts.length,
      headline_diagnostics: headlineDiagnostics,
    })
  });

  return validPrompts;
}

/**
 * Submit prompts to Gemini Batch API.
 * @param {string} batchId
 * @param {Array<{ prompt: string, inspirationTmpPath?: string, inspirationMimeType?: string }>} prompts
 * @param {string} aspectRatio - e.g. '1:1', '9:16'
 * @param {string} projectName - Used in the batch job display name
 * @param {{ base64: string, mimeType: string }|null} [productImageData]
 * @returns {Promise<string>} Gemini batch job name (for polling)
 */
async function submitGeminiBatch(batchId, prompts, aspectRatio, projectName, productImageData = null) {
  const ai = await getClient();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

  // Build inline requests — read images from temp files, caching shared paths
  // (Multiple prompts in a chunk share the same inspirationTmpPath)
  const inspirationCache = new Map();
  const inlineRequests = prompts.map(promptObj => {
    const parts = [{ text: promptObj.prompt }];

    // Include inspiration image so Gemini can reference the visual style
    if (promptObj.inspirationTmpPath) {
      let base64 = inspirationCache.get(promptObj.inspirationTmpPath);
      if (!base64) {
        base64 = readImageBase64({ tmpPath: promptObj.inspirationTmpPath });
        inspirationCache.set(promptObj.inspirationTmpPath, base64);
        // Clean up temp file after caching
        cleanupImageData({ tmpPath: promptObj.inspirationTmpPath });
      }
      parts.push({
        inlineData: {
          data: base64,
          mimeType: promptObj.inspirationMimeType || 'image/jpeg'
        }
      });
    }

    // Include product image only for prompts that explicitly want it.
    if (productImageData && promptObj.use_product_reference !== false) {
      parts.push({
        inlineData: {
          data: productImageData.base64,
          mimeType: productImageData.mimeType
        }
      });
    }
    return {
      contents: [{ parts, role: 'user' }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: aspectRatio || '1:1',
          imageSize: '1K'
        }
      }
    };
  });
  inspirationCache.clear(); // Free cached image data

  const batchJob = await withRetry(
    () => ai.batches.create({
      model: 'gemini-3.1-flash-image-preview',
      src: inlineRequests,
      config: {
        displayName: `${projectName}_batch_${batchId.slice(0, 8)}_${timestamp}`
      }
    }),
    { label: '[Gemini batch create]' }
  );

  return batchJob.name;
}

/**
 * Poll a single batch job for completion.
 * Called by the scheduler's polling loop.
 * @param {string} batchId
 * @returns {Promise<'processing'|'completed'|'failed'>}
 */
export async function pollBatchJob(batchId) {
  const batch = await getBatchJob(batchId);
  if (!batch) return 'failed';
  if (batch.status === 'completed') return 'completed';
  if (batch.status === 'saving_results') return 'processing';

  // If the batch is still in the pre-Gemini pipeline stages (generating prompts,
  // submitting, etc.) it won't have a gemini_batch_job yet — that's normal, not a failure.
  if (!batch.gemini_batch_job) {
    if (['generating_prompts', 'submitting'].includes(batch.status)) {
      return 'processing';
    }
    if (batch.status === 'processing') {
      await updateBatchHeartbeat(batchId, {
        status: 'failed',
        error_message: 'Batch entered image-processing state without a Gemini batch job. It is safe to retry.',
      });
    }
    return 'failed';
  }

  const ai = await getClient();

  try {
    const job = await withRetry(
      () => ai.batches.get({ name: batch.gemini_batch_job }),
      { label: '[Gemini batch poll]', maxRetries: 2 }
    );

    if (job.state === 'JOB_STATE_SUCCEEDED') {
      await processBatchResults(batchId, job);
      return 'completed';
    } else if (job.state === 'JOB_STATE_FAILED' || job.state === 'JOB_STATE_EXPIRED') {
      await updateBatchHeartbeat(batchId, {
        status: 'failed',
        error_message: `Gemini batch job ${job.state.replace('JOB_STATE_', '').toLowerCase()}`
      });
      return 'failed';
    } else if (job.state === 'JOB_STATE_CANCELLED') {
      await updateBatchHeartbeat(batchId, {
        status: 'failed',
        error_message: 'Gemini batch job was cancelled'
      });
      return 'failed';
    }

    // JOB_STATE_PENDING or JOB_STATE_RUNNING — still processing
    console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: state=${job.state}`);
    // Store batch stats for frontend progress display
    if (job.batchStats) {
      const stats = {
        successfulCount: job.batchStats.successfulCount || 0,
        processingCount: job.batchStats.processingCount || 0,
        failedCount: job.batchStats.failedCount || 0,
        totalCount: job.batchStats.totalCount || 0
      };
      await updateBatchHeartbeat(batchId, { batch_stats: JSON.stringify(stats) });
      console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: ${stats.successfulCount} done, ${stats.processingCount} processing`);
    } else {
      await updateBatchHeartbeat(batchId);
    }
    return 'processing';

  } catch (err) {
    console.error(`[BatchProcessor] Poll error for ${batchId.slice(0, 8)}:`, err.message);
    // Don't change status on transient errors — retry next cycle
    return 'processing';
  }
}

/**
 * Process completed batch results: extract images, upload to Convex storage,
 * upload to Drive, create ad_creative records.
 * @param {string} batchId
 * @param {object} job - The Gemini batch job object from the API
 * @returns {Promise<{ savedCount: number, failedCount: number }>}
 */
async function processBatchResults(batchId, job) {
  const claim = await claimBatchResultsProcessing(batchId);
  if (!claim.claimed) {
    return {
      savedCount: claim.completed_count || 0,
      failedCount: claim.failed_count || 0,
    };
  }

  const batch = await getBatchJob(batchId);
  if (!batch) throw new Error('Batch not found');

  const project = await getProject(batch.project_id);
  const prompts = JSON.parse(batch.gpt_prompts || '[]');

  // Phase 1 — Staging Page: ensure the ad_set this batch's ads will join exists.
  // Deterministic id (`adset-<batchId>`) makes this idempotent if processBatchResults
  // is retried. Failure to set up the ad_set is non-fatal — ads will still be created
  // without `ad_set_id` and will appear as orphan ads (not surfaced in the Staging
  // Page until a manual fix). Logged so it's not silent.
  let stagingAdSetId = null;
  try {
    stagingAdSetId = await ensureBatchAdSet(batch, project);
  } catch (err) {
    console.warn(`[BatchProcessor] Could not ensure ad_set for batch ${batchId.slice(0, 8)}: ${err.message}. Ads will be created without ad_set_id.`);
  }

  // Get responses from the batch job
  const responses = job.dest?.inlinedResponses || [];

  // Load product image for single-image retries (if configured)
  let productImageData = null;
  if (batch.product_image_storageId) {
    try {
      const imgBuffer = await downloadToBuffer(batch.product_image_storageId);
      productImageData = { base64: imgBuffer.toString('base64'), mimeType: 'image/png' };
    } catch {}
  }

  let savedCount = 0;
  let failedCount = 0;
  const historyEntries = [];

  for (let i = 0; i < responses.length; i++) {
    try {
      const response = responses[i];
      // Navigate the response structure — may vary by SDK version
      const parts = response?.response?.candidates?.[0]?.content?.parts
        || response?.candidates?.[0]?.content?.parts
        || [];

      let imageBuffer = null;
      let mimeType = 'image/png';
      let textResponse = '';

      for (const part of parts) {
        if (part.inlineData) {
          imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          mimeType = part.inlineData.mimeType || 'image/png';
        } else if (part.text) {
          textResponse += part.text;
        }
      }

      // Get the prompt object (may be { prompt, headline, body_copy } or a legacy string)
      const promptObj = prompts[i];
      const promptText = typeof promptObj === 'string' ? promptObj : (promptObj?.prompt || null);

      // If batch response had no image, retry with direct Gemini call (1 attempt)
      if (!imageBuffer && promptText) {
        console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: No image in response ${i}, retrying with direct Gemini call...`);
        try {
          const retryResult = await generateImage(
            promptText,
            batch.aspect_ratio || '1:1',
            (typeof promptObj === 'object' && promptObj?.use_product_reference === false) ? null : productImageData
          );
          if (retryResult && retryResult.imageBuffer) {
            imageBuffer = retryResult.imageBuffer;
            mimeType = retryResult.mimeType || 'image/png';
            console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: Retry succeeded for response ${i}`);
          }
        } catch (retryErr) {
          console.warn(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: Retry failed for response ${i}: ${retryErr.message}`);
        }
      }

      if (!imageBuffer) {
        console.warn(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: No image in response ${i} (after retry)`);
        failedCount++;
        continue;
      }

      // Upload image to Convex storage
      const storageId = await uploadBuffer(imageBuffer, mimeType);

      // Extract actual rendered text from image (Gemini often renders different copy than requested)
      let renderedHeadline = (typeof promptObj === 'object' ? promptObj?.headline : null) || undefined;
      let renderedBodyCopy = (typeof promptObj === 'object' ? promptObj?.body_copy : null) || undefined;
      const isRenderedCopy = typeof promptObj === 'object' && shouldOcrRenderedCopy(
        promptObj?.rendered_text_expectation || promptObj?.copy_render_expectation
      );
      if (isRenderedCopy) {
        try {
          const extracted = await extractRenderedCopy(imageBuffer, mimeType, batch.project_id);
          if (extracted.headline) renderedHeadline = extracted.headline;
          if (extracted.body_copy) renderedBodyCopy = extracted.body_copy;
        } catch (err) {
          console.warn(`[BatchProcessor] OCR extraction failed for response ${i}: ${err.message}`);
        }
      }

      // Create ad_creative record. The deterministic ID makes result-saving
      // retries safe if a serverless invocation times out after partial writes.
      const adId = uuidv5(`batch-result:${batchId}:${i}`, BATCH_AD_UUID_NAMESPACE);
      const existingAd = await convexClient.query(api.adCreatives.getByExternalId, { externalId: adId }).catch(() => null);
      if (existingAd) {
        savedCount++;
        continue;
      }
      const adCompletedAt = new Date().toISOString();
      await convexClient.mutation(api.adCreatives.create, {
        externalId: adId,
        project_id: batch.project_id,
        generation_mode: batch.generation_mode,
        angle: batch.angle || undefined,
        angle_name: batch.angle_name || undefined,
        headline: renderedHeadline,
        body_copy: renderedBodyCopy,
        hook_lane: (typeof promptObj === 'object' ? promptObj?.hook_lane : null) || undefined,
        core_claim: (typeof promptObj === 'object' ? promptObj?.core_claim : null) || undefined,
        target_symptom: (typeof promptObj === 'object' ? promptObj?.target_symptom : null) || undefined,
        emotional_entry: (typeof promptObj === 'object' ? promptObj?.emotional_entry : null) || undefined,
        desired_belief_shift: (typeof promptObj === 'object' ? promptObj?.desired_belief_shift : null) || undefined,
        opening_pattern: (typeof promptObj === 'object' ? promptObj?.opening_pattern : null) || undefined,
        sub_angle: (typeof promptObj === 'object' ? promptObj?.sub_angle : null) || undefined,
        scoring_mode: (typeof promptObj === 'object' ? promptObj?.scoring_mode : null) || undefined,
        copy_render_expectation: (typeof promptObj === 'object' ? promptObj?.copy_render_expectation : null) || undefined,
        product_expectation: (typeof promptObj === 'object' ? promptObj?.product_expectation : null) || undefined,
        image_prompt: promptText || undefined,
        gpt_creative_output: promptText || undefined,
        aspect_ratio: batch.aspect_ratio,
        storageId,
        status: 'completed',
        completed_at: adCompletedAt,
        auto_generated: true,
        template_image_id: (typeof promptObj === 'object' && promptObj?.visual_reference_type === 'uploaded'
          ? promptObj.visual_reference_id
          : batch.template_image_id) || undefined,
        inspiration_image_id: (typeof promptObj === 'object' && promptObj?.visual_reference_type === 'drive'
          ? promptObj.visual_reference_id
          : undefined) || undefined,
        batch_job_id: batchId,
        text_model: 'gpt-5.2',
        image_model: 'nano-banana-2',
        // Phase 1 — Staging Page: link the ad to its parent ad_set if one was created.
        // Falls back to undefined when ensureBatchAdSet failed; ad becomes an orphan
        // (visible in AdStudio gallery, not in Staging Page) until manually grouped.
        ad_set_id: stagingAdSetId || undefined,
      });

      if (batch.angle_name && typeof promptObj === 'object' && promptObj?.headline) {
        historyEntries.push(buildHeadlineHistoryEntry({
          projectId: batch.project_id,
          angleName: batch.angle_name,
          batchJobId: batchId,
          conductorRunId: batch.conductor_run_id || null,
          adCreativeId: adId,
          candidate: {
            headline: promptObj.headline,
            hook_lane: promptObj.hook_lane,
            sub_angle: promptObj.sub_angle,
            scene_anchor: promptObj.scene_anchor,
            core_claim: promptObj.core_claim,
            target_symptom: promptObj.target_symptom,
            emotional_entry: promptObj.emotional_entry || promptObj.primary_emotion,
            desired_belief_shift: promptObj.desired_belief_shift,
            opening_pattern: promptObj.opening_pattern,
          },
          createdAt: new Date().toISOString(),
        }));
      }

      savedCount++;
      if (savedCount % 3 === 0) {
        await updateBatchHeartbeat(batchId);
      }

      // Log Gemini cost with batch discount (fire-and-forget)
      try { await logGeminiCost(batch.project_id, 1, '2K', true); } catch {}

    } catch (err) {
      console.error(`[BatchProcessor] Failed to process result ${i}:`, err.message);
      failedCount++;
    }
  }

  if (historyEntries.length > 0) {
    try {
      await recordHeadlineHistory(historyEntries);
    } catch (err) {
      console.warn(`[BatchProcessor] Failed to record headline history for ${historyEntries.length} ads: ${err.message}`);
    }
  }

  // Accumulate counts across runs (don't overwrite previous runs' totals)
  await updateBatchHeartbeat(batchId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_count: (batch.completed_count || 0) + savedCount,
    failed_count: (batch.failed_count || 0) + failedCount,
    run_count: (batch.run_count || 0) + 1
  });

  console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)} completed: ${savedCount} saved, ${failedCount} failed (run ${(batch.run_count || 0) + 1}, total: ${(batch.completed_count || 0) + savedCount} saved).`);
  return { savedCount, failedCount };
}

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import {
  getProject, createBatchJob, getBatchJob, getBatchesByProject,
  updateBatchJob, deleteBatchJob, uploadBuffer
} from '../convexClient.js';
import { copyStorageBlob } from '../utils/adImages.js';
import { assertTemplateTagHasActiveTemplates, normalizeTemplateTag } from '../services/adGenerator.js';
import { resolveImageModel, getImageProvider } from '../services/imageProvider.js';

// Durable batch execution is handled by the cron-backed scheduler. These hooks
// are retained for route compatibility; the scheduler reads Convex directly.
const registerCronJob = () => {};
const unregisterCronJob = () => {};
const loadScheduledBatches = () => [];

const router = Router();
router.use(requireAuth);
const MAX_REFERENCE_IMAGES = 10;

function normalizeProductImages(body) {
  const incoming = Array.isArray(body.product_images)
    ? body.product_images
    : (body.product_images ? [body.product_images] : []);
  const normalized = incoming
    .map(img => ({
      base64: img?.base64 || img?.image || null,
      mimeType: img?.mimeType || img?.mime_type || img?.mime || 'image/png',
    }))
    .filter(img => img.base64);
  if (normalized.length > MAX_REFERENCE_IMAGES) {
    const err = new Error(`Use up to ${MAX_REFERENCE_IMAGES} reference images per batch.`);
    err.status = 400;
    throw err;
  }
  if (normalized.length > 0) return normalized;
  if (body.product_image && body.product_image_mime) {
    return [{ base64: body.product_image, mimeType: body.product_image_mime }];
  }
  return [];
}

/**
 * POST /:projectId/batches — Create a new batch job
 */
router.post('/:projectId/batches', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const {
    generation_mode = 'mode1',
    batch_size = 5,
    angle,
    aspect_ratio = '1:1',
    template_image_id,
    template_image_ids,        // JSON string array of uploaded template IDs (multi-select)
    template_tag,
    inspiration_image_id,
    inspiration_image_ids,     // JSON string array of drive template IDs (multi-select)
    product_image,
    product_image_mime,
    product_images,
    product_image_storageIds,
    skip_product_image,
    image_model,
    scheduled = false,
    schedule_cron,
    run_immediately = true
  } = req.body;

  // Validate
  if (!['mode1', 'mode2'].includes(generation_mode)) {
    return res.status(400).json({ error: 'generation_mode must be "mode1" or "mode2".' });
  }
  // mode2 requires either single template_image_id or multi template_image_ids
  if (generation_mode === 'mode2' && !template_image_id && !template_image_ids) {
    return res.status(400).json({ error: 'template_image_id or template_image_ids is required for mode2.' });
  }
  const size = Math.max(1, Math.min(50, parseInt(batch_size) || 5));
  const normalizedTemplateTag = normalizeTemplateTag(template_tag);
  if (normalizedTemplateTag && !template_image_id && !template_image_ids && !inspiration_image_id && !inspiration_image_ids) {
    try {
      await assertTemplateTagHasActiveTemplates(req.params.projectId, normalizedTemplateTag);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const id = uuidv4();
  const resolvedImageModel = resolveImageModel(image_model);
  const imageProvider = getImageProvider(resolvedImageModel);
  let productImages;
  try {
    productImages = normalizeProductImages({ ...req.body, product_images });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  // Upload product image to Convex storage if provided, else use project-level image
  let productImageStorageId = undefined;
  let productImageStorageIds = undefined;
  if (skip_product_image) {
    // Explicitly skip product image (user opted out)
    productImageStorageId = undefined;
  } else if (Array.isArray(product_image_storageIds) && product_image_storageIds.length > 0) {
    if (product_image_storageIds.length > MAX_REFERENCE_IMAGES) {
      return res.status(400).json({ error: `Use up to ${MAX_REFERENCE_IMAGES} reference images per batch.` });
    }
    productImageStorageIds = product_image_storageIds;
    productImageStorageId = productImageStorageIds[0];
  } else if (typeof product_image_storageIds === 'string' && product_image_storageIds.trim()) {
    try {
      const parsed = JSON.parse(product_image_storageIds);
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (parsed.length > MAX_REFERENCE_IMAGES) {
          return res.status(400).json({ error: `Use up to ${MAX_REFERENCE_IMAGES} reference images per batch.` });
        }
        productImageStorageIds = parsed;
        productImageStorageId = productImageStorageIds[0];
      }
    } catch {}
  } else if (productImages.length > 0) {
    productImageStorageIds = [];
    for (const img of productImages) {
      const buffer = Buffer.from(img.base64, 'base64');
      productImageStorageIds.push(await uploadBuffer(buffer, img.mimeType));
    }
    productImageStorageId = productImageStorageIds[0];
  } else if (project.product_image_storageId) {
    // Copy the project's product image into a new storage blob owned by THIS batch.
    // Sharing the storage ID would mean batchJobs.remove() deletes the project's image
    // when the batch is cleaned up, breaking the project's product image silently.
    try {
      productImageStorageId = await copyStorageBlob(project.product_image_storageId);
      productImageStorageIds = [productImageStorageId];
    } catch (err) {
      console.warn(`[batches] Project product image storageId is dead, proceeding without: ${err.message}`);
      productImageStorageId = undefined;
    }
  }

  try {
    const shouldQueueNow = run_immediately && !scheduled;
    const now = new Date().toISOString();
    await createBatchJob({
      id,
      project_id: req.params.projectId,
      generation_mode,
      batch_size: size,
      angle: (angle && angle !== 'undefined') ? angle : null,
      aspect_ratio,
      template_image_id: template_image_id || null,
      template_image_ids: template_image_ids || null,
      template_tag: normalizedTemplateTag || null,
      inspiration_image_id: inspiration_image_id || null,
      inspiration_image_ids: inspiration_image_ids || null,
      product_image_storageId: productImageStorageId,
      product_image_storageIds: productImageStorageIds?.length ? JSON.stringify(productImageStorageIds) : undefined,
      scheduled: !!scheduled,
      schedule_cron: schedule_cron || null,
      status: shouldQueueNow ? 'queued' : 'pending',
      queued_at: shouldQueueNow ? now : undefined,
      last_heartbeat_at: shouldQueueNow ? now : undefined,
      image_model: resolvedImageModel,
      image_provider: imageProvider,
    });

    // If scheduled, register the cron job
    if (scheduled && schedule_cron) {
      const batch = await getBatchJob(id);
      registerCronJob(batch);
    }

    const batch = await getBatchJob(id);
    res.status(201).json(batch);

  } catch (err) {
    console.error('[Batches API] Create error:', err.message);
    console.error('[Batches API] Create error details:', err.stack || err);
    res.status(500).json({ error: 'Failed to create batch job. Please try again.' });
  }
});

/**
 * GET /:projectId/batches — List all batch jobs for a project
 */
router.get('/:projectId/batches', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const batches = await getBatchesByProject(req.params.projectId);
  res.json({ batches, total: batches.length });
});

/**
 * GET /:projectId/batches/:batchId — Get a single batch job
 */
router.get('/:projectId/batches/:batchId', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }
  res.json(batch);
});

/**
 * PUT /:projectId/batches/:batchId — Update batch config (schedule, etc.)
 */
router.put('/:projectId/batches/:batchId', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  const { scheduled, schedule_cron, angle, batch_size, aspect_ratio } = req.body;
  const updates = {};

  if (scheduled !== undefined) updates.scheduled = scheduled ? 1 : 0;
  if (schedule_cron !== undefined) updates.schedule_cron = schedule_cron;
  if (angle !== undefined) updates.angle = angle;
  if (batch_size !== undefined) updates.batch_size = batch_size;
  if (aspect_ratio !== undefined) updates.aspect_ratio = aspect_ratio;

  if (Object.keys(updates).length > 0) {
    await updateBatchJob(req.params.batchId, updates);
  }

  // Update cron registration (handles both edit and pause/resume)
  if (scheduled === true) {
    const updated = await getBatchJob(req.params.batchId);
    if (updated.schedule_cron) registerCronJob(updated);
  } else if (scheduled === false) {
    unregisterCronJob(req.params.batchId);
  }

  res.json(await getBatchJob(req.params.batchId));
});

/**
 * DELETE /:projectId/batches/:batchId — Delete/cancel a batch job
 */
router.delete('/:projectId/batches/:batchId', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  // Unregister cron if scheduled
  unregisterCronJob(req.params.batchId);

  await deleteBatchJob(req.params.batchId);
  res.json({ success: true, id: req.params.batchId });
});

/**
 * POST /:projectId/batches/:batchId/run — Manually trigger a batch job
 */
router.post('/:projectId/batches/:batchId/run', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  if (!['pending', 'completed', 'failed'].includes(batch.status)) {
    return res.status(400).json({ error: `Cannot run batch in "${batch.status}" state. Wait for current run to finish.` });
  }

  const now = new Date().toISOString();
  await updateBatchJob(req.params.batchId, {
    status: 'queued',
    error_message: null,
    gemini_batch_job: null,
    gpt_prompts: null,
    batch_stats: null,
    queued_at: now,
    last_heartbeat_at: now,
    stale_detected_at: null,
  });

  res.json({ success: true, message: 'Batch job queued.', batch: await getBatchJob(req.params.batchId) });
});

/**
 * POST /:projectId/batches/:batchId/cancel — Cancel an active batch job
 */
router.post('/:projectId/batches/:batchId/cancel', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  if (!['queued', 'generating_prompts', 'submitting', 'processing'].includes(batch.status)) {
    return res.status(400).json({ error: `Cannot cancel batch in "${batch.status}" state.` });
  }

  // If it has a Gemini batch job, attempt to cancel it
  if (batch.gemini_batch_job) {
    try {
      const { getClient } = await import('../services/gemini.js');
      const ai = getClient();
      await ai.batches.cancel({ name: batch.gemini_batch_job });
    } catch (err) {
      console.warn(`[Batches API] Could not cancel Gemini batch: ${err.message}`);
    }
  }

  await updateBatchJob(req.params.batchId, { status: 'failed', error_message: 'Cancelled by user' });
  res.json({ success: true, message: 'Batch cancelled.', batch: await getBatchJob(req.params.batchId) });
});

/**
 * POST /retry/:batchId — Retry a failed batch
 * This route is mounted at /api/batches/retry/:batchId (flat, no project nesting)
 */
router.post('/retry/:batchId', async (req, res) => {
  try {
    const batch = await getBatchJob(req.params.batchId);
    if (!batch) {
      return res.status(404).json({ error: 'Batch job not found' });
    }

    if (!['pending', 'completed', 'failed'].includes(batch.status)) {
      return res.status(400).json({ error: `Cannot retry batch in "${batch.status}" state.` });
    }

    const now = new Date().toISOString();
    await updateBatchJob(req.params.batchId, {
      status: 'queued',
      error_message: null,
      gemini_batch_job: null,
      gpt_prompts: null,
      batch_stats: null,
      queued_at: now,
      last_heartbeat_at: now,
      stale_detected_at: null,
      retry_count: 0,
    });

    res.json({ success: true, message: 'Batch retry queued.', batch: await getBatchJob(req.params.batchId) });
  } catch (err) {
    console.error('[Batches API] Retry error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

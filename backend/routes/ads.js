import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getLatestDoc, getAdsByProject, getInProgressAdsByProject, getAd, getAdImageUrl, markStaleAdsAsFailed, uploadBuffer, setProjectProductImage, convexClient, api } from '../convexClient.js';

// Single-ad generation can now run up to the Vercel Fluid Compute ceiling, but
// legitimate long-running requests heartbeat every 30s. No heartbeat for this
// threshold means the request/stream is dead enough to surface a terminal state.
const STUCK_ADS_THRESHOLD_MIN = 5;
import { generateAd, generateAdMode2, regenerateImageOnly, applyPromptEdit, assertTemplateTagHasActiveTemplates, normalizeTemplateTag } from '../services/adGenerator.js';
import { generateBodyCopy } from '../services/bodyCopyGenerator.js';
import { chat } from '../services/openai.js';
import { buildAngleGenerationPrompt, buildHeadlineGenerationPrompt } from '../services/adStudioPrompts.js';

// Same model the batch pipeline uses for copy generation (see commit 76c8109).
const SINGLE_AD_TEXT_MODEL = 'gpt-5.2';
import { getProjectProductImage, generateThumbnail } from '../utils/adImages.js';
import { streamService } from '../utils/sseHelper.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMB_CACHE_DIR = path.join(__dirname, '..', '.thumb-cache');

// Ensure thumbnail cache directory exists
if (!fs.existsSync(THUMB_CACHE_DIR)) {
  fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
}

const router = Router();
router.use(requireAuth);

const TERMINAL_AD_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'quality_rejected']);
const CANCELLABLE_AD_STATUSES = new Set(['pending', 'queued', 'generating_copy', 'generating_image']);
const CANCEL_POLL_MS = 2000;

function attachAdMedia(projectId, ad) {
  return {
    ...ad,
    imageUrl: ad.storageId ? `/api/projects/${projectId}/ads/${ad.id}/image` : null,
    thumbnailUrl: ad.storageId ? `/api/projects/${projectId}/ads/${ad.id}/thumbnail` : null,
  };
}

async function repairStaleAdsForProject(projectId) {
  try {
    const result = await markStaleAdsAsFailed(projectId, { olderThanMinutes: STUCK_ADS_THRESHOLD_MIN });
    if (result?.repaired > 0) {
      console.info(`[ads-cleanup] repaired ${result.repaired} stale generating ads in project ${projectId}`);
    }
    return result;
  } catch (err) {
    console.warn(`[ads-cleanup] failed for project ${projectId}:`, err.message);
    return { repaired: 0, error: err.message };
  }
}

function createAdCancellationWatcher(sendEvent) {
  const controller = new AbortController();
  let adId = null;
  let pollTimer = null;

  const stop = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const start = (nextAdId) => {
    if (!nextAdId || nextAdId === adId) return;
    adId = nextAdId;
    stop();
    pollTimer = setInterval(async () => {
      if (controller.signal.aborted || !adId) return;
      try {
        const ad = await convexClient.query(api.adCreatives.getByExternalId, { externalId: adId });
        if (ad?.cancellation_requested_at || ad?.status === 'cancelled' || ad?.status === 'canceled') {
          controller.abort(new Error('Cancelled by user'));
        }
      } catch (err) {
        console.warn(`[Ads] Cancellation poll failed for ${adId}:`, err.message);
      }
    }, CANCEL_POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  };

  return {
    signal: controller.signal,
    sendEvent(event) {
      if (event?.adId) start(event.adId);
      sendEvent(event);
    },
    stop,
  };
}

// Generate an ad creative (SSE stream)
router.post('/:projectId/generate-ad', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let { mode = 'mode1', aspect_ratio, angle, inspiration_image_id, uploaded_image, uploaded_image_mime, product_image, product_image_mime, headline, body_copy, template_image_id, template_tag, skip_product_image, image_model, save_as_project_default } = req.body;
  template_tag = normalizeTemplateTag(template_tag);

  // If user opted to save the per-ad product image as the project default,
  // persist it BEFORE generation so the image is saved even if generation fails.
  // Only fires when there's a per-ad upload AND the project has no image yet.
  if (save_as_project_default && product_image && product_image_mime && !project.product_image_storageId) {
    try {
      const buffer = Buffer.from(product_image, 'base64');
      const storageId = await uploadBuffer(buffer, product_image_mime);
      await setProjectProductImage(req.params.projectId, storageId);
      project.product_image_storageId = storageId;  // keep local var in sync for downstream code
    } catch (err) {
      console.warn('[Ads] Failed to save product image as project default:', err.message);
      // Non-fatal — proceed with ad generation regardless.
    }
  }

  // Auto-inject project-level product image if none provided (and not explicitly skipped).
  // If the fetch fails (dead storageId, transient Convex error, etc.), capture a warning
  // to surface via SSE so the user knows their toggle was ON but the image was dropped.
  let productImageWarning = null;
  if (!product_image && !skip_product_image && project.product_image_storageId) {
    try {
      const projImg = await getProjectProductImage(project);
      if (projImg) {
        product_image = projImg.base64;
        product_image_mime = projImg.mimeType;
      }
    } catch (err) {
      if (err.code === 'product_image_fetch_failed') {
        productImageWarning = 'Project product image could not be loaded — generating without it. Try re-uploading the image in Project Settings.';
      } else {
        throw err;
      }
    }
  }

  if (mode !== 'mode1' && mode !== 'mode2') {
    return res.status(400).json({ error: 'Mode must be "mode1" or "mode2".' });
  }

  if (mode === 'mode2' && !template_image_id) {
    return res.status(400).json({ error: 'template_image_id is required for Mode 2 generation.' });
  }

  if (mode === 'mode1' && template_tag && !inspiration_image_id && !uploaded_image) {
    try {
      await assertTemplateTagHasActiveTemplates(req.params.projectId, template_tag);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  streamService(req, res, async (sendEvent) => {
    const cancellation = createAdCancellationWatcher(sendEvent);
    try {
      if (productImageWarning) {
        cancellation.sendEvent({ type: 'warning', tag: 'product_image_fetch_failed', message: productImageWarning });
      }
      if (mode === 'mode2') {
        await generateAdMode2(req.params.projectId, {
          templateImageId: template_image_id,
          angle,
          aspectRatio: aspect_ratio || '1:1',
          imageModel: image_model || undefined,
          productImageBase64: product_image || undefined,
          productImageMimeType: product_image_mime || undefined,
          headline: headline || undefined,
          bodyCopy: body_copy || undefined,
          onEvent: cancellation.sendEvent,
          cancelSignal: cancellation.signal
        });
      } else {
        await generateAd(req.params.projectId, {
          angle,
          aspectRatio: aspect_ratio || '1:1',
          imageModel: image_model || undefined,
          inspirationImageId: inspiration_image_id,
          templateTag: template_tag || undefined,
          uploadedImageBase64: uploaded_image || undefined,
          uploadedImageMimeType: uploaded_image_mime || undefined,
          productImageBase64: product_image || undefined,
          productImageMimeType: product_image_mime || undefined,
          headline: headline || undefined,
          bodyCopy: body_copy || undefined,
          onEvent: cancellation.sendEvent,
          cancelSignal: cancellation.signal
        });
      }
    } finally {
      cancellation.stop();
    }
  });
});

// Regenerate image only — skip GPT, use provided prompt (SSE stream)
router.post('/:projectId/regenerate-image', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let { image_prompt, aspect_ratio, parent_ad_id, product_image, product_image_mime, reference_image, reference_image_mime, angle, headline, body_copy, skip_product_image, image_model, save_as_project_default } = req.body;

  // Same save-as-project-default flow as in the generate-ad route.
  if (save_as_project_default && product_image && product_image_mime && !project.product_image_storageId) {
    try {
      const buffer = Buffer.from(product_image, 'base64');
      const storageId = await uploadBuffer(buffer, product_image_mime);
      await setProjectProductImage(req.params.projectId, storageId);
      project.product_image_storageId = storageId;
    } catch (err) {
      console.warn('[Ads] Failed to save product image as project default:', err.message);
    }
  }

  // Auto-inject project-level product image if none provided (and not explicitly skipped).
  // Surface fetch failures as an SSE warning instead of silently dropping the image.
  let productImageWarning = null;
  if (!product_image && !skip_product_image && project.product_image_storageId) {
    try {
      const projImg = await getProjectProductImage(project);
      if (projImg) {
        product_image = projImg.base64;
        product_image_mime = projImg.mimeType;
      }
    } catch (err) {
      if (err.code === 'product_image_fetch_failed') {
        productImageWarning = 'Project product image could not be loaded — regenerating without it. Try re-uploading the image in Project Settings.';
      } else {
        throw err;
      }
    }
  }

  if (!image_prompt || !image_prompt.trim()) {
    return res.status(400).json({ error: 'image_prompt is required for image-only regeneration.' });
  }

  streamService(req, res, async (sendEvent) => {
    const cancellation = createAdCancellationWatcher(sendEvent);
    try {
      if (productImageWarning) {
        cancellation.sendEvent({ type: 'warning', tag: 'product_image_fetch_failed', message: productImageWarning });
      }
      await regenerateImageOnly(req.params.projectId, {
        imagePrompt: image_prompt.trim(),
        aspectRatio: aspect_ratio || '1:1',
        imageModel: image_model || undefined,
        parentAdId: parent_ad_id || undefined,
        productImageBase64: product_image || undefined,
        productImageMimeType: product_image_mime || undefined,
        referenceImageBase64: reference_image || undefined,
        referenceImageMimeType: reference_image_mime || undefined,
        angle: angle || undefined,
        headline: headline || undefined,
        bodyCopy: body_copy || undefined,
        onEvent: cancellation.sendEvent,
        cancelSignal: cancellation.signal
      });
    } finally {
      cancellation.stop();
    }
  });
});

// Apply a natural-language edit to an existing image prompt (returns modified prompt, no image generation)
router.post('/:projectId/edit-prompt', async (req, res) => {
  const { original_prompt, edit_instruction, reference_image, reference_image_mime } = req.body;

  if (!original_prompt || !original_prompt.trim()) {
    return res.status(400).json({ error: 'original_prompt is required.' });
  }
  if (!edit_instruction || !edit_instruction.trim()) {
    return res.status(400).json({ error: 'edit_instruction is required.' });
  }

  try {
    const referenceImage = reference_image ? { base64: reference_image, mimeType: reference_image_mime || 'image/jpeg' } : null;
    const revisedPrompt = await applyPromptEdit(original_prompt.trim(), edit_instruction.trim(), referenceImage);
    res.json({ revised_prompt: revisedPrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate a random angle/topic from foundational docs
router.post('/:projectId/generate-angle', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [avatar, offer_brief] = await Promise.all([
      getLatestDoc(req.params.projectId, 'avatar'),
      getLatestDoc(req.params.projectId, 'offer_brief'),
    ]);

    const avatarSnippet = (avatar?.content || '').slice(0, 2000);
    const offerSnippet = (offer_brief?.content || '').slice(0, 2000);

    if (!avatarSnippet && !offerSnippet) {
      return res.status(400).json({ error: 'Generate foundational docs first.' });
    }

    const result = await chat([{
      role: 'user',
      content: buildAngleGenerationPrompt({ project, avatarSnippet, offerSnippet }),
    }], SINGLE_AD_TEXT_MODEL, { max_tokens: 100, operation: 'ad_angle_generation', projectId: req.params.projectId });

    const angle = result.trim().replace(/^["'"]+|["'"]+$/g, '');
    res.json({ angle });
  } catch (err) {
    console.error('Failed to generate angle:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a headline from foundational docs + angle
router.post('/:projectId/generate-headline', async (req, res) => {
  try {
    const { angle } = req.body;
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [avatar, offer_brief, research] = await Promise.all([
      getLatestDoc(req.params.projectId, 'avatar'),
      getLatestDoc(req.params.projectId, 'offer_brief'),
      getLatestDoc(req.params.projectId, 'research'),
    ]);

    const avatarSnippet = (avatar?.content || '').slice(0, 2000);
    const offerSnippet = (offer_brief?.content || '').slice(0, 1500);
    const researchSnippet = (research?.content || '').slice(0, 1500);

    if (!avatarSnippet && !offerSnippet) {
      return res.status(400).json({ error: 'Generate foundational docs first.' });
    }

    const result = await chat([{
      role: 'user',
      content: buildHeadlineGenerationPrompt({ project, angle, avatarSnippet, offerSnippet, researchSnippet }),
    }], SINGLE_AD_TEXT_MODEL, { max_tokens: 150, operation: 'ad_headline_generation', projectId: req.params.projectId });

    const headline = result.trim().replace(/^["'"]+|["'"]+$/g, '');
    res.json({ headline });
  } catch (err) {
    console.error('Failed to generate headline:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate body copy for Ad Studio
router.post('/:projectId/generate-body-copy', async (req, res) => {
  try {
    const { headline, angle, style } = req.body;

    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Anchor priority: explicit headline → explicit angle → project product
    // description → project brand name → project name. The Generate button is
    // always clickable (matches angle/headline siblings), so the route must
    // succeed for any project that has any usable text on its record.
    const headlineForCopy = (headline || '').trim();
    const angleForCopy = (angle || '').trim();
    const anchor =
      headlineForCopy ||
      angleForCopy ||
      (project.product_description || '').trim() ||
      (project.brand_name || '').trim() ||
      (project.name || '').trim();

    if (!anchor) {
      return res.status(400).json({ error: 'Add a project name or product description first.' });
    }

    // Synthesize a minimal quote object for bodyCopyGenerator's signature.
    const quote = {
      quote: anchor,
      emotion: 'persuasive',
      emotional_intensity: 'medium',
    };

    const targetDemographic = project.niche || '';
    const problem = angleForCopy;

    const bodyCopy = await generateBodyCopy(anchor, quote, targetDemographic, problem, style || 'short');
    res.json({ body_copy: bodyCopy });
  } catch (err) {
    console.error('Failed to generate body copy:', err);
    res.status(500).json({ error: err.message });
  }
});

// List all ads for a project
router.get('/:projectId/ads', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  await repairStaleAdsForProject(req.params.projectId);
  const ads = await getAdsByProject(req.params.projectId);
  const withUrls = ads.map(ad => attachAdMedia(req.params.projectId, ad));
  res.json({ ads: withUrls, total: withUrls.length });
});

// Admin emergency endpoint: forced cleanup of stuck ads with custom threshold.
router.post('/:projectId/ads/cleanup-stuck', async (req, res) => {
  const olderThanMinutes = Number(req.body?.olderThanMinutes ?? STUCK_ADS_THRESHOLD_MIN);
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes <= 0) {
    return res.status(400).json({ error: 'olderThanMinutes must be a positive number' });
  }
  try {
    const result = await markStaleAdsAsFailed(req.params.projectId, { olderThanMinutes });
    res.json({ success: true, repaired: result.repaired });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get in-progress ads for queue restoration
router.get('/:projectId/ads/in-progress', async (req, res) => {
  try {
    await repairStaleAdsForProject(req.params.projectId);
    const ads = await getInProgressAdsByProject(req.params.projectId);
    res.json({ ads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request cancellation for an active single-ad generation.
// The running SSE worker observes this flag and performs the terminal transition.
router.post('/:projectId/ads/:adId/cancel', async (req, res) => {
  try {
    const ad = await getAd(req.params.adId);
    if (!ad || ad.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    if (TERMINAL_AD_STATUSES.has(ad.status)) {
      return res.status(409).json({ error: `Cannot cancel ad in "${ad.status}" state.` });
    }

    if (!CANCELLABLE_AD_STATUSES.has(ad.status)) {
      return res.status(409).json({ error: `Cannot cancel ad in "${ad.status || 'unknown'}" state.` });
    }

    const cancellationRequestedAt = new Date().toISOString();
    await convexClient.mutation(api.adCreatives.update, {
      externalId: req.params.adId,
      cancellation_requested_at: cancellationRequestedAt,
      cancelled_by: req.user?.username || req.user?.displayName || req.user?.id || 'unknown',
      error_message: null,
      failure_stage: null,
    });

    res.json({
      success: true,
      cancellation_requested_at: cancellationRequestedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single ad
router.get('/:projectId/ads/:adId', async (req, res) => {
  const ad = await getAd(req.params.adId);
  if (!ad || ad.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Ad not found' });
  }

  res.json(attachAdMedia(req.params.projectId, ad));
});

// Update tags on an ad
router.patch('/:projectId/ads/:adId/tags', async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array of strings' });
    await convexClient.mutation(api.adCreatives.update, {
      externalId: req.params.adId,
      tags: tags.map(t => String(t).trim()).filter(Boolean),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle favorite on an ad
router.patch('/:projectId/ads/:adId/favorite', async (req, res) => {
  try {
    const { is_favorite } = req.body;
    await convexClient.mutation(api.adCreatives.update, {
      externalId: req.params.adId,
      is_favorite: !!is_favorite,
    });
    res.json({ success: true, is_favorite: !!is_favorite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve ad image file (redirect to Convex storage URL — fallback for direct links)
router.get('/:projectId/ads/:adId/image', async (req, res) => {
  const url = await getAdImageUrl(req.params.adId);
  if (!url) {
    return res.status(404).json({ error: 'Image file not found' });
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.redirect(url);
});

// Serve resized thumbnail (~400px wide, JPEG 80%) with disk cache
router.get('/:projectId/ads/:adId/thumbnail', async (req, res) => {
  try {
    const result = await generateThumbnail(req.params.adId, THUMB_CACHE_DIR);
    if (result.cached) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(result.path).pipe(res);
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(result.buffer);
  } catch (err) {
    console.error(`[Thumbnail] Failed for ${req.params.adId}:`, err.message);
    // Fallback: redirect to full image
    try {
      const url = await getAdImageUrl(req.params.adId);
      if (url) return res.redirect(url);
    } catch {}
    res.status(500).json({ error: 'Thumbnail generation failed' });
  }
});

// Delete an ad
router.delete('/:projectId/ads/:adId', async (req, res) => {
  const ad = await getAd(req.params.adId);
  if (!ad || ad.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Ad not found' });
  }

  await convexClient.mutation(api.adCreatives.remove, {
    externalId: req.params.adId,
  });

  res.json({ success: true, id: req.params.adId });
});

export default router;

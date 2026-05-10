import { v4 as uuidv4 } from 'uuid';
import { chat, chatWithImage, chatWithImages } from './openai.js';
import { generateImage as geminiGenerateImage } from './gemini.js';

// Batch-pipeline LLM model selection (per-call-type, chosen for capability).
// Migrated off Anthropic 2026-04-30 — see changelog for rationale.
const BATCH_TEXT_MODEL = 'gpt-5.2';     // copy generation: brief extraction, headlines, body copy, repair, image-prompt-text
const BATCH_VISION_MODEL = 'gpt-4.1';   // image-prompt-with-vision: 4.1 has reliable vision regardless of OpenAI tier

// Whitelist of allowed image-model strings + which provider handles each.
// Prevents devtools-injected arbitrary strings from reaching the API.
const GEMINI_MODELS = new Set(['nano-banana-pro', 'nano-banana-2', 'gemini-3-pro']);

function resolveImageProvider(imageModel) {
  if (!imageModel || GEMINI_MODELS.has(imageModel)) return geminiGenerateImage;
  throw new Error(`Unknown image model: ${imageModel}`);
}

function imageModelLabel(imageModel) {
  if (imageModel === 'nano-banana-2') return 'Nano Banana 2';
  return 'Nano Banana Pro';
}

function makeRenderReference(base64, mimeType, role) {
  if (!base64 || !mimeType) return null;
  return { base64, mimeType, role };
}
import { withHeavyLLMLimit } from './rateLimiter.js';
import {
  getProject, getLatestDoc, uploadBuffer, downloadToBuffer,
  getInspirationImages, getAllInspirationImages, getInspirationImageUrl,
  getTemplateImagesByProject, getAllTemplateImages,
  getAdImageUrl, getSetting, convexClient, api, invalidateQueryCache
} from '../convexClient.js';
import sharp from 'sharp';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
// Drive upload removed — ads are stored in Convex only

// Pre-generate thumbnail cache for newly created ads
const __adgen_dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMB_CACHE_DIR = path.join(__adgen_dirname, '..', '.thumb-cache');
if (!fs.existsSync(THUMB_CACHE_DIR)) {
  fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
}

const TERMINAL_AD_STATUSES = new Set(['completed', 'failed', 'quality_rejected', 'cancelled', 'canceled']);
const AD_CANCELLED_MESSAGE = 'Cancelled by user';
const MISSING_PRODUCT_DESCRIPTION_MESSAGE = "This project is missing a Product Description. Add a clear 1-3 sentence description of what's actually being sold (the offer, who it's for, and what they get), then try generating again.";

export function assertProductDescription(project) {
  if (String(project?.product_description || '').trim()) return;

  const projectExternalId = project?.externalId || project?.id;
  const err = new Error(MISSING_PRODUCT_DESCRIPTION_MESSAGE);
  err.code = 'MISSING_PRODUCT_DESCRIPTION';
  err.userActionable = true;
  err.actionUrl = projectExternalId ? `/projects/${projectExternalId}?tab=overview` : '/projects';
  err.actionLabel = 'Edit Product Description';
  throw err;
}

function buildAdErrorEvent(err) {
  return {
    type: 'error',
    error: err.message,
    message: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.userActionable !== undefined ? { userActionable: err.userActionable } : {}),
    ...(err.actionUrl ? { actionUrl: err.actionUrl } : {}),
    ...(err.actionLabel ? { actionLabel: err.actionLabel } : {}),
  };
}

function emitAdError(emit, err) {
  emit(buildAdErrorEvent(err));
}

function isTerminalAdStatus(status) {
  return TERMINAL_AD_STATUSES.has(status);
}

function buildAdCancellationError(message = AD_CANCELLED_MESSAGE) {
  const err = new Error(message);
  err.code = 'AD_GENERATION_CANCELLED';
  return err;
}

function isAdCancellationError(err, cancelSignal = null) {
  if (!err) return false;
  if (err.code === 'AD_GENERATION_CANCELLED' || err.code === 'GEMINI_CANCELLED') return true;
  if (err.geminiErrorClass === 'cancelled') return true;
  if (cancelSignal?.aborted && (err.name === 'AbortError' || /cancel|abort/i.test(err.message || ''))) return true;
  return false;
}

async function assertAdNotCancelled(adId, cancelSignal = null) {
  if (cancelSignal?.aborted) throw buildAdCancellationError();
  const ad = await convexClient.query(api.adCreatives.getByExternalId, { externalId: adId });
  if (ad?.cancellation_requested_at || ad?.status === 'cancelled' || ad?.status === 'canceled') {
    throw buildAdCancellationError();
  }
  return ad;
}

async function markAdCancelled(adId, emit, fields = {}) {
  await updateAdCreative(adId, {
    status: 'cancelled',
    error_message: AD_CANCELLED_MESSAGE,
    failure_stage: null,
    ...fields,
  });
  emit({ type: 'cancelled', adId, message: AD_CANCELLED_MESSAGE });
}

function serializeImageAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return undefined;
  return JSON.stringify(attempts.map((attempt, index) => ({
    attempt_number: Number(attempt.attempt_number) || index + 1,
    started_at: attempt.started_at || null,
    ended_at: attempt.ended_at || null,
    duration_ms: Number.isFinite(attempt.duration_ms) ? attempt.duration_ms : null,
    error_class: attempt.error_class || 'unknown',
    error_message: attempt.error_message || null,
    queue_depth_at_start: Number.isFinite(attempt.queue_depth_at_start) ? attempt.queue_depth_at_start : null,
  })));
}

async function precacheThumb(adId, imageBuffer) {
  try {
    const thumb = await sharp(imageBuffer)
      .resize({ width: 400, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    fs.writeFile(path.join(THUMB_CACHE_DIR, `${adId}.jpg`), thumb, () => {});
  } catch (e) { /* non-critical */ }
}

async function createAdCreative(fields) {
  const now = new Date().toISOString();
  await convexClient.mutation(api.adCreatives.create, {
    ...fields,
    last_progress_at: now,
    ...(isTerminalAdStatus(fields.status) && !fields.completed_at ? { completed_at: now } : {}),
  });
  invalidateQueryCache('ad_creatives');
}

async function updateAdCreative(adId, fields) {
  const now = new Date().toISOString();
  await convexClient.mutation(api.adCreatives.update, {
    externalId: adId,
    ...fields,
    last_progress_at: fields.last_progress_at || now,
    ...(isTerminalAdStatus(fields.status) && !fields.completed_at ? { completed_at: now } : {}),
  });
  invalidateQueryCache('ad_creatives');
}

function emitProgress(emit, adId, event) {
  emit({ type: 'status', adId, ...event });
  updateAdCreative(adId, {
    status: event.status,
    error_message: null,
    failure_stage: null,
  }).catch(() => {});
}

function startAdHeartbeat(adId, intervalMs = 30 * 1000) {
  const handle = setInterval(() => {
    updateAdCreative(adId, {}).catch((err) => {
      console.warn(`[AdGenerator] Heartbeat failed for ${adId.slice(0, 8)}: ${err.message}`);
    });
  }, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

export function normalizeTemplateTag(tag) {
  return String(tag || '').trim();
}

function normalizeTemplateTags(tags) {
  if (Array.isArray(tags)) return tags.map(normalizeTemplateTag).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map(normalizeTemplateTag).filter(Boolean);
  return [];
}

function templateMatchesTag(template, tag) {
  const normalized = normalizeTemplateTag(tag).toLowerCase();
  if (!normalized) return true;
  return normalizeTemplateTags(template?.tags).some(t => t.toLowerCase() === normalized);
}

function activeStoredTemplates(templates, tag = '') {
  return (templates || [])
    .filter(t => t?.storageId && !t.archived_at)
    .filter(t => templateMatchesTag(t, tag));
}

export async function getActiveTemplatePoolForTag(projectId, templateTag = '') {
  const normalizedTag = normalizeTemplateTag(templateTag);
  const templates = normalizedTag
    ? await getAllTemplateImages()
    : await getTemplateImagesByProject(projectId);
  return activeStoredTemplates(templates, normalizedTag);
}

export async function assertTemplateTagHasActiveTemplates(projectId, templateTag = '') {
  const normalizedTag = normalizeTemplateTag(templateTag);
  if (!normalizedTag) return { tag: '', count: 0 };
  const pool = await getActiveTemplatePoolForTag(projectId, normalizedTag);
  if (pool.length === 0) {
    throw new Error(`No active templates are tagged "${normalizedTag}". Add that tag to a template or choose Any active template before starting generation.`);
  }
  return { tag: normalizedTag, count: pool.length };
}

/**
 * Extract headline and body copy from a freeform image generation prompt.
 * Uses GPT-4.1-mini with JSON response format for reliable parsing.
 * Non-blocking — returns nulls if extraction fails.
 */
export async function extractHeadlineAndBody(imagePrompt) {
  if (!imagePrompt || !imagePrompt.trim()) return { headline: null, body_copy: null };
  try {
    const result = await chat([
      {
        role: 'system',
        content: `You extract the headline and body copy from image generation prompts. Return JSON with exactly two fields:
- "headline": The main headline text that appears on the ad (the large, prominent text). Extract ONLY the text itself, not formatting instructions.
- "body_copy": The supporting body copy / subheadline text (smaller text below the headline). Extract ONLY the text itself.

If the prompt doesn't contain a clear headline, set headline to null.
If the prompt doesn't contain body copy, set body_copy to null.
Return ONLY valid JSON, no markdown.`
      },
      {
        role: 'user',
        content: imagePrompt
      }
    ], 'gpt-4.1-mini', { response_format: { type: 'json_object' }, operation: 'ad_headline_extraction' });

    const parsed = JSON.parse(result);
    return {
      headline: parsed.headline || null,
      body_copy: parsed.body_copy || null,
    };
  } catch (err) {
    console.warn('[AdGenerator] Headline extraction failed:', err.message);
    return { headline: null, body_copy: null };
  }
}

/**
 * Review and revise an image prompt against project-level prompt guidelines.
 * Uses a fast GPT model to check the prompt for violations and fix them.
 * Returns the original prompt unchanged if no guidelines are set or no changes needed.
 */
export async function reviewPromptWithGuidelines(imagePrompt, guidelines) {
  if (!guidelines || !guidelines.trim()) return imagePrompt;

  try {
    const reviewMessages = [
      {
        role: 'system',
        content: `You are a prompt reviewer. You will receive an image generation prompt and a set of rules/guidelines. Your job is to revise the prompt so it complies with ALL the guidelines while preserving the original creative intent, style, and detail level.

Rules:
- If the prompt already complies with all guidelines, return it EXACTLY as-is.
- If changes are needed, make minimal targeted edits to fix violations.
- Do NOT add disclaimers, explanations, or commentary — return ONLY the revised prompt text.
- Do NOT shorten or simplify the prompt — keep the same level of detail.
- Preserve the artistic direction, brand elements, and layout instructions.`
      },
      {
        role: 'user',
        content: `GUIDELINES:\n${guidelines.trim()}\n\n---\n\nIMAGE PROMPT:\n${imagePrompt}`
      }
    ];

    const revisedPrompt = await chat(reviewMessages, 'gpt-4.1-mini', { operation: 'prompt_guideline_review' });
    return revisedPrompt.trim();
  } catch (err) {
    console.warn('[AdGenerator] Prompt guidelines review failed, using original prompt:', err.message);
    return imagePrompt;
  }
}

/**
 * Apply a natural-language edit instruction to an existing image prompt.
 * Uses GPT to interpret the user's edit description and modify the prompt accordingly.
 * Returns the modified prompt text.
 */
export async function applyPromptEdit(originalPrompt, editInstruction, referenceImage = null) {
  if (!editInstruction || !editInstruction.trim()) return originalPrompt;
  if (!originalPrompt || !originalPrompt.trim()) throw new Error('Original prompt is required.');

  const systemContent = `You are an expert image prompt editor. You will receive an existing image generation prompt and a user's edit instruction describing what they want to change.${referenceImage ? ' The user may also attach a reference image — use it to understand what they are describing (e.g., the correct product, a color reference, a style example). Describe what you see in the image and incorporate that into the revised prompt accurately.' : ''}

Your job:
- Interpret the user's edit instruction and apply it to the existing prompt.
- Make targeted modifications to the prompt that accomplish the requested change.
- Preserve everything else in the prompt that is NOT related to the edit instruction — keep all other creative details, style, layout, brand elements, colors, typography, and composition.
- If the edit is about adding something, integrate it naturally into the prompt.
- If the edit is about removing something, remove it cleanly.
- If the edit is about changing something, swap it out while keeping the surrounding context intact.
- Return ONLY the revised prompt text. No explanations, no commentary, no markdown formatting.
- Keep the same level of detail and length as the original prompt.`;

  // Build user message — if a reference image is attached, use multipart content format for vision
  let userContent;
  if (referenceImage) {
    userContent = [
      { type: 'text', text: `CURRENT PROMPT:\n${originalPrompt.trim()}\n\n---\n\nEDIT INSTRUCTION:\n${editInstruction.trim()}\n\n---\n\nI have attached a reference image below. Use it to understand what I'm describing in my edit instruction.` },
      { type: 'image_url', image_url: { url: `data:${referenceImage.mimeType};base64,${referenceImage.base64}` } }
    ];
  } else {
    userContent = `CURRENT PROMPT:\n${originalPrompt.trim()}\n\n---\n\nEDIT INSTRUCTION:\n${editInstruction.trim()}`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];

  try {
    const revisedPrompt = await chat(messages, 'gpt-4.1-mini', { operation: 'prompt_edit' });
    return revisedPrompt.trim();
  } catch (err) {
    console.error('[AdGenerator] Prompt edit failed:', err.message);
    throw new Error('Failed to apply edit to prompt. Please try again.');
  }
}

/**
 * Build the creative director prompt (Message 1) for GPT-5.2.
 * Includes brand context + all 4 foundational documents.
 * @param {object} project - The project record
 * @param {object} docs - { research, avatar, offer_brief, necessary_beliefs }
 */
export function buildCreativeDirectorPrompt(project, docs) {
  const researchContent = docs.research?.content || '[No research document available]';
  const avatarContent = docs.avatar?.content || '[No avatar sheet available]';
  const offerContent = docs.offer_brief?.content || '[No offer brief available]';
  const beliefsContent = docs.necessary_beliefs?.content || '[No necessary beliefs document available]';
  const offerRenderContext = getOfferRenderContext(project, docs);

  let prompt = `You are a world-class creative director and image generation expert working exclusively for ${project.brand_name}, a brand advertising this offer: ${project.product_description}.

🎯 Your Role:
Your sole job is to analyze creative inputs and generate prompts for text-to-image softwares for the brand, including:
Static ads
Comparison ads
Offer explainer visuals
Before/after belief or situation transformations
Lifestyle, documentary, or user-experience visuals
And more

📄 Workflow:
I will upload four foundational documents containing important brand strategy, copywriting, audience insights, and creative direction.
I will then upload example image ads (from competitors or previous tests).
You must:
Analyze the documents and image examples carefully.
Recreate the image concepts—but styled, branded, and tailored for my brand mentioned above.
Ensure the design, layout, and mood matches my brands audience and brand aesthetic.
Ask for clarification only if absolutely necessary—default to action.

OFFER RENDERING CONTEXT:
${offerRenderContext}

✅ Creative Requirements:
All image generations must use 1:1 aspect ratio unless otherwise specified.
Use truthful visual anchors for the offer being advertised. For non-physical offers, show the prospect's lived moment, decision context, emotional state, or outcome rather than inventing a physical item.
Avoid generic stock photo vibes—aim for realism, emotional specificity, and offer-relevant ad performance.
Prioritize scroll-stopping contrast and clean, legible design.
Do not invent proof elements, reviewer names, review-score graphics, customer-volume claims, named testimonial signatures, or specific statistics unless they are present in the project documentation.

📣 Tone & Audience:
Please match the tone of the ads according to the research doc attached to this message.
Please begin by simply acknowledging your role.

---

FOUNDATIONAL DOCUMENTS:

RESEARCH DOCUMENT:
${researchContent}

AVATAR SHEET:
${avatarContent}

OFFER BRIEF:
${offerContent}

NECESSARY BELIEFS:
${beliefsContent}`;

  return prompt;
}

/**
 * Build the image prompt request (Message 2) text.
 * Per the SOP, the core instruction is exactly "make a prompt for an image like this".
 * Angle, aspect ratio, product image, headline, and body copy are appended as additional direction.
 *
 * Pass `imageModel` when known for future model-specific prompt routing.
 */
export function buildImageRequestText(angle, aspectRatio, hasProductImage = false, headline = null, bodyCopy = null, angleBrief = null, imageModel = null) {
  let text = 'make a prompt for an image like this';

  const extras = [];
  if (hasProductImage) {
    extras.push('I have attached an image of the product — reference this product image in your prompt, as it will also be attached when the prompt is used for image generation');
  }
  if (headline) {
    const cleanHeadline = headline.replace(/^["'""\u201C\u201D]+|["'""\u201C\u201D]+$/g, '');
    extras.push(`The ad must include this headline text exactly as written (do NOT add quotation marks around it): ${cleanHeadline}`);
  }
  if (bodyCopy) {
    const cleanBody = bodyCopy.replace(/^["'""\u201C\u201D]+|["'""\u201C\u201D]+$/g, '');
    extras.push(`The ad must include this body copy text exactly as written (do NOT add quotation marks around it): ${cleanBody}`);
  }
  if (angleBrief && (angleBrief.scene || angleBrief.tone)) {
    // Use structured angle context when available
    const briefParts = [];
    if (angleBrief.scene) briefParts.push(`scene: ${angleBrief.scene}`);
    if (angleBrief.tone) briefParts.push(`tone: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) briefParts.push(`avoid: ${angleBrief.avoid_list}`);
    extras.push(`The ad should focus on this angle: ${angle || angleBrief.name || 'general'} (${briefParts.join('; ')})`);
  } else if (angle) {
    extras.push(`The ad should focus on this angle/topic: ${angle}`);
  }
  if (aspectRatio && aspectRatio !== '1:1') {
    extras.push(`Use ${aspectRatio} aspect ratio instead of 1:1`);
  }

  if (extras.length > 0) {
    text += '. ' + extras.join('. ');
  }

  return text;
}

/**
 * Select an inspiration image from Convex storage. For Random Template
 * (inspirationImageId === null) the function tries `inspiration_images` (the
 * Drive-synced folder) first; if empty, it falls back to `template_images`
 * (uploaded templates) so projects without Drive sync still work.
 *
 * @param {string} projectId
 * @param {string|null} inspirationImageId - Specific Drive file ID to use, or null for random
 * @returns {{ tmpPath: string, mimeType: string, fileId: string }}
 */
export async function selectInspirationImage(projectId, inspirationImageId, optionsOrExcludeIds = []) {
  const options = Array.isArray(optionsOrExcludeIds)
    ? { excludeIds: optionsOrExcludeIds }
    : (optionsOrExcludeIds || {});
  const excludeIds = Array.isArray(options.excludeIds) ? options.excludeIds : [];
  const templateTag = normalizeTemplateTag(options.templateTag);
  // Scope to current project's inspiration images and deduplicate by drive_file_id
  const inspirationImages = await getInspirationImages(projectId);
  const seen = new Set();
  const dedupedInspiration = inspirationImages.filter(img => {
    if (seen.has(img.drive_file_id)) return false;
    seen.add(img.drive_file_id);
    return true;
  });

  // If a specific Drive inspiration ID was requested, only the inspiration_images table is valid.
  if (inspirationImageId) {
    const selected = dedupedInspiration.find(img => img.drive_file_id === inspirationImageId);
    if (!selected) {
      throw new Error(`Inspiration image ${inspirationImageId} not found in cache.`);
    }
    return await loadInspirationFromStorage(selected, selected.drive_file_id);
  }

  // Tagged random selection uses uploaded Template Library images only. This
  // keeps tag behavior explicit and prevents a tagged Director run from
  // silently falling back to unrelated Drive inspiration images.
  let candidates = dedupedInspiration;
  let usingTemplates = false;
  if (templateTag) {
    candidates = await getActiveTemplatePoolForTag(projectId, templateTag);
    usingTemplates = true;
  } else if (!candidates.length) {
    const templates = await getTemplateImagesByProject(projectId);
    candidates = activeStoredTemplates(templates);
    usingTemplates = true;
  }
  if (!candidates.length) {
    throw new Error(templateTag
      ? `No active templates are tagged "${templateTag}". Add that tag to a template or choose Any active template.`
      : 'No templates available. Upload templates in the Template Library first.');
  }

  let pool = candidates;
  if (excludeIds.length > 0) {
    const excludeSet = new Set(excludeIds);
    const filtered = candidates.filter(c => !excludeSet.has(usingTemplates ? c.externalId : c.drive_file_id));
    if (filtered.length > 0) pool = filtered;
    // If all candidates are excluded, reset to full pool.
  }
  const selected = pool[Math.floor(Math.random() * pool.length)];
  const fileId = usingTemplates ? selected.externalId : selected.drive_file_id;
  return await loadInspirationFromStorage(selected, fileId);
}

/**
 * Download a stored image (from inspiration_images OR template_images) to a
 * temp file and return the metadata expected by the rest of the ad pipeline.
 */
async function loadInspirationFromStorage(selected, fileId) {
  if (!selected.storageId) {
    throw new Error('Selected template has no stored file. Re-upload or re-sync.');
  }
  const buffer = await downloadToBuffer(selected.storageId);
  const mimeType = selected.mimeType || 'image/jpeg';

  // Write to temp file to avoid holding large base64 strings in memory
  const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
  const tmpPath = path.join(os.tmpdir(), `insp_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmpPath, buffer);

  return { tmpPath, mimeType, fileId };
}

/**
 * Read base64 from imageData — supports both temp file (batch mode) and inline base64 (single ad mode).
 * After reading from a temp file, the file is deleted to free disk space.
 * @param {{ tmpPath?: string, base64?: string }} imageData
 * @returns {string} base64-encoded image data
 */
export function readImageBase64(imageData) {
  if (imageData.base64) return imageData.base64;
  if (imageData.tmpPath) {
    const buffer = fs.readFileSync(imageData.tmpPath);
    return buffer.toString('base64');
  }
  throw new Error('imageData has no base64 or tmpPath');
}

/**
 * Clean up temp file from imageData if it exists. Called after image is no longer needed.
 * @param {{ tmpPath?: string }} imageData
 */
export function cleanupImageData(imageData) {
  if (imageData?.tmpPath) {
    try { fs.unlinkSync(imageData.tmpPath); } catch { /* already deleted */ }
  }
}

/**
 * Generate a slug from angle text for Drive file naming.
 */
function slugify(text) {
  if (!text) return 'NoAngle';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

/**
 * Select a template image from Convex storage.
 * @param {string} templateImageId - The template_images external ID
 * @returns {{ base64: string, mimeType: string, fileId: string }}
 */
export async function selectTemplateImage(templateImageId) {
  const template = await convexClient.query(api.templateImages.getByExternalId, { externalId: templateImageId });
  if (!template) {
    throw new Error(`Template image ${templateImageId} not found.`);
  }
  if (!template.storageId) {
    throw new Error(`Template image has no stored file. Re-upload the template.`);
  }

  // Download from Convex storage
  const buffer = await downloadToBuffer(template.storageId);
  const mimeType = template.mimeType || 'image/jpeg';

  // Write to temp file to avoid holding large base64 strings in memory
  const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
  const tmpPath = path.join(os.tmpdir(), `tmpl_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmpPath, buffer);

  return { tmpPath, mimeType, fileId: template.externalId };
}

/**
 * Generate a single ad creative (Mode 1 — Inspiration Folder).
 *
 * @param {string} projectId
 * @param {object} options
 * @param {string} [options.angle] - Optional angle/hook
 * @param {string} [options.aspectRatio='1:1'] - Aspect ratio
 * @param {string} [options.inspirationImageId] - Specific inspiration image ID (null = random from folder)
 * @param {string} [options.uploadedImageBase64] - Base64-encoded uploaded image (overrides folder selection)
 * @param {string} [options.uploadedImageMimeType] - MIME type of the uploaded image
 * @param {string} [options.productImageBase64] - Base64-encoded product image to reference
 * @param {string} [options.productImageMimeType] - MIME type of the product image
 * @param {string} [options.headline] - Optional headline text for the ad
 * @param {string} [options.bodyCopy] - Optional body copy text for the ad
 * @param {(event: object) => void} [options.onEvent] - SSE event callback
 * @returns {Promise<object>} The completed ad creative record
 */
export async function generateAd(projectId, options = {}) {
  const { angle, aspectRatio = '1:1', imageModel, inspirationImageId, templateTag, uploadedImageBase64, uploadedImageMimeType, productImageBase64, productImageMimeType, headline, bodyCopy, onEvent, cancelSignal } = options;

  const emit = (event) => {
    if (onEvent) {
      try { onEvent(event); } catch {}
    }
  };

  // Create ad record at the start
  const adId = uuidv4();
  emit({ type: 'status', status: 'generating_copy', message: 'Loading project data...', progress: 2, adId });
  await createAdCreative({
    externalId: adId,
    project_id: projectId,
    generation_mode: 'mode1',
    angle: angle || undefined,
    headline: headline || undefined,
    body_copy: bodyCopy || undefined,
    aspect_ratio: aspectRatio,
    status: 'generating_copy',
    inspiration_image_id: inspirationImageId || undefined,
    text_model: 'gpt-5.2',
    image_model: imageModel || 'nano-banana-2',
  });

  const stopHeartbeat = startAdHeartbeat(adId);
  try {
    await assertAdNotCancelled(adId, cancelSignal);

    // 1. Load project + foundational docs + inspiration image in parallel
    const useUploadedImage = !!(uploadedImageBase64 && uploadedImageMimeType);
    const [project, research, avatar, offer_brief, necessary_beliefs, inspiration] = await Promise.all([
      getProject(projectId),
      getLatestDoc(projectId, 'research'),
      getLatestDoc(projectId, 'avatar'),
      getLatestDoc(projectId, 'offer_brief'),
      getLatestDoc(projectId, 'necessary_beliefs'),
      useUploadedImage
        ? Promise.resolve({ base64: uploadedImageBase64, mimeType: uploadedImageMimeType, fileId: 'uploaded' })
        : selectInspirationImage(projectId, inspirationImageId, { templateTag }),
    ]);
    if (!project) throw new Error('Project not found');
    assertProductDescription(project);
    await assertAdNotCancelled(adId, cancelSignal);

    const docs = { research, avatar, offer_brief, necessary_beliefs };

    // Ensure at least some docs exist
    const docCount = Object.values(docs).filter(d => d && d.content).length;
    if (docCount === 0) {
      throw new Error('No foundational documents found. Generate or upload documents first.');
    }

    // Update the inspiration_image_id in the record (fire-and-forget, don't block)
    if (!useUploadedImage && inspiration.fileId) {
      updateAdCreative(adId, {
        inspiration_image_id: inspiration.fileId,
      }).catch(() => {});
    }

    // GPT-5.2 Messages 1-2: Rate-limited to prevent TPM overload
    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    let renderReferenceImages = [];

    let imagePrompt = await withHeavyLLMLimit(async () => {
      await assertAdNotCancelled(adId, cancelSignal);
      // Message 1: Creative director prompt + foundational docs
      emitProgress(emit, adId, { status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...', progress: 15 });

      const creativeDirectorPrompt_inner = buildCreativeDirectorPrompt(project, docs);
      const acknowledgment = await chat(
        [{ role: 'user', content: creativeDirectorPrompt_inner }],
        'gpt-5.2',
        { operation: 'ad_creative_director', projectId, signal: cancelSignal }
      );

      await assertAdNotCancelled(adId, cancelSignal);
      // Message 2: Inspiration image + optional product image + instructions
      emitProgress(emit, adId, { status: 'generating_copy', message: hasProductImage
        ? 'GPT-5.2 analyzing inspiration image + product image...'
        : 'GPT-5.2 analyzing inspiration image...', progress: 35 });

      const imageRequestText_inner = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy, null, imageModel);
      const conversationSoFar = [
        { role: 'user', content: creativeDirectorPrompt_inner },
        { role: 'assistant', content: acknowledgment }
      ];

      const inspirationBase64 = readImageBase64(inspiration);
      renderReferenceImages = [
        makeRenderReference(inspirationBase64, inspiration.mimeType, 'layout'),
        hasProductImage ? makeRenderReference(productImageBase64, productImageMimeType, 'product') : null,
      ].filter(Boolean);

      let prompt;
      if (hasProductImage) {
        prompt = await chatWithImages(
          conversationSoFar,
          imageRequestText_inner,
          [
            { base64: inspirationBase64, mimeType: inspiration.mimeType },
            { base64: productImageBase64, mimeType: productImageMimeType }
          ],
          'gpt-5.2',
          { operation: 'ad_generation_mode1', projectId, signal: cancelSignal }
        );
      } else {
        prompt = await chatWithImage(
          conversationSoFar,
          imageRequestText_inner,
          inspirationBase64,
          inspiration.mimeType,
          'gpt-5.2',
          { operation: 'ad_generation_mode1', projectId, signal: cancelSignal }
        );
      }

      // Clean up temp file — no longer needed after GPT call
      cleanupImageData(inspiration);

      return prompt;
    }, `[Mode1 Ad ${adId.slice(0, 8)}]`);
    await assertAdNotCancelled(adId, cancelSignal);

    // Apply prompt guidelines if set (uses gpt-4.1-mini, not rate-limited)
    if (project.prompt_guidelines) {
      await assertAdNotCancelled(adId, cancelSignal);
      emitProgress(emit, adId, { status: 'generating_copy', message: 'Reviewing prompt against guidelines...', progress: 55 });
      imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
      await assertAdNotCancelled(adId, cancelSignal);
    }

    // Extract headline & body copy from GPT output (non-blocking, runs in parallel)
    const extractionPromise = extractHeadlineAndBody(imagePrompt);

    // Update record with GPT output
    await updateAdCreative(adId, {
      gpt_creative_output: imagePrompt,
      image_prompt: imagePrompt,
      status: 'generating_image',
    });
    await assertAdNotCancelled(adId, cancelSignal);

    // Save extracted headline/body (don't block image generation)
    extractionPromise.then(({ headline: extractedHeadline, body_copy: extractedBody }) => {
      if (extractedHeadline || extractedBody) {
        const updates = { externalId: adId };
        if (extractedHeadline && !headline) updates.headline = extractedHeadline;
        if (extractedBody && !bodyCopy) updates.body_copy = extractedBody;
        if (updates.headline || updates.body_copy) {
          const { externalId, ...fields } = updates;
          updateAdCreative(externalId, fields).catch(() => {});
        }
      }
    }).catch(() => {});

    // Generate image, save, upload to Drive (shared helper)
    const productImage = hasProductImage
      ? { base64: productImageBase64, mimeType: productImageMimeType }
      : null;
    const ad = await generateAndSaveImage({
      adId, projectId, project, imagePrompt, aspectRatio, angle,
      productImage, imageModel, renderReferenceImages,
      expectedHeadline: headline || null,
      expectedBodyCopy: bodyCopy || null,
      emit,
      cancelSignal
    });

    return ad;

  } catch (err) {
    if (isAdCancellationError(err, cancelSignal)) {
      await markAdCancelled(adId, emit, {
        image_attempts: serializeImageAttempts(err.imageAttempts),
      });
      return null;
    }
    // Mark as failed
    await updateAdCreative(adId, {
      status: 'failed',
      error_message: err.message,
      failure_stage: 'ad_generation',
      image_attempts: serializeImageAttempts(err.imageAttempts),
    });
    emitAdError(emit, err);
    throw err;
  } finally {
    stopHeartbeat();
  }
}

async function generateAndSaveImage({ adId, projectId, project, imagePrompt, aspectRatio, angle, productImage, imageModel, renderReferenceImages = [], expectedHeadline = null, expectedBodyCopy = null, emit, modeLabel = 'Mode1', cancelSignal = null }) {
  const modelLabel = imageModelLabel(imageModel);
  const imageGen = resolveImageProvider(imageModel);
  await assertAdNotCancelled(adId, cancelSignal);
  emitProgress(emit, adId, { status: 'generating_image', message: (productImage || renderReferenceImages.length > 0)
    ? `Generating image with ${modelLabel} (with product reference)...`
    : `Generating image with ${modelLabel}...`, progress: 70 });

  const { imageBuffer, mimeType: imgMime, imageAttempts } = await imageGen(imagePrompt, aspectRatio, productImage, {
    projectId, operation: 'ad_image_generation', imageModel, imageSize: '1K', cancelSignal,
  });
  await assertAdNotCancelled(adId, cancelSignal);

  emitProgress(emit, adId, { status: 'generating_image', message: 'Uploading image...', progress: 90 });

  // Upload image to Convex storage
  const storageId = await uploadBuffer(imageBuffer, imgMime);
  await assertAdNotCancelled(adId, cancelSignal);

  // Pre-generate thumbnail cache (fire-and-forget)
  precacheThumb(adId, imageBuffer);

  // Update final record
  await updateAdCreative(adId, {
    storageId,
    status: 'completed',
    error_message: null,
    failure_stage: null,
    image_attempts: serializeImageAttempts(imageAttempts),
  });

  // Return the completed ad record with direct CDN URL for fast loading
  const ad = await convexClient.query(api.adCreatives.getByExternalId, { externalId: adId });
  let resolvedUrl = null;
  try { resolvedUrl = await getAdImageUrl(adId); } catch {}

  const adRow = {
    id: ad.externalId,
    project_id: ad.project_id,
    generation_mode: ad.generation_mode,
    angle: ad.angle || null,
    headline: ad.headline || null,
    body_copy: ad.body_copy || null,
    image_prompt: ad.image_prompt || null,
    gpt_creative_output: ad.gpt_creative_output || null,
    storageId: ad.storageId || null,
    aspect_ratio: ad.aspect_ratio || '1:1',
    status: ad.status,
    updated_at: ad.updated_at || null,
    completed_at: ad.completed_at || null,
    image_attempts: ad.image_attempts || null,
    imageUrl: resolvedUrl || `/api/projects/${projectId}/ads/${adId}/image`,
    thumbnailUrl: `/api/projects/${projectId}/ads/${adId}/thumbnail`,
  };

  emit({ type: 'complete', ad: adRow });
  return adRow;
}

/**
 * Generate a single ad creative (Mode 2 — Template-Based).
 * Same GPT-5.2 creative director flow as Mode 1, but uses a user-uploaded
 * template image instead of a random inspiration folder image.
 *
 * @param {string} projectId
 * @param {object} options
 * @param {string} options.templateImageId - Template image ID to use
 * @param {string} [options.angle] - Optional angle/hook
 * @param {string} [options.aspectRatio='1:1'] - Aspect ratio
 * @param {string} [options.productImageBase64] - Base64-encoded product image
 * @param {string} [options.productImageMimeType] - MIME type of the product image
 * @param {string} [options.headline] - Optional headline text
 * @param {string} [options.bodyCopy] - Optional body copy text
 * @param {(event: object) => void} [options.onEvent] - SSE event callback
 * @returns {Promise<object>} The completed ad creative record
 */
export async function generateAdMode2(projectId, options = {}) {
  const { templateImageId, angle, aspectRatio = '1:1', imageModel, productImageBase64, productImageMimeType, headline, bodyCopy, onEvent, cancelSignal } = options;

  const emit = (event) => {
    if (onEvent) {
      try { onEvent(event); } catch {}
    }
  };

  if (!templateImageId) {
    throw new Error('A template image is required for Mode 2 generation.');
  }

  // Create ad record
  const adId = uuidv4();
  emit({ type: 'status', status: 'generating_copy', message: 'Loading project data...', progress: 2, adId });
  await createAdCreative({
    externalId: adId,
    project_id: projectId,
    generation_mode: 'mode2',
    angle: angle || undefined,
    headline: headline || undefined,
    body_copy: bodyCopy || undefined,
    aspect_ratio: aspectRatio,
    status: 'generating_copy',
    template_image_id: templateImageId,
    text_model: 'gpt-5.2',
    image_model: imageModel || 'nano-banana-2',
  });

  const stopHeartbeat = startAdHeartbeat(adId);
  try {
    await assertAdNotCancelled(adId, cancelSignal);

    // 1. Load project + foundational docs + template image (+ optional headline ref) in parallel
    const [project, research, avatar, offer_brief, necessary_beliefs, template] = await Promise.all([
      getProject(projectId),
      getLatestDoc(projectId, 'research'),
      getLatestDoc(projectId, 'avatar'),
      getLatestDoc(projectId, 'offer_brief'),
      getLatestDoc(projectId, 'necessary_beliefs'),
      selectTemplateImage(templateImageId),
    ]);
    if (!project) throw new Error('Project not found');
    assertProductDescription(project);
    await assertAdNotCancelled(adId, cancelSignal);

    const docs = { research, avatar, offer_brief, necessary_beliefs };

    const docCount = Object.values(docs).filter(d => d && d.content).length;
    if (docCount === 0) {
      throw new Error('No foundational documents found. Generate or upload documents first.');
    }

    // GPT-5.2 Messages 1-2: Rate-limited to prevent TPM overload
    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    let renderReferenceImages = [];

    let imagePrompt = await withHeavyLLMLimit(async () => {
      await assertAdNotCancelled(adId, cancelSignal);
      // Message 1: Creative director prompt + foundational docs
      emitProgress(emit, adId, { status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...', progress: 15 });

      const creativeDirectorPrompt_inner = buildCreativeDirectorPrompt(project, docs);
      const acknowledgment = await chat(
        [{ role: 'user', content: creativeDirectorPrompt_inner }],
        'gpt-5.2',
        { operation: 'ad_creative_director', projectId, signal: cancelSignal }
      );

      await assertAdNotCancelled(adId, cancelSignal);
      // Message 2: Template image + optional product image + instructions
      emitProgress(emit, adId, { status: 'generating_copy', message: hasProductImage
        ? 'GPT-5.2 analyzing template image + product image...'
        : 'GPT-5.2 analyzing template image...', progress: 35 });

      const imageRequestText_inner = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy, null, imageModel);
      const conversationSoFar = [
        { role: 'user', content: creativeDirectorPrompt_inner },
        { role: 'assistant', content: acknowledgment }
      ];

      const templateBase64 = readImageBase64(template);
      renderReferenceImages = [
        makeRenderReference(templateBase64, template.mimeType, 'layout'),
        hasProductImage ? makeRenderReference(productImageBase64, productImageMimeType, 'product') : null,
      ].filter(Boolean);

      let prompt;
      if (hasProductImage) {
        prompt = await chatWithImages(
          conversationSoFar,
          imageRequestText_inner,
          [
            { base64: templateBase64, mimeType: template.mimeType },
            { base64: productImageBase64, mimeType: productImageMimeType }
          ],
          'gpt-5.2',
          { operation: 'ad_generation_mode2', projectId, signal: cancelSignal }
        );
      } else {
        prompt = await chatWithImage(
          conversationSoFar,
          imageRequestText_inner,
          templateBase64,
          template.mimeType,
          'gpt-5.2',
          { operation: 'ad_generation_mode2', projectId, signal: cancelSignal }
        );
      }

      // Clean up temp file — no longer needed after GPT call
      cleanupImageData(template);

      return prompt;
    }, `[Mode2 Ad ${adId.slice(0, 8)}]`);
    await assertAdNotCancelled(adId, cancelSignal);

    // Apply prompt guidelines if set (uses gpt-4.1-mini, not rate-limited)
    if (project.prompt_guidelines) {
      await assertAdNotCancelled(adId, cancelSignal);
      emitProgress(emit, adId, { status: 'generating_copy', message: 'Reviewing prompt against guidelines...', progress: 55 });
      imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
      await assertAdNotCancelled(adId, cancelSignal);
    }

    // Extract headline & body copy from GPT output (non-blocking, runs in parallel)
    const extractionPromise = extractHeadlineAndBody(imagePrompt);

    // Update record with GPT output
    await updateAdCreative(adId, {
      gpt_creative_output: imagePrompt,
      image_prompt: imagePrompt,
      status: 'generating_image',
    });
    await assertAdNotCancelled(adId, cancelSignal);

    // Save extracted headline/body (don't block image generation)
    extractionPromise.then(({ headline: extractedHeadline, body_copy: extractedBody }) => {
      if (extractedHeadline || extractedBody) {
        const updates = { externalId: adId };
        if (extractedHeadline && !headline) updates.headline = extractedHeadline;
        if (extractedBody && !bodyCopy) updates.body_copy = extractedBody;
        if (updates.headline || updates.body_copy) {
          const { externalId, ...fields } = updates;
          updateAdCreative(externalId, fields).catch(() => {});
        }
      }
    }).catch(() => {});

    // Generate image, save, upload to Drive (shared helper)
    const productImage = hasProductImage
      ? { base64: productImageBase64, mimeType: productImageMimeType }
      : null;
    const ad = await generateAndSaveImage({
      adId, projectId, project, imagePrompt, aspectRatio, angle,
      productImage, imageModel, renderReferenceImages,
      expectedHeadline: headline || null,
      expectedBodyCopy: bodyCopy || null,
      emit, modeLabel: 'Mode2',
      cancelSignal
    });

    return ad;

  } catch (err) {
    if (isAdCancellationError(err, cancelSignal)) {
      await markAdCancelled(adId, emit, {
        image_attempts: serializeImageAttempts(err.imageAttempts),
      });
      return null;
    }
    await updateAdCreative(adId, {
      status: 'failed',
      error_message: err.message,
      failure_stage: 'ad_generation_mode2',
      image_attempts: serializeImageAttempts(err.imageAttempts),
    });
    emitAdError(emit, err);
    throw err;
  } finally {
    stopHeartbeat();
  }
}

/**
 * Regenerate an image using a user-provided prompt (skip GPT entirely).
 * Creates a new ad record linked to the parent ad.
 */
// =============================================
// 4-Stage Batch Pipeline Functions
// =============================================

/**
 * Attempt to repair malformed JSON from LLM responses.
 * Strips markdown code fences, fixes trailing commas, then parses.
 */
export function repairJSON(text) {
  if (!text || !text.trim()) throw new Error('Empty JSON response');
  let cleaned = text.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Fix trailing commas before } or ]
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

  return JSON.parse(cleaned);
}

/**
 * Extract a named section from the brief_packet markdown.
 * Returns the text between the section heading and the next ## heading (or end).
 */
function extractBriefSection(briefPacket, sectionName) {
  const regex = new RegExp(`## ${sectionName}[^\n]*\n([\\s\\S]*?)(?=\n## |$)`, 'i');
  const match = briefPacket.match(regex);
  return match ? match[1].trim() : '';
}

function compactPromptText(value, maxLength = 900) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function extractAvatarAudienceSnippet(source) {
  const text = typeof source === 'string'
    ? source
    : source?.avatar?.content || source?.avatarContent || source?.avatar || '';
  if (!text) return '';

  const briefAudience = extractBriefSection(text, 'AVATAR IN THIS MOMENT');
  if (briefAudience) return compactPromptText(briefAudience);

  const headingPatterns = [
    /(?:^|\n)#{1,3}\s*(?:Demographic & General Information|Demographics?|Target Audience|Avatar|Who They Are)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s+|$)/i,
    /(?:^|\n)(?:Demographic & General Information|Demographics?|Target Audience|Avatar|Who They Are)[^\n]*\n([\s\S]*?)(?=\n[A-Z][A-Z\s/&-]{8,}\n|$)/i,
  ];
  for (const pattern of headingPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return compactPromptText(match[1]);
  }

  return compactPromptText(text, 900);
}

export function getProjectAudienceContext(project = {}, foundationalDocs = null) {
  const brand = project?.brand_name || project?.name || 'the brand';
  const product = compactPromptText(project?.product_description || '', 500);
  const niche = compactPromptText(project?.niche || '', 160);
  const avatarSnippet = extractAvatarAudienceSnippet(foundationalDocs);

  const lines = [
    `Brand: ${brand}${niche ? ` (${niche})` : ''}.`,
    product ? `Offer: ${product}` : null,
    avatarSnippet
      ? `Audience from project docs: ${avatarSnippet}`
      : 'Audience from project docs: use only the audience, beliefs, pain points, and context provided in the project materials.',
    'Do not invent a default age range, demographic, product category, or niche that is not present in the project materials.',
  ].filter(Boolean);

  return lines.join('\n');
}

function isExplicitEcommerceProject(project = {}) {
  const haystack = [
    project?.niche,
    project?.category,
    project?.business_type,
    project?.product_type,
    project?.product_description,
  ].filter(Boolean).join(' ').toLowerCase();

  return /\b(ecommerce|e-commerce|dtc|direct-to-consumer|shopify|woocommerce|supplement|supplements|physical product|skincare|cosmetic|apparel|retail|consumer product|cpg)\b/.test(haystack);
}

export function getOfferRenderContext(project = {}, foundationalDocs = null) {
  const offer = compactPromptText(project?.product_description || '', 700);
  const audience = getProjectAudienceContext(project, foundationalDocs);
  const ecommerce = isExplicitEcommerceProject(project);

  if (ecommerce) {
    return [
      'Offer rendering mode: ecommerce / physical-product eligible because the project niche or offer explicitly indicates ecommerce, DTC, supplements, retail, or a physical consumer product.',
      offer ? `Offer being advertised: ${offer}` : null,
      'Visuals may show the actual item, packaging, shopping context, or a concrete product demonstration when it is truthful to the project materials.',
      'Still do not invent proof elements, reviewer names, review-score graphics, customer-volume claims, or specific statistics unless they are present in the project documentation.',
      audience,
    ].filter(Boolean).join('\n');
  }

  return [
    'Offer rendering mode: offer-agnostic / non-physical by default.',
    offer ? `Offer being advertised: ${offer}` : null,
    'Do not assume there is a physical item to photograph, hold, unbox, compare on a shelf, or place as the dominant visual.',
    'Build the visual around the prospect, the lived moment, the emotional tension, the setting, the promised clarity, or the next-step action described in the project materials.',
    'If a template has product-shaped space, adapt it into an offer-relevant visual anchor such as a webinar screen, calendar moment, notes, decision map, or real-world scene only when that fits the project context.',
    'Do not invent proof elements, reviewer names, review-score graphics, customer-volume claims, named testimonial signatures, or specific statistics unless they are present in the project documentation.',
    audience,
  ].join('\n');
}

export const HEADLINE_LANES = {
  symptom_recognition: "Open with a specific moment, sensation, or recognition from the prospect's lived experience.",
  oddly_specific_moment: 'Describe a hyper-specific moment, time, or sensation that feels uncannily real.',
  failed_solutions: "Lead with the things the prospect has already tried (advice they got, solutions they considered, paths they almost took) that didn't resolve the underlying tension.",
  consequence_led: 'Focus on the cost of leaving the problem unresolved.',
  skeptical_confession: 'Use the voice of someone who doubted it would work and admits that honestly.',
  objection_reversal: 'Name the objection directly, then flip it in a grounded way.',
  review_like: "Sound like a real first-person reflection or insight, in the voice of someone who's been through this experience. Do NOT fabricate named endorsements, review-score graphics, or invented reviewer credentials.",
  comparison: 'Compare against a familiar alternative, habit, or failed solution.',
  mechanism_curiosity: 'Create curiosity around how or why something works without fully explaining it.',
  identity_trust: 'Appeal to identity, values, trust, origin, or buyer-protection logic.',
};

export const FRAME_LANE_MAP = {
  'symptom-first': ['symptom_recognition', 'oddly_specific_moment', 'failed_solutions', 'consequence_led', 'skeptical_confession', 'mechanism_curiosity'],
  scam: ['skeptical_confession', 'objection_reversal', 'failed_solutions', 'comparison', 'review_like', 'mechanism_curiosity'],
  'objection-first': ['objection_reversal', 'skeptical_confession', 'comparison', 'review_like', 'identity_trust', 'mechanism_curiosity'],
  'identity-first': ['identity_trust', 'review_like', 'oddly_specific_moment', 'comparison', 'skeptical_confession', 'failed_solutions'],
  MAHA: ['identity_trust', 'comparison', 'objection_reversal', 'mechanism_curiosity', 'consequence_led', 'review_like'],
  'news-first': ['mechanism_curiosity', 'comparison', 'symptom_recognition', 'skeptical_confession', 'consequence_led', 'review_like'],
  'consequence-first': ['consequence_led', 'symptom_recognition', 'oddly_specific_moment', 'failed_solutions', 'skeptical_confession', 'mechanism_curiosity'],
};

export const DEFAULT_LANES = ['symptom_recognition', 'oddly_specific_moment', 'failed_solutions', 'skeptical_confession', 'mechanism_curiosity', 'review_like'];

const SCENE_LOCKED_FRAME_LANE_MAP = {
  'symptom-first': ['symptom_recognition', 'oddly_specific_moment', 'failed_solutions', 'mechanism_curiosity', 'consequence_led'],
};

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isSceneLockedAngle(angleBrief) {
  return !!(safeString(angleBrief?.scene) && safeString(angleBrief?.symptom_pattern));
}

function inferOpeningPattern(headline) {
  const raw = safeString(headline);
  const normalized = raw
    ? raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return 'statement';
  if (raw.endsWith('?')) return 'question_open';
  if (/^(i|my)\b/.test(normalized)) return 'first_person_open';
  if (/^(still|after|before|when|why|what|how)\b/.test(normalized)) return 'pattern_interrupt_open';
  if (/^\d/.test(normalized)) return 'number_open';
  if (/^(review|heres|here|try|tap|stop)\b/.test(normalized)) return 'directive_open';
  return 'statement_open';
}

function selectHeadlineLanes(angleBrief, count) {
  const sceneLocked = isSceneLockedAngle(angleBrief);
  const frame = angleBrief?.frame && FRAME_LANE_MAP[angleBrief.frame]
    ? angleBrief.frame
    : null;
  const lanePool = sceneLocked && frame && SCENE_LOCKED_FRAME_LANE_MAP[frame]
    ? SCENE_LOCKED_FRAME_LANE_MAP[frame]
    : frame
      ? FRAME_LANE_MAP[frame]
      : DEFAULT_LANES;
  const desiredLaneCount = Math.max(4, Math.min(6, count >= 24 ? 6 : count >= 16 ? 5 : 4));
  return lanePool.slice(0, desiredLaneCount);
}

function buildLaneAllocation(lanes, count) {
  const allocation = [];
  const base = Math.floor(count / Math.max(1, lanes.length));
  let remainder = count % Math.max(1, lanes.length);
  for (const lane of lanes) {
    allocation.push({
      lane,
      count: base + (remainder > 0 ? 1 : 0),
    });
    if (remainder > 0) remainder -= 1;
  }
  return allocation;
}

function formatPriorHeadlineHistory(priorHeadlines) {
  if (!Array.isArray(priorHeadlines) || priorHeadlines.length === 0) return '';
  const lines = priorHeadlines
    .slice(0, 30)
    .map((entry) => {
      const lane = entry.hook_lane ? ` | lane: ${entry.hook_lane}` : '';
      const claim = entry.core_claim ? ` | claim: ${entry.core_claim}` : '';
      const symptom = entry.target_symptom ? ` | symptom: ${entry.target_symptom}` : '';
      return `- "${entry.headline || entry.headline_text}"${lane}${claim}${symptom}`;
    })
    .join('\n');
  return `\n\nRECENT HEADLINES ALREADY USED FOR THIS ANGLE:\n${lines}\nDo NOT recycle these headline families, hook moves, or central claims.`;
}

function formatAngleAvoidList(angleBrief) {
  const raw = safeString(angleBrief?.avoid_list);
  if (!raw) return '';
  const items = raw
    .split(/\n|;|,/)
    .map((item) => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return items.length > 0 ? items.join('; ') : raw;
}

function buildAngleSpecificExampleBlock(angleBrief = null) {
  const frame = safeString(angleBrief?.frame);
  const scene = safeString(angleBrief?.scene);
  const symptom = safeString(angleBrief?.symptom_pattern);
  const objection = safeString(angleBrief?.objection);
  const coreBuyer = safeString(angleBrief?.core_buyer);
  const sceneExample = scene
    ? scene.split(/[.!?]/)[0].trim()
    : 'the exact lived moment from the angle';
  const symptomExample = symptom
    ? symptom.split(/[.!?]/)[0].trim()
    : 'the specific symptom or decision tension';
  const buyerExample = coreBuyer
    ? coreBuyer.split(/[.!?]/)[0].trim()
    : 'the exact buyer described in the angle';
  const rejected = frame === 'objection-first'
    ? ['Get Clarity Today', 'FINDING YOUR CALLING', 'Free Live Webinar']
    : ['Free Live Webinar', 'Get Clarity Today', 'FINDING YOUR CALLING'];

  const goodExamples = [
    scene ? `"${sceneExample.length > 72 ? sceneExample.slice(0, 69) + '...' : sceneExample}"` : `"${buyerExample.length > 72 ? buyerExample.slice(0, 69) + '...' : buyerExample}"`,
    symptom ? `"${symptomExample.length > 72 ? symptomExample.slice(0, 69) + '...' : symptomExample}"` : '"The exact doubt from this angle, stated plainly"',
    objection ? `"${objection.split(/[.!?]/)[0].trim().slice(0, 72)}"` : '"A concrete moment that only this angle would create"',
  ];

  return `\n\nANGLE-SIGNAL EXAMPLES:\nGOOD candidates must sound this concrete and angle-specific:\n- ${goodExamples.join('\n- ')}\n\nREJECT generic offer/category candidates like:\n- "${rejected.join('"\n- "')}"\nThese rejected lines are too broad unless the visible headline itself also contains angle-specific scene, symptom, buyer, or objection language.`;
}

/**
 * Stage 0: Brief Extraction — condenses 4 foundational docs into angle-specific ~1 page brief.
 * Runs once per batch. 1 API call.
 *
 * @param {object} project - Project record
 * @param {object} docs - { research, avatar, offer_brief, necessary_beliefs }
 * @param {string} angle - The advertising angle for this batch
 * @returns {string} brief_packet (markdown)
 */
// Brief extraction cache — keyed by projectId+angle, 24h TTL
const briefCache = new Map(); // key -> { brief, expiresAt }
const BRIEF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function extractBrief(project, docs, angle, angleBrief = null) {
  // Check cache first
  const cacheKey = `${project?.id || 'unknown'}::${angle || 'general'}`;
  const cached = briefCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[Pipeline Stage 0] Brief cache hit for "${(angle || 'general').slice(0, 40)}" (${cached.brief.length} chars)`);
    return cached.brief;
  }
  const researchContent = docs.research?.content || '[No research document available]';
  const avatarContent = docs.avatar?.content || '[No avatar sheet available]';
  const offerContent = docs.offer_brief?.content || '[No offer brief available]';
  const beliefsContent = docs.necessary_beliefs?.content || '[No necessary beliefs document available]';

  // Extract first paragraph of avatar sheet for target demographic summary
  const targetDemographic = avatarContent.split('\n\n')[0] || avatarContent.slice(0, 500);

  // Build angle context — structured brief when available, flat name otherwise
  let angleContext;
  if (angleBrief && (angleBrief.core_buyer || angleBrief.symptom_pattern || angleBrief.scene)) {
    const parts = [`ANGLE NAME: "${angle || angleBrief.name || 'general'}"`];
    if (angleBrief.frame) parts.push(`FRAME: ${angleBrief.frame}`);
    if (angleBrief.core_buyer) parts.push(`CORE BUYER: ${angleBrief.core_buyer}`);
    if (angleBrief.symptom_pattern) parts.push(`SYMPTOM PATTERN: ${angleBrief.symptom_pattern}`);
    if (angleBrief.failed_solutions) parts.push(`FAILED SOLUTIONS: ${angleBrief.failed_solutions}`);
    if (angleBrief.current_belief) parts.push(`CURRENT BELIEF: ${angleBrief.current_belief}`);
    if (angleBrief.objection) parts.push(`OBJECTION TO ADDRESS: ${angleBrief.objection}`);
    if (angleBrief.emotional_state) parts.push(`EMOTIONAL STATE: ${angleBrief.emotional_state}`);
    if (angleBrief.scene) parts.push(`SCENE TO CENTER THE AD ON: ${angleBrief.scene}`);
    if (angleBrief.desired_belief_shift) parts.push(`DESIRED BELIEF SHIFT: ${angleBrief.desired_belief_shift}`);
    angleContext = parts.join('\n');
  } else {
    angleContext = `THE ANGLE FOR THIS BATCH: "${angle || 'general'}"`;
  }

  const prompt = `You are a direct response research analyst. Your job is to extract the most relevant raw material from brand foundational documents for a specific advertising angle.

BRAND: ${project.brand_name || project.name}
OFFER: ${project.product_description || ''}
TARGET DEMOGRAPHIC: ${targetDemographic}

${angleContext}

I will provide you with four foundational documents. From these documents, extract ONLY the material directly relevant to this specific angle. Ignore everything else — do not try to be comprehensive.

Your output must contain exactly these sections:

## AVATAR IN THIS MOMENT
3-4 sentences describing who this person is specifically when they encounter an ad using this angle. What are they feeling right now? What would make them stop scrolling?

## RELEVANT PAIN POINTS (max 5)
Only the pain points from the research/avatar docs that this angle activates. Not all pain points — just the ones this angle touches.

## RELEVANT QUOTES FROM LANGUAGE BANK (max 8)
Exact raw quotes from the deep research doc's language bank that a copywriter would use for THIS angle. Emotional, specific phrases only.

## RELEVANT BELIEFS (max 3)
From the necessary beliefs document, which 3 beliefs are most critical for this angle?

## RELEVANT OBJECTIONS (max 4)
Which objections does this angle need to preempt or address?

## EMOTIONAL ENTRY POINT
One sentence: what is the single dominant emotion this angle enters through?

## SPECIFICITY ANCHORS (max 6)
Concrete details from the research that make ads feel real: specific times of night, body parts, failed solutions, social moments. Only ones relevant to this angle.

FOUNDATIONAL DOCUMENTS:

=== DEEP RESEARCH ===
${researchContent}

=== AVATAR SHEET ===
${avatarContent}

=== OFFER BRIEF ===
${offerContent}

=== NECESSARY BELIEFS ===
${beliefsContent}`;

  // Attempt with retry — fall back to raw docs if both attempts fail
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const briefPacket = await withHeavyLLMLimit(async () => {
        return await chat([{ role: 'user', content: prompt }], BATCH_TEXT_MODEL, {
          operation: 'batch_brief_extraction',
          projectId: project?.id || null,
        });
      }, `[Stage 0 Brief Extraction attempt ${attempt}]`);

      console.log(`[Pipeline Stage 0] Brief extracted (${briefPacket.length} chars) for angle: "${(angle || 'general').slice(0, 40)}"`);
      // Cache the result
      briefCache.set(cacheKey, { brief: briefPacket, expiresAt: Date.now() + BRIEF_CACHE_TTL_MS });
      return briefPacket;
    } catch (err) {
      console.error(`[Pipeline Stage 0] Attempt ${attempt}/2 failed:`, err.message);
      console.error(`[Pipeline Stage 0] Error status: ${err.status || 'none'}, type: ${err.type || 'none'}`);
      if (attempt === 2) {
        // Fallback: concatenate raw docs
        console.warn('[Pipeline Stage 0] Falling back to raw foundational docs');
        return `## AVATAR IN THIS MOMENT\n${targetDemographic}\n\n## RELEVANT PAIN POINTS\n(Full docs — brief extraction failed)\n\n## RELEVANT QUOTES FROM LANGUAGE BANK\n(See research document)\n\n## RELEVANT BELIEFS\n(See necessary beliefs document)\n\n## RELEVANT OBJECTIONS\n(See offer brief)\n\n## EMOTIONAL ENTRY POINT\n(Brief extraction failed — using full docs)\n\n## SPECIFICITY ANCHORS\n(See research document)\n\nFULL FOUNDATIONAL DOCUMENTS:\n\n${researchContent}\n\n${avatarContent}\n\n${offerContent}\n\n${beliefsContent}`;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

/**
 * Stage 1: Headline generation — creates a structured pool of headline candidates
 * distributed across fixed hook lanes, with recent angle history supplied as an avoid list.
 *
 * @param {object} project - Project record
 * @param {string} briefPacket - Output of Stage 0
 * @param {string} angle - The advertising angle
 * @param {number} count - Total number of candidates to generate
 * @param {object|null} angleBrief - Structured angle brief when available
 * @param {Array} priorHeadlines - Recent headline history for the same angle
 * @returns {{ lanes_used: Array, sub_angles: Array, headlines: Array }}
 */
export async function generateHeadlines(project, briefPacket, angle, count, angleBrief = null, priorHeadlines = []) {
  const avatarSection = extractBriefSection(briefPacket, 'AVATAR IN THIS MOMENT');
  const emotionalEntry = extractBriefSection(briefPacket, 'EMOTIONAL ENTRY POINT');
  const painPoints = extractBriefSection(briefPacket, 'RELEVANT PAIN POINTS');
  const quotes = extractBriefSection(briefPacket, 'RELEVANT QUOTES');
  const anchors = extractBriefSection(briefPacket, 'SPECIFICITY ANCHORS');
  const selectedLanes = selectHeadlineLanes(angleBrief, count);
  const laneAllocation = buildLaneAllocation(selectedLanes, count);
  const priorHeadlineBlock = formatPriorHeadlineHistory(priorHeadlines);
  const sceneLocked = isSceneLockedAngle(angleBrief);

  let structuredAngleBlock = '';
  if (angleBrief && (angleBrief.core_buyer || angleBrief.scene || angleBrief.objection)) {
    const parts = [];
    if (angleBrief.frame) parts.push(`FRAME: ${angleBrief.frame} — use this as the dominant structural lens.`);
    if (angleBrief.core_buyer) parts.push(`CORE BUYER: ${angleBrief.core_buyer}`);
    if (angleBrief.symptom_pattern) parts.push(`TARGET SYMPTOM PATTERN: ${angleBrief.symptom_pattern}`);
    if (angleBrief.scene) {
      parts.push(
        sceneLocked
          ? `SCENE: ${angleBrief.scene} — every accepted headline must stay anchored to this exact lived moment. Variation is allowed in framing, not in scene.`
          : `SCENE: ${angleBrief.scene} — center the headlines around this lived moment when useful.`
      );
    }
    if (angleBrief.objection) parts.push(`OBJECTION TO ADDRESS: ${angleBrief.objection}`);
    if (angleBrief.failed_solutions) parts.push(`FAILED SOLUTIONS: ${angleBrief.failed_solutions}`);
    if (angleBrief.current_belief) parts.push(`CURRENT BELIEF: ${angleBrief.current_belief}`);
    if (angleBrief.emotional_state) parts.push(`EMOTIONAL STATE: ${angleBrief.emotional_state}`);
    if (angleBrief.desired_belief_shift) parts.push(`DESIRED BELIEF SHIFT: ${angleBrief.desired_belief_shift} — headlines should move the reader toward this belief.`);
    if (angleBrief.tone) parts.push(`TONE: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`AVOID: ${angleBrief.avoid_list}`);
    structuredAngleBlock = '\n\nSTRUCTURED ANGLE BRIEF:\n' + parts.join('\n');
  }

  const laneInstructions = laneAllocation
    .map(({ lane, count: laneCount }) => `- ${lane}: generate exactly ${laneCount} headline${laneCount === 1 ? '' : 's'}\n  ${HEADLINE_LANES[lane]}`)
    .join('\n');
  const audienceContext = getProjectAudienceContext(project, briefPacket);
  const angleAvoidList = formatAngleAvoidList(angleBrief);
  const angleExampleBlock = buildAngleSpecificExampleBlock(angleBrief);

  const prompt = `You are a world-class direct response copywriter writing Facebook ad headlines for this specific project. Use the project materials below to understand who the audience is, what they want, and what would make them feel safe, understood, and intrigued before they engage.

PROJECT AUDIENCE CONTEXT:
${audienceContext}

Your job is NOT to produce loosely varied headlines. Your job is to produce a diverse headline set where each hook feels meaningfully different in persuasion style, emotional entry point, and central claim.

BRAND: ${project.brand_name || project.name}
OFFER: ${project.product_description || ''}

TARGET AUDIENCE IN THIS MOMENT:
${avatarSection || '(Not available)'}

THE ANGLE FOR THIS BATCH: "${angle || 'general'}"${structuredAngleBlock}

EMOTIONAL ENTRY POINT:
${emotionalEntry || '(Not available)'}

RELEVANT PAIN POINTS:
${painPoints || '(Not available)'}

LANGUAGE TO DRAW FROM (for tone and specificity — do not copy verbatim):
${quotes || '(Not available)'}

CONCRETE DETAILS TO WEAVE IN:
${anchors || '(Not available)'}${priorHeadlineBlock}

---

HEADLINE LANES TO USE FOR THIS BATCH:
${laneInstructions}

IMPORTANT DIVERSITY RULES:
- Write exactly ${count} headlines total.
- Every headline must belong to one of the allowed hook lanes above.
- NON-NEGOTIABLE COLD-SCROLL REQUIREMENT: every visible headline must make sense to a cold Facebook scroller in 1 second with no prior context. Every headline must include BOTH:
  1. An audience identifier: name who this is for in plain language from the project/angle context.
  2. An offer identifier: name what is being offered, sold, or invited to in plain language from the project/product description.
  Examples of audience identifiers: "Christians", "Christian counselors", "aspiring counselors", "parents", "coaches", "founders", or the actual niche audience from this project.
  Examples of offer identifiers: "free webinar", "course", "program", "consultation", "training", "assessment", "shop", or the actual offer from this project.
- NON-NEGOTIABLE ANGLE SIGNAL: every visible headline must also reflect at least one of the structured angle's core buyer language, scene fragment, symptom-pattern moment, objection, current belief, desired belief shift, or frame-style hook. The headline cannot be only an audience + offer label; it must carry the angle's specific reason to care.
- Both rules apply to every headline: audience + offer identifier AND angle-specific signal. If a headline lacks either one, rewrite it before returning JSON.
- EXAMPLES:
  Bad: "Free Live Webinar" — names an offer but no audience and no angle signal.
  Bad: "Get Clarity Today" — no audience, no offer, no angle signal.
  Better: "Christians Considering Counseling? Free Webinar Maps Your Options" — audience + offer + decision-clarity angle.
  Better: "Parents Comparing Teen Therapy Options? Free Assessment Helps" — audience + offer + comparison angle.
- ${angleAvoidList ? `Do not produce headlines that read like: ${angleAvoidList}.` : 'Do not produce generic promise headlines that could fit any webinar, course, product, or brand.'}
- No two headlines may share the same hook lane AND the same core claim.
- No two headlines may start with the same opening phrase.
- Do not recycle the same persuasion move with slightly different wording.
- ${sceneLocked
    ? `Every headline must stay unmistakably about this exact scene: ${angleBrief.scene}. Variation is allowed in framing, but the lived moment must remain explicit.`
    : `The angle "${angle || 'general'}" is a strategic lens, not the headline text itself.`}
- Headlines must be short. Maximum 12 words. Under 8 words is ideal when it still feels natural.
- Avoid hype cliches, fake authority, miracle language, and anything that sounds like generic ad copy.
- ${sceneLocked
    ? 'For consequence-led headlines, the consequence must still be tied directly to the same scene and prospect tension.'
    : 'Consequences can widen the frame as long as the line still feels specific and grounded.'}

KEEP A SECONDARY "SUB-ANGLE" LABEL:
- For each headline, include a short sub_angle label that captures the micro-angle or speaker perspective for that exact line.
- This is a secondary variation layer inside the hook lane. Keep it short and concrete.
${angleExampleBlock}

STRUCTURED METADATA REQUIREMENTS:
- hook_lane: one of the allowed lanes above
- scene_anchor: short phrase naming the exact lived moment this headline is about
- core_claim: short phrase describing the central promise, problem, or idea
- target_symptom: the specific symptom or moment this headline is speaking to
- emotional_entry: the dominant emotional doorway for this line
- desired_belief_shift: the belief this line is trying to move the reader toward
- opening_pattern: classify the opening as one of these:
  direct_symptom | specific_moment | failed_solution | confession | objection_flip | review_statement | comparison | mechanism_hint | trust_signal | question_open | statement_open

SCORING:
After writing the headlines, score each one on:
- scroll_stop
- specificity
- uniqueness
- real_human

UNIQUENESS MUST PENALIZE:
- same hook lane + same core claim as another line
- same opening pattern with nearly the same meaning
- recycling ideas from the recent headline history above

Return ONLY valid JSON:
{
  "angle": "${angle || 'general'}",
  "lanes_used": ["symptom_recognition", "oddly_specific_moment"],
  "headlines": [
    {
      "rank": 1,
      "headline": "the headline text",
      "hook_lane": "symptom_recognition",
      "sub_angle": "decision clarity",
      "scene_anchor": "stuck comparing options and unsure what to choose",
      "core_claim": "the right next step can become clear",
      "target_symptom": "uncertainty about choosing the wrong path",
      "emotional_entry": "recognition",
      "desired_belief_shift": "I can make a wise decision with clearer information",
      "opening_pattern": "direct_symptom",
      "primary_emotion": "recognition",
      "word_count": 8,
      "scores": {
        "scroll_stop": 9,
        "specificity": 8,
        "uniqueness": 9,
        "real_human": 8
      },
      "average_score": 8.5
    }
  ]
}`;

  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await withHeavyLLMLimit(async () => {
        return await chat(
          [{
            role: 'user',
            content: attempt > 1
              ? prompt + `\n\nIMPORTANT: Your previous attempt did not succeed. Generate exactly ${count} headlines, use only the allowed lanes, and return valid JSON.`
              : prompt
          }],
          BATCH_TEXT_MODEL,
          {
            response_format: { type: 'json_object' },
            operation: 'batch_headline_generation',
            projectId: project?.id || null,
          }
        );
      }, `[Stage 1 Headlines attempt ${attempt}]`);

      let result;
      try {
        result = JSON.parse(response);
      } catch {
        result = repairJSON(response);
      }

      if (!result.headlines || !Array.isArray(result.headlines)) {
        throw new Error('Response missing headlines array');
      }

      const allowedLanes = new Set(selectedLanes);
      result.headlines = result.headlines
        .map((headline, index) => {
          const hookLane = allowedLanes.has(headline.hook_lane)
            ? headline.hook_lane
            : selectedLanes[index % selectedLanes.length];
          const primaryEmotion = headline.primary_emotion || headline.emotional_entry || 'curiosity';
          const emotionalEntryValue = headline.emotional_entry || primaryEmotion;
          return {
            rank: Number(headline.rank) || index + 1,
            headline: safeString(headline.headline),
            hook_lane: hookLane,
            sub_angle: safeString(headline.sub_angle) || hookLane,
            scene_anchor: safeString(headline.scene_anchor) || safeString(headline.target_symptom) || safeString(angleBrief?.scene),
            core_claim: safeString(headline.core_claim),
            target_symptom: safeString(headline.target_symptom),
            emotional_entry: safeString(emotionalEntryValue) || 'curiosity',
            desired_belief_shift: safeString(headline.desired_belief_shift) || angleBrief?.desired_belief_shift || '',
            opening_pattern: safeString(headline.opening_pattern) || inferOpeningPattern(headline.headline),
            primary_emotion: safeString(primaryEmotion) || 'curiosity',
            word_count: Number(headline.word_count) || safeString(headline.headline).split(/\s+/).filter(Boolean).length,
            scores: headline.scores && typeof headline.scores === 'object' ? headline.scores : {},
            average_score: Number(headline.average_score) || 0,
          };
        })
        .filter((headline) => headline.headline);

      result.headlines.sort((a, b) => {
        const scoreDiff = (b.average_score || 0) - (a.average_score || 0);
        if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
        return (a.rank || 999) - (b.rank || 999);
      });

      const uniqueSubAngles = Array.from(
        new Map(
          result.headlines.map((headline) => [
            `${headline.hook_lane}:${headline.sub_angle}`,
            {
              id: `${headline.hook_lane}:${headline.sub_angle}`,
              name: headline.sub_angle,
              hook_lane: headline.hook_lane,
              emotional_entry: headline.emotional_entry,
            }
          ])
        ).values()
      );

      result.sub_angles = Array.isArray(result.sub_angles) && result.sub_angles.length > 0
        ? result.sub_angles
        : uniqueSubAngles;
      result.lanes_used = Array.isArray(result.lanes_used) && result.lanes_used.length > 0
        ? result.lanes_used.filter((lane) => allowedLanes.has(lane))
        : selectedLanes;

      lastResult = result;
      console.log(`[Pipeline Stage 1] Generated ${result.headlines.length} structured headline candidates across ${result.lanes_used.length} lanes for angle: "${(angle || 'general').slice(0, 40)}"`);

      if (attempt < 3 && result.headlines.length < count) {
        console.warn(`[Pipeline Stage 1] Got ${result.headlines.length}/${count} headlines, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      return result;
    } catch (err) {
      lastError = err;
      console.error(`[Pipeline Stage 1] Attempt ${attempt}/3 failed:`, err.message);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
      }
    }
  }

  if (lastResult && lastResult.headlines && lastResult.headlines.length > 0) {
    console.warn(`[Pipeline Stage 1] Returning partial results: ${lastResult.headlines.length} headlines`);
    return lastResult;
  }

  // Build a self-diagnosing error: most actionable info first (so 50-char inline truncation still surfaces it).
  // Fields below use defensive existence checks — both Anthropic and OpenAI SDK shapes are handled.
  const status = lastError?.status ?? lastError?.statusCode ?? null;
  const errorType = lastError?.error?.type ?? lastError?.type ?? null;
  const errorCode = lastError?.error?.code ?? lastError?.code ?? null;
  const baseMessage = lastError?.message ?? 'unknown error';

  let leadingDiagnostic;
  if (status === 401 || errorType === 'authentication_error' || errorCode === 'invalid_api_key') {
    leadingDiagnostic = 'LLM auth error (401)';
  } else if (status === 429 || errorType === 'rate_limit_error' || errorCode === 'rate_limit_exceeded') {
    leadingDiagnostic = 'LLM rate-limited (429)';
  } else if (status === 404 || errorType === 'not_found_error') {
    leadingDiagnostic = 'LLM model not found (404)';
  } else if (errorCode === 'content_policy_violation' || errorCode === 'content_filter') {
    leadingDiagnostic = 'OpenAI content policy rejected the prompt — try rephrasing';
  } else if (typeof status === 'number' && status >= 500) {
    leadingDiagnostic = `LLM server error (${status})`;
  } else if (errorType) {
    leadingDiagnostic = `LLM ${errorType}`;
  } else {
    leadingDiagnostic = 'Headline generation failed';
  }

  const partialCount = lastResult?.headlines?.length || 0;
  const full = `[Stage 1] ${leadingDiagnostic} after 3 attempts. ${baseMessage}; partial: ${partialCount} headlines`;
  const message = full.length > 480 ? full.slice(0, 477) + '...' : full;

  throw new Error(message);
}

/**
 * Stage 2: Body Copy Generation — writes body copy in batches of 5 headlines.
 * Multiple API calls (N/5).
 *
 * @param {object} project - Project record
 * @param {string} briefPacket - Output of Stage 0
 * @param {Array} headlines - Array of headline objects from Stage 1
 * @returns {Array} Array of { headline, body_copy, structure, word_count, specific_detail_used, closing_cta, primary_emotion }
 */
export async function generateBodyCopies(project, briefPacket, headlines, angleBrief = null) {
  const quotes = extractBriefSection(briefPacket, 'RELEVANT QUOTES');
  const anchors = extractBriefSection(briefPacket, 'SPECIFICITY ANCHORS');
  const beliefs = extractBriefSection(briefPacket, 'RELEVANT BELIEFS');
  const audienceContext = getProjectAudienceContext(project, briefPacket);

  // Build tone/avoid directives from structured brief
  let briefToneBlock = '';
  if (angleBrief) {
    const parts = [];
    if (angleBrief.tone) parts.push(`TONE DIRECTIVE FROM ANGLE BRIEF: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`AVOID (from angle brief): ${angleBrief.avoid_list}`);
    if (angleBrief.emotional_state) parts.push(`READER'S EMOTIONAL STATE: ${angleBrief.emotional_state}`);
    if (angleBrief.failed_solutions) parts.push(`FAILED SOLUTIONS TO REFERENCE: ${angleBrief.failed_solutions}`);
    if (angleBrief.desired_belief_shift) parts.push(`BELIEF SHIFT GOAL: ${angleBrief.desired_belief_shift}`);
    if (parts.length > 0) briefToneBlock = '\n\n' + parts.join('\n');
  }

  const allCopies = [];

  const attachHeadlineMetadata = (copy, matchingHeadline) => ({
    ...copy,
    primary_emotion: matchingHeadline?.primary_emotion || 'curiosity',
    sub_angle: matchingHeadline?.sub_angle || null,
    hook_lane: matchingHeadline?.hook_lane || null,
    scene_anchor: matchingHeadline?.scene_anchor || null,
    core_claim: matchingHeadline?.core_claim || null,
    target_symptom: matchingHeadline?.target_symptom || null,
    emotional_entry: matchingHeadline?.emotional_entry || matchingHeadline?.primary_emotion || null,
    desired_belief_shift: matchingHeadline?.desired_belief_shift || null,
    opening_pattern: matchingHeadline?.opening_pattern || null,
  });

  // Process in batches of 5
  for (let i = 0; i < headlines.length; i += 5) {
    const batch = headlines.slice(i, i + 5);
    const batchNum = Math.floor(i / 5) + 1;
    const totalBatches = Math.ceil(headlines.length / 5);

    const headlineList = batch.map((headlineObj, idx) => {
      const metadata = [
        headlineObj.hook_lane ? `lane: ${headlineObj.hook_lane}` : null,
        headlineObj.sub_angle ? `sub-angle: ${headlineObj.sub_angle}` : null,
        headlineObj.scene_anchor ? `scene anchor: ${headlineObj.scene_anchor}` : null,
        headlineObj.core_claim ? `core claim: ${headlineObj.core_claim}` : null,
        headlineObj.target_symptom ? `symptom: ${headlineObj.target_symptom}` : null,
        headlineObj.emotional_entry ? `emotional entry: ${headlineObj.emotional_entry}` : null,
        headlineObj.desired_belief_shift ? `belief shift: ${headlineObj.desired_belief_shift}` : null,
      ].filter(Boolean).join(' | ');
      return `${idx + 1}. "${headlineObj.headline}"${metadata ? `\n   ${metadata}` : ''}`;
    }).join('\n');

    const prompt = `You are a direct response creative strategist writing compact creative context for image generation. This is NOT final Facebook primary text and should NOT be rendered verbatim inside the image. Final Meta primary texts are written later after images pass QA.

Write for the audience described in this project, using the offer, avatar, and research context below. Your context is warm, specific, honest, and sounds like a real person — not a brand.

PROJECT AUDIENCE CONTEXT:
${audienceContext}

BRAND: ${project.brand_name || project.name}
OFFER: ${project.product_description || ''}

TONE RULES:
- Never use hype language or miracle framing
- Lead with relief, not claims
- Show skepticism openly — don't fight it
- Emphasize safety and reversibility
- Sound like a trusted friend who found something that helped, not a salesperson${briefToneBlock}

REFERENCE MATERIAL (use for specificity and emotional tone — do not copy verbatim):
${quotes || '(Not available)'}
${anchors || '(Not available)'}

BELIEFS TO ACTIVATE (weave in naturally, never state as bullet points):
${beliefs || '(Not available)'}

---

For each headline below, write one compact creative context block that explains the buyer moment, emotional pivot, and offer bridge the image prompt should understand.

RULES FOR EVERY CREATIVE CONTEXT:

1. ANCHOR TO THE HEADLINE. Your first sentence must continue the emotional thread the headline started. Do not restart. Do not introduce a new idea. Do not repeat the headline. If the headline opens a loop, partially close it — enough to satisfy, not enough to remove the need to click.
1a. THE FIRST SENTENCE MUST MAKE IMMEDIATE SENSE. Maximum 12 words. Do NOT start with weak continuations like "Because", "So", "And", "Honestly", a character name, or generic exposition.

2. MAXIMUM 45 WORDS. This is image-generation context, not Meta primary text.

3. INCLUDE ONE SPECIFIC, CONCRETE DETAIL from the project materials: a setting, question, decision point, failed solution, objection, exact phrase, or life moment. Generic improvement claims do NOT count as specific.

4. DO NOT REPEAT THE HEADLINE TEXT in the context.

5. DO NOT FORCE A CTA. Include an offer bridge only if it helps the visual concept. The template text contract will decide how much copy appears on the image.

6. NONE of these phrases: "game-changer", "revolutionize", "transform your life", "the ultimate solution", "miracle", "breakthrough discovery", "you won't believe what happened next"

7. DO NOT fabricate testimonials, reviewer names, review-score graphics, customer-volume claims, or specific statistics. Only use proof that appears in the project materials.

---

HEADLINES TO WRITE CREATIVE CONTEXT FOR:

${headlineList}

For each headline, write ONE creative context block. Vary the structural approach across the five:
- At least 1 should use STORY CONTINUATION (extend the narrative voice of the headline)
- At least 1 should use PROBLEM-AGITATE (hit the pain with specific detail, then pivot to the offer)
- At least 1 should use PEER REFLECTION (sound like a grounded first-person realization without inventing a named testimonial, age, credential, or specific result)
- The remaining can use whichever approach fits the headline best

OUTPUT FORMAT — respond as JSON only:

{
  "body_copies": [
    {
      "headline": "...",
      "body_copy": "compact creative context for image generation, not final Meta primary text",
      "structure": "story_continuation | problem_agitate | peer_reflection",
      "word_count": 42,
      "specific_detail_used": "specific lived detail from the project materials",
      "closing_cta": null
    }
  ]
}`;

    // Retry each batch up to 2 times
    let batchSuccess = false;
    for (let attempt = 1; attempt <= 2 && !batchSuccess; attempt++) {
      try {
        const response = await withHeavyLLMLimit(async () => {
          return await chat(
            [{ role: 'user', content: prompt }],
            BATCH_TEXT_MODEL,
            {
              response_format: { type: 'json_object' },
              operation: 'batch_body_copy',
              projectId: project?.id || null,
            }
          );
        }, `[Stage 2 Body Copy batch ${batchNum}/${totalBatches} attempt ${attempt}]`);

        let result;
        try {
          result = JSON.parse(response);
        } catch {
          result = repairJSON(response);
        }

        if (!result.body_copies || !Array.isArray(result.body_copies)) {
          throw new Error('Response missing body_copies array');
        }

        let normalizedCopies = result.body_copies.map((copy) => {
          const matchingHeadline = batch.find(h => h.headline === copy.headline);
          return attachHeadlineMetadata(copy, matchingHeadline);
        });

        const weakLeadInRe = /^(because|so|and|honestly|same|most|she\b|he\b|they\b|the\s+(routine|room|dog|light|water|problem)|it's not\b|carol\b|linda\b)/i;
        const splitSentences = (text) => String(text || '')
          .split(/(?<=[.!?])\s+/)
          .map((part) => part.trim())
          .filter(Boolean);
        const detectRepairReasons = (copy) => {
          const sentences = splitSentences(copy.body_copy);
          const firstSentence = sentences[0] || '';
          const reasons = [];
          if (!firstSentence || weakLeadInRe.test(firstSentence) || firstSentence.split(/\s+/).filter(Boolean).length > 14) {
            reasons.push('first_line_hook');
          }
          if (sentences.join(' ').split(/\s+/).filter(Boolean).length > 55) {
            reasons.push('too_long_for_image_context');
          }
          return reasons;
        };

        const flaggedCopies = normalizedCopies
          .map((copy) => ({ copy, reasons: detectRepairReasons(copy) }))
          .filter((entry) => entry.reasons.length > 0);

        if (flaggedCopies.length > 0) {
          const flaggedList = flaggedCopies.map((entry, idx) => {
            const reasons = entry.reasons.join(', ');
            return `${idx + 1}. HEADLINE: "${entry.copy.headline}"\nCURRENT BODY COPY: "${entry.copy.body_copy}"\nFAILED REQUIREMENTS: ${reasons}`;
          }).join('\n\n');

          const repairPrompt = `You are repairing compact creative context for image generation. This is NOT final Facebook primary text and should NOT be rendered verbatim inside the image.

REPAIR RULES:
- Keep the same headline, same overall angle, and same emotional promise.
- Rewrite ONLY the creative context in body_copy.
- The first sentence must be clear and standalone. No weak lead-ins like "Because", "So", "Honestly", names, or generic exposition.
- Maximum 45 words.
- Keep one concrete detail.
- Do not repeat the headline verbatim.
- Do not force a CTA.

HEADLINES TO REPAIR:

${flaggedList}

Return JSON only:
{
  "body_copies": [
    {
      "headline": "...",
      "body_copy": "compact creative context for image generation",
      "structure": "story_continuation | problem_agitate | social_proof",
      "word_count": 42,
      "specific_detail_used": "2-4am wakeups",
      "closing_cta": null
    }
  ]
}`;

          try {
            const repairResponse = await withHeavyLLMLimit(async () => {
              return await chat(
                [{ role: 'user', content: repairPrompt }],
                BATCH_TEXT_MODEL,
                {
                  response_format: { type: 'json_object' },
                  operation: 'batch_body_copy_repair',
                  projectId: project?.id || null,
                }
              );
            }, `[Stage 2 Body Copy repair batch ${batchNum}/${totalBatches}]`);

            let repairResult;
            try {
              repairResult = JSON.parse(repairResponse);
            } catch {
              repairResult = repairJSON(repairResponse);
            }

            if (repairResult?.body_copies && Array.isArray(repairResult.body_copies)) {
              const repairedByHeadline = new Map(
                repairResult.body_copies.map((copy) => {
                  const matchingHeadline = batch.find(h => h.headline === copy.headline);
                  return [copy.headline, attachHeadlineMetadata(copy, matchingHeadline)];
                })
              );
              normalizedCopies = normalizedCopies.map((copy) => repairedByHeadline.get(copy.headline) || copy);
            }
          } catch (repairErr) {
            console.warn(`[Pipeline Stage 2] Repair pass skipped for batch ${batchNum}: ${repairErr.message}`);
          }
        }

        allCopies.push(...normalizedCopies);
        batchSuccess = true;
        console.log(`[Pipeline Stage 2] Body copy batch ${batchNum}/${totalBatches}: ${normalizedCopies.length} copies generated`);

      } catch (err) {
        console.error(`[Pipeline Stage 2] Batch ${batchNum} attempt ${attempt} failed:`, err.message);
        if (attempt === 2) {
          console.warn(`[Pipeline Stage 2] Skipping batch ${batchNum} (${batch.length} headlines lost)`);
        } else {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    // Small delay between batches
    if (i + 5 < headlines.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`[Pipeline Stage 2] Total body copies generated: ${allCopies.length}/${headlines.length}`);
  return allCopies;
}

/**
 * Stage 3: Image Prompt Generation — generates image prompt for a single ad with locked copy.
 * Runs once per ad. Uses vision API with template image.
 *
 * @param {object} project - Project record
 * @param {string} headline - Locked headline text
 * @param {string} bodyCopy - Locked body copy text
 * @param {string} primaryEmotion - Primary emotion from Stage 1
 * @param {{ base64: string, mimeType: string }} imageData - Template image data
 * @param {string} aspectRatio - User-selected aspect ratio
 * @param {object|null} headlineMeta - Selected headline metadata carried through the pipeline
 * @returns {string} Image generation prompt
 */
export async function generateImagePrompt(project, headline, bodyCopy, primaryEmotion, imageData, aspectRatio, angleBrief = null, headlineMeta = null, options = {}) {
  const documentaryMode = !!options.documentaryMode;
  const repairNotes = Array.isArray(options.repairNotes) ? options.repairNotes.filter(Boolean) : [];
  const audienceContext = getProjectAudienceContext(project, options.audienceContextSource || null);
  const offerRenderContext = getOfferRenderContext(project, options.audienceContextSource || null);
  // Build visual direction from structured angle brief
  let visualDirectionBlock = '';
  if (angleBrief && (angleBrief.scene || angleBrief.frame || angleBrief.tone)) {
    const parts = [];
    if (angleBrief.scene) parts.push(`SCENE/SETTING: ${angleBrief.scene} — the visual should evoke this moment`);
    if (angleBrief.frame) parts.push(`AD FRAME: ${angleBrief.frame} — inform the visual treatment accordingly`);
    if (angleBrief.core_buyer) parts.push(`CORE BUYER: ${angleBrief.core_buyer} — the person in the image should feel like this prospect`);
    if (angleBrief.emotional_state) parts.push(`EMOTIONAL STATE TO CONVEY: ${angleBrief.emotional_state}`);
    if (angleBrief.tone) parts.push(`TONE: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`VISUAL ELEMENTS TO AVOID: ${angleBrief.avoid_list}`);
    visualDirectionBlock = '\n\nSTRUCTURED VISUAL DIRECTION:\n' + parts.join('\n') + '\n';
  }

  let headlineStrategyBlock = '';
  if (headlineMeta && (headlineMeta.hook_lane || headlineMeta.scene_anchor || headlineMeta.core_claim || headlineMeta.target_symptom || headlineMeta.desired_belief_shift)) {
    const parts = [];
    if (headlineMeta.hook_lane) parts.push(`HOOK LANE: ${headlineMeta.hook_lane}`);
    if (headlineMeta.sub_angle) parts.push(`SUB-ANGLE: ${headlineMeta.sub_angle}`);
    if (headlineMeta.scene_anchor) parts.push(`SCENE ANCHOR: ${headlineMeta.scene_anchor}`);
    if (headlineMeta.core_claim) parts.push(`CORE CLAIM: ${headlineMeta.core_claim}`);
    if (headlineMeta.target_symptom) parts.push(`TARGET SYMPTOM: ${headlineMeta.target_symptom}`);
    if (headlineMeta.emotional_entry) parts.push(`EMOTIONAL ENTRY: ${headlineMeta.emotional_entry}`);
    if (headlineMeta.desired_belief_shift) parts.push(`DESIRED BELIEF SHIFT: ${headlineMeta.desired_belief_shift}`);
    if (headlineMeta.opening_pattern) parts.push(`OPENING PATTERN: ${headlineMeta.opening_pattern}`);
    headlineStrategyBlock = '\nHEADLINE STRATEGY:\n' + parts.join('\n') + '\n';
  }

  const promptText = documentaryMode
    ? `You are a creative director generating documentary-style image prompts for Meta ads tailored to this project's audience.

PROJECT AUDIENCE CONTEXT:
${audienceContext}

OFFER RENDERING CONTEXT:
${offerRenderContext}

BRAND: ${project.brand_name || project.name}
OFFER CONTEXT: ${project.product_description || ''}

ASPECT RATIO: ${aspectRatio || '1:1'}

THE APPROVED AD COPY (USE FOR MEANING ONLY — DO NOT RENDER ANY TEXT IN THE IMAGE):
HEADLINE: "${headline}"
BODY COPY: "${bodyCopy}"

PRIMARY EMOTION OF THIS AD: ${primaryEmotion || 'curiosity'}
${headlineStrategyBlock}
${visualDirectionBlock}
${repairNotes.length > 0 ? `REPAIR NOTES:\n${repairNotes.map((note) => `- ${note}`).join('\n')}\n` : ''}
REFERENCE IMAGE:
(If attached, use it only for lighting, realism, and general mood. Do NOT copy its layout, text treatment, product framing, or branding.)

---

Generate an image prompt that:

1. Creates a pure documentary/lifestyle scene that visually expresses the headline and body copy without rendering any words.
2. Centers the human moment, symptom pattern, and emotional state from the angle brief.
3. Shows a realistic person, setting, or context that matches the project audience and the scene called for by the angle.
4. Uses lighting, expression, posture, camera distance, and composition to communicate the exact frustration or relief in the copy.
5. Prioritizes realism, intimacy, and specificity over polished ad-design aesthetics.
6. Uses the specified aspect ratio: ${aspectRatio || '1:1'}

CRITICAL NEGATIVES:
- NO text overlays
- NO logos, badges, bullets, testimonial cards, review-score graphics, comparison layouts, before/after panels, mockups, coupons, or ad-template framing
- NO physical item visible unless the project documentation explicitly describes a physical item
- NO flat-lay item photography
- NO branded footer or brand mark
- NO split-screen or infographic composition
- NO fabricated proof elements, reviewer names, customer-volume claims, named testimonial signatures, or invented statistics

Treat the approved copy as semantic direction only. The output should be a photorealistic visual scene, not a designed ad layout.`
    : `You are a creative director generating prompts for text-to-image AI software. You create Facebook ad visuals tailored to this project's specific offer, audience, and brand context.

PROJECT AUDIENCE CONTEXT:
${audienceContext}

OFFER RENDERING CONTEXT:
${offerRenderContext}

BRAND: ${project.brand_name || project.name}
OFFER CONTEXT: ${project.product_description || ''}

ASPECT RATIO: ${aspectRatio || '1:1'}

THE APPROVED AD COPY (DO NOT MODIFY — render exactly as written):
HEADLINE: "${headline}"
BODY COPY: "${bodyCopy}"

PRIMARY EMOTION OF THIS AD: ${primaryEmotion || 'curiosity'}
${headlineStrategyBlock}
${visualDirectionBlock}
${repairNotes.length > 0 ? `REPAIR NOTES:\n${repairNotes.map((note) => `- ${note}`).join('\n')}\n` : ''}
TEMPLATE TO MATCH:
(See attached image — analyze its visual structure, layout, color palette, typography, and composition)

---

Analyze the template's visual structure:
- Layout (where text sits, where the main visual anchor sits, visual hierarchy)
- Color palette and mood
- Typography style (serif vs sans-serif, weight, contrast)
- Use of callouts, decorative frames, or secondary text zones
- Overall composition and whitespace

Generate an image prompt that:

1. Recreates the template's layout and composition style — adapted for ${project.brand_name || project.name}
2. Adapts any product-shaped or hero-visual area into an offer-relevant visual anchor. For non-physical offers, use the prospect's lived scene, decision context, webinar setting, notes, calendar, screen, or other truthful context from the project materials instead of inventing a physical item.
3. Places the EXACT headline text in the primary/dominant text position matching the template's hierarchy
4. Places a key supporting line from the body copy (or the closing CTA) in the secondary text position if the template has one
5. Places the brand name (${project.brand_name || project.name}) in a subtle position (footer, corner) matching the template
6. Supports the emotional tone of the headline — the visual mood (colors, lighting, texture, casting, composition) should reinforce what the headline makes the reader feel and what belief shift it is trying to create. Skepticism angles get editorial/news-style treatments. Pain point angles get warm, empathetic tones. Relief angles get bright, calm aesthetics.
7. Uses the specified aspect ratio: ${aspectRatio || '1:1'}
8. Avoids generic stock photo aesthetics — aim for authentic, warm, realistic direct-response ad quality that resonates with the documented audience
9. Prioritizes scroll-stopping contrast, clean hierarchy, and offer-relevant design
10. Does not instruct the renderer to include fabricated proof elements, reviewer names, review-score graphics, customer-volume claims, named testimonial signatures, or invented statistics. If the project documentation contains real testimonials or proof, those can be referenced; otherwise omit proof elements.

CRITICAL: The headline and body copy are FINAL. Do not rewrite, shorten, improve, or paraphrase them. Your job is visual execution only. Render the text exactly as provided.

Output the image generation prompt as a single text block ready to paste into the image generation tool.`;

  const imagePrompt = await withHeavyLLMLimit(async () => {
    if (imageData) {
      const imageBase64 = readImageBase64(imageData);
      return await chatWithImage(
        [],
        promptText,
        imageBase64,
        imageData.mimeType,
        BATCH_VISION_MODEL,
        { operation: 'batch_image_prompt', projectId: project?.id || null }
      );
    }
    return await chat(
      [{ role: 'user', content: promptText }],
      BATCH_TEXT_MODEL,
      { operation: 'batch_image_prompt', projectId: project?.id || null }
    );
  }, `[Stage 3 Image Prompt]`);

  return imagePrompt;
}

function normalizeTemplateTextZone(zone, index) {
  if (!zone || typeof zone !== 'object') return null;
  const role = String(zone.role || zone.type || `zone_${index + 1}`).trim().toLowerCase();
  const density = String(zone.density || zone.copy_length || '').trim().toLowerCase();
  const maxWords = Number(zone.max_words ?? zone.approx_words ?? zone.words);
  return {
    role: role || `zone_${index + 1}`,
    required: zone.required !== false,
    approximate_words: Number.isFinite(maxWords) && maxWords > 0 ? Math.min(350, Math.round(maxWords)) : null,
    density: density || null,
    visual_role: zone.visual_role || zone.hierarchy || null,
    notes: zone.notes || zone.description || null,
  };
}

function normalizeTemplateTextContract(raw = {}, { documentaryMode = false } = {}) {
  if (documentaryMode) {
    return {
      text_density: 'none',
      rendered_text_expectation: 'none',
      zones: [],
      template_summary: 'Documentary/lifestyle creative with no rendered copy.',
      copy_guidance: 'Do not render words on the image.',
    };
  }

  const density = String(raw.text_density || raw.visual_text_density || raw.density || 'medium').trim().toLowerCase();
  const expectation = String(raw.rendered_text_expectation || raw.copy_expectation || 'template_matched').trim().toLowerCase();
  const zones = Array.isArray(raw.zones)
    ? raw.zones.map(normalizeTemplateTextZone).filter(Boolean).slice(0, 8)
    : [];

  return {
    text_density: ['none', 'minimal', 'short', 'medium', 'long', 'heavy'].includes(density) ? density : 'medium',
    rendered_text_expectation: ['none', 'not_required', 'template_matched', 'rendered'].includes(expectation)
      ? expectation
      : 'template_matched',
    zones: zones.length > 0 ? zones : [
      { role: 'headline', required: true, approximate_words: 8, density: 'short', visual_role: 'primary', notes: 'Main visible hook.' },
      { role: 'supporting_text', required: false, approximate_words: 18, density: 'medium', visual_role: 'secondary', notes: 'Only if the template has secondary text space.' },
    ],
    template_summary: raw.template_summary || raw.summary || 'Template-style ad with visible copy areas.',
    copy_guidance: raw.copy_guidance || raw.guidance || 'Match the template text density and hierarchy. Do not force a full primary-text paragraph.',
  };
}

export async function analyzeTemplateTextContract(project, imageData, aspectRatio, options = {}) {
  const documentaryMode = !!options.documentaryMode;
  if (documentaryMode || !imageData) {
    return normalizeTemplateTextContract({}, { documentaryMode });
  }

  const prompt = `Analyze this ad template/reference image only for how much visible text it expects.

Return ONLY valid JSON with this shape:
{
  "text_density": "none|minimal|short|medium|long|heavy",
  "rendered_text_expectation": "none|template_matched|rendered",
  "template_summary": "one sentence about the layout and text hierarchy",
  "copy_guidance": "how future generated ads should match this template's text density",
  "zones": [
    {
      "role": "headline|subhead|body|badge|cta|testimonial|caption|other",
      "required": true,
      "approx_words": 8,
      "density": "short|medium|long",
      "hierarchy": "primary|secondary|small",
      "notes": "where it appears / how it behaves"
    }
  ]
}

Rules:
- Do not judge whether the text in this template is good copy.
- Estimate text zones from the image layout. If the template has no visible ad text, return text_density "none" and zones [].
- If it has a long paragraph/testimonial block, mark that zone as long/heavy. Long copy is allowed only when the template visibly supports it.
- Aspect ratio for the generated ad: ${aspectRatio || '1:1'}.
- Brand/offer context: ${project?.brand_name || project?.name || 'Unknown brand'} / ${project?.product_description || 'unknown offer'}.`;

  try {
    const imageBase64 = readImageBase64(imageData);
    const result = await chatWithImage(
      [],
      prompt,
      imageBase64,
      imageData.mimeType,
      BATCH_VISION_MODEL,
      { operation: 'template_text_contract', projectId: project?.id || null }
    );
    return normalizeTemplateTextContract(repairJSON(result), { documentaryMode });
  } catch (err) {
    console.warn('[AdGenerator] Template text contract analysis failed, using fallback:', err.message);
    return normalizeTemplateTextContract({}, { documentaryMode });
  }
}

function normalizePromptPackage(item, index, templateTextContract) {
  if (typeof item === 'string') {
    return {
      prompt: item,
      visual_copy_plan: null,
      rendered_text_expectation: templateTextContract.rendered_text_expectation,
      visual_text_density: templateTextContract.text_density,
      template_text_contract: templateTextContract,
    };
  }
  if (!item || typeof item !== 'object') return null;
  const prompt = item.prompt || item.image_prompt || item.generation_prompt;
  if (!prompt || typeof prompt !== 'string') return null;
  return {
    prompt,
    visual_copy_plan: item.visual_copy_plan || item.visualCopyPlan || null,
    rendered_text_expectation: item.rendered_text_expectation || templateTextContract.rendered_text_expectation,
    visual_text_density: item.visual_text_density || templateTextContract.text_density,
    template_text_contract: item.template_text_contract || templateTextContract,
    index,
  };
}

/**
 * Stage 3 (batched): Generate image prompts for multiple ads in a single LLM call.
 * Groups 2-3 ads per call to reduce API costs (~45% fewer calls).
 *
 * @param {object} project - Project record
 * @param {Array<{headline, body_copy, primary_emotion, headlineMeta}>} ads - Ad copy specs
 * @param {{ base64: string, mimeType: string }|null} imageData - Shared template image
 * @param {string} aspectRatio - Aspect ratio
 * @param {object|null} angleBrief - Angle brief for visual direction
 * @param {object} options - { documentaryMode }
 * @returns {Array<{prompt: string, visual_copy_plan?: object, template_text_contract?: object}>} Prompt packages
 */
export async function generateImagePromptsBatch(project, ads, imageData, aspectRatio, angleBrief = null, options = {}) {
  const documentaryMode = !!options.documentaryMode;
  const audienceContext = getProjectAudienceContext(project, options.audienceContextSource || null);
  const offerRenderContext = getOfferRenderContext(project, options.audienceContextSource || null);
  const templateTextContract = options.templateTextContract
    ? normalizeTemplateTextContract(options.templateTextContract, { documentaryMode })
    : await analyzeTemplateTextContract(project, imageData, aspectRatio, { documentaryMode });

  // Build shared visual direction block
  let visualDirectionBlock = '';
  if (angleBrief && (angleBrief.scene || angleBrief.frame || angleBrief.tone)) {
    const parts = [];
    if (angleBrief.scene) parts.push(`SCENE/SETTING: ${angleBrief.scene}`);
    if (angleBrief.frame) parts.push(`AD FRAME: ${angleBrief.frame}`);
    if (angleBrief.core_buyer) parts.push(`CORE BUYER: ${angleBrief.core_buyer}`);
    if (angleBrief.emotional_state) parts.push(`EMOTIONAL STATE TO CONVEY: ${angleBrief.emotional_state}`);
    if (angleBrief.tone) parts.push(`TONE: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`VISUAL ELEMENTS TO AVOID: ${angleBrief.avoid_list}`);
    visualDirectionBlock = '\nSTRUCTURED VISUAL DIRECTION:\n' + parts.join('\n') + '\n';
  }

  // Build per-ad spec blocks
  const adSpecs = ads.map((ad, i) => {
    const meta = ad.headlineMeta || {};
    let strategyBlock = '';
    if (meta.hook_lane || meta.scene_anchor || meta.core_claim) {
      const parts = [];
      if (meta.hook_lane) parts.push(`HOOK LANE: ${meta.hook_lane}`);
      if (meta.sub_angle) parts.push(`SUB-ANGLE: ${meta.sub_angle}`);
      if (meta.scene_anchor) parts.push(`SCENE ANCHOR: ${meta.scene_anchor}`);
      if (meta.core_claim) parts.push(`CORE CLAIM: ${meta.core_claim}`);
      if (meta.target_symptom) parts.push(`TARGET SYMPTOM: ${meta.target_symptom}`);
      if (meta.emotional_entry) parts.push(`EMOTIONAL ENTRY: ${meta.emotional_entry}`);
      if (meta.desired_belief_shift) parts.push(`DESIRED BELIEF SHIFT: ${meta.desired_belief_shift}`);
      strategyBlock = '\n' + parts.join('\n');
    }
    return `--- AD ${i + 1} ---
HEADLINE: "${ad.headline}"
META PRIMARY TEXT CONTEXT (do not render verbatim unless the template contract has a long body/testimonial zone): "${ad.body_copy}"
PRIMARY EMOTION: ${ad.primary_emotion || 'curiosity'}${strategyBlock}`;
  }).join('\n\n');

  const modeInstruction = documentaryMode
    ? `You are a creative director generating documentary-style image prompts for Meta ads tailored to this project's audience.
Generate pure documentary/lifestyle scenes that visually express each ad's copy without rendering any words.
CRITICAL NEGATIVES: NO text overlays, NO logos, NO physical item unless the project documentation demands it, NO ad-template framing.`
    : `You are a creative director generating prompts for text-to-image AI software. You create Facebook ad visuals tailored to this project's specific offer, audience, and brand context.
${imageData ? 'Analyze the attached template image for layout, color palette, typography, and composition. Each prompt should recreate this style.' : ''}
Each prompt must follow the TEMPLATE TEXT CONTRACT below. Generate the on-image copy needed for the template's visible text zones. Do not render the full Meta primary-text paragraph inside the image unless the template contract explicitly contains a long body/testimonial zone.`;

  const promptText = `${modeInstruction}

PROJECT AUDIENCE CONTEXT:
${audienceContext}

OFFER RENDERING CONTEXT:
${offerRenderContext}

BRAND: ${project.brand_name || project.name}
OFFER: ${project.product_description || ''}
ASPECT RATIO: ${aspectRatio || '1:1'}
${visualDirectionBlock}

TEMPLATE TEXT CONTRACT:
${JSON.stringify(templateTextContract, null, 2)}

FABRICATED-PROOF RULE:
Do not instruct the renderer to include fabricated proof elements, reviewer names, review-score graphics, customer-volume claims, named testimonial signatures, or invented statistics. If the project documentation contains real testimonials or proof, those can be referenced; otherwise omit proof elements.

I need you to generate ${ads.length} SEPARATE image prompts — one for each ad below. Each prompt must be tailored to its specific headline, body copy, and emotion.

${adSpecs}

Return a JSON object with a "prompts" array containing exactly ${ads.length} objects, one per ad in order:
{
  "prompts": [
    {
      "prompt": "complete standalone image generation prompt for ad 1",
      "visual_copy_plan": {
        "headline": "exact on-image headline if the template has a headline zone, otherwise null",
        "supporting_text": "on-image supporting text if the template has that zone, otherwise null",
        "badge": "badge/label text if applicable, otherwise null",
        "cta": "CTA text if the template has a CTA zone, otherwise null",
        "notes": "one sentence explaining how text density matches the template"
      },
      "rendered_text_expectation": "${templateTextContract.rendered_text_expectation}",
      "visual_text_density": "${templateTextContract.text_density}"
    }
  ]
}

Each prompt should be complete and standalone. The visual copy should be modeled after the attached template: if the template is text-heavy, text-heavy is okay; if it is sparse, keep it sparse; if it has no visible copy, do not force rendered words.`;

  const result = await withHeavyLLMLimit(async () => {
    if (imageData) {
      const imageBase64 = readImageBase64(imageData);
      return await chatWithImage(
        [],
        promptText,
        imageBase64,
        imageData.mimeType,
        BATCH_VISION_MODEL,
        { operation: 'batch_image_prompt', projectId: project?.id || null }
      );
    }
    return await chat(
      [{ role: 'user', content: promptText }],
      BATCH_TEXT_MODEL,
      { operation: 'batch_image_prompt', projectId: project?.id || null }
    );
  }, `[Stage 3 Image Prompt Batch x${ads.length}]`);

  // Parse JSON response
  try {
    const parsed = JSON.parse(result);
    if (parsed.prompts && Array.isArray(parsed.prompts) && parsed.prompts.length === ads.length) {
      return parsed.prompts
        .map((item, index) => normalizePromptPackage(item, index, templateTextContract))
        .filter(Boolean);
    }
  } catch {}

  // Fallback: try to extract JSON from response
  try {
    const match = result.match(/\{[\s\S]*"prompts"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.prompts && Array.isArray(parsed.prompts) && parsed.prompts.length === ads.length) {
        return parsed.prompts
          .map((item, index) => normalizePromptPackage(item, index, templateTextContract))
          .filter(Boolean);
      }
    }
  } catch {}

  // Last resort: fall back to single-prompt calls
  console.warn(`[Stage 3] Batch parse failed for ${ads.length} ads, falling back to individual calls`);
  const fallbackPrompts = [];
  for (const ad of ads) {
    const prompt = await generateImagePrompt(
      project, ad.headline, ad.body_copy, ad.primary_emotion,
      imageData, aspectRatio, angleBrief, ad.headlineMeta, options
    );
    fallbackPrompts.push(normalizePromptPackage(prompt, fallbackPrompts.length, templateTextContract));
  }
  return fallbackPrompts;
}

export async function repairBodyCopy(project, options = {}) {
  const {
    headline,
    bodyCopy,
    angleBrief = null,
    failedReasons = [],
    weaknesses = [],
    maxWords = 90,
  } = options;

  if (!headline) {
    throw new Error('Headline is required for body copy repair.');
  }
  const audienceContext = getProjectAudienceContext(project, options.audienceContextSource || null);

  const toneBits = [];
  if (angleBrief?.tone) toneBits.push(`TONE: ${angleBrief.tone}`);
  if (angleBrief?.failed_solutions) toneBits.push(`FAILED SOLUTIONS TO REFERENCE: ${angleBrief.failed_solutions}`);
  if (angleBrief?.desired_belief_shift) toneBits.push(`BELIEF SHIFT: ${angleBrief.desired_belief_shift}`);
  if (angleBrief?.emotional_state) toneBits.push(`EMOTIONAL STATE: ${angleBrief.emotional_state}`);

  const repairIssues = [...failedReasons, ...weaknesses].filter(Boolean).slice(0, 6);
  const prompt = `You are repairing Facebook ad primary text so it passes a strict creative filter.

BRAND: ${project?.brand_name || project?.name || 'Unknown brand'}
HEADLINE: "${headline}"
CURRENT BODY COPY: "${bodyCopy || ''}"
PROJECT AUDIENCE CONTEXT:
${audienceContext}
${toneBits.length > 0 ? `\nANGLE CONTEXT:\n${toneBits.join('\n')}` : ''}

WHY THIS COPY FAILED:
${repairIssues.length > 0 ? repairIssues.map((item) => `- ${item}`).join('\n') : '- Weak hook and/or weak CTA'}

REPAIR RULES:
- Keep the same headline, same angle, and same promise.
- Rewrite ONLY the body copy.
- The first sentence must be a standalone hook on its own. No weak lead-ins like "Because", "So", "And", "Honestly", names, or generic exposition.
- Keep the copy under ${maxWords} words.
- Include at least one concrete detail.
- The final sentence must be an explicit CTA using an action verb such as See, Read, Tap, Click, Learn, Find out, Watch, or Discover.
- Do not repeat the headline verbatim.
- Sound like a warm, credible direct-response ad for the documented audience.

Return JSON only:
{
  "body_copy": "...",
  "structure": "story_continuation | problem_agitate | social_proof",
  "word_count": 78,
  "specific_detail_used": "2:43 AM wakeup",
  "closing_cta": "the final CTA sentence"
}`;

  const response = await withHeavyLLMLimit(async () => {
    return await chat(
      [{ role: 'user', content: prompt }],
      BATCH_TEXT_MODEL,
      {
        response_format: { type: 'json_object' },
        operation: 'batch_body_copy_repair',
        projectId: project?.id || null,
      }
    );
  }, '[Stage 2 Body Copy targeted repair]');

  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch {
    parsed = repairJSON(response);
  }

  if (!parsed?.body_copy) {
    throw new Error('Body copy repair returned no body_copy.');
  }

  return {
    body_copy: parsed.body_copy,
    structure: parsed.structure || null,
    word_count: Number(parsed.word_count) || String(parsed.body_copy).split(/\s+/).filter(Boolean).length,
    specific_detail_used: parsed.specific_detail_used || null,
    closing_cta: parsed.closing_cta || null,
  };
}

export async function regenerateImageOnly(projectId, options = {}) {
  const {
    imagePrompt,
    aspectRatio = '1:1',
    imageModel,
    parentAdId,
    productImageBase64,
    productImageMimeType,
    referenceImageBase64,
    referenceImageMimeType,
    angle,
    angleName,
    headline,
    bodyCopy,
    onEvent,
    scoringMode,
    copyRenderExpectation,
    productExpectation,
    hookLane,
    coreClaim,
    targetSymptom,
    emotionalEntry,
    desiredBeliefShift,
    openingPattern,
    subAngle,
    templateImageId,
    inspirationImageId,
    cancelSignal,
  } = options;

  const emit = (event) => {
    if (onEvent) {
      try { onEvent(event); } catch {}
    }
  };

  if (!imagePrompt || !imagePrompt.trim()) {
    throw new Error('Image prompt is required for image-only regeneration.');
  }

  // Create new ad record
  const adId = uuidv4();
  await createAdCreative({
    externalId: adId,
    project_id: projectId,
    generation_mode: 'image_only',
    angle: angle || undefined,
    angle_name: angleName || undefined,
    headline: headline || undefined,
    body_copy: bodyCopy || undefined,
    hook_lane: hookLane || undefined,
    core_claim: coreClaim || undefined,
    target_symptom: targetSymptom || undefined,
    emotional_entry: emotionalEntry || undefined,
    desired_belief_shift: desiredBeliefShift || undefined,
    opening_pattern: openingPattern || undefined,
    sub_angle: subAngle || undefined,
    scoring_mode: scoringMode || undefined,
    copy_render_expectation: copyRenderExpectation || undefined,
    product_expectation: productExpectation || undefined,
    template_image_id: templateImageId || undefined,
    inspiration_image_id: inspirationImageId || undefined,
    aspect_ratio: aspectRatio,
    status: 'generating_image',
    image_prompt: imagePrompt.trim(),
    gpt_creative_output: imagePrompt.trim(),
    parent_ad_id: parentAdId || undefined,
    image_model: imageModel || 'nano-banana-2',
  });

  emit({ type: 'status', status: 'generating_image', message: 'Preparing image generation...', progress: 5, adId });

  const stopHeartbeat = startAdHeartbeat(adId);
  try {
    await assertAdNotCancelled(adId, cancelSignal);
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');
    assertProductDescription(project);
    await assertAdNotCancelled(adId, cancelSignal);

    // Apply prompt guidelines if set
    let finalPrompt = imagePrompt.trim();
    if (project.prompt_guidelines) {
      await assertAdNotCancelled(adId, cancelSignal);
      emitProgress(emit, adId, { status: 'generating_image', message: 'Reviewing prompt against guidelines...', progress: 20 });
      finalPrompt = await reviewPromptWithGuidelines(finalPrompt, project.prompt_guidelines);
      await assertAdNotCancelled(adId, cancelSignal);
      // Update the stored prompt if it changed
      if (finalPrompt !== imagePrompt.trim()) {
        await updateAdCreative(adId, {
          image_prompt: finalPrompt,
          gpt_creative_output: finalPrompt,
        });
      }
    }

    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    const productImage = hasProductImage
      ? { base64: productImageBase64, mimeType: productImageMimeType }
      : null;
    const hasReferenceImage = !!(referenceImageBase64 && referenceImageMimeType);
    const renderReferenceImages = [
      hasReferenceImage ? makeRenderReference(referenceImageBase64, referenceImageMimeType, 'layout') : null,
      hasProductImage ? makeRenderReference(productImageBase64, productImageMimeType, 'product') : null,
    ].filter(Boolean);

    const ad = await generateAndSaveImage({
      adId, projectId, project,
      imagePrompt: finalPrompt,
      aspectRatio, angle, productImage, imageModel, renderReferenceImages,
      expectedHeadline: headline || null,
      expectedBodyCopy: bodyCopy || null,
      emit,
      modeLabel: 'Regen',
      cancelSignal
    });

    return ad;

  } catch (err) {
    if (isAdCancellationError(err, cancelSignal)) {
      await markAdCancelled(adId, emit, {
        image_attempts: serializeImageAttempts(err.imageAttempts),
      });
      return null;
    }
    await updateAdCreative(adId, {
      status: 'failed',
      error_message: err.message,
      failure_stage: 'image_regeneration',
      image_attempts: serializeImageAttempts(err.imageAttempts),
    });
    emitAdError(emit, err);
    throw err;
  } finally {
    stopHeartbeat();
  }
}

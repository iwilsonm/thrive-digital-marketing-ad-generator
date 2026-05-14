import OpenAI, { toFile } from 'openai';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';
import { logOpenAIImageCost } from './costTracker.js';

const OPENAI_BILLING_URL = 'https://platform.openai.com/account/billing';
const OPENAI_IMAGE_ATTEMPT_TIMEOUT_MS = 180 * 1000;
const OPENAI_IMAGE_MAX_ATTEMPTS = 2;
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_QUALITY = 'medium';
const DEFAULT_FORMAT = 'jpeg';
const MAX_REFERENCE_IMAGES = 10;

let client = null;
let lastApiKey = null;

export async function getClient() {
  const apiKey = await getSetting('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API key not configured. Set it in Settings.');
  if (!client || lastApiKey !== apiKey) {
    client = new OpenAI({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

function collectProviderErrorMessages(value, seen = new Set()) {
  if (!value || seen.has(value)) return [];
  if (typeof value === 'string') return [value];
  if (value instanceof Error) {
    seen.add(value);
    return [
      value.message,
      ...collectProviderErrorMessages(value.error, seen),
      ...collectProviderErrorMessages(value.response, seen),
      ...collectProviderErrorMessages(value.cause, seen),
    ].filter(Boolean);
  }
  if (typeof value !== 'object') return [];
  seen.add(value);
  const messages = [];
  if (typeof value.message === 'string') messages.push(value.message);
  if (value.error) messages.push(...collectProviderErrorMessages(value.error, seen));
  if (value.response) messages.push(...collectProviderErrorMessages(value.response, seen));
  if (value.cause) messages.push(...collectProviderErrorMessages(value.cause, seen));
  if (Array.isArray(value.details)) messages.push(...value.details.flatMap(detail => collectProviderErrorMessages(detail, seen)));
  return messages;
}

function getProviderErrorText(err) {
  return collectProviderErrorMessages(err).join(' ');
}

function isOpenAIBillingError(err, providerErrorText = getProviderErrorText(err)) {
  const code = err?.code || err?.error?.code;
  const type = err?.type || err?.error?.type;
  const text = providerErrorText.toLowerCase();
  return code === 'billing_hard_limit_reached'
    || type === 'insufficient_quota'
    || code === 'insufficient_quota'
    || text.includes('insufficient_quota')
    || text.includes('billing_hard_limit_reached')
    || text.includes('billing')
    || text.includes('maximum monthly spend')
    || text.includes('hard limit')
    || text.includes('exceeded your current quota');
}

function buildOpenAIImageBillingError(model) {
  const err = new Error(`OpenAI account has zero usable quota for ${model}. Top up billing at ${OPENAI_BILLING_URL} or rotate to a key with usable quota.`);
  err.code = 'BILLING_EXHAUSTED';
  err.provider = 'OpenAI';
  err.model = model;
  err.userActionable = true;
  err.actionUrl = OPENAI_BILLING_URL;
  err.actionLabel = 'OpenAI billing';
  return err;
}

function shouldRetryOpenAIImage(err, model) {
  if (isOpenAIBillingError(err)) {
    console.warn(`[OpenAI Billing] Account quota exhausted, failing fast — model: ${model}`);
    err.model = model;
    return false;
  }
  const status = err?.status || err?.statusCode || err?.httpCode || err?.response?.status;
  if (status === 429 || status >= 500) return true;
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'];
  if (err?.code && networkCodes.includes(err.code)) return true;
  if (/fetch|network|socket|ECONNRESET|ETIMEDOUT/i.test(err?.message || '')) return true;
  return false;
}

function withAttemptTimeout(fn, timeoutMs, cancelSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, timeoutMs);
  const signal = cancelSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([cancelSignal, controller.signal])
    : controller.signal;
  return fn(signal).finally(() => clearTimeout(timeout));
}

function mapAspectRatioToSize(aspectRatio) {
  switch (aspectRatio) {
    case '1:1': return '1024x1024';
    case '4:5': return '1024x1280';
    case '9:16': return '864x1536';
    case '16:9': return '1536x864';
    default:
      if (aspectRatio) console.warn(`[OpenAI Image] Unknown aspect ratio "${aspectRatio}"; defaulting to 1024x1024.`);
      return '1024x1024';
  }
}

function sanitizeAttemptMessage(message) {
  return String(message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function classifyOpenAIImageError(err, timedOut = false) {
  if (timedOut || err?.name === 'AbortError') return 'timeout';
  if (isOpenAIBillingError(err)) return 'billing_exhausted';
  const status = err?.status || err?.statusCode || err?.httpCode || err?.response?.status;
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_unavailable';
  if (status >= 400) return 'api_error';
  if (/fetch|network|socket|ECONNRESET|ETIMEDOUT/i.test(err?.message || '')) return 'fetch_failed';
  return 'unknown';
}

function attachImageAttempts(err, imageAttempts) {
  err.imageAttempts = imageAttempts;
  return err;
}

function normalizeProductImages(productImage) {
  if (!productImage) return [];
  const images = Array.isArray(productImage) ? productImage : [productImage];
  const filtered = images.filter(img => img?.base64);
  if (filtered.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Image generation supports up to ${MAX_REFERENCE_IMAGES} reference images. Remove ${filtered.length - MAX_REFERENCE_IMAGES} image${filtered.length - MAX_REFERENCE_IMAGES === 1 ? '' : 's'} and try again.`);
  }
  return filtered;
}

async function buildImageFile(productImage, index = 0) {
  if (!productImage?.base64) return null;
  const mimeType = productImage.mimeType || 'image/png';
  const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
  return toFile(Buffer.from(productImage.base64, 'base64'), `reference-${index + 1}.${extension}`, { type: mimeType });
}

export function getOpenAIImageSize(aspectRatio = '1:1') {
  return mapAspectRatioToSize(aspectRatio);
}

export async function generateImage(prompt, aspectRatio = '1:1', productImage = null, options = {}) {
  const {
    projectId = null,
    operation = 'image_generation',
    quality = DEFAULT_QUALITY,
    cancelSignal = null,
  } = options;
  const model = DEFAULT_MODEL;
  const openai = await getClient();
  const imageAttempts = [];
  const size = mapAspectRatioToSize(aspectRatio || '1:1');
  const resolvedQuality = quality === 'low' ? 'low' : DEFAULT_QUALITY;
  const productImages = normalizeProductImages(productImage);

  try {
    const response = await withRetry(
      async () => {
        const attemptNumber = imageAttempts.length + 1;
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        let timedOut = false;
        try {
          const result = await withAttemptTimeout(async (signal) => {
            const requestOptions = signal ? { signal } : undefined;
            if (productImages.length > 0) {
              const image = await Promise.all(productImages.map((img, index) => buildImageFile(img, index)));
              return openai.images.edit({
                model,
                image,
                prompt,
                size,
                quality: resolvedQuality,
                output_format: DEFAULT_FORMAT,
              }, requestOptions);
            }
            return openai.images.generate({
              model,
              prompt,
              n: 1,
              size,
              quality: resolvedQuality,
              output_format: DEFAULT_FORMAT,
            }, requestOptions);
          }, OPENAI_IMAGE_ATTEMPT_TIMEOUT_MS, cancelSignal);
          const base64 = result?.data?.[0]?.b64_json;
          if (!base64) {
            const err = new Error('OpenAI image generation returned no image data.');
            err.code = 'OPENAI_IMAGE_NO_IMAGE_RETURNED';
            throw err;
          }
          imageAttempts.push({
            attempt_number: attemptNumber,
            started_at: startedAt,
            ended_at: new Date().toISOString(),
            duration_ms: Math.max(0, Date.now() - startedMs),
            error_class: 'success',
            error_message: null,
            queue_depth_at_start: null,
          });
          return result;
        } catch (err) {
          timedOut = err?.name === 'AbortError';
          const errorClass = classifyOpenAIImageError(err, timedOut);
          imageAttempts.push({
            attempt_number: attemptNumber,
            started_at: startedAt,
            ended_at: new Date().toISOString(),
            duration_ms: Math.max(0, Date.now() - startedMs),
            error_class: errorClass,
            error_message: sanitizeAttemptMessage(err?.message || errorClass),
            queue_depth_at_start: null,
          });
          if (errorClass === 'billing_exhausted') err.openaiImageErrorClass = 'billing_exhausted';
          throw err;
        }
      },
      {
        label: `[OpenAI Image ${model}]`,
        maxRetries: OPENAI_IMAGE_MAX_ATTEMPTS - 1,
        shouldRetry: (err) => shouldRetryOpenAIImage(err, model),
        baseDelayMs: 2000,
      }
    );

    const imageBuffer = Buffer.from(response.data[0].b64_json, 'base64');
    const mimeType = DEFAULT_FORMAT === 'jpeg' ? 'image/jpeg' : 'image/png';
    logOpenAIImageCost({
      projectId,
      operation,
      model,
      usage: response.usage,
      size,
      quality: resolvedQuality,
    }).catch(() => {});
    return { imageBuffer, mimeType, textResponse: '', imageAttempts, usage: response.usage };
  } catch (err) {
    if (err.openaiImageErrorClass === 'billing_exhausted' || isOpenAIBillingError(err)) {
      throw attachImageAttempts(buildOpenAIImageBillingError(model), imageAttempts);
    }
    throw attachImageAttempts(err, imageAttempts);
  }
}

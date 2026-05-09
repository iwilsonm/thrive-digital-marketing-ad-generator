import { GoogleGenAI } from '@google/genai';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';
import { withGeminiLimit } from './rateLimiter.js';
import { logGeminiCost } from './costTracker.js';

let client = null;
let lastApiKey = null;
const GEMINI_IMAGE_ATTEMPT_TIMEOUT_MS = 180 * 1000;
const GEMINI_IMAGE_MAX_ATTEMPTS = 2;
const NO_IMAGE_MESSAGE = "Gemini returned a response without an image. This usually means the prompt was refused or hit a content filter. Check the ad's diagnostic detail for finish reason and safety ratings, or try a different prompt.";
const GEMINI_BILLING_URL = 'https://aistudio.google.com/app/billing';

async function getClient() {
  const apiKey = await getSetting('gemini_api_key');
  if (!apiKey) throw new Error('Gemini API key not configured. Set it in Settings.');
  // Recreate if key changed
  if (!client || lastApiKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

// Model name mapping
const GEMINI_MODELS = {
  'nano-banana-pro': 'gemini-3-pro-image-preview',
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  'gemini-3-pro': 'gemini-3-pro-image-preview',
};

function durationMs(startedMs) {
  return Math.max(0, Date.now() - startedMs);
}

function classifyGeminiError(err, timedOut = false) {
  const status = err?.status || err?.statusCode || err?.httpCode;
  const message = String(err?.message || '');
  const providerText = getProviderErrorText(err);
  if (err?.code === 'GEMINI_CANCELLED' || err?.geminiErrorClass === 'cancelled') return 'cancelled';
  if (timedOut || err?.code === 'GEMINI_ATTEMPT_TIMEOUT' || err?.name === 'AbortError') return 'timeout';
  if (err?.code === 'GEMINI_NO_IMAGE_RETURNED' || err?.geminiErrorClass === 'no_image_returned') return 'no_image_returned';
  if (isGeminiBillingError(err, providerText)) return 'billing_exhausted';
  if (status === 503 || /UNAVAILABLE|high demand|experiencing/i.test(`${message} ${providerText}`)) return 'provider_unavailable';
  if (status === 429 || err?.code === 'RESOURCE_EXHAUSTED' || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) return 'rate_limit';
  if (status >= 400) return 'api_error';
  if (err?.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(err.code)) return 'fetch_failed';
  if (/fetch|network|socket|ECONNRESET|ETIMEDOUT/i.test(message)) return 'fetch_failed';
  return 'unknown';
}

function sanitizeAttemptMessage(message) {
  return String(message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
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

function isGeminiZeroQuotaError(providerErrorText) {
  return /"?limit"?\s*[:=]\s*"?0"?/i.test(providerErrorText) || /free[_-]?tier/i.test(providerErrorText);
}

function isGeminiBillingError(err, providerErrorText = getProviderErrorText(err)) {
  const status = err?.status || err?.statusCode || err?.httpCode;
  const code = err?.code || err?.error?.code || err?.error?.status;
  const text = `${providerErrorText} ${err?.message || ''}`.toLowerCase();
  return (status === 400 && code === 'FAILED_PRECONDITION' && /free tier|enable billing|setup a paid plan|set up billing/i.test(text))
    || /failed_precondition/i.test(text) && /free tier|enable billing|setup a paid plan|set up billing/i.test(text)
    || /billing disabled|billing account closed|billing account inactive|prepay credit balance|credit balance hits \$?0|all api keys.*stop working|zero quota/i.test(text)
    || isGeminiZeroQuotaError(providerErrorText);
}

function isGeminiResourceExhaustedError(err, providerErrorText) {
  const status = err?.status || err?.statusCode || err?.httpCode;
  return status === 429 || err?.code === 'RESOURCE_EXHAUSTED' || /RESOURCE_EXHAUSTED/i.test(providerErrorText);
}

function buildTimeoutError(timeoutMs) {
  const err = new Error(`Gemini image generation attempt timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
  err.code = 'GEMINI_ATTEMPT_TIMEOUT';
  return err;
}

function buildCancelledError() {
  const err = new Error('Cancelled by user');
  err.code = 'GEMINI_CANCELLED';
  err.geminiErrorClass = 'cancelled';
  return err;
}

function buildGeminiBillingError(model) {
  const err = new Error(`Gemini account has zero usable quota for ${model}. Top up billing at ${GEMINI_BILLING_URL} or rotate to a key with usable quota.`);
  err.code = 'BILLING_EXHAUSTED';
  err.provider = 'Gemini';
  err.model = model;
  return err;
}

function combineAbortSignals(signals) {
  const filtered = signals.filter(Boolean);
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(filtered);
  }
  const controller = new AbortController();
  const abort = (signal) => {
    try { controller.abort(signal.reason); } catch { controller.abort(); }
  };
  for (const signal of filtered) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

function attachImageAttempts(err, attempts) {
  try {
    Object.defineProperty(err, 'imageAttempts', {
      value: attempts,
      enumerable: false,
      configurable: true,
    });
  } catch {
    err.imageAttempts = attempts;
  }
  return err;
}

function getPartTypes(part) {
  if (!part || typeof part !== 'object') return ['unknown'];
  return Object.keys(part).sort();
}

function summarizeNoImageResponse(response) {
  const candidate = response?.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  const textExcerpt = parts
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return {
    finishReason: candidate.finishReason || null,
    partTypes: parts.map(getPartTypes),
    textExcerpt: textExcerpt || null,
    safetyRatings: candidate.safetyRatings || null,
  };
}

function buildNoImageError(response) {
  const err = new Error(NO_IMAGE_MESSAGE);
  err.code = 'GEMINI_NO_IMAGE_RETURNED';
  err.geminiErrorClass = 'no_image_returned';
  err.noImageDiagnostics = summarizeNoImageResponse(response);
  return err;
}

function extractGeminiImage(response) {
  let imageBuffer = null;
  let mimeType = 'image/png';
  let textResponse = '';

  if (response.candidates && response.candidates[0]) {
    const parts = response.candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        mimeType = part.inlineData.mimeType || 'image/png';
      } else if (part.text) {
        textResponse += part.text;
      }
    }
  }

  return { imageBuffer, mimeType, textResponse };
}

async function generateContentWithAttemptTimeout(ai, params, timeoutMs, cancelSignal = null) {
  const timeoutController = new AbortController();
  const abortSignal = combineAbortSignals([timeoutController.signal, cancelSignal]);
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutErr = buildTimeoutError(timeoutMs);
      try { timeoutController.abort(timeoutErr); } catch { timeoutController.abort(); }
      reject(timeoutErr);
    }, timeoutMs);
  });
  const cancelPromise = cancelSignal
    ? new Promise((_, reject) => {
      if (cancelSignal.aborted) {
        reject(buildCancelledError());
        return;
      }
      cancelSignal.addEventListener('abort', () => reject(buildCancelledError()), { once: true });
    })
    : null;

  const requestPromise = ai.models.generateContent({
    ...params,
    config: {
      ...(params.config || {}),
      abortSignal,
    },
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise, cancelPromise].filter(Boolean));
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Generate an image using Nano Banana Pro or Nano Banana 2.
 * Cost is auto-logged to Convex api_costs table.
 *
 * @param {string} prompt
 * @param {string} aspectRatio
 * @param {object|null} productImage - { base64, mimeType }
 * @param {object} [options] - { projectId, operation, isBatch, imageModel } for cost tracking + model selection
 */
export async function generateImage(prompt, aspectRatio = '1:1', productImage = null, options = {}) {
  const { projectId = null, operation = 'image_generation', isBatch = false, imageModel, imageSize, cancelSignal = null } = options;
  const ai = await getClient();
  const imageAttempts = [];

  // Resolve model name — default to Nano Banana 2
  if (imageModel === 'gemini-3-pro') {
    console.warn('[Gemini] Received legacy image model alias "gemini-3-pro"; routing to Nano Banana Pro.');
  }
  const modelId = GEMINI_MODELS[imageModel] || GEMINI_MODELS['nano-banana-2'];
  const isProModel = imageModel === 'nano-banana-pro' || imageModel === 'gemini-3-pro';
  const modelLabel = isProModel ? 'Nano Banana Pro' : 'Nano Banana 2';
  const requestedImageSize = imageSize || (!isProModel ? '512' : '1K');

  try {
    let contents;
    if (productImage) {
      contents = [
        { text: prompt },
        {
          inlineData: {
            data: productImage.base64,
            mimeType: productImage.mimeType
          }
        }
      ];
    } else {
      contents = prompt;
    }

    // Gemini sometimes returns 400 INVALID_ARGUMENT for transient issues (rate limits, capacity).
    // Custom retry predicate to handle this, plus standard network/server errors.
    const shouldRetryGemini = (err) => {
      const status = err.status || err.statusCode || err.httpCode;
      if (isGeminiBillingError(err)) {
        console.warn(`[Gemini Billing] Account quota exhausted, failing fast — model: ${modelId}`);
        err.model = modelId;
        return false;
      }
      if (err.geminiErrorClass === 'timeout') return true;
      if (err.geminiErrorClass === 'provider_unavailable') return true;
      if (err.geminiErrorClass === 'no_image_returned') return true;
      if (err.geminiErrorClass === 'billing_exhausted') return false;
      // Retry 400 from Gemini (transient INVALID_ARGUMENT errors)
      if (status === 400 && err.message?.includes('INVALID_ARGUMENT')) return true;
      // Retry 429 (rate limit) and 5xx (server errors)
      if (status === 429 || status >= 500) return true;
      // Retry network errors
      const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'];
      if (err.code && networkCodes.includes(err.code)) return true;
      if (err.message && /fetch|network|socket|ECONNRESET|ETIMEDOUT/i.test(err.message)) return true;
      return false;
    };

    const response = await withGeminiLimit(
      ({ queueDepthAtStart } = {}) => withRetry(
        async () => {
          const attemptNumber = imageAttempts.length + 1;
          const startedAt = new Date().toISOString();
          const startedMs = Date.now();
          let timedOut = false;
          try {
            const result = await generateContentWithAttemptTimeout(ai, {
              model: modelId,
              contents,
              config: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: {
                  aspectRatio: aspectRatio || '1:1',
                  // Caller can request a specific size (e.g. '1K' or '2K' for ads).
                  // Default: 512 for Nano Banana 2, omit for Pro (defaults to 1K).
                  // Pro only supports 1K/2K/4K; 512 is not valid for Pro.
                  imageSize: imageSize || (!isProModel ? '512' : undefined),
                }
              }
            }, GEMINI_IMAGE_ATTEMPT_TIMEOUT_MS, cancelSignal);
            if (cancelSignal?.aborted) throw buildCancelledError();
            const extracted = extractGeminiImage(result);
            if (!extracted.imageBuffer) {
              throw buildNoImageError(result);
            }
            imageAttempts.push({
              attempt_number: attemptNumber,
              started_at: startedAt,
              ended_at: new Date().toISOString(),
              duration_ms: durationMs(startedMs),
              error_class: 'success',
              error_message: null,
              queue_depth_at_start: Number.isFinite(queueDepthAtStart) ? queueDepthAtStart : null,
            });
            return result;
          } catch (err) {
            timedOut = err?.code === 'GEMINI_ATTEMPT_TIMEOUT' || (err?.name === 'AbortError' && !cancelSignal?.aborted);
            const errorClass = classifyGeminiError(err, timedOut);
            if (errorClass === 'provider_unavailable' && !err.retryAfter) {
              err.retryAfter = 3; // retry.js adds a 2s buffer, giving a short 5s backoff.
            }
            const attemptMessage = errorClass === 'no_image_returned'
              ? JSON.stringify(err.noImageDiagnostics || {})
              : (err?.message || errorClass);
            imageAttempts.push({
              attempt_number: attemptNumber,
              started_at: startedAt,
              ended_at: new Date().toISOString(),
              duration_ms: durationMs(startedMs),
              error_class: errorClass,
              error_message: sanitizeAttemptMessage(attemptMessage),
              queue_depth_at_start: Number.isFinite(queueDepthAtStart) ? queueDepthAtStart : null,
            });
            if (errorClass === 'timeout') {
              console.warn(`[Gemini ${modelLabel}] Attempt ${attemptNumber}/${GEMINI_IMAGE_MAX_ATTEMPTS} aborted after ${Math.round(GEMINI_IMAGE_ATTEMPT_TIMEOUT_MS / 1000)}s.`);
            }
            err.geminiErrorClass = errorClass;
            throw err;
          }
        },
        {
          label: `[Gemini ${modelLabel}]`,
          maxRetries: GEMINI_IMAGE_MAX_ATTEMPTS - 1,
          shouldRetry: shouldRetryGemini,
          baseDelayMs: 2000,
        }
      ),
      `[Gemini ${modelLabel} ${aspectRatio || '1:1'}]`
    );

    const { imageBuffer, mimeType, textResponse } = extractGeminiImage(response);

    // Auto-log Gemini cost (fire-and-forget)
    logGeminiCost(projectId, 1, requestedImageSize, isBatch, operation).catch(() => {});

    return { imageBuffer, mimeType, textResponse, imageAttempts };
  } catch (err) {
    const providerErrorText = getProviderErrorText(err);

    // Clean up Gemini API error messages — the SDK returns raw JSON as the message string
    if (err.geminiErrorClass === 'cancelled' || err.code === 'GEMINI_CANCELLED') {
      throw attachImageAttempts(buildCancelledError(), imageAttempts);
    }
    if (err.geminiErrorClass === 'billing_exhausted' || isGeminiBillingError(err, providerErrorText)) {
      throw attachImageAttempts(buildGeminiBillingError(modelId), imageAttempts);
    }
    if (err.message?.includes('INVALID_ARGUMENT')) {
      throw attachImageAttempts(new Error('Image generation temporarily unavailable (Gemini API capacity issue). Please try again in a moment.'), imageAttempts);
    }
    if (isGeminiResourceExhaustedError(err, providerErrorText)) {
      if (isGeminiZeroQuotaError(providerErrorText)) {
        throw attachImageAttempts(buildGeminiBillingError(modelId), imageAttempts);
      }
      throw attachImageAttempts(new Error('Image generation rate limit reached. Please wait a moment and try again.'), imageAttempts);
    }
    if (err.geminiErrorClass === 'provider_unavailable') {
      throw attachImageAttempts(new Error('Gemini is currently busy (high demand). Retrying… if this persists, try again in a minute or two.'), imageAttempts);
    }
    if (err.geminiErrorClass === 'no_image_returned' || err.code === 'GEMINI_NO_IMAGE_RETURNED') {
      throw attachImageAttempts(new Error(NO_IMAGE_MESSAGE), imageAttempts);
    }
    if (err.geminiErrorClass === 'timeout' || err.code === 'GEMINI_ATTEMPT_TIMEOUT') {
      throw attachImageAttempts(new Error('Image generation timed out while waiting for Gemini. Please retry this ad.'), imageAttempts);
    }
    throw attachImageAttempts(err, imageAttempts);
  }
}

export { getClient };

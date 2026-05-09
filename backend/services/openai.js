import OpenAI from 'openai';
import { getSetting } from '../convexClient.js';
import { defaultShouldRetry, withRetry } from './retry.js';
import { logOpenAICost } from './costTracker.js';

let client = null;
let lastApiKey = null;

async function getClient() {
  const apiKey = await getSetting('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API key not configured. Set it in Settings.');
  // Recreate if key changed
  if (!client || lastApiKey !== apiKey) {
    client = new OpenAI({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

/**
 * Auto-log OpenAI cost from a chat completion response (fire-and-forget).
 * Follows the same pattern as anthropic.js logCostFromResponse.
 */
function logCostFromResponse(response, model, options) {
  if (!response?.usage) return;
  const { prompt_tokens, completion_tokens } = response.usage;
  if (!prompt_tokens && !completion_tokens) return;
  logOpenAICost({
    model,
    operation: options.operation || 'other',
    inputTokens: prompt_tokens || 0,
    outputTokens: completion_tokens || 0,
    projectId: options.projectId || null,
  }).catch(() => {});
}

/**
 * Send a multi-turn conversation to GPT and stream the response (Chat Completions API).
 * Cost is auto-logged via stream_options.include_usage.
 *
 * @param {Array} messages
 * @param {Function} onChunk - callback for each token
 * @param {string} model
 * @param {object} [options] - { operation, projectId } for cost tracking
 */
export async function chatStream(messages, onChunk, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId, signal } = options;

  try {
    const stream = await withRetry(
      () => openai.chat.completions.create({
        model, messages, stream: true,
        stream_options: { include_usage: true },
      }, signal ? { signal } : undefined),
      { label: '[OpenAI chatStream]', shouldRetry: (err) => shouldRetryOpenAI(err, model) }
    );

    let fullResponse = '';
    let usage = null;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta) {
        fullResponse += delta;
        if (onChunk) onChunk(delta);
      }
    }

    // Auto-log cost from final chunk usage
    if (usage) {
      logOpenAICost({
        model,
        operation: operation || 'other',
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        projectId: projectId || null,
      }).catch(() => {});
    }

    return fullResponse;
  } catch (err) {
    throw toOpenAIUserFacingErrorForModel(err, model);
  }
}

/**
 * Detect "model not available" errors from OpenAI. The SDK surfaces these as
 * APIError instances with status 404 and code/type 'model_not_found'.
 * Returns the offending model string from the error message if found, else true.
 */
function isModelNotFoundError(err) {
  if (!err) return false;
  const code = err.code || err.error?.code;
  const type = err.type || err.error?.type;
  const status = err.status || err.statusCode;
  if (code === 'model_not_found' || type === 'model_not_found') return true;
  if (status === 404 && /model/i.test(err.message || '')) return true;
  return false;
}

const OPENAI_BILLING_URL = 'https://platform.openai.com/account/billing';
const OPENAI_RATE_LIMIT_MESSAGE = 'OpenAI rate limit reached. Please wait a moment and try again.';

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

function isOpenAIRateLimitError(err, providerErrorText = getProviderErrorText(err)) {
  const status = err?.status || err?.statusCode || err?.httpCode || err?.response?.status;
  const code = err?.code || err?.error?.code;
  const type = err?.type || err?.error?.type;
  return status === 429
    || code === 'rate_limit_exceeded'
    || type === 'rate_limit_exceeded'
    || code === 'insufficient_quota'
    || type === 'insufficient_quota'
    || /rate.?limit|quota/i.test(providerErrorText);
}

function toOpenAIUserFacingError(err) {
  if (isOpenAIBillingError(err)) return buildOpenAIBillingError(err?.model || 'this model');
  const providerErrorText = getProviderErrorText(err);
  if (!isOpenAIRateLimitError(err, providerErrorText)) return err;
  const mapped = new Error(OPENAI_RATE_LIMIT_MESSAGE);
  if (err?.imageAttempts) mapped.imageAttempts = err.imageAttempts;
  return mapped;
}

function buildOpenAIBillingError(model) {
  const err = new Error(`OpenAI account has zero usable quota for ${model}. Top up billing at ${OPENAI_BILLING_URL} or rotate to a key with usable quota.`);
  err.code = 'BILLING_EXHAUSTED';
  err.provider = 'OpenAI';
  err.model = model;
  return err;
}

function shouldRetryOpenAI(err, model) {
  if (isOpenAIBillingError(err)) {
    console.warn(`[OpenAI Billing] Account quota exhausted, failing fast — model: ${model}`);
    err.model = model;
    return false;
  }
  return defaultShouldRetry(err);
}

function toOpenAIUserFacingErrorForModel(err, model) {
  if (isOpenAIBillingError(err)) return buildOpenAIBillingError(model);
  return toOpenAIUserFacingError(err);
}

const OPENAI_FALLBACK_CHAIN = {
  'gpt-5.4': 'gpt-5.2',     // PEF plan 2026-04-21 — graceful fallback if 5.4 not yet available
  'gpt-5.2': 'gpt-4.1',     // PEF plan 2026-04-30 — fallback if account tier doesn't include 5.2 (used by batch pipeline)
};

/**
 * Send a multi-turn conversation to GPT and get the full response (no streaming).
 * Cost is auto-logged from response.usage.
 *
 * On `model_not_found`, the wrapper retries ONCE with the configured fallback
 * model (see OPENAI_FALLBACK_CHAIN). Emits a `warning` event via `options.onWarning`
 * so the SSE caller can surface the fallback to the user.
 *
 * @param {Array} messages
 * @param {string} model
 * @param {object} [options] - API options + { operation, projectId, onWarning } for cost tracking
 */
export async function chat(messages, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId, onWarning, signal, ...apiOptions } = options;
  const requestOptions = signal ? { signal } : undefined;

  // Normalize legacy `max_tokens` → `max_completion_tokens`. Reasoning-class
  // models (gpt-5.x, o1, o3) reject `max_tokens` with a 400; the new param
  // works on every OpenAI chat-completion model. Same upper-bound semantics.
  if (apiOptions.max_tokens != null && apiOptions.max_completion_tokens == null) {
    apiOptions.max_completion_tokens = apiOptions.max_tokens;
  }
  delete apiOptions.max_tokens;

  let activeModel = model;
  try {
    const response = await withRetry(
      () => openai.chat.completions.create({ model: activeModel, messages, ...apiOptions }, requestOptions),
      { label: `[OpenAI chat ${activeModel}]`, shouldRetry: (err) => shouldRetryOpenAI(err, activeModel) }
    );
    logCostFromResponse(response, activeModel, { operation, projectId });
    return response.choices[0].message.content;
  } catch (err) {
    const fallbackModel = OPENAI_FALLBACK_CHAIN[activeModel];
    if (fallbackModel && isModelNotFoundError(err)) {
      console.warn(`[OpenAI chat] Model ${activeModel} not found — falling back to ${fallbackModel}`);
      if (typeof onWarning === 'function') {
        try {
          onWarning({
            type: 'warning',
            tag: 'model_fallback',
            from: activeModel,
            to: fallbackModel,
            message: `OpenAI model ${activeModel} not available — using ${fallbackModel} instead.`,
          });
        } catch { /* swallow */ }
      }
      activeModel = fallbackModel;
      try {
        const response = await withRetry(
          () => openai.chat.completions.create({ model: activeModel, messages, ...apiOptions }, requestOptions),
          { label: `[OpenAI chat ${activeModel}]`, shouldRetry: (err) => shouldRetryOpenAI(err, activeModel) }
        );
        logCostFromResponse(response, activeModel, { operation, projectId });
        return response.choices[0].message.content;
      } catch (fallbackErr) {
        throw toOpenAIUserFacingErrorForModel(fallbackErr, activeModel);
      }
    }
    throw toOpenAIUserFacingErrorForModel(err, activeModel);
  }
}

/**
 * Send a message with an image (base64) to GPT.
 * Cost is auto-logged from response.usage.
 */
export async function chatWithImage(messages, text, base64Image, mimeType, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId, signal, ...apiOptions } = options;
  const requestOptions = signal ? { signal } : undefined;
  const newMessage = {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
    ]
  };

  try {
    const response = await withRetry(
      () => openai.chat.completions.create({ model, messages: [...messages, newMessage], ...apiOptions }, requestOptions),
      { label: '[OpenAI chatWithImage]', shouldRetry: (err) => shouldRetryOpenAI(err, model) }
    );
    logCostFromResponse(response, model, { operation, projectId });
    return response.choices[0].message.content;
  } catch (err) {
    throw toOpenAIUserFacingErrorForModel(err, model);
  }
}

/**
 * Send a message with multiple images (base64) to GPT.
 * Cost is auto-logged from response.usage.
 */
export async function chatWithImages(messages, text, images, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId, signal, ...apiOptions } = options;
  const requestOptions = signal ? { signal } : undefined;
  const content = [
    { type: 'text', text }
  ];

  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
    });
  }

  const newMessage = { role: 'user', content };

  try {
    const response = await withRetry(
      () => openai.chat.completions.create({ model, messages: [...messages, newMessage], ...apiOptions }, requestOptions),
      { label: '[OpenAI chatWithImages]', shouldRetry: (err) => shouldRetryOpenAI(err, model) }
    );
    logCostFromResponse(response, model, { operation, projectId });
    return response.choices[0].message.content;
  } catch (err) {
    throw toOpenAIUserFacingErrorForModel(err, model);
  }
}

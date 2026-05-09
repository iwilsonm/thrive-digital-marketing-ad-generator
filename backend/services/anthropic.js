/**
 * Anthropic Claude API wrapper — mirrors the openai.js interface for drop-in use.
 *
 * Provides chat() and chatWithImage() functions that match the OpenAI signatures
 * but route to Claude via the Anthropic SDK.
 *
 * Cost tracking: Every successful call automatically logs cost to the api_costs
 * table using token counts from the API response. Callers pass an `operation`
 * string in options to categorize the cost (e.g. 'copy_correction', 'brief_extraction').
 *
 * JSON mode: Neither Opus 4.6 nor Sonnet 4.6 support assistant message prefill.
 * For JSON output we add a JSON instruction to the system prompt and extract
 * JSON from the response text using a robust brace-matching parser.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../convexClient.js';
import { defaultShouldRetry, withRetry } from './retry.js';
import { logAnthropicCost } from './costTracker.js';

let client = null;
let lastApiKey = null;

async function getClient() {
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('Anthropic API key not configured. Set it in Settings.');
  if (!client || lastApiKey !== apiKey) {
    client = new Anthropic({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

/**
 * Extract the first complete JSON object from a text string.
 * Handles cases where the model wraps JSON in markdown fences or adds prose.
 */
export function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch {}

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Find the first { ... } block (greedy)
  const braceStart = text.indexOf('{');
  if (braceStart !== -1) {
    // Find matching closing brace
    let depth = 0;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(braceStart, i + 1)); } catch {}
        break;
      }
    }
    // Last resort: try from first { to last }
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > braceStart) {
      try { return JSON.parse(text.slice(braceStart, lastBrace + 1)); } catch {}
    }
  }

  return null;
}

/**
 * Detect Anthropic "model not available" errors. The SDK surfaces these as
 * Anthropic.NotFoundError (status 404) typically with a message containing
 * "model" or the offending model name.
 */
function isModelNotFoundError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  const type = err.error?.type || err.type;
  if (type === 'not_found_error' && /model/i.test(err.message || '')) return true;
  if (status === 404 && /model/i.test(err.message || '')) return true;
  return false;
}

const ANTHROPIC_BILLING_URL = 'https://console.anthropic.com/settings/billing';
const ANTHROPIC_RATE_LIMIT_MESSAGE = 'Anthropic rate limit reached. Please wait a moment and try again.';

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

function isAnthropicBillingError(err, providerErrorText = getProviderErrorText(err)) {
  const code = err?.code || err?.error?.code;
  const type = err?.error?.type || err?.type;
  const text = providerErrorText.toLowerCase();
  return code === 'credit_balance_too_low'
    || code === 'billing_error'
    || code === 'payment_required'
    || code === 'organization_disabled'
    || code === 'account_suspended'
    || type === 'credit_balance_too_low'
    || type === 'billing_error'
    || type === 'payment_required'
    || text.includes('credit balance is too low')
    || text.includes('purchase credits')
    || text.includes('upgrade or purchase credits')
    || text.includes('billing')
    || text.includes('organization has been disabled')
    || text.includes('organization disabled')
    || text.includes('account suspended')
    || text.includes('organization suspended');
}

function isAnthropicRateLimitError(err, providerErrorText = getProviderErrorText(err)) {
  const status = err?.status || err?.statusCode || err?.httpCode || err?.response?.status;
  const type = err?.error?.type || err?.type;
  return status === 429
    || status === 400 && isAnthropicBillingError(err, providerErrorText)
    || type === 'rate_limit_error'
    || /rate.?limit|too many requests|quota|credit balance is too low|billing|organization has been disabled/i.test(providerErrorText);
}

function toAnthropicUserFacingError(err) {
  if (isAnthropicBillingError(err)) return buildAnthropicBillingError(err?.model || 'this model');
  const providerErrorText = getProviderErrorText(err);
  if (!isAnthropicRateLimitError(err, providerErrorText)) return err;
  return new Error(ANTHROPIC_RATE_LIMIT_MESSAGE);
}

function buildAnthropicBillingError(model) {
  const err = new Error(`Anthropic account has zero usable quota for ${model}. Top up billing at ${ANTHROPIC_BILLING_URL} or rotate to a key with usable quota.`);
  err.code = 'BILLING_EXHAUSTED';
  err.provider = 'Anthropic';
  err.model = model;
  return err;
}

function shouldRetryAnthropic(err, model) {
  if (isAnthropicBillingError(err)) {
    console.warn(`[Anthropic Billing] Account quota exhausted, failing fast — model: ${model}`);
    err.model = model;
    return false;
  }
  return defaultShouldRetry(err);
}

function toAnthropicUserFacingErrorForModel(err, model) {
  if (isAnthropicBillingError(err)) return buildAnthropicBillingError(model);
  return toAnthropicUserFacingError(err);
}

const ANTHROPIC_FALLBACK_CHAIN = {
  'claude-sonnet-4-6': 'claude-sonnet-4-5',  // PEF plan 2026-04-21 — graceful fallback if 4.6 deprecated mid-deploy
};

/**
 * Fire-and-forget cost logging for an Anthropic API response.
 * Extracts token usage from the response and logs to api_costs.
 */
function logCostFromResponse(response, model, options) {
  if (!response?.usage) return;
  const { input_tokens, output_tokens } = response.usage;
  if (!input_tokens && !output_tokens) return;

  // Fire-and-forget — don't block the caller
  logAnthropicCost({
    model,
    operation: options.operation || 'other',
    inputTokens: input_tokens || 0,
    outputTokens: output_tokens || 0,
    projectId: options.projectId || null,
  }).catch(() => {}); // silently ignore cost logging failures
}

/**
 * Send a conversation to Claude and get the full response (no streaming).
 *
 * Accepts OpenAI-style messages array: [{ role: 'user'|'assistant', content: string }]
 * Automatically extracts system messages and passes them via the `system` parameter.
 *
 * JSON mode handling:
 * Adds a JSON instruction to the system prompt and extracts JSON from response.
 * No assistant prefill — current Claude models do not support it.
 *
 * @param {Array} messages - OpenAI-format messages array
 * @param {string} [model='claude-sonnet-4-6'] - Anthropic model name
 * @param {object} [options={}] - Extra options (e.g., max_tokens, response_format, operation, projectId)
 * @returns {string} The assistant's response text
 */
export async function chat(messages, model = 'claude-sonnet-4-6', options = {}) {
  const anthropic = await getClient();

  // Separate system messages from conversation messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  // Build system prompt from system messages (if any)
  let systemPrompt = systemMessages.length > 0
    ? systemMessages.map(m => m.content).join('\n\n')
    : undefined;

  // Convert messages — Anthropic requires alternating user/assistant.
  // Phase 2 (PEF item I): if a message carries `cache_control`, convert its
  // string content into a content-block array with the cache marker so
  // Anthropic's prompt cache can hit. Caller sets the marker on the docs +
  // swipe turns (Turn 1 + Turn 2) — large, repeated, project-stable payloads.
  // Per PEF invariant #2, Turn 4 must NEVER set this marker.
  const anthropicMessages = conversationMessages.map(m => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (m.cache_control && typeof m.content === 'string') {
      return {
        role,
        content: [{ type: 'text', text: m.content, cache_control: m.cache_control }],
      };
    }
    return { role, content: typeof m.content === 'string' ? m.content : m.content };
  });

  // Handle JSON mode — add instruction to system prompt (no prefill, current models do not support it)
  const wantJSON = options.response_format?.type === 'json_object';
  if (wantJSON) {
    const jsonInstruction = '\n\nIMPORTANT: You must respond with ONLY a valid JSON object. No markdown fences, no prose before or after — just the raw JSON object starting with { and ending with }.';
    systemPrompt = systemPrompt ? systemPrompt + jsonInstruction : jsonInstruction;
  }

  // Use timeout if specified (in ms), default 120s
  const timeoutMs = options.timeout || 120000;

  const callWithModel = async (activeModel) => {
    const createParams = {
      model: activeModel,
      max_tokens: options.max_tokens || 16384,
      messages: anthropicMessages,
    };
    if (systemPrompt) createParams.system = systemPrompt;
    return withRetry(
      () => {
        const apiCall = anthropic.messages.create(createParams);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Anthropic API call timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
        );
        return Promise.race([apiCall, timeoutPromise]);
      },
      {
        label: `[Anthropic chat ${activeModel}]`,
        maxRetries: options.maxRetries ?? 3,
        shouldRetry: (err) => shouldRetryAnthropic(err, activeModel),
      }
    );
  };

  let activeModel = model;
  let response;
  try {
    response = await callWithModel(activeModel);
  } catch (err) {
    const fallbackModel = ANTHROPIC_FALLBACK_CHAIN[activeModel];
    if (fallbackModel && isModelNotFoundError(err)) {
      console.warn(`[Anthropic chat] Model ${activeModel} not found — falling back to ${fallbackModel}`);
      if (typeof options.onWarning === 'function') {
        try {
          options.onWarning({
            type: 'warning',
            tag: 'anthropic_model_fallback',
            from: activeModel,
            to: fallbackModel,
            message: `Anthropic model ${activeModel} not available — using ${fallbackModel} instead.`,
          });
        } catch { /* swallow */ }
      }
      activeModel = fallbackModel;
      try {
        response = await callWithModel(activeModel);
      } catch (fallbackErr) {
        throw toAnthropicUserFacingErrorForModel(fallbackErr, activeModel);
      }
    } else {
      throw toAnthropicUserFacingErrorForModel(err, activeModel);
    }
  }

  // Log cost from token usage (fire-and-forget) — uses the model that actually responded.
  logCostFromResponse(response, activeModel, options);

  let text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  // For JSON mode, extract the JSON object from the response
  if (wantJSON) {
    const parsed = extractJSON(text);
    if (parsed) {
      text = JSON.stringify(parsed);
    }
    // If extraction failed, return raw text — caller's repairJSON will handle it
  }

  return text;
}

/**
 * Send a message with a single image (base64) to Claude.
 *
 * @param {Array} messages - Previous conversation messages (OpenAI format)
 * @param {string} text - Text prompt to accompany the image
 * @param {string} base64Image - Base64-encoded image data
 * @param {string} mimeType - Image MIME type (e.g., 'image/png', 'image/jpeg')
 * @param {string} [model='claude-sonnet-4-6'] - Anthropic model name
 * @param {object} [options={}] - Extra options (e.g., operation, projectId for cost tracking)
 * @returns {string} The assistant's response text
 */
export async function chatWithImage(messages, text, base64Image, mimeType, model = 'claude-sonnet-4-6', options = {}) {
  const anthropic = await getClient();

  // Separate system messages from conversation messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  const systemPrompt = systemMessages.length > 0
    ? systemMessages.map(m => m.content).join('\n\n')
    : undefined;

  // Convert previous messages
  const anthropicMessages = conversationMessages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content : m.content,
  }));

  // Normalize MIME type for Anthropic (supports image/jpeg, image/png, image/gif, image/webp)
  let normalizedMime = mimeType;
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
    normalizedMime = 'image/png'; // fallback
  }

  // Add the new message with image in Anthropic's format
  anthropicMessages.push({
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizedMime,
          data: base64Image,
        },
      },
      {
        type: 'text',
        text: text,
      },
    ],
  });

  const createParams = {
    model,
    max_tokens: 16384,
    messages: anthropicMessages,
  };

  if (systemPrompt) {
    createParams.system = systemPrompt;
  }

  try {
    const response = await withRetry(
      () => anthropic.messages.create(createParams),
      { label: '[Anthropic chatWithImage]', shouldRetry: (err) => shouldRetryAnthropic(err, model) }
    );

    // Log cost from token usage (fire-and-forget)
    logCostFromResponse(response, model, options);

    return response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  } catch (err) {
    throw toAnthropicUserFacingErrorForModel(err, model);
  }
}

/**
 * Send a message with multiple images (base64) to Claude.
 *
 * @param {Array} messages - Previous conversation messages (OpenAI format)
 * @param {string} text - Text prompt to accompany the images
 * @param {Array<{base64: string, mimeType: string}>} images - Array of base64-encoded images
 * @param {string} [model='claude-sonnet-4-6'] - Anthropic model name
 * @param {object} [options={}] - Extra options (e.g., max_tokens, operation, projectId, response_format)
 * @returns {string} The assistant's response text
 */
export async function chatWithMultipleImages(messages, text, images, model = 'claude-sonnet-4-6', options = {}) {
  const anthropic = await getClient();

  // Separate system messages from conversation messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  let systemPrompt = systemMessages.length > 0
    ? systemMessages.map(m => m.content).join('\n\n')
    : undefined;

  // Convert previous messages
  const anthropicMessages = conversationMessages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content : m.content,
  }));

  // Handle JSON mode
  const wantJSON = options.response_format?.type === 'json_object';
  if (wantJSON) {
    const jsonInstruction = '\n\nIMPORTANT: You must respond with ONLY a valid JSON object. No markdown fences, no prose before or after — just the raw JSON object starting with { and ending with }.';
    systemPrompt = systemPrompt ? systemPrompt + jsonInstruction : jsonInstruction;
  }

  // Build content blocks: all images/documents first, then text
  const contentBlocks = [];
  for (const img of images) {
    if (img.mimeType === 'application/pdf') {
      // PDF: send as document block
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: img.base64,
        },
      });
    } else {
      // Image: send as vision block
      let normalizedMime = img.mimeType;
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(normalizedMime)) {
        normalizedMime = 'image/png';
      }
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizedMime,
          data: img.base64,
        },
      });
    }
  }
  contentBlocks.push({ type: 'text', text });

  // Add the new message with all images
  anthropicMessages.push({ role: 'user', content: contentBlocks });

  const createParams = {
    model,
    max_tokens: options.max_tokens || 16384,
    messages: anthropicMessages,
  };

  if (systemPrompt) {
    createParams.system = systemPrompt;
  }

  const timeoutMs = options.timeout || 120000;

  try {
    const response = await withRetry(
      () => {
        const apiCall = anthropic.messages.create(createParams);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Anthropic API call timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
        );
        return Promise.race([apiCall, timeoutPromise]);
      },
      {
        label: '[Anthropic chatWithMultipleImages]',
        maxRetries: options.maxRetries ?? 3,
        shouldRetry: (err) => shouldRetryAnthropic(err, model),
      }
    );

    // Log cost from token usage (fire-and-forget)
    logCostFromResponse(response, model, options);

    let responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // For JSON mode, extract the JSON object from the response
    if (wantJSON) {
      const parsed = extractJSON(responseText);
      if (parsed) {
        responseText = JSON.stringify(parsed);
      }
    }

    return responseText;
  } catch (err) {
    throw toAnthropicUserFacingErrorForModel(err, model);
  }
}

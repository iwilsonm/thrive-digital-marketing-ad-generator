import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  getSetting: vi.fn(),
  logAnthropicCost: vi.fn(),
  withRetry: vi.fn(async (fn, options = {}) => {
    try {
      return await fn();
    } catch (err) {
      if (typeof options.shouldRetry === 'function') options.shouldRetry(err);
      throw err;
    }
  }),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function AnthropicMock() {
    return {
      messages: {
        create: mocks.messagesCreate,
      },
    };
  }),
}));

vi.mock('../convexClient.js', () => ({
  getSetting: mocks.getSetting,
}));

vi.mock('../services/retry.js', () => ({
  withRetry: mocks.withRetry,
  defaultShouldRetry: vi.fn((err) => {
    const status = err.status || err.statusCode || err.httpCode;
    return status === 429 || status >= 500;
  }),
}));

vi.mock('../services/costTracker.js', () => ({
  logAnthropicCost: mocks.logAnthropicCost,
}));

import { chat } from '../services/anthropic.js';

describe('Anthropic rate limit user-facing messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockResolvedValue('sk-ant-test');
    mocks.logAnthropicCost.mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports billing/account action when Anthropic returns a low-credit error', async () => {
    const err = new Error('Your credit balance is too low to access the Anthropic API.');
    err.status = 400;
    err.error = {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    };
    mocks.messagesCreate.mockRejectedValueOnce(err);

    await expect(chat([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6', { maxRetries: 0 })).rejects.toMatchObject({
      code: 'BILLING_EXHAUSTED',
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      message: 'Anthropic account has zero usable quota for claude-sonnet-4-6. Top up billing at https://console.anthropic.com/settings/billing or rotate to a key with usable quota.',
    });
    expect(mocks.messagesCreate).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[Anthropic Billing] Account quota exhausted, failing fast — model: claude-sonnet-4-6');
  });

  it('keeps the wait-and-retry message for transient Anthropic rate limits', async () => {
    const err = new Error('Too many requests.');
    err.status = 429;
    err.error = {
      type: 'rate_limit_error',
      message: 'Too many requests.',
    };
    mocks.messagesCreate.mockRejectedValueOnce(err);

    await expect(chat([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6', { maxRetries: 0 })).rejects.toThrow(
      'Anthropic rate limit reached. Please wait a moment and try again.'
    );
  });
});

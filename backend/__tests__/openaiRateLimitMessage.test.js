import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  getSetting: vi.fn(),
  logOpenAICost: vi.fn(),
  withRetry: vi.fn(async (fn, options = {}) => {
    try {
      return await fn();
    } catch (err) {
      if (typeof options.shouldRetry === 'function') options.shouldRetry(err);
      throw err;
    }
  }),
}));

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      chat: {
        completions: {
          create: mocks.chatCreate,
        },
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
  logOpenAICost: mocks.logOpenAICost,
}));

import { chat } from '../services/openai.js';

describe('OpenAI rate limit user-facing messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockResolvedValue('sk-test');
    mocks.logOpenAICost.mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports billing/account action when OpenAI returns insufficient_quota', async () => {
    const err = new Error('You exceeded your current quota, please check your plan and billing details.');
    err.status = 429;
    err.error = {
      type: 'insufficient_quota',
      code: 'insufficient_quota',
      message: 'You exceeded your current quota, please check your plan and billing details.',
    };
    mocks.chatCreate.mockRejectedValueOnce(err);

    await expect(chat([{ role: 'user', content: 'hi' }], 'gpt-5.2')).rejects.toMatchObject({
      code: 'BILLING_EXHAUSTED',
      provider: 'OpenAI',
      model: 'gpt-5.2',
      message: 'OpenAI account has zero usable quota for gpt-5.2. Top up billing at https://platform.openai.com/account/billing or rotate to a key with usable quota.',
    });
    expect(mocks.chatCreate).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[OpenAI Billing] Account quota exhausted, failing fast — model: gpt-5.2');
  });

  it('keeps the wait-and-retry message for transient OpenAI rate limits', async () => {
    const err = new Error('Rate limit reached for requests.');
    err.status = 429;
    err.error = {
      type: 'rate_limit_exceeded',
      code: 'rate_limit_exceeded',
      message: 'Rate limit reached for requests.',
    };
    mocks.chatCreate.mockRejectedValueOnce(err);

    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'OpenAI rate limit reached. Please wait a moment and try again.'
    );
  });
});

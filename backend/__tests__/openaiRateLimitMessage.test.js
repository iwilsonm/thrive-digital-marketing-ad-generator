import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  getSetting: vi.fn(),
  logOpenAICost: vi.fn(),
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
  withRetry: vi.fn((fn) => fn()),
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

    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'OpenAI request blocked — your account shows zero usable quota for this model. Add billing details or check usage limits at https://platform.openai.com/account/billing.'
    );
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

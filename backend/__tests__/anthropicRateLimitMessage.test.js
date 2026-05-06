import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  getSetting: vi.fn(),
  logAnthropicCost: vi.fn(),
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
  withRetry: vi.fn((fn) => fn()),
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
  });

  it('reports billing/account action when Anthropic returns a low-credit error', async () => {
    const err = new Error('Your credit balance is too low to access the Anthropic API.');
    err.status = 400;
    err.error = {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    };
    mocks.messagesCreate.mockRejectedValueOnce(err);

    await expect(chat([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6', { maxRetries: 0 })).rejects.toThrow(
      'Anthropic request blocked — your account shows insufficient credit balance or a billing issue. Check your plan and credits at https://console.anthropic.com/settings/billing.'
    );
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

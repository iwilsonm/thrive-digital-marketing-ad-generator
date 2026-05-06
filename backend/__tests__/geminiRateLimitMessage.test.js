import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  getSetting: vi.fn(),
  logGeminiCost: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    return {
      models: {
        generateContent: mocks.generateContent,
      },
    };
  }),
}));

vi.mock('../convexClient.js', () => ({
  getSetting: mocks.getSetting,
}));

vi.mock('../services/rateLimiter.js', () => ({
  withGeminiLimit: vi.fn((fn) => fn()),
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: mocks.logGeminiCost,
}));

import { generateImage } from '../services/gemini.js';

async function expectGeminiFailureMessage(err, expectedMessage) {
  vi.useFakeTimers();
  mocks.generateContent.mockRejectedValue(err);

  const generation = generateImage('prompt', '1:1', null, {
    projectId: 'project-1',
    imageModel: 'nano-banana-2',
    operation: 'ad_image_generation',
  });

  const expectation = expect(generation).rejects.toMatchObject({
    message: expectedMessage,
    imageAttempts: [
      expect.objectContaining({ attempt_number: 1, error_class: 'rate_limit' }),
      expect.objectContaining({ attempt_number: 2, error_class: 'rate_limit' }),
    ],
  });

  await vi.advanceTimersByTimeAsync(15_000);
  await expectation;
}

describe('Gemini image rate limit user-facing messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockResolvedValue('gemini-api-key');
    mocks.logGeminiCost.mockResolvedValue(undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports billing/account action when Gemini returns a free-tier zero-quota error', async () => {
    const err = new Error('RESOURCE_EXHAUSTED: Quota exceeded for metric GenerateImagesRequestsPerMinutePerProjectPerModel-FreeTier, limit: 0');
    err.status = 429;
    err.error = {
      message: 'Quota exceeded for metric GenerateImagesRequestsPerMinutePerProjectPerModel-FreeTier with limit: 0',
    };

    await expectGeminiFailureMessage(
      err,
      "Gemini image generation requires a paid Google AI Studio tier — your current API key's project shows zero quota for this model. Enable billing at https://aistudio.google.com or switch the image model in Settings."
    );
  });

  it('keeps the wait-and-retry message for transient Gemini 429s with non-zero quota', async () => {
    const err = new Error('RESOURCE_EXHAUSTED: Rate limit exceeded for generateContent requests. Please retry later.');
    err.status = 429;
    err.error = {
      message: 'Quota exceeded for metric GenerateImagesRequestsPerMinutePerProjectPerModel, limit: 60',
    };

    await expectGeminiFailureMessage(
      err,
      'Image generation rate limit reached. Please wait a moment and try again.'
    );
  });
});

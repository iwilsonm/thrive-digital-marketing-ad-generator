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
  withGeminiLimit: vi.fn((fn) => fn({ queueDepthAtStart: 2 })),
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: mocks.logGeminiCost,
}));

import { generateImage } from '../services/gemini.js';

async function expectGeminiFailureMessage(err, expectedMessage, expectedClass = 'rate_limit', retryDelayMs = 15_000) {
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
      expect.objectContaining({ attempt_number: 1, error_class: expectedClass, queue_depth_at_start: 2 }),
      expect.objectContaining({ attempt_number: 2, error_class: expectedClass, queue_depth_at_start: 2 }),
    ],
  });

  await vi.advanceTimersByTimeAsync(retryDelayMs);
  await expectation;
}

describe('Gemini image rate limit user-facing messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockResolvedValue('gemini-api-key');
    mocks.logGeminiCost.mockResolvedValue(undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    mocks.generateContent.mockRejectedValue(err);

    await expect(generateImage('prompt', '1:1', null, {
      projectId: 'project-1',
      imageModel: 'nano-banana-2',
      operation: 'ad_image_generation',
    })).rejects.toMatchObject({
      code: 'BILLING_EXHAUSTED',
      provider: 'Gemini',
      model: 'gemini-3.1-flash-image-preview',
      message: 'Gemini account has zero usable quota for gemini-3.1-flash-image-preview. Top up billing at https://aistudio.google.com/app/billing or rotate to a key with usable quota.',
      imageAttempts: [
        expect.objectContaining({ attempt_number: 1, error_class: 'billing_exhausted', queue_depth_at_start: 2 }),
      ],
    });
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[Gemini Billing] Account quota exhausted, failing fast — model: gemini-3.1-flash-image-preview');
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

  it('reports provider high demand separately from quota rate limits', async () => {
    const err = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}');
    err.status = 503;
    err.error = {
      message: 'This model is currently experiencing high demand.',
    };

    await expectGeminiFailureMessage(
      err,
      'Gemini is currently busy (high demand). Retrying… if this persists, try again in a minute or two.',
      'provider_unavailable',
      5_000
    );
  });

  it('retries no-image responses and records finish reason diagnostics', async () => {
    vi.useFakeTimers();
    mocks.generateContent.mockResolvedValue({
      candidates: [{
        finishReason: 'SAFETY',
        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'LOW' }],
        content: {
          parts: [
            { text: 'I cannot create that image because it appears to violate a policy.' },
          ],
        },
      }],
    });

    const generation = generateImage('prompt', '1:1', null, {
      projectId: 'project-1',
      imageModel: 'nano-banana-pro',
      operation: 'ad_image_generation',
    });

    const expectation = expect(generation).rejects.toMatchObject({
      message: "Gemini returned a response without an image. This usually means the prompt was refused or hit a content filter. Check the ad's diagnostic detail for finish reason and safety ratings, or try a different prompt.",
      imageAttempts: [
        expect.objectContaining({
          attempt_number: 1,
          error_class: 'no_image_returned',
          error_message: expect.stringContaining('"finishReason":"SAFETY"'),
          queue_depth_at_start: 2,
        }),
        expect.objectContaining({
          attempt_number: 2,
          error_class: 'no_image_returned',
          error_message: expect.stringContaining('"partTypes":[["text"]]'),
          queue_depth_at_start: 2,
        }),
      ],
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
  });
});

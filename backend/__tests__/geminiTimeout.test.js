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
  withGeminiLimit: vi.fn((fn) => fn({ queueDepthAtStart: 4 })),
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: mocks.logGeminiCost,
}));

import { generateImage } from '../services/gemini.js';

const imagePayload = Buffer.from('generated-image').toString('base64');

function successResponse() {
  return {
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            data: imagePayload,
            mimeType: 'image/png',
          },
        }],
      },
    }],
  };
}

describe('Gemini synchronous image attempt timeout', () => {
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

  it('passes an AbortSignal to the synchronous generateContent call and records success attempts', async () => {
    mocks.generateContent.mockResolvedValueOnce(successResponse());

    const result = await generateImage('prompt', '1:1', null, {
      projectId: 'project-1',
      imageModel: 'nano-banana-2',
      operation: 'ad_image_generation',
    });

    expect(result.imageBuffer.equals(Buffer.from('generated-image'))).toBe(true);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(result.imageAttempts).toEqual([expect.objectContaining({
      attempt_number: 1,
      error_class: 'success',
      error_message: null,
      duration_ms: expect.any(Number),
      queue_depth_at_start: 4,
    })]);
  });

  it('aborts a hung attempt at 180 seconds, retries once, and returns diagnostics', async () => {
    vi.useFakeTimers();
    mocks.generateContent
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(successResponse());

    const generation = generateImage('prompt', '1:1', null, {
      projectId: 'project-1',
      imageModel: 'nano-banana-2',
      operation: 'ad_image_generation',
    });

    await vi.advanceTimersByTimeAsync(180_000);
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await generation;

    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    expect(result.imageAttempts).toHaveLength(2);
    expect(result.imageAttempts[0]).toMatchObject({
      attempt_number: 1,
      error_class: 'timeout',
      queue_depth_at_start: 4,
    });
    expect(result.imageAttempts[1]).toMatchObject({
      attempt_number: 2,
      error_class: 'success',
    });
  });

  it('fails cleanly after two timed-out attempts and exposes imageAttempts on the error', async () => {
    vi.useFakeTimers();
    mocks.generateContent.mockImplementation(() => new Promise(() => {}));

    const generation = generateImage('prompt', '1:1', null, {
      projectId: 'project-1',
      imageModel: 'nano-banana-2',
      operation: 'ad_image_generation',
    });
    const expectation = expect(generation).rejects.toMatchObject({
      message: 'Image generation timed out while waiting for Gemini. Please retry this ad.',
      imageAttempts: [
        expect.objectContaining({ attempt_number: 1, error_class: 'timeout' }),
        expect.objectContaining({ attempt_number: 2, error_class: 'timeout' }),
      ],
    });

    await vi.advanceTimersByTimeAsync(180_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(180_000);

    await expectation;
    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
  });

  it('maps the legacy gemini-3-pro alias to Nano Banana Pro', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.generateContent.mockResolvedValueOnce(successResponse());

    await generateImage('prompt', '1:1', null, {
      projectId: 'project-1',
      imageModel: 'gemini-3-pro',
      operation: 'ad_image_generation',
    });

    expect(mocks.generateContent.mock.calls[0][0].model).toBe('gemini-3-pro-image-preview');
    expect(mocks.generateContent.mock.calls[0][0].config.imageConfig.imageSize).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('legacy image model alias "gemini-3-pro"'));
  });

  it('classifies an external cancel signal separately from timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mocks.generateContent.mockImplementationOnce(() => new Promise(() => {}));

    const generation = generateImage('prompt', '1:1', null, {
      projectId: 'project-1',
      imageModel: 'nano-banana-2',
      operation: 'ad_image_generation',
      cancelSignal: controller.signal,
    });

    const expectation = expect(generation).rejects.toMatchObject({
      message: 'Cancelled by user',
      imageAttempts: [
        expect.objectContaining({
          attempt_number: 1,
          error_class: 'cancelled',
        }),
      ],
    });

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expectation;
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  imagesGenerate: vi.fn(),
  imagesEdit: vi.fn(),
  getSetting: vi.fn(),
  logOpenAIImageCost: vi.fn(),
  toFile: vi.fn(async (buffer, name, options) => ({ buffer, name, options })),
}));

vi.mock('openai', () => ({
  default: vi.fn(function OpenAI() {
    return {
      images: {
        generate: mocks.imagesGenerate,
        edit: mocks.imagesEdit,
      },
    };
  }),
  toFile: mocks.toFile,
}));

vi.mock('../convexClient.js', () => ({
  getSetting: mocks.getSetting,
}));

vi.mock('../services/costTracker.js', () => ({
  logOpenAIImageCost: mocks.logOpenAIImageCost,
}));

vi.mock('../services/retry.js', () => ({
  withRetry: vi.fn(async (fn, options = {}) => {
    try {
      return await fn();
    } catch (err) {
      if (options.shouldRetry) options.shouldRetry(err);
      throw err;
    }
  }),
}));

import { generateImage } from '../services/openaiImage.js';

describe('openaiImage generateImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockResolvedValue('openai-key');
    mocks.logOpenAIImageCost.mockResolvedValue(undefined);
    mocks.imagesGenerate.mockResolvedValue({
      data: [{ b64_json: Buffer.from('image').toString('base64') }],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        input_tokens_details: { text_tokens: 10, image_tokens: 0 },
      },
    });
    mocks.imagesEdit.mockResolvedValue({
      data: [{ b64_json: Buffer.from('edited-image').toString('base64') }],
      usage: {
        input_tokens: 30,
        output_tokens: 20,
        total_tokens: 50,
        input_tokens_details: { text_tokens: 10, image_tokens: 20 },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps aspect ratio, defaults quality to medium, requests jpeg, and logs usage', async () => {
    const result = await generateImage('prompt', '4:5', null, {
      projectId: 'project-1',
      operation: 'ad_image_generation',
    });

    expect(mocks.imagesGenerate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2',
      prompt: 'prompt',
      size: '1024x1280',
      quality: 'medium',
      output_format: 'jpeg',
    }), expect.any(Object));
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.usage.total_tokens).toBe(30);
    expect(mocks.logOpenAIImageCost).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      model: 'gpt-image-2',
      size: '1024x1280',
      quality: 'medium',
    }));
  });

  it('uses low quality when requested for the Settings test button', async () => {
    await generateImage('prompt', '1:1', null, { quality: 'low' });
    expect(mocks.imagesGenerate).toHaveBeenCalledWith(expect.objectContaining({
      quality: 'low',
      size: '1024x1024',
    }), expect.any(Object));
  });

  it('keeps single product image behavior by routing through images.edit with one file', async () => {
    await generateImage('prompt', '1:1', {
      base64: Buffer.from('reference').toString('base64'),
      mimeType: 'image/png',
    });

    expect(mocks.imagesGenerate).not.toHaveBeenCalled();
    expect(mocks.toFile).toHaveBeenCalledTimes(1);
    expect(mocks.imagesEdit).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2',
      prompt: 'prompt',
      image: [expect.objectContaining({ name: 'reference-1.png' })],
      output_format: 'jpeg',
    }), expect.any(Object));
  });

  it('passes multiple product images to images.edit as an image array', async () => {
    const refs = [1, 2, 3].map(n => ({
      base64: Buffer.from(`reference-${n}`).toString('base64'),
      mimeType: n === 2 ? 'image/jpeg' : 'image/png',
    }));

    await generateImage('prompt', '1:1', refs);

    expect(mocks.imagesGenerate).not.toHaveBeenCalled();
    expect(mocks.toFile).toHaveBeenCalledTimes(3);
    expect(mocks.imagesEdit).toHaveBeenCalledWith(expect.objectContaining({
      image: [
        expect.objectContaining({ name: 'reference-1.png' }),
        expect.objectContaining({ name: 'reference-2.jpg' }),
        expect.objectContaining({ name: 'reference-3.png' }),
      ],
    }), expect.any(Object));
  });

  it('treats an empty product image array as text-only generation', async () => {
    await generateImage('prompt', '1:1', []);
    expect(mocks.imagesGenerate).toHaveBeenCalledTimes(1);
    expect(mocks.imagesEdit).not.toHaveBeenCalled();
  });

  it('rejects more than ten product images with a clear error', async () => {
    const refs = Array.from({ length: 11 }, (_, index) => ({
      base64: Buffer.from(`reference-${index}`).toString('base64'),
      mimeType: 'image/png',
    }));

    await expect(generateImage('prompt', '1:1', refs)).rejects.toThrow('supports up to 10 reference images');
    expect(mocks.imagesGenerate).not.toHaveBeenCalled();
    expect(mocks.imagesEdit).not.toHaveBeenCalled();
  });

  it('fails fast with BILLING_EXHAUSTED metadata for account quota errors', async () => {
    const err = new Error('insufficient_quota');
    err.status = 429;
    err.code = 'insufficient_quota';
    mocks.imagesGenerate.mockRejectedValueOnce(err);

    await expect(generateImage('prompt')).rejects.toMatchObject({
      code: 'BILLING_EXHAUSTED',
      provider: 'OpenAI',
      model: 'gpt-image-2',
      message: 'OpenAI account has zero usable quota for gpt-image-2. Top up billing at https://platform.openai.com/account/billing or rotate to a key with usable quota.',
      imageAttempts: [
        expect.objectContaining({ attempt_number: 1, error_class: 'billing_exhausted' }),
      ],
    });
    expect(mocks.imagesGenerate).toHaveBeenCalledTimes(1);
  });
});

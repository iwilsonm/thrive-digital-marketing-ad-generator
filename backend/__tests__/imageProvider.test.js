import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  geminiGenerateImage: vi.fn(),
  openaiGenerateImage: vi.fn(),
}));

vi.mock('../services/gemini.js', () => ({
  generateImage: mocks.geminiGenerateImage,
}));

vi.mock('../services/openaiImage.js', () => ({
  generateImage: mocks.openaiGenerateImage,
}));

import {
  DEFAULT_IMAGE_MODEL,
  resolveImageModel,
  getImageProvider,
  generateImage,
} from '../services/imageProvider.js';

describe('imageProvider dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.geminiGenerateImage.mockResolvedValue({ imageBuffer: Buffer.from('gemini'), mimeType: 'image/png' });
    mocks.openaiGenerateImage.mockResolvedValue({ imageBuffer: Buffer.from('openai'), mimeType: 'image/jpeg' });
  });

  it('defaults null and unknown model values to nano-banana-2', () => {
    expect(DEFAULT_IMAGE_MODEL).toBe('nano-banana-2');
    expect(resolveImageModel(null)).toBe('nano-banana-2');
    expect(resolveImageModel(undefined)).toBe('nano-banana-2');
    expect(resolveImageModel('unknown-model')).toBe('nano-banana-2');
  });

  it('accepts the legacy Gemini alias without exposing it as canonical', () => {
    expect(resolveImageModel('gemini-3-pro')).toBe('nano-banana-pro');
    expect(getImageProvider('gemini-3-pro')).toBe('gemini');
  });

  it('routes Gemini and OpenAI models to the selected provider', async () => {
    await generateImage({ model: 'nano-banana-2', prompt: 'p', aspectRatio: '1:1' });
    expect(mocks.geminiGenerateImage).toHaveBeenCalledTimes(1);
    expect(mocks.openaiGenerateImage).not.toHaveBeenCalled();

    await generateImage({ model: 'gpt-image-2', prompt: 'p', aspectRatio: '1:1' });
    expect(mocks.openaiGenerateImage).toHaveBeenCalledTimes(1);
  });

  it('lets provider errors bubble without silent Gemini fallback', async () => {
    mocks.openaiGenerateImage.mockRejectedValueOnce(new Error('OpenAI failed'));
    await expect(generateImage({ model: 'gpt-image-2', prompt: 'p' })).rejects.toThrow('OpenAI failed');
    expect(mocks.geminiGenerateImage).not.toHaveBeenCalled();
  });
});

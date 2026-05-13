import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
}));

vi.mock('../services/openai.js', () => ({
  chat: mocks.chat,
  chatWithImage: vi.fn(),
  chatWithImages: vi.fn(),
}));

vi.mock('../services/imageProvider.js', () => ({
  generateImage: vi.fn(),
  resolveImageModel: vi.fn((value) => value || 'nano-banana-2'),
  getImageModelLabel: vi.fn((value) => value || 'Nano Banana 2'),
}));

vi.mock('../convexClient.js', () => ({
  getProject: vi.fn(),
  getLatestDoc: vi.fn(),
  uploadBuffer: vi.fn(),
  downloadToBuffer: vi.fn(),
  getInspirationImages: vi.fn(),
  getAllInspirationImages: vi.fn(),
  getInspirationImageUrl: vi.fn(),
  getTemplateImagesByProject: vi.fn(),
  getAllTemplateImages: vi.fn(),
  getAdImageUrl: vi.fn(),
  getSetting: vi.fn(),
  invalidateQueryCache: vi.fn(),
  convexClient: { query: vi.fn(), mutation: vi.fn() },
  api: {},
}));

vi.mock('../services/rateLimiter.js', () => ({
  withHeavyLLMLimit: vi.fn((fn) => fn()),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  })),
}));

import { reviewPromptWithGuidelines } from '../services/adGenerator.js';

describe('reviewPromptWithGuidelines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the original prompt without calling chat when guidelines are empty', async () => {
    const result = await reviewPromptWithGuidelines('original prompt', '', { projectId: 'p1' });

    expect(result).toBe('original prompt');
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('passes operation and projectId into the guideline review chat call', async () => {
    mocks.chat.mockResolvedValue(' revised prompt ');

    const result = await reviewPromptWithGuidelines('original prompt', 'avoid blue backgrounds', { projectId: 'p1' });

    expect(result).toBe('revised prompt');
    expect(mocks.chat).toHaveBeenCalledWith(
      expect.any(Array),
      'gpt-4.1-mini',
      expect.objectContaining({
        operation: 'prompt_guideline_review',
        projectId: 'p1',
      })
    );
  });

  it('returns the original prompt and logs a warning when chat fails', async () => {
    mocks.chat.mockRejectedValue(new Error('quota temporarily unavailable'));

    const result = await reviewPromptWithGuidelines('original prompt', 'avoid blue backgrounds', { projectId: 'p1' });

    expect(result).toBe('original prompt');
    expect(console.warn).toHaveBeenCalledWith(
      '[AdGenerator] Prompt guidelines review failed, using original prompt:',
      'quota temporarily unavailable'
    );
  });
});

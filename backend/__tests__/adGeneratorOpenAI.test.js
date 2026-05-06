import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
  chatWithImages: vi.fn(),
  geminiGenerateImage: vi.fn(),
  convexQuery: vi.fn(),
  convexMutation: vi.fn(),
  getProject: vi.fn(),
  getLatestDoc: vi.fn(),
  uploadBuffer: vi.fn(),
  downloadToBuffer: vi.fn(),
  getAdImageUrl: vi.fn(),
}));

vi.mock('../convexClient.js', () => ({
  getProject: mocks.getProject,
  getLatestDoc: mocks.getLatestDoc,
  uploadBuffer: mocks.uploadBuffer,
  downloadToBuffer: mocks.downloadToBuffer,
  getInspirationImages: vi.fn(),
  getAllInspirationImages: vi.fn(),
  getInspirationImageUrl: vi.fn(),
  getTemplateImagesByProject: vi.fn(),
  getAdImageUrl: mocks.getAdImageUrl,
  invalidateQueryCache: vi.fn(),
  getSetting: vi.fn(),
  convexClient: {
    query: mocks.convexQuery,
    mutation: mocks.convexMutation,
  },
  api: {
    adCreatives: {
      create: 'adCreatives.create',
      update: 'adCreatives.update',
      getByExternalId: 'adCreatives.getByExternalId',
    },
    templateImages: {
      getByExternalId: 'templateImages.getByExternalId',
    },
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-ad-id'),
}));

vi.mock('../services/openai.js', () => ({
  chat: mocks.chat,
  chatWithImage: mocks.chatWithImage,
  chatWithImages: mocks.chatWithImages,
}));

vi.mock('../services/gemini.js', () => ({
  generateImage: mocks.geminiGenerateImage,
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: vi.fn(),
}));

vi.mock('../services/rateLimiter.js', () => ({
  withHeavyLLMLimit: vi.fn((fn) => fn()),
  withGptRateLimit: vi.fn((fn) => fn()),
  AsyncSemaphore: vi.fn(),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  })),
}));

import { generateAd, generateAdMode2 } from '../services/adGenerator.js';

const templateBase64 = Buffer.from('template-image').toString('base64');
const generatedImage = Buffer.from('generated-image');

function setupHappyPath() {
  mocks.getProject.mockResolvedValue({
    id: 'project-1',
    brand_name: 'Test Brand',
    niche: 'wellness',
    product_description: 'test product',
    prompt_guidelines: null,
  });
  mocks.getLatestDoc.mockResolvedValue({ content: 'doc content' });
  mocks.downloadToBuffer.mockResolvedValue(Buffer.from('template-image'));
  mocks.convexQuery.mockImplementation(async (fn) => {
    if (fn === 'templateImages.getByExternalId') {
      return {
        externalId: 'template-1',
        storageId: 'storage-template',
        mimeType: 'image/jpeg',
      };
    }
    if (fn === 'adCreatives.getByExternalId') {
      return {
        externalId: 'ad-1',
        project_id: 'project-1',
        generation_mode: 'mode2',
        angle: null,
        headline: 'Headline',
        body_copy: 'Body',
        image_prompt: 'generated prompt',
        gpt_creative_output: 'generated prompt',
        storageId: 'storage-ad',
        aspect_ratio: '1:1',
        status: 'completed',
      };
    }
    return null;
  });
  mocks.chat.mockImplementation(async (_messages, model) => {
    if (model === 'gpt-4.1-mini') {
      return JSON.stringify({ headline: 'Headline', body_copy: 'Body' });
    }
    return 'ack';
  });
  mocks.chatWithImages.mockResolvedValue('generated prompt');
  mocks.chatWithImage.mockResolvedValue(JSON.stringify({
    is_product_only: false,
    has_visible_ad_layout: true,
    headline_visible: true,
    reason: 'looks like an ad',
  }));
  mocks.geminiGenerateImage.mockResolvedValue({
    imageBuffer: generatedImage,
    mimeType: 'image/png',
    imageAttempts: [{
      attempt_number: 1,
      started_at: '2026-05-06T00:00:00.000Z',
      ended_at: '2026-05-06T00:00:02.000Z',
      duration_ms: 2000,
      error_class: 'success',
      error_message: null,
    }],
  });
  mocks.uploadBuffer.mockResolvedValue('storage-ad');
  mocks.getAdImageUrl.mockResolvedValue('https://example.com/ad.png');
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyPath();
});

afterEach(() => {
  try {
    fs.unlinkSync(path.join(process.cwd(), '.thumb-cache', 'test-ad-id.jpg'));
  } catch { /* generated thumbnail may not exist */ }
});

describe('Gemini ad generation plumbing', () => {
  it('records completed_at on a successful Mode 1 ad update', async () => {
    await generateAd('project-1', {
      uploadedImageBase64: Buffer.from('uploaded-layout').toString('base64'),
      uploadedImageMimeType: 'image/png',
      headline: 'Headline',
      bodyCopy: 'Body',
    });

    expect(mocks.convexMutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      status: 'completed',
      completed_at: expect.any(String),
      image_attempts: expect.any(String),
    }));
    const completedUpdate = mocks.convexMutation.mock.calls.find(([, payload]) => payload?.status === 'completed')?.[1];
    expect(JSON.parse(completedUpdate.image_attempts)).toEqual([expect.objectContaining({
      attempt_number: 1,
      error_class: 'success',
    })]);
  });

  it('records completed_at on a failed generation update', async () => {
    const err = new Error('image provider 500');
    err.imageAttempts = [{
      attempt_number: 1,
      started_at: '2026-05-06T00:00:00.000Z',
      ended_at: '2026-05-06T00:00:01.000Z',
      duration_ms: 1000,
      error_class: 'api_error',
      error_message: 'image provider 500',
    }];
    mocks.geminiGenerateImage.mockRejectedValueOnce(err);

    await expect(generateAd('project-1', {
      uploadedImageBase64: Buffer.from('uploaded-layout').toString('base64'),
      uploadedImageMimeType: 'image/png',
      headline: 'Headline',
      bodyCopy: 'Body',
    })).rejects.toThrow('image provider 500');

    expect(mocks.convexMutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      status: 'failed',
      error_message: 'image provider 500',
      completed_at: expect.any(String),
      image_attempts: expect.any(String),
    }));
    const failedUpdate = mocks.convexMutation.mock.calls.find(([, payload]) => payload?.status === 'failed')?.[1];
    expect(JSON.parse(failedUpdate.image_attempts)).toEqual([expect.objectContaining({
      attempt_number: 1,
      error_class: 'api_error',
    })]);
  });

  it('blocks Mode 1 before provider calls when product_description is empty', async () => {
    mocks.getProject.mockResolvedValueOnce({
      id: 'project-1',
      brand_name: 'Test Brand',
      niche: 'wellness',
      product_description: '   ',
      prompt_guidelines: null,
    });
    const onEvent = vi.fn();

    await expect(generateAd('project-1', {
      uploadedImageBase64: Buffer.from('uploaded-layout').toString('base64'),
      uploadedImageMimeType: 'image/png',
      headline: 'Headline',
      bodyCopy: 'Body',
      onEvent,
    })).rejects.toMatchObject({
      code: 'MISSING_PRODUCT_DESCRIPTION',
      actionUrl: '/projects/project-1?tab=overview',
      actionLabel: 'Edit Product Description',
    });

    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.chatWithImage).not.toHaveBeenCalled();
    expect(mocks.chatWithImages).not.toHaveBeenCalled();
    expect(mocks.geminiGenerateImage).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      code: 'MISSING_PRODUCT_DESCRIPTION',
      actionUrl: '/projects/project-1?tab=overview',
      actionLabel: 'Edit Product Description',
    }));
    expect(mocks.convexMutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('missing a Product Description'),
      failure_stage: 'ad_generation',
    }));
  });

  it('routes Mode 2 Nano Banana through the synchronous Gemini wrapper, not a batch job', async () => {
    await generateAdMode2('project-1', {
      templateImageId: 'template-1',
      imageModel: 'nano-banana-2',
      headline: 'Headline',
      bodyCopy: 'Body',
    });

    expect(mocks.geminiGenerateImage).toHaveBeenCalledTimes(1);
    const [, , , options] = mocks.geminiGenerateImage.mock.calls[0];
    expect(options).toMatchObject({
      imageModel: 'nano-banana-2',
      operation: 'ad_image_generation',
    });
    expect(mocks.convexMutation).not.toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      gemini_batch_job: expect.any(String),
    }));
  });

  it('marks the ad cancelled when cancellation is requested at a step boundary', async () => {
    const onEvent = vi.fn();
    mocks.convexQuery.mockResolvedValue({
      externalId: 'test-ad-id',
      project_id: 'project-1',
      status: 'generating_copy',
      cancellation_requested_at: '2026-05-07T00:00:00.000Z',
    });

    await expect(generateAd('project-1', {
      uploadedImageBase64: Buffer.from('uploaded-layout').toString('base64'),
      uploadedImageMimeType: 'image/png',
      headline: 'Headline',
      bodyCopy: 'Body',
      onEvent,
    })).resolves.toBeNull();

    expect(mocks.geminiGenerateImage).not.toHaveBeenCalled();
    expect(mocks.convexMutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      externalId: 'test-ad-id',
      status: 'cancelled',
      error_message: 'Cancelled by user',
      completed_at: expect.any(String),
    }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cancelled',
      adId: 'test-ad-id',
      message: 'Cancelled by user',
    }));
  });

  it('passes the cancel AbortSignal through OpenAI copy calls and Gemini image generation', async () => {
    const controller = new AbortController();

    await generateAd('project-1', {
      uploadedImageBase64: Buffer.from('uploaded-layout').toString('base64'),
      uploadedImageMimeType: 'image/png',
      headline: 'Headline',
      bodyCopy: 'Body',
      cancelSignal: controller.signal,
    });

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.any(Array),
      'gpt-5.2',
      expect.objectContaining({ signal: controller.signal })
    );
    expect(mocks.chatWithImage).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'gpt-5.2',
      expect.objectContaining({ signal: controller.signal })
    );
    expect(mocks.geminiGenerateImage).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      null,
      expect.objectContaining({ cancelSignal: controller.signal })
    );
  });
});

import { describe, it, expect, vi } from 'vitest';

// Mock modules that depend on convexClient (which needs Convex generated code)
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

vi.mock('../services/openai.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
  chatWithImages: vi.fn(),
  generateImage: vi.fn(),
}));

vi.mock('../services/anthropic.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
}));

vi.mock('../services/gemini.js', () => ({
  generateImage: vi.fn(),
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: vi.fn(),
}));

vi.mock('../services/rateLimiter.js', () => ({
  withGptRateLimit: vi.fn((fn) => fn()),
  withHeavyLLMLimit: vi.fn((fn) => fn()),
  AsyncSemaphore: vi.fn(),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

import { chat, chatWithImage } from '../services/openai.js';
import { getAllTemplateImages } from '../convexClient.js';
import {
  HEADLINE_LANES,
  repairJSON,
  buildCreativeDirectorPrompt,
  buildImageRequestText,
  generateImagePrompt,
  generateImagePromptsBatch,
  getOfferRenderContext,
  assertTemplateTagHasActiveTemplates,
} from '../services/adGenerator.js';

// ── repairJSON ──────────────────────────────────────────────────────────────

describe('repairJSON', () => {
  it('parses valid JSON', () => {
    const result = repairJSON('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips markdown code fences (```json)', () => {
    const input = '```json\n{"a": 1}\n```';
    expect(repairJSON(input)).toEqual({ a: 1 });
  });

  it('strips bare markdown code fences (```)', () => {
    const input = '```\n{"b": 2}\n```';
    expect(repairJSON(input)).toEqual({ b: 2 });
  });

  it('fixes trailing commas before }', () => {
    const input = '{"a": 1, "b": 2,}';
    expect(repairJSON(input)).toEqual({ a: 1, b: 2 });
  });

  it('fixes trailing commas before ]', () => {
    const input = '{"arr": [1, 2, 3,]}';
    expect(repairJSON(input)).toEqual({ arr: [1, 2, 3] });
  });

  it('handles fences + trailing commas together', () => {
    const input = '```json\n{"items": ["a", "b",],}\n```';
    expect(repairJSON(input)).toEqual({ items: ['a', 'b'] });
  });

  it('throws on empty input', () => {
    expect(() => repairJSON('')).toThrow('Empty JSON response');
    expect(() => repairJSON('   ')).toThrow('Empty JSON response');
  });

  it('throws on null/undefined input', () => {
    expect(() => repairJSON(null)).toThrow();
    expect(() => repairJSON(undefined)).toThrow();
  });

  it('throws on completely invalid JSON', () => {
    expect(() => repairJSON('not json at all')).toThrow();
  });
});

describe('template tag preflight', () => {
  it('passes when an active template has the requested tag', async () => {
    getAllTemplateImages.mockResolvedValue([
      { externalId: 'archived', storageId: 's1', tags: ['sleep'], archived_at: '2026-05-01T00:00:00Z' },
      { externalId: 'active', storageId: 's2', tags: ['Sleep'], archived_at: null },
    ]);

    await expect(assertTemplateTagHasActiveTemplates('proj-1', 'sleep')).resolves.toMatchObject({
      tag: 'sleep',
      count: 1,
    });
  });

  it('blocks before generation when no active template matches the requested tag', async () => {
    getAllTemplateImages.mockResolvedValue([
      { externalId: 'other', storageId: 's1', tags: ['testimonial'], archived_at: null },
      { externalId: 'archived', storageId: 's2', tags: ['sleep'], archived_at: '2026-05-01T00:00:00Z' },
    ]);

    await expect(assertTemplateTagHasActiveTemplates('proj-1', 'sleep')).rejects.toThrow('No active templates are tagged "sleep"');
  });
});

// ── buildCreativeDirectorPrompt ─────────────────────────────────────────────

describe('buildCreativeDirectorPrompt', () => {
  const project = {
    brand_name: 'TestBrand',
    niche: 'wellness',
    product_description: 'a grounding sleep mat',
  };

  it('includes brand name and product description', () => {
    const result = buildCreativeDirectorPrompt(project, {});
    expect(result).toContain('TestBrand');
    expect(result).toContain('a grounding sleep mat');
    expect(result).toContain('wellness');
  });

  it('includes all 4 doc contents when provided', () => {
    const docs = {
      research: { content: 'RESEARCH_CONTENT_HERE' },
      avatar: { content: 'AVATAR_CONTENT_HERE' },
      offer_brief: { content: 'OFFER_CONTENT_HERE' },
      necessary_beliefs: { content: 'BELIEFS_CONTENT_HERE' },
    };
    const result = buildCreativeDirectorPrompt(project, docs);
    expect(result).toContain('RESEARCH_CONTENT_HERE');
    expect(result).toContain('AVATAR_CONTENT_HERE');
    expect(result).toContain('OFFER_CONTENT_HERE');
    expect(result).toContain('BELIEFS_CONTENT_HERE');
  });

  it('uses placeholder text for missing docs', () => {
    const result = buildCreativeDirectorPrompt(project, {});
    expect(result).toContain('[No research document available]');
    expect(result).toContain('[No avatar sheet available]');
    expect(result).toContain('[No offer brief available]');
    expect(result).toContain('[No necessary beliefs document available]');
  });

  it('handles partial docs (some present, some missing)', () => {
    const docs = {
      research: { content: 'Some research' },
      avatar: null,
      offer_brief: { content: '' },
      necessary_beliefs: undefined,
    };
    const result = buildCreativeDirectorPrompt(project, docs);
    expect(result).toContain('Some research');
    expect(result).toContain('[No avatar sheet available]');
    // Empty string is falsy → falls back to placeholder
    expect(result).toContain('[No offer brief available]');
    expect(result).toContain('[No necessary beliefs document available]');
  });
});

// ── buildImageRequestText ───────────────────────────────────────────────────

describe('buildImageRequestText', () => {
  it('returns base text with no extras', () => {
    const result = buildImageRequestText(null, '1:1', false);
    expect(result).toBe('make a prompt for an image like this');
  });

  it('appends angle instruction', () => {
    const result = buildImageRequestText('pain relief', '1:1', false);
    expect(result).toContain('The ad should focus on this angle/topic: pain relief');
  });

  it('appends aspect ratio when not 1:1', () => {
    const result = buildImageRequestText(null, '9:16', false);
    expect(result).toContain('Use 9:16 aspect ratio instead of 1:1');
  });

  it('does NOT append aspect ratio when 1:1', () => {
    const result = buildImageRequestText(null, '1:1', false);
    expect(result).not.toContain('aspect ratio');
  });

  it('appends product image instruction', () => {
    const result = buildImageRequestText(null, '1:1', true);
    expect(result).toContain('I have attached an image of the product');
  });

  it('appends headline with quotes stripped', () => {
    const result = buildImageRequestText(null, '1:1', false, '"My Headline"');
    expect(result).toContain('The ad must include this headline text exactly as written');
    expect(result).toContain('My Headline');
    // Should not have outer quotes
    expect(result).not.toContain('""');
  });

  it('appends body copy with quotes stripped', () => {
    const result = buildImageRequestText(null, '1:1', false, null, '\u201CSome body copy\u201D');
    expect(result).toContain('The ad must include this body copy text exactly as written');
    expect(result).toContain('Some body copy');
  });

  it('combines all extras', () => {
    const result = buildImageRequestText('sleep angle', '4:5', true, 'My Headline', 'Body text');
    expect(result).toContain('make a prompt for an image like this');
    expect(result).toContain('product');
    expect(result).toContain('My Headline');
    expect(result).toContain('Body text');
    expect(result).toContain('sleep angle');
    expect(result).toContain('4:5');
  });
});

// ── generateImagePromptsBatch ───────────────────────────────────────────────

describe('generateImagePromptsBatch', () => {
  it('uses a template text contract and does not force full primary text rendering', async () => {
    chatWithImage
      .mockResolvedValueOnce(JSON.stringify({
        text_density: 'short',
        rendered_text_expectation: 'template_matched',
        template_summary: 'Sparse template with one headline and a small badge.',
        copy_guidance: 'Keep on-image text sparse.',
        zones: [
          { role: 'headline', required: true, approx_words: 6, density: 'short', hierarchy: 'primary' },
          { role: 'badge', required: false, approx_words: 3, density: 'short', hierarchy: 'small' },
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        prompts: [
          {
            prompt: 'Create a sparse ad with one bold headline and a small badge.',
            visual_copy_plan: {
              headline: 'Sleep Deeper Tonight',
              badge: 'No More 3AM',
              supporting_text: null,
              cta: null,
              notes: 'Matches the sparse template.',
            },
            rendered_text_expectation: 'template_matched',
            visual_text_density: 'short',
          },
        ],
      }));

    const result = await generateImagePromptsBatch(
      { id: 'project-1', name: 'Brand', brand_name: 'Brand', product_description: 'Grounding sheet' },
      [{
        headline: 'Sleep Deeper Tonight',
        body_copy: 'This is a long Facebook primary text paragraph that should guide the idea but should not be rendered verbatim inside the image.',
        primary_emotion: 'relief',
      }],
      { base64: 'ZmFrZQ==', mimeType: 'image/png' },
      '1:1',
      null
    );

    expect(result).toHaveLength(1);
    expect(result[0].prompt).toContain('sparse ad');
    expect(result[0].visual_copy_plan.headline).toBe('Sleep Deeper Tonight');
    expect(result[0].template_text_contract.text_density).toBe('short');

    const imagePromptRequest = chatWithImage.mock.calls[1][1];
    expect(imagePromptRequest).toContain('TEMPLATE TEXT CONTRACT');
    expect(imagePromptRequest).toContain('META PRIMARY TEXT CONTEXT (do not render verbatim');
    expect(imagePromptRequest).not.toContain('Each prompt should render the EXACT headline and body copy text');
  });
});

describe('offer-agnostic image prompt defaults', () => {
  it('does not include ecommerce rendering defaults for a non-ecom webinar offer', async () => {
    chat.mockClear();
    chat.mockResolvedValueOnce('Create a webinar-specific scene.');

    await generateImagePrompt(
      {
        id: 'project-webinar',
        name: 'Christian Counsellor Webinar',
        brand_name: 'TOV',
        niche: '',
        product_description: 'A free live webinar helping Christians compare counselling paths before training.',
      },
      'One tab shows tuition; the next shows your church calendar.',
      'Compare licensure, ministry, and certificate paths before you commit.',
      'careful anxiety',
      null,
      '1:1',
      {
        frame: 'consequence-first',
        core_buyer: 'Christians discerning whether counselling training fits their calling and life.',
        scene: 'A kitchen table with a laptop, bills, and a church calendar.',
        emotional_state: 'Careful anxiety and financial caution.',
        tone: 'Practical, calm, responsible.',
      }
    );

    const prompt = chat.mock.calls.at(-1)[0][0].content;

    expect(prompt).toContain('Offer rendering mode: offer-agnostic / non-physical by default.');
    expect(prompt).toContain('CORE BUYER: Christians discerning whether counselling training fits their calling and life. — the person in the image should feel like this prospect');
    expect(prompt).not.toMatch(/product mockup/i);
    expect(prompt).not.toMatch(/trust badge/i);
    expect(prompt).not.toMatch(/star rating/i);
    expect(prompt).not.toMatch(/\bDTC\b/i);
    expect(prompt).not.toMatch(/this woman/i);
  });

  it('allows ecommerce-specific render context only when the project explicitly says ecommerce', () => {
    const context = getOfferRenderContext({
      name: 'Joint Relief',
      brand_name: 'Joint Relief',
      niche: 'supplements ecommerce',
      product_description: 'A joint support supplement sold online.',
    });

    expect(context).toContain('ecommerce / physical-product eligible');
    expect(context).toContain('packaging');
  });
});

describe('headline lane defaults', () => {
  it('does not define review_like as fabricated testimonial or product-review framing', () => {
    expect(HEADLINE_LANES.review_like).not.toMatch(/testimonial/i);
    expect(HEADLINE_LANES.review_like).not.toMatch(/product review/i);
    expect(HEADLINE_LANES.review_like).toMatch(/first-person reflection/i);
    expect(HEADLINE_LANES.failed_solutions).not.toMatch(/purchases/i);
    expect(HEADLINE_LANES.symptom_recognition).not.toMatch(/physical symptom/i);
  });
});

import { describe, expect, it } from 'vitest';
import { buildAngleGenerationPrompt, buildHeadlineGenerationPrompt } from '../services/adStudioPrompts.js';

describe('Ad Studio prompt builders', () => {
  it('does not inject health/wellness demographic defaults for non-DTC projects', () => {
    const project = {
      name: 'Christian Counsellor Webinar',
      brand_name: 'TOV',
      niche: '',
      product_description: 'A free webinar helping Christians compare counselling paths before training.',
    };
    const avatarSnippet = 'Christians who feel called to help others through counselling, ministry care, or pastoral support.';
    const offerSnippet = 'Compare licensure, ministry, and certificate paths before committing time and money.';

    const anglePrompt = buildAngleGenerationPrompt({ project, avatarSnippet, offerSnippet });
    const headlinePrompt = buildHeadlineGenerationPrompt({
      project,
      angle: 'credential confusion',
      avatarSnippet,
      offerSnippet,
      researchSnippet: 'They keep asking whether a certificate is recognized.',
    });

    for (const prompt of [anglePrompt, headlinePrompt]) {
      expect(prompt).toContain('Christians');
      expect(prompt).toMatch(/counsel(?:l)?ing/i);
      expect(prompt).not.toContain('women 55-75');
      expect(prompt).not.toContain('health/wellness');
      expect(prompt).not.toContain('DTC');
    }
  });

  it('preserves explicit DTC health context when the project says so', () => {
    const project = {
      name: 'Joint Relief',
      brand_name: 'Joint Relief',
      niche: 'DTC supplements',
      product_description: 'A joint support supplement.',
    };
    const avatarSnippet = 'Women 55-75 buying health and wellness supplements for joint comfort.';
    const prompt = buildHeadlineGenerationPrompt({ project, avatarSnippet, offerSnippet: 'A supplement offer.' });

    expect(prompt).toContain('DTC supplements');
    expect(prompt).toContain('Women 55-75');
    expect(prompt).toContain('health and wellness supplements');
  });
});

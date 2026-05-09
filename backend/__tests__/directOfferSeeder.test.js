import { describe, expect, it, vi } from 'vitest';
import {
  buildDirectOfferPrompt,
  generateDirectOfferAngleContent,
  seedDirectOfferAngleForProject,
} from '../services/directOfferSeeder.js';

const ccwProject = {
  id: 'ccw-project',
  name: 'Christian Counsellor Webinar',
  brand_name: 'TOV',
  niche: 'Christian counselling education',
  product_description: 'A free webinar helping Christians compare counselling paths before training.',
};

const ccwDocs = [
  { doc_type: 'research', content: 'The audience wants clarity before choosing a Christian counselling training path.' },
  { doc_type: 'avatar', content: 'Christians who feel called to help hurting people but are unsure whether to sign up for the next step.' },
  { doc_type: 'offer_brief', content: 'The offer is a free webinar registration that helps them understand fit before enrolling.' },
  { doc_type: 'necessary_beliefs', content: 'They need to believe a low-pressure webinar can give clarity before commitment.' },
];

const ecommerceProject = {
  id: 'ecom-project',
  name: 'Sleep Gummies',
  brand_name: 'RestWell',
  niche: 'DTC ecommerce supplements',
  product_description: 'A physical sleep supplement sold online for adults who want calmer nights.',
};

const ecommerceDocs = [
  { doc_type: 'research', content: 'Buyers compare sleep supplements and want product reassurance before purchase.' },
  { doc_type: 'avatar', content: 'Adults considering a sleep product but skeptical about whether another supplement will help.' },
  { doc_type: 'offer_brief', content: 'The offer is a physical product available to purchase online.' },
  { doc_type: 'necessary_beliefs', content: 'They need to believe this product fits their routine and is worth trying.' },
];

function mockAngle(overrides = {}) {
  return {
    name: 'Direct Offer',
    status: 'active',
    priority: 'medium',
    frame: 'objection-first',
    core_buyer: 'Christians who are considering the free Christian counselling webinar.',
    symptom_pattern: 'They are trying to figure out which counselling path fits before they register.',
    failed_solutions: 'They have compared pages and asked around, but still need a direct path comparison.',
    current_belief: 'They think they need more certainty before they click into the webinar.',
    objection: 'They worry the webinar may pressure them into a program before they understand the options.',
    emotional_state: 'Curious but cautious.',
    scene: "The moment they see the ad in feed: they have no prior context, they have 1-2 seconds to decide whether to stop. The headline must name who it's for and what's offered so they can decide instantly.",
    desired_belief_shift: 'The webinar is a clear, low-pressure way to compare Christian counselling paths.',
    tone: 'Direct, plain, action-oriented. No hype, no metaphors, no narrative voice. Like a Facebook ad that names the offer.',
    avoid_list: 'Scene-bound metaphors (kitchen-table, home-desk, notepad, Bible-nearby imagery), insider marketing jargon (funnel, pitch, pipeline), narrative storytelling, hyper-specific moments or props, second-person scene descriptions, anything that requires creative translation to make sense in a 5-word headline. Headlines should name the audience, name the offer plainly, and let the offer do the asking.',
    prompt_hints: 'Text-forward webinar creative with audience-relevant imagery and a clear CTA.',
    ...overrides,
  };
}

describe('Direct Offer seeder', () => {
  it('builds a CCW prompt with service/webinar rendering context and direct-offer rules', () => {
    const { system, user } = buildDirectOfferPrompt(ccwProject, ccwDocs);

    expect(system).toContain('You generate a single "Direct Offer" angle');
    expect(system).toContain('name the audience, name the offer');
    expect(system).toContain('No metaphors, no scene imagery, no narrative storytelling');
    expect(system).toContain('Scene-bound metaphors (kitchen-table, home-desk, notepad, Bible-nearby imagery)');
    expect(user).toContain('Offer rendering mode: offer-agnostic / non-physical by default');
    expect(user).toContain('webinar screen');
    expect(user).toContain('[offer_brief]');
    expect(user).toContain('free webinar registration');
    expect(user).toContain('Considering Christian Counseling? Free Webinar Compares All 3 Paths');
  });

  it('generates webinar-shaped Direct Offer content for Christian Counsellor Webinar context', async () => {
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle()));

    const content = await generateDirectOfferAngleContent(ccwProject, ccwDocs, { chatImpl });

    expect(content.name).toBe('Direct Offer');
    expect(`${content.core_buyer} ${content.symptom_pattern} ${content.prompt_hints}`).toMatch(/webinar|register|christian counselling/i);
    expect(JSON.stringify(content)).not.toMatch(/Shop Now|90-day guarantee|10,000\+ happy customers|free shipping/i);
    expect(content.scene).toContain('The moment they see the ad in feed');
    expect(content.scene).not.toMatch(/kitchen|home desk|notepad|Bible-nearby/i);
  });

  it('generates product-shaped Direct Offer content for ecommerce context without unsupported banned claims', async () => {
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle({
      core_buyer: 'Adults who are considering the RestWell sleep gummies product.',
      symptom_pattern: 'They are trying to decide whether this sleep supplement is worth trying.',
      failed_solutions: 'They have compared sleep products and want direct product clarity.',
      current_belief: 'They think another sleep product may not fit their nightly routine.',
      objection: 'They worry the product will not be different enough to justify buying.',
      desired_belief_shift: 'This product is a simple next step to consider for calmer nights.',
      prompt_hints: 'Product-forward creative with clear product visual and offer-focused copy.',
    })));

    const content = await generateDirectOfferAngleContent(ecommerceProject, ecommerceDocs, { chatImpl });

    expect(`${content.core_buyer} ${content.symptom_pattern} ${content.prompt_hints}`).toMatch(/product|buying|sleep supplement/i);
    expect(JSON.stringify(content)).not.toMatch(/Shop Now|90-day guarantee|10,000\+ happy customers|free shipping/i);
  });

  it('rejects banned ecommerce contamination when the project materials do not justify it', async () => {
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle({
      prompt_hints: 'Use a Shop Now CTA and mention a 90-day guarantee.',
    })));

    await expect(generateDirectOfferAngleContent(ccwProject, ccwDocs, { chatImpl }))
      .rejects.toThrow(/unsupported ecommerce claims/i);
  });

  it('does not call the LLM when a Direct Offer angle already exists', async () => {
    const chatImpl = vi.fn();
    const result = await seedDirectOfferAngleForProject(ccwProject, ccwDocs, {
      chatImpl,
      existingAngles: [{ externalId: 'existing-direct-offer', name: 'Direct Offer', source: 'direct_offer', status: 'archived' }],
    });

    expect(result).toMatchObject({ created: false, reason: 'direct_offer_exists' });
    expect(chatImpl).not.toHaveBeenCalled();
  });

  it('is idempotent when run twice against the same project', async () => {
    const inserted = [];
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle()));
    const getAnglesImpl = vi.fn(async () => inserted);
    const seedImpl = vi.fn(async (angle) => {
      inserted.push({ ...angle, externalId: angle.id, source: 'direct_offer', name: angle.name });
      return { created: true, externalId: angle.id };
    });

    const first = await seedDirectOfferAngleForProject(ccwProject, ccwDocs, {
      chatImpl,
      getAnglesImpl,
      seedImpl,
      idFactory: () => 'seed-1',
    });
    const second = await seedDirectOfferAngleForProject(ccwProject, ccwDocs, {
      chatImpl,
      getAnglesImpl,
      seedImpl,
      idFactory: () => 'seed-2',
    });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, reason: 'direct_offer_exists' });
    expect(inserted).toHaveLength(1);
    expect(chatImpl).toHaveBeenCalledTimes(1);
  });
});

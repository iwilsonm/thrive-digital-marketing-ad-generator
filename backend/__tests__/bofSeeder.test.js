import { describe, expect, it, vi } from 'vitest';
import {
  buildDefaultBofPrompt,
  generateDefaultBofAngleContent,
  seedDefaultBofAngleForProject,
} from '../services/bofSeeder.js';

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
    name: 'BOF - Final Step Clarity',
    status: 'active',
    priority: 'medium',
    frame: 'objection-first',
    core_buyer: 'Prospects close to taking the next step.',
    symptom_pattern: 'They keep returning to the offer because they want reassurance before acting.',
    failed_solutions: 'They have compared options and tried to answer the final questions alone.',
    current_belief: 'They think they need more certainty before they move.',
    objection: 'They worry the next step may pressure them into a commitment.',
    emotional_state: 'Cautious but ready.',
    scene: 'Feels ready to act but wants one more clear reason that the next step fits.',
    desired_belief_shift: 'After this ad, they should believe that the next step is clear, low-pressure, and useful.',
    tone: 'Calm, direct, reassuring.',
    avoid_list: 'No invented proof claims.',
    prompt_hints: 'Show a clear next-step decision moment.',
    ...overrides,
  };
}

describe('default BOF seeder', () => {
  it('builds a CCW prompt with service/webinar rendering context', () => {
    const { user } = buildDefaultBofPrompt(ccwProject, ccwDocs);

    expect(user).toContain('Offer rendering mode: offer-agnostic / non-physical by default');
    expect(user).toContain('webinar screen');
    expect(user).toContain('[offer_brief]');
    expect(user).toContain('free webinar registration');
  });

  it('generates webinar-shaped BOF content for Christian Counsellor Webinar context', async () => {
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle({
      name: 'BOF - Webinar Registration Clarity',
      core_buyer: 'Christians who are close to registering for the counselling webinar but want reassurance first.',
      symptom_pattern: 'They keep coming back to the webinar because they want clarity before choosing a training path.',
      scene: 'Feels ready to sign up for the webinar, but wants confidence that it will answer the real fit questions.',
      desired_belief_shift: 'After this ad, they should believe that registering for the webinar is a wise clarity step before enrollment.',
      prompt_hints: 'Center the creative around a calm webinar sign-up decision, not product shopping.',
    })));

    const content = await generateDefaultBofAngleContent(ccwProject, ccwDocs, { chatImpl });

    expect(content.name).toContain('BOF -');
    expect(`${content.core_buyer} ${content.scene} ${content.prompt_hints}`).toMatch(/webinar|register|sign-up/i);
    expect(JSON.stringify(content)).not.toMatch(/Shop Now|90-day guarantee|10,000\+ happy customers|free shipping/i);
  });

  it('generates product-shaped BOF content for ecommerce context without unsupported banned claims', async () => {
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle({
      name: 'BOF - Product Trial Confidence',
      core_buyer: 'Shoppers close to buying the sleep supplement who want final product reassurance.',
      symptom_pattern: 'They keep comparing product details because they want to know whether this supplement fits their nightly routine.',
      scene: 'Feels ready to purchase but wants one more clear reason this product is the right choice.',
      desired_belief_shift: 'After this ad, they should believe that trying the product is a sensible next step.',
      prompt_hints: 'Show the physical product clearly with simple routine-fit reassurance.',
    })));

    const content = await generateDefaultBofAngleContent(ecommerceProject, ecommerceDocs, { chatImpl });

    expect(`${content.core_buyer} ${content.scene} ${content.prompt_hints}`).toMatch(/product|purchase|shopper/i);
    expect(JSON.stringify(content)).not.toMatch(/Shop Now|90-day guarantee|10,000\+ happy customers|free shipping/i);
  });

  it('rejects banned ecommerce contamination when the project materials do not justify it', async () => {
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle({
      prompt_hints: 'Use a Shop Now CTA and mention a 90-day guarantee.',
    })));

    await expect(generateDefaultBofAngleContent(ccwProject, ccwDocs, { chatImpl }))
      .rejects.toThrow(/unsupported ecommerce claims/i);
  });

  it('does not call the LLM when a BOF angle already exists', async () => {
    const chatImpl = vi.fn();
    const result = await seedDefaultBofAngleForProject(ccwProject, ccwDocs, {
      chatImpl,
      existingAngles: [{ externalId: 'existing-bof', name: 'BOF - Existing', source: 'default_bof', status: 'archived' }],
    });

    expect(result).toMatchObject({ created: false, reason: 'bof_exists' });
    expect(chatImpl).not.toHaveBeenCalled();
  });

  it('is idempotent when run twice against the same project', async () => {
    const inserted = [];
    const chatImpl = vi.fn().mockResolvedValue(JSON.stringify(mockAngle({
      name: 'BOF - Webinar Sign-Up Confidence',
      core_buyer: 'Christians close to registering for the webinar.',
      scene: 'Feels ready to sign up for the webinar after checking the final questions.',
      desired_belief_shift: 'After this ad, they should believe that registering is a wise clarity step.',
      prompt_hints: 'Use webinar registration context.',
    })));
    const getAnglesImpl = vi.fn(async () => inserted);
    const seedImpl = vi.fn(async (angle) => {
      inserted.push({ ...angle, externalId: angle.id, source: 'default_bof', name: angle.name });
      return { created: true, externalId: angle.id };
    });

    const first = await seedDefaultBofAngleForProject(ccwProject, ccwDocs, {
      chatImpl,
      getAnglesImpl,
      seedImpl,
      idFactory: () => 'seed-1',
    });
    const second = await seedDefaultBofAngleForProject(ccwProject, ccwDocs, {
      chatImpl,
      getAnglesImpl,
      seedImpl,
      idFactory: () => 'seed-2',
    });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, reason: 'bof_exists' });
    expect(inserted).toHaveLength(1);
    expect(chatImpl).toHaveBeenCalledTimes(1);
  });
});

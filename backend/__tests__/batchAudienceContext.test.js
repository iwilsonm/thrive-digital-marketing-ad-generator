import { describe, expect, it } from 'vitest';
import { getProjectAudienceContext } from '../services/adGenerator.js';

describe('batch audience context derivation', () => {
  it('uses project/avatar context for non-DTC offers without default demographic assumptions', () => {
    const context = getProjectAudienceContext(
      {
        name: 'Christian Counsellor Webinar',
        brand_name: 'TOV',
        niche: '',
        product_description: 'A free webinar helping Christians compare counselling paths before training.',
      },
      {
        avatar: {
          content: `## Demographic & General Information
Christians who feel called to help others through counseling, ministry care, or pastoral support. They are comparing Christian counselling certificate, licensure, and ministry paths before committing time and money.`,
        },
      }
    );

    expect(context).toContain('Christian');
    expect(context).toMatch(/counsel(?:l)?ing/i);
    expect(context).not.toContain('women 55-75');
    expect(context).not.toContain('DTC health/wellness');
  });

  it('preserves explicit supplement and demographic context when the project docs say so', () => {
    const context = getProjectAudienceContext(
      {
        name: 'Joint Relief',
        brand_name: 'Joint Relief',
        niche: 'supplements',
        product_description: 'A joint support supplement.',
      },
      {
        avatar: {
          content: `## Demographics
Women 55-75 who buy supplements for joint comfort and want proof before trying another product.`,
        },
      }
    );

    expect(context).toContain('supplements');
    expect(context).toContain('Women 55-75');
    expect(context).toContain('joint comfort');
  });
});

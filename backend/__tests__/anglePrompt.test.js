import { describe, expect, it } from 'vitest';
import { buildAnglePromptText } from '../../frontend/src/utils/anglePrompt.js';
import { parseAnglesMarkdown } from '../utils/angleParser.js';

describe('Copy LLM Prompt angle template', () => {
  it('renders curated teaser-first workflow instructions while preserving import headings', () => {
    const prompt = buildAnglePromptText({
      brand: 'TOV',
      productName: 'Christian Counsellor Webinar',
      niche: 'Christian counselling education',
      productDesc: 'A free webinar helping Christians compare counselling paths before training.',
      salesPageContent: 'Register for a free clarity webinar about Christian counselling paths.',
      foundationalDocs: [
        { doc_type: 'avatar', content: 'Christians who feel called to help but are unsure whether to sign up for training.' },
        { doc_type: 'offer_brief', content: 'The next step is a free webinar registration.' },
      ],
    });

    expect(prompt).toContain('COLD-SCROLL CONTEXT (READ BEFORE GENERATING)');
    expect(prompt).toContain('Facebook and Instagram ads for **cold scroll traffic**');
    expect(prompt).toContain('the recurring pattern the buyer recognizes in themselves');
    expect(prompt).toContain('ongoing experience or feeling, not a specific isolated moment');
    expect(prompt).toContain('the emotional truth and recurring lived experience the ad anchors to');
    expect(prompt).toContain('AI RENDERING WARNING');
    expect(prompt).toContain('If a fragment shouldn\'t appear verbatim in a 5-word Facebook headline');
    expect(prompt).toContain('LIGHT TEASER FORMAT');
    expect(prompt).toContain('Return exactly 10 teasers');
    expect(prompt).toContain("Tell me which ones you'd like to keep on your shortlist");
    expect(prompt).toContain("'keep 1, 4, 7'");
    expect(prompt).toContain("'create the markdown'");
    expect(prompt).toContain('running shortlist');
    expect(prompt).toContain('Added to shortlist: [names]. Shortlist total: N angles');
    expect(prompt).toContain("Tell me which to keep, or ask for 10 more, or say 'create the markdown' to expand your shortlist.");
    expect(prompt).toContain('expand 1, 4, 7');
    expect(prompt).toContain('backwards-compatible');
    expect(prompt).toContain('direct expansion ONLY for those specific numbers from the most recent teaser batch');
    expect(prompt).toContain('10 fresh teasers');
    expect(prompt).toContain('including kept and discarded ideas');
    expect(prompt).toContain('Fresh ground is getting thin');
    expect(prompt).toContain('Begin now with exactly 10 light teasers, then end with a brief CTA telling me what to do next.');
    expect(prompt).toContain('[avatar]');
    expect(prompt).toContain('Register for a free clarity webinar');

    expect(prompt).not.toContain('the exact lived experience the ad centers on. Not a category');
    expect(prompt).not.toContain('the concrete physical scene the ad visually and narratively anchors to');
    expect(prompt).not.toContain('Return **8 distinct angles**');
    expect(prompt).not.toContain('No preamble');

    for (const section of [
      'BRAND CONTEXT',
      'COLD-SCROLL CONTEXT (READ BEFORE GENERATING)',
      'WHAT AN ANGLE IS',
      'AI RENDERING WARNING',
      'LIGHT TEASER FORMAT',
      'WEAK VS BETTER LIGHT TEASERS',
      'EXPANDED MARKDOWN FORMAT — COPY EXACTLY',
    ]) {
      expect(prompt).toContain(section);
    }

    for (const heading of [
      '### Core Buyer',
      '### Symptom Pattern',
      '### Failed Solutions',
      '### Current Belief',
      '### Objection',
      '### Emotional State',
      '### Scene to Center the Ad On',
      '### Desired Belief Shift',
      '### Tone',
      '### Avoid',
    ]) {
      expect(prompt).toContain(heading);
    }
  });

  it('keeps fenced expanded markdown compatible with the existing structured angle parser', () => {
    const markdown = `\`\`\`markdown
## Called To Help Cold Traffic

- **Status**: active
- **Priority**: highest
- **Frame**: identity-first

### Core Buyer
Christians who feel called to help hurting people but are not sure what wise training should look like.

### Symptom Pattern
They keep noticing people bring them heavy problems and feel the weight of wanting to help well.

### Failed Solutions
They have asked church friends and browsed broad counselling advice, but still need a clear next step.

### Current Belief
They think the next step must be choosing a full program.

### Objection
They will scroll past if it sounds like a hard-sell admissions pitch.

### Emotional State
Cautious, hopeful, and protective of their time.

### Scene to Center the Ad On
Feels the responsibility of being someone others trust, but wants clarity before choosing a path.

### Desired Belief Shift
After this ad, they should believe that a free clarity step can come before enrollment.

### Tone
Calm, plainspoken, faithful, pressure-free.

### Avoid
No timestamps. No kitchen-table tabs. No urgency hype.

---
\`\`\``;

    const [angle] = parseAnglesMarkdown(markdown);

    expect(angle.name).toBe('Called To Help Cold Traffic');
    expect(angle.status).toBe('active');
    expect(angle.priority).toBe('highest');
    expect(angle.frame).toBe('identity-first');
    expect(angle.symptom_pattern).toContain('people bring them heavy problems');
    expect(angle.scene).toContain('responsibility of being someone others trust');
    expect(angle.avoid_list).toContain('No kitchen-table tabs');
  });
});

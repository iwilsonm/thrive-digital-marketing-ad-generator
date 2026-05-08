import { describe, expect, it } from 'vitest';
import { buildAnglePromptText } from '../../frontend/src/utils/anglePrompt.js';
import { parseAnglesMarkdown } from '../utils/angleParser.js';

describe('Copy LLM Prompt angle template', () => {
  it('renders cold-scroll-aware angle instructions while preserving import headings', () => {
    const prompt = buildAnglePromptText({
      brand: 'TOV',
      productName: 'Christian Counsellor Webinar',
      niche: 'Christian counselling education',
      productDesc: 'A free webinar helping Christians compare counselling paths before training.',
    });

    expect(prompt).toContain('COLD-SCROLL CONTEXT (READ BEFORE GENERATING)');
    expect(prompt).toContain('Facebook and Instagram ads for **cold scroll traffic**');
    expect(prompt).toContain('the recurring pattern the buyer recognizes in themselves');
    expect(prompt).toContain('ongoing experience or feeling, not a specific isolated moment');
    expect(prompt).toContain('the emotional truth and recurring lived experience the ad anchors to');
    expect(prompt).toContain('AI RENDERING WARNING');
    expect(prompt).toContain('If a fragment shouldn\'t appear verbatim in a 5-word Facebook headline');
    expect(prompt).toContain('BEFORE / AFTER REFERENCE');

    expect(prompt).not.toContain('the exact lived experience the ad centers on. Not a category');
    expect(prompt).not.toContain('the concrete physical scene the ad visually and narratively anchors to');

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

  it('keeps the markdown contract compatible with the existing structured angle parser', () => {
    const markdown = `## Called To Help Cold Traffic

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

---`;

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

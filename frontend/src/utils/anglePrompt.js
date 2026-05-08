/**
 * Builds a self-contained LLM prompt that, when pasted into ChatGPT/Claude, asks the
 * model to return a markdown file matching the exact format the "Import Angles" flow
 * parses. The produced markdown can be saved as .md and dropped into the Import panel.
 *
 * Output format reference: angle import expects:
 *   ## <Angle Name>
 *   - **Status**: active
 *   - **Priority**: highest|high|medium|test
 *   - **Frame**: symptom-first|scam|objection-first|identity-first|MAHA|news-first|consequence-first
 *   ### Core Buyer
 *   ### Symptom Pattern
 *   ### Failed Solutions
 *   ### Current Belief
 *   ### Objection
 *   ### Emotional State
 *   ### Scene to Center the Ad On
 *   ### Desired Belief Shift
 *   ### Tone
 *   ### Avoid
 *   ---
 *   (next angle...)
 */
export function buildAnglePromptText({ brand, productName, niche, productDesc }) {
  const productLine = productName && brand && productName !== brand
    ? `${brand} — ${productName}`
    : brand;

  return `You are a world-class direct-response copywriter brainstorming Facebook ad angles for the brand below.

Return **8 distinct angles** as a single markdown document, formatted *exactly* as specified at the bottom of this message. The markdown will be imported verbatim into an ad-generation system; any deviation from the format will cause angles to be silently dropped.

=============================
BRAND CONTEXT
=============================
Brand: ${productLine}
Niche / market: ${niche}
Product description: ${productDesc}

=============================
COLD-SCROLL CONTEXT (READ BEFORE GENERATING)
=============================
These angles will be used by an AI ad-generation system to produce Facebook and Instagram ads for **cold scroll traffic**. The viewer has never heard of this offer. They have no context about the brand. They have 1-2 seconds to decide whether to stop scrolling.

The AI takes your structured fields literally — it will render scene fragments and specific moments into headline text as-is. That's a problem when those fragments only make sense to someone already in the funnel.

Write your angles as if every field could end up in a headline that has to make sense to a complete stranger. Recurring patterns travel better than specific moments. Universal recognition signals travel better than insider scene props.

=============================
WHAT AN ANGLE IS
=============================
An "angle" is a single creative lens — a specific emotional story, buyer identity, or belief shift — that a whole ad set can be generated around. A good angle set covers the same product from meaningfully different emotional entry points.

Each angle must include these 14 properties:

1. **Name** — a short, evocative label (4-10 words). Use the ad's core idea, not the product. Example: "The 2 AM Wake-Up Nobody Talks About".

2. **Status** — always "active" for new angles.

3. **Priority** — one of: \`highest\`, \`high\`, \`medium\`, \`test\`. Use "highest" for 1-2 angles you're most confident about; "high" for solid bets; "medium" for supporting angles; "test" for exploratory ideas.

4. **Frame** — the persuasion archetype. Choose exactly one of:
   - \`symptom-first\` — open with a visceral specific symptom the buyer is living through
   - \`scam\` — the incumbent industry is misleading them; here's the truth
   - \`objection-first\` — address the #1 skepticism up front and flip it
   - \`identity-first\` — speak to who they believe they are ("People like us don't need…")
   - \`MAHA\` — Make America Healthy Again / populist-health framing (skip if not health-adjacent)
   - \`news-first\` — a recent finding, study, or event justifies the product
   - \`consequence-first\` — lead with the cost of inaction

5. **Core Buyer** — 1-2 sentences describing who this specific ad is for. Be concrete, but use cold-scroll recognition signals: identity, life stage, role, belief, or problem language the buyer would recognize immediately. Include age, gender, or income only when truly relevant.

6. **Symptom Pattern** — the recurring pattern the buyer recognizes in themselves — an ongoing experience or feeling, not a specific isolated moment. It should travel out of context: a cold scroller seeing this language should feel "that's me" before they have any context about the offer.
   Bad: "last Tuesday at 2:47 AM, lay there for two hours, watching the clock" (specific moment, becomes literal headline material).
   Good: "most weeknights, lies awake calculating hours until the alarm, can't shake the loop once it starts" (recurring pattern, recognizable).
   2-4 sentences.

7. **Failed Solutions** — what they've already tried that hasn't worked. Be specific, but favor recognizable categories over one-off props. 1-3 sentences or a short bulleted list in prose form.

8. **Current Belief** — the limiting or incorrect belief they hold right now about the problem or about offers like this one. 1-2 sentences.

9. **Objection** — the single strongest reason this buyer would scroll past this ad. 1 sentence.

10. **Emotional State** — the dominant feeling when the ad catches them in cold scroll. Specific emotion words — "weary resignation", "quiet panic", "self-blame", not "bad" or "sad". 1 sentence.

11. **Scene to Center the Ad On** — the emotional truth and recurring lived experience the ad anchors to, expressed as something the buyer would recognize in themselves before they're in any specific moment. This is source material for the AI's emotional voice — not headline material.
   Bad: "flipping between three browser tabs at the kitchen table at 10:38 PM" (specific moment + props that become literal headline).
   Good: "caught in the middle of researching, can't tell which path is real, doesn't trust any single source" (recurring pattern, emotional truth, recognizable to cold scroll).
   1-2 sentences.

12. **Desired Belief Shift** — the single belief this angle needs to move the buyer toward. Complete the sentence: "After this ad, they should believe that ___." 1 sentence.

13. **Tone** — 3-6 adjectives describing the voice. Example: "Calm, specific, skeptical-friendly, free of hype."

14. **Avoid** — 2-5 specific things the copy or visuals must not do. Include any literal scene fragments, jargon, proof claims, or urgency tactics that would confuse cold scroll. Example: "No specific timestamps. No kitchen-table/tab literalism. No 'secret trick' phrasing."

=============================
AI RENDERING WARNING
=============================
This document is consumed by an AI rendering system, not a human copywriter. The AI takes things literally and will render scene fragments and specific phrases into headline text as-is. If a fragment shouldn't appear verbatim in a 5-word Facebook headline, don't put it in the angle.

AVOID:
- Specific timestamps (2:47 AM, 10:38 PM, last Tuesday)
- Hyper-specific scene props (kitchen table, three browser tabs, parked car, fee page)
- Insider jargon the cold scroller doesn't share (admissions pitch, ministry-vs-licensure)
- Anything requiring creative translation to make sense in a 5-word headline

USE:
- Recurring patterns ("most evenings," "every time," "whenever they...")
- Emotional truths the buyer recognizes ("the weight of being the helper," "the dread of choosing wrong")
- Universal recognition signals ("Christians who feel called to help," "people the church turns to")

=============================
RULES FOR THE ANGLE SET
=============================
- 8 angles total. No fewer.
- Every angle must use a different **Frame** if possible. If you repeat a Frame, the Core Buyer or Symptom Pattern must be meaningfully different.
- No two angles may share the same Symptom Pattern or the same Scene.
- At least one angle each at priority "highest" and "high". Up to two "test".
- Write in plain, specific English. No marketing-ese. No hype. No em-dashes as hedges.
- Every angle should contain at least one cold-scroll audience signal that a stranger could recognize without knowing the brand first.
- If a field would be empty, put a concrete guess — never "N/A" or "(none)".

=============================
BEFORE / AFTER REFERENCE
=============================
Weak angle field:
Scene to Center the Ad On: "At 10:38 PM, she sits at the kitchen table with three browser tabs open, comparing ministry certificates and licensure pages."

Why it fails: the AI may turn this into a headline about "10:38 PM" or "three tabs," which only makes sense to someone already deep in research.

Better angle field:
Scene to Center the Ad On: "Feels called to help, but keeps running into conflicting paths and doesn't know which one is credible, wise, or realistic."

Why it works: the emotional truth is clear enough for cold scroll and does not require the AI to translate specific props.

=============================
OUTPUT FORMAT — COPY EXACTLY
=============================
Return the full document as a single markdown code block. For each angle, use this exact structure. Separate angles with a line containing only three dashes on its own line.

\`\`\`markdown
## <Angle Name>

- **Status**: active
- **Priority**: <highest|high|medium|test>
- **Frame**: <symptom-first|scam|objection-first|identity-first|MAHA|news-first|consequence-first>

### Core Buyer
<text>

### Symptom Pattern
<text>

### Failed Solutions
<text>

### Current Belief
<text>

### Objection
<text>

### Emotional State
<text>

### Scene to Center the Ad On
<text>

### Desired Belief Shift
<text>

### Tone
<text>

### Avoid
<text>

---

## <Next Angle Name>

... (same 10 sections, then another \`---\`)
\`\`\`

Produce the document now. No preamble, no commentary — just the markdown.`;
}

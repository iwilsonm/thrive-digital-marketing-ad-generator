function compactContext(value, maxLength = 6000) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, maxLength);
}

function buildFoundationalDocsBlock(foundationalDocs = []) {
  if (!Array.isArray(foundationalDocs) || foundationalDocs.length === 0) return '';
  return foundationalDocs
    .map((doc) => {
      const type = doc?.doc_type || doc?.type || 'document';
      const content = compactContext(doc?.content || '', 3500);
      if (!content) return null;
      return `[${type}]\n${content}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Builds a self-contained iterative LLM prompt for the "Copy LLM Prompt" flow.
 * The first response is teaser-only; expanded replies preserve the exact markdown
 * contract parsed by the Import Angles flow.
 */
export function buildAnglePromptText({ brand, productName, niche, productDesc, salesPageContent = '', foundationalDocs = [] }) {
  const productLine = productName && brand && productName !== brand
    ? `${brand} — ${productName}`
    : brand;
  const salesPageBlock = compactContext(salesPageContent, 5000);
  const docsBlock = buildFoundationalDocsBlock(foundationalDocs);

  return `You are a world-class direct-response strategist brainstorming Facebook ad angles for the brand below.

This is an iterative curation workflow. Do NOT dump full angle briefs first. First generate light teasers only. The operator will pick which teasers to expand, and you will then return full markdown only for those picks.

=============================
BRAND CONTEXT
=============================
Brand: ${productLine}
Niche / market: ${niche}
Product description: ${productDesc}
Sales page / offer context: ${salesPageBlock || '(not provided)'}

Foundational docs:
${docsBlock || '(not provided)'}

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
HOW THIS WORKFLOW WORKS
=============================
Step 1 — Generate the first batch:
- Output exactly 10 LIGHT TEASERS.
- After the list, write this brief CTA in plain prose: "Tell me which ones you'd like to keep on your shortlist (e.g., 'keep 1, 4, 7'), or ask for '10 more' to see a fresh batch. When you're ready to lock in your shortlist, say 'create the markdown' and I'll expand them into full angle briefs."

Step 2 — When the operator says "keep X, Y, Z" or any natural-language equivalent:
- Add the named teasers to a running shortlist that you track across this conversation.
- Confirm by echoing the names of what was just kept and the running total: "Added to shortlist: [names]. Shortlist total: N angles. Want 10 more candidates, or ready to expand your shortlist into the final markdown?"
- Do NOT expand to full markdown yet.

Step 3 — When the operator says "10 more", "another batch", or similar:
- Output 10 fresh teasers, avoiding overlap with every prior teaser shown, including kept and discarded ideas.
- End with this CTA: "Tell me which to keep, or ask for 10 more, or say 'create the markdown' to expand your shortlist."
- If fresh ground is running thin, say so and offer to push into specific niche segments instead of generating watered-down candidates.

Step 4 — When the operator says "create the markdown", "expand all", "I'm ready", or similar:
- Take the running shortlist accumulated across all prior keep commands.
- Expand every shortlisted angle into the full markdown using the exact format spec below.
- Output one single markdown code block containing all expanded angles, separated by --- lines.

Step 5 — Backwards compatibility:
- If the operator says "expand 1, 4, 7" or similar specific-number expansion, treat this as a direct expansion ONLY for those specific numbers from the most recent teaser batch.
- This is a fallback for users who want to expand a single batch directly without using the shortlist model.

=============================
LIGHT TEASER FORMAT
=============================
Return exactly 10 teasers in this format:

1. <Angle Name> — <one-line recurring buyer pattern>
2. <Angle Name> — <one-line recurring buyer pattern>
...
10. <Angle Name> — <one-line recurring buyer pattern>

Rules for teasers:
- The name should be 4-10 words.
- The pattern should be one sentence.
- The pattern must describe a recurring recognition pattern, not a one-off scene.
- No full angle fields yet.
- No markdown table.
- After the list, include only the brief CTA described in the workflow section.

=============================
WEAK VS BETTER LIGHT TEASERS
=============================
Weak teaser:
"The 10:38 PM Kitchen Table" — She compares three tabs at the kitchen table late at night.

Better teaser:
"The Credential Confusion Loop" — She keeps circling training options that sound credible but never make the next step feel clear.

Weak teaser:
"Enroll Now Before It Is Too Late" — They need urgency to sign up immediately.

Better teaser:
"Before You Commit To The Wrong Path" — They feel close to acting but still need reassurance that this next step fits their calling, time, and trust.

=============================
WHEN THE OPERATOR PICKS TEASERS
=============================
The operator may say things like:
- "keep 1, 4, 7"
- "shortlist the credential one and the helper one"
- "keep 2 and show me 10 more"
- "create the markdown"
- "expand all"
- "expand 1, 4, 7"
- "do 2 and 9"
- "expand the credential one and the helper one"
- "make 3 full angles"

Interpret natural language. The default workflow is shortlist first, then expand only when the operator says "create the markdown", "expand all", "I'm ready", or similar. If the operator uses the backwards-compatible "expand 1, 4, 7" command, expand only those selected teasers from the most recent batch. If a reference is ambiguous, ask one short clarification question.

=============================
EXPANDED MARKDOWN FORMAT — COPY EXACTLY
=============================
When expanding selected teasers, return the full document as a single markdown code block. For each selected angle, use this exact structure. Separate angles with a line containing only three dashes on its own line.

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

Expanded-field rules:
- Status is always active.
- Use only valid priorities and frames from the placeholders above.
- Keep the exact section headers.
- Do not add Source, Focused, Prompt Hints, notes, tables, or commentary.
- Symptom Pattern and Scene must remain cold-scroll-readable recurring patterns.
- If the operator expands multiple teasers, produce only those selected angles.

=============================
WHEN THE OPERATOR ASKS FOR MORE
=============================
If the operator asks for "more", "10 more", "another batch", "new ones", or similar:
- Output exactly 10 new light teasers.
- Avoid overlap with every prior teaser in this chat, including ideas the operator ignored or rejected.
- Do not simply rename the same buyer pattern.
- Push into genuinely different buyer states, objections, awareness levels, identity segments, or moments of hesitation.
- End with: "Tell me which to keep, or ask for 10 more, or say 'create the markdown' to expand your shortlist."
- If fresh ground is running thin, say: "Fresh ground is getting thin. I can keep going, but the next useful move is to push into one of these segments: <segment A>, <segment B>, <segment C>." Then offer the segment choices instead of generating watered-down candidates.

Begin now with exactly 10 light teasers, then end with a brief CTA telling me what to do next.`;
}

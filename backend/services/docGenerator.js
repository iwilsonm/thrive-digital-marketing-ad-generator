import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chat, chatStream } from './openai.js';
import { chat as claudeChat } from './anthropic.js';
import { getProject, getLatestDoc, updateProject, convexClient, api, invalidateQueryCache } from '../convexClient.js';

const __docgen_dirname = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH_METHODOLOGY_PROMPT = fs.readFileSync(
  path.join(__docgen_dirname, 'prompts', 'research-methodology.txt'),
  'utf-8'
);

// The 8 prompts from the SOP, organized as functions that return prompt text.
// Steps 1-3 produce the research prompt (prep work via GPT-4.1).
// Step 4 is completed manually by the user in ChatGPT/Claude Deep Research.
// Step 5 produces the Avatar Sheet (synthesis via GPT-4.1).
// Step 6 produces the Offer Brief (synthesis via GPT-4.1).
// Step 7 is the E5/Agora methodology training (no saved output, GPT-4.1).
// Step 8 produces the Necessary Beliefs (synthesis via GPT-4.1).

function prompt1_AnalyzeSalesPage(productDescription, salesPageContent) {
  const productDescriptionText = (productDescription || '').trim() || '[INSERT DESCRIPTION OF YOUR PRODUCT]';
  const intro = `You are my expert copywriter and you specialize in writing highly persuasive direct response style copy for my brand. The product I'm advertising can be described as: ${productDescriptionText}. Here's detailed information about the product I'm advertising. I want you to analyze it and please let me know your thoughts.`;
  const trimmed = (salesPageContent || '').trim();
  return trimmed ? `${intro}\n\n${trimmed}` : intro;
}

function prompt2_ResearchMethodology() {
  return RESEARCH_METHODOLOGY_PROMPT;
}

function prompt3_GenerateResearchPrompt(productName) {
  return `Great, now that you properly understand how to conduct research, I want you to create a full prompt to actually conduct this research for the ${productName}. Please be as specific as possible here in order to get the best quality research. Please include that you want the research compiled into a doc as well, and it should be a minimum of 6 pages worth of research.`;
}

function prompt5_AvatarSheet() {
  return `Amazing work! Now that you have properly completed the research portion, I want you to please complete this Avatar sheet template:

# [BRAND NAME] AVATAR SHEET TEMPLATE

## Demographic & General Information
- Age Range:
- Gender:
- Location:
- Monthly Income/Spending Power:
- Professional Backgrounds:
- Typical Identities (how they see themselves — use first-person "I am..." framing):

## Key Challenges & Pain Points
(Identify 3-5 major challenge categories. Under each, list specific manifestations with detail and emotional weight.)

### 1. [Challenge Category Name]
- [Specific manifestation with emotional detail]
- [Specific manifestation with emotional detail]
- [Specific manifestation with emotional detail]

### 2. [Challenge Category Name]
- [Specific manifestation with emotional detail]
- [Specific manifestation with emotional detail]

### 3. [Challenge Category Name]
- [Specific manifestation with emotional detail]
- [Specific manifestation with emotional detail]

## Goals & Aspirations
### Short-Term Goals (2-4 weeks):
-
-
### Long-Term Goals (3-12 months):
-
-
### Ultimate Dream State:
-

## Emotional Drivers & Psychological Insights
(List 6-10 deep psychological insights about what truly drives this person. Go beyond surface-level — what are the hidden motivations, identity needs, and emotional triggers?)
1.
2.
3.

## Direct Client Quotes
(Use verbatim language from research. Do NOT paraphrase. Organize by category.)

### General Quotes:
- "..."
- "..."

### Pain Points & Frustrations Quotes:
- "..."
- "..."

### Mindset Quotes:
- "..."
- "..."

### Emotional State Quotes:
- "..."
- "..."

### Emotional Responses to Struggles Quotes:
- "..."
- "..."

### Motivation & Urgency Quotes:
- "..."
- "..."

## Key Emotional Fears
(List 4-6 deep fears. These are not surface-level — these are the fears they think about at 2am.)
1.
2.
3.

## Psychographic Insights
(What are their core beliefs about themselves, their problem, and the world? What tribal markers do they have? What do they trust and distrust?)
-
-

## Typical Emotional Journey
Map the journey from first awareness to purchase:

### Stage 1: Awareness
(What triggers them to notice the problem? Internal monologue, behaviors, feelings.)

### Stage 2: Frustration
(What have they tried? Why did it fail? How do they feel about the failures?)

### Stage 3: Desperation
(What is the breaking point? What makes them actively search for a new solution?)

### Stage 4: Relief
(What does finding the right solution feel like? What do they say/think/feel?)

## Avatar Summary
- Avatar Name: [Give them a name]
- One-Line Summary: [Single sentence capturing the essence of this person]`;
}

function prompt6_OfferBrief() {
  return `Great work! Now that you've finished that, I want you to complete this offer brief document template for this product:

# [BRAND NAME] OFFER BRIEF TEMPLATE

## Potential Product Name Ideas
(List 8-10 potential product names with brief rationale for each. Include recommendation.)
1.
2.

## Level of Consciousness
(How aware is the market that they have a problem? HIGH / MEDIUM / LOW. Explain with evidence from the research.)

## Level of Awareness
(Where is the market on Eugene Schwartz's 5 levels?)
1. Unaware — Don't know they have a problem
2. Problem Aware — Know they have a problem but not that solutions exist
3. Solution Aware — Know solutions exist but not THIS solution
4. Product Aware — Know about this product but haven't bought yet
5. Most Aware — Know the product, just need a deal

Current Level: ___
Evidence: ___
Implication for Copy: ___

## Stage of Sophistication
(Where is the market on the sophistication scale?)
1. First to market — Simple direct claim works
2. Second wave — Enlarge the claim (bigger, better, faster)
3. Mechanism stage — Must explain WHY it works differently
4. Exhausted — Need a new mechanism or angle
5. Highly skeptical — Need identification/story-driven approach

Current Stage: ___
Evidence: ___
Implication for Copy: ___

## Big Idea
(The single overarching concept that frames the entire marketing campaign. It should reframe the problem in a way the prospect hasn't considered.)

## Metaphor
(The primary metaphor or analogy that makes the big idea tangible and memorable.)

## UMP — Unique Mechanism of the Problem
(Why does the prospect ACTUALLY have this problem? Not the surface-level explanation — the deeper mechanism that reframes their understanding of why they're stuck.)

## UMS — Unique Mechanism of the Solution
(How does this product solve the problem in a way that is fundamentally different from everything else? What is the proprietary mechanism, method, or approach?)

## Guru / Authority Figure
(Who is the credible authority behind the product? Their story, credentials, why they should be trusted.)

## Discovery Story
(The narrative of how this solution was discovered or created. This should be compelling, specific, and emotionally resonant.)

## Product Description
(What the product actually is — features, format, delivery, components.)

## Headline / Subheadline Ideas
(List 10-15 headline options based on the big idea, mechanism, and key angles from research.)
1.
2.

## All Objections
(List every possible objection a prospect might have. Be exhaustive — include logical, emotional, and irrational objections.)
1.
2.

## Belief Chains
(For each major objection, map the sequence of beliefs that must be established to overcome it.)

Objection: ___
Belief Chain: ___ → ___ → ___ → Resolution

## Funnel Architecture
(Recommended funnel structure — traffic source, landing page type, upsell sequence, email follow-up.)

## Potential Domains
(List 5-10 domain name ideas for the product/brand.)

## Examples / Swipes
(Reference any competitor campaigns, ads, or copy that could serve as inspiration or models.)

## Other Notes
(Anything else relevant to the offer positioning, pricing, guarantees, bonuses, scarcity elements, etc.)`;
}

function prompt7_E5AgoraMethodology() {
  return `Great work! Now, please analyze this transcript and let me know your thoughts:

Please analyze this full video transcript and let me know your thoughts:

--- E5/AGORA COPYWRITING METHODOLOGY TRANSCRIPT ---

There is a fundamental difference in the copywriting approach that is taught and used at Agora that I fell in love with that really became kind of the Genesis or the foundation of the E5 method and the copywriting method that is most often taught in the internet marketing world. There is a fundamental difference and that fundamental difference really impedes the progress of most of the copywriters or most of the people that try to learn copywriting from the IM approach.

You see, the internet marketing approach and the way that copy was kind of always taught was really based on the foundation of magnificent word choice. It was all about the words that you used. It was all about the phrases that you used. "The incredible steroid-like traffic generation system that brings a tsunami of buyers." It was all about the words. This idea that if I use these extremely exciting, compelling, almost hyperbolic words, that makes for good copy.

This is why back in the day, almost every single copywriting training — what did it come with? They almost always included a power word list. "These are power words: astonishing. Let me see how often I can sprinkle in astonishing throughout the copy. Magnet." All these power words. And so everybody became trained on words. It's the words.

That's why when Kyle was going through his swipes and examples, I was paying attention to the room. I could see people agonizing over, almost becoming overwhelmed with the copy. "Let me look at the copy. What did he say there? What's the word there? Is there a power word being used in there?"

And I said to you guys that it's not the words that I want you to pay attention to. It's not the words. The exact word choice that I want you to model and swipe — it's not the one phrase in the third sentence of the fourth paragraph that I want you to swipe. It's the structure.

Because I said that there's a fundamental difference in the copy approach that Agora uses compared to the IM world. In the IM world it's all about the magnificence of the words that you use. But in the Agora world, it's all about the magnificence of the argument. The magnificence of the argument.

What I think about is: it's about a compelling argument, not compelling words. Meaning I'm not trying to convince people that this is great because I use the word magnificent, amazing, fantastic, steroid-like. It's not compelling because of solely the words that I use. It's compelling first and foremost because I'm presenting an argument that you can't dispute. That logically, emotionally — I'm showing it to you where at the end, you are led to one conclusion and only one conclusion.

This is an important point for you to get because one of the things that I see often when I see critiques — one of the biggest mistakes or issues that I see is there is no structure. There is no argument being presented. It's kind of all over the place. They're saying a lot and saying nothing at the same time.

What I mean is: the way that I approach every campaign, every sales letter, every VSL is that there is a belief that I need my prospect to have before I introduce my product. A belief. A belief that if they have, my product then becomes the obvious next step. The obvious conclusion.

So the first thing that I do is I determine what is the belief that I need my prospect to have. What is the belief? And then everything that I do from the headline all the way through the body is built to lead them to that belief. Every section has a purpose. Every paragraph has a purpose. And the purpose is to advance the argument toward that belief.

It's like a North Star. If you know the belief that you need the prospect to hold before you introduce the offer, then you have a diagnostic tool to evaluate every single sentence. "Does this advance the argument? Does this move them closer to the belief? If not, cut it — no matter how well written."

And at the core of this is the concept of the unique mechanism. Because the way I position things is: I'm always introducing a proprietary solution. That solution falls under the heading of a unique mechanism. And then everything that I'm doing and saying and showing through education, through informing, is to show them what makes it different and most importantly what makes it better.

I'm just trying to present that airtight, rock solid emotional and logical argument. I love when John got up here and talked about the syllogism and argumentation. I almost started crying with joy inside.

The point that I'm really trying to make is: most folks are making their word choice the priority, the focus, the aim. Stop writing copy and start crafting arguments. Stop sitting down and putting on your copy cap and thinking "what's the next power word I can use?" Start with putting together rock solid, airtight logical and emotional arguments. Prove to the people that you've got something different and superior.

You want to go back later through the editing process and layer in better verbs, more powerful verbs? Cool. I'm not saying that words don't matter. I'm saying that words matter when layered on a foundation of a rock solid argument.

Be argument creators, not copy creators. Not copywriters — craft arguments first and foremost.

--- END OF TRANSCRIPT ---`;
}

function prompt8_NecessaryBeliefs(researchContent, avatarContent, offerBriefContent) {
  return `Great work! Now that you understand that marketing at its core is simply about changing the existing beliefs of a customer into the beliefs that align with them taking the next conversion action for this offer, I want you to please analyze the following documents about my prospect and write out the few absolutely necessary beliefs that a prospect must have before taking that next conversion action. It should be no more than 6 beliefs. I also want you to structure these as "I believe that…" statements. Go ahead.

RESEARCH DOCUMENT:
${researchContent}

AVATAR SHEET:
${avatarContent}

OFFER BRIEF:
${offerBriefContent}`;
}

// --- Step definitions ---
// Steps 1-3: Prep work (GPT-4.1 Chat Completions) — analyzes sales page and builds research prompt
// Step 4: Deep Research (o3-deep-research Responses API) — actual web research with browsing
// Steps 5-8: Synthesis (GPT-4.1 Chat Completions) — generates docs from research

const STEPS = [
  { id: 1, label: 'Analyzing Sales Page', savedAs: null, mode: 'chat' },
  { id: 2, label: 'Learning Research Methodology', savedAs: null, mode: 'chat' },
  { id: 3, label: 'Generating Research Prompt', savedAs: null, mode: 'chat' },
  { id: 4, label: 'Deep Research (Web Browsing)', savedAs: 'research', mode: 'deep_research' },
  { id: 5, label: 'Creating Avatar Sheet', savedAs: 'avatar', mode: 'chat' },
  { id: 6, label: 'Creating Offer Brief', savedAs: 'offer_brief', mode: 'chat' },
  { id: 7, label: 'Analyzing E5/Agora Methodology', savedAs: null, mode: 'chat' },
  { id: 8, label: 'Defining Necessary Beliefs', savedAs: 'necessary_beliefs', mode: 'chat' }
];

/**
 * Regenerate a single document.
 * Uses a focused context for each doc type to stay within token limits.
 * For synthesis docs (avatar, offer_brief, necessary_beliefs), builds a lean
 * context with only the prerequisite documents — not the full conversation history.
 * @param {string} projectId
 * @param {'research'|'avatar'|'offer_brief'|'necessary_beliefs'} docType
 * @param {(event: { type: string, step?: number, label?: string, [key: string]: any }) => void} onEvent
 * @returns {Promise<void>}
 */
export async function regenerateDoc(projectId, docType, onEvent) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  // Find which step produces this doc type
  const targetStep = STEPS.find(s => s.savedAs === docType);
  if (!targetStep) throw new Error(`Unknown doc type: ${docType}`);

  try {
    onEvent({ type: 'step_start', step: targetStep.id, label: targetStep.label, mode: targetStep.mode });

    if (targetStep.mode === 'deep_research') {
      throw new Error('Research is manual-only. Use the Manual Research Guide to replace the research document.');
    } else {
      // Chat-based synthesis steps — build a lean, focused context
      let messages;

      switch (targetStep.id) {
        case 5: {
          // Avatar Sheet: needs research doc
          const researchDoc = await getLatestDoc(projectId, 'research');
          if (!researchDoc) throw new Error('No research document found. Please generate research first.');
          messages = [
            { role: 'user', content: `You are my expert copywriter specializing in direct response copy for my brand. The offer being advertised is described as: ${project.product_description}. Here is the research document:\n\n${researchDoc.content}` },
            { role: 'assistant', content: 'I\'ve thoroughly reviewed the research document. Ready to proceed.' },
            { role: 'user', content: prompt5_AvatarSheet() }
          ];
          break;
        }
        case 6: {
          // Offer Brief: needs research doc + avatar
          const researchDoc = await getLatestDoc(projectId, 'research');
          const avatarDoc = await getLatestDoc(projectId, 'avatar');
          if (!researchDoc) throw new Error('No research document found. Please generate research first.');
          messages = [
            { role: 'user', content: `You are my expert copywriter specializing in direct response copy for my brand. The offer being advertised is described as: ${project.product_description}. Here is the research document:\n\n${researchDoc.content}` },
            { role: 'assistant', content: 'I\'ve thoroughly reviewed the research. Ready to proceed.' },
            { role: 'user', content: prompt5_AvatarSheet() },
            { role: 'assistant', content: avatarDoc?.content || 'Avatar sheet not yet created.' },
            { role: 'user', content: prompt6_OfferBrief() }
          ];
          break;
        }
        case 8: {
          // Necessary Beliefs: uses isolated context with all 3 docs injected directly
          const researchDoc = await getLatestDoc(projectId, 'research');
          const avatarDoc = await getLatestDoc(projectId, 'avatar');
          const offerDoc = await getLatestDoc(projectId, 'offer_brief');
          messages = [
            { role: 'user', content: prompt8_NecessaryBeliefs(
              researchDoc?.content || '',
              avatarDoc?.content || '',
              offerDoc?.content || ''
            )}
          ];
          break;
        }
        default:
          throw new Error(`Cannot regenerate step ${targetStep.id} individually`);
      }

      const fullResponse = await chatStream(messages, (chunk) => {
        onEvent({ type: 'chunk', step: targetStep.id, text: chunk });
      }, 'gpt-4.1', { operation: 'foundational_docs', projectId });

      await saveDoc(projectId, targetStep.savedAs, fullResponse);
      onEvent({ type: 'step_complete', step: targetStep.id, label: targetStep.label, savedAs: targetStep.savedAs });
    }

    onEvent({ type: 'complete' });
  } catch (err) {
    onEvent({ type: 'error', message: err.message });
    throw err;
  }
}

async function saveDoc(projectId, docType, content, source = 'generated') {
  const existing = await getLatestDoc(projectId, docType);
  const version = existing ? existing.version + 1 : 1;
  const id = uuidv4();

  await convexClient.mutation(api.foundationalDocs.create, {
    externalId: id,
    project_id: projectId,
    doc_type: docType,
    content,
    version,
    source,
  });
  invalidateQueryCache('foundational_docs');

  return id;
}

/**
 * Generate synthesis docs (Steps 5-8) from a manually-provided research document.
 * Skips the expensive deep research step — user provides their own research.
 *
 * @param {string} projectId
 * @param {string} researchContent - The user's manually-produced research text
 * @param {(event: object) => void} onEvent - SSE event emitter
 */
export async function generateFromManualResearch(projectId, researchContent, onEvent) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  await updateProject(projectId, { status: 'generating_docs' });

  // Save the manual research as the 'research' doc
  await saveDoc(projectId, 'research', researchContent, 'manual_research');
  onEvent({ type: 'step_complete', step: 4, label: 'Research (Manual Upload)', savedAs: 'research' });

  // Build synthetic chat context so Steps 5-8 have the same priming
  // they'd get in the automated flow
  const chatMessages = [
    {
      role: 'user',
      content: prompt1_AnalyzeSalesPage(
        project.product_description,
        project.sales_page_content
      )
    },
    {
      role: 'assistant',
      content: 'I have analyzed the sales page content thoroughly. I understand the product positioning, claims, and target audience. Ready to proceed.'
    },
    {
      role: 'user',
      content: prompt2_ResearchMethodology()
    },
    {
      role: 'assistant',
      content: 'I have studied both research methodology documents in detail. I understand the four-layer research framework (demographic/psychographic profile, existing solution landscape, curiosity/historical angles, and corruption/fall from Eden narratives) and the practical workflow for forum mining, review mining, and subject line harvesting. Ready to proceed.'
    },
    {
      role: 'user',
      content: prompt3_GenerateResearchPrompt(project.name)
    },
    {
      role: 'assistant',
      content: 'I have generated the research prompt. Let me proceed with the research.'
    },
    {
      role: 'user',
      content: `Here is the completed deep research document for our product. Please use this as the foundation for all subsequent analysis:\n\n${researchContent}`
    },
    {
      role: 'assistant',
      content: 'I have thoroughly reviewed the research document. It contains detailed market analysis and consumer insights. I\'m ready to use this research to create the Avatar Sheet, Offer Brief, and other foundational documents. Let\'s proceed.'
    }
  ];

  // Run only Steps 5-8 (synthesis)
  // Trim the synthetic context to just what's needed — drop the bulky methodology prompts
  // and keep only the role setup + research document
  chatMessages.length = 0;
  chatMessages.push(
    { role: 'user', content: `You are my expert copywriter specializing in direct response copy for my brand. The offer being advertised is described as: ${project.product_description}. I've completed deep market research. Here is the research document:\n\n${researchContent}` },
    { role: 'assistant', content: 'I\'ve thoroughly reviewed the research document. I can see the consumer insights, verbatim quotes, pain points, and market dynamics. I\'m ready to use this to create the foundational documents. Let\'s proceed.' }
  );

  const SYNTHESIS_STEPS = STEPS.filter(s => s.id >= 5);

  try {
    for (const step of SYNTHESIS_STEPS) {
      onEvent({ type: 'step_start', step: step.id, label: step.label, mode: step.mode });

      let promptText;
      let useIsolatedContext = false;

      switch (step.id) {
        case 5:
          promptText = prompt5_AvatarSheet();
          break;
        case 6:
          promptText = prompt6_OfferBrief();
          break;
        case 7:
          promptText = prompt7_E5AgoraMethodology();
          break;
        case 8: {
          // Use isolated context for Step 8 to avoid token overflow
          useIsolatedContext = true;
          const researchDoc = await getLatestDoc(projectId, 'research');
          const avatarDoc = await getLatestDoc(projectId, 'avatar');
          const offerDoc = await getLatestDoc(projectId, 'offer_brief');
          promptText = prompt8_NecessaryBeliefs(
            researchDoc?.content || '',
            avatarDoc?.content || '',
            offerDoc?.content || ''
          );
          break;
        }
      }

      const messages = useIsolatedContext
        ? [{ role: 'user', content: promptText }]
        : (chatMessages.push({ role: 'user', content: promptText }), chatMessages);

      const fullResponse = await chatStream(messages, (chunk) => {
        onEvent({ type: 'chunk', step: step.id, text: chunk });
      }, 'gpt-4.1', { operation: 'foundational_docs', projectId });

      if (!useIsolatedContext) {
        chatMessages.push({ role: 'assistant', content: fullResponse });
      }

      if (step.savedAs) {
        await saveDoc(projectId, step.savedAs, fullResponse);
      }

      onEvent({ type: 'step_complete', step: step.id, label: step.label, savedAs: step.savedAs });
    }

    await updateProject(projectId, { status: 'docs_ready' });
    onEvent({ type: 'complete' });
  } catch (err) {
    await updateProject(projectId, { status: 'setup' });
    onEvent({ type: 'error', message: err.message });
    throw err;
  }
}

// =============================================
// Copy Correction — scan docs and propose fixes
// =============================================

const DOC_TYPES = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
const DOC_LABELS_MAP = {
  research: 'Research Document',
  avatar: 'Avatar Sheet',
  offer_brief: 'Offer Brief',
  necessary_beliefs: 'Necessary Beliefs'
};

/**
 * Scan all foundational docs for claims matching a correction instruction and propose fixes.
 * @param {string} projectId
 * @param {string} correctionInstruction - e.g. "fix the claim about vitamin D deficiency"
 * @returns {Promise<{ corrections: Array<{ doc_type: string, doc_id: string, doc_label: string, old_text: string, new_text: string, context: string, full_updated_content: string }>, message: string }>}
 */
async function findAndCorrectDocs(projectId, correctionInstruction) {
  // 1. Fetch all latest docs
  const docEntries = [];
  for (const docType of DOC_TYPES) {
    const doc = await getLatestDoc(projectId, docType);
    if (doc && doc.content) {
      docEntries.push({ doc_type: docType, id: doc.id, content: doc.content });
    }
  }

  if (docEntries.length === 0) {
    return { corrections: [], message: 'No foundational documents found to search.' };
  }

  // 2. Build prompt — lightweight: only old_text/new_text, NO full_updated_content
  const systemPrompt = `You are a document correction assistant. You will receive foundational marketing documents and a correction instruction from the user.

Your job:
1. Search ALL documents for any claims, statements, or references that relate to the user's correction.
2. The incorrect information may be worded differently than how the user describes it. Use semantic understanding — look for the same CONCEPT, not just the same words.
3. For each instance found, produce the correction.
4. Return your response as a JSON object. Do NOT include any text outside the JSON.

CRITICAL RULES:
- Search ALL documents thoroughly. The same incorrect claim may appear in multiple documents.
- Make MINIMAL changes. Only fix the specific incorrect claim. Do NOT rewrite surrounding sentences.
- Preserve ALL markdown formatting, headers, bullet points, and structure exactly as-is.
- If you find NO instances of the incorrect information, return an empty corrections array.
- The "old_text" field must be an EXACT substring copy-pasted from the original document (including punctuation and whitespace). This is critical — it will be used for programmatic find-and-replace.
- The "new_text" field is what should replace the old_text.
- Keep old_text as SHORT as possible while being unique within the document. Include just enough surrounding context to be unambiguous.
- Do NOT include the full document in your response. Only return the specific old_text and new_text snippets.

Return this exact JSON structure:
{
  "corrections": [
    {
      "doc_type": "research|avatar|offer_brief|necessary_beliefs",
      "old_text": "exact substring from the original document",
      "new_text": "the corrected replacement text",
      "explanation": "Brief explanation of what was wrong and what was changed"
    }
  ],
  "message": "Brief summary of what was found and changed"
}`;

  let userContent = 'Here are the foundational documents:\n\n';
  for (const entry of docEntries) {
    userContent += `=== ${DOC_LABELS_MAP[entry.doc_type]} (doc_type: ${entry.doc_type}) ===\n${entry.content}\n\n`;
  }
  userContent += `---\n\nCORRECTION INSTRUCTION:\n${correctionInstruction}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  // 3. Call Claude Sonnet 4.6 with reduced max_tokens (corrections are small, not full docs)
  const raw = await claudeChat(messages, 'claude-sonnet-4-6', {
    response_format: { type: 'json_object' },
    max_tokens: 4096,
    timeout: 60000,    // 60s timeout — corrections should be fast
    maxRetries: 2,     // Fewer retries for interactive feature
    operation: 'doc_correction',
    projectId,
  });

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error('Failed to parse correction response from AI.');
  }

  if (!result.corrections || !Array.isArray(result.corrections)) {
    return { corrections: [], message: result.message || 'No corrections found.' };
  }

  // 4. For each correction, do programmatic find-and-replace (no full_updated_content needed)
  const enriched = [];
  for (const c of result.corrections) {
    const docEntry = docEntries.find(d => d.doc_type === c.doc_type);
    if (!docEntry) continue;
    if (!c.old_text || !c.new_text) continue;

    let finalContent;
    if (docEntry.content.includes(c.old_text)) {
      // Exact match — best case
      finalContent = docEntry.content.replace(c.old_text, c.new_text);
    } else {
      // Try trimmed match (model sometimes adds/removes leading/trailing whitespace)
      const trimmed = c.old_text.trim();
      if (trimmed && docEntry.content.includes(trimmed)) {
        finalContent = docEntry.content.replace(trimmed, c.new_text.trim());
      } else {
        // Try case-insensitive search for the first 40 chars to find approximate location
        const searchSnippet = trimmed.slice(0, 40).toLowerCase();
        const lowerContent = docEntry.content.toLowerCase();
        const idx = lowerContent.indexOf(searchSnippet);
        if (idx !== -1) {
          // Found approximate location — try to match a broader region
          const region = docEntry.content.slice(Math.max(0, idx - 20), idx + trimmed.length + 20);
          console.log(`[CopyCorrection] Fuzzy match needed for "${trimmed.slice(0, 50)}..." — found near index ${idx}`);
          // Use the old_text as-is but with the actual content from the document
          const actualOld = docEntry.content.slice(idx, idx + trimmed.length);
          finalContent = docEntry.content.replace(actualOld, c.new_text.trim());
        } else {
          console.log(`[CopyCorrection] Could not match old_text in ${c.doc_type}: "${c.old_text.slice(0, 60)}..."`);
          continue; // Skip — can't find the text to replace
        }
      }
    }

    enriched.push({
      doc_type: c.doc_type,
      doc_id: docEntry.id,
      doc_label: DOC_LABELS_MAP[c.doc_type],
      old_text: c.old_text,
      new_text: c.new_text,
      context: c.explanation || '',
      full_updated_content: finalContent
    });
  }

  return {
    corrections: enriched,
    message: enriched.length > 0
      ? `Found ${enriched.length} correction${enriched.length !== 1 ? 's' : ''} across ${new Set(enriched.map(c => c.doc_type)).size} document${new Set(enriched.map(c => c.doc_type)).size !== 1 ? 's' : ''}`
      : result.message || 'No matching claims found in any document.'
  };
}

export {
  STEPS,
  prompt1_AnalyzeSalesPage,
  prompt2_ResearchMethodology,
  prompt3_GenerateResearchPrompt,
  findAndCorrectDocs
};

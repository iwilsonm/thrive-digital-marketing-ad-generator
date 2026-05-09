import { v4 as uuidv4 } from 'uuid';
import { chat, extractJSON } from './anthropic.js';
import { getOfferRenderContext } from './adGenerator.js';
import { buildDescriptionFromBrief } from '../utils/angleParser.js';
import { getConductorAngles, seedDirectOfferAngle } from '../convexClient.js';

export const REQUIRED_DOC_TYPES = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
const VALID_FRAMES = ['symptom-first', 'scam', 'objection-first', 'identity-first', 'MAHA', 'news-first', 'consequence-first'];
const BANNED_DEFAULT_CLAIMS = ['Shop Now', '90-day guarantee', '10,000+ happy customers', 'free shipping'];

function text(value) {
  return String(value || '').trim();
}

function compact(value, maxLength = 8000) {
  return text(value).replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').slice(0, maxLength);
}

function docsArrayToMap(foundationalDocs = []) {
  const map = {};
  for (const doc of foundationalDocs || []) {
    const type = doc?.doc_type || doc?.type;
    if (!type) continue;
    map[type] = doc;
  }
  return map;
}

export function hasCompleteFoundationalDocs(foundationalDocs = []) {
  const map = docsArrayToMap(foundationalDocs);
  return REQUIRED_DOC_TYPES.every((type) => text(map[type]?.content));
}

function sourceCorpus(project = {}, foundationalDocs = []) {
  const docs = foundationalDocs.map((doc) => doc?.content || '').join('\n\n');
  return [
    project?.name,
    project?.brand_name,
    project?.niche,
    project?.product_description,
    project?.sales_page_content,
    docs,
  ].filter(Boolean).join('\n').toLowerCase();
}

function allowedBySource(keyword, project, foundationalDocs) {
  return sourceCorpus(project, foundationalDocs).includes(keyword.toLowerCase());
}

function assertNoUnjustifiedContamination(angle, project, foundationalDocs) {
  const output = JSON.stringify(angle).toLowerCase();
  const violations = BANNED_DEFAULT_CLAIMS.filter((keyword) => (
    output.includes(keyword.toLowerCase()) && !allowedBySource(keyword, project, foundationalDocs)
  ));
  if (violations.length > 0) {
    throw new Error(`Direct Offer seed contained unsupported ecommerce claims: ${violations.join(', ')}`);
  }
}

export function projectAlreadyHasDirectOfferAngle(angles = []) {
  return (angles || []).some((angle) => (
    angle?.source === 'direct_offer'
      || angle?.source === 'default_bof'
      || /^Direct Offer$/i.test(text(angle?.name))
      || /^BOF\b/i.test(text(angle?.name))
  ));
}

export function buildDirectOfferPrompt(project = {}, foundationalDocs = []) {
  const docs = docsArrayToMap(foundationalDocs);
  const offerRenderContext = getOfferRenderContext(project, docs);
  const docBlock = REQUIRED_DOC_TYPES
    .map((type) => `[${type}] ${compact(docs[type]?.content || '(missing)', 5000)}`)
    .join('\n');

  const system = `You generate a single "Direct Offer" angle for a direct-response ad platform. This is the default angle every project gets — its job is to drive headlines that name the audience, name the offer, and ask for the action. Plain English. No metaphors, no scene imagery, no narrative storytelling, no insider jargon.

Return only valid JSON in this exact shape:
{
  "name": "Direct Offer",
  "status": "active",
  "priority": "medium",
  "frame": "objection-first",
  "core_buyer": "...",
  "symptom_pattern": "...",
  "failed_solutions": "...",
  "current_belief": "...",
  "objection": "...",
  "emotional_state": "...",
  "scene": "...",
  "desired_belief_shift": "...",
  "tone": "...",
  "avoid_list": "...",
  "prompt_hints": "..."
}

Field rules:

- core_buyer: Name the audience plainly. "[Identity] who are considering [offer/topic]." No demographic narrative.
- symptom_pattern: One direct sentence — what they'd say if asked "what are you trying to figure out?" NOT an emotional pattern, NOT a scene.
- failed_solutions: One line. Context, not headline material.
- current_belief: One line.
- objection: One line — their main hesitation about clicking the offer.
- emotional_state: One line — but not used as scene material.
- scene: CRITICAL — this field most strongly biases headline generation. Do NOT describe a literal moment, kitchen table, home desk, notepad, Bible-nearby, etc. Instead, describe the cold-scroll moment instructionally: "The moment they see the ad in feed: they have no prior context, they have 1-2 seconds to decide whether to stop. The headline must name who it's for and what's offered so they can decide instantly." Treat this field as instructional metadata to the headline generator, not narrative.
- desired_belief_shift: One line — what the ad should accomplish.
- tone: "Direct, plain, action-oriented. No hype, no metaphors, no narrative voice. Like a Facebook ad that names the offer."
- avoid_list: Explicit prohibitions. Include verbatim: "Scene-bound metaphors (kitchen-table, home-desk, notepad, Bible-nearby imagery), insider marketing jargon (funnel, pitch, pipeline), narrative storytelling, hyper-specific moments or props, second-person scene descriptions, anything that requires creative translation to make sense in a 5-word headline. Headlines should name the audience, name the offer plainly, and let the offer do the asking."
- prompt_hints: Clean image direction appropriate to the offer rendering context. Service businesses → text-forward, audience-relevant imagery, clear CTA. Ecommerce → product visual, social proof, offer-focused. NEVER invent specific claims, statistics, customer counts, star ratings, or testimonial text.

Banned content unless explicitly present in source materials:
- "Shop Now", "90-day guarantee", "10,000+ happy customers", "Free shipping"
- Star rating claims, specific testimonial quotes, customer-volume statistics`;

  const user = `Project name: ${project?.name || ''}
Brand: ${project?.brand_name || project?.name || ''}
Niche: ${project?.niche || ''}
Product description: ${compact(project?.product_description || '(not provided)', 4000)}
Offer rendering context: ${offerRenderContext}
Foundational docs:
${docBlock}

Generate exactly one Direct Offer angle JSON object that, when fed to a downstream headline generator, will produce headlines like:
- "Considering Christian Counseling? Free Webinar Compares All 3 Paths"
- "5 Questions to Ask Before Becoming a Christian Counselor"
- "Confused About Christian Counseling Requirements? Free Webinar"
- "Get Clear on Christian Counseling: Free 30-Minute Webinar"
(Adapt naming to the actual project's audience and offer.)`;

  return { system, user, offerRenderContext };
}

export function normalizeDirectOfferAngle(rawAngle, project = {}, foundationalDocs = []) {
  const angle = rawAngle && typeof rawAngle === 'object' ? rawAngle : {};
  const normalized = {
    name: 'Direct Offer',
    status: 'active',
    priority: ['highest', 'high', 'medium', 'test'].includes(text(angle.priority)) ? text(angle.priority) : 'medium',
    frame: VALID_FRAMES.includes(text(angle.frame)) ? text(angle.frame) : 'objection-first',
    core_buyer: text(angle.core_buyer),
    symptom_pattern: text(angle.symptom_pattern),
    failed_solutions: text(angle.failed_solutions),
    current_belief: text(angle.current_belief),
    objection: text(angle.objection),
    emotional_state: text(angle.emotional_state),
    scene: text(angle.scene),
    desired_belief_shift: text(angle.desired_belief_shift),
    tone: text(angle.tone),
    avoid_list: text(angle.avoid_list),
    prompt_hints: text(angle.prompt_hints),
  };

  const missing = ['core_buyer', 'symptom_pattern', 'objection', 'scene', 'desired_belief_shift']
    .filter((field) => !normalized[field]);
  if (missing.length > 0) {
    throw new Error(`Direct Offer seed missing required fields: ${missing.join(', ')}`);
  }

  normalized.description = buildDescriptionFromBrief(normalized);
  assertNoUnjustifiedContamination(normalized, project, foundationalDocs);
  return normalized;
}

export async function generateDirectOfferAngleContent(project, foundationalDocs, options = {}) {
  if (!hasCompleteFoundationalDocs(foundationalDocs)) {
    throw new Error('Direct Offer seed requires all foundational docs.');
  }

  const { system, user } = buildDirectOfferPrompt(project, foundationalDocs);
  const chatImpl = options.chatImpl || chat;
  const response = await chatImpl(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    'claude-sonnet-4-6',
    {
      response_format: { type: 'json_object' },
      max_tokens: 3000,
      operation: 'direct_offer_seed',
      projectId: project?.id || project?.externalId || null,
    }
  );
  const parsed = typeof response === 'string' ? extractJSON(response) : response;
  return normalizeDirectOfferAngle(parsed, project, foundationalDocs);
}

export async function seedDirectOfferAngleForProject(project, foundationalDocs, options = {}) {
  const projectId = project?.id || project?.externalId;
  if (!projectId) throw new Error('Project id is required for Direct Offer seeding.');

  if (!hasCompleteFoundationalDocs(foundationalDocs)) {
    return { created: false, reason: 'missing_foundational_docs', project_id: projectId };
  }

  const getAnglesImpl = options.getAnglesImpl || getConductorAngles;
  const existingAngles = options.existingAngles || await getAnglesImpl(projectId);
  if (projectAlreadyHasDirectOfferAngle(existingAngles)) {
    return { created: false, reason: 'direct_offer_exists', project_id: projectId };
  }

  const content = await generateDirectOfferAngleContent(project, foundationalDocs, options);
  const seedImpl = options.seedImpl || seedDirectOfferAngle;
  const result = await seedImpl({
    id: options.idFactory ? options.idFactory() : uuidv4(),
    project_id: projectId,
    ...content,
    tags: content.tags || [],
  });

  return {
    ...(result || {}),
    project_id: projectId,
    name: content.name,
    content,
  };
}

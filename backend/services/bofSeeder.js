import { v4 as uuidv4 } from 'uuid';
import { chat, extractJSON } from './anthropic.js';
import { getOfferRenderContext } from './adGenerator.js';
import { buildDescriptionFromBrief } from '../utils/angleParser.js';
import { getConductorAngles, seedDefaultBofAngle } from '../convexClient.js';

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
    throw new Error(`Default BOF seed contained unsupported ecommerce claims: ${violations.join(', ')}`);
  }
}

export function projectAlreadyHasBofAngle(angles = []) {
  return (angles || []).some((angle) => (
    angle?.source === 'default_bof' || /^BOF\b/i.test(text(angle?.name))
  ));
}

export function buildDefaultBofPrompt(project = {}, foundationalDocs = []) {
  const docs = docsArrayToMap(foundationalDocs);
  const offerRenderContext = getOfferRenderContext(project, docs);
  const docBlock = REQUIRED_DOC_TYPES
    .map((type) => `[${type}]\n${compact(docs[type]?.content || '(missing)', 5000)}`)
    .join('\n\n');

  const system = `You generate one default bottom-of-funnel ad angle for a direct-response ad platform. You must return only valid JSON. You are not writing ads; you are creating a structured angle brief that downstream AI will use literally.

The angle must be niche-aware. Use the project materials and offer rendering context. Do not import generic ecommerce proof, guarantees, shipping claims, customer counts, star ratings, review snippets, discounts, or purchase CTA language unless those exact claims or ecommerce conditions are present in the provided project materials.

The output must use this exact JSON shape:
{
  "name": "BOF - <short niche-aware label>",
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
  "desired_belief_shift": "After this ad, they should believe that ...",
  "tone": "...",
  "avoid_list": "...",
  "prompt_hints": "..."
}

Rules:
- Name must start with "BOF - ".
- Use one valid frame only: symptom-first, scam, objection-first, identity-first, MAHA, news-first, consequence-first.
- This is bottom-of-funnel positioning: the prospect is close to action but needs final clarity, reassurance, fit confirmation, or next-step confidence.
- For non-physical/service/webinar/education offers, shape the action around sign-up, registration, consultation, clarity call, application, booking, or the project-specific next step. Do not use product purchase language.
- For ecommerce/physical product offers, product and purchase language is allowed only when the offer rendering context explicitly indicates ecommerce/physical-product eligibility.
- Do not invent proof claims, customer counts, guarantees, shipping, discounts, testimonials, statistics, reviewer names, review scores, or deadlines.
- The scene must be a recurring, cold-scroll-readable pattern, not a timestamped literal prop scene.
- prompt_hints should guide creative direction without hardcoded claims. It may mention visual anchors appropriate to the offer rendering context.`;

  const user = `Project name: ${project?.name || ''}
Brand: ${project?.brand_name || project?.name || ''}
Niche: ${project?.niche || ''}
Product description:
${compact(project?.product_description || '(not provided)', 4000)}

Offer rendering context:
${offerRenderContext}

Foundational docs:
${docBlock}

Generate exactly one default BOF angle JSON object.`;

  return { system, user, offerRenderContext };
}

export function normalizeDefaultBofAngle(rawAngle, project = {}, foundationalDocs = []) {
  const angle = rawAngle && typeof rawAngle === 'object' ? rawAngle : {};
  const normalized = {
    name: text(angle.name).startsWith('BOF') ? text(angle.name) : `BOF - ${text(angle.name) || 'Final Step Confidence'}`,
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
    throw new Error(`Default BOF seed missing required fields: ${missing.join(', ')}`);
  }

  normalized.description = buildDescriptionFromBrief(normalized);
  assertNoUnjustifiedContamination(normalized, project, foundationalDocs);
  return normalized;
}

export async function generateDefaultBofAngleContent(project, foundationalDocs, options = {}) {
  if (!hasCompleteFoundationalDocs(foundationalDocs)) {
    throw new Error('Default BOF seed requires all foundational docs.');
  }

  const { system, user } = buildDefaultBofPrompt(project, foundationalDocs);
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
      operation: 'default_bof_seed',
      projectId: project?.id || project?.externalId || null,
    }
  );
  const parsed = typeof response === 'string' ? extractJSON(response) : response;
  return normalizeDefaultBofAngle(parsed, project, foundationalDocs);
}

export async function seedDefaultBofAngleForProject(project, foundationalDocs, options = {}) {
  const projectId = project?.id || project?.externalId;
  if (!projectId) throw new Error('Project id is required for default BOF seeding.');

  if (!hasCompleteFoundationalDocs(foundationalDocs)) {
    return { created: false, reason: 'missing_foundational_docs', project_id: projectId };
  }

  const getAnglesImpl = options.getAnglesImpl || getConductorAngles;
  const existingAngles = options.existingAngles || await getAnglesImpl(projectId);
  if (projectAlreadyHasBofAngle(existingAngles)) {
    return { created: false, reason: 'bof_exists', project_id: projectId };
  }

  const content = await generateDefaultBofAngleContent(project, foundationalDocs, options);
  const seedImpl = options.seedImpl || seedDefaultBofAngle;
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

#!/usr/bin/env node

const REQUIRED_HOST = 'cheery-cobra-258.convex.cloud';
const CCW_PROJECT_ID = '526cdad9-fc79-48ef-9657-726f3a6c4a3c';
const HEADLINE_COUNT = 16;

const angleFlagIndex = process.argv.indexOf('--angle');
const requestedAngleId = angleFlagIndex >= 0 ? process.argv[angleFlagIndex + 1] : null;

const configuredUrl = process.env.CONVEX_URL || '';

let configuredHost = '';
try {
  configuredHost = new URL(configuredUrl).hostname;
} catch {
  configuredHost = '';
}

if (configuredHost !== REQUIRED_HOST) {
  console.error(`[previewDirectOfferHeadlines] Refusing to run. Set CONVEX_URL=https://${REQUIRED_HOST}`);
  console.error(`[previewDirectOfferHeadlines] Current CONVEX_URL host: ${configuredHost || '(missing/invalid)'}`);
  process.exit(1);
}

const [
  { getProject, getLatestDoc, getConductorAngles },
  { extractBrief, generateHeadlines },
] = await Promise.all([
  import('../convexClient.js'),
  import('../services/adGenerator.js'),
]);

const project = await getProject(CCW_PROJECT_ID);
if (!project) {
  throw new Error(`Project not found: ${CCW_PROJECT_ID}`);
}

const [research, avatar, offer_brief, necessary_beliefs] = await Promise.all([
  getLatestDoc(CCW_PROJECT_ID, 'research'),
  getLatestDoc(CCW_PROJECT_ID, 'avatar'),
  getLatestDoc(CCW_PROJECT_ID, 'offer_brief'),
  getLatestDoc(CCW_PROJECT_ID, 'necessary_beliefs'),
]);

const docs = { research, avatar, offer_brief, necessary_beliefs };
const angles = await getConductorAngles(CCW_PROJECT_ID);
const selectedAngle = requestedAngleId
  ? angles.find((angle) => angle.externalId === requestedAngleId)
  : angles.find((angle) => angle.source === 'direct_offer' && angle.name === 'Direct Offer');

if (!selectedAngle) {
  throw new Error(requestedAngleId
    ? `Angle not found for ${CCW_PROJECT_ID}: ${requestedAngleId}`
    : `Direct Offer angle not found for ${CCW_PROJECT_ID}`);
}

const angleBrief = {
  name: selectedAngle.name,
  priority: selectedAngle.priority,
  frame: selectedAngle.frame,
  core_buyer: selectedAngle.core_buyer,
  symptom_pattern: selectedAngle.symptom_pattern,
  failed_solutions: selectedAngle.failed_solutions,
  current_belief: selectedAngle.current_belief,
  objection: selectedAngle.objection,
  emotional_state: selectedAngle.emotional_state,
  scene: selectedAngle.scene,
  desired_belief_shift: selectedAngle.desired_belief_shift,
  tone: selectedAngle.tone,
  avoid_list: selectedAngle.avoid_list,
  prompt_hints: selectedAngle.prompt_hints,
};

console.log(`[previewDirectOfferHeadlines] project=${project.name} (${CCW_PROJECT_ID})`);
console.log(`[previewDirectOfferHeadlines] angle=${selectedAngle.name} (${selectedAngle.externalId})`);
console.log('[previewDirectOfferHeadlines] mode=dry_run_raw_stage_1_no_persistence_no_filters');

const briefPacket = await extractBrief(project, docs, selectedAngle.name, angleBrief);
const result = await generateHeadlines(project, briefPacket, selectedAngle.name, HEADLINE_COUNT, angleBrief, []);
const headlines = Array.isArray(result?.headlines) ? result.headlines.slice(0, HEADLINE_COUNT) : [];

console.log('[previewDirectOfferHeadlines] headlines_json=' + JSON.stringify(headlines, null, 2));
console.log('[previewDirectOfferHeadlines] headlines:');
headlines.forEach((candidate, index) => {
  console.log(`${index + 1}. ${candidate.headline || candidate.headline_text || ''}`);
});

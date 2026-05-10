#!/usr/bin/env node

import { chat, extractJSON } from '../services/anthropic.js';
import {
  filterSceneAlignedHeadlines,
  filterAngleSignalHeadlines,
  filterHeadlineCandidatePool,
  evaluateHeadlineConflict,
  normalizeHeadlineText,
} from '../services/headlineDiversity.js';
import {
  getProject,
  getConductorAngles,
  getRecentHeadlineHistoryByAngle,
} from '../convexClient.js';

const REQUIRED_HOST = 'cheery-cobra-258.convex.cloud';
const PROJECT_ID = '526cdad9-fc79-48ef-9657-726f3a6c4a3c';
const DIRECT_OFFER_ANGLE_ID = 'ed02b53f-25f2-407b-b042-511b74602c56';
const MODEL = 'claude-sonnet-4-6';

const HEADLINES = [
  'Considering Christian Counseling? Free Webinar Compares All 3 Paths',
  '5 Questions to Ask Before Becoming a Christian Counselor',
  'Free Webinar: Licensure vs Ministry vs Certificate — Pick Your Christian Counseling Path',
  'Want to Help Others Through Christian Counseling? Start Here (Free)',
  'Confused About Christian Counseling Requirements? Free Webinar',
  'Get Clear on Christian Counseling: Free 30-Minute Webinar',
  'Called to Counsel? Free Webinar Maps Your Path Forward',
  "Don't Waste Years on the Wrong Christian Counseling Path (Free Webinar)",
  'What Every Aspiring Christian Counselor Should Know — Free Webinar',
  'Should You Become a Christian Counselor? Find Out in This Free Webinar',
  'For Christians Considering Counseling: Free Live Webinar on All 3 Paths',
  'Stop Googling "Christian Counselor Requirements" — Free Webinar Has the Answer',
  'Free Webinar for Christians Exploring a Counseling Career',
  'Pastor, Counselor, or Both? Free Christian Counseling Webinar',
  'Christian Counseling 101: Free Webinar Compares Your Options',
  'Becoming a Christian Counselor — What You Need to Know (Free Webinar)',
  'Christian, Called to Counsel? Free Webinar Walks You Through 3 Paths',
  'Before You Spend Years on Christian Counseling Training — Watch This Free',
  '3 Paths to Becoming a Christian Counselor: Free Webinar Explains Each',
  'The Christian Counseling Path Question — Answered in 30 Free Minutes',
];

function configuredConvexHost() {
  try {
    return new URL(process.env.CONVEX_URL || '').hostname;
  } catch {
    return '';
  }
}

function assertProductionReadOnlyTarget() {
  const host = configuredConvexHost();
  if (host !== REQUIRED_HOST) {
    console.error(`[testHeadlinesAgainstFilters] Refusing to run. Set CONVEX_URL=https://${REQUIRED_HOST}`);
    console.error(`[testHeadlinesAgainstFilters] Current CONVEX_URL host: ${host || '(missing/invalid)'}`);
    process.exit(1);
  }
}

function angleBriefFromRow(angle) {
  return {
    name: angle.name,
    priority: angle.priority,
    frame: angle.frame,
    core_buyer: angle.core_buyer,
    symptom_pattern: angle.symptom_pattern,
    failed_solutions: angle.failed_solutions,
    current_belief: angle.current_belief,
    objection: angle.objection,
    emotional_state: angle.emotional_state,
    scene: angle.scene,
    desired_belief_shift: angle.desired_belief_shift,
    tone: angle.tone,
    avoid_list: angle.avoid_list,
    prompt_hints: angle.prompt_hints,
  };
}

function buildMetadataPrompt(project, angleBrief) {
  return [
    {
      role: 'system',
      content: `You enrich hand-written ad headlines with the same metadata shape used by a Stage 1 headline generator.

Return only valid JSON in this exact shape:
{
  "items": [
    {
      "index": 1,
      "headline": "...",
      "target_symptom": "...",
      "core_claim": "...",
      "scene_anchor": "...",
      "sub_angle": "...",
      "hook_lane": "...",
      "opening_pattern": "...",
      "emotional_entry": "...",
      "desired_belief_shift": "..."
    }
  ]
}

Rules:
- Preserve the headline text exactly.
- Use concise metadata consistent with the Direct Offer angle.
- The angle is for a free Christian counselling webinar. It should name audience, name offer, and keep plain-English cold-scroll clarity.
- Do not add claims, statistics, guarantees, testimonials, or sales pressure.
- hook_lane should be one of: direct_offer, comparison, question, list, objection_reversal, identity_trust, search_intent.
- opening_pattern should be a short machine-friendly label like direct_question, list_format, comparison, free_offer, search_intent, before_you_spend, identity_callout.`,
    },
    {
      role: 'user',
      content: `Project:
${project.name}

Direct Offer angle:
${JSON.stringify(angleBrief, null, 2)}

Headlines:
${HEADLINES.map((headline, index) => `${index + 1}. ${headline}`).join('\n')}

Return metadata for all ${HEADLINES.length} headlines.`,
    },
  ];
}

function parseMetadataResponse(response) {
  const parsed = typeof response === 'string' ? extractJSON(response) : response;
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items) || items.length !== HEADLINES.length) {
    throw new Error(`Expected ${HEADLINES.length} metadata items, got ${Array.isArray(items) ? items.length : 'none'}`);
  }
  return items;
}

function synthesizeFallbackMetadata(headline, index, angleBrief) {
  return {
    index: index + 1,
    headline,
    target_symptom: 'Confusion about Christian counselling paths and requirements.',
    core_claim: 'A free webinar explains the Christian counselling path options plainly.',
    scene_anchor: 'Cold-scroll Direct Offer ad naming Christians considering counselling and the free webinar.',
    sub_angle: 'direct offer clarity',
    hook_lane: 'direct_offer',
    opening_pattern: 'direct_offer',
    emotional_entry: 'curiosity with caution',
    desired_belief_shift: angleBrief.desired_belief_shift || 'The free webinar is a clear first step before committing.',
  };
}

function buildCandidates(items, angleBrief) {
  return HEADLINES.map((headline, index) => {
    const item = items.find((entry) => Number(entry.index) === index + 1)
      || items.find((entry) => normalizeHeadlineText(entry.headline) === normalizeHeadlineText(headline))
      || synthesizeFallbackMetadata(headline, index, angleBrief);
    return {
      rank: index + 1,
      headline,
      target_symptom: String(item.target_symptom || '').trim(),
      core_claim: String(item.core_claim || '').trim(),
      scene_anchor: String(item.scene_anchor || '').trim(),
      sub_angle: String(item.sub_angle || '').trim(),
      hook_lane: String(item.hook_lane || '').trim(),
      opening_pattern: String(item.opening_pattern || '').trim(),
      emotional_entry: String(item.emotional_entry || '').trim(),
      desired_belief_shift: String(item.desired_belief_shift || '').trim(),
      scores: { scroll_stop: 8, specificity: 8, uniqueness: 8, real_human: 8 },
      average_score: 8,
    };
  });
}

function rejectedMap(entries, stage) {
  const map = new Map();
  for (const entry of entries || []) {
    map.set(normalizeHeadlineText(entry.candidate?.headline), { ...entry, stage });
  }
  return map;
}

function dedupRejectedMap(pool) {
  const map = new Map();
  for (const entry of pool.rejectedByHistory || []) {
    const conflict = evaluateHeadlineConflict(entry.candidate, entry.against);
    map.set(normalizeHeadlineText(entry.candidate?.headline), {
      stage: 'history_dedup',
      reasons: conflict.reasons || [],
      against: entry.against?.headline,
      similarity: conflict.similarity,
    });
  }
  for (const entry of pool.rejectedInBatch || []) {
    const conflict = evaluateHeadlineConflict(entry.candidate, entry.against);
    map.set(normalizeHeadlineText(entry.candidate?.headline), {
      stage: 'in_batch_dedup',
      reasons: conflict.reasons || [],
      against: entry.against?.headline,
      similarity: conflict.similarity,
    });
  }
  return map;
}

function pct(numerator, denominator) {
  if (!denominator) return 'n/a';
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

assertProductionReadOnlyTarget();

const project = await getProject(PROJECT_ID);
if (!project) throw new Error(`Project not found: ${PROJECT_ID}`);

const angles = await getConductorAngles(PROJECT_ID);
const angle = angles.find((candidate) => candidate.externalId === DIRECT_OFFER_ANGLE_ID);
if (!angle) {
  throw new Error(`Hard blocker: Direct Offer angle externalId not found: ${DIRECT_OFFER_ANGLE_ID}`);
}

const angleBrief = angleBriefFromRow(angle);
const metadataResponse = await chat(
  buildMetadataPrompt(project, angleBrief),
  MODEL,
  {
    response_format: { type: 'json_object' },
    max_tokens: 3500,
    timeout: 240000,
    operation: 'direct_offer_filter_diagnostic_metadata',
    projectId: PROJECT_ID,
  }
);
const metadataItems = parseMetadataResponse(metadataResponse);
const candidates = buildCandidates(metadataItems, angleBrief);

const history = await getRecentHeadlineHistoryByAngle(PROJECT_ID, angle.name, {
  limit: 200,
  since: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
});

const scene = filterSceneAlignedHeadlines(candidates, angleBrief);
const angleSignal = filterAngleSignalHeadlines(scene.survivors, angleBrief);
const dedup = filterHeadlineCandidatePool(angleSignal.survivors, history);

const sceneRejected = rejectedMap(scene.rejected, 'scene_alignment');
const angleRejected = rejectedMap(angleSignal.rejected, 'angle_signal');
const dedupRejected = dedupRejectedMap(dedup);
const passed = new Set(dedup.survivors.map((candidate) => normalizeHeadlineText(candidate.headline)));

const rows = HEADLINES.map((headline, index) => {
  const key = normalizeHeadlineText(headline);
  const sceneHit = sceneRejected.get(key);
  const angleHit = angleRejected.get(key);
  const dedupHit = dedupRejected.get(key);
  let status = 'PASS';
  let detail = '';
  if (sceneHit) {
    status = 'REJECT scene_alignment';
    detail = (sceneHit.reasons || []).join(', ') || 'scene alignment rejected';
  } else if (angleHit) {
    status = 'REJECT angle_signal';
    detail = `${(angleHit.reasons || []).join(', ') || 'angle signal rejected'}; score=${angleHit.score}; visibleScore=${angleHit.visibleScore}; tokens=${(angleHit.matchedTokens || []).join('|')}`;
  } else if (dedupHit) {
    status = `REJECT ${dedupHit.stage}`;
    detail = `${(dedupHit.reasons || []).join(', ') || 'dedup conflict'}; against="${dedupHit.against || ''}"; similarity=${Math.round((dedupHit.similarity || 0) * 1000) / 1000}`;
  } else if (!passed.has(key)) {
    status = 'REJECT unknown';
    detail = 'Not present in final survivor set.';
  }
  return {
    index: index + 1,
    headline,
    status,
    detail,
  };
});

const summary = {
  project: { id: PROJECT_ID, name: project.name },
  angle: { externalId: angle.externalId, name: angle.name, source: angle.source },
  read_only: true,
  headline_history_loaded: history.length,
  scene_alignment: {
    scene_locked: scene.sceneLocked,
    survivors: scene.survivors.length,
    rejected: scene.rejected.length,
    pass_rate: pct(scene.survivors.length, candidates.length),
    reason_counts: scene.reasonCounts,
  },
  angle_signal: {
    active: angleSignal.active,
    survivors: angleSignal.survivors.length,
    rejected: angleSignal.rejected.length,
    pass_rate_of_scene_survivors: pct(angleSignal.survivors.length, scene.survivors.length),
    reason_counts: angleSignal.reasonCounts,
  },
  dedup: {
    survivors: dedup.survivors.length,
    rejected_by_history: dedup.rejectedByHistory.length,
    rejected_in_batch: dedup.rejectedInBatch.length,
    pass_rate_of_angle_signal_survivors: pct(dedup.survivors.length, angleSignal.survivors.length),
  },
  overall: {
    passed: dedup.survivors.length,
    total: candidates.length,
    pass_rate: pct(dedup.survivors.length, candidates.length),
  },
  rows,
};

console.log(JSON.stringify(summary, null, 2));
setTimeout(() => process.exit(0), 0);

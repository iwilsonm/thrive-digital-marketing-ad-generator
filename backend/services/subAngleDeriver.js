// Phase 4 — Sub-angle derivation. Triggers from the Phase 3 cron after the
// archive phase. Reads a project's active angles, finds eligible parents,
// and asks Claude Sonnet 4.6 to propose sub-angles that VARY 1-2 dimensions
// of the parent's structured creative brief while preserving the core_buyer
// and brand identity.
//
// PEF fortifications:
//   - Strict JSON validator with allowlists + length caps + partial-accept on `frame`
//   - Prompt-injection sanitization on user-controlled context
//   - System/user role separation in the Anthropic call
//   - Convex setDerivationLock for race protection (cron + manual)
//   - 6h cooldown after failed derivation (derivation_attempt_failed_at)
//   - Per-project daily cost cap + per-tick global cost cap
//   - Sub-angle priority capped at `medium` regardless of parent
//   - Naming uniqueness with auto-suffix on collision
//   - foundational_docs avatar/beliefs compacted into context (off-brand drift mitigation)

import { v4 as uuidv4 } from 'uuid';
import { chat as claudeChat, extractJSON } from './anthropic.js';
import {
  convexClient, api, getSetting, setSetting, getDocsByProject, upsertDashboardTodo,
} from '../convexClient.js';
import {
  validateSubAngleCandidate,
  sanitizeContextForLLM,
  DEFAULTS,
  FRAME_ENUM,
} from './subAngleValidator.js';

export { DEFAULTS, validateSubAngleCandidate, sanitizeContextForLLM };

const PRIORITY_CAP_FOR_DERIVED = 'medium';
const FAILED_ATTEMPT_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h
const DAY_MS = 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────
// Eligibility logic
// ────────────────────────────────────────────────────────

function angleDepth(angle, allAngles) {
  let depth = 0;
  let current = angle;
  while (current.parent_angle_id) {
    depth += 1;
    if (depth > 10) break; // defensive against cycles
    current = allAngles.find((a) => a.externalId === current.parent_angle_id);
    if (!current) break;
  }
  return depth;
}

function thresholdAtDepth(baseThreshold, depth) {
  return baseThreshold * Math.pow(2, depth);
}

function distinctPostingDays(passedResults) {
  return new Set(passedResults.map((r) => r.posted_at?.slice(0, 10)).filter(Boolean)).size;
}

function meetsCohortFloor(passedResults, minUniqueDays) {
  const distinct = distinctPostingDays(passedResults);
  if (distinct >= minUniqueDays) return true;
  // Fallback: ≥ 5 total OR oldest ≥ 21d old
  if (passedResults.length >= 5) return true;
  const oldest = passedResults.reduce((min, r) => (!min || r.posted_at < min ? r.posted_at : min), null);
  if (oldest && (Date.now() - new Date(oldest).getTime()) >= 21 * DAY_MS) return true;
  return false;
}

// ────────────────────────────────────────────────────────
// LLM context builder
// ────────────────────────────────────────────────────────

async function buildAvatarSummary(projectId) {
  try {
    const docs = await getDocsByProject(projectId);
    if (!Array.isArray(docs)) return '';
    const avatar = docs.find((d) => d.doc_type === 'avatar');
    const beliefs = docs.find((d) => d.doc_type === 'necessary_beliefs');
    let combined = '';
    if (avatar?.content) combined += `AVATAR:\n${avatar.content}\n\n`;
    if (beliefs?.content) combined += `BELIEFS:\n${beliefs.content}\n\n`;
    return sanitizeContextForLLM(combined, 1500);
  } catch (err) {
    console.warn(`[subAngleDeriver] avatar summary failed: ${err.message}`);
    return '';
  }
}

function compactParentBrief(parent) {
  const fields = ['frame', 'core_buyer', 'symptom_pattern', 'emotional_state', 'scene', 'objection', 'desired_belief_shift', 'tone'];
  return fields
    .filter((f) => parent[f])
    .map((f) => `${f}: ${sanitizeContextForLLM(parent[f], 200)}`)
    .join('\n');
}

function summarizePassedResults(results, max = 5) {
  return results
    .slice(0, max)
    .map((r, i) => {
      const roas = r.roas != null ? `ROAS ${r.roas.toFixed(2)}` : '';
      const spend = r.spend != null ? `$${r.spend.toFixed(2)} spent` : '';
      const days = r.days_observed ? `${r.days_observed}d` : '';
      const reason = sanitizeContextForLLM(r.reason || '', 300);
      return `Result ${i + 1}: posted ${r.posted_at?.slice(0, 10)} | ${spend} | ${roas} | ${days} obs | "${reason}"`;
    })
    .join('\n');
}

// ────────────────────────────────────────────────────────
// LLM call
// ────────────────────────────────────────────────────────

async function callDerivationLLM({ parent, avatarSummary, passedResults, maxPerRun, existingNames, projectId }) {
  const systemPrompt = `You are creating variations of a winning ad angle for a direct response e-commerce brand.

Your job: generate ${maxPerRun} sub-angles that VARY 1-2 dimensions of the parent angle (frame, scene, objection, emotional_state, or symptom_pattern) while PRESERVING the parent's core_buyer and brand identity.

Each sub-angle must test a clearly different creative hypothesis. Don't just rephrase the parent — meaningfully shift one of the dimensions.

Constraints:
- frame must be one of: ${FRAME_ENUM.join(', ')}
- name must be unique (these names already exist: ${[...existingNames].slice(0, 30).join(', ')})
- name should be a short, evocative label (under 80 chars)
- description should explain the variation in 2-3 sentences
- Stay on-brand: do not invent claims that contradict the avatar/beliefs below

Output strict JSON of the form:
{
  "sub_angles": [
    {
      "name": "Short evocative label",
      "description": "What this angle tests, 2-3 sentences.",
      "frame": "one-of-enum",
      "scene": "Where the ad lives",
      "objection": "Buyer hesitation this angle dismantles",
      "emotional_state": "What the buyer feels",
      "symptom_pattern": "Pattern of pain/symptom this angle hooks",
      "prompt_hints": "Specific creative direction for image and copy",
      "reasoning": "Why this variation is worth testing given parent's wins"
    }
  ]
}`;

  const userContent = `Parent angle:
NAME: ${parent.name}
DESCRIPTION: ${sanitizeContextForLLM(parent.description, 600)}
${compactParentBrief(parent)}

${avatarSummary ? `Project avatar + beliefs (for brand alignment — do not contradict):\n${avatarSummary}\n` : ''}

Recent passed observations for this angle (ad sets that hit benchmark):
${summarizePassedResults(passedResults)}

Now generate ${maxPerRun} sub-angles per the schema.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const raw = await claudeChat(messages, 'claude-sonnet-4-6', {
    response_format: { type: 'json_object' },
    max_tokens: 4096,
    operation: 'subangle_derivation',
    projectId,
  });

  const parsed = extractJSON(raw);
  if (!parsed || !Array.isArray(parsed.sub_angles)) {
    throw new Error('LLM output missing sub_angles array');
  }
  return parsed.sub_angles.slice(0, maxPerRun);
}

// ────────────────────────────────────────────────────────
// Main entrypoint
// ────────────────────────────────────────────────────────

export async function deriveSubAnglesForProject(projectId, opts = {}) {
  const dryRun = opts.dryRun || false;
  const force = opts.force || false;
  const onlyAngleId = opts.parentAngleId || null;

  const cfg = await loadEffectiveConfig(projectId);
  if (!cfg.sub_angle_derivation_enabled) {
    return { skipped: true, reason: 'derivation disabled' };
  }

  const allAngles = await convexClient.query(api.conductor.getAngles, { projectId });
  const activeAngles = allAngles.filter((a) => a.status === 'active');
  const allResults = await convexClient.query(api.observationResults.getAllByProjectGroupedByAngle, { projectId });
  const resultsByAngle = new Map();
  for (const r of allResults) {
    if (!r.angle_id) continue;
    const arr = resultsByAngle.get(r.angle_id) || [];
    arr.push(r);
    resultsByAngle.set(r.angle_id, arr);
  }

  // Per-project daily cost cap check
  const todayKey = new Date().toISOString().slice(0, 10);
  const costSpentRaw = await getSetting(`phase4_derivation_cost_spent:${projectId}:${todayKey}`);
  const costSpent = costSpentRaw ? parseFloat(costSpentRaw) : 0;
  if (costSpent >= cfg.sub_angle_per_project_daily_cost_cap_usd) {
    return { skipped: true, reason: `daily cost cap reached ($${costSpent.toFixed(2)}/$${cfg.sub_angle_per_project_daily_cost_cap_usd})` };
  }

  // Pending review queue gate
  if (cfg.sub_angle_derivation_mode === 'review') {
    const pending = await convexClient.query(api.conductor.getPendingReviewAngles, { projectId });
    if (pending.length > 0 && !force) {
      return { skipped: true, reason: `${pending.length} pending review — resolve before queueing more`, pending_count: pending.length };
    }
  }

  const candidates = onlyAngleId
    ? activeAngles.filter((a) => a.externalId === onlyAngleId)
    : activeAngles;

  const summary = { parents_processed: [], derived_count: 0, skipped: [], errors: [] };
  const avatarSummary = await buildAvatarSummary(projectId);

  for (const parent of candidates) {
    const reason = await checkEligibility(parent, allAngles, resultsByAngle, cfg, force);
    if (reason) {
      summary.skipped.push({ angle: parent.name, reason });
      continue;
    }

    // Acquire lock
    const lock = await convexClient.mutation(api.conductor.setDerivationLock, {
      externalId: parent.externalId,
      in_progress: true,
    });
    if (!lock.acquired) {
      summary.skipped.push({ angle: parent.name, reason: 'lock not acquired' });
      continue;
    }

    try {
      const passedResults = (resultsByAngle.get(parent.externalId) || [])
        .filter((r) => isPassed(r))
        .sort((a, b) => (a.observed_through < b.observed_through ? 1 : -1));

      const existingNames = new Set(allAngles.map((a) => a.name));
      const maxPerRun = cfg.sub_angle_derivation_max_per_run;

      let candidatesFromLLM;
      if (dryRun) {
        candidatesFromLLM = [];
        summary.parents_processed.push({ angle: parent.name, dry_run: true });
      } else {
        candidatesFromLLM = await callDerivationLLM({
          parent, avatarSummary, passedResults, maxPerRun, existingNames, projectId,
        });
      }

      const insertedIds = [];
      const childStatus = cfg.sub_angle_derivation_mode === 'review' ? 'pending_review' : 'active';

      for (const c of candidatesFromLLM) {
        const validation = validateSubAngleCandidate(c, parent, existingNames);
        if (!validation.ok) {
          summary.errors.push({ angle: parent.name, candidate: c.name || '?', issues: validation.normalizations });
          continue;
        }
        const childId = uuidv4();
        existingNames.add(validation.normalized.name);
        await convexClient.mutation(api.conductor.createAngle, {
          externalId: childId,
          project_id: projectId,
          name: validation.normalized.name,
          description: validation.normalized.description,
          prompt_hints: validation.normalized.prompt_hints,
          source: 'auto_generated',
          status: childStatus,
          priority: PRIORITY_CAP_FOR_DERIVED,
          frame: validation.normalized.frame,
          core_buyer: validation.normalized.core_buyer,
          symptom_pattern: validation.normalized.symptom_pattern,
          objection: validation.normalized.objection,
          emotional_state: validation.normalized.emotional_state,
          scene: validation.normalized.scene,
          desired_belief_shift: validation.normalized.desired_belief_shift,
          tone: validation.normalized.tone,
          avoid_list: validation.normalized.avoid_list,
          parent_angle_id: parent.externalId,
          derived_at: Date.now(),
          derivation_source_result_ids: JSON.stringify(passedResults.slice(0, 5).map((r) => r.externalId)),
          derivation_reasoning: validation.normalized.reasoning,
        });
        insertedIds.push(childId);
        summary.derived_count += 1;
      }

      // Patch parent: clear since_last_derived counter via last_derived_at update
      await convexClient.mutation(api.conductor.updateAngle, {
        externalId: parent.externalId,
        last_derived_at: Date.now(),
        derivation_attempt_failed_at: undefined,
      });

      // Auto-tag children via Phase 5 (best-effort)
      await tryAutoTagChildren(projectId, parent, insertedIds).catch((err) => {
        console.warn(`[subAngleDeriver] auto-tag failed for ${parent.name}: ${err.message}`);
      });

      // Dashboard todo
      if (insertedIds.length > 0) {
        await upsertDashboardTodo({
          externalId: `phase4-derived-${parent.externalId}-${Date.now()}`,
          text: `Derived ${insertedIds.length} sub-angle${insertedIds.length === 1 ? '' : 's'} from "${parent.name}"`,
          notes: `Project: ${projectId}. ${childStatus === 'pending_review' ? 'Review required in Creative Director settings.' : 'Click to view in Creative Director settings.'}`,
          author: 'Phase 4 Sub-angle Deriver',
          priority: childStatus === 'pending_review' ? 0 : 2,
          sort_order: Date.now(),
        }).catch(() => {});
      }

      summary.parents_processed.push({ angle: parent.name, derived: insertedIds.length });
    } catch (err) {
      console.warn(`[subAngleDeriver] ${parent.name} failed: ${err.message}`);
      summary.errors.push({ angle: parent.name, error: err.message });
      // Mark failure for backoff
      await convexClient.mutation(api.conductor.updateAngle, {
        externalId: parent.externalId,
        derivation_attempt_failed_at: Date.now(),
      }).catch(() => {});
    } finally {
      // Release lock
      await convexClient.mutation(api.conductor.setDerivationLock, {
        externalId: parent.externalId,
        in_progress: false,
      }).catch(() => {});
    }
  }

  return summary;
}

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

async function loadEffectiveConfig(projectId) {
  const all = await convexClient.query(api.conductor.getAllConfigs, {});
  const cfg = all.find((c) => c.project_id === projectId) || {};
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (cfg[key] !== undefined && cfg[key] !== null) merged[key] = cfg[key];
  }
  return merged;
}

function isPassed(result) {
  if (result.verdict === 'passed' || result.verdict === 'manual_passed') return true;
  return false;
}

async function checkEligibility(parent, allAngles, resultsByAngle, cfg, force) {
  if (parent.is_system_default) return 'Direct Offer system default';
  if (parent.derivation_in_progress) return 'derivation in progress';

  if (parent.derivation_attempt_failed_at) {
    const elapsed = Date.now() - parent.derivation_attempt_failed_at;
    if (elapsed < FAILED_ATTEMPT_BACKOFF_MS) {
      return `failed-attempt cooldown (${Math.round((FAILED_ATTEMPT_BACKOFF_MS - elapsed) / 60000)} min remaining)`;
    }
  }

  const depth = angleDepth(parent, allAngles);
  if (depth >= cfg.sub_angle_max_depth) return `max depth ${depth} reached`;

  if (parent.last_derived_at && !force) {
    const cooldownMs = cfg.sub_angle_derivation_cooldown_days * DAY_MS;
    if (Date.now() - parent.last_derived_at < cooldownMs) {
      return `cooldown (${cfg.sub_angle_derivation_cooldown_days}d window)`;
    }
  }

  const allResults = resultsByAngle.get(parent.externalId) || [];
  const passedResults = allResults.filter((r) => isPassed(r));

  // Filter to "since last derivation" if applicable
  const sinceLast = parent.last_derived_at;
  const eligible = sinceLast
    ? passedResults.filter((r) => new Date(r.observed_through).getTime() > sinceLast)
    : passedResults;

  const threshold = thresholdAtDepth(cfg.sub_angle_derivation_threshold, depth);
  if (eligible.length < threshold) {
    return `${eligible.length}/${threshold} passes (depth ${depth})`;
  }

  if (!meetsCohortFloor(eligible, cfg.sub_angle_derivation_min_unique_days)) {
    return `cohort independence not met (${distinctPostingDays(eligible)} distinct posting day(s))`;
  }

  return null; // eligible
}

async function tryAutoTagChildren(projectId, parent, childIds) {
  if (childIds.length === 0) return;
  const tagName = `Derived-${parent.name}`.slice(0, 60);
  const color = '#7C6DCD'; // accent-purple — system-generated tag

  const existing = await convexClient.query(api.tags.getByProject, { projectId });
  let tagId = (existing || []).find((t) => t.name === tagName)?.externalId;
  if (!tagId) {
    tagId = uuidv4();
    await convexClient.mutation(api.tags.create, {
      externalId: tagId,
      project_id: projectId,
      name: tagName,
      color,
    });
  }
  for (const childId of childIds) {
    await convexClient.mutation(api.tagAssignments.create, {
      externalId: uuidv4(),
      project_id: projectId,
      tag_id: tagId,
      entity_type: 'angle',
      entity_id: childId,
      entity_id_kind: 'cf',
    }).catch(() => {});
  }
}

// ────────────────────────────────────────────────────────
// Stats phase entry — called from observationTracker
// ────────────────────────────────────────────────────────

export async function computeAngleStatsForProject(projectId) {
  const angles = await convexClient.query(api.conductor.getAngles, { projectId });
  const results = await convexClient.query(api.observationResults.getAllByProjectGroupedByAngle, { projectId });

  const byAngle = new Map();
  for (const r of results) {
    if (!r.angle_id) continue;
    const arr = byAngle.get(r.angle_id) || [];
    arr.push(r);
    byAngle.set(r.angle_id, arr);
  }

  const updates = [];
  for (const angle of angles) {
    const all = byAngle.get(angle.externalId) || [];
    const lifetimePassed = all.filter((r) => isPassed(r)).length;
    const lifetimeFailed = all.filter((r) => r.verdict === 'failed' || r.verdict === 'failed_external' || r.verdict === 'manual_failed').length;
    const lifetimeTotal = lifetimePassed + lifetimeFailed;
    const lifetimePassRate = lifetimeTotal > 0 ? lifetimePassed / lifetimeTotal : 0;

    const sinceLast = angle.last_derived_at;
    const recent = sinceLast ? all.filter((r) => new Date(r.observed_through).getTime() > sinceLast) : all;
    const sinceLastPassed = recent.filter((r) => isPassed(r)).length;
    const sinceLastFailed = recent.filter((r) => r.verdict === 'failed' || r.verdict === 'failed_external' || r.verdict === 'manual_failed').length;

    updates.push({
      externalId: angle.externalId,
      since_last_derived_pass_count: sinceLastPassed,
      since_last_derived_fail_count: sinceLastFailed,
      lifetime_pass_count: lifetimePassed,
      lifetime_fail_count: lifetimeFailed,
      lifetime_pass_rate: lifetimePassRate,
    });
  }

  if (updates.length > 0) {
    await convexClient.mutation(api.conductor.bulkUpdateAngleStats, { updates });
  }
  return { angles_updated: updates.length };
}

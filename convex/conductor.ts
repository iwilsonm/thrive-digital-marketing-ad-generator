import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// =============================================
// conductor_config — per-project Director settings
// =============================================

export const getConfig = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .first();
  },
});

export const upsertConfig = mutation({
  args: {
    project_id: v.string(),
    enabled: v.optional(v.boolean()),
    daily_flex_target: v.optional(v.number()),
    ads_per_batch: v.optional(v.number()),
    angle_mode: v.optional(v.string()),
    explore_ratio: v.optional(v.number()),
    angle_rotation: v.optional(v.string()),
    angle_tag_filter: v.optional(v.string()),
    headline_style: v.optional(v.string()),
    primary_text_style: v.optional(v.string()),
    template_tag: v.optional(v.string()),
    default_campaign_id: v.optional(v.string()),
    run_schedule: v.optional(v.string()),
    run_schedule_days: v.optional(v.string()),
    run_schedule_hour: v.optional(v.number()),
    last_planning_run: v.optional(v.number()),
    last_verify_run: v.optional(v.number()),
    // Phase 4 — sub-angle derivation + health-biased selection
    health_bias: v.optional(v.boolean()),
    sub_angle_derivation_enabled: v.optional(v.boolean()),
    sub_angle_derivation_mode: v.optional(v.string()),
    sub_angle_derivation_threshold: v.optional(v.number()),
    sub_angle_derivation_min_unique_days: v.optional(v.number()),
    sub_angle_derivation_max_per_run: v.optional(v.number()),
    sub_angle_derivation_cooldown_days: v.optional(v.number()),
    sub_angle_max_depth: v.optional(v.number()),
    sub_angle_exploration_boost_days: v.optional(v.number()),
    sub_angle_lineage_cap_share: v.optional(v.number()),
    sub_angle_min_active_for_health_bias: v.optional(v.number()),
    sub_angle_min_active_for_lineage_cap: v.optional(v.number()),
    sub_angle_per_project_daily_cost_cap_usd: v.optional(v.number()),
    // Phase 9 — auto-posting
    auto_post_enabled: v.optional(v.boolean()),
    auto_post_max_daily_sets: v.optional(v.number()),
    auto_post_max_daily_budget_cents: v.optional(v.number()),
    auto_post_require_min_score: v.optional(v.number()),
    auto_post_pause_on_error: v.optional(v.boolean()),
    auto_post_error_threshold: v.optional(v.number()),
    auto_post_consecutive_errors: v.optional(v.number()),
    auto_post_paused_reason: v.optional(v.string()),
    auto_post_today_count: v.optional(v.number()),
    auto_post_today_date: v.optional(v.string()),
    auto_post_last_posted_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conductor_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();

    const now = Date.now();
    if (existing) {
      const { project_id, ...updates } = args;
      const filtered: Record<string, any> = { updated_at: now };
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) filtered[key] = value;
      }
      await ctx.db.patch(existing._id, filtered);
    } else {
      await ctx.db.insert("conductor_config", {
        project_id: args.project_id,
        enabled: args.enabled ?? false,
        daily_flex_target: args.daily_flex_target ?? 5,
        ads_per_batch: args.ads_per_batch ?? 5,
        angle_mode: args.angle_mode ?? "manual",
        explore_ratio: args.explore_ratio ?? 0.2,
        angle_rotation: args.angle_rotation ?? "round_robin",
        angle_tag_filter: args.angle_tag_filter,
        headline_style: args.headline_style,
        primary_text_style: args.primary_text_style,
        template_tag: args.template_tag,
        default_campaign_id: args.default_campaign_id,
        run_schedule: args.run_schedule ?? "weekdays",
        last_planning_run: args.last_planning_run,
        last_verify_run: args.last_verify_run,
        created_at: now,
        updated_at: now,
      });
    }
  },
});

export const getAllConfigs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("conductor_config").collect();
  },
});

export const repairLegacyAdsPerBatchDefaults = mutation({
  args: {
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const now = Date.now();
    const configs = await ctx.db.query("conductor_config").collect();
    const results: Array<{
      project_id: string;
      old_ads_per_batch: number;
      new_ads_per_batch: number;
      project_ads_per_ad_set: number | null;
      project_updated: boolean;
    }> = [];

    for (const config of configs) {
      if (config.ads_per_batch !== 18) continue;

      let project = await ctx.db
        .query("projects")
        .withIndex("by_externalId", (q) => q.eq("externalId", config.project_id))
        .first();

      const projectAdsPerAdSet =
        typeof project?.ads_per_ad_set === "number" ? project.ads_per_ad_set : null;
      const shouldPatchProject = !!project && (projectAdsPerAdSet === null || projectAdsPerAdSet === 18);

      results.push({
        project_id: config.project_id,
        old_ads_per_batch: 18,
        new_ads_per_batch: 5,
        project_ads_per_ad_set: projectAdsPerAdSet,
        project_updated: shouldPatchProject,
      });

      if (!dryRun) {
        await ctx.db.patch(config._id, {
          ads_per_batch: 5,
          updated_at: now,
        });
        if (shouldPatchProject && project) {
          await ctx.db.patch(project._id, {
            ads_per_ad_set: 5,
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    return {
      dryRun,
      matched: results.length,
      updated: dryRun ? 0 : results.length,
      results,
    };
  },
});

// =============================================
// conductor_angles — angle library per project
// =============================================

export const getAngles = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_angles")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getActiveAngles = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_angles")
      .withIndex("by_project_and_status", (q) =>
        q.eq("project_id", args.projectId).eq("status", "active")
      )
      .collect();
  },
});

export const getSystemDefaultAngle = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const angles = await ctx.db
      .query("conductor_angles")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return angles.find((a) => a.is_system_default === true) || null;
  },
});

export const createAngle = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.string(),
    prompt_hints: v.optional(v.string()),
    source: v.string(),
    status: v.string(),
    // Structured creative brief fields
    priority: v.optional(v.string()),
    frame: v.optional(v.string()),
    core_buyer: v.optional(v.string()),
    symptom_pattern: v.optional(v.string()),
    failed_solutions: v.optional(v.string()),
    current_belief: v.optional(v.string()),
    objection: v.optional(v.string()),
    emotional_state: v.optional(v.string()),
    scene: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    tone: v.optional(v.string()),
    avoid_list: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    is_system_default: v.optional(v.boolean()),
    // Phase 4 — sub-angle derivation fields on creation
    parent_angle_id: v.optional(v.string()),
    derived_at: v.optional(v.number()),
    derivation_source_result_ids: v.optional(v.string()),
    derivation_reasoning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("conductor_angles", {
      ...args,
      times_used: 0,
      created_at: now,
      updated_at: now,
    });
  },
});

export const seedDirectOfferAngle = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.string(),
    prompt_hints: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    frame: v.optional(v.string()),
    core_buyer: v.optional(v.string()),
    symptom_pattern: v.optional(v.string()),
    failed_solutions: v.optional(v.string()),
    current_belief: v.optional(v.string()),
    objection: v.optional(v.string()),
    emotional_state: v.optional(v.string()),
    scene: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    tone: v.optional(v.string()),
    avoid_list: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conductor_angles")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .collect();

    const directOffer = existing.find((angle) => angle.source === "direct_offer" || angle.source === "default_bof");
    if (directOffer) {
      return { created: false, reason: "direct_offer_exists", externalId: directOffer.externalId };
    }

    const namedDirectOffer = existing.find((angle) => /^Direct Offer$/i.test(angle.name || "") || /^BOF\b/i.test(angle.name || ""));
    if (namedDirectOffer) {
      return { created: false, reason: "direct_offer_name_exists", externalId: namedDirectOffer.externalId };
    }

    const now = Date.now();
    await ctx.db.insert("conductor_angles", {
      ...args,
      source: "direct_offer",
      status: args.status || "active",
      priority: args.priority || "medium",
      is_system_default: true,
      times_used: 0,
      created_at: now,
      updated_at: now,
    });

    return { created: true, reason: "created", externalId: args.externalId };
  },
});

export const updateAngle = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    prompt_hints: v.optional(v.string()),
    status: v.optional(v.string()),
    focused: v.optional(v.boolean()),
    // Structured creative brief fields
    priority: v.optional(v.string()),
    frame: v.optional(v.string()),
    core_buyer: v.optional(v.string()),
    symptom_pattern: v.optional(v.string()),
    failed_solutions: v.optional(v.string()),
    current_belief: v.optional(v.string()),
    objection: v.optional(v.string()),
    emotional_state: v.optional(v.string()),
    scene: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    tone: v.optional(v.string()),
    avoid_list: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    destination_urls: v.optional(v.string()),
    is_system_default: v.optional(v.boolean()),
    // Operational
    times_used: v.optional(v.number()),
    last_used_at: v.optional(v.number()),
    performance_note: v.optional(v.string()),
    // Phase 4 — sub-angle derivation
    parent_angle_id: v.optional(v.string()),
    derived_at: v.optional(v.number()),
    derivation_source_result_ids: v.optional(v.string()),
    derivation_reasoning: v.optional(v.string()),
    last_derived_at: v.optional(v.number()),
    derivation_in_progress: v.optional(v.boolean()),
    derivation_attempt_failed_at: v.optional(v.number()),
    since_last_derived_pass_count: v.optional(v.number()),
    since_last_derived_fail_count: v.optional(v.number()),
    lifetime_pass_count: v.optional(v.number()),
    lifetime_fail_count: v.optional(v.number()),
    lifetime_pass_rate: v.optional(v.number()),
    observation_stats_updated_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) throw new Error("Angle not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = { updated_at: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(angle._id, filtered);
  },
});

export const deleteAngle = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) return;
    await ctx.db.delete(angle._id);
  },
});

// Phase 3 — angle archive / unarchive
// Idempotent: archiveAngle no-ops if status is already "archived".
export const archiveAngle = mutation({
  args: {
    externalId: v.string(),
    performance_note: v.optional(v.string()),
    source: v.optional(v.string()),  // "auto" | "manual"
  },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) throw new Error("Angle not found");
    if (angle.status === "archived") return; // idempotent
    const updates: Record<string, any> = {
      status: "archived",
      updated_at: Date.now(),
    };
    if (args.performance_note !== undefined) {
      const prefix = args.source === "auto" ? "Auto-archived" : "Manually archived";
      updates.performance_note = `${prefix}: ${args.performance_note}`;
    }
    await ctx.db.patch(angle._id, updates);
  },
});

export const unarchiveAngle = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) throw new Error("Angle not found");
    await ctx.db.patch(angle._id, {
      status: "active",
      updated_at: Date.now(),
    });
  },
});

export const getArchivedAngles = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_angles")
      .withIndex("by_project_and_status", (q) =>
        q.eq("project_id", args.projectId).eq("status", "archived")
      )
      .collect();
  },
});

// ─────────────────────────────────────────────────────────
// Phase 4 — Sub-angle derivation queries + helpers
// ─────────────────────────────────────────────────────────

export const getPendingReviewAngles = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_angles")
      .withIndex("by_project_and_status", (q) =>
        q.eq("project_id", args.projectId).eq("status", "pending_review")
      )
      .collect();
  },
});

export const getSubAnglesByParent = query({
  args: { parent_angle_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_angles")
      .withIndex("by_parent", (q) => q.eq("parent_angle_id", args.parent_angle_id))
      .collect();
  },
});

// Returns recently derived angles (children with derived_at >= since_ms),
// scoped to one project.
export const getRecentlyDerived = query({
  args: { projectId: v.string(), since_ms: v.number() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("conductor_angles")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return all
      .filter((a) => a.derived_at && a.derived_at >= args.since_ms)
      .sort((a, b) => (b.derived_at || 0) - (a.derived_at || 0));
  },
});

// Returns the full lineage rooted at the given angle (depth-first, transitive).
export const getLineage = query({
  args: { angle_external_id: v.string() },
  handler: async (ctx, args) => {
    const root = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.angle_external_id))
      .first();
    if (!root) return [];
    const out = [root];
    const queue = [root.externalId];
    while (queue.length > 0) {
      const id = queue.shift();
      const children = await ctx.db
        .query("conductor_angles")
        .withIndex("by_parent", (q) => q.eq("parent_angle_id", id))
        .collect();
      for (const c of children) {
        out.push(c);
        queue.push(c.externalId);
      }
    }
    return out;
  },
});

// Atomic race lock for derivation. Acquires (returns true) only if not already
// locked. Idempotent release. Cron AND manual-derive both go through this.
export const setDerivationLock = mutation({
  args: { externalId: v.string(), in_progress: v.boolean() },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) throw new Error("Angle not found");
    // Acquire — fail if already in progress
    if (args.in_progress && angle.derivation_in_progress) {
      return { acquired: false };
    }
    await ctx.db.patch(angle._id, {
      derivation_in_progress: args.in_progress,
      updated_at: Date.now(),
    });
    return { acquired: true };
  },
});

// Bulk-update observation stats for many angles at once. Cron stats phase.
export const bulkUpdateAngleStats = mutation({
  args: {
    updates: v.array(v.object({
      externalId: v.string(),
      since_last_derived_pass_count: v.number(),
      since_last_derived_fail_count: v.number(),
      lifetime_pass_count: v.number(),
      lifetime_fail_count: v.number(),
      lifetime_pass_rate: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const u of args.updates) {
      const angle = await ctx.db
        .query("conductor_angles")
        .withIndex("by_externalId", (q) => q.eq("externalId", u.externalId))
        .first();
      if (!angle) continue;
      await ctx.db.patch(angle._id, {
        since_last_derived_pass_count: u.since_last_derived_pass_count,
        since_last_derived_fail_count: u.since_last_derived_fail_count,
        lifetime_pass_count: u.lifetime_pass_count,
        lifetime_fail_count: u.lifetime_fail_count,
        lifetime_pass_rate: u.lifetime_pass_rate,
        observation_stats_updated_at: now,
        updated_at: now,
      });
    }
    return { updated: args.updates.length };
  },
});

// Approve a pending_review sub-angle. Restarts the exploration boost clock so
// the freshly-approved angle gets the full 14-day window.
export const approveSubAngle = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) throw new Error("Angle not found");
    await ctx.db.patch(angle._id, {
      status: "active",
      derived_at: Date.now(),
      updated_at: Date.now(),
    });
  },
});

export const rejectSubAngle = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) return;
    // Hard-delete rejected pending-review angles — no point keeping them
    await ctx.db.delete(angle._id);
  },
});

// Admin-only bulk delete: remove this angle and ALL transitive descendants.
// observation_results pointing at deleted angle stay (audit history).
export const deleteAngleAndDescendants = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const queue = [args.externalId];
    let removed = 0;
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) continue;
      const angle = await ctx.db
        .query("conductor_angles")
        .withIndex("by_externalId", (q) => q.eq("externalId", id))
        .first();
      if (!angle) continue;
      const children = await ctx.db
        .query("conductor_angles")
        .withIndex("by_parent", (q) => q.eq("parent_angle_id", id))
        .collect();
      for (const c of children) queue.push(c.externalId);
      await ctx.db.delete(angle._id);
      removed += 1;
    }
    return { removed };
  },
});

// =============================================
// conductor_runs — audit log
// =============================================

export const getRuns = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("conductor_runs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return runs.slice(0, args.limit ?? 50);
  },
});

export const getActiveRuns = query({
  args: {},
  handler: async (ctx) => {
    const activeStatuses = new Set(["running", "scoring", "repairing", "processing"]);
    const runs = await ctx.db.query("conductor_runs").collect();
    return runs.filter((run) => activeStatuses.has(run.status));
  },
});

export const getTestRunQueue = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const visibleStatuses = new Set(["queued", "running", "scoring", "repairing", "processing"]);
    const runs = await ctx.db
      .query("conductor_runs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return runs
      .filter((run) => run.run_type === "test" && visibleStatuses.has(run.status))
      .sort((a, b) => {
        if (a.status === "queued" && b.status === "queued") {
          return (a.queue_position ?? 0) - (b.queue_position ?? 0);
        }
        if (a.status === "queued") return 1;
        if (b.status === "queued") return -1;
        return (b.run_at || b.created_at || 0) - (a.run_at || a.created_at || 0);
      })
      .slice(0, args.limit ?? 50);
  },
});

export const createRun = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    run_type: v.string(),
    run_at: v.number(),
    posting_days: v.optional(v.string()),
    batches_created: v.optional(v.string()),
    angles_generated: v.optional(v.string()),
    decisions: v.optional(v.string()),
    status: v.string(),
    error: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    terminal_status: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    required_passes: v.optional(v.number()),
    ads_per_round: v.optional(v.number()),
    template_tag: v.optional(v.string()),
    max_rounds: v.optional(v.number()),
    total_rounds: v.optional(v.number()),
    total_ads_generated: v.optional(v.number()),
    total_ads_scored: v.optional(v.number()),
    total_ads_passed: v.optional(v.number()),
    ready_to_post_count: v.optional(v.number()),
    flex_ad_id: v.optional(v.string()),
    rounds_json: v.optional(v.string()),
    error_stage: v.optional(v.string()),
    scoring_started_at: v.optional(v.number()),
    last_heartbeat_at: v.optional(v.string()),
    queue_position: v.optional(v.number()),
    queued_at: v.optional(v.string()),
    started_at: v.optional(v.string()),
    queued_angle_id: v.optional(v.string()),
    worker_lease_owner: v.optional(v.string()),
    worker_lease_expires_at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("conductor_runs", {
      ...args,
      created_at: Date.now(),
    });
  },
});

export const updateRun = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    error: v.optional(v.string()),
    batches_created: v.optional(v.string()),
    angles_generated: v.optional(v.string()),
    decisions: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    posting_days: v.optional(v.string()),
    terminal_status: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    required_passes: v.optional(v.number()),
    ads_per_round: v.optional(v.number()),
    template_tag: v.optional(v.string()),
    max_rounds: v.optional(v.number()),
    total_rounds: v.optional(v.number()),
    total_ads_generated: v.optional(v.number()),
    total_ads_scored: v.optional(v.number()),
    total_ads_passed: v.optional(v.number()),
    ready_to_post_count: v.optional(v.number()),
    flex_ad_id: v.optional(v.string()),
    rounds_json: v.optional(v.string()),
    error_stage: v.optional(v.string()),
    scoring_started_at: v.optional(v.number()),
    last_heartbeat_at: v.optional(v.string()),
    queue_position: v.optional(v.number()),
    queued_at: v.optional(v.string()),
    started_at: v.optional(v.string()),
    queued_angle_id: v.optional(v.string()),
    worker_lease_owner: v.optional(v.string()),
    worker_lease_expires_at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("conductor_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!run) throw new Error("Run not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(run._id, filtered);
  },
});

export const enqueueTestRun = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    queued_angle_id: v.string(),
    required_passes: v.number(),
    ads_per_round: v.number(),
    template_tag: v.optional(v.string()),
    max_rounds: v.number(),
    now: v.string(),
    run_at: v.number(),
  },
  handler: async (ctx, args) => {
    const projectRuns = await ctx.db
      .query("conductor_runs")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .collect();
    const queuedRuns = projectRuns.filter((run) => run.run_type === "test" && run.status === "queued");
    const maxPosition = queuedRuns.reduce((max, run) => Math.max(max, run.queue_position ?? 0), 0);
    const queuePosition = maxPosition + 1;
    await ctx.db.insert("conductor_runs", {
      externalId: args.externalId,
      project_id: args.project_id,
      run_type: "test",
      run_at: args.run_at,
      status: "queued",
      terminal_status: "queued",
      decisions: `Queued test run #${queuePosition}.`,
      required_passes: args.required_passes,
      ads_per_round: args.ads_per_round,
      template_tag: args.template_tag,
      max_rounds: args.max_rounds,
      queued_angle_id: args.queued_angle_id,
      queued_at: args.now,
      queue_position: queuePosition,
      created_at: args.run_at,
    });
    return {
      queued: true,
      run: {
        externalId: args.externalId,
        project_id: args.project_id,
        run_type: "test",
        run_at: args.run_at,
        status: "queued",
        terminal_status: "queued",
        decisions: `Queued test run #${queuePosition}.`,
        required_passes: args.required_passes,
        ads_per_round: args.ads_per_round,
        template_tag: args.template_tag,
        max_rounds: args.max_rounds,
        queued_angle_id: args.queued_angle_id,
        queued_at: args.now,
        queue_position: queuePosition,
        created_at: args.run_at,
      },
    };
  },
});

export const claimQueuedTestRun = mutation({
  args: {
    owner: v.string(),
    lease_expires_at: v.string(),
    now: v.string(),
  },
  handler: async (ctx, args) => {
    const activeStatuses = new Set(["running", "scoring", "repairing", "processing"]);
    const queuedRuns = await ctx.db
      .query("conductor_runs")
      .withIndex("by_status_and_queue_position", (q) => q.eq("status", "queued"))
      .order("asc")
      .collect();

    for (const run of queuedRuns) {
      const leaseOwner = run.worker_lease_owner || null;
      const leaseExpiresAt = run.worker_lease_expires_at || null;
      if (leaseOwner && leaseOwner !== args.owner && leaseExpiresAt && leaseExpiresAt > args.now) {
        continue;
      }

      const projectRuns = await ctx.db
        .query("conductor_runs")
        .withIndex("by_project", (q) => q.eq("project_id", run.project_id))
        .collect();
      const activeRun = projectRuns.find((candidate) =>
        candidate.externalId !== run.externalId && activeStatuses.has(candidate.status)
      );
      if (activeRun) continue;

      const patch = {
        status: "running",
        terminal_status: "starting",
        started_at: args.now,
        last_heartbeat_at: args.now,
        worker_lease_owner: args.owner,
        worker_lease_expires_at: args.lease_expires_at,
      };
      await ctx.db.patch(run._id, patch);
      return { claimed: true, run: { ...run, ...patch } };
    }

    return { claimed: false, reason: "none_available" };
  },
});

export const releaseQueuedTestRun = mutation({
  args: {
    externalId: v.string(),
    owner: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("conductor_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!run) return { released: false, reason: "not_found" };
    if (run.worker_lease_owner && run.worker_lease_owner !== args.owner) {
      return { released: false, reason: "not_owner" };
    }
    await ctx.db.patch(run._id, {
      worker_lease_owner: "",
      worker_lease_expires_at: "",
    });
    return { released: true };
  },
});

export const cancelQueuedTestRun = mutation({
  args: {
    externalId: v.string(),
    now: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("conductor_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!run) return { cancelled: false, reason: "not_found" };
    if (run.status !== "queued") return { cancelled: false, reason: "not_queued", run };

    const patch = {
      status: "cancelled",
      terminal_status: "cancelled",
      error: "Cancelled by user",
      failure_reason: "Cancelled by user",
      error_stage: "cancelled",
      duration_ms: 0,
      last_heartbeat_at: args.now,
      worker_lease_owner: "",
      worker_lease_expires_at: "",
      decisions: "Queued test run cancelled before it started.",
    };
    await ctx.db.patch(run._id, patch);
    return { cancelled: true, run: { ...run, ...patch } };
  },
});

// =============================================
// conductor_slots — durable posting-day slot reservations
// =============================================

export const getSlotsByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_slots")
      .withIndex("by_project_and_posting_day", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getSlotsByPostingDay = query({
  args: { projectId: v.string(), postingDay: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_slots")
      .withIndex("by_project_and_posting_day", (q) =>
        q.eq("project_id", args.projectId).eq("posting_day", args.postingDay)
      )
      .collect();
  },
});

export const createSlot = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    posting_day: v.string(),
    slot_index: v.number(),
    angle_name: v.string(),
    angle_external_id: v.optional(v.string()),
    status: v.string(),
    batch_ids: v.optional(v.string()),
    attempt_count: v.optional(v.number()),
    last_attempt_at: v.optional(v.number()),
    produced_flex_ad_id: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    diagnostics_summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("conductor_slots", {
      ...args,
      attempt_count: args.attempt_count ?? 0,
      created_at: now,
      updated_at: now,
    });
  },
});

export const updateSlot = mutation({
  args: {
    externalId: v.string(),
    angle_name: v.optional(v.string()),
    angle_external_id: v.optional(v.string()),
    status: v.optional(v.string()),
    batch_ids: v.optional(v.string()),
    attempt_count: v.optional(v.number()),
    last_attempt_at: v.optional(v.number()),
    produced_flex_ad_id: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    diagnostics_summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const slot = await ctx.db
      .query("conductor_slots")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!slot) throw new Error("Slot not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = { updated_at: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(slot._id, filtered);
  },
});

// =============================================
// conductor_playbooks — per-angle learning memory
// =============================================

export const getPlaybooks = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_playbooks")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getPlaybook = query({
  args: { projectId: v.string(), angleName: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_playbooks")
      .withIndex("by_project_and_angle", (q) =>
        q.eq("project_id", args.projectId).eq("angle_name", args.angleName)
      )
      .first();
  },
});

export const upsertPlaybook = mutation({
  args: {
    project_id: v.string(),
    angle_name: v.string(),
    version: v.number(),
    total_scored: v.number(),
    total_passed: v.number(),
    pass_rate: v.number(),
    visual_patterns: v.optional(v.string()),
    copy_patterns: v.optional(v.string()),
    avoid_patterns: v.optional(v.string()),
    generation_hints: v.optional(v.string()),
    raw_analysis: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conductor_playbooks")
      .withIndex("by_project_and_angle", (q) =>
        q.eq("project_id", args.project_id).eq("angle_name", args.angle_name)
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        last_updated: now,
      });
    } else {
      await ctx.db.insert("conductor_playbooks", {
        ...args,
        last_updated: now,
        created_at: now,
      });
    }
  },
});

// =============================================
// auto_post_log — audit trail for auto-posting
// =============================================

export const createAutoPostLog = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    ad_set_id: v.string(),
    meta_adset_id: v.optional(v.string()),
    status: v.string(),
    gate_reason: v.optional(v.string()),
    error_message: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    created_at: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auto_post_log", args);
  },
});

export const getAutoPostLogsByProject = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("auto_post_log")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return results.slice(0, args.limit ?? 50);
  },
});

// =============================================
// reconciliation_log — audit trail for manual linking
// =============================================

export const createReconciliationLog = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    action: v.string(),
    cf_entity_id: v.string(),
    cf_entity_type: v.string(),
    meta_entity_id: v.string(),
    linked_by: v.string(),
    notes: v.optional(v.string()),
    created_at: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("reconciliation_log", args);
  },
});

export const getReconciliationLogsByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reconciliation_log")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
  },
});

// =============================================
// reconciliation_archives — hidden unlinked Meta entities
// =============================================

const archiveEntryValidator = v.object({
  meta_adset_id: v.string(),
  name: v.optional(v.string()),
  campaign_name: v.optional(v.string()),
  status: v.optional(v.string()),
  snapshot_json: v.optional(v.string()),
});

export const getArchivedUnlinkedAdSetsByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reconciliation_archives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return rows
      .filter((row) => row.meta_entity_type === "ad_set" && !row.unarchived_at)
      .sort((a, b) => (a.archived_at < b.archived_at ? 1 : -1));
  },
});

export const archiveUnlinkedAdSets = mutation({
  args: {
    projectId: v.string(),
    archived_by: v.string(),
    ad_sets: v.array(archiveEntryValidator),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    let archived = 0;
    for (const entry of args.ad_sets) {
      const metaAdSetId = entry.meta_adset_id.trim();
      if (!metaAdSetId) continue;
      const existing = await ctx.db
        .query("reconciliation_archives")
        .withIndex("by_project_and_meta", (q) =>
          q.eq("project_id", args.projectId).eq("meta_adset_id", metaAdSetId)
        )
        .first();
      const snapshotFields: Record<string, any> = {
        meta_entity_type: "ad_set",
        archived_at: now,
        archived_by: args.archived_by,
        updated_at: now,
      };
      if (entry.name !== undefined) snapshotFields.name = entry.name;
      if (entry.campaign_name !== undefined) snapshotFields.campaign_name = entry.campaign_name;
      if (entry.status !== undefined) snapshotFields.status = entry.status;
      if (entry.snapshot_json !== undefined) snapshotFields.snapshot_json = entry.snapshot_json;

      if (existing) {
        await ctx.db.patch(existing._id, {
          ...snapshotFields,
          unarchived_at: undefined,
          unarchived_by: undefined,
        });
      } else {
        await ctx.db.insert("reconciliation_archives", {
          externalId: crypto.randomUUID(),
          project_id: args.projectId,
          meta_adset_id: metaAdSetId,
          ...snapshotFields,
        });
      }
      archived += 1;
    }
    return { archived };
  },
});

export const unarchiveUnlinkedAdSets = mutation({
  args: {
    projectId: v.string(),
    unarchived_by: v.string(),
    meta_adset_ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    let unarchived = 0;
    for (const rawId of args.meta_adset_ids) {
      const metaAdSetId = String(rawId || "").trim();
      if (!metaAdSetId) continue;
      const existing = await ctx.db
        .query("reconciliation_archives")
        .withIndex("by_project_and_meta", (q) =>
          q.eq("project_id", args.projectId).eq("meta_adset_id", metaAdSetId)
        )
        .first();
      if (!existing || existing.unarchived_at) continue;
      await ctx.db.patch(existing._id, {
        unarchived_at: now,
        unarchived_by: args.unarchived_by,
        updated_at: now,
      });
      unarchived += 1;
    }
    return { unarchived };
  },
});

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { adjustProjectCounters } from "./projects";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "quality_rejected",
  "cancelled",
  "canceled",
]);

function isTerminalStatus(status: string | undefined) {
  return !!status && TERMINAL_STATUSES.has(status);
}

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("ad_creatives").collect();
  },
});

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .take(1000);
  },
});

export const getByProjectWithUrls = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return Promise.all(
      ads.map(async (ad) => ({
        ...ad,
        resolvedImageUrl: ad.storageId
          ? await ctx.storage.getUrl(ad.storageId)
          : null,
      }))
    );
  },
});

export const getGalleryByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .take(500);

    return ads.map((ad) => ({
      externalId: ad.externalId,
      project_id: ad.project_id,
      generation_mode: ad.generation_mode,
      angle: ad.angle,
      angle_name: ad.angle_name,
      headline: ad.headline,
      body_copy: ad.body_copy,
      hook_lane: ad.hook_lane,
      core_claim: ad.core_claim,
      target_symptom: ad.target_symptom,
      emotional_entry: ad.emotional_entry,
      desired_belief_shift: ad.desired_belief_shift,
      opening_pattern: ad.opening_pattern,
      scoring_mode: ad.scoring_mode,
      copy_render_expectation: ad.copy_render_expectation,
      product_expectation: ad.product_expectation,
      sub_angle: ad.sub_angle,
      template_image_id: ad.template_image_id,
      storageId: ad.storageId,
      aspect_ratio: ad.aspect_ratio,
      status: ad.status,
      auto_generated: ad.auto_generated,
      parent_ad_id: ad.parent_ad_id,
      tags: ad.tags,
      is_favorite: ad.is_favorite,
      drive_file_id: ad.drive_file_id,
      drive_url: ad.drive_url,
      has_image_prompt: !!ad.image_prompt,
      gemini_batch_job: ad.gemini_batch_job,
      error_message: ad.error_message,
      failure_stage: ad.failure_stage,
      cancellation_requested_at: ad.cancellation_requested_at,
      cancelled_by: ad.cancelled_by,
      last_progress_at: ad.last_progress_at,
      image_attempts: ad.image_attempts,
      updated_at: ad.updated_at,
      completed_at: ad.completed_at,
      batch_job_id: ad.batch_job_id,
      created_at: ad.created_at,
    }));
  },
});

export const getInProgressByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .take(500);
    return ads.filter(
      (ad) => ad.status === "generating_copy" || ad.status === "generating_image"
    );
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const getSummariesByExternalIds = query({
  args: { externalIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const uniqueExternalIds = [...new Set(args.externalIds)].slice(0, 500);

    const ads = await Promise.all(
      uniqueExternalIds.map((externalId) =>
        ctx.db
          .query("ad_creatives")
          .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
          .first()
      )
    );

    return ads.filter(Boolean).map((ad) => ({
      externalId: ad!.externalId,
      project_id: ad!.project_id,
      angle: ad!.angle,
      angle_name: ad!.angle_name,
      headline: ad!.headline,
      body_copy: ad!.body_copy,
      hook_lane: ad!.hook_lane,
      core_claim: ad!.core_claim,
      tags: ad!.tags || [],
      has_image: !!ad!.storageId,
      image_attempts: ad!.image_attempts,
      updated_at: ad!.updated_at,
      completed_at: ad!.completed_at,
    }));
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    angle: v.optional(v.string()),
    angle_name: v.optional(v.string()),
    headline: v.optional(v.string()),
    body_copy: v.optional(v.string()),
    hook_lane: v.optional(v.string()),
    core_claim: v.optional(v.string()),
    target_symptom: v.optional(v.string()),
    emotional_entry: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    opening_pattern: v.optional(v.string()),
    scoring_mode: v.optional(v.string()),
    copy_render_expectation: v.optional(v.string()),
    product_expectation: v.optional(v.string()),
    image_prompt: v.optional(v.string()),
    gpt_creative_output: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    drive_file_id: v.optional(v.string()),
    drive_url: v.optional(v.string()),
    aspect_ratio: v.optional(v.string()),
    status: v.optional(v.string()),
    auto_generated: v.optional(v.boolean()),
    parent_ad_id: v.optional(v.string()),
    batch_job_id: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    sub_angle: v.optional(v.string()),
    text_model: v.optional(v.string()),
    image_model: v.optional(v.string()),
    gemini_batch_job: v.optional(v.string()),
    error_message: v.optional(v.union(v.string(), v.null())),
    failure_stage: v.optional(v.union(v.string(), v.null())),
    cancellation_requested_at: v.optional(v.string()),
    cancelled_by: v.optional(v.string()),
    last_progress_at: v.optional(v.string()),
    image_attempts: v.optional(v.string()),
    updated_at: v.optional(v.string()),
    completed_at: v.optional(v.string()),
    worker_lease_owner: v.optional(v.union(v.string(), v.null())),
    worker_lease_expires_at: v.optional(v.union(v.string(), v.null())),
    // Phase 1 — Staging Page + Filter agent
    ad_set_id: v.optional(v.string()),
    filter_score: v.optional(v.number()),
    filter_verdict: v.optional(v.string()),
    filter_reasons: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const completedAt = args.completed_at || (isTerminalStatus(args.status) ? now : undefined);
    await ctx.db.insert("ad_creatives", {
      ...args,
      created_at: now,
      updated_at: args.updated_at || now,
      ...(completedAt ? { completed_at: completedAt } : {}),
    });
    await adjustProjectCounters(ctx, args.project_id, { adCount: 1 });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    image_prompt: v.optional(v.string()),
    gpt_creative_output: v.optional(v.string()),
    headline: v.optional(v.string()),
    body_copy: v.optional(v.string()),
    angle_name: v.optional(v.string()),
    hook_lane: v.optional(v.string()),
    core_claim: v.optional(v.string()),
    target_symptom: v.optional(v.string()),
    emotional_entry: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    opening_pattern: v.optional(v.string()),
    scoring_mode: v.optional(v.string()),
    copy_render_expectation: v.optional(v.string()),
    product_expectation: v.optional(v.string()),
    sub_angle: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    drive_file_id: v.optional(v.string()),
    drive_url: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    is_favorite: v.optional(v.boolean()),
    text_model: v.optional(v.string()),
    image_model: v.optional(v.string()),
    gemini_batch_job: v.optional(v.string()),
    error_message: v.optional(v.union(v.string(), v.null())),
    failure_stage: v.optional(v.union(v.string(), v.null())),
    cancellation_requested_at: v.optional(v.string()),
    cancelled_by: v.optional(v.string()),
    last_progress_at: v.optional(v.string()),
    image_attempts: v.optional(v.string()),
    updated_at: v.optional(v.string()),
    completed_at: v.optional(v.string()),
    worker_lease_owner: v.optional(v.union(v.string(), v.null())),
    worker_lease_expires_at: v.optional(v.union(v.string(), v.null())),
    // Phase 1 — Staging Page + Filter agent
    ad_set_id: v.optional(v.string()),
    filter_score: v.optional(v.number()),
    filter_verdict: v.optional(v.string()),
    filter_reasons: v.optional(v.string()),
    // Phase 2B — Meta posting
    meta_ad_id: v.optional(v.string()),
    meta_creative_id: v.optional(v.string()),
    meta_image_hash: v.optional(v.string()),
    meta_post_error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad) throw new Error("Ad creative not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    const now = new Date().toISOString();
    filtered.updated_at = updates.updated_at || now;
    if (isTerminalStatus(updates.status) && !filtered.completed_at && !ad.completed_at) {
      filtered.completed_at = now;
    }
    await ctx.db.patch(ad._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad) throw new Error("Ad creative not found");
    // If has a storageId, delete the stored file too
    if (ad.storageId) {
      await ctx.storage.delete(ad.storageId);
    }
    await ctx.db.delete(ad._id);
    await adjustProjectCounters(ctx, ad.project_id, { adCount: -1 });
  },
});

// Get all ads generated by a specific batch job
export const getByBatch = query({
  args: { batchId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_batch_job", (q) => q.eq("batch_job_id", args.batchId))
      .collect();
  },
});

export const getImageUrl = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad || !ad.storageId) return null;
    return await ctx.storage.getUrl(ad.storageId);
  },
});

// Phase 1 — Staging Page + Filter agent

export const getByAdSet = query({
  args: { adSetId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.adSetId))
      .collect();
  },
});

export const getRejectedByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return ads.filter((a) => a.status === "quality_rejected");
  },
});

// Filter agent writes its verdict here. Sets filter_score, filter_verdict, filter_reasons.
// Also flips status to "staging" or "quality_rejected" based on verdict.
export const setFilterVerdict = mutation({
  args: {
    externalId: v.string(),
    filter_score: v.number(),
    filter_verdict: v.string(), // "passed" | "rejected"
    filter_reasons: v.optional(v.string()), // JSON array
  },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad) throw new Error("Ad creative not found");
    const newStatus = args.filter_verdict === "passed" ? "staging" : "quality_rejected";
    const now = new Date().toISOString();
    await ctx.db.patch(ad._id, {
      filter_score: args.filter_score,
      filter_verdict: args.filter_verdict,
      filter_reasons: args.filter_reasons,
      status: newStatus,
      updated_at: now,
      ...(isTerminalStatus(newStatus) && !ad.completed_at ? { completed_at: now } : {}),
    });
  },
});

// Operator override: flip a quality_rejected ad back to staging.
export const forcePromote = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad) throw new Error("Ad creative not found");
    if (ad.status !== "quality_rejected") {
      throw new Error(`Cannot force-promote ad with status "${ad.status}" — only "quality_rejected" is eligible`);
    }
    const now = new Date().toISOString();
    await ctx.db.patch(ad._id, {
      status: "staging",
      filter_verdict: "passed",
      updated_at: now,
    });
  },
});

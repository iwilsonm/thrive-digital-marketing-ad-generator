// One-shot migration mutations. Run via `npx convex run migrations:<name>`.
// Each is idempotent (safe to re-run). Each is scoped to the deployment it runs against.
// Distinct fork-specific naming (e.g., wipeCFFlexAds) is intentional — discourages running
// these against the Dacia Automation Software deployment, which is a different Convex env.

import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Phase 1 — wipe all flex_ads rows from this fork's deployment.
// The legacy Planner/Flex Ad UI was removed in favor of the new Staging Page.
// DA Software runs on a separate
// Convex deployment so this migration cannot accidentally touch their data.
export const wipeCFFlexAds = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("flex_ads").collect();
    let deleted = 0;
    for (const fa of all) {
      await ctx.db.delete(fa._id);
      deleted++;
    }
    return { deleted };
  },
});

// Phase 6 — rename ad_set lifecycle values to match unified UI.
// staging  → draft  (Planner)
// promoted → ready  (Ready to Post)
// observing/passed/failed/failed_external/insufficient_data — unchanged.
// Idempotent: only renames rows still in old lifecycle values.
export const phase6RenameLifecycles = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("ad_sets").collect();
    let staging = 0, promoted = 0;
    for (const row of all) {
      if (row.lifecycle_status === "staging") {
        await ctx.db.patch(row._id, { lifecycle_status: "draft" });
        staging++;
      } else if (row.lifecycle_status === "promoted") {
        await ctx.db.patch(row._id, { lifecycle_status: "ready" });
        promoted++;
      }
    }
    return { renamed_staging_to_draft: staging, renamed_promoted_to_ready: promoted };
  },
});

// Phase 6 — Director run lock. Prevents concurrent Director runs (cron + manual)
// for the same project. Returns { acquired, expires_at }. Caller is responsible
// for releasing via releaseDirectorLock when done.
export const tryAcquireDirectorLock = mutation({
  args: { project_id: v.string(), ttlMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ttl = args.ttlMs ?? 5 * 60 * 1000; // 5 min default
    const now = Date.now();
    const existing = await ctx.db
      .query("director_locks")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();
    if (existing && existing.expires_at > now) {
      return { acquired: false, expires_at: existing.expires_at };
    }
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("director_locks", {
      project_id: args.project_id,
      acquired_at: now,
      expires_at: now + ttl,
    });
    return { acquired: true, expires_at: now + ttl };
  },
});

export const releaseDirectorLock = mutation({
  args: { project_id: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("director_locks")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return { released: !!existing };
  },
});

// Phase 6 — soft-lock deployments during Combine modal to prevent concurrent
// delete by another user. 30s TTL by default. Returns { locked, expires_at }
// or throws if any deployment is already locked by someone else.
export const softLockDeployments = mutation({
  args: { deployment_ids: v.array(v.string()), ttlMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ttl = args.ttlMs ?? 30_000;
    const now = Date.now();
    const expires = now + ttl;
    for (const id of args.deployment_ids) {
      const dep = await ctx.db
        .query("ad_deployments")
        .withIndex("by_externalId", (q) => q.eq("externalId", id))
        .first();
      if (!dep) continue;
      if (dep.lock_expires_at && dep.lock_expires_at > now) {
        throw new Error(`Deployment ${id} is locked until ${new Date(dep.lock_expires_at).toISOString()}`);
      }
      await ctx.db.patch(dep._id, { lock_expires_at: expires });
    }
    return { locked: args.deployment_ids.length, expires_at: expires };
  },
});

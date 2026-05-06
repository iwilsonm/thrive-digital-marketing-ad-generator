import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

type ProjectRecord = {
  _id: any;
  externalId: string;
  name: string;
  brand_name?: string;
  niche?: string;
  status?: string;
  archived_at?: string | null;
  template_seeding_status?: string;
  template_seeding_error?: string;
  docCount?: number;
  adCount?: number;
  lpCount?: number;
  lpPublishedCount?: number;
};

type ProjectStats = {
  docCount: number;
  adCount: number;
  lpCount: number;
  lpPublishedCount: number;
};

async function getProjectByExternalId(ctx: any, externalId: string) {
  return await ctx.db
    .query("projects")
    .withIndex("by_externalId", (q: any) => q.eq("externalId", externalId))
    .first();
}

function hasStoredStats(project: ProjectRecord) {
  return [project.docCount, project.adCount, project.lpCount, project.lpPublishedCount].every(
    (value) => typeof value === "number"
  );
}

function getStoredStats(project: ProjectRecord): ProjectStats {
  return {
    docCount: project.docCount ?? 0,
    adCount: project.adCount ?? 0,
    lpCount: project.lpCount ?? 0,
    lpPublishedCount: project.lpPublishedCount ?? 0,
  };
}

function isArchivedProject(project: ProjectRecord) {
  return typeof project.archived_at === "string" && project.archived_at.trim().length > 0;
}

async function countProjectAssets(ctx: any, projectId: string): Promise<ProjectStats> {
  const docs = await ctx.db
    .query("foundational_docs")
    .withIndex("by_project", (q: any) => q.eq("project_id", projectId))
    .collect();
  const ads = await ctx.db
    .query("ad_creatives")
    .withIndex("by_project", (q: any) => q.eq("project_id", projectId))
    .collect();

  return {
    docCount: docs.length,
    adCount: ads.length,
    lpCount: 0,
    lpPublishedCount: 0,
  };
}

async function getProjectStatsForRecord(ctx: any, project: ProjectRecord): Promise<ProjectStats> {
  if (hasStoredStats(project)) {
    return getStoredStats(project);
  }
  return countProjectAssets(ctx, project.externalId);
}

function toProjectSummary(project: ProjectRecord, stats: ProjectStats) {
  return {
    externalId: project.externalId,
    name: project.name,
    brand_name: project.brand_name,
    niche: project.niche,
    status: project.status ?? "setup",
    archived_at: project.archived_at ?? null,
    template_seeding_status: project.template_seeding_status ?? "complete",
    template_seeding_error: project.template_seeding_error ?? "",
    ...stats,
  };
}

export async function adjustProjectCounters(
  ctx: any,
  projectId: string,
  deltas: Partial<Record<keyof ProjectStats, number>>
) {
  const project = await getProjectByExternalId(ctx, projectId);
  if (!project) return;

  const patch: Partial<ProjectStats> = {};
  for (const [key, delta] of Object.entries(deltas)) {
    if (!delta) continue;
    const statsKey = key as keyof ProjectStats;
    const current = typeof project[statsKey] === "number" ? project[statsKey] : 0;
    patch[statsKey] = Math.max(0, current + delta);
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(project._id, patch);
  }
}

export const create = mutation({
  args: {
    externalId: v.string(),
    name: v.string(),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("projects", {
      ...args,
      docCount: 0,
      adCount: 0,
      lpCount: 0,
      lpPublishedCount: 0,
      status: "setup",
      template_seeding_status: "pending",
      template_seeding_error: "",
      created_at: now,
      updated_at: now,
    });
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").order("desc").collect();
    return projects.filter((project) => !isArchivedProject(project));
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
    prompt_guidelines: v.optional(v.string()),
    status: v.optional(v.string()),
    template_seeding_status: v.optional(v.string()),
    template_seeding_error: v.optional(v.string()),
    // Creative Filter QA + Ready-to-Post defaults
    scout_enabled: v.optional(v.boolean()),
    scout_default_campaign: v.optional(v.string()),
    scout_cta: v.optional(v.string()),
    scout_display_link: v.optional(v.string()),
    scout_facebook_page: v.optional(v.string()),
    scout_score_threshold: v.optional(v.number()),
    scout_daily_flex_ads: v.optional(v.number()),
    scout_destination_url: v.optional(v.string()),
    scout_destination_urls: v.optional(v.string()),
    scout_duplicate_adset_name: v.optional(v.string()),
    docCount: v.optional(v.float64()),
    adCount: v.optional(v.float64()),
    lpCount: v.optional(v.float64()),
    lpPublishedCount: v.optional(v.float64()),
    // Phase 1 — Staging Page + Director cycle config
    default_campaign_id: v.optional(v.string()),
    adset_default_template: v.optional(v.string()),
    filter_quality_threshold: v.optional(v.number()),
    ad_sets_per_cycle: v.optional(v.number()),
    ads_per_ad_set: v.optional(v.number()),
    // Phase 2A — Meta integration
    meta_access_token: v.optional(v.string()),
    meta_token_expires_at: v.optional(v.number()),
    meta_user_id: v.optional(v.string()),
    meta_user_name: v.optional(v.string()),
    meta_account_id: v.optional(v.string()),
    meta_account_name: v.optional(v.string()),
    meta_business_id: v.optional(v.string()),
    meta_integration_path: v.optional(v.string()),
    meta_read_path: v.optional(v.string()),
    meta_connected_at: v.optional(v.number()),
    // Phase 2B
    meta_page_id: v.optional(v.string()),
    meta_page_name: v.optional(v.string()),
    // Phase 3 — account currency cached from Meta
    meta_account_currency: v.optional(v.string()),
    archived_at: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");

    const { externalId, ...updates } = args;
    // Filter out undefined values
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    filtered.updated_at = new Date().toISOString();
    await ctx.db.patch(project._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");

    const now = new Date().toISOString();
    await ctx.db.patch(project._id, {
      archived_at: now,
      updated_at: now,
    });
  },
});

export const setProductImage = mutation({
  args: {
    externalId: v.string(),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");

    // Delete old image from storage if replacing
    if (project.product_image_storageId && project.product_image_storageId !== args.storageId) {
      try {
        await ctx.storage.delete(project.product_image_storageId);
      } catch {
        // Ignore if already deleted
      }
    }

    await ctx.db.patch(project._id, {
      product_image_storageId: args.storageId,
      updated_at: new Date().toISOString(),
    });
  },
});

export const getStats = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const project = await getProjectByExternalId(ctx, args.projectId);
    if (!project) throw new Error("Project not found");
    return await getProjectStatsForRecord(ctx, project);
  },
});

export const getSummaries = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").order("desc").collect();
    const activeProjects = projects.filter((project) => !isArchivedProject(project));

    return await Promise.all(
      activeProjects.map(async (project) => {
        const stats = await getProjectStatsForRecord(ctx, project);
        return toProjectSummary(project, stats);
      })
    );
  },
});

export const getArchivedSummaries = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const archivedProjects = projects
      .filter(isArchivedProject)
      .sort((a, b) => String(b.archived_at || "").localeCompare(String(a.archived_at || "")));

    return await Promise.all(
      archivedProjects.map(async (project) => {
        const stats = await getProjectStatsForRecord(ctx, project);
        return toProjectSummary(project, stats);
      })
    );
  },
});

export const getOptions = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").order("desc").collect();
    return projects.filter((project) => !isArchivedProject(project)).map((project) => ({
      externalId: project.externalId,
      name: project.name,
      brand_name: project.brand_name,
      displayName: project.brand_name || project.name,
      status: project.status ?? "setup",
      archived_at: project.archived_at ?? null,
      template_seeding_status: project.template_seeding_status ?? "complete",
      template_seeding_error: project.template_seeding_error ?? "",
    }));
  },
});

// Combined query retained for compatibility with older call sites.
export const getAllWithStats = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").order("desc").collect();
    const activeProjects = projects.filter((project) => !isArchivedProject(project));
    return Promise.all(
      activeProjects.map(async (project) => {
        const stats = await getProjectStatsForRecord(ctx, project);
        return {
          ...project,
          ...stats,
        };
      })
    );
  },
});

export const backfillStoredStats = mutation({
  args: {
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const projects = await ctx.db.query("projects").collect();
    let updated = 0;

    for (const project of projects) {
      if (!args.force && hasStoredStats(project)) {
        continue;
      }

      const stats = await countProjectAssets(ctx, project.externalId);
      await ctx.db.patch(project._id, stats);
      updated += 1;
    }

    return { updated };
  },
});

// Phase 2A — Meta integration: list projects whose tokens expire within `withinMs` from now.
// Used by the daily Vercel Cron Job at /api/meta/oauth/refresh to keep tokens fresh.
export const getWithExpiringMetaTokens = query({
  args: { withinMs: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = now + args.withinMs;
    const projects = await ctx.db.query("projects").collect();
    return projects
      .filter((p) =>
        !isArchivedProject(p) &&
        !!p.meta_access_token &&
        typeof p.meta_token_expires_at === "number" &&
        p.meta_token_expires_at <= cutoff
      )
      .map((p) => ({
        externalId: p.externalId,
        meta_access_token: p.meta_access_token,
        meta_token_expires_at: p.meta_token_expires_at,
        meta_user_id: p.meta_user_id,
      }));
  },
});

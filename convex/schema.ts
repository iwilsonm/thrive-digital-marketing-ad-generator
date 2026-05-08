import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  settings: defineTable({
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),

  meta_mcp_diagnostics: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    meta_account_id: v.string(),
    status: v.string(),
    read_access: v.string(),
    posting_access: v.string(),
    reason_code: v.string(),
    read_reason_code: v.optional(v.string()),
    posting_reason_code: v.optional(v.string()),
    user_message: v.string(),
    technical_details: v.optional(v.string()),
    checked_at: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_account", ["project_id", "meta_account_id"]),

  projects: defineTable({
    externalId: v.string(),
    name: v.string(),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
    prompt_guidelines: v.optional(v.string()),
    product_image_storageId: v.optional(v.id("_storage")),
    docCount: v.optional(v.float64()),
    adCount: v.optional(v.float64()),
    lpCount: v.optional(v.float64()),
    lpPublishedCount: v.optional(v.float64()),
    status: v.optional(v.string()),
    template_seeding_status: v.optional(v.string()),
    template_seeding_error: v.optional(v.string()),
    // Creative Filter QA + Ready-to-Post defaults — per-project config
    scout_enabled: v.optional(v.boolean()),
    scout_default_campaign: v.optional(v.string()),
    scout_cta: v.optional(v.string()),
    scout_display_link: v.optional(v.string()),
    scout_facebook_page: v.optional(v.string()),
    scout_score_threshold: v.optional(v.number()),
    scout_daily_flex_ads: v.optional(v.number()),  // Legacy manual filter cap; Director Ad Set Target is the primary volume control
    scout_destination_url: v.optional(v.string()),        // Default website/landing page URL (legacy single)
    scout_destination_urls: v.optional(v.string()),       // JSON array of default LP URLs (overrides single)
    scout_duplicate_adset_name: v.optional(v.string()),   // Default "duplicate this ad set" name for Meta
    // Phase 1 — Staging Page + Director cycle config
    default_campaign_id: v.optional(v.string()),          // → campaigns.externalId; default Meta campaign for new ad sets
    adset_default_template: v.optional(v.string()),       // JSON: { targeting, budget_type, budget_amount_cents, schedule, optimization_goal, billing_event }
    filter_quality_threshold: v.optional(v.number()),     // 0-1, Filter agent pass threshold; default 0.6
    ad_sets_per_cycle: v.optional(v.number()),            // Director: how many ad sets to generate per cycle; default 5
    ads_per_ad_set: v.optional(v.number()),               // Director: ads per ad set; default 5, hard cap 20
    // Phase 2A — Meta integration (per-project OAuth + ad account binding)
    meta_access_token: v.optional(v.string()),            // long-lived (60-day) FB Marketing API token; powers both direct API + MCP paths
    meta_token_expires_at: v.optional(v.number()),        // unix ms; refresh trigger
    meta_user_id: v.optional(v.string()),                 // connected FB user ID
    meta_user_name: v.optional(v.string()),               // for "Connected as ___" display
    meta_account_id: v.optional(v.string()),              // selected ad account (act_XXX format)
    meta_account_name: v.optional(v.string()),
    meta_business_id: v.optional(v.string()),             // Business Manager ID (if applicable)
    meta_integration_path: v.optional(v.string()),        // "mcp" | "api" — defaults to "mcp"
    meta_read_path: v.optional(v.string()),               // "api" | "mcp" — defaults to "api"; controls Analytics/Observation reads
    meta_connected_at: v.optional(v.number()),            // unix ms; when OAuth completed
    // Phase 2B — Facebook Page selected for posting ads (one Page per project)
    meta_page_id: v.optional(v.string()),
    meta_page_name: v.optional(v.string()),
    // Phase 3 — Account currency (fetched once on connect; benchmarks stored in this currency)
    meta_account_currency: v.optional(v.string()),
    archived_at: v.optional(v.union(v.string(), v.null())),
    created_at: v.string(),
    updated_at: v.string(),
  }).index("by_externalId", ["externalId"]),

  foundational_docs: defineTable({
    externalId: v.string(),
    project_id: v.string(), // references projects.externalId
    doc_type: v.string(),
    content: v.optional(v.string()),
    version: v.number(),
    approved: v.boolean(),
    source: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_type", ["project_id", "doc_type"]),

  template_images: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    filename: v.string(),
    storageId: v.optional(v.id("_storage")),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    archived_at: v.optional(v.union(v.string(), v.null())),
    analysis: v.optional(v.string()),
    source_template_id: v.optional(v.string()),
    source_project_id: v.optional(v.string()),
    source_storage_id: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.optional(v.string()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  ad_creatives: defineTable({
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
    thumbnailStorageId: v.optional(v.id("_storage")),
    drive_file_id: v.optional(v.string()),
    drive_url: v.optional(v.string()),
    aspect_ratio: v.optional(v.string()),
    status: v.optional(v.string()),
    auto_generated: v.optional(v.boolean()),
    parent_ad_id: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    is_favorite: v.optional(v.boolean()),    // Heart/favorite toggle in gallery
    batch_job_id: v.optional(v.string()),    // → batch_jobs.externalId (batch that generated this ad)
    copy_framework: v.optional(v.string()),  // Legacy: from removed diversity features
    sub_angle: v.optional(v.string()),       // Secondary variation label within a hook lane
    text_model: v.optional(v.string()),      // LLM used for copy (e.g., "gpt-5.2")
    image_model: v.optional(v.string()),     // Model used for image (e.g., "nano-banana-2")
    gemini_batch_job: v.optional(v.string()), // Ad Studio durable image job name
    error_message: v.optional(v.union(v.string(), v.null())),
    failure_stage: v.optional(v.union(v.string(), v.null())),
    cancellation_requested_at: v.optional(v.string()),
    cancelled_by: v.optional(v.string()),
    last_progress_at: v.optional(v.string()),
    image_attempts: v.optional(v.string()), // JSON array of sync image-generation attempt diagnostics
    updated_at: v.optional(v.string()),
    completed_at: v.optional(v.string()),
    worker_lease_owner: v.optional(v.union(v.string(), v.null())),
    worker_lease_expires_at: v.optional(v.union(v.string(), v.null())),
    // Phase 1 — Staging Page + Filter agent
    ad_set_id: v.optional(v.string()),       // → ad_sets.externalId; set when ad joins a Staging Page ad set
    filter_score: v.optional(v.number()),    // 0-1, Filter agent quality score
    filter_verdict: v.optional(v.string()),  // "passed" | "rejected" | null (null = not yet scored)
    filter_reasons: v.optional(v.string()),  // JSON array of reason strings (for rejected ads)
    // status field above accepts new values: "staging" | "quality_rejected"
    // Phase 2B — Meta-side IDs after posting to Meta
    meta_ad_id: v.optional(v.string()),       // Meta-side ad ID after posting
    meta_creative_id: v.optional(v.string()), // Meta-side creative ID
    meta_image_hash: v.optional(v.string()),  // hash returned by /adimages upload (idempotent)
    meta_post_error: v.optional(v.string()),  // error message if posting failed
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_batch_job", ["batch_job_id"])
    .index("by_project_and_angle_name", ["project_id", "angle_name"])
    .index("by_ad_set", ["ad_set_id"]),

  headline_history: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    angle_name: v.string(),
    batch_job_id: v.optional(v.string()),
    conductor_run_id: v.optional(v.string()),
    ad_creative_id: v.optional(v.string()),
    headline_text: v.string(),
    normalized_headline: v.string(),
    hook_lane: v.optional(v.string()),
    sub_angle: v.optional(v.string()),
    core_claim: v.optional(v.string()),
    target_symptom: v.optional(v.string()),
    emotional_entry: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    opening_pattern: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project_and_angle", ["project_id", "angle_name"])
    .index("by_project_angle_and_created_at", ["project_id", "angle_name", "created_at"])
    .index("by_batch_job", ["batch_job_id"])
    .index("by_run", ["conductor_run_id"]),

  batch_jobs: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    batch_size: v.number(),
    angle: v.optional(v.string()),
    angles: v.optional(v.string()),  // JSON array of angles for multi-angle batches
    aspect_ratio: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    template_image_ids: v.optional(v.string()),      // JSON array of uploaded template IDs (multi-select)
    template_tag: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    inspiration_image_ids: v.optional(v.string()),    // JSON array of drive template IDs (multi-select)
    product_image_storageId: v.optional(v.id("_storage")),
    gemini_batch_job: v.optional(v.nullable(v.string())),
    gpt_prompts: v.optional(v.nullable(v.string())),
    status: v.optional(v.string()),
    scheduled: v.optional(v.boolean()),
    schedule_cron: v.optional(v.string()),
    error_message: v.optional(v.nullable(v.string())),
    completed_count: v.optional(v.number()),
    failed_count: v.optional(v.number()),
    run_count: v.optional(v.number()),
    retry_count: v.optional(v.number()),
    queued_at: v.optional(v.string()),
    last_heartbeat_at: v.optional(v.string()),
    stale_detected_at: v.optional(v.nullable(v.string())),
    worker_lease_owner: v.optional(v.nullable(v.string())),
    worker_lease_expires_at: v.optional(v.nullable(v.string())),
    last_scheduled_run_key: v.optional(v.string()),
    used_template_ids: v.optional(v.string()),  // JSON array of template IDs used across runs
    batch_stats: v.optional(v.nullable(v.string())),
    pipeline_state: v.optional(v.string()),  // JSON: { stage, brief_packet, headlines, body_copies }
    filter_assigned: v.optional(v.boolean()),      // Opt-in: batch assigned to Creative Filter
    filter_processed: v.optional(v.boolean()),    // Creative Filter has evaluated this batch
    filter_processed_at: v.optional(v.string()),  // When filter processed it
    // Dacia Creative Director fields
    posting_day: v.optional(v.string()),           // YYYY-MM-DD posting day this batch produces ads for
    conductor_run_id: v.optional(v.string()),      // → conductor_runs.externalId that created this batch
    angle_name: v.optional(v.string()),            // Which angle this batch targets
    angle_prompt: v.optional(v.string()),          // Full angle prompt injected into generation
    angle_brief: v.optional(v.string()),           // JSON: structured angle brief for downstream use
    flex_ad_id: v.optional(v.string()),            // DEPRECATED — Phase 6 — drop in 6.1 (LP feature removed)
    // LP auto-generation tracking
    // DEPRECATED — Phase 6 — drop in 6.1 (LP feature removed from this Thrive fork)
    lp_primary_id: v.optional(v.string()),
    lp_primary_url: v.optional(v.string()),
    lp_primary_status: v.optional(v.string()),
    lp_primary_error: v.optional(v.string()),
    lp_primary_retry_count: v.optional(v.float64()),
    lp_secondary_id: v.optional(v.string()),
    lp_secondary_url: v.optional(v.string()),
    lp_secondary_status: v.optional(v.string()),
    lp_secondary_error: v.optional(v.string()),
    lp_secondary_retry_count: v.optional(v.float64()),
    lp_narrative_frames: v.optional(v.string()),
    gauntlet_lp_urls: v.optional(v.string()),        // JSON: [{ frame, frameName, url, score }]
    created_at: v.string(),
    started_at: v.optional(v.string()),
    completed_at: v.optional(v.string()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_status", ["status"])
    .index("by_scheduled", ["scheduled"]),

  api_costs: defineTable({
    externalId: v.string(),
    project_id: v.optional(v.string()),
    service: v.string(),
    operation: v.optional(v.string()),
    cost_usd: v.number(),
    rate_used: v.optional(v.number()),
    image_count: v.optional(v.number()),
    resolution: v.optional(v.string()),
    source: v.optional(v.string()),
    period_date: v.string(),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_period", ["period_date"])
    .index("by_project_and_period", ["project_id", "period_date"])
    .index("by_source_and_period", ["source", "period_date"]),

  campaigns: defineTable({
    externalId: v.string(),
    project_id: v.string(),      // → projects.externalId
    name: v.string(),
    sort_order: v.number(),
    // Phase 5 — Meta-side ID for cross-referencing in the Analytics tab
    meta_campaign_id: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  ad_sets: defineTable({
    externalId: v.string(),
    campaign_id: v.string(),     // → campaigns.externalId
    project_id: v.string(),      // → projects.externalId (denormalized)
    name: v.string(),
    sort_order: v.number(),
    // Phase 1 — Staging Page + Director-driven angle testing
    angle_id: v.optional(v.string()),                  // → conductor_angles.externalId; the angle this ad set tests
    lifecycle_status: v.optional(v.string()),          // "staging" | "promoted" | "posted" (Phase 3 adds: observing | passed | failed)
    meta_targeting: v.optional(v.string()),            // JSON audience targeting spec
    meta_budget_type: v.optional(v.string()),          // "daily" | "lifetime"
    meta_budget_amount_cents: v.optional(v.number()),
    meta_schedule: v.optional(v.string()),             // JSON: { start_time, end_time? }
    meta_optimization_goal: v.optional(v.string()),
    meta_billing_event: v.optional(v.string()),
    posted_at: v.optional(v.string()),                 // ISO timestamp; Day 1 of Phase 3 observation
    meta_adset_id: v.optional(v.string()),             // Meta's ad set ID after posting
    ready_source: v.optional(v.string()),              // "creative_director" | "manual_planner" — source when first moved to Ready to Post
    ready_at: v.optional(v.string()),                  // ISO timestamp when first moved to Ready to Post
    // Phase 2B — Meta posting metadata
    meta_campaign_id: v.optional(v.string()),          // resolved-or-created Meta campaign for this ad set
    meta_post_error: v.optional(v.string()),           // error message if posting failed
    meta_post_path: v.optional(v.string()),            // "mcp" | "api" — which path was used (audit)
    // Phase 3 — Observation pause/resume + extension
    observation_paused_at: v.optional(v.string()),     // ISO timestamp when paused; null when running
    observation_paused_total_ms: v.optional(v.number()), // cumulative paused milliseconds
    extension_days: v.optional(v.number()),             // user-extended days beyond default window
    is_demo: v.optional(v.boolean()),                   // local-only demo row; skipped by Meta observation automation
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_campaign", ["campaign_id"])
    .index("by_project", ["project_id"])
    .index("by_project_and_lifecycle", ["project_id", "lifecycle_status"])
    .index("by_angle", ["angle_id"]),

  // DEPRECATED — Phase 6 — drop in 6.1. Meta retired flex ads.
  // Replaced by ad_sets as the parent container for ad_deployments.
  // Schema preserved for backwards-compat reads only; no new writes.
  flex_ads: defineTable({
    externalId: v.string(),
    project_id: v.string(),                     // → projects.externalId
    ad_set_id: v.optional(v.string()),          // → ad_sets.externalId (optional — CF fork has no pre-seeded ad sets)
    name: v.string(),
    child_deployment_ids: v.string(),            // JSON string array of deployment externalIds
    primary_texts: v.optional(v.string()),       // JSON string array (up to 5)
    headlines: v.optional(v.string()),           // JSON string array (up to 5)
    destination_url: v.optional(v.string()),
    display_link: v.optional(v.string()),        // Display link (shown instead of destination URL)
    cta_button: v.optional(v.string()),          // Meta CTA type
    facebook_page: v.optional(v.string()),       // Facebook Page name to post from
    planned_date: v.optional(v.string()),        // ISO datetime for scheduled posting
    posted_by: v.optional(v.string()),           // Who will post this ad (e.g. "Corinne", "Liz")
    duplicate_adset_name: v.optional(v.string()), // Name for the duplicated ad set in Ads Manager
    notes: v.optional(v.string()),               // Free-text notes for poster employees
    // Dacia Creative Director fields
    posting_day: v.optional(v.string()),           // YYYY-MM-DD posting day this flex ad is for
    angle_name: v.optional(v.string()),            // Inherited from batch that produced its ads
    // LP URLs for auto-generated landing pages
    lp_primary_url: v.optional(v.string()),
    lp_secondary_url: v.optional(v.string()),
    // Gauntlet LP URLs
    gauntlet_lp_urls: v.optional(v.string()),         // JSON: [{ frame, url, score }]
    destination_urls_used: v.optional(v.string()),     // JSON: [0, 2, 5] — indices of copied URLs
    created_at: v.string(),
    updated_at: v.string(),
    deleted_at: v.optional(v.string()),           // ISO timestamp for soft delete
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_ad_set", ["ad_set_id"]),

  ad_deployments: defineTable({
    externalId: v.string(),
    ad_id: v.string(),           // → ad_creatives.externalId
    project_id: v.string(),      // → projects.externalId
    status: v.string(),          // selected | scheduled | posted | analyzing
    campaign_name: v.optional(v.string()),
    ad_set_name: v.optional(v.string()),
    ad_name: v.optional(v.string()),
    landing_page_url: v.optional(v.string()),    // DEPRECATED — Phase 6 — drop in 6.1 (LP feature removed from CF)
    notes: v.optional(v.string()),
    planned_date: v.optional(v.string()),
    posted_date: v.optional(v.string()),
    local_campaign_id: v.optional(v.string()),  // → campaigns.externalId or "unplanned"
    local_adset_id: v.optional(v.string()),     // → ad_sets.externalId
    flex_ad_id: v.optional(v.string()),          // DEPRECATED — Phase 6 — drop in 6.1 (replaced by local_adset_id)
    primary_texts: v.optional(v.string()),       // JSON array of primary text strings
    ad_headlines: v.optional(v.string()),         // JSON array of headline strings
    destination_url: v.optional(v.string()),      // Meta destination URL
    display_link: v.optional(v.string()),         // Display link (shown instead of destination URL)
    cta_button: v.optional(v.string()),           // Meta CTA type (SHOP_NOW, LEARN_MORE, etc.)
    facebook_page: v.optional(v.string()),        // Facebook Page name to post from
    posted_by: v.optional(v.string()),            // Who will post this ad (e.g. "Corinne", "Liz")
    duplicate_adset_name: v.optional(v.string()), // Name for the duplicated ad set in Ads Manager
    meta_ad_id: v.optional(v.string()),           // Meta-side ad ID after posting this deployment
    meta_post_error: v.optional(v.string()),      // Posting error for this deployment
    // Phase 6 — soft-lock TTL during Combine modal to prevent concurrent delete
    lock_expires_at: v.optional(v.number()),     // ms timestamp; lock auto-expires
    created_at: v.string(),
    deleted_at: v.optional(v.string()),           // ISO timestamp for soft delete
  })
    .index("by_externalId", ["externalId"])
    .index("by_ad_id", ["ad_id"])
    .index("by_status", ["status"])
    .index("by_project", ["project_id"]),

  // Phase 6 — Director run lock. Prevents concurrent Director runs (cron + manual)
  // for the same project. One row per project; auto-expires via expires_at.
  director_locks: defineTable({
    project_id: v.string(),
    acquired_at: v.number(),
    expires_at: v.number(),
  }).index("by_project", ["project_id"]),

  inspiration_images: defineTable({
    project_id: v.string(),
    drive_file_id: v.string(),
    filename: v.string(),
    mimeType: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    thumbnailStorageId: v.optional(v.id("_storage")),
    modifiedTime: v.optional(v.string()),
    size: v.optional(v.number()),
  })
    .index("by_project", ["project_id"])
    .index("by_project_and_drive_id", ["project_id", "drive_file_id"]),

  correction_history: defineTable({
    externalId: v.string(),
    project_id: v.string(),        // → projects.externalId
    correction: v.string(),        // user instruction or "Manual edit to X"
    timestamp: v.string(),         // ISO 8601
    manual: v.optional(v.boolean()),
    changes: v.string(),           // JSON array of change objects
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  dashboard_todos: defineTable({
    externalId: v.string(),
    text: v.string(),
    done: v.boolean(),
    author: v.optional(v.string()),
    notes: v.optional(v.string()),
    priority: v.optional(v.number()),
    sort_order: v.number(),
  })
    .index("by_externalId", ["externalId"]),


  // =============================================
  // Dacia Creative Director — Agent Team tables
  // =============================================

  conductor_config: defineTable({
    project_id: v.string(),              // → projects.externalId
    enabled: v.boolean(),
    daily_flex_target: v.number(),       // ad sets per day (1-20, default 5)
    ads_per_batch: v.number(),           // ads per ad set fallback (default 5)
    angle_mode: v.string(),             // "manual" | "auto" | "mixed"
    explore_ratio: v.number(),           // for mixed mode, % testing new angles (0.0-1.0)
    angle_rotation: v.string(),         // "round_robin" | "weighted" | "random"
    angle_tag_filter: v.optional(v.string()),    // optional active-angle tag filter for Director selection
    headline_style: v.optional(v.string()),      // freeform prompt guidance
    primary_text_style: v.optional(v.string()),  // freeform prompt guidance
    template_tag: v.optional(v.string()),         // optional uploaded-template tag for Director random template selection
    default_campaign_id: v.optional(v.string()),  // → campaigns.externalId for auto-deployed ad sets
    run_schedule: v.string(),           // "daily" | "weekdays" | "weekly_monday" | "custom" | "manual_only"
    run_schedule_days: v.optional(v.string()),   // JSON array of day numbers (0=Sun...6=Sat) for custom schedule
    run_schedule_hour: v.optional(v.number()),   // Hour in ICT (0-23) for custom schedule, default 0
    last_planning_run: v.optional(v.number()),   // timestamp
    last_verify_run: v.optional(v.number()),     // timestamp
    // Phase 4 — sub-angle derivation + health-biased selection
    health_bias: v.optional(v.boolean()),                            // default FALSE in v1
    sub_angle_derivation_enabled: v.optional(v.boolean()),           // default TRUE
    sub_angle_derivation_mode: v.optional(v.string()),               // 'auto' | 'review'
    sub_angle_derivation_threshold: v.optional(v.number()),          // default 3 (depth-doubled)
    sub_angle_derivation_min_unique_days: v.optional(v.number()),    // default 1
    sub_angle_derivation_max_per_run: v.optional(v.number()),        // default 3
    sub_angle_derivation_cooldown_days: v.optional(v.number()),      // default 7
    sub_angle_max_depth: v.optional(v.number()),                     // default 3
    sub_angle_exploration_boost_days: v.optional(v.number()),        // default 14
    sub_angle_lineage_cap_share: v.optional(v.number()),             // default 0.6
    sub_angle_min_active_for_health_bias: v.optional(v.number()),    // default 3
    sub_angle_min_active_for_lineage_cap: v.optional(v.number()),    // default 5
    sub_angle_per_project_daily_cost_cap_usd: v.optional(v.number()),  // default 0.45
    // Phase 9 — auto-posting to Meta
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
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_project", ["project_id"]),

  conductor_angles: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    name: v.string(),                    // short label
    description: v.string(),             // detailed angle for prompt injection (auto-computed from structured fields)
    prompt_hints: v.optional(v.string()), // specific creative direction
    source: v.string(),                  // "manual" | "imported" | "auto_generated"
    status: v.string(),                  // "active" | "testing" | "archived"
    focused: v.optional(v.boolean()),    // When true + active, Director only uses focused angles
    tags: v.optional(v.array(v.string())),
    // Structured creative brief fields
    priority: v.optional(v.string()),    // "highest" | "high" | "medium" | "test"
    frame: v.optional(v.string()),       // "symptom-first" | "scam" | "objection-first" | "identity-first" | "MAHA" | "news-first" | "consequence-first"
    core_buyer: v.optional(v.string()),
    symptom_pattern: v.optional(v.string()),
    failed_solutions: v.optional(v.string()),
    current_belief: v.optional(v.string()),
    objection: v.optional(v.string()),
    emotional_state: v.optional(v.string()),
    scene: v.optional(v.string()),       // "Scene to Center the Ad On"
    desired_belief_shift: v.optional(v.string()),
    tone: v.optional(v.string()),
    avoid_list: v.optional(v.string()),  // "Avoid" — renamed to avoid JS keyword
    destination_urls: v.optional(v.string()), // JSON array of LP URLs for this angle (overrides project default)
    is_system_default: v.optional(v.boolean()), // True for auto-created system angles (e.g., BOF)
    // Operational fields
    times_used: v.number(),
    last_used_at: v.optional(v.number()),
    performance_note: v.optional(v.string()),
    // Phase 4 — sub-angle derivation + health-biased Director selection
    parent_angle_id: v.optional(v.string()),                // → conductor_angles.externalId
    derived_at: v.optional(v.number()),                     // ms — for linear-decaying exploration boost
    derivation_source_result_ids: v.optional(v.string()),   // JSON array of observation_result IDs that triggered derivation
    derivation_reasoning: v.optional(v.string()),           // LLM's free-text justification
    last_derived_at: v.optional(v.number()),                // ms — cooldown throttle on parents
    derivation_in_progress: v.optional(v.boolean()),        // race lock during derivation
    derivation_attempt_failed_at: v.optional(v.number()),   // 6h backoff after failure
    // Cached observation stats (populated by stats phase)
    since_last_derived_pass_count: v.optional(v.number()),
    since_last_derived_fail_count: v.optional(v.number()),
    lifetime_pass_count: v.optional(v.number()),
    lifetime_fail_count: v.optional(v.number()),
    lifetime_pass_rate: v.optional(v.number()),
    observation_stats_updated_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_status", ["project_id", "status"])
    .index("by_parent", ["parent_angle_id"]),

  conductor_runs: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    run_type: v.string(),                // "planning" | "verification" | "manual" | "emergency"
    run_at: v.number(),                  // timestamp
    posting_days: v.optional(v.string()), // JSON array of posting day objects checked
    batches_created: v.optional(v.string()), // JSON array of batch info
    angles_generated: v.optional(v.string()), // JSON array of new angles
    decisions: v.optional(v.string()),   // LLM reasoning
    status: v.string(),                  // "completed" | "partial" | "failed"
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
    created_at: v.number(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  conductor_slots: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    posting_day: v.string(),             // YYYY-MM-DD
    slot_index: v.number(),              // 0-based slot within posting day
    angle_name: v.string(),
    angle_external_id: v.optional(v.string()),
    status: v.string(),                  // "reserved" | "in_progress" | "produced" | "failed" | "abandoned"
    batch_ids: v.optional(v.string()),   // JSON array of batch externalIds
    attempt_count: v.optional(v.number()),
    last_attempt_at: v.optional(v.number()),
    produced_flex_ad_id: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    diagnostics_summary: v.optional(v.string()), // compact JSON summary for overnight diagnosis
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project_and_posting_day", ["project_id", "posting_day"])
    .index("by_project_posting_day_and_slot", ["project_id", "posting_day", "slot_index"]),

  conductor_playbooks: defineTable({
    project_id: v.string(),              // → projects.externalId
    angle_name: v.string(),              // matches conductor_angles.name
    version: v.number(),
    total_scored: v.number(),
    total_passed: v.number(),
    pass_rate: v.number(),               // 0.0-1.0
    visual_patterns: v.optional(v.string()),
    copy_patterns: v.optional(v.string()),
    avoid_patterns: v.optional(v.string()),
    generation_hints: v.optional(v.string()),
    raw_analysis: v.optional(v.string()),
    last_updated: v.number(),
    created_at: v.number(),
  })
    .index("by_project", ["project_id"])
    .index("by_project_and_angle", ["project_id", "angle_name"]),

  auto_post_log: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    ad_set_id: v.string(),
    meta_adset_id: v.optional(v.string()),
    status: v.string(),
    gate_reason: v.optional(v.string()),
    error_message: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  reconciliation_log: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    action: v.string(),
    cf_entity_id: v.string(),
    cf_entity_type: v.string(),
    meta_entity_id: v.string(),
    linked_by: v.string(),
    notes: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  reconciliation_archives: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    meta_entity_type: v.string(),
    meta_adset_id: v.string(),
    name: v.optional(v.string()),
    campaign_name: v.optional(v.string()),
    status: v.optional(v.string()),
    snapshot_json: v.optional(v.string()),
    archived_at: v.string(),
    archived_by: v.string(),
    unarchived_at: v.optional(v.string()),
    unarchived_by: v.optional(v.string()),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_meta", ["project_id", "meta_adset_id"]),

  users: defineTable({
    externalId: v.string(),
    username: v.string(),
    display_name: v.string(),
    password_hash: v.string(),
    role: v.string(),              // 'admin' | 'manager' | 'poster'
    is_active: v.boolean(),
    created_by: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_username", ["username"]),

  sessions: defineTable({
    sid: v.string(),
    session_data: v.string(),
    expires_at: v.number(),
  })
    .index("by_sid", ["sid"])
    .index("by_expires_at", ["expires_at"]),

  // ─────────────────────────────────────────────────────────
  // Phase 5 — Analytics tab + tagging + saved views
  // ─────────────────────────────────────────────────────────

  // Project-scoped tags. Flat (no hierarchy). Color stored as hex string.
  // Each entity (Meta-side or CF-side) is tagged independently — no inheritance.
  tags: defineTable({
    externalId: v.string(),
    project_id: v.string(),       // → projects.externalId
    name: v.string(),
    color: v.string(),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  // Many-to-many tag → entity relationships. entity_type identifies what's tagged
  // (campaign / ad_set / ad). entity_id is the Meta-side ID OR a local CF UUID,
  // disambiguated by entity_id_kind. The same (tag_id, entity_id, entity_type)
  // tuple should not duplicate — mutations enforce upsert semantics.
  tag_assignments: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    tag_id: v.string(),                  // → tags.externalId
    entity_type: v.string(),             // "ad" | "ad_set" | "campaign"
    entity_id: v.string(),
    entity_id_kind: v.string(),          // "meta" | "cf"
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_tag", ["tag_id"])
    .index("by_entity", ["entity_id", "entity_type"])
    .index("by_project_and_entity", ["project_id", "entity_type"]),

  // Project-scoped plain-text notes for Meta-side analytics entities and
  // Thrive Digital Marketing local entities. Notes are intentionally independent from
  // tag assignments so they can be edited/bulk-appended without touching tags.
  entity_notes: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    entity_type: v.string(),             // "ad" | "ad_set" | "campaign"
    entity_id: v.string(),
    entity_id_kind: v.string(),          // "meta" | "cf"
    note: v.string(),
    updated_by: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_entity", ["project_id", "entity_type"])
    .index("by_entity", ["entity_id", "entity_type"]),

  // Notion-style saved views. Each view captures the active level + date range
  // + filters + sort + columns at save time. Scope is "private" (visible only
  // to the owner) or "project" (visible to all teammates on the project).
  analytics_saved_views: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    owner_user_id: v.string(),
    scope: v.string(),                   // "private" | "project"
    name: v.string(),
    level: v.string(),                   // "campaigns" | "adsets" | "ads"
    config: v.string(),                  // JSON: { date_range, filters, sort, columns }
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_owner", ["owner_user_id"])
    .index("by_project_and_scope", ["project_id", "scope"]),

  // ─────────────────────────────────────────────────────────
  // Phase 3 — Observation lifecycle, daily snapshots, terminal verdicts
  // ─────────────────────────────────────────────────────────

  // Daily metric snapshot per observing ad set (one row per ad_set_id × day_index).
  // Populated by the Phase 3 cron from Meta /insights with time_increment=1.
  observation_snapshots: defineTable({
    externalId: v.string(),
    project_id: v.string(),                 // → projects.externalId
    ad_set_id: v.string(),                  // → ad_sets.externalId
    meta_adset_id: v.string(),              // Meta-side ad set id for cross-reference
    day_index: v.number(),                  // 1-based; day 1 = posted_at calendar day in account tz
    snapshot_at: v.string(),                // ISO timestamp of write
    // Daily-delta metrics (single day, NOT lifetime)
    spend: v.number(),
    impressions: v.number(),
    clicks: v.number(),
    ctr: v.number(),
    cpm: v.number(),
    cpc: v.number(),
    roas: v.optional(v.number()),
    cpa: v.optional(v.number()),
    conversions: v.optional(v.number()),
    raw_insights: v.optional(v.string()),   // JSON of original Meta row for audit
    account_currency: v.optional(v.string()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_ad_set", ["ad_set_id"])
    .index("by_ad_set_and_day", ["ad_set_id", "day_index"])
    .index("by_project_and_snapshot", ["project_id", "snapshot_at"]),

  // Terminal observation verdict. One row per ad set's first terminal evaluation;
  // manual overrides write a new row pointing back via replaces_external_id.
  observation_results: defineTable({
    externalId: v.string(),
    project_id: v.string(),                 // → projects.externalId
    ad_set_id: v.string(),                  // → ad_sets.externalId
    angle_id: v.optional(v.string()),       // → conductor_angles.externalId
    posted_at: v.string(),                  // copied from ad_sets at evaluation time
    observed_through: v.string(),           // ISO timestamp of evaluation
    days_observed: v.number(),
    verdict: v.string(),                    // "passed" | "failed" | "failed_external" | "insufficient_data" | "manual_passed" | "manual_failed"
    fail_reason_code: v.optional(v.string()), // "starved" | "underperforming" | "external_deletion" | null
    // Lifetime metrics for the observation window
    spend: v.number(),
    impressions: v.number(),
    clicks: v.number(),
    ctr: v.number(),
    roas: v.optional(v.number()),
    cpa: v.optional(v.number()),
    conversions: v.optional(v.number()),
    // Provenance + traceability
    benchmark_used: v.string(),             // JSON snapshot of resolved benchmark at evaluation time
    benchmark_version: v.number(),
    reason: v.string(),                     // human-readable
    evaluated_by: v.string(),               // "cron" | "user_<uuid>"
    account_currency: v.string(),
    replaces_external_id: v.optional(v.string()), // for manual overrides
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_ad_set", ["ad_set_id"])
    .index("by_angle", ["angle_id"])
    .index("by_project_and_created", ["project_id", "created_at"]),
});

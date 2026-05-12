/**
 * convexClient.js — Drop-in async replacement for db.js
 *
 * All functions have the same names and parameters as db.js,
 * but they are ASYNC and call Convex instead of SQLite.
 *
 * Usage: change `import { X } from './db.js'` to `import { X } from './convexClient.js'`
 * and add `await` to every call site.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { withRetry } from './services/retry.js';
import { ensureArray } from './utils/collections.js';
import { compactConvexWrite } from './services/adSetPlanner.js';
import { buildStaleAdRepairUpdate, getAdProgressTime, isSingleAdGenerationRecoveryCandidate } from './utils/adGenerationRecovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadLocalEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Local dev convenience. Vercel/production env vars win because existing
// process.env values are never overwritten.
loadLocalEnvFile(path.join(__dirname, '.env.local'));
loadLocalEnvFile(path.join(__dirname, '..', '.env.local'));

// Read Convex URL from environment
const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  throw new Error('CONVEX_URL environment variable not set. Add it to .env.local or PM2 config.');
}

const client = new ConvexHttpClient(CONVEX_URL);

export function getConvexHost() {
  try {
    return new URL(CONVEX_URL).hostname;
  } catch {
    return 'invalid-convex-url';
  }
}

// Custom retry predicate for Convex calls.
// Convex errors are plain Error objects with no status/code properties, so the
// default retry predicate (which checks status codes) would never retry them.
// We retry on: Server Error (transient Convex platform issues), fetch failed,
// ECONNRESET, and other network errors.
function isConvexTransientInternalServerErrorMessage(msg) {
  if (!msg) return false;
  const hasTransientCode = /InternalServerError/i.test(msg);
  const hasTransientMessage = /Your request couldn['’]t be completed/i.test(msg);
  if (hasTransientCode && hasTransientMessage) return true;

  try {
    const parsed = JSON.parse(msg);
    return parsed?.code === 'InternalServerError'
      && /Your request couldn['’]t be completed/i.test(parsed?.message || '');
  } catch {
    return false;
  }
}

export function convexShouldRetry(err) {
  const msg = err.message || '';
  // Convex wraps validation/business errors in "Server Error" text. Retrying
  // those only makes user-facing failures feel slow without changing outcome.
  if (/ArgumentValidationError|Value does not match validator|Object is missing the required field|INVALID_DEPLOYMENTS|does not belong to this project|already exists|Could not find public function|Did you forget to run `npx convex dev`/i.test(msg)) {
    return false;
  }
  // Convex/Vercel platform JSON error — transient platform-side 500.
  if (isConvexTransientInternalServerErrorMessage(msg)) return true;
  // Convex "Server Error" — can be transient platform issues (502/503 from Cloudflare)
  if (/Server Error/i.test(msg)) return true;
  // Network / connection errors
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket|network/i.test(msg)) return true;
  // Convex overloaded
  if (/overloaded|too many requests|rate.?limit/i.test(msg)) return true;
  return false;
}

// Retry-wrapped Convex calls — handles transient ECONNRESET + Server Error from VPS → Convex cloud
export async function queryWithRetry(fnRef, args) {
  return withRetry(() => client.query(fnRef, args), { maxRetries: 3, baseDelayMs: 2000, shouldRetry: convexShouldRetry, label: 'Convex query' });
}

export async function mutationWithRetry(fnRef, args) {
  return withRetry(() => client.mutation(fnRef, args), { maxRetries: 3, baseDelayMs: 2000, shouldRetry: convexShouldRetry, label: 'Convex mutation' });
}

// =============================================
// Generic Query Cache — reduces 250ms Convex round-trips to <1ms for repeat reads
// =============================================

const queryCache = new Map();

// Table-specific TTLs (longer for rarely-changing data)
const TABLE_TTL = {
  settings:            10 * 60 * 1000,
  users:               10 * 60 * 1000,
  projects:             2 * 60 * 1000,
  foundational_docs:    5 * 60 * 1000,
  ad_creatives:         1 * 60 * 1000,
  batch_jobs:          30 * 1000,
  api_costs:            2 * 60 * 1000,
  ad_deployments:       1 * 60 * 1000,
  campaigns:            2 * 60 * 1000,
  ad_sets:              2 * 60 * 1000,
  flex_ads:             1 * 60 * 1000,
  landing_pages:        2 * 60 * 1000,
  landing_page_versions: 2 * 60 * 1000,
  lp_templates:         5 * 60 * 1000,
  conductor:            2 * 60 * 1000,
  lp_agent_config:      5 * 60 * 1000,
  template_images:      5 * 60 * 1000,
  headline_history:     1 * 60 * 1000,
};
const DEFAULT_QUERY_TTL = 60 * 1000;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of queryCache) {
    if (now - entry.time > entry.ttl) queryCache.delete(key);
  }
}, 5 * 60 * 1000).unref();

async function cachedQuery(table, fnRef, args) {
  const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
  const key = table + ':' + caller + ':' + JSON.stringify(args);
  const cached = queryCache.get(key);
  const ttl = TABLE_TTL[table] || DEFAULT_QUERY_TTL;
  if (cached && Date.now() - cached.time < ttl) return cached.value;
  const value = await queryWithRetry(fnRef, args);
  queryCache.set(key, { value, time: Date.now(), ttl, table });
  return value;
}

export function invalidateQueryCache(table) {
  for (const [key, entry] of queryCache) {
    if (entry.table === table) queryCache.delete(key);
  }
}

// =============================================
// Settings helpers (with 10-min in-memory cache)
// =============================================

const settingsCache = new Map();
const SETTINGS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function getSetting(key) {
  const cached = settingsCache.get(key);
  if (cached && Date.now() - cached.time < SETTINGS_CACHE_TTL) return cached.value;
  const value = await queryWithRetry(api.settings.get, { key });
  settingsCache.set(key, { value, time: Date.now() });
  return value;
}

export async function setSetting(key, value) {
  settingsCache.delete(key);
  await mutationWithRetry(api.settings.set, { key, value });
}

export async function deleteSetting(key) {
  settingsCache.delete(key);
  await mutationWithRetry(api.settings.remove, { key });
}

export async function getAllSettings() {
  return await queryWithRetry(api.settings.getAll, {});
}

export async function getSystemCapabilities() {
  return await queryWithRetry(api.system.getCapabilities, {});
}

// =============================================
// Project helpers
// =============================================

export async function createProject({ id, name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id }) {
  await mutationWithRetry(api.projects.create, {
    externalId: id,
    name,
    brand_name: brand_name || '',
    niche: niche || '',
    product_description: product_description || '',
    sales_page_content: sales_page_content || '',
    drive_folder_id: drive_folder_id || '',
    inspiration_folder_id: inspiration_folder_id || '',
  });
  invalidateQueryCache('projects');
}

export async function getProject(id) {
  // No caching here. On Vercel, function invocations may run on different
  // containers; an in-memory `cachedQuery` invalidation in container A doesn't
  // reach container B's cache. That made post-mutation reads inconsistently
  // stale (e.g., delete product image → next GET sometimes returned the old
  // value). Convex queries are fast enough that always fetching fresh is fine.
  const project = await queryWithRetry(api.projects.getByExternalId, { externalId: id });
  if (!project) return null;
  return convexProjectToRow(project);
}

// Phase 2A — Meta integration. Server-side only. Returns the raw project row
// INCLUDING `meta_access_token`. NEVER return this to the frontend; it's only
// for backend service code (metaApi.js) that needs the bearer token to call
// graph.facebook.com or mcp.facebook.com. Frontend reads use getProject() which
// applies convexProjectToRow() and redacts the token.
export async function getProjectRawForMeta(id) {
  const project = await queryWithRetry(api.projects.getByExternalId, { externalId: id });
  if (!project) return null;
  return project;
}

// Phase 2A — Meta integration. List projects with tokens expiring soon.
// Used by the daily Vercel Cron at /api/meta/oauth/refresh.
export async function getProjectsWithExpiringMetaTokens(withinMs) {
  return await queryWithRetry(api.projects.getWithExpiringMetaTokens, { withinMs });
}

export async function getAllProjects() {
  const projects = await cachedQuery('projects', api.projects.getAll, {});
  return projects.map(convexProjectToRow);
}

export async function getProjectSummaries() {
  const projects = ensureArray(await queryWithRetry(api.projects.getSummaries, {}), 'convexClient.getProjectSummaries');
  return projects.map(convexProjectSummaryToRow);
}

export async function getArchivedProjectSummaries() {
  const projects = ensureArray(await queryWithRetry(api.projects.getArchivedSummaries, {}), 'convexClient.getArchivedProjectSummaries');
  return projects.map(convexProjectSummaryToRow);
}

export async function getProjectOptions() {
  const projects = ensureArray(await queryWithRetry(api.projects.getOptions, {}), 'convexClient.getProjectOptions');
  return projects.map(convexProjectOptionToRow);
}

export async function getAllProjectsWithStats() {
  return await getProjectSummaries();
}

// Phase 6.26 — `filter_quality_threshold` and `scout_score_threshold` removed
// from the whitelist. Both UI surfaces are gone and no runtime consumer reads
// them; the Filter service uses internal constants in creativeFilterService.js.
// Do not re-add without a real consumer.
export async function updateProject(id, fields) {
  const allowed = ['name', 'brand_name', 'niche', 'product_description', 'sales_page_content', 'drive_folder_id', 'inspiration_folder_id', 'prompt_guidelines', 'status', 'template_seeding_status', 'template_seeding_error', 'archived_at', 'scout_enabled', 'scout_default_campaign', 'scout_cta', 'scout_display_link', 'scout_facebook_page', 'scout_daily_flex_ads', 'scout_destination_url', 'scout_destination_urls', 'scout_duplicate_adset_name',
    // Phase 1 — Staging Page + Director cycle config
    'default_campaign_id', 'adset_default_template', 'ad_sets_per_cycle', 'ads_per_ad_set',
    // Phase 2A — Meta integration
    'meta_access_token', 'meta_token_expires_at', 'meta_user_id', 'meta_user_name', 'meta_account_id', 'meta_account_name', 'meta_business_id', 'meta_integration_path', 'meta_read_path', 'meta_connected_at',
    // Phase 2B
    'meta_page_id', 'meta_page_name',
    // Phase 3 — observation
    'meta_account_currency'];
  const updates = { externalId: id };
  for (const key of allowed) {
    // Drop both undefined and null. Convex v.optional(v.string()) rejects null
    // (only undefined or string). The convexProjectToRow mapper used to emit
    // null for unset optional strings, which round-tripped through the
    // frontend form and triggered ArgumentValidationError on save. Any new
    // optional field added to `allowed` is automatically protected here.
    if (fields[key] !== undefined && (fields[key] !== null || key === 'archived_at')) {
      updates[key] = fields[key];
    }
  }
  await mutationWithRetry(api.projects.update, updates);
  invalidateQueryCache('projects');
}

export async function getMetaMcpDiagnostic(projectId, metaAccountId) {
  if (!projectId || !metaAccountId) return null;
  return await queryWithRetry(api.metaMcpDiagnostics.getByProjectAccount, {
    projectId,
    metaAccountId,
  });
}

export async function upsertMetaMcpDiagnostic(entry) {
  const externalId = entry.externalId || uuidv4();
  await mutationWithRetry(api.metaMcpDiagnostics.upsert, {
    externalId,
    project_id: entry.project_id,
    meta_account_id: entry.meta_account_id,
    status: entry.status,
    read_access: entry.read_access,
    posting_access: entry.posting_access,
    reason_code: entry.reason_code,
    ...(entry.read_reason_code !== undefined ? { read_reason_code: entry.read_reason_code } : {}),
    ...(entry.posting_reason_code !== undefined ? { posting_reason_code: entry.posting_reason_code } : {}),
    user_message: entry.user_message,
    ...(entry.technical_details !== undefined ? { technical_details: entry.technical_details } : {}),
    checked_at: entry.checked_at,
  });
  return externalId;
}

export async function deleteProject(id) {
  await archiveProject(id);
}

export async function archiveProject(id) {
  await updateProject(id, { archived_at: new Date().toISOString() });
}

export async function unarchiveProject(id) {
  await updateProject(id, { archived_at: null });
}

export async function backfillProjectStats(force = false) {
  invalidateQueryCache('projects');
  return await mutationWithRetry(api.projects.backfillStoredStats, {
    ...(force ? { force: true } : {}),
  });
}

function convexProjectToRow(p) {
  // Optional simple-string fields emit '' (not null) so the contract going OUT
  // matches the contract going BACK to projects.update. Convex's v.optional(v.string())
  // rejects null but accepts '' as a valid string. Carve-outs:
  //   - product_image_storageId: Convex storage ID; frontend null-checks for image rendering
  //   - scout_destination_urls: JSON-array-as-string per Critical Invariant #2; '' would break JSON.parse
  //   - scout_enabled / scout_daily_flex_ads: nullable boolean/number
  return {
    id: p.externalId,
    name: p.name,
    brand_name: p.brand_name || '',
    niche: p.niche || '',
    product_description: p.product_description || '',
    sales_page_content: p.sales_page_content || '',
    drive_folder_id: p.drive_folder_id || '',
    inspiration_folder_id: p.inspiration_folder_id || '',
    prompt_guidelines: p.prompt_guidelines || '',
    product_image_storageId: p.product_image_storageId || null,
    status: p.status || 'setup',
    template_seeding_status: p.template_seeding_status || 'complete',
    template_seeding_error: p.template_seeding_error || '',
    archived_at: p.archived_at || null,
    // Dacia Creative Filter per-project config
    scout_enabled: p.scout_enabled ?? null,
    scout_default_campaign: p.scout_default_campaign || '',
    scout_cta: p.scout_cta || '',
    scout_display_link: p.scout_display_link || '',
    scout_facebook_page: p.scout_facebook_page || '',
    scout_daily_flex_ads: p.scout_daily_flex_ads ?? null,
    scout_destination_url: p.scout_destination_url || '',
    scout_destination_urls: p.scout_destination_urls || null,
    scout_duplicate_adset_name: p.scout_duplicate_adset_name || '',
    docCount: p.docCount ?? 0,
    adCount: p.adCount ?? 0,
    lpCount: p.lpCount ?? 0,
    lpPublishedCount: p.lpPublishedCount ?? 0,
    // Phase 1 — Staging Page + Director cycle config
    default_campaign_id: p.default_campaign_id || '',
    adset_default_template: p.adset_default_template || null,  // JSON-as-string; null when unset
    ad_sets_per_cycle: p.ad_sets_per_cycle ?? null,
    ads_per_ad_set: p.ads_per_ad_set ?? null,
    // Phase 2A — Meta integration. Token NEVER returned to frontend; only the fact-of-connection.
    // Backend code that needs the raw token must read it via convexClient helpers (server-side).
    meta_connected: !!p.meta_access_token,
    meta_token_expires_at: p.meta_token_expires_at ?? null,
    meta_user_id: p.meta_user_id || null,
    meta_user_name: p.meta_user_name || null,
    meta_account_id: p.meta_account_id || null,
    meta_account_name: p.meta_account_name || null,
    meta_business_id: p.meta_business_id || null,
    meta_integration_path: p.meta_integration_path || 'mcp',  // default mcp
    meta_read_path: p.meta_read_path || 'api',  // default api; this is the current stable Analytics/Observation read path
    meta_connected_at: p.meta_connected_at ?? null,
    // Phase 2B — Meta Page selection
    meta_page_id: p.meta_page_id || null,
    meta_page_name: p.meta_page_name || null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function convexProjectSummaryToRow(p) {
  return {
    id: p.externalId,
    name: p.name,
    brand_name: p.brand_name || null,
    niche: p.niche || null,
    status: p.status || 'setup',
    archived_at: p.archived_at || null,
    template_seeding_status: p.template_seeding_status || 'complete',
    template_seeding_error: p.template_seeding_error || '',
    docCount: p.docCount ?? 0,
    adCount: p.adCount ?? 0,
    lpCount: p.lpCount ?? 0,
    lpPublishedCount: p.lpPublishedCount ?? 0,
  };
}

function convexProjectOptionToRow(p) {
  return {
    id: p.externalId,
    name: p.name,
    brand_name: p.brand_name || null,
    displayName: p.displayName || p.brand_name || p.name,
    status: p.status || 'setup',
    archived_at: p.archived_at || null,
    template_seeding_status: p.template_seeding_status || 'complete',
    template_seeding_error: p.template_seeding_error || '',
  };
}

export async function setProjectProductImage(projectId, storageId) {
  await mutationWithRetry(api.projects.setProductImage, {
    externalId: projectId,
    storageId: storageId || undefined,
  });
  // Bust the cached project so the next GET reflects the new (or cleared)
  // product image without waiting for the TTL. Without this, the UI keeps
  // showing the old image until refresh.
  invalidateQueryCache('projects');
}

// =============================================
// Foundational doc helpers
// =============================================

export async function getDocsByProject(projectId) {
  const docs = await queryWithRetry(api.foundationalDocs.getByProject, { projectId });
  return docs.map(convexDocToRow);
}

export async function getLatestDoc(projectId, docType) {
  const doc = await queryWithRetry(api.foundationalDocs.getLatest, { projectId, docType });
  if (!doc) return null;
  return convexDocToRow(doc);
}

function convexDocToRow(d) {
  return {
    id: d.externalId,
    project_id: d.project_id,
    doc_type: d.doc_type,
    content: d.content || null,
    version: d.version,
    approved: d.approved ? 1 : 0,
    source: d.source || 'generated',
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

// =============================================
// Ad creative helpers
// =============================================

export async function getAdsByProject(projectId) {
  const ads = ensureArray(await queryWithRetry(api.adCreatives.getGalleryByProject, { projectId }), 'convexClient.getAdsByProject');
  return ads.map(convexAdSummaryToRow);
}

export async function getRecentHeadlineHistoryByAngle(projectId, angleName, options = {}) {
  if (!projectId || !angleName) return [];
  const { limit = 200, since = null } = options;
  const rows = ensureArray(
    await cachedQuery('headline_history', api.headlineHistory.getRecentByAngle, {
      projectId,
      angleName,
      limit,
      ...(since ? { since } : {}),
    }),
    'convexClient.getRecentHeadlineHistoryByAngle'
  );

  return rows.map((row) => ({
    externalId: row.externalId,
    project_id: row.project_id,
    angle_name: row.angle_name,
    batch_job_id: row.batch_job_id || null,
    conductor_run_id: row.conductor_run_id || null,
    ad_creative_id: row.ad_creative_id || null,
    headline: row.headline_text,
    normalized_headline: row.normalized_headline,
    hook_lane: row.hook_lane || null,
    sub_angle: row.sub_angle || null,
    core_claim: row.core_claim || null,
    target_symptom: row.target_symptom || null,
    emotional_entry: row.emotional_entry || null,
    desired_belief_shift: row.desired_belief_shift || null,
    opening_pattern: row.opening_pattern || null,
    created_at: row.created_at,
  }));
}

export async function recordHeadlineHistory(entries) {
  const safeEntries = ensureArray(entries, 'convexClient.recordHeadlineHistory.entries').filter(Boolean);
  if (safeEntries.length === 0) return;
  await mutationWithRetry(api.headlineHistory.recordMany, { entries: safeEntries });
  invalidateQueryCache('headline_history');
}

export async function clearHeadlineHistoryByAngle(projectId, angleName) {
  if (!projectId || !angleName) return { deleted: 0 };
  const result = await mutationWithRetry(api.headlineHistory.clearByAngle, {
    projectId,
    angleName,
  });
  invalidateQueryCache('headline_history');
  return result || { deleted: 0 };
}

export async function getRecentLPHeadlineHistoryByAngle(projectId, angleName, options = {}) {
  if (!projectId || !angleName) return [];
  const { limit = 200, since = null } = options;
  const rows = ensureArray(
    await cachedQuery('lp_headline_history', api.lpHeadlineHistory.getRecentByAngle, {
      projectId,
      angleName,
      limit,
      ...(since ? { since } : {}),
    }),
    'convexClient.getRecentLPHeadlineHistoryByAngle'
  );

  return rows.map((row) => ({
    externalId: row.externalId,
    project_id: row.project_id,
    angle_name: row.angle_name,
    narrative_frame: row.narrative_frame,
    landing_page_id: row.landing_page_id || null,
    gauntlet_batch_id: row.gauntlet_batch_id || null,
    headline_text: row.headline_text,
    subheadline_text: row.subheadline_text || null,
    normalized_headline: row.normalized_headline,
    headline_signature: row.headline_signature || null,
    created_at: row.created_at,
  }));
}

export async function getRecentLPHeadlineHistoryByAngleAndFrame(projectId, angleName, narrativeFrame, options = {}) {
  if (!projectId || !angleName || !narrativeFrame) return [];
  const { limit = 100, since = null } = options;
  const rows = ensureArray(
    await cachedQuery('lp_headline_history', api.lpHeadlineHistory.getRecentByAngleAndFrame, {
      projectId,
      angleName,
      narrativeFrame,
      limit,
      ...(since ? { since } : {}),
    }),
    'convexClient.getRecentLPHeadlineHistoryByAngleAndFrame'
  );

  return rows.map((row) => ({
    externalId: row.externalId,
    project_id: row.project_id,
    angle_name: row.angle_name,
    narrative_frame: row.narrative_frame,
    landing_page_id: row.landing_page_id || null,
    gauntlet_batch_id: row.gauntlet_batch_id || null,
    headline_text: row.headline_text,
    subheadline_text: row.subheadline_text || null,
    normalized_headline: row.normalized_headline,
    headline_signature: row.headline_signature || null,
    created_at: row.created_at,
  }));
}

export async function recordLPHeadlineHistory(entries) {
  const safeEntries = ensureArray(entries, 'convexClient.recordLPHeadlineHistory.entries').filter(Boolean);
  if (safeEntries.length === 0) return;
  await mutationWithRetry(api.lpHeadlineHistory.recordMany, { entries: safeEntries });
  invalidateQueryCache('lp_headline_history');
}

export async function getAdSummariesByExternalIds(externalIds) {
  if (!Array.isArray(externalIds) || externalIds.length === 0) return [];
  const uniqueExternalIds = [...new Set(externalIds.filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < uniqueExternalIds.length; i += 500) {
    chunks.push(uniqueExternalIds.slice(i, i + 500));
  }
  const results = await Promise.all(
    chunks.map(chunk => queryWithRetry(api.adCreatives.getSummariesByExternalIds, { externalIds: chunk }))
  );
  return results.flat().map(a => ({
    id: a.externalId,
    project_id: a.project_id,
    angle: a.angle || null,
    angle_name: a.angle_name || null,
    headline: a.headline || null,
    body_copy: a.body_copy || null,
    tags: a.tags || [],
    hasImage: !!a.has_image,
  }));
}

export async function getAd(id) {
  const ad = await queryWithRetry(api.adCreatives.getByExternalId, { externalId: id });
  if (!ad) return null;
  return convexAdToRow(ad);
}

export async function getAllAds() {
  const ads = ensureArray(await cachedQuery('ad_creatives', api.adCreatives.getAll, {}), 'convexClient.getAllAds');
  return ads.map(a => convexAdToRow(a));
}

export async function getInProgressAdsByProject(projectId) {
  const ads = ensureArray(await queryWithRetry(api.adCreatives.getInProgressByProject, { projectId }), 'convexClient.getInProgressAdsByProject');
  return ads.map(a => convexAdToRow(a));
}

export async function getAdImageUrl(id) {
  return await queryWithRetry(api.adCreatives.getImageUrl, { externalId: id });
}

export async function getAdsByBatchId(batchId) {
  const ads = ensureArray(await cachedQuery('ad_creatives', api.adCreatives.getByBatch, { batchId }), 'convexClient.getAdsByBatchId');
  return ads.map(a => convexAdToRow(a));
}

// Mark ads stuck in generating_* status (older than threshold) as failed.
// Implemented via the existing adCreatives.update mutation (status field is whitelisted).
// Idempotent (status precondition checked before update); bounded by maxRepairs.
export async function markStaleAdsAsFailed(projectId, opts = {}) {
  const olderThanMinutes = opts.olderThanMinutes ?? 5;
  const maxRepairs = opts.maxRepairs ?? 100;
  const cutoff = Date.now() - olderThanMinutes * 60 * 1000;

  const candidates = ensureArray(
    await queryWithRetry(api.adCreatives.getByProject, { projectId }),
    'convexClient.markStaleAdsAsFailed.getByProject'
  );

  let repaired = 0;
  for (const ad of candidates) {
    if (repaired >= maxRepairs) break;
    if (!isSingleAdGenerationRecoveryCandidate(ad)) continue;
    const ts = getAdProgressTime(ad);
    if (!Number.isFinite(ts) || ts > cutoff) continue;
    const update = buildStaleAdRepairUpdate(ad);
    if (!update) continue;
    try {
      await mutationWithRetry(api.adCreatives.update, {
        externalId: ad.externalId,
        ...update,
      });
      repaired += 1;
    } catch (err) {
      console.warn(`[markStaleAdsAsFailed] failed to update ad ${ad.externalId}: ${err.message}`);
    }
  }
  if (repaired > 0) {
    invalidateQueryCache('ad_creatives');
  }
  return { repaired };
}

function convexAdToRow(a) {
  return {
    id: a.externalId,
    project_id: a.project_id,
    generation_mode: a.generation_mode,
    angle: a.angle || null,
    angle_name: a.angle_name || null,
    headline: a.headline || null,
    body_copy: a.body_copy || null,
    hook_lane: a.hook_lane || null,
    core_claim: a.core_claim || null,
    target_symptom: a.target_symptom || null,
    emotional_entry: a.emotional_entry || null,
    desired_belief_shift: a.desired_belief_shift || null,
    opening_pattern: a.opening_pattern || null,
    scoring_mode: a.scoring_mode || null,
    copy_render_expectation: a.copy_render_expectation || null,
    product_expectation: a.product_expectation || null,
    sub_angle: a.sub_angle || null,
    image_prompt: a.image_prompt || null,
    gpt_creative_output: a.gpt_creative_output || null,
    template_image_id: a.template_image_id || null,
    inspiration_image_id: a.inspiration_image_id || null,
    storageId: a.storageId || null,
    drive_file_id: a.drive_file_id || null,
    drive_url: a.drive_url || null,
    aspect_ratio: a.aspect_ratio || '1:1',
    status: a.status || 'generating_copy',
    auto_generated: a.auto_generated ? 1 : 0,
    parent_ad_id: a.parent_ad_id || null,
    tags: a.tags || [],
    is_favorite: !!a.is_favorite,
    text_model: a.text_model || null,
    image_model: a.image_model || null,
    gemini_batch_job: a.gemini_batch_job || null,
    error_message: a.error_message || null,
    failure_stage: a.failure_stage || null,
    cancellation_requested_at: a.cancellation_requested_at || null,
    cancelled_by: a.cancelled_by || null,
    last_progress_at: a.last_progress_at || null,
    image_attempts: a.image_attempts || null,
    updated_at: a.updated_at || null,
    completed_at: a.completed_at || null,
    // Phase 1 — Staging Page + Filter agent
    ad_set_id: a.ad_set_id || null,
    filter_score: a.filter_score ?? null,
    filter_verdict: a.filter_verdict || null,
    filter_reasons: a.filter_reasons || null,  // JSON array as string; null when unset
    // Phase 2B — Meta posting
    meta_ad_id: a.meta_ad_id || null,
    meta_creative_id: a.meta_creative_id || null,
    meta_image_hash: a.meta_image_hash || null,
    meta_post_error: a.meta_post_error || null,
    created_at: a.created_at,
  };
}

function convexAdSummaryToRow(a) {
  return {
    id: a.externalId,
    project_id: a.project_id,
    generation_mode: a.generation_mode,
    angle: a.angle || null,
    angle_name: a.angle_name || null,
    headline: a.headline || null,
    body_copy: a.body_copy || null,
    hook_lane: a.hook_lane || null,
    core_claim: a.core_claim || null,
    target_symptom: a.target_symptom || null,
    emotional_entry: a.emotional_entry || null,
    desired_belief_shift: a.desired_belief_shift || null,
    opening_pattern: a.opening_pattern || null,
    scoring_mode: a.scoring_mode || null,
    copy_render_expectation: a.copy_render_expectation || null,
    product_expectation: a.product_expectation || null,
    sub_angle: a.sub_angle || null,
    template_image_id: a.template_image_id || null,
    storageId: a.storageId || null,
    aspect_ratio: a.aspect_ratio || '1:1',
    status: a.status || 'generating_copy',
    auto_generated: a.auto_generated ? 1 : 0,
    parent_ad_id: a.parent_ad_id || null,
    tags: a.tags || [],
    is_favorite: !!a.is_favorite,
    drive_file_id: a.drive_file_id || null,
    drive_url: a.drive_url || null,
    error_message: a.error_message || null,
    failure_stage: a.failure_stage || null,
    cancellation_requested_at: a.cancellation_requested_at || null,
    cancelled_by: a.cancelled_by || null,
    last_progress_at: a.last_progress_at || null,
    image_attempts: a.image_attempts || null,
    updated_at: a.updated_at || null,
    completed_at: a.completed_at || null,
    has_edit_prompt: !!a.has_image_prompt,
    batch_job_id: a.batch_job_id || null,
    created_at: a.created_at,
  };
}

// =============================================
// Stats helpers
// =============================================

export async function getProjectStats(projectId) {
  return await queryWithRetry(api.projects.getStats, { projectId });
}

// =============================================
// Batch job helpers
// =============================================

export async function createBatchJob({ id, project_id, generation_mode, batch_size, angle, angles, aspect_ratio, template_image_id, template_image_ids, template_tag, inspiration_image_id, inspiration_image_ids, product_image_storageId, scheduled, schedule_cron, filter_assigned, status, queued_at, last_heartbeat_at, posting_day, conductor_run_id, angle_name, angle_prompt, angle_brief, image_model, image_provider, openai_batch_job }) {
  await mutationWithRetry(api.batchJobs.create, {
    externalId: id,
    project_id,
    generation_mode,
    batch_size: batch_size || 1,
    angle: angle || undefined,
    angles: angles || undefined,
    aspect_ratio: aspect_ratio || '1:1',
    template_image_id: template_image_id || undefined,
    template_image_ids: template_image_ids || undefined,
    template_tag: template_tag || undefined,
    inspiration_image_id: inspiration_image_id || undefined,
    inspiration_image_ids: inspiration_image_ids || undefined,
    product_image_storageId: product_image_storageId || undefined,
    scheduled: !!scheduled,
    schedule_cron: schedule_cron || undefined,
    filter_assigned: filter_assigned ? true : undefined,
    status: status || undefined,
    queued_at: queued_at || undefined,
    last_heartbeat_at: last_heartbeat_at || undefined,
    posting_day: posting_day || undefined,
    conductor_run_id: conductor_run_id || undefined,
    angle_name: angle_name || undefined,
    angle_prompt: angle_prompt || undefined,
    angle_brief: angle_brief || undefined,
    image_model: image_model || undefined,
    image_provider: image_provider || undefined,
    openai_batch_job: openai_batch_job ?? undefined,
  });
  invalidateQueryCache('batch_jobs');
}

export async function getBatchJob(id) {
  const batch = await cachedQuery('batch_jobs', api.batchJobs.getByExternalId, { externalId: id });
  if (!batch) return null;
  return convexBatchToRow(batch);
}

export async function getBatchesByProject(projectId) {
  const batches = await cachedQuery('batch_jobs', api.batchJobs.getByProject, { projectId });
  return batches.map(convexBatchToRow);
}

export async function getActiveBatchJobs() {
  const batches = await queryWithRetry(api.batchJobs.getActive, {});
  return batches.map(convexBatchToRow);
}

export async function getQueuedBatchJobs() {
  const batches = await queryWithRetry(api.batchJobs.getQueued, {});
  return batches.map(convexBatchToRow);
}

export async function getScheduledBatchJobs() {
  const batches = await queryWithRetry(api.batchJobs.getScheduled, {});
  return batches.map(convexBatchToRow);
}

export async function getAllScheduledBatchesForCost() {
  return await cachedQuery('batch_jobs', api.batchJobs.getAllScheduledForCost, {});
}

export async function getCompletedDirectorBatchStats(sinceDate) {
  return await cachedQuery('batch_jobs', api.batchJobs.getCompletedDirectorBatchStats, { sinceDate });
}

export async function updateBatchJob(id, fields) {
  const allowed = ['status', 'gemini_batch_job', 'openai_batch_job', 'image_model', 'image_provider', 'gpt_prompts', 'error_message', 'started_at', 'completed_at', 'completed_count', 'failed_count', 'run_count', 'scheduled', 'schedule_cron', 'retry_count', 'queued_at', 'last_heartbeat_at', 'stale_detected_at', 'worker_lease_owner', 'worker_lease_expires_at', 'last_scheduled_run_key', 'batch_stats', 'pipeline_state', 'angle', 'angles', 'batch_size', 'aspect_ratio', 'used_template_ids', 'filter_assigned', 'filter_processed', 'filter_processed_at', 'posting_day', 'conductor_run_id', 'angle_name', 'angle_prompt', 'angle_brief', 'flex_ad_id', 'lp_primary_id', 'lp_primary_url', 'lp_primary_status', 'lp_primary_error', 'lp_primary_retry_count', 'lp_secondary_id', 'lp_secondary_url', 'lp_secondary_status', 'lp_secondary_error', 'lp_secondary_retry_count', 'lp_narrative_frames', 'gauntlet_lp_urls'];
  const updates = { externalId: id };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates[key] = fields[key];
    }
  }
  // Convert scheduled boolean 0/1 to actual boolean for Convex
  if (updates.scheduled !== undefined) {
    updates.scheduled = !!updates.scheduled;
  }
  await mutationWithRetry(api.batchJobs.update, updates);
  invalidateQueryCache('batch_jobs');
}

export async function claimBatchWork(id, owner, leaseMs = 4 * 60 * 1000) {
  const now = new Date();
  const result = await mutationWithRetry(api.batchJobs.claimWork, {
    externalId: id,
    owner,
    now: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
  });
  invalidateQueryCache('batch_jobs');
  if (result?.batch) result.batch = convexBatchToRow(result.batch);
  return result || { claimed: false, reason: 'unknown' };
}

export async function releaseBatchWork(id, owner) {
  const result = await mutationWithRetry(api.batchJobs.releaseWork, { externalId: id, owner });
  invalidateQueryCache('batch_jobs');
  return result || { released: false, reason: 'unknown' };
}

export async function heartbeatBatchJob(id) {
  await mutationWithRetry(api.batchJobs.heartbeat, {
    externalId: id,
    now: new Date().toISOString(),
  });
  invalidateQueryCache('batch_jobs');
}

export async function queueScheduledBatchRun(id, runKey) {
  const result = await mutationWithRetry(api.batchJobs.queueScheduledRun, {
    externalId: id,
    run_key: runKey,
    now: new Date().toISOString(),
  });
  invalidateQueryCache('batch_jobs');
  return result || { queued: false, reason: 'unknown' };
}

export async function claimBatchResultsProcessing(id) {
  const result = await mutationWithRetry(api.batchJobs.claimResultsProcessing, { externalId: id });
  invalidateQueryCache('batch_jobs');
  return result || { claimed: false, status: null, completed_count: 0, failed_count: 0, run_count: 0 };
}

export async function deleteBatchJob(id) {
  await mutationWithRetry(api.batchJobs.remove, { externalId: id });
  invalidateQueryCache('batch_jobs');
}

function convexBatchToRow(b) {
  return {
    id: b.externalId,
    project_id: b.project_id,
    generation_mode: b.generation_mode,
    batch_size: b.batch_size,
    angle: b.angle || null,
    angles: b.angles || null,
    aspect_ratio: b.aspect_ratio || '1:1',
    template_image_id: b.template_image_id || null,
    inspiration_image_id: b.inspiration_image_id || null,
    product_image_storageId: b.product_image_storageId || null,
    product_image_path: null, // no longer used
    gemini_batch_job: b.gemini_batch_job || null,
    openai_batch_job: b.openai_batch_job || null,
    image_model: b.image_model || null,
    image_provider: b.image_provider || null,
    gpt_prompts: b.gpt_prompts || null,
    status: b.status || 'pending',
    scheduled: b.scheduled ? 1 : 0,
    schedule_cron: b.schedule_cron || null,
    error_message: b.error_message || null,
    completed_count: b.completed_count || 0,
    failed_count: b.failed_count || 0,
    run_count: b.run_count || 0,
    retry_count: b.retry_count || 0,
    queued_at: b.queued_at || null,
    last_heartbeat_at: b.last_heartbeat_at || null,
    stale_detected_at: b.stale_detected_at || null,
    worker_lease_owner: b.worker_lease_owner || null,
    worker_lease_expires_at: b.worker_lease_expires_at || null,
    last_scheduled_run_key: b.last_scheduled_run_key || null,
    used_template_ids: b.used_template_ids || null,
    batch_stats: b.batch_stats || null,
    pipeline_state: b.pipeline_state || null,
    filter_assigned: !!b.filter_assigned,
    filter_processed: !!b.filter_processed,
    filter_processed_at: b.filter_processed_at || null,
    posting_day: b.posting_day || null,
    conductor_run_id: b.conductor_run_id || null,
    angle_name: b.angle_name || null,
    angle_prompt: b.angle_prompt || null,
    angle_brief: b.angle_brief || null,
    flex_ad_id: b.flex_ad_id || null,
    lp_primary_id: b.lp_primary_id || null,
    lp_primary_url: b.lp_primary_url || null,
    lp_primary_status: b.lp_primary_status || null,
    lp_primary_error: b.lp_primary_error || null,
    lp_primary_retry_count: b.lp_primary_retry_count || 0,
    lp_secondary_id: b.lp_secondary_id || null,
    lp_secondary_url: b.lp_secondary_url || null,
    lp_secondary_status: b.lp_secondary_status || null,
    lp_secondary_error: b.lp_secondary_error || null,
    lp_secondary_retry_count: b.lp_secondary_retry_count || 0,
    lp_narrative_frames: b.lp_narrative_frames || null,
    gauntlet_lp_urls: b.gauntlet_lp_urls || null,
    created_at: b.created_at,
    started_at: b.started_at || null,
    completed_at: b.completed_at || null,
  };
}

// =============================================
// API Cost helpers
// =============================================

export async function logCost({ id, project_id, service, operation, cost_usd, rate_used, image_count, resolution, source, period_date, model, input_tokens, output_tokens, total_tokens, input_text_tokens, input_image_tokens, quality }) {
  await mutationWithRetry(api.apiCosts.log, {
    externalId: id,
    project_id: project_id || undefined,
    service,
    operation: operation || undefined,
    cost_usd: cost_usd || 0,
    rate_used: rate_used || undefined,
    image_count: image_count || undefined,
    resolution: resolution || undefined,
    model: model || undefined,
    input_tokens: input_tokens || undefined,
    output_tokens: output_tokens || undefined,
    total_tokens: total_tokens || undefined,
    input_text_tokens: input_text_tokens || undefined,
    input_image_tokens: input_image_tokens || undefined,
    quality: quality || undefined,
    source: source || 'calculated',
    period_date: period_date || new Date().toISOString().split('T')[0],
  });
}

export async function getCostAggregates(startDate, endDate, projectId = null) {
  return await cachedQuery('api_costs', api.apiCosts.getAggregates, {
    startDate,
    endDate,
    projectId: projectId || undefined,
  });
}

/**
 * Phase 2 (PEF item D) — sum LLM costs attributed to a single LP. We can't
 * tag individual cost records by LP id (the cost tracker uses operation +
 * projectId), so we approximate by:
 *   1. Fetch all api_costs for the project on the LP's creation date.
 *   2. Filter to operations whose tags strongly imply LP work
 *      (lp_legacy_*, lp_image_strategy_*, lp_image_candidate, lp_generation,
 *       lp_html_generation, lp_visual_qa).
 *   3. Sum cost_usd.
 * Approximate but useful for "this LP cost roughly $X" surfacing.
 */
export async function getLPCostEstimate(projectId, lpCreatedAtIso) {
  if (!projectId || !lpCreatedAtIso) return { totalUsd: 0, byOperation: {} };
  const dateStr = lpCreatedAtIso.slice(0, 10);
  const aggregates = await getCostAggregates(dateStr, dateStr, projectId).catch(() => null);
  if (!aggregates?.byOperation) return { totalUsd: 0, byOperation: {} };
  const lpOpPrefixes = ['lp_legacy_', 'lp_image_strategy', 'lp_image_candidate', 'lp_generation', 'lp_html', 'lp_visual_qa', 'lp_design_analysis', 'lp_image_prescore', 'lp_gauntlet'];
  let totalUsd = 0;
  const byOperation = {};
  for (const [op, data] of Object.entries(aggregates.byOperation)) {
    const matches = lpOpPrefixes.some(prefix => op.startsWith(prefix));
    if (!matches) continue;
    byOperation[op] = data.cost || 0;
    totalUsd += data.cost || 0;
  }
  return { totalUsd, byOperation };
}

/**
 * Phase 2 (PEF item J) — return today's Gemini spend in USD for a project.
 * Used by the LP image-candidate generator to enforce a daily budget cap and
 * prevent denial-of-wallet from runaway candidate regeneration.
 */
export async function getTodayGeminiSpend(projectId) {
  if (!projectId) return 0;
  const today = new Date().toISOString().split('T')[0];
  const aggregates = await getCostAggregates(today, today, projectId).catch(() => null);
  if (!aggregates) return 0;
  const byService = aggregates.byService || {};
  // The cost tracker stores Gemini under either 'gemini' or 'google' depending
  // on the wrapper version — sum both to be safe.
  return (byService.gemini || 0) + (byService.google || 0);
}

export async function getAgentCosts(startDate, endDate) {
  return await cachedQuery('api_costs', api.apiCosts.getAgentCosts, { startDate, endDate });
}

export async function getDailyCostHistory(days = 30, projectId = null) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().split('T')[0];

  return await cachedQuery('api_costs', api.apiCosts.getDailyHistory, {
    startDate: startStr,
    projectId: projectId || undefined,
  });
}

export async function getDailyCostHistoryRange(startDate, endDate, projectId = null) {
  return await cachedQuery('api_costs', api.apiCosts.getDailyHistory, {
    startDate,
    endDate,
    projectId: projectId || undefined,
  });
}

export async function deleteCostsBySource(source, startDate) {
  return await mutationWithRetry(api.apiCosts.deleteBySourceAndDate, { source, startDate });
}

// =============================================
// Inspiration image helpers (new)
// =============================================

export async function getInspirationImages(projectId) {
  return await queryWithRetry(api.inspirationImages.getByProject, { projectId });
}

export async function getAllInspirationImages() {
  // Use indexed per-project queries instead of unindexed getAll (which crashes on 200+ records)
  const projects = await getAllProjects();
  const results = await Promise.all(
    projects.map(p => getInspirationImages(p.id))
  );
  return results.flat();
}

export async function getInspirationImage(projectId, driveFileId) {
  return await queryWithRetry(api.inspirationImages.getByDriveFileId, { projectId, driveFileId });
}

export async function getInspirationImageUrl(projectId, driveFileId) {
  return await queryWithRetry(api.inspirationImages.getImageUrl, { projectId, driveFileId });
}

// =============================================
// File storage helpers
// =============================================

export async function generateUploadUrl() {
  return await mutationWithRetry(api.fileStorage.generateUploadUrl, {});
}

// In-memory TTL cache for storage URLs — content-addressed, stable for the lifetime of the file
const storageUrlCache = new Map();
const STORAGE_URL_TTL = 30 * 60 * 1000; // 30 minutes

// Periodic cleanup to prevent memory growth (runs every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of storageUrlCache) {
    if (now - entry.time > STORAGE_URL_TTL) storageUrlCache.delete(key);
  }
}, 10 * 60 * 1000).unref();

export async function getStorageUrl(storageId) {
  if (!storageId) return null;

  const cached = storageUrlCache.get(storageId);
  if (cached && Date.now() - cached.time < STORAGE_URL_TTL) return cached.url;

  const url = await queryWithRetry(api.fileStorage.getUrl, { storageId });
  if (url) storageUrlCache.set(storageId, { url, time: Date.now() });
  return url;
}

export async function deleteStorageFile(storageId) {
  storageUrlCache.delete(storageId);
  await mutationWithRetry(api.fileStorage.deleteFile, { storageId });
}

/**
 * Upload a Buffer to Convex file storage.
 * Returns the storageId that can be stored in any record.
 */
export async function uploadBuffer(buffer, contentType = 'image/png') {
  return withRetry(async () => {
    // Fresh upload URL on each attempt (previous one may be stale after ECONNRESET)
    const uploadUrl = await generateUploadUrl();

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: buffer,
    });

    if (!response.ok) {
      throw new Error(`Convex upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.storageId;
  }, { maxRetries: 3, label: 'Convex upload' });
}

/**
 * Download a file from Convex storage and return it as a Buffer.
 * Useful for passing to external APIs (Drive, Gemini).
 */
export async function downloadToBuffer(storageId) {
  return withRetry(async () => {
    const url = await getStorageUrl(storageId);
    if (!url) throw new Error('No storage URL for storageId');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download from Convex storage: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }, { maxRetries: 3, label: 'Convex storage download' });
}

// =============================================
// Template image helpers
// =============================================

export async function getTemplateImageUrl(externalId) {
  return await queryWithRetry(api.templateImages.getImageUrl, { externalId });
}

export async function getTemplateImagesByProject(projectId) {
  return await queryWithRetry(api.templateImages.getByProject, { projectId });
}

export async function getAllTemplateImages() {
  // Use indexed per-project queries instead of unindexed getAll (which crashes on large tables)
  const projects = await getAllProjects();
  const results = await Promise.all(
    projects.map(p => queryWithRetry(api.templateImages.getByProject, { projectId: p.id }))
  );
  return results.flat();
}

export async function getAllTemplateImagesWithUrls() {
  return await queryWithRetry(api.templateImages.getAllWithUrls, {});
}

// =============================================
// Ad Deployment helpers (Ad Tracker feature)
// =============================================

export async function getAllDeployments() {
  return await cachedQuery('ad_deployments', api.ad_deployments.getAll, {});
}

export async function getDeploymentsByProject(projectId) {
  return await cachedQuery('ad_deployments', api.ad_deployments.getByProject, { projectId });
}

export async function getDeploymentsByStatus(status) {
  return await cachedQuery('ad_deployments', api.ad_deployments.getByStatus, { status });
}

export async function getDeploymentByAdId(adId) {
  return await cachedQuery('ad_deployments', api.ad_deployments.getByAdId, { adId });
}

export async function getDeploymentByExternalId(externalId) {
  return await cachedQuery('ad_deployments', api.ad_deployments.getByExternalId, { externalId });
}

export async function createDeployment({ id, ad_id, project_id, status, ad_name, local_campaign_id }) {
  const result = await mutationWithRetry(api.ad_deployments.create, {
    externalId: id,
    ad_id,
    project_id,
    status,
    ...(ad_name ? { ad_name } : {}),
    ...(local_campaign_id ? { local_campaign_id } : {}),
    created_at: new Date().toISOString(),
  });
  invalidateQueryCache('ad_deployments');
  return result;
}

export async function updateDeployment(id, fields) {
  const result = await mutationWithRetry(api.ad_deployments.update, { externalId: id, fields });
  invalidateQueryCache('ad_deployments');
  return result;
}

export async function updateDeploymentStatus(id, status) {
  const result = await mutationWithRetry(api.ad_deployments.updateStatus, { externalId: id, status });
  invalidateQueryCache('ad_deployments');
  return result;
}

export async function deleteDeployment(id) {
  const result = await mutationWithRetry(api.ad_deployments.remove, { externalId: id });
  invalidateQueryCache('ad_deployments');
  return result;
}

export async function restoreDeployment(id) {
  const result = await mutationWithRetry(api.ad_deployments.restore, { externalId: id });
  invalidateQueryCache('ad_deployments');
  return result;
}

export async function getDeletedDeployments(projectId) {
  const results = await cachedQuery('ad_deployments', api.ad_deployments.getDeleted, { projectId: projectId || undefined });
  return results.map(d => ({
    ...d,
    id: d.externalId,
  }));
}

export async function purgeDeletedDeployments(olderThanDays = 30) {
  return await mutationWithRetry(api.ad_deployments.purgeDeleted, { olderThanDays });
}

// =============================================
// Campaign helpers (local campaign organization)
// =============================================

export async function getCampaignsByProject(projectId) {
  const campaigns = ensureArray(await cachedQuery('campaigns', api.campaigns.getByProject, { projectId }), 'convexClient.getCampaignsByProject');
  return campaigns.map(c => ({
    id: c.externalId,
    project_id: c.project_id,
    name: c.name,
    sort_order: c.sort_order,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}

export async function getCampaign(id) {
  const campaign = await cachedQuery('campaigns', api.campaigns.getByExternalId, { externalId: id });
  if (!campaign) return null;
  return {
    id: campaign.externalId,
    project_id: campaign.project_id,
    name: campaign.name,
    sort_order: campaign.sort_order,
    created_at: campaign.created_at,
    updated_at: campaign.updated_at,
  };
}

export async function createCampaign({ id, project_id, name, sort_order }) {
  const now = new Date().toISOString();
  const result = await mutationWithRetry(api.campaigns.create, {
    externalId: id,
    project_id,
    name,
    sort_order: sort_order || 0,
    created_at: now,
    updated_at: now,
  });
  invalidateQueryCache('campaigns');
  return result;
}

export async function updateCampaign(id, fields) {
  const result = await mutationWithRetry(api.campaigns.update, { externalId: id, fields });
  invalidateQueryCache('campaigns');
  return result;
}

export async function deleteCampaign(id) {
  const result = await mutationWithRetry(api.campaigns.remove, { externalId: id });
  invalidateQueryCache('campaigns');
  invalidateQueryCache('ad_sets');
  invalidateQueryCache('flex_ads');
  return result;
}

// =============================================
// Ad Set helpers (local ad set organization)
// =============================================

function convexAdSetToRow(a) {
  return {
    id: a.externalId,
    campaign_id: a.campaign_id,
    project_id: a.project_id,
    name: a.name,
    sort_order: a.sort_order,
    // Phase 1 — Staging Page + Director-driven angle testing
    angle_id: a.angle_id || null,
    lifecycle_status: a.lifecycle_status || null,
    meta_targeting: a.meta_targeting || null,                    // JSON-as-string; null when unset
    meta_budget_type: a.meta_budget_type || null,
    meta_budget_amount_cents: a.meta_budget_amount_cents ?? null,
    meta_schedule: a.meta_schedule || null,                      // JSON-as-string
    meta_optimization_goal: a.meta_optimization_goal || null,
    meta_billing_event: a.meta_billing_event || null,
    posted_at: a.posted_at || null,
    meta_adset_id: a.meta_adset_id || null,
    ready_source: a.ready_source || null,
    ready_at: a.ready_at || null,
    // Phase 2B
    meta_campaign_id: a.meta_campaign_id || null,
    meta_post_error: a.meta_post_error || null,
    meta_post_path: a.meta_post_path || null,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export async function getAdSet(id) {
  const adSet = await cachedQuery('ad_sets', api.adSets.getByExternalId, { externalId: id });
  if (!adSet) return null;
  return convexAdSetToRow(adSet);
}

export async function getAdSetsByProject(projectId) {
  const adSets = ensureArray(await cachedQuery('ad_sets', api.adSets.getByProject, { projectId }), 'convexClient.getAdSetsByProject');
  return adSets.map(convexAdSetToRow);
}

export async function getAdSetsByCampaign(campaignId) {
  const adSets = await cachedQuery('ad_sets', api.adSets.getByCampaign, { campaignId });
  return adSets.map(convexAdSetToRow);
}

// Phase 1 — staging-lifecycle queries
export async function getAdSetsByProjectAndLifecycle(projectId, lifecycleStatus) {
  const adSets = ensureArray(
    await queryWithRetry(api.adSets.getByProjectAndLifecycle, { projectId, lifecycle_status: lifecycleStatus }),
    'convexClient.getAdSetsByProjectAndLifecycle'
  );
  return adSets.map(convexAdSetToRow);
}

export async function createAdSet({ id, campaign_id, project_id, name, sort_order, angle_id, lifecycle_status, ready_source, ready_at, meta_targeting, meta_budget_type, meta_budget_amount_cents, meta_schedule, meta_optimization_goal, meta_billing_event }) {
  const now = new Date().toISOString();
  const result = await mutationWithRetry(api.adSets.create, compactConvexWrite({
    externalId: id,
    campaign_id,
    project_id,
    name,
    sort_order: sort_order || 0,
    // Phase 1 fields (all optional)
    angle_id,
    lifecycle_status,
    ready_source,
    ready_at,
    meta_targeting,
    meta_budget_type,
    meta_budget_amount_cents,
    meta_schedule,
    meta_optimization_goal,
    meta_billing_event,
    created_at: now,
    updated_at: now,
  }));
  invalidateQueryCache('ad_sets');
  return result;
}

export async function createAdSetFromDeployments({ id, campaign_id, project_id, name, sort_order, angle_id, lifecycle_status, ready_source, ready_at, deployment_ids, meta_targeting, meta_budget_type, meta_budget_amount_cents, meta_schedule, meta_optimization_goal, meta_billing_event }) {
  const now = new Date().toISOString();
  const result = await mutationWithRetry(api.adSets.createFromDeployments, compactConvexWrite({
    externalId: id,
    campaign_id,
    project_id,
    name,
    sort_order: sort_order || 0,
    deployment_ids,
    angle_id,
    lifecycle_status,
    ready_source,
    ready_at,
    meta_targeting,
    meta_budget_type,
    meta_budget_amount_cents,
    meta_schedule,
    meta_optimization_goal,
    meta_billing_event,
    created_at: now,
    updated_at: now,
  }));
  invalidateQueryCache('ad_sets');
  invalidateQueryCache('ad_deployments');
  return result;
}

export async function updateAdSet(id, fields) {
  // Whitelist enforcement is handled inside convex/adSets.ts:update via v.object().
  // Caller passes fields supported by that whitelist.
  const result = await mutationWithRetry(api.adSets.update, { externalId: id, fields: compactConvexWrite(fields) });
  invalidateQueryCache('ad_sets');
  return result;
}

export async function deleteAdSet(id) {
  const result = await mutationWithRetry(api.adSets.remove, { externalId: id });
  invalidateQueryCache('ad_sets');
  invalidateQueryCache('flex_ads');
  return result;
}

// =============================================
// Phase 1 — Staging Page operations
// =============================================

export async function getStagingPending(projectId) {
  // Returns [{ adSet: {...}, ads: [...] }]
  const result = await queryWithRetry(api.staging.getPendingByProject, { projectId });
  if (!Array.isArray(result)) return [];
  return result.map(({ adSet, ads }) => ({
    adSet: convexAdSetToRow(adSet),
    ads: ads.map(convexAdToRow),
  }));
}

export async function getStagingPromoted(projectId) {
  const result = ensureArray(
    await queryWithRetry(api.staging.getPromotedByProject, { projectId }),
    'convexClient.getStagingPromoted'
  );
  return result.map(convexAdSetToRow);
}

export async function getStagingRejected(projectId) {
  const result = ensureArray(
    await queryWithRetry(api.adCreatives.getRejectedByProject, { projectId }),
    'convexClient.getStagingRejected'
  );
  return result.map(convexAdToRow);
}

export async function promoteAdSet(adSetExternalId) {
  const result = await mutationWithRetry(api.staging.promote, { externalId: adSetExternalId });
  invalidateQueryCache('ad_sets');
  return result;
}

export async function regroupAds(adIds, targetAdSetId) {
  const result = await mutationWithRetry(api.staging.regroupAds, { adIds, targetAdSetId });
  invalidateQueryCache('ad_creatives');
  return result;
}

export async function createEmptyAdSet({ id, project_id, campaign_id, angle_id, name, sort_order, meta_targeting, meta_budget_type, meta_budget_amount_cents, meta_schedule, meta_optimization_goal, meta_billing_event }) {
  const result = await mutationWithRetry(api.staging.createEmptyAdSet, compactConvexWrite({
    externalId: id,
    project_id,
    campaign_id,
    angle_id,
    name,
    sort_order: sort_order || 0,
    meta_targeting,
    meta_budget_type,
    meta_budget_amount_cents,
    meta_schedule,
    meta_optimization_goal,
    meta_billing_event,
  }));
  invalidateQueryCache('ad_sets');
  return result;
}

export async function setFilterVerdict(adId, { score, verdict, reasons }) {
  const result = await mutationWithRetry(api.adCreatives.setFilterVerdict, {
    externalId: adId,
    filter_score: score,
    filter_verdict: verdict,
    filter_reasons: reasons || undefined,
  });
  invalidateQueryCache('ad_creatives');
  return result;
}

export async function forcePromoteAd(adId) {
  const result = await mutationWithRetry(api.adCreatives.forcePromote, { externalId: adId });
  invalidateQueryCache('ad_creatives');
  return result;
}

// Phase 1 — auxiliary helpers used by batchProcessor when creating ad_sets per batch.

// Lookup an angle's externalId by its name within a project. Returns null if not found.
// Used when bridging between batch.angle_name (string) and ad_sets.angle_id (externalId).
export async function findConductorAngleByName(projectId, name) {
  if (!name) return null;
  const angles = await getConductorAngles(projectId);
  const match = angles.find((a) => a.name === name);
  return match ? match.externalId : null;
}

// Get or create the project's default Meta campaign (used when an ad_set is created
// and no explicit campaign is selected). Caches the resolved campaign id back onto
// the project so subsequent lookups are direct. Idempotent.
export async function ensureDefaultCampaign(project) {
  if (project?.default_campaign_id) {
    return project.default_campaign_id;
  }
  // Try to find an existing "Default" campaign for the project before creating one.
  const existingCampaigns = await getCampaignsByProject(project.id);
  let campaign = existingCampaigns.find((c) => c.name === `[Default] ${project.name}`);
  if (!campaign) {
    const newId = uuidv4();
    await createCampaign({
      id: newId,
      project_id: project.id,
      name: `[Default] ${project.name}`,
      sort_order: 0,
    });
    campaign = { id: newId };
  }
  // Persist on the project so the next call short-circuits.
  await updateProject(project.id, { default_campaign_id: campaign.id });
  return campaign.id;
}

// Read project's adset_default_template JSON safely. Returns an object with the standard
// Meta-set fields (targeting, budget, schedule, optimization, billing). Missing keys → null.
// All values are passed through as JSON-stringified or primitive types matching the schema.
export function parseAdSetDefaults(project) {
  if (!project?.adset_default_template) {
    return {
      meta_targeting: null,
      meta_budget_type: null,
      meta_budget_amount_cents: null,
      meta_schedule: null,
      meta_optimization_goal: null,
      meta_billing_event: null,
    };
  }
  let parsed;
  try {
    parsed = typeof project.adset_default_template === 'string'
      ? JSON.parse(project.adset_default_template)
      : project.adset_default_template;
  } catch {
    return {
      meta_targeting: null,
      meta_budget_type: null,
      meta_budget_amount_cents: null,
      meta_schedule: null,
      meta_optimization_goal: null,
      meta_billing_event: null,
    };
  }
  return {
    meta_targeting: parsed.targeting ? JSON.stringify(parsed.targeting) : null,
    meta_budget_type: parsed.budget_type || null,
    meta_budget_amount_cents: typeof parsed.budget_amount_cents === 'number' ? parsed.budget_amount_cents : null,
    meta_schedule: parsed.schedule ? JSON.stringify(parsed.schedule) : null,
    meta_optimization_goal: parsed.optimization_goal || null,
    meta_billing_event: parsed.billing_event || null,
  };
}

// =============================================
// Flex Ad helpers
// =============================================

export async function getFlexAdsByProject(projectId) {
  const flexAds = ensureArray(await cachedQuery('flex_ads', api.flexAds.getByProject, { projectId }), 'convexClient.getFlexAdsByProject');
  return flexAds.map(f => ({
    id: f.externalId,
    project_id: f.project_id,
    ad_set_id: f.ad_set_id,
    name: f.name,
    child_deployment_ids: f.child_deployment_ids,
    primary_texts: f.primary_texts || null,
    headlines: f.headlines || null,
    destination_url: f.destination_url || null,
    display_link: f.display_link || null,
    cta_button: f.cta_button || null,
    facebook_page: f.facebook_page || null,
    planned_date: f.planned_date || null,
    posted_by: f.posted_by || null,
    duplicate_adset_name: f.duplicate_adset_name || null,
    notes: f.notes || null,
    posting_day: f.posting_day || null,
    angle_name: f.angle_name || null,
    lp_primary_url: f.lp_primary_url || null,
    lp_secondary_url: f.lp_secondary_url || null,
    gauntlet_lp_urls: f.gauntlet_lp_urls || null,
    destination_urls_used: f.destination_urls_used || null,
    created_at: f.created_at,
    updated_at: f.updated_at,
  }));
}

export async function getFlexAdsByAdSet(adSetId) {
  const flexAds = await cachedQuery('flex_ads', api.flexAds.getByAdSet, { adSetId });
  return flexAds.map(f => ({
    id: f.externalId,
    project_id: f.project_id,
    ad_set_id: f.ad_set_id,
    name: f.name,
    child_deployment_ids: f.child_deployment_ids,
    primary_texts: f.primary_texts || null,
    headlines: f.headlines || null,
    destination_url: f.destination_url || null,
    display_link: f.display_link || null,
    cta_button: f.cta_button || null,
    facebook_page: f.facebook_page || null,
    planned_date: f.planned_date || null,
    posted_by: f.posted_by || null,
    duplicate_adset_name: f.duplicate_adset_name || null,
    lp_primary_url: f.lp_primary_url || null,
    lp_secondary_url: f.lp_secondary_url || null,
    gauntlet_lp_urls: f.gauntlet_lp_urls || null,
    destination_urls_used: f.destination_urls_used || null,
    created_at: f.created_at,
    updated_at: f.updated_at,
  }));
}

export async function getFlexAd(id) {
  const f = await cachedQuery('flex_ads', api.flexAds.getByExternalId, { externalId: id });
  if (!f) return null;
  return {
    id: f.externalId,
    project_id: f.project_id,
    ad_set_id: f.ad_set_id,
    name: f.name,
    child_deployment_ids: f.child_deployment_ids,
    primary_texts: f.primary_texts || null,
    headlines: f.headlines || null,
    destination_url: f.destination_url || null,
    display_link: f.display_link || null,
    cta_button: f.cta_button || null,
    facebook_page: f.facebook_page || null,
    planned_date: f.planned_date || null,
    posted_by: f.posted_by || null,
    duplicate_adset_name: f.duplicate_adset_name || null,
    notes: f.notes || null,
    posting_day: f.posting_day || null,
    angle_name: f.angle_name || null,
    lp_primary_url: f.lp_primary_url || null,
    lp_secondary_url: f.lp_secondary_url || null,
    gauntlet_lp_urls: f.gauntlet_lp_urls || null,
    destination_urls_used: f.destination_urls_used || null,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

export async function createFlexAd({ id, project_id, ad_set_id, name, child_deployment_ids, primary_texts, headlines, display_link, cta_button, facebook_page, destination_url, duplicate_adset_name, posting_day, angle_name, lp_primary_url, lp_secondary_url, gauntlet_lp_urls }) {
  const now = new Date().toISOString();
  return await mutationWithRetry(api.flexAds.create, {
    externalId: id,
    project_id,
    ad_set_id,
    name,
    child_deployment_ids: JSON.stringify(child_deployment_ids),
    ...(primary_texts ? { primary_texts: JSON.stringify(primary_texts) } : {}),
    ...(headlines ? { headlines: JSON.stringify(headlines) } : {}),
    ...(display_link ? { display_link } : {}),
    ...(cta_button ? { cta_button } : {}),
    ...(facebook_page ? { facebook_page } : {}),
    ...(destination_url ? { destination_url } : {}),
    ...(duplicate_adset_name ? { duplicate_adset_name } : {}),
    ...(posting_day ? { posting_day } : {}),
    ...(angle_name ? { angle_name } : {}),
    ...(lp_primary_url ? { lp_primary_url } : {}),
    ...(lp_secondary_url ? { lp_secondary_url } : {}),
    ...(gauntlet_lp_urls ? { gauntlet_lp_urls } : {}),
    created_at: now,
    updated_at: now,
  });
  invalidateQueryCache('flex_ads');
}

export async function updateFlexAd(id, fields) {
  const result = await mutationWithRetry(api.flexAds.update, { externalId: id, fields });
  invalidateQueryCache('flex_ads');
  return result;
}

export async function deleteFlexAd(id) {
  const result = await mutationWithRetry(api.flexAds.remove, { externalId: id });
  invalidateQueryCache('flex_ads');
  return result;
}

export async function restoreFlexAd(id) {
  const result = await mutationWithRetry(api.flexAds.restore, { externalId: id });
  invalidateQueryCache('flex_ads');
  return result;
}

export async function purgeDeletedFlexAds(olderThanDays = 30) {
  const result = await mutationWithRetry(api.flexAds.purgeDeleted, { olderThanDays });
  invalidateQueryCache('flex_ads');
  return result;
}

// Duplicate a deployment (skips dedup guard)
export async function createDeploymentDuplicate({ id, ad_id, project_id, status, ad_name, local_campaign_id, local_adset_id, flex_ad_id, destination_url, cta_button, primary_texts, ad_headlines, planned_date }) {
  const result = await mutationWithRetry(api.ad_deployments.createWithoutDedup, {
    externalId: id,
    ad_id,
    project_id,
    status,
    ...(ad_name ? { ad_name } : {}),
    ...(local_campaign_id ? { local_campaign_id } : {}),
    ...(local_adset_id ? { local_adset_id } : {}),
    ...(flex_ad_id ? { flex_ad_id } : {}),
    ...(destination_url ? { destination_url } : {}),
    ...(cta_button ? { cta_button } : {}),
    ...(primary_texts ? { primary_texts } : {}),
    ...(ad_headlines ? { ad_headlines } : {}),
    ...(planned_date ? { planned_date } : {}),
    created_at: new Date().toISOString(),
  });
  invalidateQueryCache('ad_deployments');
  return result;
}

// =============================================
// Chat Thread helpers
// =============================================

export async function getActiveChatThread(projectId) {
  return await queryWithRetry(api.chatThreads.getActiveByProject, { projectId });
}

export async function createChatThread({ id, project_id, title }) {
  await mutationWithRetry(api.chatThreads.create, {
    externalId: id,
    project_id,
    title: title || undefined,
  });
}

export async function archiveChatThread(threadId) {
  await mutationWithRetry(api.chatThreads.archive, { externalId: threadId });
}

export async function getChatMessages(threadId) {
  return await queryWithRetry(api.chatThreads.getMessagesByThread, { threadId });
}

export async function createChatMessage({ id, thread_id, project_id, role, content, is_context_message }) {
  await mutationWithRetry(api.chatThreads.createMessage, {
    externalId: id,
    thread_id,
    project_id,
    role,
    content,
    is_context_message: is_context_message || undefined,
  });
}

// =============================================
// Correction History (dedicated table)
// =============================================

export async function getCorrectionHistoryByProject(projectId) {
  const rows = await queryWithRetry(api.correction_history.getByProject, { projectId });
  return (rows || []).map(row => ({
    id: row.externalId,
    correction: row.correction,
    timestamp: row.timestamp,
    manual: row.manual || false,
    changes: row.changes ? JSON.parse(row.changes) : [],
  }));
}

export async function createCorrectionHistory({ id, project_id, correction, timestamp, manual, changes }) {
  await mutationWithRetry(api.correction_history.create, {
    externalId: id,
    project_id,
    correction,
    timestamp,
    manual: manual || undefined,
    changes: typeof changes === 'string' ? changes : JSON.stringify(changes),
  });
}

export async function deleteCorrectionHistory(externalId) {
  await mutationWithRetry(api.correction_history.remove, { externalId });
}

// =============================================
// Dashboard Todos (dedicated table)
// =============================================

export async function getDashboardTodos() {
  const rows = await queryWithRetry(api.dashboard_todos.getAll, {});
  return (rows || [])
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(row => ({
      id: row.externalId,
      text: row.text,
      done: row.done,
      author: row.author || undefined,
      notes: row.notes || undefined,
      priority: typeof row.priority === 'number' ? row.priority : undefined,
    }));
}

export async function replaceDashboardTodos(todos) {
  await mutationWithRetry(api.dashboard_todos.replaceAll, {
    todos: JSON.stringify(todos),
  });
}

/**
 * Non-destructive single-row upsert on the dashboard_todos table. Safe to
 * call concurrently from LP chief-review events — only the row keyed by
 * externalId is touched.
 */
export async function upsertDashboardTodo({ externalId, text, notes, author, priority, sort_order }) {
  await mutationWithRetry(api.dashboard_todos.upsertByExternalId, {
    externalId,
    text,
    notes,
    author,
    priority,
    sort_order,
  });
}

/**
 * Non-destructive delete of a single dashboard todo by externalId. Used to
 * clear a pending-review reminder when the LP is approved, rejected, or
 * expires. No-op if the row doesn't exist.
 */
export async function removeDashboardTodo(externalId) {
  await mutationWithRetry(api.dashboard_todos.removeByExternalId, { externalId });
}

/**
 * Return every landing page currently in `pending_review` across the whole
 * database. Used by the daily expiry scheduler to age out stale reviews.
 */
export async function getAllPendingReviewLPs() {
  return await queryWithRetry(api.landingPages.getAllPendingReview, {});
}

/**
 * Return every landing page currently in `pending_image_selection` (PEF plan
 * 2026-04-21 manual flow). Used by the daily expiry scheduler.
 */
export async function getAllPendingImageSelectionLPs() {
  return await queryWithRetry(api.landingPages.getAllPendingImageSelection, {});
}

/**
 * Phase 2 (PEF item B) — return every published LP that still has
 * image_candidates populated. Used by the daily cleanup cron to purge
 * unplaced candidate blobs after the LP has been live for N days.
 */
export async function getPublishedLPsWithCandidates() {
  return await queryWithRetry(api.landingPages.getPublishedLPsWithCandidates, {});
}

/**
 * Delete a single blob from Convex storage by storageId. Used by the
 * candidate-cleanup cron to purge individual unplaced image blobs without
 * removing the LP's placed candidates.
 */
export async function deleteStorageBlob(storageId) {
  return mutationWithRetry(api.fileStorage.deleteFile, { storageId });
}

/**
 * Phase 2 (PEF item H) — return every LP for a project that has candidates,
 * for the unplaced-candidates archive view.
 */
export async function getLPsWithCandidatesByProject(projectId) {
  return queryWithRetry(api.landingPages.getLPsWithCandidatesByProject, { projectId });
}

// =============================================
// Landing Page helpers
// =============================================

export async function getLandingPagesByProject(projectId) {
  return ensureArray(await cachedQuery('landing_pages', api.landingPages.getByProject, { projectId }), 'convexClient.getLandingPagesByProject');
}

export async function getLandingPageSummariesByProject(projectId) {
  return ensureArray(await cachedQuery('landing_pages', api.landingPages.getListByProject, { projectId }), 'convexClient.getLandingPageSummariesByProject');
}

export async function getLandingPage(externalId) {
  return await cachedQuery('landing_pages', api.landingPages.getByExternalId, { externalId });
}

/**
 * Count LPs created in the current UTC day for a project. Used by the
 * daily LP generation cap (PEF plan 2026-04-21 invariant — denial-of-wallet
 * guard). Skips LPs in 'failed' status so a string of failed attempts doesn't
 * lock Ian out.
 */
export async function countLandingPagesCreatedToday(projectId) {
  const all = await getLandingPagesByProject(projectId);
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();
  return all.filter((p) => {
    if (!p?.created_at) return false;
    if (p.status === 'failed') return false;
    return p.created_at >= startIso;
  }).length;
}

export async function getLandingPagesByBatchJob(batchJobId) {
  return ensureArray(
    await queryWithRetry(api.landingPages.getByBatchJob, { batchJobId }),
    'convexClient.getLandingPagesByBatchJob'
  );
}

export async function getLandingPageGauntletStats(projectId) {
  return await queryWithRetry(api.landingPages.getGauntletStatsByProject, { projectId });
}

export async function createLandingPage({ id, project_id, name, angle, word_count, additional_direction, swipe_text, swipe_filename, swipe_url, swipe_screenshot_storageId, status, auto_generated, batch_job_id, narrative_frame, template_id, headline_text, subheadline_text, headline_frame_alignment_status, headline_frame_alignment_reason, headline_uniqueness_status, headline_uniqueness_reason, headline_duplicate_of_lp_id, title_family_uniqueness_status, title_family_uniqueness_reason, title_concept_separation_status, title_concept_separation_reason, title_concept_signature, title_concept_family, headline_history_status, headline_history_reason, headline_signature, frame_blueprint_status, frame_blueprint_reason, gauntlet_batch_id, gauntlet_frame, gauntlet_attempt, gauntlet_status, gauntlet_batch_started_at, gauntlet_batch_completed_at, source_angle, derived_angle, angle_derivation_image_urls }) {
  await mutationWithRetry(api.landingPages.create, {
    externalId: id,
    project_id,
    name,
    angle: angle || undefined,
    word_count: word_count || undefined,
    additional_direction: additional_direction || undefined,
    swipe_text: swipe_text || undefined,
    swipe_filename: swipe_filename || undefined,
    swipe_url: swipe_url || undefined,
    swipe_screenshot_storageId: swipe_screenshot_storageId || undefined,
    status: status || 'draft',
    auto_generated: auto_generated || undefined,
    batch_job_id: batch_job_id || undefined,
    narrative_frame: narrative_frame || undefined,
    template_id: template_id || undefined,
    headline_text: headline_text || undefined,
    subheadline_text: subheadline_text || undefined,
    headline_frame_alignment_status: headline_frame_alignment_status || undefined,
    headline_frame_alignment_reason: headline_frame_alignment_reason || undefined,
    headline_uniqueness_status: headline_uniqueness_status || undefined,
    headline_uniqueness_reason: headline_uniqueness_reason || undefined,
    headline_duplicate_of_lp_id: headline_duplicate_of_lp_id || undefined,
    title_family_uniqueness_status: title_family_uniqueness_status || undefined,
    title_family_uniqueness_reason: title_family_uniqueness_reason || undefined,
    title_concept_separation_status: title_concept_separation_status || undefined,
    title_concept_separation_reason: title_concept_separation_reason || undefined,
    title_concept_signature: title_concept_signature || undefined,
    title_concept_family: title_concept_family || undefined,
    headline_history_status: headline_history_status || undefined,
    headline_history_reason: headline_history_reason || undefined,
    headline_signature: headline_signature || undefined,
    frame_blueprint_status: frame_blueprint_status || undefined,
    frame_blueprint_reason: frame_blueprint_reason || undefined,
    gauntlet_batch_id: gauntlet_batch_id || undefined,
    gauntlet_frame: gauntlet_frame || undefined,
    gauntlet_attempt: gauntlet_attempt || undefined,
    gauntlet_status: gauntlet_status || undefined,
    gauntlet_batch_started_at: gauntlet_batch_started_at || undefined,
    gauntlet_batch_completed_at: gauntlet_batch_completed_at || undefined,
    source_angle: source_angle || undefined,
    derived_angle: derived_angle || undefined,
    angle_derivation_image_urls: angle_derivation_image_urls || undefined,
  });
  invalidateQueryCache('landing_pages');
}

export async function updateLandingPage(externalId, fields) {
  await mutationWithRetry(api.landingPages.update, { externalId, ...fields });
  invalidateQueryCache('landing_pages');
}

export async function deleteLandingPage(externalId) {
  // Best-effort: purge any image_candidate blobs held by this LP so storage
  // doesn't leak. Non-fatal if it fails (the row delete still proceeds).
  try {
    await purgeLPCandidateBlobs(externalId);
  } catch (err) {
    console.warn(`[convexClient.deleteLandingPage] purgeLPCandidateBlobs failed for ${externalId}: ${err.message}`);
  }

  // Delete all versions first
  const versions = await queryWithRetry(api.landingPageVersions.getByLandingPage, { landingPageId: externalId });
  for (const v of versions) {
    await mutationWithRetry(api.landingPageVersions.remove, { externalId: v.externalId });
  }
  await mutationWithRetry(api.landingPages.remove, { externalId });
  invalidateQueryCache('landing_pages');
  invalidateQueryCache('landing_page_versions');
}

/**
 * Delete every image_candidate blob storage entry for an LP.
 * Used by the LP-delete cascade and the daily expiry cron's blob-purge step.
 *
 * Failures on individual deletes are logged but don't abort the loop —
 * a missing blob shouldn't block the cleanup.
 */
export async function purgeLPCandidateBlobs(externalId) {
  const lp = await queryWithRetry(api.landingPages.getByExternalId, { externalId }).catch(() => null);
  if (!lp) return { purged: 0, missing: 0 };
  let purged = 0;
  let missing = 0;
  let candidates = [];
  try {
    candidates = lp.image_candidates ? JSON.parse(lp.image_candidates) : [];
  } catch {
    candidates = [];
  }
  if (!Array.isArray(candidates)) return { purged: 0, missing: 0 };
  for (const c of candidates) {
    if (!c?.storageId) { missing += 1; continue; }
    try {
      await mutationWithRetry(api.fileStorage.deleteFile, { storageId: c.storageId });
      purged += 1;
    } catch (err) {
      console.warn(`[convexClient.purgeLPCandidateBlobs] delete blob failed (${c.storageId}): ${err.message}`);
    }
  }
  return { purged, missing };
}

// ─── LP Generation Locks ─────────────────────────────────────────────────────
// Per-project lock that prevents concurrent /generate calls (PEF plan 2026-04-21
// invariant #9). The lock auto-expires after `ttl_ms` and the daily scheduler
// cron purges stale entries.

export async function tryAcquireLPGenerationLock(projectId, ttlMs = 600000, holderLabel = null) {
  return mutationWithRetry(api.lpGenerationLocks.tryAcquire, {
    project_id: projectId,
    ttl_ms: ttlMs,
    holder_label: holderLabel || undefined,
  });
}

export async function releaseLPGenerationLock(projectId) {
  return mutationWithRetry(api.lpGenerationLocks.release, { project_id: projectId });
}

export async function getLPGenerationLock(projectId) {
  return queryWithRetry(api.lpGenerationLocks.get, { project_id: projectId });
}

export async function purgeStaleLPGenerationLocks() {
  return mutationWithRetry(api.lpGenerationLocks.purgeStale, {});
}

export async function getLandingPageVersions(landingPageId) {
  return await cachedQuery('landing_page_versions', api.landingPageVersions.getByLandingPage, { landingPageId });
}

export async function createLandingPageVersion({ id, landing_page_id, version, copy_sections, source, image_slots, cta_links, html_template, assembled_html }) {
  await mutationWithRetry(api.landingPageVersions.create, {
    externalId: id,
    landing_page_id,
    version,
    copy_sections,
    source,
    image_slots: image_slots || undefined,
    cta_links: cta_links || undefined,
    html_template: html_template || undefined,
    assembled_html: assembled_html || undefined,
  });
}

export async function getLandingPageVersion(externalId) {
  return await cachedQuery('landing_page_versions', api.landingPageVersions.getByExternalId, { externalId });
}

// =============================================
// LP Template helpers
// =============================================

function convexLPTemplateToRow(t) {
  return {
    id: t.externalId,
    project_id: t.project_id || null,
    source_url: t.source_url || null,
    name: t.name || null,
    skeleton_html: t.skeleton_html || null,
    design_brief: t.design_brief || null,
    slot_definitions: t.slot_definitions || null,
    screenshot_storage_id: t.screenshot_storage_id || null,
    status: t.status || null,
    error_message: t.error_message || null,
    created_at: t.created_at || null,
  };
}

export async function getLPTemplatesByProject(projectId) {
  const templates = ensureArray(await cachedQuery('lp_templates', api.lpTemplates.getByProject, { projectId }), 'convexClient.getLPTemplatesByProject');
  return templates.map(convexLPTemplateToRow);
}

export async function getLPTemplate(externalId) {
  const t = await cachedQuery('lp_templates', api.lpTemplates.getByExternalId, { externalId });
  if (!t) return null;
  return convexLPTemplateToRow(t);
}

export async function createLPTemplate({ id, project_id, source_url, name, skeleton_html, design_brief, slot_definitions, screenshot_storage_id, status }) {
  await mutationWithRetry(api.lpTemplates.create, {
    externalId: id,
    project_id,
    source_url,
    name,
    skeleton_html,
    design_brief,
    slot_definitions,
    screenshot_storage_id: screenshot_storage_id || undefined,
    status: status || 'extracting',
  });
}

export async function updateLPTemplate(externalId, fields) {
  const allowed = ['name', 'skeleton_html', 'design_brief', 'slot_definitions', 'screenshot_storage_id', 'status', 'error_message'];
  const filtered = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) filtered[key] = fields[key];
  }
  await mutationWithRetry(api.lpTemplates.update, { externalId, ...filtered });
}

export async function deleteLPTemplate(externalId) {
  await mutationWithRetry(api.lpTemplates.remove, { externalId });
}

// =============================================
// Sales Page helpers
// =============================================

function convexSalesPageToRow(raw) {
  return {
    id: raw.externalId,
    project_id: raw.project_id || null,
    name: raw.name || null,
    status: raw.status || null,
    product_brief: raw.product_brief || null,
    section_data: raw.section_data || null,
    editorial_notes: raw.editorial_notes || null,
    published_url: raw.published_url || null,
    published_at: raw.published_at || null,
    shopify_page_id: raw.shopify_page_id || null,
    shopify_theme_id: raw.shopify_theme_id || null,
    template_key: raw.template_key || null,
    current_version: raw.current_version ?? null,
    error_message: raw.error_message || null,
    generation_model: raw.generation_model || null,
    created_at: raw.created_at || null,
    updated_at: raw.updated_at || null,
  };
}

export async function getSalesPagesByProject(projectId) {
  const pages = ensureArray(await cachedQuery('sales_pages', api.salesPages.getByProject, { projectId }), 'convexClient.getSalesPagesByProject');
  return pages.map(convexSalesPageToRow);
}

export async function getSalesPage(externalId) {
  const page = await cachedQuery('sales_pages', api.salesPages.getByExternalId, { externalId });
  if (!page) return null;
  return convexSalesPageToRow(page);
}

export async function createSalesPage({ id, project_id, name, status, product_brief, generation_model }) {
  await mutationWithRetry(api.salesPages.create, {
    externalId: id,
    project_id,
    name,
    status: status || 'draft',
    product_brief: product_brief || undefined,
    generation_model: generation_model || undefined,
  });
  invalidateQueryCache('sales_pages');
}

const SALES_PAGE_UPDATE_WHITELIST = [
  'name', 'status', 'product_brief', 'section_data', 'editorial_notes',
  'published_url', 'published_at', 'shopify_page_id', 'shopify_theme_id',
  'template_key', 'current_version', 'error_message', 'generation_model',
];

export async function updateSalesPage(externalId, fields) {
  const filtered = {};
  for (const key of SALES_PAGE_UPDATE_WHITELIST) {
    if (fields[key] !== undefined) filtered[key] = fields[key];
  }
  if (Object.keys(filtered).length === 0) return;
  await mutationWithRetry(api.salesPages.update, { externalId, ...filtered });
  invalidateQueryCache('sales_pages');
}

export async function deleteSalesPage(externalId) {
  await mutationWithRetry(api.salesPages.remove, { externalId });
  invalidateQueryCache('sales_pages');
}

export async function createSalesPageVersion({ id, sales_page_id, version, section_data, source }) {
  await mutationWithRetry(api.salesPageVersions.create, {
    externalId: id,
    sales_page_id,
    version,
    section_data: section_data || undefined,
    source,
  });
}

export async function getSalesPageVersions(salesPageId) {
  return await cachedQuery('sales_page_versions', api.salesPageVersions.getBySalesPage, { salesPageId });
}

// =============================================
// User helpers
// =============================================

export async function getUserByUsername(username) {
  return await queryWithRetry(api.users.getByUsername, { username });
}

export async function getUserByExternalId(externalId) {
  return await queryWithRetry(api.users.getByExternalId, { externalId });
}

export async function getAllUsers() {
  return await queryWithRetry(api.users.getAll, {});
}

export async function getUserCount() {
  return await queryWithRetry(api.users.count, {});
}

export async function createUser({ externalId, username, display_name, password_hash, role, is_active, created_by }) {
  await mutationWithRetry(api.users.create, {
    externalId,
    username,
    display_name,
    password_hash,
    role,
    is_active: is_active !== false,
    created_by: created_by || undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

export async function updateUser(externalId, updates) {
  await mutationWithRetry(api.users.update, {
    externalId,
    ...updates,
    updated_at: new Date().toISOString(),
  });
}

export async function updateUserPassword(externalId, password_hash) {
  await mutationWithRetry(api.users.updatePassword, {
    externalId,
    password_hash,
    updated_at: new Date().toISOString(),
  });
}

export async function deleteUser(externalId) {
  await mutationWithRetry(api.users.remove, { externalId });
}

// =============================================
// Session store helpers (for ConvexSessionStore)
// =============================================

export async function getSession(sid) {
  return await queryWithRetry(api.sessions.get, { sid });
}

export async function setSession(sid, sessionData, expiresAt) {
  await mutationWithRetry(api.sessions.set, {
    sid,
    session_data: sessionData,
    expires_at: expiresAt,
  });
}

export async function destroySession(sid) {
  await mutationWithRetry(api.sessions.destroy, { sid });
}

export async function cleanupExpiredSessions() {
  return await mutationWithRetry(api.sessions.cleanupExpired, {});
}

// =============================================
// Conductor Config helpers (Dacia Creative Director)
// =============================================

export async function getConductorConfig(projectId) {
  return await cachedQuery('conductor', api.conductor.getConfig, { projectId });
}

export async function upsertConductorConfig(projectId, fields) {
  await mutationWithRetry(api.conductor.upsertConfig, { project_id: projectId, ...fields });
  invalidateQueryCache('conductor');
}

export async function getAllConductorConfigs() {
  return await cachedQuery('conductor', api.conductor.getAllConfigs, {});
}

// =============================================
// Auto-Post Log helpers
// =============================================

export async function createAutoPostLog(entry) {
  await mutationWithRetry(api.conductor.createAutoPostLog, entry);
}

export async function getAutoPostLogs(projectId, limit = 50) {
  return await cachedQuery('auto_post_log', api.conductor.getAutoPostLogsByProject, { projectId, limit });
}

// =============================================
// Reconciliation Log helpers
// =============================================

export async function createReconciliationLog(entry) {
  await mutationWithRetry(api.conductor.createReconciliationLog, entry);
}

export async function getReconciliationLogs(projectId) {
  return await cachedQuery('reconciliation_log', api.conductor.getReconciliationLogsByProject, { projectId });
}

// =============================================
// LP Agent Config helpers (Landing Page Agent)
// =============================================

export async function getLPAgentConfig(projectId) {
  const config = await cachedQuery('lp_agent_config', api.lpAgentConfig.getByProject, { projectId });
  // Listicle-only post-Mark-SOP refactor: coerce legacy default_narrative_frames
  // values (e.g. ["testimonial","listicle"]) down to listicle at read-time so
  // downstream selection code never sees a retired frame. Paired with the
  // defensive clamp in runGauntlet for belt-and-suspenders.
  if (config && typeof config.default_narrative_frames === 'string' && config.default_narrative_frames.length > 0) {
    try {
      const parsed = JSON.parse(config.default_narrative_frames);
      if (Array.isArray(parsed)) {
        const coerced = parsed.filter((id) => id === 'listicle');
        const nextValue = coerced.length > 0 ? coerced : ['listicle'];
        const nextJSON = JSON.stringify(nextValue);
        if (nextJSON !== config.default_narrative_frames) {
          config.default_narrative_frames = nextJSON;
        }
      }
    } catch {
      // Malformed JSON in config — leave untouched so a migration or UI save can heal it.
    }
  }
  return config;
}

export async function upsertLPAgentConfig(projectId, fields) {
  await mutationWithRetry(api.lpAgentConfig.upsertConfig, { project_id: projectId, ...fields });
  invalidateQueryCache('lp_agent_config');
}

export async function getAllLPAgentConfigs() {
  return await cachedQuery('lp_agent_config', api.lpAgentConfig.getAllConfigs, {});
}

// =============================================
// Conductor Angles helpers
// =============================================

export async function getConductorAngles(projectId) {
  return ensureArray(await cachedQuery('conductor', api.conductor.getAngles, { projectId }), 'convexClient.getConductorAngles');
}

export async function getActiveConductorAngles(projectId) {
  return ensureArray(await cachedQuery('conductor', api.conductor.getActiveAngles, { projectId }), 'convexClient.getActiveConductorAngles');
}

export async function getSystemDefaultAngle(projectId) {
  return await queryWithRetry(api.conductor.getSystemDefaultAngle, { projectId });
}

export async function createConductorAngle({ id, project_id, name, description, prompt_hints, source, status,
  priority, frame, core_buyer, symptom_pattern, failed_solutions, current_belief,
  objection, emotional_state, scene, desired_belief_shift, tone, avoid_list, tags, is_system_default }) {
  await mutationWithRetry(api.conductor.createAngle, {
    externalId: id,
    project_id,
    name,
    description,
    prompt_hints: prompt_hints || undefined,
    source: source || 'manual',
    status: status || 'active',
    priority: priority || undefined,
    frame: frame || undefined,
    core_buyer: core_buyer || undefined,
    symptom_pattern: symptom_pattern || undefined,
    failed_solutions: failed_solutions || undefined,
    current_belief: current_belief || undefined,
    objection: objection || undefined,
    emotional_state: emotional_state || undefined,
    scene: scene || undefined,
    desired_belief_shift: desired_belief_shift || undefined,
    tone: tone || undefined,
    avoid_list: avoid_list || undefined,
    tags: Array.isArray(tags) ? tags : undefined,
    is_system_default: is_system_default || undefined,
  });
  invalidateQueryCache('conductor');
}

export async function seedDirectOfferAngle({ id, project_id, name, description, prompt_hints, status,
  priority, frame, core_buyer, symptom_pattern, failed_solutions, current_belief,
  objection, emotional_state, scene, desired_belief_shift, tone, avoid_list, tags }) {
  const result = await mutationWithRetry(api.conductor.seedDirectOfferAngle, {
    externalId: id,
    project_id,
    name,
    description,
    prompt_hints: prompt_hints || undefined,
    status: status || 'active',
    priority: priority || 'medium',
    frame: frame || undefined,
    core_buyer: core_buyer || undefined,
    symptom_pattern: symptom_pattern || undefined,
    failed_solutions: failed_solutions || undefined,
    current_belief: current_belief || undefined,
    objection: objection || undefined,
    emotional_state: emotional_state || undefined,
    scene: scene || undefined,
    desired_belief_shift: desired_belief_shift || undefined,
    tone: tone || undefined,
    avoid_list: avoid_list || undefined,
    tags: Array.isArray(tags) ? tags : undefined,
  });
  invalidateQueryCache('conductor');
  return result;
}

export async function updateConductorAngle(id, fields) {
  await mutationWithRetry(api.conductor.updateAngle, { externalId: id, ...fields });
  invalidateQueryCache('conductor');
}

export async function deleteConductorAngle(id) {
  await mutationWithRetry(api.conductor.deleteAngle, { externalId: id });
  invalidateQueryCache('conductor');
}

// =============================================
// Conductor Runs helpers (audit log)
// =============================================

export async function getConductorRuns(projectId, limit = 50) {
  return ensureArray(await cachedQuery('conductor', api.conductor.getRuns, { projectId, limit }), 'convexClient.getConductorRuns');
}

export async function getConductorTestQueue(projectId, limit = 50) {
  return ensureArray(await queryWithRetry(api.conductor.getTestRunQueue, { projectId, limit }), 'convexClient.getConductorTestQueue');
}

export async function createConductorRun(fields) {
  await mutationWithRetry(api.conductor.createRun, fields);
  invalidateQueryCache('conductor');
}

export async function enqueueConductorTestRun(fields) {
  const result = await mutationWithRetry(api.conductor.enqueueTestRun, fields);
  invalidateQueryCache('conductor');
  return result;
}

export async function claimQueuedConductorTestRun(owner, leaseMs = 4 * 60 * 1000) {
  const now = new Date();
  const result = await mutationWithRetry(api.conductor.claimQueuedTestRun, {
    owner,
    now: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
  });
  invalidateQueryCache('conductor');
  return result;
}

export async function releaseQueuedConductorTestRun(id, owner) {
  const result = await mutationWithRetry(api.conductor.releaseQueuedTestRun, { externalId: id, owner });
  invalidateQueryCache('conductor');
  return result;
}

export async function cancelQueuedConductorTestRun(id) {
  const result = await mutationWithRetry(api.conductor.cancelQueuedTestRun, {
    externalId: id,
    now: new Date().toISOString(),
  });
  invalidateQueryCache('conductor');
  return result;
}

const ALLOWED_CONDUCTOR_RUN_UPDATE_FIELDS = [
  'status',
  'error',
  'batches_created',
  'angles_generated',
  'decisions',
  'duration_ms',
  'posting_days',
  'terminal_status',
  'failure_reason',
  'required_passes',
  'ads_per_round',
  'template_tag',
  'max_rounds',
  'total_rounds',
  'total_ads_generated',
  'total_ads_scored',
  'total_ads_passed',
  'ready_to_post_count',
  'flex_ad_id',
  'rounds_json',
  'error_stage',
  'scoring_started_at',
  'last_heartbeat_at',
  'queue_position',
  'queued_at',
  'started_at',
  'queued_angle_id',
  'worker_lease_owner',
  'worker_lease_expires_at',
];

export async function updateConductorRun(id, fields) {
  const updates = {};
  for (const field of ALLOWED_CONDUCTOR_RUN_UPDATE_FIELDS) {
    if (fields[field] !== undefined) updates[field] = fields[field];
  }
  await mutationWithRetry(api.conductor.updateRun, { externalId: id, ...updates });
  invalidateQueryCache('conductor');
}

function convexConductorSlotToRow(slot) {
  return {
    id: slot.externalId,
    project_id: slot.project_id,
    posting_day: slot.posting_day,
    slot_index: slot.slot_index,
    angle_name: slot.angle_name,
    angle_external_id: slot.angle_external_id || null,
    status: slot.status,
    batch_ids: slot.batch_ids || null,
    attempt_count: slot.attempt_count || 0,
    last_attempt_at: slot.last_attempt_at || null,
    produced_flex_ad_id: slot.produced_flex_ad_id || null,
    failure_reason: slot.failure_reason || null,
    diagnostics_summary: slot.diagnostics_summary || null,
    created_at: slot.created_at,
    updated_at: slot.updated_at,
  };
}

export async function getConductorSlots(projectId) {
  const slots = await cachedQuery('conductor_slots', api.conductor.getSlotsByProject, { projectId });
  return ensureArray(slots, 'convexClient.getConductorSlots').map(convexConductorSlotToRow);
}

export async function getConductorSlotsByPostingDay(projectId, postingDay) {
  const slots = await cachedQuery('conductor_slots', api.conductor.getSlotsByPostingDay, { projectId, postingDay });
  return ensureArray(slots, 'convexClient.getConductorSlotsByPostingDay').map(convexConductorSlotToRow);
}

export async function createConductorSlot(fields) {
  await mutationWithRetry(api.conductor.createSlot, fields);
  invalidateQueryCache('conductor_slots');
}

export async function updateConductorSlot(externalId, fields) {
  await mutationWithRetry(api.conductor.updateSlot, { externalId, ...fields });
  invalidateQueryCache('conductor_slots');
}

// =============================================
// Conductor Playbooks helpers (per-angle learning)
// =============================================

export async function getConductorPlaybooks(projectId) {
  return ensureArray(await cachedQuery('conductor', api.conductor.getPlaybooks, { projectId }), 'convexClient.getConductorPlaybooks');
}

export async function getConductorPlaybook(projectId, angleName) {
  return await cachedQuery('conductor', api.conductor.getPlaybook, { projectId, angleName });
}

export async function upsertConductorPlaybook(fields) {
  await mutationWithRetry(api.conductor.upsertPlaybook, fields);
  invalidateQueryCache('conductor');
}

// =============================================
// CMO Agent helpers (Ad Performance Management)
// =============================================

export async function getCmoConfig(projectId) {
  return await cachedQuery('cmo', api.cmo.getConfig, { projectId });
}

export async function upsertCmoConfig(projectId, fields) {
  await mutationWithRetry(api.cmo.upsertConfig, { project_id: projectId, ...fields });
  invalidateQueryCache('cmo');
}

export async function getAllCmoConfigs() {
  return await cachedQuery('cmo', api.cmo.getAllConfigs, {});
}

export async function getCmoRuns(projectId, limit = 50) {
  return ensureArray(await cachedQuery('cmo', api.cmo.getRuns, { projectId, limit }), 'convexClient.getCmoRuns');
}

export async function getCmoRun(externalId) {
  return await queryWithRetry(api.cmo.getRun, { externalId });
}

export async function createCmoRun(fields) {
  await mutationWithRetry(api.cmo.createRun, fields);
  invalidateQueryCache('cmo');
}

export async function updateCmoRun(id, fields) {
  await mutationWithRetry(api.cmo.updateRun, { externalId: id, ...fields });
  invalidateQueryCache('cmo');
}

export async function getCmoAngleHistory(projectId, limit = 500) {
  return ensureArray(await cachedQuery('cmo', api.cmo.getAngleHistory, { projectId, limit }), 'convexClient.getCmoAngleHistory');
}

export async function getCmoAngleHistoryByAngle(projectId, angleName) {
  return ensureArray(await queryWithRetry(api.cmo.getAngleHistoryByAngle, { projectId, angleName }), 'convexClient.getCmoAngleHistoryByAngle');
}

export async function getCmoAngleHistoryByRun(cmoRunId) {
  return ensureArray(await queryWithRetry(api.cmo.getAngleHistoryByRun, { cmoRunId }), 'convexClient.getCmoAngleHistoryByRun');
}

export async function createCmoAngleHistory(fields) {
  await mutationWithRetry(api.cmo.createAngleHistory, fields);
  invalidateQueryCache('cmo');
}

export async function getCmoNotifications(projectId, limit = 100) {
  return ensureArray(await cachedQuery('cmo', api.cmo.getNotifications, { projectId, limit }), 'convexClient.getCmoNotifications');
}

export async function getCmoNotificationsByRun(projectId, cmoRunId) {
  return ensureArray(await queryWithRetry(api.cmo.getNotificationsByRun, { projectId, cmoRunId }), 'convexClient.getCmoNotificationsByRun');
}

export async function createCmoNotification(fields) {
  await mutationWithRetry(api.cmo.createNotification, fields);
  invalidateQueryCache('cmo');
}

export async function acknowledgeCmoNotification(externalId) {
  await mutationWithRetry(api.cmo.acknowledgeNotification, { externalId });
  invalidateQueryCache('cmo');
}

export async function acknowledgeAllCmoNotifications(projectId) {
  await mutationWithRetry(api.cmo.acknowledgeAllNotifications, { projectId });
  invalidateQueryCache('cmo');
}

// =============================================
// Direct Convex client access (for advanced use cases)
// =============================================

export { client as convexClient, api };

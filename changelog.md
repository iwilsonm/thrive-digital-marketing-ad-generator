# ThriveCampaigns — Changelog

## 2026-05-06 — OpenAI and Anthropic quota error parity

- OpenAI and Anthropic wrappers now distinguish billing/account-state quota failures from transient rate limits, mirroring the Gemini zero-quota behavior.

## 2026-05-06 — Remove GPT Image 2

- Removed the GPT Image 2 / OpenAI image-generation path, including the Settings test, AdStudio model option, backend route/service/tests, provider routing, and `openai_image_rate_per_image` setting.

## 2026-05-06 — Manual-only foundational research

- Removed API-based auto deep research from foundational documents. Manual research prompts, research upload, direct document upload, and downstream synthesis from uploaded research remain available.

## 2026-05-06 — Clarify Gemini zero-quota image errors

- Gemini wrapper now surfaces a clearer error when Google returns limit: 0 / free_tier quota (billing/account state is the real cause), distinct from transient rate limits.

## 2026-05-06 — ThriveCampaigns brand asset

- Logos replaced with actual ThriveCampaigns brand PNG (green logomark + black wordmark on transparent). User-visible brand string flipped to one-word "ThriveCampaigns" to match the asset. Internal slugs unchanged.

## 2026-05-06 — Settings tests persist successful API keys

- OpenAI, Gemini, and OpenAI Image Settings tests now save a pasted key after a successful test, matching the existing Anthropic pattern.
- The test buttons still fall back to testing previously saved keys when the input field is empty.

## 2026-05-06 — Restore Vercel cron secret

- Restored `CRON_SECRET` in Vercel production with a newly generated 64-character hex secret so Vercel Cron routes can authenticate.
- Documented missing production cron-path env gaps separately from the env-only fix.

## 2026-05-06 — Stabilize Vercel Convex binding

- Replaced the blank Vercel production `CONVEX_URL` project env value with the dedicated Thrive Convex deployment URL.
- Verified no checked-in Vercel env block or deploy script is rewriting `CONVEX_URL`; the live binding is now validated across consecutive production deploys.

## 2026-05-06 — Settings API key test routes accept pasted keys

- Settings test routes (openai/gemini/openai-image/test-model) accept `api_key` in the request body, matching the Anthropic pattern.
- Fixes "key not configured" false positives caused by per-instance settings cache staleness on serverless.

## 2026-05-06 — Drop manual research PDF attachment guidance

- Drop PDF-attachment guidance from manual research walkthrough Step 1; product description is now in the prompt body itself.
- Removed the Step 1 tip and alert fields so the frontend no longer shows the obsolete amber warning block.

## 2026-05-06 — Restore project sales_page_content persistence

- Restore `sales_page_content` persistence on projects table — fixes deep research input gap. Schema + mapper + whitelist + POST handler updated. Convex prod deployed.
- Added `sales_page_content` back to the Convex `projects` table as an optional string and allowed it through project create/update paths.
- Returned `sales_page_content` from the backend project mapper so document generation can receive the user's detailed product/offering description.

## 2026-05-06 — ProjectSetup product input simplified

- ProjectSetup product input switched from PDF/paste sales page to free-form product description textarea; prompt1 intro updated; downstream pipeline unchanged.
- Kept the internal `sales_page_content` form key and `salesPageContent` prompt variable names unchanged so existing backend contracts keep working.
- Left `DragDropUpload` intact for Foundational Docs research/document upload flows.

## 2026-05-06 — Thrive Campaigns rebrand

- Thrive Campaigns rebrand — green color theme, sidebar/login logos, user-visible wordmark; internal slugs unchanged.
- Replaced customer-facing Thrive Digital Marketing brand copy with Thrive Campaigns in the app shell, login, settings, Meta connection copy, analytics labels, HTML title, and README.
- Added new black/currentColor SVG assets for the sidebar mark, full sidebar/login wordmark, and SVG favicon.
- Remapped the editorial color tokens and legacy Tailwind brand aliases from the prior navy/gold/rust theme to a green/neutral palette while preserving the existing layout and component structure.

## 2026-05-06 — Thrive Convex Deployment Cutover + Identity Cleanup

- Provisioned a new dedicated Thrive Digital Marketing Convex project and deployed the current schema/functions to its dev and production deployments.
- Rebound local Convex env files to `https://impartial-shrimp-656.convex.cloud` / `dev:impartial-shrimp-656`.
- Documented the Vercel production target as `https://cheery-cobra-258.convex.cloud` / `prod:cheery-cobra-258`.
- Updated product identity from the source-product naming to Thrive Digital Marketing across package metadata, Convex system capabilities, health response, UI copy, docs, README, and local env comments.
- Verified the new Thrive Convex deployment is empty across all schema tables and Convex file storage.
- Completed Vercel production env cutover using the provided token: added `CONVEX_URL` for the new Thrive production Convex deployment, redeployed production, and reassigned `https://thrive-digital-marketing-ad-generat.vercel.app` to deployment `https://thrive-digital-marketing-ad-generat-ddnxndze3.vercel.app` at 2026-05-06 14:59 ICT.
- Confirmed live `/login` starts from a clean setup state and live `/api/health` reports the new Thrive production Convex host. Creative Factory-side cleanup remains out of scope and is handled separately by Ian via the Convex dashboard.

## 2026-05-06 — Add reversible project archive flow

**Feature**
- Added the ability to remove a project from the All Projects page without destroying its data.
- The user-facing "Delete" action now opens a centered confirmation dialog that asks: "Are you sure you want to delete this project?"
- Confirming moves the project into an **Archived Projects** view where it can be restored with **Unarchive**.

**Cause**
- The app previously exposed a project delete path that hard-deleted the project row. That conflicted with the current product requirement: deleted projects should remain recoverable and keep their child ads, batches, foundational documents, templates, and other project-scoped data.

**Fix**
- Added `projects.archived_at` as an optional ISO timestamp. `null` / unset means active; a timestamp means archived.
- Default project list and project options now return only active projects.
- Added a separate archived-project query and API route sorted by `archived_at` descending.
- Added reversible archive/unarchive helpers and endpoints:
  - `PATCH /api/projects/:id/archive`
  - `PATCH /api/projects/:id/unarchive`
- Converted the existing `DELETE /api/projects/:id` route to soft-archive semantics for compatibility; it no longer hard-deletes.
- Updated All Projects UI with:
  - active/archived view toggle,
  - delete/archive action on active cards,
  - portal-based confirmation dialog,
  - unarchive action on archived cards.
- Updated Project Detail delete copy to archive semantics so it no longer claims permanent deletion.
- Added route tests covering active vs archived lists, archive/unarchive round-trip behavior, and the legacy delete route mapping to archive without touching child data.

**Files modified**
- `convex/schema.ts`
- `convex/projects.ts`
- `backend/convexClient.js`
- `backend/routes/projects.js`
- `backend/__tests__/projectArchive.test.js`
- `frontend/src/api.js`
- `frontend/src/pages/Projects.jsx`
- `frontend/src/pages/ProjectDetail.jsx`

**Out of scope**
- Hard delete / permanent destruction.
- Bulk project archive.
- Auto-purge after N days.
- Archiving child records directly.
- Changing project detail access rules for already-archived projects.
- Touching legacy LP / quote-mining / Shopify publishing layers.

**Risk + rollback**
- Risk: archived projects could disappear from active project pickers that previously listed every project. This is intentional for default active views; archived projects remain recoverable from the new Archived Projects view.
- Risk: older automation helpers that used the all-project list now skip archived projects. This matches the archive semantics and prevents hidden projects from being processed.
- Rollback: revert this entry's code changes and redeploy Convex + Vercel. Existing `archived_at` timestamps are optional and can remain harmlessly on project rows.

---

## 2026-05-06 — Add per-attempt Gemini timeouts and image attempt diagnostics

**Bug**
- Single-ad generations could still get stuck even after the Vercel `maxDuration` bump from 300s to 800s.
- The reproduced production pattern was: Gemini Nano Banana 2 attempts 1 and 2 failed quickly with `fetch failed`, then a later synchronous `ai.models.generateContent` call hung silently until Vercel killed the function.
- Mode 2 was audited and confirmed not to be using the Gemini Batch API; Mode 1 and Mode 2 both route through the same synchronous Gemini wrapper.

**Cause**
- `backend/services/gemini.js#generateImage` used retry logic around `ai.models.generateContent`, but each attempt had no per-attempt timeout or abort signal.
- A single hung Google Gen AI SDK request could consume the entire serverless window before the retry wrapper regained control.
- The previous observability fields (`updated_at`, `completed_at`, `last_progress_at`) showed when the ad died, but not which image attempt hung or how long each attempt ran.

**Fix**
- Added a 90-second `AbortController` timeout inside `generateImage()` for each synchronous Gemini image attempt.
- Reduced the synchronous Gemini image path to 2 total attempts, preserving retry behavior for transient `fetch failed`, timeout, 429, and 5xx-style errors without giving a hung provider call a third chance to consume the whole function window.
- Added `image_attempts` to `ad_creatives` as a JSON-stringified array containing `{ attempt_number, started_at, ended_at, duration_ms, error_class, error_message }`.
- Propagated `image_attempts` through Convex create/update args, backend row mappers, successful single-ad writes, failed single-ad writes, Mode 2 failures, and image-regeneration failures.
- Added tests for:
  - passing an `AbortSignal` into the synchronous Gemini SDK call,
  - retrying once after a 90-second timeout,
  - failing cleanly after two timed-out attempts with diagnostics attached,
  - persisting image attempts on success and failure,
  - keeping Mode 2 on the synchronous Gemini wrapper and away from batch-job helpers.

**Files modified**
- `convex/schema.ts`
- `convex/adCreatives.ts`
- `backend/convexClient.js`
- `backend/services/gemini.js`
- `backend/services/adGenerator.js`
- `backend/__tests__/geminiTimeout.test.js`
- `backend/__tests__/adGeneratorOpenAI.test.js`

**Out of scope**
- Changing the Gemini Batch API path used by `batchProcessor.js`; batch remains async by design.
- Hardening OpenAI image calls with per-attempt aborts.
- Changing the 10-minute stale-generation sweeper threshold.
- Refactoring single-ad generation into a durable worker queue.
- Changing Nano Banana prompt structure, model choice, or template/image selection behavior.

**Risk + rollback**
- Risk: 90 seconds may be too strict if Gemini synchronous image latency regresses. Mitigation: every timeout is now logged distinctly in `image_attempts`, so the threshold can be adjusted with real data instead of inference.
- Risk: reducing attempts from the prior retry setting can surface failures sooner during provider turbulence. Mitigation: two attempts still cover transient blips while preventing the recurring full-window hang.
- Rollback: revert this entry's code changes and redeploy Convex + Vercel. Existing `image_attempts` values are optional diagnostic strings and can remain safely on old rows.

---

## 2026-05-06 — Raise single-ad timeout ceiling and add exact ad completion timestamps

**Diagnostic findings**
- Today's single-ad failure rate was materially higher than the 30-day baseline: 7 failed / 15 total single ads in the last 24 hours (46.7%) versus 12 failed / 75 total over 30 days (16.0%).
- The spike was not one single cause: 4 failures were `No templates available`, 2 were image-generation timeout messages, and 1 was `[STALE-RECOVERY]` after the live request stopped heartbeating.
- All last-24-hour single-ad rows used `nano-banana-2`; failures clustered in Mode 1 and in newer/test projects with template-library setup issues.
- `api_costs` records cost/image counts only, not provider error rates or latency, so it could not prove a Gemini outage. It did show 8 Gemini image generations logged today and no separate error telemetry.

**Cause**
- The previous 300-second Vercel ceiling was too close to real successful single-ad latency. One observed Mode 1 success finished at 290.6s, and one observed Mode 2 success had a 672.1s completion proxy.
- Future latency analysis was imprecise because `ad_creatives` stored `created_at` and `last_progress_at`, but not canonical `updated_at` or `completed_at`; 46 of 63 completed single-ad records in the 30-day measurement window had no usable completion timestamp.

**Fix**
- Increased `api/index.js` `maxDuration` from 300s to 800s in `vercel.json` for the Vercel Pro / Fluid Compute path.
- Added `updated_at` and `completed_at` to `ad_creatives`.
- Centralized timestamp writes in Convex `adCreatives.create` / `adCreatives.update`: every create/update gets `updated_at`, and terminal statuses (`completed`, `failed`, `quality_rejected`, `cancelled`, `canceled`) get `completed_at`.
- Added timestamp propagation through `convexAdToRow` / `convexAdSummaryToRow`, Ad Studio display, single-ad success/failure writes, batch-created completed ad rows, stale recovery helpers, and the global generation sweeper.

**Files modified**
- `vercel.json`
- `convex/schema.ts`
- `convex/adCreatives.ts`
- `backend/convexClient.js`
- `backend/routes/ads.js`
- `backend/services/adGenerator.js`
- `backend/services/batchProcessor.js`
- `backend/services/generationSweeper.js`
- `backend/utils/adGenerationRecovery.js`
- `backend/__tests__/adGenerationRecovery.test.js`
- `backend/__tests__/adGeneratorOpenAI.test.js`
- `backend/__tests__/generationSweeper.test.js`
- `frontend/src/components/AdStudio.jsx`

**Out of scope**
- Backfilling `updated_at` / `completed_at` onto historical ad records.
- Refactoring single-ad generation into a durable worker queue.
- Changing the 10-minute heartbeat-based generation sweeper threshold.
- Changing image model selection.
- Touching legacy LP / quote-mining / Shopify publishing layers.

**Risk + rollback**
- Risk: 800s can use more function time for legitimately slow requests. Mitigation: the sweeper still fails non-heartbeating records after the existing 10-minute idle threshold, so dead ads do not silently wait for the full ceiling.
- Risk: timestamp fields may expose sparse values on old rows. Mitigation: UI falls back to `created_at`, and no backfill is required.
- Rollback: revert the timeout and timestamp commit. Existing rows with `completed_at` / `updated_at` are harmless optional fields.

---

## 2026-05-06 — Add global stuck-generation sweeper and queue watchdog

**Bug**
- Ad Studio single-ad generations could still appear stuck in the queue when a Vercel request died mid-generation or the SSE stream ended before a terminal event reached the browser.
- Prior fixes marked stale ads only when the user later loaded Ad Studio for that same project, so recovery depended on page traffic and did not cover batches or Creative Director runs.

**Cause**
- Vercel serverless functions have a 300-second max duration. If a single generation was killed while waiting on GPT/Gemini, the request could stop before writing `status='completed'` or `status='failed'`.
- Existing cleanup lived behind project-specific Ad Studio endpoints (`GET /ads`, `GET /ads/in-progress`) instead of a global production sweeper.
- There was no `/api/health` signal proving stale-generation recovery was running successfully.

**Fix**
- Added a global generation sweeper that scans:
  - `ad_creatives` active statuses using `last_progress_at || created_at`,
  - `batch_jobs` active statuses using `last_heartbeat_at || started_at || queued_at || created_at`,
  - `conductor_runs` active statuses using `scoring_started_at || run_at || created_at`.
- The sweeper marks records with no heartbeat for 10+ minutes as `failed` with a `[STALE]` message explaining the timeout/worker/stream failure pattern.
- Added `/api/cron/generation-sweeper`, wired to Vercel Cron every 5 minutes.
- Added `/api/health/sweeper`, which reports the last successful sweep and fails loud if the sweeper has not succeeded in over 1 hour.
- Added 30-second single-ad heartbeats while Mode 1, Mode 2, and image-only regeneration are running so long in-flight requests are not falsely swept.
- Added an Ad Studio queue watchdog that shows a clear “Generation may have failed” message if no progress arrives for over 10 minutes.

**Files modified**
- `convex/conductor.ts`
- `backend/services/generationSweeper.js`
- `backend/services/adGenerator.js`
- `backend/routes/cron.js`
- `backend/server.js`
- `backend/__tests__/generationSweeper.test.js`
- `frontend/src/components/AdStudio.jsx`
- `vercel.json`

**Out of scope**
- Replacing single-ad generation with a durable external job queue.
- Changing batch generation architecture beyond stale recovery.
- Fixing the known `conductorLearning.js` `messages.filter is not a function` issue.
- Touching legacy LP / quote-mining / Shopify publishing layers.

**Risk + rollback**
- Risk: a legitimate long-running record could be marked failed if it emits no heartbeat for 10 minutes. Mitigation: single-ad flows now heartbeat every 30 seconds, and batch flows already heartbeat through scheduler/polling.
- Risk: Vercel Cron could fail to invoke the route. Mitigation: `/api/health/sweeper` exposes last successful sweep age and returns degraded after 1 hour.
- Rollback: remove the cron entry and revert this entry's code changes. Existing records marked `[STALE]` remain failed but can be retried manually from the UI.

---

## 2026-05-06 — Lock new-project template inheritance to storage-provenance copies

**Bug**
- New projects could still end up with an empty Template Library, causing Ad Studio Mode 2 / random-template generation to fail with: "No templates available. Upload templates in the Template Library first."
- Prior "adopt shared templates" attempts did not persist a project-level seeding status and deduped by template identity instead of storage provenance, so future agents could silently reintroduce empty or duplicated libraries.

**Cause**
- `backend/services/templateAdoption.js` deduped by `source_template_id || externalId`, not the locked source-storage provenance. Once templates were copied between projects, the system could no longer reliably tell which inherited rows represented the same original uploaded blob.
- `projects` had no `template_seeding_status` / `template_seeding_error`, so failures during inheritance were invisible except as downstream empty-library generation errors.

**Fix**
- Added project seeding fields: `template_seeding_status` and `template_seeding_error`.
- Added template provenance field: `source_storage_id`.
- Replaced template adoption with a one-time storage-provenance seeder:
  - snapshots all active stored templates from every other project at seeding start,
  - caps source scan at 5000 rows,
  - dedupes by `source_storage_id || storageId`,
  - downloads each selected source blob and uploads a fresh Convex storage blob for the new project,
  - writes copied template rows with `source_storage_id`, `source_template_id`, and `source_project_id`,
  - updates project seeding status to `in_progress`, then `complete` or `failed`.
- Project creation now goes through `createProjectWithTemplateSeeding()` so the Express route has a single sanctioned creation path.
- Template Library now shows a seeding status banner and retry button when inheritance is pending/in-progress/failed.

**Files modified**
- `convex/schema.ts`
- `convex/projects.ts`
- `convex/templateImages.ts`
- `backend/convexClient.js`
- `backend/routes/projects.js`
- `backend/routes/templates.js`
- `backend/services/projectCreation.js`
- `backend/services/templateAdoption.js`
- `backend/__tests__/templateAdoption.test.js`
- `frontend/src/api.js`
- `frontend/src/components/TemplateImages.jsx`

**Out of scope**
- Perceptual/image hashing for near-duplicate templates.
- Pagination beyond the 5000 source-row cap.
- Lazy/background seeding outside the project creation request.
- Migrating every historical copied template row to backfill `source_storage_id`; retry/seeding logic can infer provenance from old `source_template_id` where the source row still exists.

**Risk + rollback**
- Risk: project creation now does more storage work inside the request. The locked requirement explicitly chose eager full-copy at creation time; the 5000-row cap limits runaway work.
- Risk: if a source template's storage blob is already missing, that one copy fails and the project remains usable with `template_seeding_status='failed'` plus a retry banner.
- Rollback: revert this entry's code changes and redeploy Convex schema/functions + Vercel. Existing copied template rows remain valid because they own their duplicated storage blobs.

---

## 2026-05-01 — Bump Vercel maxDuration to 300s (Pro tier) + clean up orphaned batches

**Problem**
- Marco's Heal Naturally Director test run died at the 60-second Vercel function timeout. `conductorEngine.js:319` does `await runBatch(b.batch_id)`, which means the entire batch pipeline (~2-5 min for 18 ads) tries to complete inside one serverless invocation. On Hobby tier (60s cap), batches get killed mid-Stage-1 (headlines), leaving the batch + run records orphaned forever in `generating_prompts` / `running` states. Two batches (`179e1cff` today, `e2b8efbc-ffa9-4493-a57f-4eeccdda2fbe` yesterday) and one conductor run (`91678eaf-03e0-4243-b315-4355cbc3e647`) were stuck this way.
- Manual single-ad generation (Mode 1/2 in AdStudio) was unaffected because it fits inside 60s. Batches don't.

**Fix**
- Marco upgraded to Vercel Pro (300s default function-timeout cap). `vercel.json#functions[api/index.js].maxDuration` bumped from `60` → `300`. All endpoints inherit the new cap.
- 5 minutes is sufficient headroom for current 18-ad batches (~2-3 min total). 800s is available with Fluid Compute config but unnecessary for current batch sizes; chose 300s for tighter cost-control on metered Pro execution.

**Cleanup mutations**
- Marked the 2 orphaned batches as `failed` with `error_message` prefix `[ARCHITECTURE]` (so future filtering is possible by string-match) explaining the timeout root cause + resolution.
- Marked the orphaned conductor run as `failed` with similar attribution.

**Why 300s, not 800s**
- Conservative blast radius on hung-route bugs: a buggy endpoint stuck in an infinite loop now wastes up to 5 min of compute per request before Vercel kills it (vs 13+ min at 800s). 300s is the lower-cost option that still solves the actual problem.
- Future escalation: if batches grow to 30+ ads or hit external-API slow patches, bump to 800s with Fluid Compute config. Tracked in plan's Out of Scope.

**Out of scope**
- Refactoring `conductorEngine.js:319` from sequential `await` to fire-and-forget. Current pattern works fine within 300s for current batch sizes.
- Adding scheduler-side stalled-batch detection for Stages 1-3. With timeouts now unlikely, the orphan-cleanup tax is near-zero.
- Per-route timeout config (e.g., 60s for auth, 300s for batches). Would require multi-function `vercel.json` setup. Defer.
- Backfilling old ad records' `image_model` field. Same disposition as prior changelog entries.

**Risk + rollback**
- Permission-widening change only (more time allowed, never less). One-line revert on `vercel.json` reverses it. Cleanup mutations are not reversible but the records were already dead — no data lost.

**Files modified**
- `vercel.json` — `maxDuration: 60` → `300`.

**Convex mutations executed (no file change)**
- `batchJobs:updateStatus` × 2 (one per orphaned batch).
- `conductor:updateRun` × 1 (orphaned conductor run).

---

## 2026-05-01 — Switch default image model to Nano Banana 2 (Creative Director + Agent)

**Change**
- Default image model for both ad-generation flows is now `nano-banana-2` (Gemini 3.1 Flash Image Preview), was `nano-banana-pro` (Gemini 3 Pro Image Preview).
- Affects: AdStudio dropdown initial state (manual single-ad gen), and the Director-triggered batch processor (autonomous batch gen).
- Nano Banana Pro stays in the dropdown — users can still pick it manually. Default-only change.

**Why**
- Marco's call: Flash is faster, cheaper, supports up to 4K, and has improved text rendering vs Pro for the kind of structured ad layouts the Creative Director generates. After the dall-e-2 quality-ceiling experience, Marco wants the higher-quality Gemini path as the default for both manual and autonomous ad generation.

**Locations changed**
- `frontend/src/components/AdStudio.jsx:172` — `useState('nano-banana-pro')` → `useState('nano-banana-2')`. Plus dropdown-description "(current default)" annotation moved from Pro to 2.
- `backend/services/adGenerator.js:475, 714, 2071` — three metadata fallbacks switched from legacy label `'gemini-3-pro'` to `'nano-banana-2'`. This also fixes a pre-existing inconsistency: `gemini.js#generateImage` already auto-defaulted to `nano-banana-2` when no model was passed, but these stored-metadata fallbacks recorded `'gemini-3-pro'` (a legacy label not in the current GEMINI_MODELS map). Stored metadata now matches what actually ran.
- `backend/services/batchProcessor.js:738` — Gemini Batch API model string switched from `'gemini-3-pro-image-preview'` to `'gemini-3.1-flash-image-preview'`. This is the actual API model name used in the `ai.batches.create({ model, ... })` call (the batch path bypasses our `gemini.js` wrapper, so this hardcoded string is the only switch).
- `backend/services/batchProcessor.js:957` — stored metadata label switched from `'gemini-3-pro'` to `'nano-banana-2'`.
- `convex/schema.ts:102` — comment example updated. No schema change.

**Out of scope**
- LP Agent (`lpGenerator.js#generateSlotImages`): not changed. Marco's request was about ad generation; LP Agent is a separate subsystem with its own image flow. If LP Agent should also flip, that's a follow-up.
- Removing Nano Banana Pro from the dropdown: kept as a manual option.
- Per-project default model setting: not added. All sessions still start from the global default.
- Backfilling old `image_model` field on existing ad records: not done. Old records keep whatever was stored.
- Removing the legacy `'gemini-3-pro'` entry from `adGenerator.js#GEMINI_MODELS` validation Set: deferred. Harmless legacy whitelist entry; cleanup belongs in a future tidy-up commit.

**Risk + rollback**
- Gemini Batch API support for `gemini-3.1-flash-image-preview` is not explicitly documented as identical to `models.generate_content`. If the next Director batch fails 400 with "unsupported model," revert this commit (single one-line literal swap on `batchProcessor.js:738`).
- All other changes are purely metadata / frontend defaults — those revert with the same single commit.

**Cost note**
- `gemini_rate_*` settings auto-refresh daily. If `gemini_rate_gemini-3.1-flash-image-preview` hasn't yet been pulled, the first day's nano-banana-2 generations may log $0 cost until the next midnight refresh. Cosmetic only — actual API spend is unaffected.

---

## 2026-05-01 — Purpose-build short prompts for dall-e-2 (no more decapitation)

**Problem**
- The previous fixes solved the dall-e-2 byte-limit error by tail-truncating the prompt: keep the last 1000 bytes, drop the head. Marco flagged the right concern: the prompt was engineered for gpt-image-2's larger budget, then sliced — losing the brand/avatar opening. Cohesion suffers; the model sees the back half of a document rather than a complete brief.

**Fix**
- `backend/services/adGenerator.js#buildImageRequestText` now accepts an `imageModel` parameter. When `hasProductImage && imageModel === 'gpt-image-2'` (the dall-e-2 routing condition), Message 2 to GPT-5.2 gets a final extra: "LENGTH LIMIT: ... keep your prompt under 900 bytes ... prioritize: scene, product reference, headline, body copy, angle. Drop or shorten: verbose brand background, avatar psychographics, foundational-doc context."
- GPT-5.2 produces a compact, purpose-built prompt for dall-e-2's budget instead of its usual 2000-3000 byte output. dall-e-2 receives a complete brief sized for its capability.
- Both single-ad callers updated to pass `imageModel` (Mode 1 angle path + Mode 2 template path). Other paths default to `null` (no constraint, no behavior change).

**Why 900 bytes (not 1000)**
- 100-byte safety margin against (a) GPT-5.2 mildly overshooting, (b) multi-byte chars (em-dashes/smart-quotes/accented brand names) inflating UTF-8 byte count beyond JS char count, (c) the optional gpt-4.1-mini guideline review re-inflating the prompt slightly.

**Truncation is now a safety net, not the primary fix**
- The byte-truncation in `backend/services/openai.js#generateImage` (commit 218e867) stays in place. With the upstream constraint, it should rarely or never trigger. If GPT-5.2 ignores the constraint and overshoots 1000 bytes, the truncation still catches it — but the overshoot is bounded much closer to 1000, so head loss is minimized rather than the original 1500+ byte chop.
- Comment in `openai.js` updated to label the block as a safety net and point to the upstream constraint.

**Cost impact**
- Constraint adds ~80 input tokens (~$0.00014 per ad at GPT-5.2's $1.75/M rate). Compact output saves ~400 output tokens (~$0.0056 per ad at $14.00/M output rate). Net savings: ~$0.0055 per dall-e-2 ad. Cheaper, not more expensive.

**Out of scope**
- `reviewPromptWithGuidelines` re-inflation (the gpt-4.1-mini review explicitly says "Do NOT shorten" — could push a tight prompt back over 1000 bytes if the project has guidelines set). Truncation safety net catches it.
- OpenAI Responses API + image_generation tool (would unlock gpt-image-2 quality with reference image, no 1000-byte limit). Bigger refactor; defer.
- dall-e-2 aspect-ratio mapping (256/512/1024 only). Still pending.

**Files modified**
- `backend/services/adGenerator.js` — new `imageModel` param on `buildImageRequestText`, conditional length-limit extra, two caller updates.
- `backend/services/openai.js` — comment-only update labeling the truncation as a safety net.

---

## 2026-05-01 — dall-e-2 truncation: switch from JS chars to UTF-8 bytes

**Bug**
- After the previous fix shipped, Marco hit a follow-up: `400 Invalid 'prompt': string too long. Expected a string with maximum length 1000, but got a string with length 1017 instead.`

**Cause**
- OpenAI's 1000-limit on dall-e-2 is measured in **UTF-8 bytes**, not JS UTF-16 code units. The prior fix used `prompt.length` and `prompt.slice()` — which work on UTF-16 code units. Many prompts contain Latin-1 supplements (é, ñ, ß), em-dashes (—), smart quotes (" "), or emojis. Each costs 2-4 bytes in UTF-8 but 1-2 code units in JS. A "1000 char" prompt by JS counting can be 1017+ bytes when sent over HTTP, blowing OpenAI's limit.
- In Marco's case the prompt was 1017 JS chars but those 17 extra-vs-1000 chars must have been multi-byte (likely em-dashes, since GPT-5.2 loves them in copywriting) — the prompt sailed through `length > 1000` truncation but tipped over OpenAI's byte counter.

**Fix**
- `backend/services/openai.js#generateImage` — measure prompt size with `Buffer.byteLength(prompt, 'utf8')` instead of `.length`. Estimate the cut point by character count (cheap), then refine with a tail-trim loop while byte length still exceeds 1000. Tail truncation strategy unchanged — only the measurement metric is corrected.
- Smoke-tested with adversarial inputs: 2582-byte ASCII (truncates to 1000), 1017-char prompt with 17 em-dashes (truncates to 1000 bytes), 600-char string of all 4-byte emojis (truncates to 500 chars / 1000 bytes), and edge cases at exactly 1000 + 1001 chars. All pass.

**Why iterative trim, not Buffer slicing**
- Buffer-byte slicing risks cutting a multi-byte char mid-codepoint and producing invalid UTF-8 (decoded as `�`). Iterating `.slice(1)` on the JS string and re-measuring guarantees character boundaries. The estimate-first step keeps the loop O(few iterations) on typical prompts.

**Files modified**
- `backend/services/openai.js`

---

## 2026-05-01 — Truncate prompts to ≤1000 chars when calling dall-e-2 (PEF-fortified)

**Bug**
- Marco: "Now I'm getting this error message: `400 Invalid 'prompt': string too long. Expected a string with maximum length 1000, but got a string with length 2582 instead.`"

**Cause**
- The previous fix routed the OpenAI image-edit path through `dall-e-2`. dall-e-2 has a hard 1000-char prompt limit (verified by the API error message itself + OpenAI docs). The codebase's prompt generator at `backend/services/adGenerator.js` is built around gpt-image-2's larger token budget — typical generated prompts run 2000–3000 chars (brand context + foundational docs + angle direction + headline/body copy + visual style). dall-e-2 rejects anything over 1000.
- The Gemini path doesn't have this limit, so the prompt-generation pipeline never had to constrain length. Now that we route to dall-e-2 for the edit path, we hit the cap.

**Fix**
- `backend/services/openai.js#generateImage` — in the productImage (edit) branch, truncate the prompt to ≤1000 chars before passing to `images.edit`. Slice the **tail** of the prompt (last 1000 chars), not the head. The visual-direction content (headline/body copy, aspect ratio cue, style direction) sits at the END of the prompt template — most actionable for image generation. The opening brand/avatar context is less critical here because the reference image itself carries brand visual identity.
- Generate endpoint (no productImage) is untouched — gpt-image-2 keeps the full prompt.
- Gemini paths are untouched.

**Why tail truncation, not head**
- `buildImageRequestText` in adGenerator.js orders content as: brand → product → avatar → angle → aspect ratio → headline → body copy. Visual direction is at the bottom. Slicing the LAST 1000 chars preserves visual cues; slicing the first 1000 would keep brand context but drop the actual visual prompt — worse for image gen. The product image passed as a reference compensates for the dropped brand context.

**Edge case**
- If `prompt.length <= 1000` (rare but possible), no truncation; `dallePrompt === prompt`.

**Out of scope**
- Smarter prompt compression (LLM-based summarization to fit in 1000 chars while preserving meaning). Adds complexity + extra API call. Defer; if dall-e-2 quality with naïve truncation is poor, this would be the next step.
- Switching to Responses API + image_generation tool for higher-quality OpenAI edits. Defer; Gemini already provides this path.
- Aspect-ratio mapping for dall-e-2 (256/512/1024 only). Carried forward as still-pending follow-up.

**Files modified**
- `backend/services/openai.js`

---

## 2026-05-01 — Use dall-e-2 for the OpenAI image-edit path (gpt-image-2 still rejected)

**Bug**
- Marco: "Now I'm getting this error: `400 Invalid value: 'gpt-image-2'. Value must be 'dall-e-2'.`" + "Why aren't we using `dall-e-2`?"

**Cause**
- OpenAI's `/v1/images/edits` endpoint is hardcoded to accept only `dall-e-2` (verified May 2026 via OpenAI docs + developer community reports). All gpt-image-* variants are rejected. This is a server-side OpenAI limitation, not a tier restriction. The error message itself names the only acceptable model.

**Fix**
- `backend/services/openai.js` — when productImage is present (edit endpoint), hardcode `model: 'dall-e-2'` regardless of the user's selected `imageModel`. Generate endpoint (no productImage) keeps using the user's selected model (gpt-image-2).
- The dropdown UX is unchanged: users still see "GPT Image 2 (OpenAI)" and pick it. The substitution is silent at the API layer.
- Inline comment documents the OpenAI limitation + the one-line swap-back path when OpenAI ships gpt-image-2 edit support.

**Quality note**
- dall-e-2 is older (2022-vintage) and produces lower-quality images than gpt-image-2. For higher quality with a product reference, users should pick **Gemini (Nano Banana Pro / Nano Banana 2)** — both accept product images natively at full quality. The "GPT Image 2 (OpenAI)" option is most useful for projects WITHOUT a product image, where it can use full gpt-image-2 quality on the generate endpoint.

**Out of scope**
- Switching to OpenAI's Responses API + image_generation tool to get gpt-image-2 quality with a reference image. Defer; Gemini already provides this path. Future PR if needed.
- Aspect-ratio compatibility: dall-e-2 only accepts `256x256`, `512x512`, `1024x1024`. Non-1:1 aspect ratios will fail with size errors. 1:1 (the default) works. Future PR.

**Files modified**
- `backend/services/openai.js`

---

## 2026-05-01 — Fix GPT Image 2 "Value must be 'dall-e-2'" — use the alias, not the dated snapshot

**Bug**
- Marco: "Now I'm getting this error message: `400 Invalid value: 'gpt...-21'. Value must be 'dall-e-2'.`"

**Cause**
- The codebase passed the dated snapshot name `gpt-image-2-2026-04-21` to OpenAI's `images.edit` and `images.generate` APIs. Per OpenAI's May 2026 documentation, `images.edit` rejects dated snapshots — only the alias `gpt-image-2` is accepted. The error "Value must be 'dall-e-2'" is OpenAI's generic fall-through when an unrecognized model string is passed to the edit endpoint.
- Same pattern as their chat API: `gpt-4.1` (alias) works everywhere; specific snapshots like `gpt-4.1-2025-XX-XX` may only resolve in some endpoints.

**Fix**
- Dropped the `-2026-04-21` suffix from all callsites. Marco still gets the actual GPT Image 2 model — just under its alias name. Aliases auto-track the latest production version (desirable for ad creative).
- Updated 6 callsites across 3 files: frontend dropdown (option value + label conditional), backend `DEFAULT_IMAGE_MODEL` constant, `OPENAI_IMAGE_MODELS` Set, `imageModelLabel` lookup. Pre-flight grep + post-fix grep confirm zero remaining snapshot references.

**Antipattern note**
- Avoid passing dated model snapshots to OpenAI APIs unless explicitly required for version pinning. Aliases (`gpt-image-2`, `gpt-4.1`, `gpt-5.2`) are universally accepted across endpoints and auto-track the latest production version.

**Files modified**
- `frontend/src/components/AdStudio.jsx`
- `backend/services/openai.js`
- `backend/services/adGenerator.js`

**Note on historical records**
- Existing ad-creative records have `text_model: 'gpt-image-2-2026-04-21'` stored. Future records will have `text_model: 'gpt-image-2'`. Audit-only data, not callable identifiers; no impact on cost reporting (which aggregates by service, not model name).

---

## 2026-05-01 — Fix GPT Image 2 "input file is missing" — productImage object passed raw to sharp()

**Bug**
- Marco: "I've tried to generate a couple of ads in the ad generator using ChatGPT Image 2. It doesn't seem like they are able to generate. I'm getting an 'input file is missing' error message."

**Cause**
- In `backend/services/openai.js#generateImage`, the product-image branch called `sharp(productImage).png().toBuffer()` — passing the WHOLE `{ base64, mimeType }` object as sharp's input. Sharp's constructor doesn't accept that shape, so it silently produced empty output. The empty buffer was wrapped via `toFile` and uploaded to OpenAI's `/v1/images/edits` endpoint, which rejected with "input file is missing." The Gemini sibling at `gemini.js:46–55` correctly destructures `productImage.base64` and `productImage.mimeType`.

**Fix**
- `backend/services/openai.js` — decode `productImage.base64` to a Buffer first, then pass to sharp. Sharp re-encodes to PNG (required by `/v1/images/edits`), the file uploads cleanly. One-line fix plus a comment explaining the shape contract.

**Antipattern note**
- When a function signature is shared across providers (e.g., Gemini and OpenAI both take `productImage`), make sure the IMPLEMENTATION accesses the shape consistently. The OpenAI path was originally written assuming `productImage` was a Buffer, but the producers always pass `{ base64, mimeType }`. The bug was masked by sharp not throwing on the wrong-shape input.

**Files modified**
- `backend/services/openai.js`

---

## 2026-05-01 — API cost rate audit + GPT-5.2 rate corrected

**Audit performed**
- Cross-referenced `backend/services/costTracker.js` rate tables against verified May 1 2026 pricing for OpenAI, Anthropic, and Google AI.
- All Anthropic rates correct (Opus 4.6 $5/$25, Sonnet 4.6/4.5 $3/$15).
- All Gemini Pro Image rates correct (1K/2K $0.134, 4K $0.24).
- All OpenAI rates correct EXCEPT GPT-5.2 (see below).

**Bug — GPT-5.2 rate was wrong**
- Code had `gpt-5.2: { input: 2.00, output: 8.00 }`. Verified May 2026 rate is `{ input: 1.75, output: 14.00 }`.
- Input was 14% overstated. Output was 43% understated. Net per-call cost was understated by ~25–30% on average.
- GPT-5.2 is the workhorse for Marco's setup: single-ad text generation (commit `0976d83`) + batch pipeline (commit `76c8109`). All ad-generation cost rows logged since these migrations have understated `cost_usd`.

**Fix**
- `backend/services/costTracker.js:20` — GPT-5.2 rate corrected to $1.75 / $14.00.
- Effective May 1 2026. All NEW cost rows from this point forward use the correct rate.

**Historical impact**
- Records logged before May 1 2026 with `service: 'openai'` for GPT-5.2-derived operations (`ad_creative_director`, `ad_generation_mode1/mode2`, `batch_brief_extraction`, `batch_headline_generation`, `batch_body_copy`, `batch_body_copy_repair`, `batch_image_prompt`, `ad_angle_generation`, `ad_headline_generation`) are ~25–30% understated.
- The `api_costs` Convex schema does NOT store input/output token counts, only `cost_usd`. Precise retroactive recalculation is impossible without the source data.
- **Estimate true pre-fix GPT-5.2 spend by multiplying historical OpenAI/GPT-5.2 totals by ~1.27.**

**Antipattern note for future devs**
- The `api_costs` schema is rate-coupled — when a rate changes, historical accuracy is lost because token counts aren't stored. A future PR could add `input_tokens` + `output_tokens` columns + a recompute endpoint, enabling future-proof rate changes. Out of scope for this hotfix (Convex schema deploy needed).

**Other rates flagged**
- GPT-5.4 ($2.50 / $10) — couldn't confirm exact base rate via search; mini variant is $0.75/$4.50. Marco/Ian to verify against OpenAI dashboard if LP-pipeline cost reporting feels off. GPT-5.4 is minimally used in primary flows (only referenced in fallback chain).
- Anthropic Haiku 3.5 ($0.80 / $4) — vestigial entry. No production code currently uses Haiku 3.5; safe to leave or drop.

**Files modified**
- `backend/services/costTracker.js`

**Verification post-deploy**
- Generate one ad after deploy. Convex query `api_costs` for that record. `cost_usd` should reflect the new $1.75/$14.00 rate (typical small ad: ~$0.005 instead of ~$0.004).
- Daily OpenAI cost on the dashboard should show ~25–30% increase from May 1 onwards relative to similar-volume days in April.

---

## 2026-04-30 — Fix product-image Remove still required refresh (per-container cache on Vercel)

**Bug**
- After commit `0750dc5` invalidated the `projects` query cache on `setProjectProductImage`, Marco STILL had to refresh the page after pressing Remove to see the image disappear.

**Cause**
- The `cachedQuery` machinery in `backend/convexClient.js` stores results in an in-memory `Map` (per Node process). Vercel serverless functions can be served by different containers across invocations — a DELETE that runs on container A and invalidates A's local cache doesn't reach B's. The subsequent GET sometimes lands on a different container with stale cache and returns the pre-delete project. In-memory caches simply don't work as cross-request state on Vercel.

**Fix**
- `backend/convexClient.js` — `getProject` no longer uses `cachedQuery`. Calls `queryWithRetry(api.projects.getByExternalId, ...)` directly. Every GET fetches fresh from Convex. Performance hit is one fast Convex roundtrip per request — negligible, and it's only called once per HTTP handler.
- The Convex strong-consistency guarantee (a query after a mutation must see the mutation's effect) now applies cleanly to project reads.

**Antipattern note for future devs**
- In-memory caches on serverless platforms (Vercel, AWS Lambda) are per-container and provide no cross-request consistency. Use them only for within-request memoization, OR move to a shared cache (Redis), OR drop them entirely. Trying to "invalidate" them is unreliable when state needs to be visible across requests.

**Files modified**
- `backend/convexClient.js`

---

## 2026-04-30 — Random Template falls back to uploaded templates + save-as-default uses a real toggle

**Bug 1 — Random Template threw "No inspiration images cached"**
- Marco: clicked Random Template + Generate, got "No inspiration images cached. Sync your inspiration folder first." His project has uploaded templates in the Templates Library but no Drive inspiration sync (Drive sync was removed earlier in favor of multi-file upload).
- Cause: `services/adGenerator.js#selectInspirationImage` queried `inspiration_images` (Drive) only, throwing when empty. The frontend Random Template panel description says "random from your uploaded templates" — UI promised one thing, backend did another.
- Fix: `selectInspirationImage` now falls back to `template_images` (uploaded templates) when `inspiration_images` is empty for random selection. Specific-ID lookups (from redo / batch flows) still query `inspiration_images` only — that path is unchanged.
- Cleaner error when truly empty: "No templates available. Upload templates in the Template Library first."
- Refactored the storage-download + temp-file logic into a shared `loadInspirationFromStorage` helper used by both branches.
- Added `getTemplateImagesByProject` helper in `convexClient.js` (uses `cachedQuery` for consistency with sibling helpers).

**Bug 2 — save-as-default was a checkbox, should be a toggle**
- Marco: "The checkbox for saving a product image as a project default needs to be a toggle, like I asked!"
- Replaced the `<input type="checkbox">` with the same toggle pattern used elsewhere on the Ad Studio page (custom button + sliding span). Container background tints teal-on / navy-off so the on-state is clearly distinguishable.

**Files modified**
- `backend/convexClient.js` — added `getTemplateImagesByProject` helper.
- `backend/services/adGenerator.js` — `selectInspirationImage` template fallback + `loadInspirationFromStorage` extraction.
- `frontend/src/components/AdStudio.jsx` — toggle pattern for save-as-default.

**Out of scope**
- Removing Random Template entirely when no templates exist.
- Random across BOTH inspiration_images AND template_images simultaneously (when both populated, inspiration_images still takes precedence).
- Migrating to a shared `<Toggle>` React component (two copies of toggle markup is acceptable).

---

## 2026-04-30 — Fix product-image Remove requires page refresh to reflect

**Bug**
- Marco: "I just pressed the Remove button on the product image for Heal Naturally. It did remove the image, but I had to refresh the page in order to see that."

**Cause**
- `backend/convexClient.js:setProjectProductImage` patched the project's storage ID via the Convex mutation, but did NOT call `invalidateQueryCache('projects')`. The backend's in-memory project query cache (used by `getProject` via `cachedQuery`) kept serving the pre-delete data until the TTL expired. The frontend's `loadProject()` after the delete fetched the stale cached version, so the UI kept showing the old image.
- All sibling project mutations (`updateProject`, `deleteProject`, `createProject`, `backfillProjectStats`) already invalidate the cache. `setProjectProductImage` was the missing one.

**Fix**
- `backend/convexClient.js` — added `invalidateQueryCache('projects')` to `setProjectProductImage` after the mutation completes. The next GET fetches fresh data; UI reflects upload OR delete instantly.

**Antipattern note**
- When a backend wraps a mutation that mutates a cached entity, the wrapper must invalidate the matching cache table — otherwise reads serve stale data until TTL.

**Files modified**
- `backend/convexClient.js`

---

## 2026-04-30 — Fix tab info-tooltips rendering underneath the page body

**Bug**
- Marco: "When I put my cursor over the Ad Studio tab, there's an info button. That info button then gives text that explains what that tab is for, but right now that text is translucent and it's underneath the generate ad section, so it's kind of hard to read. That's the same for the info graphic with the ad pipeline and also the project settings."

**Cause**
- `.page-tabs` (the Ad Studio / Ad Pipeline / Project Settings segmented control) has `backdrop-filter: blur(10px)`, which creates a stacking context per CSS spec. The InfoTooltip's `z-index: 50` only applies WITHIN that stacking context. `.page-tabs` itself sat at `z-index: auto` — so when downstream `.card` elements (Generate Ad form, also a stacking context via `backdrop-blur-2xl`) appeared LATER in the DOM, they painted ON TOP of the entire tabs container, including the tooltip text. Marco saw the tooltip text bleed-through against the Generate Ad form.

**Fix**
- `frontend/src/index.css` — added `position: relative; z-index: 30;` to `.page-tabs`. The whole tabs container now sits above downstream page content (under `.glass-nav` at z-40). Tooltip text renders cleanly on top.
- Inline comment locks in the lesson for future devs.

**Antipattern note**
- When an element has `backdrop-filter` (or `transform`, `filter`, `will-change`, `position: sticky`), it creates a stacking context. Descendant `z-index` values are scoped to that context. To "win" against later sibling stacking contexts, the ancestor itself needs an explicit `z-index`.

**Files modified**
- `frontend/src/index.css`

---

## 2026-04-30 — Settings clarity + Perplexity removal + project pinning + save-as-default product image

**Marco's batch of 4 asks**

**1. Settings — make it clear which API keys are configured.**
- `frontend/src/pages/Settings.jsx` — added a `KeyStatusPill` helper component that renders next to each API key label. Green ● Configured pill when the key is set; gray ○ Not set otherwise. Backend masks keys to `prefix...suffix` on GET, so a non-empty string from settings means "set." Crystal clear at a glance.

**2. Remove Perplexity entirely.**
- Removed Perplexity from: Settings UI form field + handler, `api.testPerplexity`, `routes/settings.js` allowed key list + `/test-perplexity` endpoint, `services/costTracker.js` `PERPLEXITY_RATES` + `logPerplexityCost`, `CostBarChart` and `CostSummaryCards` segment definitions.
- Convex aggregation (`convex/apiCosts.ts`) still has a `perplexity` field; it's harmless dead data, can be cleaned up in a follow-up Convex deploy. The frontend no longer reads it.

**3. Project pinning on the Projects page.**
- `frontend/src/pages/Projects.jsx` — pin icon on each project card (top-right, next to status badge). Pinned projects sort to the top in pin order; unpinned keep server-default order.
- Storage: `pinned_project_ids` setting in the Convex `settings` table (JSON-stringified array). Added to the allowed-keys list in `backend/routes/settings.js`. No Convex schema change needed.
- Pin state is global to the install (single-tenant). Per-user pinning is out of scope.

**4. Save-as-project-default product image toggle.**
- `frontend/src/components/AdStudio.jsx` — when a per-ad product image is uploaded AND the project has no project-level image yet, a toggle appears: "Save as project default — Future ads in this project will automatically use this image." Off by default.
- `backend/routes/ads.js` — both `generate-ad` and `regenerate-image` routes now accept `save_as_project_default`. When set + a per-ad product image is provided + the project has no image yet, the buffer is uploaded to Convex storage and persisted via `setProjectProductImage` BEFORE generation. If generation fails, the project image is still saved (non-fatal failure — generation proceeds).
- The toggle is gated on `!project?.productImageUrl` so it can't accidentally overwrite an existing project image. To replace, the user clears the project image in Project Settings first.

**Antipattern note**
- Don't gate UX clarity behind placeholder text alone. Use explicit visual indicators (status pills, badges) for binary state that the user needs to act on.

**Files modified**
- `frontend/src/pages/Settings.jsx` — status pills + Perplexity removal.
- `frontend/src/pages/Projects.jsx` — pin button + sort logic + settings read/write.
- `frontend/src/components/AdStudio.jsx` — save-as-default toggle + payload flag (3 generate paths).
- `frontend/src/api.js` — removed `testPerplexity`.
- `frontend/src/components/CostBarChart.jsx` — removed Perplexity segment.
- `frontend/src/components/CostSummaryCards.jsx` — removed Perplexity row.
- `backend/routes/settings.js` — removed Perplexity from API_KEY_KEYS / allowed list / test endpoint; added `pinned_project_ids` to allowed list.
- `backend/services/costTracker.js` — removed `PERPLEXITY_RATES` + `logPerplexityCost`.
- `backend/routes/ads.js` — `save_as_project_default` flag handling at both generate-ad and regenerate-image.

**Out of scope**
- Per-user pinning (settings table is shared across the install).
- Drag-reorder of pinned projects.
- Cleaning up the dormant `perplexity` field in `convex/apiCosts.ts`.
- A "Replace project default" UX when an image is already set.

---

## 2026-04-30 — Fix bulk action bar centering bug + aesthetic redesign

**Bug**
- Marco: "It should be floating. It should be sticking with my scroll. Right now it just hangs out in the bottom. You don't know where it is when you select images."
- Cause: the bar at `AdStudio.jsx:3422` used `fixed bottom-6 left-1/2 -translate-x-1/2 z-50 fade-in` for centering. The `.fade-in` keyframe ends at `transform: none` (forwards fill), which **overrode the static `translateX(-50%)`** after the 0.4s entrance animation. The bar's left edge sat at viewport `left: 50%`, pushing the bar into the right half of the screen — often partially or fully off-screen. Marco saw the bar pop in centered, then "disappear."

**Fix — centering**
- Switched the wrapper from `left-1/2 -translate-x-1/2` to `inset-x-0 mx-auto w-fit`. Margin-based centering doesn't conflict with `transform: none`. Inline comment on the wrapper warns future devs not to revert to the transform-based pattern.

**Aesthetic redesign**
- Marco: "The spacing in that is a little awkward. Can you please redesign that to be a little bit more aesthetic for desktop?"
- Pill shape (`rounded-full`) instead of `rounded-2xl` rectangle.
- Gold count badge (e.g. `5`) + concise "selected" label, replacing verbose "5 ads selected".
- Tighter button spacing (`gap-1.5`), smaller padding (`pl-2 pr-2 py-1.5`), `text-[12px]`.
- Stronger elevation: `shadow-2xl shadow-navy/30` with navy tint.
- `backdrop-blur-md` for crisper glass effect.
- Close button restyled as a subtle circular icon button.
- Verbose labels trimmed: "Send to Ad Pipeline" → "Send to Pipeline", "Download Zip" → "Download".

**Antipattern note**
- Don't combine `transform`-based centering (e.g. `-translate-x-1/2`) with an animation whose end state is `transform: none`. The keyframe overrides the static transform via `forwards` fill. Use margin-based centering (`inset-x-0 mx-auto`) on animated elements.

**Files modified**
- `frontend/src/components/AdStudio.jsx`

---

## 2026-04-30 — Fix ad-detail modal layout (Edit Image overflow) + surface silent product-image fetch failures

**Bug A — modal layout**
- Marco: "When I click an ad in the Ad Gallery, the dialog box is not big enough for the Edit Image button. The layout doesn't work correctly."
- Cause: Quick Actions row in the modal at `AdStudio.jsx:3225` was a 3-button `flex` row inside a 280px content area. With three `flex-1` buttons + gaps, each button was ~88px — too narrow for the "Edit Image" label + icon + padding.
- Fix: changed to `grid grid-cols-2 gap-2`. Download + Regenerate sit side-by-side on row 1; Edit Image (when shown) gets `col-span-2` and takes a full-width row 2 below. Edit Image now has ~270px to render comfortably.

**Bug B — product image silently dropped**
- Marco: "I'm generating ads, but it doesn't seem to be using the product image, even though the toggle is on."
- Cause: `backend/utils/adImages.js:getProjectProductImage` swallowed any download failure and returned `null`. The route then proceeded to `generateAd` without `productImageBase64`. Marco saw an ad without the product reference — no warning, no log surface, total silence.
- Fix: `getProjectProductImage` now throws a tagged `Error` with `code: 'product_image_fetch_failed'` instead of returning null on failure. Both `routes/ads.js:generate-ad` and `routes/ads.js:regenerate-image` catch this and emit an SSE `{ type: 'warning', tag: 'product_image_fetch_failed', message: ... }` event at the start of the stream. The frontend's existing `handleEvent` (`AdStudio.jsx:918–920`) renders the warning text on the generation queue card. Marco now sees: "⚠ Project product image could not be loaded — generating without it. Try re-uploading the image in Project Settings."

**Why fetches were failing in the first place**
- A self-heal block in `routes/projects.js:GET` was overly aggressive: if `getStorageUrl(storageId)` returned `null` even once (transient Convex hiccup), the route would fire `setProjectProductImage(undefined)` which deleted the underlying blob AND cleared the project field. A single transient failure permanently destroyed the user's just-uploaded product image, leaving a stale field that subsequent generations would silently fall back to "no product image" on.
- The self-heal was originally added to clean up stale storageIds left by the batch-deletion bug, which itself was fixed in commit `2627947` (per-batch buffer copies). Net new state can't enter that stuck condition anymore, so the self-heal is no longer needed.
- Fix: removed the self-heal entirely. If `getStorageUrl` returns null, `productImageUrl` is null in the GET response. The frontend's toggle UI is gated on `productImageUrl`, so it auto-hides — implicitly prompting the user to re-upload. No silent destruction. No more accidental loss of valid storage IDs.

**Antipattern note for future devs**
- Don't auto-mutate persisted state on a single transient null/falsy result. Surface the failure to the user; let them recover via their natural workflow. Auto-mutation looks like "self-healing" but is destructive when the null is a transient hiccup, not genuinely stale state.

**Files modified**
- `frontend/src/components/AdStudio.jsx` — modal action row layout.
- `backend/routes/ads.js` — try/catch around `getProjectProductImage` + SSE warning emit at both call sites (generate-ad + regenerate-image).
- `backend/utils/adImages.js` — `getProjectProductImage` throws tagged error instead of swallowing.
- `backend/routes/projects.js` — removed self-heal block from GET project route.

**Out of scope**
- Investigating the root cause of Marco's specific storageId being unreachable. The fix surfaces the failure so we can diagnose from logs if it recurs. Removing self-heal eliminates the prime suspect.
- A diagnostic panel showing storage health.
- Backfilling stale storageIds project-wide.

---

## 2026-04-30 — Cascade angle Generate → headline + body copy when those fields already have content

**Request (Marco)**
- "If you press the Generate button for the ad topic/angle, it should rewrite the headline if it's been written already and the body copy if it's been written already. If not, it doesn't have to do anything. The ad angle will dictate what kind of headline it needs to be written and what kind of body copy needs to be written."

**Behavior**
- Click angle Generate, nothing else filled in → only the angle populates.
- Click angle Generate, headline filled in → angle populates, then headline regenerates against the new angle.
- Click angle Generate, headline + body copy filled in → angle populates, headline regenerates, body copy regenerates against the new angle + new headline. Sequential, ~10–20s for full cascade.
- Click angle Generate, body copy only (no headline) → angle populates, body copy regenerates anchored on the new angle (the body-copy backend's project-context fallback handles the missing headline).
- Headline regeneration failure aborts the body cascade — body would otherwise be anchored on a stale headline mismatched with the new angle.

**Implementation**
- `frontend/src/components/AdStudio.jsx` — `handleGenerateAngle` rewritten with sequential cascade.
- Snapshots `hadHeadline` and `hadBodyCopy` at function start so the cascade reflects user INTENT, not whatever React state ends up being mid-cascade.
- Passes `newAngle` and `newHeadline` as explicit local variables to downstream API calls — no reliance on async/batched React state updates.
- Each stage has its own loading state and try/catch so a downstream failure doesn't break the upstream success.

**Antipattern note for future devs**
- When chaining state-dependent async ops in React, capture inputs as local variables and pass them explicitly through the chain. Don't read from `someState` after a `setSomeState()` call — React batches updates and the local read may see stale data.

**Files modified**
- `frontend/src/components/AdStudio.jsx`

**Out of scope**
- Streaming the cascade. Today: synchronous one-shot per stage.
- Cascade behavior on the headline Generate button (only angle cascades to headline + body).
- A "preserve body copy" opt-out toggle.
- Cancellation mid-cascade.

---

## 2026-04-30 — Stop the template analysis from auto-toggling the product-image switch

**Symptom (Marco)**
- "When I pick a template, it is turning off the product image. It shouldn't be doing that. The product image should stay on all the time unless turned off manually."

**Cause**
- The template-analysis useEffect in `AdStudio.jsx` had THREE auto-mutations of the `skipProductImage` toggle: cached-analysis path (line 441), API-analysis path (line 461), and an early-return reset to ON (line 430). When an uploaded template's analysis returned `needs_product_image: false`, the toggle silently flipped from ON to OFF without any user click. The early-return reset also undid manual OFF clicks when the user left Pick Template or picked a Drive template.

**Fix**
- `frontend/src/components/AdStudio.jsx` — removed all three auto-mutations. The toggle is now purely user-controlled. `templateAnalysis` is still set, and the analysis card's "Product image: recommended / not needed" badge still renders as a **visible recommendation**. The system informs; the user decides.

**State-mutation surface (post-fix)**
- Default `false` (ON) on mount.
- Reset to `false` on project change (preserves project isolation; same pattern as `angle`, `headline`, `bodyCopy`, `selectedTemplate` reset).
- Toggled on user click (three button locations).
- Nothing else touches it.

**Antipattern note for future devs**
- For user-facing toggles that represent a CHOICE, only manual clicks should mutate the state. Programmatic mutations from background analysis or auto-effects create surprise-changes that violate user trust.

**Files modified**
- `frontend/src/components/AdStudio.jsx` (3 deletions + 1 comment block update)

**Out of scope**
- Body-copy auto-regenerate when picking a template (lines 443–445 / 469–471). Marco didn't mention it.
- Auto-set of `bodyCopyStyle` from `analysis.recommended_style` (lines 440 / 460). Same.
- Badge wording polish on the analysis card.

---

## 2026-04-30 — Fix `max_tokens` 400 on GPT-5.2; body-copy Generate button matches sibling buttons exactly

**Bug A — Headline + Angle Generate buttons returned 400 from OpenAI**
- Marco saw: `400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`
- Cause: commit `0976d83` migrated angle + headline routes to `gpt-5.2` while keeping the legacy `max_tokens` parameter. Reasoning-class models (gpt-5.x, o1, o3) reject `max_tokens` and require `max_completion_tokens`. The wrapper at `backend/services/openai.js:chat()` was passing options through verbatim with no normalization.

**Fix A — wrapper-level normalization (universal future-proofing)**
- `backend/services/openai.js` — `chat()` now normalizes `max_tokens` → `max_completion_tokens` before spreading apiOptions into the API call. Same upper-bound semantics; works on every OpenAI chat-completion model. Existing callers (`routes/upload.js`, `routes/settings.js`, `routes/ads.js`) keep working without changes; future callers using gpt-5.x are auto-fixed.
- Guard: `apiOptions.max_completion_tokens == null` check protects callers that already use the new param name.

**Bug B — body-copy Generate button visually mismatched the sibling buttons**
- The button used a refresh-arrow icon, `gap-1.5`, label-flipping (`Generate` / `Regenerate`), an input pre-condition gate (grayed out when no headline/angle), a `title` tooltip, and `disabled:cursor-not-allowed`. The angle/headline siblings use the sparkles icon, `gap-1`, static `Generate` label, and disable only while generating.

**Fix B — match the sibling pattern exactly**
- `frontend/src/components/AdStudio.jsx` — body-copy button now uses the sparkles icon, `gap-1`, `disabled={generatingBody}` only, no `title`, no extra cursor class, label always `Generate`. `handleRegenerateBody` drops the input pre-condition; backend handles the empty-input case via the project-context fallback.
- `backend/routes/ads.js` — `generate-body-copy` route falls back to `project.product_description → project.brand_name → project.name` when both headline and angle are empty. Only 400s when there's truly no usable text on the project record.

**Antipattern note for future devs**
- For OpenAI calls, prefer `max_completion_tokens` over `max_tokens`. The wrapper in `backend/services/openai.js:chat()` normalizes either to the new param name, but new code should write `max_completion_tokens` directly for clarity.

**Files modified**
- `backend/services/openai.js`
- `backend/routes/ads.js`
- `frontend/src/components/AdStudio.jsx`

**Out of scope**
- Migrating other Anthropic-using endpoints. They legitimately use Claude.
- Streaming the angle/headline/body-copy responses.
- Removing `max_tokens` references everywhere in favor of `max_completion_tokens`. Wrapper handles it transparently; future PR can refactor.
- `temperature` normalization for reasoning models (some restrict temperature). Not currently a problem.

---

## 2026-04-30 — Auto-collapse the Pick Template grid after a template is selected

**Request (Marco)**
- "When I use the Pick Template tab and I select a template, I have to scroll through all the templates to now get to the bottom. It would be nice if there's a way to collapse that menu so I could continue on there and make more adjustments and generate that."

**What changed**
- `frontend/src/components/AdStudio.jsx` — added `pickerCollapsed` state and an effect that mirrors it to `selectedTemplate`: selection present → grid auto-hides, compact pill shows; selection absent → grid auto-expands. The compact pill renders the selected template thumbnail, name, source label, and two buttons: **Change** (re-expand the grid without losing the selection) and **Clear** (deselect).
- The existing text indicator ("Selected: <name> (source) [Clear]") is gated to render only in expanded mode (it's redundant with the pill).
- The template-analysis card was hoisted out of the original `{selectedTemplate && (...)}` wrapper and now renders whenever there's a selection, regardless of collapsed/expanded state — the analysis info (layout, recommended style, product-image-needed flag) stays useful below the pill.
- Pill thumbnail has a fallback placeholder div if the underlying template was deleted between selection and render.

**Behavior**
- Click a template → grid disappears, pill appears, downstream form is immediately reachable. ✓
- Click Change → grid re-renders. Click a different template → auto-collapse to new pill. ✓
- Click Clear → selection cleared, grid expands. ✓
- Tab-leave (Manual Upload / Random Template) → prior fix clears `selectedTemplate`, this effect resets `pickerCollapsed` to false → next visit to Pick Template shows the grid. ✓
- handleRedo (Redo on a gallery ad) → sets `templateSource = SELECT` then `selectedTemplate`; effect fires → pill renders for the redo target. ✓

**Files modified**
- `frontend/src/components/AdStudio.jsx`

**Out of scope**
- Manual collapse before selection (no UX benefit when browsing).
- Per-section collapse (Drive vs Uploaded). One selection at a time.
- Slide/fade animation on collapse/expand. Future polish.
- Persisting `pickerCollapsed` across reloads. Selection is ephemeral.

---

## 2026-04-30 — Migrate Ad Studio's angle + headline generators off Anthropic; surface body-copy Generate button without requiring a headline

**Bug**
- Marco reported the Generate buttons above "Ad Topic / Angle" and "Headline" weren't working — they "still attached to the Anthropic key." Confirmed: `backend/routes/ads.js:165` and `:211` still called `claudeChat` with `claude-sonnet-4-6`. These were missed when commit `76c8109` migrated the *batch* pipeline off Anthropic. Marco's project doesn't have an Anthropic key set (intentionally — we removed that requirement for batches), so those single-ad helpers failed.

**Feature**
- Marco asked for a Generate button on the body-copy section. The button existed but was hidden behind a `headline.trim()` gate, AND the backend rejected missing-headline requests with 400.

**Fix (single commit, three logical changes)**
- `backend/routes/ads.js` — migrated `POST /generate-angle` and `POST /generate-headline` from `claudeChat` (`claude-sonnet-4-6`) to OpenAI's `chat` (`gpt-5.2`), matching the batch-pipeline pattern. Added `SINGLE_AD_TEXT_MODEL = 'gpt-5.2'` constant. Operation labels (`ad_angle_generation`, `ad_headline_generation`) and prompts are byte-identical so cost-tracking history is continuous (provider field flips Anthropic → OpenAI, operation field unchanged). Dropped the `claudeChat` import (no remaining call sites).
- `backend/routes/ads.js` — relaxed `POST /generate-body-copy` to accept either a headline OR an angle. When no headline is provided, the angle is used as the topic anchor passed into `generateBodyCopy`. Both must be empty for a 400; otherwise the existing `bodyCopyGenerator.js` (which already uses OpenAI / GPT-4.1-mini) handles generation.
- `frontend/src/components/AdStudio.jsx` — ungated the body-copy Generate button. It now always renders, and is `disabled={generatingBody || (!headline.trim() && !angle.trim())}` with a `title` tooltip for the disabled hint. `handleRegenerateBody` accepts angle-only input. Most discoverable UX: button is always visible, greys out until there's input to anchor copy generation.

**Antipattern note for future devs**
- Routes in `backend/routes/ads.js` are now OpenAI-only by design. Anthropic is retained ONLY for: LP generator, copywriter chat, conductor (Director) learning, quote miner, foundational doc generator, creative filter agent. Marco needs an Anthropic key for those features specifically.

**Pre-flight verification**
- `grep -n "claudeChat" backend/routes/ads.js` → zero matches after fix.
- `grep -n "generateAdBodyCopy" frontend/src/` → only AdStudio.jsx call site (no other consumers of the relaxed validator).

**Out of scope**
- Migrating LP generator / copywriter chat / conductor / quote miner / doc generator / filter agent off Anthropic — they legitimately use Claude.
- Streaming the angle / headline / body-copy responses (today: synchronous one-shot, ~5–10s spinner).
- Prompt-tuning for the angle-only body-copy path. Functional today; tighter results when a real headline is provided. Future polish if quality drops.

---

## 2026-04-30 — Fix product-image toggle silently flipping OFF when navigating template-source tabs

**Bug**
- Marco reported: "I went to the Pick Template tab — product image was turned ON. I clicked Manual Upload, then Random Template — and somehow the product image got switched OFF. It seems to happen when I click Manual Upload and then go back to Random Template."

**Root cause**
- In `AdStudio.jsx`, the template-analysis useEffect (deps: `[selectedTemplate?.id]`) calls `setSkipProductImage(!analysis.needs_product_image)` when an uploaded template is selected — sometimes synchronously (cached), sometimes asynchronously (API call).
- When the user clicked Pick Template and selected an uploaded template (`T1`), the API analyze call started in the background.
- When the user then clicked Manual Upload or Random Template, `selectedTemplate` was NOT cleared. The async `analyzeTemplate` call eventually returned, fired `setSkipProductImage(true)` AFTER the user had moved tabs — so the toggle visibly flipped OFF on whichever tab the user was now viewing. To Marco it looked like the act of switching tabs caused the flip.
- Additionally, the early-return path in the analysis useEffect (when no uploaded template is selected) reset `templateAnalysis` to null but left `skipProductImage` at its prior value — so any "off" decision made by a previous analysis lingered after deselect, switching to a Drive template, or other state changes.

**Fix (single commit, two surgical changes in `AdStudio.jsx`)**
- **Change A**: New `useEffect` on `[templateSource]`. When `templateSource` is no longer `TEMPLATE_SELECT` and `selectedTemplate` is set, clear `selectedTemplate`. This causes the analysis useEffect to re-run with a null selection — its existing `cancelled = true` cleanup blocks the in-flight API callback, and the early-return path runs.
- **Change B**: In the analysis useEffect's early-return path, also call `setSkipProductImage(false)`. The toggle returns to its default ON state whenever no analyzable template is selected (deselect, Drive template, tab leave via Change A).

**Coordination with handleRedo**
- `handleRedo` does `setTemplateSource(TEMPLATE_SELECT)` BEFORE `setSelectedTemplate(...)`. Change A's effect only fires when leaving SELECT, so it doesn't interfere — the redo flow correctly enters Pick Template with the right template selected and analysis fires.

**Antipattern note for future devs**
- Side effects that mutate state X based on state Y must clean up X when Y is no longer applicable. Otherwise stale X values linger and look like bugs to users.

**Files modified**
- `frontend/src/components/AdStudio.jsx` (~7 lines added)

**Out of scope**
- Manual-toggle persistence across template selections (existing UX inconsistency: an analysis still overrides a manually-set toggle when an uploaded template is selected). User did not report this as a bug.
- Visual feedback for in-flight analysis (greyed toggle / spinner). Future polish.

---

## 2026-04-30 — Fix two bugs: ad-detail modal opens off-screen + Heal Naturally product image disappears

**Bug A — Ad-detail modal opens far up the page**

Symptom: clicking an ad in the gallery opened the modal way above the current viewport; user had to scroll up to find it.

Root cause: `Layout.jsx` wraps every page in `<main className="... animate-fade-in-up">`. The `fade-in-up` keyframe in `tailwind.config.js` ended on `transform: 'translateY(0)'` with `forwards` fill mode, so `<main>` retained a non-`none` transform indefinitely. Per CSS spec, any element with a non-`none` `transform` becomes a containing block for fixed-positioned descendants — so the modal's `position: fixed; inset: 0` was calculated relative to `<main>`'s bounding box (which extends from below the navbar to the bottom of all rendered content), not the viewport. After scrolling, `<main>`'s top is way above the viewport, so the modal opened way above too.

Same antipattern existed in three CSS keyframes in `index.css` (`fadeIn`, `slideUp`, `slideInRight`).

Fix: change the final keyframe from `transform: translateY(0)` / `translateX(0)` / `scale(1)` to `transform: none`. Visually identical (translateY(0) and none look the same) but `none` does NOT create a containing block. Modal now opens dead-center in the viewport.

**Bug B — Heal Naturally product image disappeared on its own; ads now generate without it**

Symptom: Marco uploaded a product image, then it disappeared; subsequent ad generations no longer included the product image.

Root cause: storage-ID double-ownership between `projects.product_image_storageId` and `batch_jobs.product_image_storageId`. When a batch was created without uploading a separate image, `routes/batches.js:59` and `services/conductorEngine.js:227, 1065` set the batch's `product_image_storageId` field to the *exact same Convex storage ID* the project was using. Later, when ANY batch sharing that ID was deleted, `convex/batchJobs.ts:remove` unconditionally called `ctx.storage.delete(batch.product_image_storageId)`, which wiped the underlying blob. The project's field still pointed to the now-dead storage ID. Convex returned no URL for it; the UI showed no product image; ad-generation paths gracefully fell through to "no product image" because `downloadToBuffer` returns nothing for a dead storage ID. Hence "now it's making ads without it."

Fix (clean ownership):
- New helper `copyStorageBlob(sourceStorageId, contentType)` in `backend/utils/adImages.js` — downloads the source blob and re-uploads it to a new storage ID.
- `routes/batches.js`: when re-using project's image, copy buffer to new storage ID (with try/catch — if the project's source is already dead, log + proceed without).
- `services/conductorEngine.js`: same pattern at the two Director batch-creation sites, via local `copyProjectProductImageForBatch(project)` helper.
- `routes/projects.js`: GET project now self-heals — if `getStorageUrl` returns null for a set `product_image_storageId`, fire-and-forget call to `setProjectProductImage(undefined)` clears the dead pointer. Race-safe (idempotent patch). User sees "no image set" on next reload and can re-upload cleanly.

Storage cost of the copy: ~50–200 KB per batch, <$0.05/year at Marco's scale. Negligible.

**Antipattern note for future devs (animation keyframes)**
- NEVER end a CSS animation on `transform: translateY(0)` / `translateX(0)` / `scale(1)` with `animation-fill-mode: forwards`. Use `transform: none`. The two are visually identical but only `none` avoids creating a containing block for fixed-positioned descendants.

**Antipattern note for future devs (storage IDs)**
- NEVER share a Convex storage ID across two records (e.g., `project.product_image_storageId` and `batch.product_image_storageId`) without an explicit shared-ownership flag. The `remove` mutation of either record will unconditionally delete the blob. Always copy buffer to a new storage ID per record, even if it costs a small download/re-upload.

**Pre-flight verification**
- Grepped `frontend/src/index.css` and `frontend/tailwind.config.js` for `@keyframes` / `animation: ... forwards` — confirmed all four animation final-states updated.
- Grepped `backend/` for `project.product_image_storageId` direct assignments to a child record — found exactly the three sites fixed (routes/batches.js + 2x conductorEngine.js).

**Files modified**
- `frontend/tailwind.config.js`
- `frontend/src/index.css`
- `backend/utils/adImages.js` (added `copyStorageBlob` helper)
- `backend/routes/batches.js`
- `backend/services/conductorEngine.js`
- `backend/routes/projects.js`

**Out of scope**
- Backfill stale `product_image_storageId` on all projects (Layer 2 self-heals on read; one-shot Convex script overkill for hotfix).
- React portal refactor for modals (Layer 1 keyframe fix avoids the issue without portals).
- Auditing every other Convex storage-deletion path (focused grep confirmed only the project↔batch pair is affected; templateImages, adCreatives, inspirationImages own their storage IDs distinctly).
- `prefers-reduced-motion` support (future PR).

---

## 2026-04-30 — Fix dark "flash on scroll" caused by `:hover { translateY }` antipattern on cards

**Bug**
- Marco reported that scrolling down past the Generate Ad button toward the Ad Gallery caused a dark flash, repeatedly, in the area "right underneath the Generate Ad button" — a 600ms-cycle pulse of dark navy shadow on whatever card was crossing the cursor's screen Y position during scroll.

**Root cause**
- `.card:hover` defined `transform: translateY(-2px)` PLUS a heavier shadow + `bg-white/70`, all transitioned via `transition-all duration-300`. When the cursor was stationary and the page scrolled, every card whose top edge crossed the cursor's Y position would: (1) trigger `:hover`, (2) lift up by 2px (moving the card edge above the cursor), (3) end `:hover` (cursor no longer on it), (4) drop back to neutral position (cursor over it again), (5) restart at step 1. Visible 300ms transitions made it a slow, obvious dark/light pulse. The "dark" is the heavier navy shadow appearing on each cycle.
- Same antipattern existed at three Tailwind callsites: `hover:-translate-y-0.5` on the gallery grid cards in `AdStudio.jsx`, the template grid cards in `TemplateImages.jsx`, and the project list cards in `Projects.jsx` — all of which would flicker as the user scrolled past them.

**Fix (single commit, ~10 lines across 4 files)**
- `frontend/src/index.css` — removed `transform: translateY(-2px)` from `.card:hover`. Kept the heavier shadow + brighter background so cards still respond to mouse hover. Tightened `.card`'s transition from `transition-all` to specific properties (`box-shadow, background-color`) so any future Tailwind transform class on a `.card` won't reintroduce the flicker. Added inline comment explaining the antipattern.
- `frontend/src/components/AdStudio.jsx`, `frontend/src/components/TemplateImages.jsx`, `frontend/src/pages/Projects.jsx` — removed `hover:-translate-y-0.5` from the three card grid call sites.

**Carve-outs (intentionally unchanged)**
- `.btn-primary:hover { transform: translateY(-2px) scale(1.02) }` — buttons are smaller targets and clicked-not-scrolled-past, so the flicker risk is much lower. Left as-is. If a button-flicker is reported later, the follow-up will switch to scale-only.
- `group-hover:scale-[1.02]` on `<img>` elements inside cards — the image is a child of an `overflow-hidden` card; the image scales WITHIN a fixed frame, so the card outer geometry doesn't move. No flicker risk. Provides per-card hover delight without touching the card's hit area.
- Other `transition-all` callsites across the codebase — out of scope for this hotfix; CLAUDE.md guardrail covers them as a future migration.

**Pre-flight verification**
- `grep -rEn "hover:.?-?translate-y|translateY\(-?[0-9]" frontend/src/` confirmed only the four sites above. After fix, the same grep on `frontend/src/components/` and `frontend/src/pages/` returns zero `hover:-translate-y` matches. Remaining `translateY` references in `index.css` are: `.btn-primary` (intentional carve-out), `@keyframes fadeIn`/`slideUp` (one-shot mount animations), and `.info-tooltip` positioning (not on hover-on-card surfaces).

**Antipattern note for future devs**
- DO NOT add `:hover { transform: translate(...) }` (or Tailwind `hover:-translate-*`) to elements that the user typically scrolls past, especially elements taller than ~50px. The translate moves the element out from under the cursor, ending hover, restarting the loop. Use shadow / background / border-color / opacity for hover affordance instead. If a lift is essential, scope it to `@media (hover: hover) and (pointer: fine)` AND add a meaningful `transition-delay` (~100ms) so quick crossings don't trigger.

---

## 2026-04-30 — Fix `drive_folder_id` ArgumentValidationError on project save

**Bug**
- Marco tried to add a product image to the Heal Naturally project and got `ArgumentValidationError: Path: .drive_folder_id Value: null Validator: v.string()`. The error did not come from the product image upload itself — `setProductImage` only patches `product_image_storageId` + `updated_at`. It came from a `PUT /api/projects/:id` (project save) round-trip.

**Root cause chain**
1. `convex/schema.ts` and `convex/projects.ts` declare `drive_folder_id: v.optional(v.string())` — accepts undefined or string, rejects null.
2. Heal Naturally has no `drive_folder_id` set (legitimately optional).
3. `backend/convexClient.js:convexProjectToRow` was coercing missing optional strings to `null` for the API response (`p.drive_folder_id || null`).
4. The frontend `loadProject()` set `form.drive_folder_id = null`; `handleSave()` round-tripped the form (including the null) back via `api.updateProject`.
5. `backend/convexClient.js:updateProject` filtered with `if (fields[key] !== undefined)` — null passed through, hit the validator, rejected.

**Fix (single commit, two-layer defense)**
- **Layer 1** (`backend/convexClient.js:updateProject`) — filter drops both `undefined` AND `null`. Boundary defense; protects every future call site without per-component discipline. Inline comment locks in the lesson for future devs.
- **Layer 2** (`backend/convexClient.js:convexProjectToRow`) — optional simple-string fields now emit `''` instead of `null`. Contract going OUT matches contract going BACK. Frontend already uses `value={form.x || ''}` patterns, so no UI regression.

**Carve-outs (intentionally unchanged)**
- `product_image_storageId` — Convex storage ID; frontend null-checks for image rendering.
- `scout_destination_urls` — JSON-array-as-string per Critical Invariant #2; `''` would break `JSON.parse`.
- `scout_enabled` / `scout_score_threshold` / `scout_daily_flex_ads` — nullable boolean/number; Layer 1 filter handles them at the boundary.

**Pre-flight verification (run before edits)**
- Grepped `(===|!==|==|!=) *null` across `backend/`, `frontend/src/` for the affected fields. Zero matches — no consumer relies on `null` specifically.
- Confirmed working tree clean for `convexClient.js`. HEAD at `6e7e65f` (favicon commit), 0 commits ahead of origin/main.

**Out of scope**
- Auditing other mappers (`convexAdToRow`, `convexBatchToRow`, etc.) for the same null-coercion pattern. Deferred — fix when (if) they bite.
- Schema-level change to `v.optional(v.union(v.string(), v.null()))`. Would require Convex deploy (auth-mismatch risk per prior session) and codifies a less clean contract.
- Cleanup of any legacy stored nulls in other projects. Layer 1 makes them safe to save going forward.

---

## 2026-04-30 — Refactor batch pipeline off Anthropic onto OpenAI (no Anthropic key required for batches)

**Diagnostic findings**
- User Marco reported "I tried a batch job and it failed at headline generation." Direct Convex query confirmed the Anthropic API key was NULL in the settings table while OpenAI was set, and zero `batch_headline_generation` / `batch_brief_extraction` cost rows existed for that day. Root cause: Stage 1 calls Claude, but no Anthropic key was configured.
- The single-ad flow (Ad Studio "Generate Ad") already used GPT-5.2 + Gemini with no Anthropic dependency. The batch pipeline used Claude for all 4 copy stages (brief extraction, headlines, body copy, image prompts) plus OCR — a model-preference choice baked into the code, not an architectural requirement.

**What changed**
- `backend/services/adGenerator.js` — defined `BATCH_TEXT_MODEL = 'gpt-5.2'` and `BATCH_VISION_MODEL = 'gpt-4.1'` constants. Migrated 9 Claude call sites to OpenAI: Stage 0 brief extraction, Stage 1 headlines (with `response_format: { type: 'json_object' }`), Stage 2 body copy + repair, Stage 3 image prompts (with vision via `chatWithImage` + non-vision via `chat`), repair fallback. Dropped the Anthropic imports. Generalized the `lastError → leadingDiagnostic` mapping (originally added in commit `617eada`) to handle BOTH Anthropic and OpenAI error shapes — uses `err.error?.code` / `err.code` in addition to `err.error?.type`. Labels switched from "Anthropic xxx" to "LLM xxx" since the same diagnostic now serves both providers. Added explicit OpenAI content-policy violation case ("Prompt was rejected by OpenAI content policy — try rephrasing.").
- `backend/services/batchProcessor.js` — defined `BATCH_OCR_MODEL = 'gpt-4.1-mini'` and migrated the OCR text-extraction call (was Claude Haiku). Updated stored `text_model` label on ad_creatives from `'claude-sonnet-4-6'` to `'gpt-5.2'`. Swapped the pre-flight key check from Anthropic to OpenAI: error message now reads `[Stage 1] OpenAI API key not configured. Set it in Settings → API Keys.` Removed the `claudeChatWithImage` import (replaced with `chatWithImage` from openai.js).
- `backend/services/openai.js` — extended `OPENAI_FALLBACK_CHAIN` with `'gpt-5.2': 'gpt-4.1'`. If Marco's OpenAI tier doesn't grant 5.2, the existing fallback machinery at line 127 engages and uses GPT-4.1 instead.

**Why**
- Marco's primary use case (batch ad generation) shouldn't require him to manage three LLM providers when only OpenAI + Gemini are needed structurally. Eliminating the Anthropic dependency for batches removes a setup hurdle and makes the failure mode easier to debug (only 2 keys can be missing; not 3).
- The pre-flight error from commit `617eada` would have caught his original failure cleanly ("[Stage 1] Anthropic API key not configured"), but the better fix is to remove the dependency entirely.

**Cost note**
- Cost-per-batch may shift after this change (GPT-5.2 vs Claude Sonnet pricing varies by stage and token volume). Monitor for the first week. If costs jump materially or quality drops, the migration is a clean single-PR `git revert` away.

**Anthropic still required for non-batch features**
- LP generator (`lpGenerator.js`), copywriter chat, conductor learning (`conductorLearning.js`), quote miner, creative filter (`creativeFilterService.js`), foundational doc generator (`docGenerator.js`) all still call Claude. Marco needs to keep the Anthropic key set if he uses any of those features. Only the batch pipeline is migrated by this PR.

**Out of scope (explicit)**
- Prompt tuning for GPT-5.2. v1 keeps prompts byte-identical to the Claude versions. If quality drops materially in production, separate PR for tuning.
- Hybrid mode (use Claude when Anthropic key set, fall back to OpenAI otherwise). Defer; revisit only if needed.
- Removing Anthropic from the codebase entirely. Out of scope.

**Dashboard banner for missing keys** — separate follow-up PR after this lands and Marco's batch is verified working. Will surface missing OpenAI/Gemini keys at app load.

## 2026-04-30 — Fix stuck `generating_copy` / `generating_image` ads (zombie ad-creatives)

**Diagnostic findings**
- User Marco reported a generated ad "disappeared" from his Wedding System project. Direct Convex query showed: ad records exist in the database with `status: generating_copy` from 24+ hours ago. Not deleted — hidden by the gallery filter at `AdStudio.jsx:1428` which assumes those statuses mean "actively in progress."
- Most plausible root cause: Vercel function `maxDuration: 60`. Ad generation typically takes ~50s; OpenAI 429 retries can push past 60s; Vercel kills the function mid-stream; orchestrator's catch block never runs; ad's status stays at `generating_copy` forever. Other plausible causes (backend crash, SSE drop) leave the same fingerprint.

**What changed**
- `backend/convexClient.js` — new `markStaleAdsAsFailed(projectId, opts)` helper. Reads ads via existing `getByProject` query, filters to `generating_copy`/`generating_image` status with `created_at` older than threshold (default 5 min), calls existing `adCreatives.update` mutation per stuck ad to flip status to `failed`. Idempotent (status precondition checked); bounded by `maxRepairs` (default 100) to avoid Convex rate-limit blowups. No Convex schema changes — uses the existing `update` mutation's whitelisted `status` field.
- `backend/routes/ads.js` — fire-and-forget auto-cleanup in the `GET /:projectId/ads` handler (runs every gallery load). Errors logged via `console.warn`, not silently swallowed. New admin/manager-only `POST /:projectId/ads/cleanup-stuck` endpoint accepting optional `olderThanMinutes` (default 5, validated > 0) for forced cleanup. Single source-of-truth constant `STUCK_ADS_THRESHOLD_MIN = 5`.
- `frontend/src/components/AdStudio.jsx` — gallery filter at line 1428 now distinguishes "fresh" from "stuck": ads in `generating_copy`/`generating_image` are hidden ONLY if `created_at` is within the 5-minute window (matches backend threshold). Older zombies fall through and surface in the gallery, where the existing failed-ad treatment (red icon, red badge) renders + the existing per-card Delete button lets Marco dismiss them. Stale-detection runs BEFORE the type filter (`galleryFilter === 'individual'/'batch'`) so stuck batch ads also surface.

**Why**
- Marco's specific case: 2 zombie ads in the Wedding System project from 2026-04-29 will auto-resolve on his next gallery load — no manual intervention. Future zombies surface within 5 minutes instead of vanishing silently for 24+ hours.
- 5-min threshold tied to Vercel's 60s `maxDuration` + 4-min buffer for cold starts and clock skew. After 5 minutes, the function is definitively dead — no race risk with a legitimately long-running generation.

**Out of scope (future work)**
- Fixing the underlying Vercel timeout. Requires Pro tier upgrade (allows 300s `maxDuration`), splitting the orchestrator into shorter stages, or queue-based architecture. Cleanup approach surfaces the symptom; root-cause fix is a separate decision.
- Retry-from-stuck-state UI button. v1 marks zombies failed; user re-generates manually via the existing Generate button. Existing per-card Delete button is the dismiss path.
- Adding `error_message` / `pipeline_state` / `updated_at` fields to `ad_creatives` schema. Would require Convex deploy and schema migration. Not blocking the fix; status alone is sufficient signal.

## 2026-04-29 — Stage 1 batch failure: surface root cause + harden pre-flight

**What changed**
- `backend/services/adGenerator.js` — captures `lastError` in the headline-generation retry loop (lines ~1204-1311). Replaced the generic "Claude may be experiencing issues" fallback throw with a structured, length-capped message that puts the most actionable diagnostic FIRST so it survives the History panel's 50-char inline truncation. Examples: "[Stage 1] Anthropic auth error (401) after 3 attempts...", "[Stage 1] Anthropic rate-limited (429) after 3 attempts...". Uses defensive existence checks on Anthropic SDK error fields (`err.status`, `err.error?.type`).
- `backend/services/batchProcessor.js` — added API-key pre-flight check inside `runBatch` (right after the project-found check). Throws "[Stage 1] Anthropic API key not configured. Set it in Settings → API Keys." with the actionable message in the first 50 chars. Updated the existing zero-foundational-docs throw to follow the same `[Stage 1]` prefix convention. Replaced the generic diversity-filter throw at ~line 343 with a context-rich message that includes the actual filter rejection counts (`sceneAlignedPool.rejected.length`, `dedupedPool.rejectedInBatch.length`, `dedupedPool.rejectedByHistory.length` — verified field names from `headlineDiversity.js`). Catch block now also writes a structured `pipeline_state` JSON diagnostic (stage, failed_at, error_message, error_status, error_type) for post-mortem inspection in Convex when Vercel logs aren't available. Imported `getSetting` from `convexClient.js`.

**Why**
- User ran a batch of 5 ads and got the History row "Pipeline failed: [Stage 1] All headline generation". The generic message didn't tell us which of 5 plausible failure modes actually fired (API key issue, rate limit, scene-locked angle, missing docs, bad JSON). With Vercel Hobby not persisting historical logs, the next debugger had nothing to go on.
- The fix doesn't try to guess the root cause — it makes the next failure self-diagnosing. Once we see the actual diagnostic in the History panel, the targeted root-cause fix becomes a separate (small) PR.

**Out of scope (future work)**
- Actual root-cause fix for whatever the diagnostic reveals (separate PR once we have signal).
- Loosening the diversity filter — it exists for valid reasons; if it's rejecting everything, we want to know.
- Persistent log aggregation (Sentry / Logtail) — error-message-as-diagnostic gets us 80% at 0% cost.
- Live Anthropic key validation in pre-flight — diagnostic now correctly surfaces the 401 if a non-empty-but-revoked key is set.

## 2026-04-29 — Fix HTTP 413 in Ad Studio generation (client-side image resize + DRY error handling)

**What changed**
- `frontend/src/utils/imageResize.js` — **new shared utility**. `resizeImageForUpload(file)` downscales any image >1.5 MB via canvas to JPEG (max 2048×2048, iterative quality 0.92 → 0.85 → 0.75 → 0.6 → 0.45). Skips already-small files entirely (preserves PNG transparency, GIF animation). Refuses HEIC/HEIF (detected by both extension and content signature) with a clear "Convert to JPEG or PNG first" message. Refuses files >20 MB (prevents browser OOM). Uses `createImageBitmap` with an Image-element fallback for older Safari quirks. Also exports `estimateBase64BodyBytes(files)` and `MAX_COMBINED_BODY_BYTES = 4 MB` for pre-flight checks.
- `frontend/src/api.js` — added `throwForResponseError(res)` helper that handles HTTP 413 specifically with the message "Request body too large. Please reduce image size." instead of leaking a JSON.parse SyntaxError. Applied in `request()`, `streamSSE`, and `streamSSEWithBody` (the three shared fetch paths). `uploadTemplate` keeps its own pre-existing 413 handler with template-specific wording.
- `frontend/src/components/AdStudio.jsx` — added `resizeAndBase64(file)` helper that resizes then base64-encodes (with a `console.info` diagnostic on every actual resize). Wrapped all four `fileToBase64` callsites (productFile, uploadedFile, editReferenceFile in custom-prompt mode, referenceImage in edit-prompt flow) to resize-first. Added a pre-flight combined-size check via `exceedsCombinedSizeLimit()` that runs before `api.generateAd` / `api.regenerateImage` and aborts with "Combined image data is too large. Try fewer or smaller images." if the JSON body would exceed 4 MB. Added race-condition guards (capture file ref at start of resize, abandon if the source field changed mid-resize).

**Why**
- User reported two errors while generating an ad: a cryptic `Unexpected token 'R', "Request En"... is not valid JSON` toast and a `1:1 HTTP 413` line in the Ad Queue. Same root cause: per-generation image attachments (productFile / uploadedFile / editReferenceFile) were base64-encoded inline into the JSON body. With multiple attachments or one moderate-size attachment, the body crossed Vercel Hobby's 4.5 MB inbound gateway limit and was rejected before reaching the backend. The frontend then tried to JSON.parse Vercel's plain-text 413 body, leaking a SyntaxError to the toast.
- Client-side resize closes the user-facing bug at lower cost than a backend refactor (no new endpoints, no Convex changes). For typical ad inputs (product photos, lifestyle shots), 2048×2048 JPEG q=0.92 is visually indistinguishable from full-res at viewing size.

**Out of scope (future work)**
- Architectural refactor to upload-then-reference (image IDs in body instead of base64).
- Server-side body-size validation (Vercel's gateway is the de facto enforcer; not defensible if we move to a tier with higher limits).
- Applying the same resize utility to `uploadProductImage` (project-level) — same Vercel limit applies; small follow-up.

## 2026-04-28 — Templates flow: drop Drive sync, add multi-file direct upload (up to 500 at a time)

**What changed**
- `frontend/src/components/TemplateImages.jsx`: removed the Drive Templates section entirely. Replaced single-file upload with multi-file batch upload — `<input multiple>`, drag-drop accepts multiple files. Added sliding-window concurrency (5 in flight at a time, not chunked rounds). Progress UI: bar + "X of Y" + failure counter. Cancel button via AbortController. Per-file failure summary with reasons (unsupported format / exceeds 20 MB / too large for upload (server limit) / network error). Hard cap of 1000 files per session. Incremental gallery append on each successful upload (no full reload at end). Dropped the now-unused `inspirationFolderId` prop.
- `frontend/src/api.js`: `uploadTemplate` extended with optional `signal` for AbortController support. Backwards-compatible with existing string-`description` callers (BatchManager). Treats Vercel HTTP 413 (gateway-rejected) specifically as "too large for upload (server limit)" rather than a generic JSON-parse error.
- `frontend/src/components/AdStudio.jsx`: empty-state message and "Random from Templates Folder" copy no longer mention Google Drive — both now reference uploaded templates.
- `frontend/src/components/BatchManager.jsx`: same template-messaging update in two locations (random-template hint + no-templates empty state).
- `frontend/src/pages/ProjectDetail.jsx`: dropped the `inspirationFolderId` prop passed to `<TemplateImages />`.

**Why**
- Marco couldn't connect Google Drive in the UI to sync templates — the Drive UI never existed (only backend routes + an unused `DriveFolderPicker` component). The original Drive integration assumed a service-account JSON on disk, which doesn't fit Vercel's read-only serverless filesystem. Rather than build out a full Convex-backed service-account flow, the user opted to drop Drive from the templates flow entirely and use direct multi-file upload (up to 500 at a time, the practical ceiling for a single user session).
- Concurrency = 5 is a starting heuristic — tunable in `UPLOAD_CONCURRENCY` constant. Drop to 3 if Vercel rate-limits or Convex throttles; raise if uploads feel slow and there's headroom.

**Out of scope (deliberate v1 choices)**
- Client-side image resize for files >4 MB (Vercel Hobby gateway limit). v1 surfaces 413s clearly so the user can resize externally.
- In-place "Retry failed" button. v1 reports failures; user re-selects files manually to retry.
- Pre-upload review modal ("X selected, Y will be skipped, proceed?"). Goes straight to upload.
- ETA display, gallery virtualization, backend hash dedup, full Drive UI revival.

**Inspiration sync left intact**
- The separate `InspirationFolder.jsx` flow (uses `drive_folder_id` per project) still references Drive sync. Not touched in this change. The unused `DriveFolderPicker.jsx` component and `api.driveStatus`/`api.driveFolders` methods are kept since `DriveFolderPicker` may be reachable from `InspirationFolder` setup.

## 2026-04-28 — Vercel function bundling fix + production topology lock-in

**What changed**
- `vercel.json`: added `"includeFiles": "backend/services/prompts/**"` to the `api/index.js` function config so Vercel's NFT bundler always ships the prompt text files with the serverless function.
- Locked the topology fact: **Vercel is the only production deployment for Creative Factory.** The VPS deploy script (`deploy/deploy.sh`, target `daciaautomation.com`) is not used by any actual user for this project. Future work should target Vercel only.

**Why**
- Marco was still seeing the OLD Step 2 prompt because (a) my prior two commits (Step 1 fix + Step 2 swap) were deployed only to the unused VPS, and (b) Vercel auto-deploy from GitHub had silently stopped triggering ~4 days prior — last successful Vercel deployment was 2026-04-24, and the new `fs.readFileSync` for the .txt file would not have been bundled by NFT anyway because the path is dynamic. The `includeFiles` glob makes the bundling explicit and future-proofs any new file added to `backend/services/prompts/`.
- Recorded the Vercel-only fact in this changelog so future debugging doesn't waste cycles on the VPS deployment.

**What was tried that didn't work**
- Two prior `deploy.sh` runs to the VPS (commits f547a2e, 621f3d0) — code is live on the VPS but no user sees it.
- Relying on Vercel auto-deploy from git push — broken since 2026-04-24, separate concern from this fix.

**Auto-deploy verification**
- Vercel git integration confirmed connected via API (`link.type: github`, `link.repo: iwilsonm/creative-factory-software`, `productionBranch: main`).
- Pushing this commit to test whether GitHub webhook fires a `via GIT` deployment.

## 2026-04-27 — Step 2 prompt replaced with deep-research teaching transcript

**What changed**
- Created `backend/services/prompts/research-methodology.txt` (~80,000 chars) containing Marco's existing deep-research teaching transcript: "Research Part 1" (framework walkthrough — demographic / existing solutions / curiosity / corruption) and "Research Part 2" (a fully worked weight-loss research example).
- `backend/services/docGenerator.js`: `prompt2_ResearchMethodology()` now reads the prompt body from the .txt file once at module load instead of inlining a JS template literal. Added `fs` / `path` / `fileURLToPath` imports per the pattern in `adGenerator.js`.
- `backend/routes/documents.js`: Updated Step 2 `instruction` to "...deep research methodology with a fully worked example" (was "...4-layer research framework") to match the new transcript content.

**Why**
- Ian wanted the Step 2 prompt to be Marco's research methodology training transcript rather than the previous condensed 4-layer framework. The transcript walks the model through the methodology with a complete real-world example, which produces a richer Step 2 response in the manual flow and feeds more grounded context into the auto-gen flow's downstream steps.
- Loading from a .txt file avoids embedding ~80k characters of dialogue-heavy text as a JS template literal (which would be a quote-escaping nightmare) and makes future prompt edits trivial — just edit the .txt file.

**What was tried that didn't work**
- N/A — single-pass change.

## 2026-04-27 — Step 1 prompt: PDF-attach instruction + remove fallback string

**What changed**
- `backend/services/docGenerator.js`: `prompt1_AnalyzeSalesPage` now omits the trailing content block entirely when `salesPageContent` is empty/null instead of inserting placeholder text. Removed the `|| 'No sales page content provided.'` fallback at the 3 internal call sites (auto-gen step 1, re-run deep research, manual research synthesis).
- `backend/routes/documents.js`: `/research-prompts` Step 1 — removed the same fallback at the call site, rewrote the `instruction` text to tell the user to create a PDF of their PDP and attach it alongside the prompt, and added an optional `tip` field `{ text, linkLabel, linkUrl }` pointing to https://webtopdf.com/.
- `frontend/src/components/FoundationalDocs.jsx`: renders the optional `tip` as an italic line beneath the instruction with a clickable gold link. `e.stopPropagation()` prevents the link click from collapsing the expanded card.

**Why**
- Users picking "Generate with Prompts" with no `sales_page_content` saw a literal "No sales page content provided." inside the copyable Step 1 prompt — confusing and made the system look unfinished.
- The new flow is clearer: the user attaches a PDP PDF in their ChatGPT/Claude conversation alongside the prompt, which matches the prompt's existing wording ("I'm going to send you a PDF screenshot..."). The webtopdf.com tip gives them a concrete way to produce the PDF.

**What was tried that didn't work**
- N/A — single-pass change.

# Ad Creative Automation Platform — CLAUDE.md

> Context file for Claude Code. Read this before making any changes.

---

## 1. Before You Edit

**Stop and check the dependency map** (Section 4) before modifying any shared module, pipeline stage, or state shape. Grep for any identifier you're about to rename. Trace the full chain:

```
Convex schema → Convex function → convexClient.js mapper + whitelist → route handler → api.js method → React component
```

A single renamed field, changed function signature, or modified data shape can silently break 10-40 downstream files. The dependency map tells you exactly which files to check.

---

## 2. Project Overview

### What It Does

A single-tenant web app for direct response copywriters and e-commerce brands. Seven core workflows:

1. **Foundational Doc Generation** — 8-step research pipeline (GPT-4.1 + o3-deep-research) producing customer avatars, offer briefs, and belief documents from a product's sales page.
2. **Quote Mining & Headlines** — Dual-engine search (Perplexity Sonar Pro + Claude Opus 4.6) extracting emotional quotes from online communities, then headline generation via Claude Sonnet 4.6 with 3 reference copywriting docs.
3. **Static Image Ad Generation** — GPT-5.2 creative direction + Gemini 3 Pro image generation, single or automated batch via cron schedule.
4. **Ad Pipeline & Meta Integration** — 3-stage deployment pipeline (Planner -> Ready to Post -> Posted) with campaign hierarchy, flex ads, per-project Meta Ads OAuth, performance data sync.
5. **Landing Page Generation** — Copy + design + HTML generation via Claude Sonnet, Opus editorial pass, Visual QA with auto-fix loop, split-panel editor, CTA management, one-click publish to Shopify.
6. **Landing Page Template Extraction** — Puppeteer capture + Claude vision analysis to extract reusable HTML skeleton templates from any URL.
7. **Autonomous Agent System** — Three agents (Fixer, Creative Filter, Director) that auto-test, auto-heal, score ads, create flex ads, plan batches, auto-generate LPs, and learn from results.

**Live at**: `thrive-digital-marketing-ad-generat.vercel.app` (Vercel Pro)
**Convex deployments**: local dev `dev:impartial-shrimp-656` at `https://impartial-shrimp-656.convex.cloud`; production `prod:cheery-cobra-258` at `https://cheery-cobra-258.convex.cloud` (dedicated Thrive Digital Marketing project)
**GitHub**: Thrive Digital Marketing fork (auto-deploy from main → Vercel)

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite 5.4 + Tailwind CSS 3.4 + React Router 6 |
| Backend | Node.js 22 LTS + Express 4.21 |
| Database | Convex (cloud-hosted, schema-enforced, 29 tables) |
| File Storage | Convex blob storage |
| LLM (text) | OpenAI — GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research |
| LLM (copy) | Anthropic — Claude Opus 4.6, Claude Sonnet 4.6 |
| LLM (search) | Perplexity Sonar Pro |
| LLM (images) | Google Gemini 3 Pro Image Preview via `@google/genai` SDK |
| External | Google Drive API v3 (service account); Meta Marketing API v21.0 (per-project OAuth); Shopify Admin API (per-project, for LP publishing); Cloudflare Pages API |
| Auth | bcrypt + express-session + Convex-backed session store + role-based access (Admin/Manager/Poster) |
| Security | helmet (CSP), express-rate-limit, SSRF protection, field whitelisting |
| Scheduling | Inline service calls during Director runs (`creativeFilterService.js`); the legacy `scheduler.js` cron poll-loop is gated off in Vercel via `if (!process.env.VERCEL)` |
| Hosting | **Vercel Pro** — serverless functions, `maxDuration: 300s`, `api/index.js` is the catch-all Express handler; `api/health.js` is a separate stub |

### Deployment

**Hosting**: Vercel Pro. Auto-deploys on `git push origin main`. Function `maxDuration: 300s` is configured in `vercel.json` (handles 18-ad batches comfortably; Phase 4's sub-angle generation may need 800s with Fluid Compute).

**Frontend + Backend**: ship together via `git push origin main`. Vercel handles install + build + deploy.

**Convex (schema/function changes) — SEPARATE STEP**: run from your local machine, not from any VPS.
```bash
npx convex dev --once --typecheck=disable   # dev deploy + sanity-check
# OR
npx convex deploy -y                         # prod deploy (when CONVEX_DEPLOY_KEY is set)
```
Convex deploys are independent of Vercel — they push schema + functions directly to the Convex cloud. Always run after schema changes.

**Adding a New npm Dependency**: edit `backend/package.json` or `frontend/package.json`, commit, push. Vercel reinstalls on every deploy.

**About the legacy `dacia-creative-filter/` and `dacia-fixer/` directories**: bash scripts (`filter.sh`, `fixer.sh`) inside these folders were the original execution model when the system ran on a separate VPS. **They do not run anywhere in the Vercel deployment.** The actual Filter logic now lives in `backend/services/creativeFilterService.js` (a Node.js port called inline during Director runs). The dirs remain because `backend/routes/agentMonitor.js` reads log paths inside them for the Agent Dashboard UI; deleting the dirs would break that page. Treat the bash scripts themselves as fossils.

### Settings

All API keys and config are stored in the Convex `settings` table (not .env):

| Setting | Purpose |
|---------|---------|
| `openai_api_key` | OpenAI API access |
| `anthropic_api_key` | Anthropic API access |
| `gemini_api_key` | Google Gemini API access |
| `perplexity_api_key` | Perplexity API access |
| `session_secret` | Auto-generated 64-char hex for express-session |
| `drive_folder_id` | Root Google Drive folder |
| `cloudflare_account_id`, `cloudflare_api_token`, `cloudflare_pages_project` | Cloudflare Pages |
| `gemini_rate_*` | Gemini pricing rates (auto-refreshed daily) |
| `headline_ref_1`, `headline_ref_2`, `headline_ref_3` | Reference copywriting docs for headlines |

Vercel env vars (set via Vercel project settings, not `.env`): `CONVEX_URL=https://cheery-cobra-258.convex.cloud`. Most secrets live in the Convex `settings` table (auto-loaded at runtime). Do not set `VITE_APP_BASE` on Vercel; the app is hosted at `/`. Set `VITE_APP_BASE=/admin/` only for the legacy VPS/Nginx admin deployment.

On disk (gitignored): `config/service-account.json` (Google Drive service account; deployed via Vercel build).

### Styling

**Color tokens** (defined in `frontend/tailwind.config.js`):
- `navy` (#0B1D3A) / `navy-light` (#132B52) / `navy-mid` (#1A3A6B) — Primary brand, navbar, buttons, headings
- `gold` (#C4975A) / `gold-light` (#D4AA6A) — Accent, hover states, links
- `teal` (#2A9D8F) — Success states
- `offwhite` (#FAFAF8) — Page backgrounds
- `cream` (#F4F1EB) — Alternative background
- `textdark` (#1A1A2E) / `textmid` (#4A5568) / `textlight` (#8A96A8) — Text hierarchy

**Data viz colors**: OpenAI=#5B8DEF, Anthropic=#7C6DCD, Gemini=#2A9D8F, Perplexity=#C4975A

**CSS classes** (in `frontend/src/index.css`): `.glass-nav`, `.card`, `.btn-primary`, `.btn-secondary`, `.input-apple`, `.segmented-control`, `.badge`, `.info-tooltip`

**Font**: DM Sans (fallback: system-ui, sans-serif)

**Shadows**: `card` (0 2px 12px), `card-hover` (0 4px 20px), `gold` (gold glow), `nav` (subtle), `pill` (layered)

---

## 3. Architecture & Data Flow

### Layer Diagram

```
Browser -> Vercel CDN -> Vercel serverless function (api/index.js)
                            -> Express app -> Convex Cloud
                                            -> OpenAI API
                                            -> Anthropic API
                                            -> Google Gemini API
                                            -> Perplexity API
                                            -> Google Drive API
                                            -> Meta Marketing API
                                            -> Shopify Admin API
                                            -> Cloudflare Pages API

Inline Filter (creativeFilterService.js, called during Director runs)
Inline Director (conductorEngine.js, triggered manually or via batch routes)
```

Note: legacy bash scripts in `dacia-creative-filter/filter.sh` and `dacia-fixer/fixer.sh` do not run in Vercel — they were originally invoked by VPS cron in a previous deployment model. The Filter logic is now inlined via `creativeFilterService.js`.

Frontend calls `api.js` methods -> Express route handlers -> services call LLM APIs + Convex mutations -> results stored in Convex -> frontend fetches updated data.

### Data Pipelines

**1. Foundational Docs** (SSE stream)
`FoundationalDocs.jsx` -> `api.generateDocs()` -> `routes/documents.js` -> `docGenerator.js` -> GPT-4.1 analysis (3 steps) -> o3-deep-research (30min timeout) -> GPT-4.1 synthesis (Avatar -> Offer Brief -> Beliefs) -> `foundational_docs` table

**2. Ad Generation** (SSE stream)
`AdStudio.jsx` -> `api.generateAd()` -> `routes/ads.js` -> `adGenerator.js` -> GPT-5.2 creative direction -> GPT-5.2 vision -> Gemini 3 Pro image -> `ad_creatives` table

**3. Batch Pipeline** (4-stage, async)
`BatchManager.jsx` -> `api.createBatch()` / `api.runBatch()` -> `routes/batches.js` -> `batchProcessor.js`:
Stage 0: Brief extraction (Claude Opus) -> Stage 1: Headlines (Claude Opus) -> Stage 2: Body copy (Claude Sonnet, batches of 5) -> Stage 3: Image prompts (Claude Sonnet) -> Gemini Batch API -> scheduler polls every 5min -> `ad_creatives` table

**4. Ad Deployment** (state machine)
`CampaignsView.jsx` (Planner) -> `ReadyToPostView.jsx` -> `PostedView.jsx`
Status flow: `"selected"` -> `"ready_to_post"` -> `"posted"` -> `"analyzing"`

**5. Quote Mining** (SSE stream)
`QuoteMiner.jsx` -> `api.startQuoteMining()` -> `routes/quoteMining.js` -> `quoteBankService.js` -> parallel: Perplexity Sonar Pro + Claude Opus 4.6 -> merge + dedup -> `quote_bank` -> per-quote headline generation (Claude Sonnet)

**6. Landing Page — Manual** (SSE stream)
`LPGen.jsx` -> `api.generateLandingPage()` -> `routes/landingPages.js` -> `lpGenerator.js`:
1. Swipe capture (`lpSwipeFetcher.js`, Puppeteer)
2. Design analysis (`analyzeSwipeDesign`, Claude Sonnet vision)
3. Copy generation (`generateLandingPageCopy`, Claude Sonnet multi-turn)
4. Image generation (`generateSlotImages`, Gemini 3 Pro)
5. HTML template generation (`generateHtmlTemplate`, Claude Sonnet)
6. Assembly (`assembleLandingPage`) + post-processing (`postProcessLP`)
7. Visual QA (`runVisualQA`, Puppeteer + Claude vision) + auto-fix loop (`autoFixLP`)
-> `landing_pages` table -> [publish: Shopify Pages]

**6b. Landing Page — Auto-Generation** (Director-triggered, fire-and-forget)
Director creates batch -> `lpAutoGenerator.js:triggerLPGeneration()`:
1. Load templates + select 2 different narrative frames
2. For each LP: load template skeleton -> copy gen (Claude Sonnet) -> Opus editorial pass -> image gen with product reference (Gemini) -> HTML template (Claude Sonnet + editorial plan) -> assembly + post-processing
3. Visual QA loop (up to 3 attempts with `lpAutoFixer.js` fixes)
4. Publish to Shopify + smoke test (`lpSmokeTest.js`, 7 automated checks)
5. Update batch record with LP IDs, URLs, statuses
-> `landing_pages` table + batch `lp_primary_*` / `lp_secondary_*` fields

**6c. Landing Page — Template Extraction** (SSE stream)
`LPTemplateManager.jsx` -> `api.extractLPTemplate()` -> `routes/lpTemplates.js` -> `lpTemplateExtractor.js`:
1. Puppeteer capture (`lpSwipeFetcher.js`)
2. Claude Sonnet vision structural analysis
3. Parse into skeleton_html + design_brief + slot_definitions
-> `lp_templates` table

**7. Agent Pipeline** (autonomous, cron-triggered)
Director (scheduler, 3x/day) -> creates batches with angle prompts -> batch pipeline runs -> **LP Agent** (auto-generates 2 advertorials per batch) -> Filter (cron, every 30min) -> scores completed batch ads -> groups into flex ads -> deploys to Ready to Post -> triggers learning step -> Fixer (cron, every 5min) -> tests, diagnoses failures, auto-fixes, resurrects batches

### LP Post-Processing Pipeline (`postProcessLP`)

This pipeline runs on every LP save (backend PUT endpoint) and during generation. Order matters:

1. **Metadata replacement** — Fill `{{author_name}}`, `{{publish_date}}`, `{{warning_text}}`, `{{batch_angle}}` from project/agent config
2. **Catch-all placeholder strip** — Remove any remaining `{{...}}` placeholders
3. **Contrast safety CSS injection** — `injectContrastSafetyCSS()` adds `<style data-safety="contrast">` block ensuring white text on dark backgrounds. Three-layer approach: (1) CSS attribute selectors for inline `background-color:` and `background:` shorthand, (2) parses `<style>` blocks to find class-based dark backgrounds and generates override rules, (3) inline style pass to fix dark-on-dark elements. Idempotent: checks for `data-safety="contrast"` marker.
4. **Duplicate callout heading fix** — Removes duplicate `<h2>` from `<aside>` elements
5. **Generic testimonial attribution fix** — Replaces generic "Customer" names with project author_name
6. **Testimonial deduplication** — Text-content-based: strips HTML, splits into sentences, finds duplicates >= 50 chars, removes second occurrence's container
7. **Empty element cleanup** — Removes empty `<p>`, `<div>`, etc.

**Critical**: The frontend `assembleHtmlClient()` in `LPGen.jsx` rebuilds HTML from raw `htmlTemplate` + copy sections, which strips all post-processing. The backend PUT endpoint strips any existing contrast CSS then re-applies via `injectContrastSafetyCSS()`. The frontend also injects a simplified contrast CSS for editor preview.

### Paths That Must Stay in Sync

| If you change... | Also update... |
|------------------|----------------|
| Convex schema field name | Convex function file, `convexClient.js` mapper + whitelist, route handler, `api.js`, React component |
| Deployment status values | `convex/ad_deployments.ts`, `backend/convexClient.js`, `backend/routes/deployments.js`, `frontend/src/components/CampaignsView.jsx`, `frontend/src/components/ReadyToPostView.jsx`, `frontend/src/components/PostedView.jsx`, `dacia-creative-filter/filter.sh` |
| `flex_ads` field shape | `convex/flexAds.ts`, `backend/convexClient.js`, `frontend/src/components/CampaignsView.jsx`, `frontend/src/components/ReadyToPostView.jsx`, `dacia-creative-filter/filter.sh` |
| LLM wrapper function signature | Every service that calls it (see dependency map) |
| `api.js` method name or params | Every frontend file that calls it (see dependency map) |
| SSE event format | Backend route + frontend `onEvent` handler in the corresponding component |
| Error response shape | All route handlers use `{ error: msg }` for errors, `{ success: true }` for mutations |
| Cascade deletion logic | `convex/campaigns.ts`, `convex/adSets.ts` — any new parent-child entity must cascade |
| Agent authentication flow | `dacia-creative-filter/filter.sh` + `dacia-fixer/fixer.sh` both use session cookie with 24h expiry + auto-re-auth |
| LP post-processing pipeline | `backend/services/lpGenerator.js:postProcessLP()`, `backend/routes/landingPages.js` PUT safety net, `frontend/src/components/LPGen.jsx:assembleHtmlClient()` |
| LP template slot format | `backend/services/lpTemplateExtractor.js`, `backend/services/lpGenerator.js`, `frontend/src/components/LPGen.jsx` CopySection/ImageSlot structures |
| `req.user` shape | `backend/auth.js` populates it; all 17 route files depend on `{ id, username, role, displayName }` |
| Agent model names | `dacia-fixer/config/fixer.conf`, `dacia-creative-filter/config/filter.conf`, agent scripts |
| Backend port | `deploy/ecosystem.config.cjs`, `deploy/nginx.conf`, `frontend/vite.config.js` proxy |

### Route Endpoints

| Route File | Mount Path | Auth | Role |
|------------|-----------|------|------|
| `routes/auth.js` | `/api/auth` | None (login/setup) / `requireAuth` (password change) | None |
| `routes/users.js` | `/api/users` | `requireAuth` | `admin` |
| `routes/settings.js` | `/api/settings` | `requireAuth` | `admin` |
| `routes/projects.js` | `/api/projects` | `requireAuth` | `admin`, `manager` (CUD) |
| `routes/documents.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/upload.js` | `/api/upload` | `requireAuth` | `admin`, `manager` |
| `routes/drive.js` | `/api/drive` + `/api/projects` (inspiration) | `requireAuth` | `admin`, `manager` |
| `routes/templates.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/ads.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/batches.js` | `/api/projects` + `/api/batches` (flat for Fixer) | `requireAuth` | `admin`, `manager` |
| `routes/costs.js` | `/api` | `requireAuth` | `admin`, `manager` |
| `routes/quoteMining.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/chat.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/meta.js` | `/api` | `requireAuth` | `admin`, `manager` |
| `routes/landingPages.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/lpTemplates.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/deployments.js` | `/api` | `requireAuth` | varies (poster can update status/posted-by) |
| `routes/agentMonitor.js` | `/api/agent-monitor` | `requireAuth` | `admin` |
| `routes/conductor.js` | `/api/conductor` | `requireAuth` | `admin`, `manager` |
| `routes/lpAgent.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| Server direct: `/api/health` | `/api/health` | None | None |
| Server direct: `/api/agent-cost` | `/api/agent-cost` | `localhostOnly` | None |

Rate-limited endpoints (10 req/min per user): `/generate-docs`, `/generate-ad`, `/generate-landing-page`, `/generate-ad-copy`, `/generate-ad-headlines`, `/filter/generate-copy`, `/quote-mining/start`, `/conductor/run`, `/conductor/learn`, `/lp-agent/generate-test`, `/lp-agent/shopify/connect`

### Agent System

**Director** (`backend/services/conductorEngine.js`) — Plans batches and selects angles. Runs via scheduler at 7 AM, 7 PM, 1 AM ICT. Config in `conductor_config` table per project. Supports focus mode: when any active angle has `focused=true`, only focused angles are selected.

**LP Agent** (`backend/services/lpAutoGenerator.js`, `backend/services/lpGenerator.js`) — Generates two advertorials per batch with different narrative frames. Uses Opus 4.6 editorial pass for strategic content decisions. Passes project product images as reference for hero/product image slots. Publishes to Shopify. Visual QA with auto-fix loop (up to 3 attempts). Smoke test (7 automated checks). Config in `lp_agent_config` table per project. Triggered by Director after batch creation.

**Creative Filter** (`backend/services/creativeFilterService.js` — Node.js port; the bash version in `dacia-creative-filter/filter.sh` is a legacy fossil that does not run in Vercel). Scores completed batch ads via Claude Sonnet vision. Phase 1+: writes `filter_score`/`filter_verdict`/`filter_reasons` to `ad_creatives` and flips status to `staging` (passed) or `quality_rejected` (rejected) — driving the Staging Page lifecycle. Pre-Phase-1 behavior also created `flex_ads` (now wiped from CF). Runs inline during Director batch processing.

**Fixer** (legacy bash agent at `dacia-fixer/fixer.sh` — does not run in Vercel; preserved as a directory because `agentMonitor.js` reads log paths from inside it for the Agent Dashboard UI). Originally ran every 5 min via VPS cron with health probes + auto-fix capability. Currently dormant; no equivalent Node port exists yet.

Filter and Fixer agents use: lock files (`/tmp/dacia-{agent}.lock` with PID check), `flock` for atomic spend file reads/writes, session cookie auth with 24h expiry + auto-re-auth, daily log rotation.

### Scheduler (7 Automated Tasks)

1. Poll active batches every 5 min + auto-retry up to 3x
2. Sync OpenAI costs hourly from billing API
3. Purge soft-deleted records >30 days daily at 1am
4. Refresh Gemini rates daily at midnight
5. Sync Meta performance every 30 min per-project
6. Refresh Meta tokens weekly Monday 3am
7. Director runs (7 AM, 7 PM, 1 AM ICT)

Plus user-defined cron schedules for recurring batches.

### Convex Relationship Map

```
projects
  +-- foundational_docs (project_id)
  +-- ad_creatives (project_id)
  |     +-- batch_jobs (ad_creatives.batch_job_id)
  +-- campaigns (project_id)
  |     +-- ad_sets (campaign_id)
  |           +-- flex_ads (ad_set_id)
  +-- ad_deployments (project_id, ad_id)
  |     +-- meta_performance (deployment_id)
  +-- quote_mining_runs (project_id)
  |     +-- quote_bank (run_id)
  +-- template_images (project_id)
  +-- inspiration_images (project_id, composite key)
  +-- chat_threads (project_id)
  |     +-- chat_messages (thread_id)
  +-- landing_pages (project_id)
  |     +-- landing_page_versions (landing_page_id)
  +-- lp_templates (project_id)
  +-- correction_history (project_id)
  +-- conductor_config (project_id, PK)
  +-- conductor_angles (project_id)
  +-- conductor_runs (project_id)
  +-- conductor_playbooks (project_id)
  +-- lp_agent_config (project_id, PK)
```

Standalone tables: `settings`, `users`, `sessions`, `api_costs`, `dashboard_todos`, `conductor_health`, `fixer_playbook`, `file_storage`

---

## 4. Dependency Map

Every shared module imported by 3+ production files. Every file path listed. Organized by consumer count descending.

### `backend/convexClient.js` — 47 files

Central data layer. 1400+ lines, 140+ helper functions, mapper functions (`convexProjectToRow`, `convexAdToRow`, `convexBatchToRow`, `convexDocToRow`, `convexLPTemplateToRow`), field whitelists for all update operations.

* `backend/convexClient.js` → used by:
  - `backend/server.js`
  - `backend/auth.js`
  - `backend/ConvexSessionStore.js`
  - `backend/routes/ads.js`
  - `backend/routes/agentMonitor.js`
  - `backend/routes/auth.js`
  - `backend/routes/batches.js`
  - `backend/routes/chat.js`
  - `backend/routes/conductor.js`
  - `backend/routes/costs.js`
  - `backend/routes/deployments.js`
  - `backend/routes/documents.js`
  - `backend/routes/drive.js`
  - `backend/routes/landingPages.js`
  - `backend/routes/lpAgent.js`
  - `backend/routes/lpTemplates.js`
  - `backend/routes/meta.js`
  - `backend/routes/projects.js`
  - `backend/routes/quoteMining.js`
  - `backend/routes/settings.js`
  - `backend/routes/templates.js`
  - `backend/routes/users.js`
  - `backend/services/adGenerator.js`
  - `backend/services/anthropic.js`
  - `backend/services/batchProcessor.js`
  - `backend/services/conductorAngles.js`
  - `backend/services/conductorEngine.js`
  - `backend/services/conductorLearning.js`
  - `backend/services/correctionHistory.js`
  - `backend/services/costTracker.js`
  - `backend/services/docGenerator.js`
  - `backend/services/gemini.js`
  - `backend/services/headlineGenerator.js`
  - `backend/services/lpAutoFixer.js`
  - `backend/services/lpAutoGenerator.js`
  - `backend/services/lpGenerator.js`
  - `backend/services/lpPublisher.js`
  - `backend/services/lpSwipeFetcher.js`
  - `backend/services/lpTemplateExtractor.js`
  - `backend/services/metaAds.js`
  - `backend/services/openai.js`
  - `backend/services/quoteBankService.js`
  - `backend/services/quoteDedup.js`
  - `backend/services/quoteMiner.js`
  - `backend/services/scheduler.js`
  - `backend/utils/adImages.js`

---

### `frontend/src/api.js` — 26 files

164 API methods. Base `request()` fetch wrapper with auto-redirect on 401. `streamSSE()` and `streamSSEWithBody()` for SSE endpoints. No external dependencies.

* `frontend/src/api.js` → used by:
  - `frontend/src/App.jsx`
  - `frontend/src/pages/Login.jsx`
  - `frontend/src/pages/Dashboard.jsx`
  - `frontend/src/pages/Projects.jsx`
  - `frontend/src/pages/ProjectSetup.jsx`
  - `frontend/src/pages/ProjectDetail.jsx`
  - `frontend/src/pages/Settings.jsx`
  - `frontend/src/pages/AdTracker.jsx`
  - `frontend/src/components/Layout.jsx`
  - `frontend/src/components/AdStudio.jsx`
  - `frontend/src/components/BatchManager.jsx`
  - `frontend/src/components/FoundationalDocs.jsx`
  - `frontend/src/components/TemplateImages.jsx`
  - `frontend/src/components/QuoteMiner.jsx`
  - `frontend/src/components/CopywriterChat.jsx`
  - `frontend/src/components/ReadyToPostView.jsx`
  - `frontend/src/components/CampaignsView.jsx`
  - `frontend/src/components/PostedView.jsx`
  - `frontend/src/components/LPGen.jsx`
  - `frontend/src/components/LPAgentSettings.jsx`
  - `frontend/src/components/LPTemplateManager.jsx`
  - `frontend/src/components/InspirationFolder.jsx`
  - `frontend/src/components/DriveFolderPicker.jsx`
  - `frontend/src/components/DragDropUpload.jsx`
  - `frontend/src/components/AgentMonitor.jsx`
  - `frontend/src/components/CreativeFilterSettings.jsx`

---

### `backend/auth.js` — 17 files

Exports: `requireAuth`, `requireRole(...roles)`, `isSetupComplete()`, `migrateToMultiUser()`. Populates `req.user` with shape `{ id, username, role, displayName }`.

* `backend/auth.js` → used by:
  - `backend/routes/ads.js`
  - `backend/routes/auth.js`
  - `backend/routes/batches.js`
  - `backend/routes/chat.js`
  - `backend/routes/costs.js`
  - `backend/routes/deployments.js`
  - `backend/routes/documents.js`
  - `backend/routes/drive.js`
  - `backend/routes/landingPages.js`
  - `backend/routes/lpTemplates.js`
  - `backend/routes/meta.js`
  - `backend/routes/projects.js`
  - `backend/routes/quoteMining.js`
  - `backend/routes/settings.js`
  - `backend/routes/templates.js`
  - `backend/routes/upload.js`
  - `backend/routes/users.js`

---

### `backend/services/retry.js` — 14 files

Exports: `withRetry`, `isRateLimitError`, `defaultShouldRetry`. Does NOT retry 4xx except 429. 429 uses 15s base delay.

* `backend/services/retry.js` → used by:
  - `backend/convexClient.js`
  - `backend/routes/chat.js`
  - `backend/routes/drive.js`
  - `backend/routes/lpAgent.js`
  - `backend/services/anthropic.js`
  - `backend/services/batchProcessor.js`
  - `backend/services/costTracker.js`
  - `backend/services/gemini.js`
  - `backend/services/headlineGenerator.js`
  - `backend/services/lpPublisher.js`
  - `backend/services/metaAds.js`
  - `backend/services/openai.js`
  - `backend/services/quoteMiner.js`
  - `backend/utils/adImages.js`

---

### `frontend/src/components/Toast.jsx` — 13 files

Exports: `ToastProvider`, `useToast()` hook. Methods: `toast.success()`, `toast.error()`, `toast.info()`, `toast.undo(action)`.

* `frontend/src/components/Toast.jsx` → used by:
  - `frontend/src/App.jsx`
  - `frontend/src/pages/Projects.jsx`
  - `frontend/src/pages/ProjectDetail.jsx`
  - `frontend/src/pages/Settings.jsx`
  - `frontend/src/pages/AdTracker.jsx`
  - `frontend/src/components/AdStudio.jsx`
  - `frontend/src/components/BatchManager.jsx`
  - `frontend/src/components/FoundationalDocs.jsx`
  - `frontend/src/components/LPGen.jsx`
  - `frontend/src/components/LPAgentSettings.jsx`
  - `frontend/src/components/LPTemplateManager.jsx`
  - `frontend/src/components/QuoteMiner.jsx`
  - `frontend/src/components/CreativeFilterSettings.jsx`

---

### `backend/services/costTracker.js` — 11 files

Exports: `logAnthropicCost`, `logOpenAICost`, `logPerplexityCost`, `logGeminiCost`, `syncOpenAICosts`, `refreshGeminiRates`, `getCostSummary`, `getCostHistoryData`, `getRecurringBatchCostEstimate`. Callers pass `{ operation, projectId }`.

* `backend/services/costTracker.js` → used by:
  - `backend/server.js`
  - `backend/routes/chat.js`
  - `backend/routes/costs.js`
  - `backend/routes/settings.js`
  - `backend/services/anthropic.js`
  - `backend/services/batchProcessor.js`
  - `backend/services/gemini.js`
  - `backend/services/headlineGenerator.js`
  - `backend/services/openai.js`
  - `backend/services/quoteMiner.js`
  - `backend/services/scheduler.js`

---

### `backend/services/anthropic.js` — 11 files

Exports: `chat`, `chatWithImage`, `chatWithMultipleImages`. Claude Opus 4.6 + Sonnet 4.6 wrapper with retry logic and automatic cost tracking.

* `backend/services/anthropic.js` → used by:
  - `backend/routes/ads.js`
  - `backend/routes/deployments.js`
  - `backend/services/adGenerator.js`
  - `backend/services/conductorAngles.js`
  - `backend/services/conductorLearning.js`
  - `backend/services/docGenerator.js`
  - `backend/services/lpAutoFixer.js`
  - `backend/services/lpGenerator.js`
  - `backend/services/lpTemplateExtractor.js`
  - `backend/services/quoteMiner.js`

---

### `frontend/src/components/InfoTooltip.jsx` — 9 files

Pure CSS hover tooltip. Props: `text`, `position` (top/bottom/left/right).

* `frontend/src/components/InfoTooltip.jsx` → used by:
  - `frontend/src/pages/Dashboard.jsx`
  - `frontend/src/pages/Projects.jsx`
  - `frontend/src/pages/ProjectDetail.jsx`
  - `frontend/src/pages/Settings.jsx`
  - `frontend/src/components/AdStudio.jsx`
  - `frontend/src/components/BatchManager.jsx`
  - `frontend/src/components/FoundationalDocs.jsx`
  - `frontend/src/components/LPGen.jsx`
  - `frontend/src/components/TemplateImages.jsx`

---

### `backend/services/openai.js` — 8 files

Exports: `chat`, `chatStream`, `deepResearch`, `chatWithImage`, `chatWithImages`. GPT-5.2, GPT-4.1, o3-deep-research wrapper with retry + cost tracking.

* `backend/services/openai.js` → used by:
  - `backend/routes/templates.js`
  - `backend/routes/upload.js`
  - `backend/services/adGenerator.js`
  - `backend/services/bodyCopyGenerator.js`
  - `backend/services/docGenerator.js`
  - `backend/services/quoteDedup.js`
  - `backend/services/quoteMiner.js`

---

### `backend/utils/sseHelper.js` — 7 files

Exports: `createSSEStream`, `streamService`. SSE stream utilities for all long-running endpoints.

* `backend/utils/sseHelper.js` → used by:
  - `backend/routes/ads.js`
  - `backend/routes/chat.js`
  - `backend/routes/documents.js`
  - `backend/routes/landingPages.js`
  - `backend/routes/lpAgent.js`
  - `backend/routes/lpTemplates.js`
  - `backend/routes/quoteMining.js`

---

### `backend/services/gemini.js` — 6 files

Exports: `generateImage`, `getClient`. Gemini 3 Pro image generation. Rate-limited to concurrency=3.

* `backend/services/gemini.js` → used by:
  - `backend/routes/batches.js`
  - `backend/routes/landingPages.js`
  - `backend/services/adGenerator.js`
  - `backend/services/batchProcessor.js`
  - `backend/services/lpAutoFixer.js`
  - `backend/services/lpGenerator.js`

---

### `frontend/src/hooks/useAsyncData.js` — 6 files

Fetch + loading + error + refetch hook. Returns `{ data, setData, loading, error, refetch, silentRefetch }`.

* `frontend/src/hooks/useAsyncData.js` → used by:
  - `frontend/src/pages/Projects.jsx`
  - `frontend/src/pages/AdTracker.jsx`
  - `frontend/src/components/AdStudio.jsx`
  - `frontend/src/components/FoundationalDocs.jsx`
  - `frontend/src/components/QuoteMiner.jsx`
  - `frontend/src/components/TemplateImages.jsx`

---

### `frontend/src/components/Layout.jsx` — 6 files

Glass navbar + role-based nav links + user badge + logout. Wraps all pages.

* `frontend/src/components/Layout.jsx` → used by:
  - `frontend/src/pages/Dashboard.jsx`
  - `frontend/src/pages/Projects.jsx`
  - `frontend/src/pages/ProjectSetup.jsx`
  - `frontend/src/pages/ProjectDetail.jsx`
  - `frontend/src/pages/Settings.jsx`
  - `frontend/src/pages/AgentDashboard.jsx`

---

### `frontend/src/components/PipelineProgress.jsx` — 5 files

Shared progress bar for all long-running SSE pipelines. Props: `progress` (0-100), `message`, `startTime`. See `.claude/skills/progress-bar-standard/SKILL.md`.

* `frontend/src/components/PipelineProgress.jsx` → used by:
  - `frontend/src/components/BatchRow.jsx`
  - `frontend/src/components/FoundationalDocs.jsx`
  - `frontend/src/components/LPAgentSettings.jsx`
  - `frontend/src/components/LPGen.jsx`
  - `frontend/src/components/QuoteMiner.jsx`

---

### `frontend/src/hooks/usePolling.js` — 5 files

Interval polling hook. Signature: `usePolling(pollFn, intervalMs, enabled)`.

* `frontend/src/hooks/usePolling.js` → used by:
  - `frontend/src/components/AdStudio.jsx`
  - `frontend/src/components/BatchManager.jsx`
  - `frontend/src/components/LPAgentSettings.jsx`
  - `frontend/src/components/LPGen.jsx`
  - `frontend/src/components/QuoteMiner.jsx`

---

### `frontend/src/App.jsx` (AuthContext) — 5 files

Exports: `AuthContext`. Tracks `{ authenticated, loading, user, setAuthenticated, setUser }`.

* `frontend/src/App.jsx` → used by:
  - `frontend/src/pages/Login.jsx`
  - `frontend/src/pages/Projects.jsx`
  - `frontend/src/pages/ProjectDetail.jsx`
  - `frontend/src/components/Layout.jsx`

---

### `backend/services/lpGenerator.js` — 5 files

LP copy + design + HTML generation. Exports: `generateLandingPageCopy`, `generateHtmlTemplate`, `assembleLandingPage`, `postProcessLP`, `injectContrastSafetyCSS`, `runVisualQA`, `autoFixLP`, `generateSlotImages`, `analyzeSwipeDesign`.

* `backend/services/lpGenerator.js` → used by:
  - `backend/routes/landingPages.js`
  - `backend/routes/lpAgent.js`
  - `backend/services/lpAutoFixer.js`
  - `backend/services/lpAutoGenerator.js`
  - `backend/services/lpPublisher.js`

---

### `backend/services/quoteMiner.js` — 4 files

Exports: `runQuoteMining`, `generateSuggestions`, `getAnthropicClient`.

* `backend/services/quoteMiner.js` → used by:
  - `backend/routes/chat.js`
  - `backend/routes/quoteMining.js`
  - `backend/services/headlineGenerator.js`
  - `backend/services/quoteBankService.js`

---

### `backend/services/rateLimiter.js` — 3 files

Exports: `withHeavyLLMLimit` (concurrency=2), `withGeminiLimit` (concurrency=3), `getRateLimiterStats`.

* `backend/services/rateLimiter.js` → used by:
  - `backend/server.js`
  - `backend/services/adGenerator.js`
  - `backend/services/gemini.js`

---

### `backend/services/batchProcessor.js` — 3 files

Exports: `runBatch`, `pollBatchJob`.

* `backend/services/batchProcessor.js` → used by:
  - `backend/routes/batches.js`
  - `backend/services/conductorEngine.js`
  - `backend/services/scheduler.js`

---

### `backend/services/adGenerator.js` — 3 files

Ad generation orchestrator (Mode 1/2). Exports: `generateAd`, `generateAdMode2`.

* `backend/services/adGenerator.js` → used by:
  - `backend/routes/ads.js`
  - `backend/routes/deployments.js`
  - `backend/services/batchProcessor.js`

---

### `backend/services/lpSwipeFetcher.js` — 3 files

Puppeteer page capture + SSRF protection. Exports: `fetchSwipePage`.

* `backend/services/lpSwipeFetcher.js` → used by:
  - `backend/routes/landingPages.js`
  - `backend/services/lpGenerator.js`
  - `backend/services/lpTemplateExtractor.js`

---

### `backend/services/lpPublisher.js` — 3 files

Shopify page deploy + smoke test. Exports: `publishToShopify`, `unpublishFromShopify`.

* `backend/services/lpPublisher.js` → used by:
  - `backend/routes/landingPages.js`
  - `backend/routes/lpAgent.js`
  - `backend/services/lpAutoGenerator.js`

---

### `backend/services/scheduler.js` — 3 files

7 cron tasks + user-defined batch schedules. Exports: `initScheduler`, `getSchedulerStatus`, `registerBatchSchedule`, `unregisterBatchSchedule`.

* `backend/services/scheduler.js` → used by:
  - `backend/server.js`
  - `backend/routes/batches.js`

Note: Also imported internally by `conductorEngine.js` for Director scheduling, but scheduler itself imports `conductorEngine.js`.

---

### `backend/services/metaAds.js` — 3 files

Meta OAuth, token refresh, performance sync. Exports: `getAuthUrl`, `exchangeCodeForToken`, `refreshToken`, `getAdAccounts`, `getCampaigns`, `getAdSets`, `getAds`, `getAdInsights`, `syncPerformance`.

* `backend/services/metaAds.js` → used by:
  - `backend/routes/meta.js`
  - `backend/services/scheduler.js`

---

### `backend/services/lpAutoGenerator.js` — 3 files

Director-triggered LP auto-generation. Exports: `triggerLPGeneration`.

* `backend/services/lpAutoGenerator.js` → used by:
  - `backend/routes/lpAgent.js`
  - `backend/services/conductorEngine.js`

---

### `backend/services/conductorEngine.js` — 3 files

Director batch planning + angle selection. Exports: `runDirector`, `testRunDirector`.

* `backend/services/conductorEngine.js` → used by:
  - `backend/routes/conductor.js`
  - `backend/services/scheduler.js`

---

### `backend/services/conductorLearning.js` — 3 files

Learning from scored ads + adaptive batch sizing. Known bug: `messages.filter is not a function`.

* `backend/services/conductorLearning.js` → used by:
  - `backend/routes/conductor.js`
  - `backend/services/conductorEngine.js`

---

### `frontend/src/components/DragDropUpload.jsx` — 3 files

Reusable file upload with text extraction. Props: `onTextExtracted`, `disabled`, `label`, `accept`.

* `frontend/src/components/DragDropUpload.jsx` → used by:
  - `frontend/src/pages/ProjectSetup.jsx`
  - `frontend/src/pages/Settings.jsx`
  - `frontend/src/components/FoundationalDocs.jsx`

---

### `multer` (npm) — 4 files

Multipart file upload middleware. 20MB limit.

* `multer` → used by:
  - `backend/routes/landingPages.js`
  - `backend/routes/projects.js`
  - `backend/routes/templates.js`
  - `backend/routes/upload.js`

---

### `uuid` (npm, v4) — 26 files

UUID generation for `externalId` fields across the entire backend.

* `uuid` → used by:
  - `backend/auth.js`
  - `backend/convexClient.js`
  - `backend/routes/agentMonitor.js`
  - `backend/routes/auth.js`
  - `backend/routes/batches.js`
  - `backend/routes/chat.js`
  - `backend/routes/conductor.js`
  - `backend/routes/documents.js`
  - `backend/routes/landingPages.js`
  - `backend/routes/lpAgent.js`
  - `backend/routes/projects.js`
  - `backend/routes/templates.js`
  - `backend/routes/users.js`
  - `backend/services/adGenerator.js`
  - `backend/services/batchProcessor.js`
  - `backend/services/conductorAngles.js`
  - `backend/services/conductorEngine.js`
  - `backend/services/correctionHistory.js`
  - `backend/services/costTracker.js`
  - `backend/services/docGenerator.js`
  - `backend/services/lpAutoGenerator.js`
  - `backend/services/lpPublisher.js`
  - `backend/services/lpTemplateExtractor.js`
  - `backend/services/metaAds.js`
  - `backend/services/quoteBankService.js`
  - `backend/services/quoteDedup.js`

---

### `convex/schema.ts` — All Convex functions

29 tables. Schema changes require a **separate** `npx convex deploy -y` (run locally; Convex pushes directly to its cloud, independent of Vercel).

* `convex/schema.ts` → used by:
  - Every file in `convex/` (26 function files)
  - Indirectly: `backend/convexClient.js` (all mappers must match schema)

---

### Dead Code

* `backend/services/conductorAngles.js` — Angle auto-generation service. Exports `generateAngles`. Imported by **zero production files**. Referenced only in a comment in `conductorEngine.js`.

---

## 5. Critical Invariants

Rules that must never be violated. Breaking these causes silent failures or data corruption.

### Data Shape Contracts

1. **`externalId` is the foreign key, not `_id`**. All cross-table references use UUID `externalId` strings. Convex native `_id` is never used for relationships. Exception: `inspiration_images` has no `externalId` — it uses composite key `(project_id, drive_file_id)`.

2. **JSON arrays stored as strings**. These fields look like arrays but are `v.string()` in the schema — you must `JSON.parse()` to read and `JSON.stringify()` to write:
   - `batch_jobs`: `angles`, `gpt_prompts`, `used_template_ids`, `pipeline_state`, `template_image_ids`, `inspiration_image_ids`, `lp_narrative_frames`, `gauntlet_lp_urls`
   - `flex_ads`: `child_deployment_ids`, `primary_texts`, `headlines`, `gauntlet_lp_urls`, `destination_urls_used`
   - `ad_deployments`: `primary_texts`, `ad_headlines`
   - `quote_mining_runs`: `quotes`, `keywords`, `subreddits`, `forums`, `facebook_groups`, `headlines`
   - `quote_bank`: `headlines`, `tags`
   - `landing_pages`: `copy_sections`, `image_slots`, `cta_links`, `swipe_design_analysis`, `hosting_metadata`, `audit_trail`, `editorial_plan`
   - `landing_page_versions`: `copy_sections`, `image_slots`, `cta_links`
   - `correction_history`: `changes`
   - `conductor_runs`: `batches_created`, `angles_generated`, `posting_days`
   - `conductor_playbooks`: `visual_patterns`, `copy_patterns`, `avoid_patterns`

3. **Soft-delete pattern**. `ad_deployments` and `flex_ads` use `deleted_at` timestamp. All queries MUST filter out `deleted_at` records. Hard purge runs daily at 1am for records >30 days old.

4. **Cascade deletion**. `campaigns.remove()` -> hard-deletes child ad_sets -> soft-deletes child flex_ads. `adSets.remove()` -> soft-deletes child flex_ads. Any new parent-child entity must cascade.

5. **`convexBatchToRow` converts `scheduled` boolean to 0/1 integer**. Frontend must use `!!batch.scheduled` not bare `batch.scheduled` in JSX to avoid rendering `0`.

6. **Mapper functions + field whitelists**. Every route handler receives Convex data through mappers in `convexClient.js`. If you add a field to the schema, you MUST also add it to the mapper AND the helper's field whitelist or it won't appear in API responses / won't be saved on updates.

7. **Dedup guards**. `ad_deployments.create()` checks if `ad_id` already deployed (active only) — returns null if duplicate. `createWithoutDedup()` skips this. `inspiration_images.create()` skips if `(project_id, drive_file_id)` already exists.

8. **Upsert operations**. `meta_performance.upsert()` by `(meta_ad_id, date)`. `conductor_config.upsertConfig()` by `project_id`. `lp_agent_config.upsertConfig()` by `project_id`. `conductor_playbooks.upsertPlaybook()` by `(project_id, angle_name)`. `fixer_playbook.upsertFixerPlaybook()` by `issue_category`. `settings.set()` by `key`.

9. **Storage cleanup on delete**. These mutations delete from Convex blob storage when removing records: `projects.setProductImage()` (old image), `templateImages.remove()`, `adCreatives.remove()`, `batchJobs.remove()` (product image), `inspirationImages.removeByProject()` and `dedup()` (orphans).

### API Contracts

10. **SSE events**: All SSE endpoints emit `data: ${JSON.stringify(event)}\n\n`. Event objects always have a `type` field (`progress`, `step`, `complete`, `error`, `result`). Components parse these in `onEvent` callbacks.

11. **Cost logging is fire-and-forget**. Every LLM wrapper auto-logs costs internally. Callers pass `{ operation, projectId }` via options. The logging call uses `.catch(() => {})` — failures are silently swallowed. Never await cost logging.

12. **Error response shape**. All API errors: `res.status(N).json({ error: err.message })`. All mutation successes: `res.json({ success: true, ... })`. New routes must follow this.

13. **Deployment status strings**. The exact values `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are hardcoded across the entire stack. No enum — raw strings everywhere.

### Auth & Roles

14. **Three roles: `admin`, `manager`, `poster`**. Poster can ONLY see the Ad Pipeline tab (Ready to Post + Posted). Poster cannot access Planner, create projects, access Dashboard, or Settings. Backend enforces via `requireRole('admin', 'manager')`.

15. **`req.user` shape**: `{ id, username, role, displayName }`. Populated by `requireAuth` middleware from session. Every route handler depends on this shape.

16. **Session secret**: Auto-generated 64-char hex string via `crypto.randomBytes(32)` on first server start. Stored as `session_secret` setting in Convex. Session cookie maxAge: 30 days.

17. **Localhost-only agent endpoints**. `/api/agent-cost` routes use `localhostOnly` middleware checking `req.ip` against `['127.0.0.1', '::1', '::ffff:127.0.0.1']`.

### LP Pipeline

18. **`injectContrastSafetyCSS` is idempotent**. Checks for `data-safety="contrast"` marker before injecting. Safe to call multiple times. Exported from `lpGenerator.js`, called in: `postProcessLP()`, `landingPages.js` PUT endpoint (strips old CSS first), `landingPages.js` version restore endpoint (strips old CSS first).

19. **Frontend `assembleHtmlClient()` strips all post-processing**. The function rebuilds HTML from raw `htmlTemplate` + copy sections. The backend PUT endpoint re-applies contrast CSS. The frontend also injects a simplified contrast CSS version for editor preview. Any new post-processing added to `postProcessLP()` may need a corresponding safety net in the PUT endpoint.

20. **LP auto-generation is fire-and-forget**. `triggerLPGeneration()` never throws to caller. All errors are caught internally and set status to `'failed'` + error message on the batch record.

21. **Visual QA loop**: `generateAndValidateLP()` runs up to 3 generation attempts. Each failed attempt triggers `autoFixLP()` which applies deterministic fixes first (free), then LLM-powered fixes (costs tokens). Fix types: contrast CSS injection, broken image regeneration (Gemini), layout CSS fix (Claude Sonnet).

22. **Smoke test checks**: `runSmokeTest()` runs 7 automated checks post-publish: HTTP 200, load time <15s, no raw placeholders, headline present, >=50% images load, valid CTA links, no mobile horizontal overflow at 375px.

### Naming & Conventions

23. **`project_id` everywhere = `projects.externalId`** (UUID string), not the Convex `_id`.

24. **No Convex actions**. Only queries + mutations. All LLM calls, file processing, and external API work happens in Express backend.

25. **File naming**: camelCase for JS/JSX, PascalCase for React components, snake_case for Convex table names and fields.

26. **All LLM calls must go through wrappers**. Never call OpenAI, Anthropic, or Gemini APIs directly. Always use `services/openai.js`, `services/anthropic.js`, or `services/gemini.js` — they provide retry logic and automatic cost tracking.

27. **Timestamp conventions**. Most tables use ISO strings for `created_at`/`updated_at`. Conductor tables use milliseconds (`Date.now()`). Sessions use milliseconds for `expires_at`.

### Adding a New API Route

1. Create handler in `backend/routes/{feature}.js`
2. Use `requireAuth` + `requireRole('admin', 'manager')` middleware
3. Error responses: `res.status(N).json({ error: err.message })`
4. Success responses: `res.json({ success: true, ...data })`
5. Mount in `server.js` with appropriate path
6. Add rate limiting if it triggers LLM calls
7. Add corresponding method in `frontend/src/api.js`

### Adding a New Convex Table/Field

1. Add to `convex/schema.ts` with field types
2. Create `convex/{table}.ts` with queries + mutations (include field whitelisting)
3. Add mapper in `convexClient.js` to normalize Convex objects to API rows
4. Add helper functions in `convexClient.js` with field whitelists for updates
5. Add route handler to read/write the field
6. Add API method in `frontend/src/api.js`
7. Deploy Convex separately: `npx convex deploy -y` (run locally; Convex pushes directly to its cloud, independent of Vercel)
8. If hierarchical: implement cascade deletion in parent's `remove()` mutation

### Adding a New LLM Call

1. ALWAYS use the wrapper (`openai.js`, `anthropic.js`, or `gemini.js`)
2. Pass `{ operation: 'descriptive_name', projectId }` in options for cost tracking
3. Never call APIs directly — wrappers provide retry logic + cost logging
4. For Claude JSON mode: wrapper auto-strips markdown fences and extracts first `{ ... }` block

### Adding a New Long-Running Process or Progress Bar

**READ the skill file first:** `.claude/skills/progress-bar-standard/SKILL.md`

1. Use `PipelineProgress` component (`frontend/src/components/PipelineProgress.jsx`) — no custom progress bars
2. Backend: emit `{ type: 'progress', step: 'name', message: '...' }` via `createSSEStream` or `streamService`
3. Frontend: create `STEP_PROGRESS` map (weighted by wall-clock time) and `STEP_LABELS` map
4. Use `Math.max(prev, newValue)` for all progress updates (never go backwards)
5. Set `genStartRef.current = Date.now()` when starting (enables ETA display)
6. On completion: set 100%, wait 500ms, then reset state
7. The skill file has the full pattern, anti-patterns, and verification checklist

---

## 6. Common Pitfalls

1. **Forgetting Convex deploy** — `deploy.sh` only deploys backend + frontend. Schema/function changes require separate `npx convex deploy -y` (run locally; Convex pushes directly to its cloud, independent of Vercel).

2. **Missing field in whitelist** — `convexClient.js` helper functions use explicit field whitelists. Adding a field to schema + mutation but not the whitelist means updates silently drop the field.

3. **React `&&` with numbers** — `batch.scheduled` is stored as 0/1 integer. Use `!!batch.scheduled &&` not bare `batch.scheduled &&` or `0` renders as visible text.

4. **SSE event shape mismatch** — No type checking between backend emitter and frontend handler. Changes must be synchronized manually.

5. **Rate limiter concurrency** — Heavy LLM: concurrency=2, 2s gap. Gemini: concurrency=3. Increasing causes 429 errors.

6. **Deep Research timeout** — o3-deep-research has 30-minute timeout with 5s polling. Falls back gracefully.

7. **50MB JSON body limit** — Express configured with `express.json({ limit: '50mb' })`. Adding body-size middleware before JSON parser may conflict.

8. **LP HTML code fences** — Claude sometimes wraps HTML in markdown fences. `lpGenerator.js` auto-strips these.

9. **Thumbnail cache** — Lives at `backend/.thumb-cache/`. Delete directory to regenerate.

10. **Meta token expiry** — Tokens expire ~60 days. Scheduler auto-refreshes weekly. No proactive expiry warning.

11. **Legacy `deploy/` directory + `dacia-*/` bash scripts** — vestigial from the pre-Vercel deployment. Do not run anywhere; preserved on disk because `agentMonitor.js` reads paths from `dacia-creative-filter/` and `dacia-fixer/`. Don't delete without refactoring `agentMonitor.js` first.

12. **`dashboard_todos.replaceAll` is destructive** — Deletes ALL existing todos, inserts new ones. Not an update.

13. **No TypeScript on backend** — No type checking between SSE emitters and frontend handlers, or between Convex schema and Express routes.

14. **No enum for status strings** — `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are raw strings everywhere. Renaming requires updating every file that references them.

15. **Vercel function constraints** — `maxDuration: 300s` (configured in `vercel.json`), per-function memory cap. Long-running Director batches with 18+ ads typically complete in 2-3 min. Phase 4's sub-angle generation may need a bump to 800s with Fluid Compute.

16. **`conductorLearning.js` bug** — Has `messages.filter is not a function` error in learning step. Data shape issue, pre-existing.

17. **`cost_cents=0` treated as falsy** — In `agentMonitor.js` cost logging validation (`if (!cost_cents)`) — cosmetic, logs skip message.

18. **`conductorAngles.js` is dead code** — Never imported by any production caller. Referenced only in a comment in `conductorEngine.js`.

19. **OpenAI 429 on nearly every first attempt** — Current account hits rate limits frequently. The retry system handles this (15s+ backoff). Ad generation takes ~50s. This is expected, not a bug.

20. **LP contrast CSS stripping** — Frontend `assembleHtmlClient()` rebuilds HTML without contrast CSS. The PUT endpoint re-injects it. If you add a new code path that saves `assembled_html`, make sure it calls `injectContrastSafetyCSS()`.

21. **LP auto-save overwrites post-processing** — Any time the editor auto-saves (copy edit, CTA change), it sends rebuilt HTML to the PUT endpoint. The PUT endpoint's safety net re-applies placeholder fixes + contrast CSS. New post-processing steps need a corresponding safety net.

22. **Puppeteer memory** — LP Visual QA, smoke tests, and template extraction all launch headless Chromium. Vercel functions have memory limits per invocation; concurrent Puppeteer instances can exhaust the function memory. The LP auto-generator runs sequentially (not parallel) for this reason.

23. **Convex retry logic** — `convexClient.js` has its own retry predicate (`convexShouldRetry`) separate from the LLM retry logic. It retries on server errors, network failures, and rate limits. 3 retries with 2s base delay.

24. **Agent session expiry** — Both Filter and Fixer use session cookies with 24h expiry. If the backend restarts and session secret changes (shouldn't in production since it's persisted in Convex), agents get 401 and auto-re-auth.

25. **Route mount order matters** — In `server.js`, deployment routes MUST be mounted before broad `/api` routes so the poster role's limited access works correctly.

26. **Express async error patch** — `server.js` patches `Layer.prototype.handle_request` to catch async route handler errors. Without this patch, unhandled promise rejections would crash the process or hang requests.

---

## 7. File Structure

```
ad-platform/
+-- backend/
|   +-- server.js                    # Express entry point (port 3001), middleware stack, route mounting
|   +-- auth.js                      # requireAuth + requireRole middleware, req.user shape
|   +-- convexClient.js              # Central data layer (140+ helpers, mappers, whitelists)
|   +-- ConvexSessionStore.js        # Convex-backed express-session store
|   +-- vitest.config.js             # Test config
|   +-- routes/                      # 20 route files, ~177 endpoints total
|   |   +-- auth.js                  # Login/setup/session (5 endpoints)
|   |   +-- users.js                 # User CRUD — admin only (5 endpoints)
|   |   +-- projects.js              # Project CRUD + product image (7 endpoints)
|   |   +-- documents.js             # Doc generation SSE + corrections (12 endpoints)
|   |   +-- ads.js                   # Ad generation Mode 1/2 SSE (14 endpoints)
|   |   +-- batches.js               # Batch CRUD + scheduling (9 endpoints)
|   |   +-- costs.js                 # Cost aggregation (7 endpoints)
|   |   +-- drive.js                 # Google Drive sync + inspiration (9 endpoints)
|   |   +-- templates.js             # Template images + GPT analysis (6 endpoints)
|   |   +-- upload.js                # File upload + text extraction (2 endpoints)
|   |   +-- settings.js              # API keys, rates, references — admin (13 endpoints)
|   |   +-- deployments.js           # Campaigns, ad sets, flex ads, deployments (23 endpoints)
|   |   +-- quoteMining.js           # Quote mining + bank SSE (19 endpoints)
|   |   +-- chat.js                  # Copywriter Chat SSE (3 endpoints)
|   |   +-- landingPages.js          # LP CRUD + generation + publishing SSE (17 endpoints)
|   |   +-- lpTemplates.js           # LP template extraction SSE (5 endpoints)
|   |   +-- meta.js                  # Meta OAuth + performance sync (15 endpoints)
|   |   +-- agentMonitor.js          # Agent Dashboard status/control (12 endpoints)
|   |   +-- conductor.js             # Director config + angles + runs (19 endpoints)
|   |   +-- lpAgent.js               # LP Agent config, Shopify, test gen SSE (9 endpoints)
|   +-- services/                    # 25 service files
|   |   +-- openai.js                # GPT-5.2, GPT-4.1, o3-deep-research wrapper
|   |   +-- anthropic.js             # Claude Opus 4.6, Sonnet 4.6 wrapper
|   |   +-- gemini.js                # Gemini 3 Pro images wrapper (concurrency=3)
|   |   +-- adGenerator.js           # Ad generation orchestrator (Mode 1/2)
|   |   +-- batchProcessor.js        # 4-stage batch pipeline
|   |   +-- docGenerator.js          # 8-step doc pipeline
|   |   +-- quoteMiner.js            # Dual-engine quote search (Perplexity + Claude)
|   |   +-- headlineGenerator.js     # Headline generation (Claude Sonnet + 3 ref docs)
|   |   +-- bodyCopyGenerator.js     # Body copy from headline + quote context
|   |   +-- quoteBankService.js      # Quote bank orchestration
|   |   +-- quoteDedup.js            # Semantic quote deduplication (GPT-4.1-mini)
|   |   +-- costTracker.js           # Cost logging + OpenAI sync + Gemini rates
|   |   +-- scheduler.js             # 7 cron tasks + user-defined batch schedules
|   |   +-- metaAds.js               # Meta Ads OAuth, token refresh, performance sync
|   |   +-- rateLimiter.js           # Concurrency control (heavy=2, Gemini=3)
|   |   +-- retry.js                 # Exponential backoff (no 4xx retry except 429)
|   |   +-- lpGenerator.js           # LP generation + Opus editorial + postProcessLP + Visual QA
|   |   +-- lpAutoGenerator.js       # Director-triggered LP auto-generation (2 per batch)
|   |   +-- lpAutoFixer.js           # Deterministic + LLM Visual QA fixes
|   |   +-- lpPublisher.js           # Shopify page deploy + smoke test
|   |   +-- lpSmokeTest.js           # 7 automated post-publish checks
|   |   +-- lpSwipeFetcher.js        # Puppeteer page capture + SSRF protection
|   |   +-- lpTemplateExtractor.js   # URL -> reusable HTML template
|   |   +-- correctionHistory.js     # Doc correction audit trail
|   |   +-- conductorEngine.js       # Director orchestrator (batch planning + angles)
|   |   +-- conductorAngles.js       # DEAD CODE — angle generation, zero callers
|   |   +-- conductorLearning.js     # Learning + adaptive sizing (has known bug)
|   +-- utils/
|       +-- sseHelper.js             # SSE stream utilities (createSSEStream, streamService)
|       +-- adImages.js              # Image loading + thumbnail generation
|
+-- frontend/src/
|   +-- main.jsx                     # React entry (BrowserRouter wrapper)
|   +-- App.jsx                      # Router + AuthContext + lazy loading + ProtectedRoute
|   +-- api.js                       # 164 API methods (fetch wrapper + SSE helpers)
|   +-- index.css                    # Tailwind + custom classes (.glass-nav, .card, .btn-*, etc.)
|   +-- pages/                       # 8 page components
|   |   +-- Login.jsx                # Auth page (setup mode + login mode)
|   |   +-- Dashboard.jsx            # System overview + costs + TodoWidget
|   |   +-- Projects.jsx             # Project list grid with status badges
|   |   +-- ProjectSetup.jsx         # Create project form + auto-describe
|   |   +-- ProjectDetail.jsx        # Tabbed project workspace (7 tabs, URL-persisted)
|   |   +-- Settings.jsx             # API keys, Gemini rates, reference docs — admin
|   |   +-- AdTracker.jsx            # Cross-project ad pipeline (Planner/Ready/Posted views)
|   |   +-- AgentDashboard.jsx       # Agent system wrapper (4 tabs)
|   +-- components/                  # 27 component files
|   |   +-- Layout.jsx               # Navbar wrapper (role-based nav links)
|   |   +-- Toast.jsx                # Toast notifications (success/error/info/undo)
|   |   +-- ErrorBoundary.jsx        # Error boundary (chunk errors + generic)
|   |   +-- InfoTooltip.jsx          # Pure CSS hover tooltip
|   |   +-- DragDropUpload.jsx       # File upload with text extraction
|   |   +-- PipelineProgress.jsx     # Shared progress bar with ETA
|   |   +-- AdStudio.jsx             # Ad generation UI (~2500 lines)
|   |   +-- BatchManager.jsx         # Batch management + scheduling (~2500 lines)
|   |   +-- BatchRow.jsx             # Single batch row with status/progress
|   |   +-- batchUtils.js            # Batch constants, cron helpers, formatters
|   |   +-- FoundationalDocs.jsx     # Doc generation + corrections
|   |   +-- QuoteMiner.jsx           # Quote mining + bank + headlines
|   |   +-- CampaignsView.jsx        # Planner view (drag-drop, flex ad creation)
|   |   +-- ReadyToPostView.jsx      # Ready to Post view (copy, download, mark posted)
|   |   +-- PostedView.jsx           # Posted history view
|   |   +-- LPGen.jsx                # Landing page generator + editor (~3000 lines)
|   |   +-- LPAgentSettings.jsx      # LP Agent settings + gauntlet
|   |   +-- LPTemplateManager.jsx    # LP template extraction + management
|   |   +-- AgentMonitor.jsx         # Agent Dashboard tabs (Director, Filter, Fixer)
|   |   +-- CreativeFilterSettings.jsx # Per-project Filter config (scout_* fields)
|   |   +-- CopywriterChat.jsx       # Chat widget (Claude Sonnet streaming)
|   |   +-- TemplateImages.jsx       # Template + inspiration image management
|   |   +-- InspirationFolder.jsx    # Drive inspiration sync + display
|   |   +-- CostSummaryCards.jsx     # Cost widgets (today/week/month)
|   |   +-- CostBarChart.jsx         # 30-day stacked bar chart
|   |   +-- DriveFolderPicker.jsx    # Drive folder browser modal
|   |   +-- GenerationQueue.jsx      # Ad queue display (forwardRef)
|   |   +-- MultiInput.jsx           # Tag input (Enter/comma to add)
|   |   +-- NotionFilter.jsx         # Multi-select filter bar
|   +-- hooks/
|       +-- useAsyncData.js          # Fetch + loading + error + refetch
|       +-- usePolling.js            # Interval polling (ref-based)
|       +-- useSSEStream.js          # SSE streaming (factory pattern)
|
+-- convex/                          # 26 function files (29 tables)
|   +-- schema.ts                    # Full database schema (29 tables, all indexes)
|   +-- settings.ts                  # Key-value config store
|   +-- projects.ts                  # Project CRUD + stats
|   +-- foundationalDocs.ts          # Doc CRUD + versioning
|   +-- adCreatives.ts               # Ad CRUD + storage cleanup
|   +-- batchJobs.ts                 # Batch CRUD + status tracking + JSON fields
|   +-- apiCosts.ts                  # Cost logging + agent grouping
|   +-- campaigns.ts                 # Campaign CRUD + cascade delete -> ad_sets -> flex_ads
|   +-- adSets.ts                    # Ad set CRUD + cascade delete -> flex_ads
|   +-- flexAds.ts                   # Flex ad CRUD + soft delete/restore/purge
|   +-- ad_deployments.ts            # Deployment CRUD + dedup guard + soft delete
|   +-- templateImages.ts            # Template image CRUD + storage cleanup
|   +-- inspirationImages.ts         # Drive sync + composite key dedup
|   +-- quote_mining_runs.ts         # Mining run CRUD + JSON fields
|   +-- quote_bank.ts               # Quote CRUD + bulk create/update + backfill
|   +-- chatThreads.ts              # Chat thread + message CRUD
|   +-- correction_history.ts        # Correction audit log
|   +-- dashboard_todos.ts           # Dashboard to-do list (replaceAll is destructive)
|   +-- metaPerformance.ts           # Meta metrics + upsert by (meta_ad_id, date)
|   +-- landingPages.ts              # LP CRUD (40+ whitelisted fields)
|   +-- landingPageVersions.ts       # LP version history snapshots
|   +-- lpTemplates.ts               # LP template CRUD
|   +-- users.ts                     # User CRUD + username uniqueness
|   +-- sessions.ts                  # Session store (upsert, cleanup)
|   +-- fileStorage.ts               # Blob storage helpers (URL, upload, delete)
|   +-- conductor.ts                 # Director config + angles + runs + playbooks + health + fixer playbooks
|   +-- lpAgentConfig.ts             # LP Agent config (upsert by project_id)
|
+-- dacia-fixer/                     # Agent: auto-test, self-heal, resurrect
|   +-- fixer.sh                     # Main script (~1200 lines)
|   +-- config/fixer.conf            # Budget $1.33/day, models, intervals
|   +-- fix_ledger.md                # Institutional memory — DO NOT DELETE
|   +-- logs/                        # Daily log files + spend tracking
|
+-- dacia-creative-filter/           # Agent: score ads, create flex ads
|   +-- filter.sh                    # Main script (~1170 lines)
|   +-- config/filter.conf           # Budget $20/day, models, thresholds
|   +-- agents/
|   |   +-- score.sh                 # Vision-based scoring (Claude Sonnet)
|   |   +-- group.sh                 # Flex ad clustering (Claude Sonnet)
|   |   +-- validate.sh              # Copy validation
|   |   +-- regenerate.sh            # Copy fallback generation
|   +-- logs/                        # Daily log files + spend tracking
|
+-- deploy/
|   +-- (LEGACY) deploy.sh, setup.sh, ecosystem.config.cjs, nginx.conf — pre-Vercel VPS artifacts; not used by current deployment but kept on disk
|
+-- frontend/
    +-- package.json                 # React 18, Vite 5.4, Tailwind 3.4, JSZip
    +-- vite.config.js               # Dev port 5173, proxy /api -> 3001
    +-- tailwind.config.js           # Navy/gold/teal color tokens, DM Sans font
    +-- postcss.config.js            # Tailwind + autoprefixer
```

#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL || 'https://thrive-digital-marketing-ad-generat.vercel.app';
const PROJECT_ID = process.env.PROJECT_ID || '4f8aed31-c2ac-4dca-8dc6-233838d9a069';
const USERNAME = process.env.THRIVE_USERNAME || process.env.CF_USERNAME || 'admin';
const PASSWORD = process.env.THRIVE_PASSWORD || process.env.CF_PASSWORD || '';
const HEADLESS = process.env.HEADLESS !== '0';
const RUN_FULL_MATRIX = process.env.LIVE_MATRIX !== 'quick';
const RUN_SINGLES = process.env.RUN_SINGLES !== '0';
const RUN_BATCH = process.env.RUN_BATCH !== '0';
const RUN_DIRECTOR = process.env.RUN_DIRECTOR === '1';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.resolve('.tmp/e2e-generation-smoke');

const AD_TIMEOUT_MS = Number(process.env.AD_TIMEOUT_MS || 8 * 60 * 1000);
const BATCH_TIMEOUT_MS = Number(process.env.BATCH_TIMEOUT_MS || 20 * 60 * 1000);
const DIRECTOR_TIMEOUT_MS = Number(process.env.DIRECTOR_TIMEOUT_MS || 45 * 60 * 1000);

if (!PASSWORD) {
  console.error('Set THRIVE_PASSWORD before running the smoke harness.');
  process.exit(1);
}

const { chromium } = await import('playwright');

function nowSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeList(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function createdAtMs(row) {
  const raw = row?.created_at || row?.createdAt || row?._creationTime || row?.queued_at || row?.started_at;
  const parsed = typeof raw === 'number' ? raw : Date.parse(raw || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasImage(row) {
  return !!(row?.storageId || row?.imageUrl || row?.thumbnailUrl);
}

async function fetchJson(page, url, options = {}) {
  return page.evaluate(async ({ url, options }) => {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { error: await res.text().catch(() => '') };
    }
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }, { url, options });
}

async function latestAdAfter(page, projectId, startMs) {
  const data = await fetchJson(page, `/api/projects/${projectId}/ads`);
  return normalizeList(data, 'ads')
    .filter((ad) => createdAtMs(ad) >= startMs - 3000)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a))[0] || null;
}

async function waitForAdCompletion(page, projectId, startMs, label) {
  const deadline = Date.now() + AD_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await latestAdAfter(page, projectId, startMs);
    if (last?.status === 'failed') {
      throw new Error(`${label} failed: ${last.error_message || last.error || last.failure_stage || 'unknown failure'} (${last.id})`);
    }
    if (last?.status === 'completed' && hasImage(last)) {
      return last;
    }
    await sleep(5000);
  }
  throw new Error(`${label} timed out. Last ad state: ${JSON.stringify(last || {})}`);
}

async function waitForBatchCompletion(page, projectId, startMs) {
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const data = await fetchJson(page, `/api/projects/${projectId}/batches`);
    last = normalizeList(data, 'batches')
      .filter((batch) => createdAtMs(batch) >= startMs - 3000)
      .sort((a, b) => createdAtMs(b) - createdAtMs(a))[0] || null;
    if (last?.status === 'failed') {
      throw new Error(`Batch failed: ${last.error_message || last.error || 'unknown failure'} (${last.id})`);
    }
    if (last?.status === 'completed' && Number(last.completed_count || last.batch_stats?.completed || 0) > 0) {
      return last;
    }
    await sleep(10000);
  }
  throw new Error(`Batch timed out. Last batch state: ${JSON.stringify(last || {})}`);
}

async function waitForDirectorCompletion(page, projectId, startMs) {
  const deadline = Date.now() + DIRECTOR_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const data = await fetchJson(page, `/api/conductor/runs/${projectId}?limit=10`);
    last = normalizeList(data, 'runs')
      .filter((run) => run.run_type === 'test' && createdAtMs(run) >= startMs - 3000)
      .sort((a, b) => createdAtMs(b) - createdAtMs(a))[0] || null;
    const status = String(last?.status || last?.terminal_status || '').toLowerCase();
    const terminal = String(last?.terminal_status || '').toLowerCase();
    if (status.includes('failed') || status.includes('error') || terminal.includes('failed')) {
      throw new Error(`Creative Director failed: ${last.failure_reason || last.error_message || last.error_stage || 'unknown failure'} (${last.externalId || last.id})`);
    }
    if (
      status === 'completed' ||
      terminal === 'deployed' ||
      terminal === 'completed' ||
      (Number(last?.ready_count || 0) > 0 && Number(last?.total_ads_passed || 0) > 0)
    ) {
      return last;
    }
    await sleep(15000);
  }
  throw new Error(`Creative Director timed out. Last run state: ${JSON.stringify(last || {})}`);
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  const usernameInput = page.getByTestId('login-username');
  try {
    await usernameInput.waitFor({ timeout: 15000 });
    await usernameInput.fill(USERNAME);
    await page.getByTestId('login-password').fill(PASSWORD);
  } catch {
    // Already authenticated sessions may redirect away from /login before the form renders.
    return;
  }
  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/auth/login')).catch(() => null),
    page.getByTestId('login-submit').click(),
  ]);
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  if (page.url().includes('/login')) {
    await page.evaluate(async ({ username, password }) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Login failed with HTTP ${res.status}`);
      }
    }, { username: USERNAME, password: PASSWORD });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' }).catch(() => {});
  }
  if (page.url().includes('/login')) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    throw new Error(`Login did not complete. Current page still appears to be /login. ${bodyText.slice(0, 300)}`);
  }
}

async function openAdStudio(page) {
  await page.goto(`${BASE_URL}/projects/${PROJECT_ID}?tab=ads`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ad-studio-generator').waitFor({ timeout: 60000 });
}

async function ensureOptionalFields(page) {
  const angle = page.getByTestId('ad-angle-input');
  if (await angle.count()) return;
  const toggle = page.getByTestId('optional-fields-toggle');
  if (await toggle.count()) {
    await toggle.click();
    await page.getByTestId('ad-angle-input').waitFor({ timeout: 10000 });
  }
}

async function clearGenerationFields(page) {
  await ensureOptionalFields(page);
  for (const id of ['ad-angle-input', 'ad-headline-input', 'ad-body-copy-input', 'prompt-guidelines-input']) {
    const locator = page.getByTestId(id);
    if (await locator.count()) {
      await locator.fill('');
    }
  }
}

async function runSingleScenario(page, scenario, runId, report) {
  await openAdStudio(page);
  await clearGenerationFields(page);
  if (scenario.angle) await page.getByTestId('ad-angle-input').fill(`${scenario.angle} ${runId}`);
  if (scenario.headline) await page.getByTestId('ad-headline-input').fill(`${scenario.headline} ${runId}`);
  if (scenario.bodyCopy) await page.getByTestId('ad-body-copy-input').fill(`${scenario.bodyCopy} ${runId}`);
  if (scenario.guidelines) await page.getByTestId('prompt-guidelines-input').fill(`${scenario.guidelines} ${runId}`);

  const startMs = Date.now();
  await page.getByTestId('generate-ad-button').click();
  await page.getByTestId('generation-queue').waitFor({ timeout: 30000 });
  const ad = await waitForAdCompletion(page, PROJECT_ID, startMs, scenario.name);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('ad-gallery').waitFor({ timeout: 60000 });
  await page.locator(`img[src*="/api/projects/${PROJECT_ID}/ads/${ad.id}/"]`).first().waitFor({ timeout: 60000 });

  const screenshot = path.join(ARTIFACT_DIR, `${runId}-${scenario.slug}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  report.results.push({ type: 'single', scenario: scenario.name, adId: ad.id, status: ad.status, screenshot });
}

async function runBatchSmoke(page, runId, report) {
  await openAdStudio(page);
  const batchHeader = page.getByRole('button', { name: /Batch Generation/i });
  await batchHeader.scrollIntoViewIfNeeded();
  await batchHeader.click();
  const input = page.getByTestId('batch-size-input');
  await input.waitFor({ timeout: 30000 });
  await input.fill('1');
  const startMs = Date.now();
  await page.getByTestId('batch-generate-button').click();
  const batch = await waitForBatchCompletion(page, PROJECT_ID, startMs);
  report.results.push({ type: 'batch', batchId: batch.id, status: batch.status, completedCount: batch.completed_count || batch.batch_stats?.completed || 0 });
}

async function runDirectorSmoke(page, report) {
  await page.goto(`${BASE_URL}/projects/${PROJECT_ID}?tab=automation`, { waitUntil: 'domcontentloaded' });
  const angleSelect = page.getByTestId('director-test-angle-select');
  await angleSelect.waitFor({ timeout: 60000 });
  await angleSelect.focus();
  const values = await page.waitForFunction(() => {
    const select = document.querySelector('[data-testid="director-test-angle-select"]');
    if (!select) return null;
    const optionValues = Array.from(select.options).map((option) => option.value).filter(Boolean);
    return optionValues.length > 0 ? optionValues : null;
  }, null, { timeout: 60000 }).then((handle) => handle.jsonValue());
  if (values.length === 0) {
    report.skipped.push({ type: 'director', reason: 'No active Creative Director test angles are available.' });
    return;
  }
  await angleSelect.selectOption(values[0]);
  await page.getByTestId('director-test-target-input').fill('1');
  const startMs = Date.now();
  await page.getByTestId('director-test-run-button').click();
  const run = await waitForDirectorCompletion(page, PROJECT_ID, startMs);
  report.results.push({ type: 'creative_director', runId: run.externalId || run.id, status: run.status, terminalStatus: run.terminal_status, readyCount: run.ready_count || null });
}

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const runId = nowSlug();
const report = {
  baseUrl: BASE_URL,
  projectId: PROJECT_ID,
  runId,
  startedAt: new Date().toISOString(),
  results: [],
  skipped: [],
};

const browser = await chromium.launch({ headless: HEADLESS });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  await login(page);
  const scenarios = [
    { slug: 'default', name: 'default generation' },
    { slug: 'angle', name: 'adjusted angle', angle: 'Show a calm bedroom recovery angle' },
    { slug: 'headline', name: 'adjusted headline', headline: 'Wake Up Feeling Restored' },
    { slug: 'body-copy', name: 'adjusted body copy', bodyCopy: 'Create a grounding bedsheet ad about deeper rest and easier mornings.' },
    { slug: 'angle-body-copy', name: 'angle plus body copy', angle: 'Show a wellness skeptic becoming curious', bodyCopy: 'Make the ad feel practical, grounded, and not mystical.' },
    { slug: 'guidelines', name: 'prompt guidelines', guidelines: 'Use natural morning light, clean bedding, no medical claims, and no clutter.' },
  ];

  if (RUN_SINGLES) {
    for (const scenario of RUN_FULL_MATRIX ? scenarios : scenarios.slice(0, 1)) {
      await runSingleScenario(page, scenario, runId, report);
    }
  } else {
    report.skipped.push({ type: 'single', reason: 'RUN_SINGLES=0' });
  }

  if (RUN_BATCH) {
    await runBatchSmoke(page, runId, report);
  }
  if (RUN_DIRECTOR) {
    await runDirectorSmoke(page, report);
  } else {
    report.skipped.push({ type: 'creative_director', reason: 'Set RUN_DIRECTOR=1 to run the paid Creative Director target-1 smoke.' });
  }
} catch (err) {
  report.error = err?.stack || err?.message || String(err);
  const screenshot = path.join(ARTIFACT_DIR, `${runId}-failure.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  report.failureScreenshot = screenshot;
  throw err;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(ARTIFACT_DIR, `report-${runId}.json`), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

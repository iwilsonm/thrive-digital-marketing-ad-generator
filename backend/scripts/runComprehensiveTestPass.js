#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = process.env.THRIVE_BASE_URL || 'https://thrive-digital-marketing-ad-generat.vercel.app';
const PROD_CONVEX_URL = process.env.THRIVE_PROD_CONVEX_URL || 'https://cheery-cobra-258.convex.cloud';
process.env.CONVEX_URL = PROD_CONVEX_URL;
const ADMIN_USERNAME = process.env.THRIVE_ADMIN_USERNAME || 'test';
const ARTIFACT_DIR = path.resolve(
  process.env.THRIVE_TEST_ARTIFACT_DIR || path.join(REPO_ROOT, '.tmp', `comprehensive-handoff-${new Date().toISOString().replace(/[:.]/g, '-')}`)
);
const STORAGE_STATE_PATH = path.join(ARTIFACT_DIR, 'admin-storage-state.json');
const HEADLESS = process.env.HEADLESS !== '0';
const COST_BUDGET = Number(process.env.THRIVE_COST_BUDGET || 10);
const COST_STOP_THRESHOLD = Number(process.env.THRIVE_COST_STOP_THRESHOLD || 8);
const SINGLE_STEP_COST_PAUSE = Number(process.env.THRIVE_SINGLE_STEP_COST_PAUSE || 1);
const CCW_PROJECT_ID = '526cdad9-fc79-48ef-9657-726f3a6c4a3c';

const DOC_TYPES = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
const EXPECTED_401 = [/\/api\/auth\/session/, /\/api\/auth\/login/];
const SKIP_CLICK_PATTERNS = [
  /run test/i,
  /generate director run/i,
  /trigger director/i,
  /director/i,
  /stage\s*[0-3]/i,
  /gemini batch/i,
  /generate mode\s*[12]\s*ad/i,
  /generate foundational docs/i,
  /^generate docs$/i,
  /connect meta/i,
  /connect drive/i,
  /delete/i,
  /remove/i,
  /archive/i,
  /reset password/i,
  /update your password/i,
  /sign out|log out|logout/i,
  /save settings/i,
  /save profile/i,
];

const report = {
  startedAt: new Date().toISOString(),
  target: BASE_URL,
  scriptPath: path.relative(REPO_ROOT, fileURLToPath(import.meta.url)),
  artifacts: ARTIFACT_DIR,
  totalTests: 0,
  passed: 0,
  failures: [],
  routes: [],
  llmFlows: [],
  fixtures: {
    testProject: null,
    posterUser: null,
    adminUser: ADMIN_USERNAME,
  },
  cleanup: [],
  blockers: [],
  notes: [],
  cost: {
    start: null,
    current: null,
    total: 0,
  },
};

function redact(value) {
  let text = String(value || '');
  const secret = process.env.THRIVE_ADMIN_PASSWORD || '';
  if (secret) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  return text;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readPassword() {
  if (process.env.THRIVE_ADMIN_PASSWORD) return process.env.THRIVE_ADMIN_PASSWORD;
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stdout.write('Admin password: ');
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return await new Promise((resolve) => {
    stdin.on('data', (chunk) => {
      for (const str of chunk.toString('utf8')) {
        if (str === '\r' || str === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        } else if (str === '\u0003') {
          process.exit(130);
        } else if (str === '\u007f') {
          value = value.slice(0, -1);
        } else {
          value += str;
        }
      }
    });
  });
}

function addFailure(severity, location, message, steps = [], details = {}) {
  report.failures.push({
    severity,
    location,
    message: redact(message),
    steps,
    ...details,
  });
}

function countTest(ok) {
  report.totalTests += 1;
  if (ok) report.passed += 1;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function screenshot(page, name) {
  const file = path.join(ARTIFACT_DIR, `${name.replace(/[^a-z0-9._-]+/gi, '_')}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

function bodyTextPreview(body) {
  if (body == null) return '';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return redact(text.slice(0, 1000));
}

async function apiJson(request, method, url, body = undefined, options = {}) {
  const response = await request.fetch(`${BASE_URL}${url}`, {
    method,
    data: body,
    timeout: options.timeout || 60000,
  });
  let parsed = null;
  let raw = '';
  try {
    raw = await response.text();
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw ? { raw } : null;
  }
  if (!response.ok() && !options.allowFailure) {
    throw new Error(`${method} ${url} failed HTTP ${response.status()}: ${bodyTextPreview(parsed)}`);
  }
  return { status: response.status(), ok: response.ok(), body: parsed, raw };
}

async function pageFetchJson(page, method, url, body = undefined, timeoutMs = 60000) {
  return await page.evaluate(
    async ({ method, url, body, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        return { ok: res.ok, status: res.status, data };
      } finally {
        clearTimeout(timer);
      }
    },
    { method, url, body, timeoutMs }
  );
}

async function pageFetchSse(page, url, body, timeoutMs = 8 * 60 * 1000) {
  return await page.evaluate(
    async ({ url, body, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const events = [];
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, status: res.status, events, text };
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6);
            if (raw === '[DONE]') return { ok: true, status: res.status, events, done: true };
            try { events.push(JSON.parse(raw)); } catch { events.push({ raw }); }
          }
        }
        return { ok: true, status: res.status, events, done: false };
      } catch (err) {
        return { ok: false, status: 0, events, text: err.message };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, body, timeoutMs }
  );
}

function extractCostNumber(data) {
  const seen = new Set();
  const candidates = [];
  function walk(value, key = '') {
    if (!value || typeof value !== 'object') {
      if (typeof value === 'number' && /cost|total|spend|amount/i.test(key)) candidates.push(value);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const [k, v] of Object.entries(value)) walk(v, k);
  }
  walk(data);
  if (typeof data?.month?.total === 'number') return data.month.total;
  if (typeof data?.total === 'number') return data.total;
  if (typeof data?.total_cost === 'number') return data.total_cost;
  return candidates.length ? Math.max(...candidates.filter((n) => Number.isFinite(n))) : 0;
}

async function getCostSnapshot(page, projectId = null) {
  const pathName = projectId ? `/api/projects/${projectId}/costs` : '/api/costs';
  const result = await pageFetchJson(page, 'GET', pathName, undefined, 45000);
  if (!result.ok) return { available: false, status: result.status, value: 0, raw: result.data };
  return { available: true, status: result.status, value: extractCostNumber(result.data), raw: result.data };
}

async function withCost(page, name, fn, projectId = null) {
  const before = await getCostSnapshot(page, projectId);
  const started = Date.now();
  let status = 'pass';
  let error = '';
  try {
    const result = await fn();
    const after = await getCostSnapshot(page, projectId);
    const cost = Math.max(0, (after.value || 0) - (before.value || 0));
    report.cost.current = after.value;
    report.cost.total += cost;
    report.llmFlows.push({ name, status, cost, durationMs: Date.now() - started, details: result });
    if (cost > SINGLE_STEP_COST_PAUSE) {
      throw new Error(`${name} cost $${cost.toFixed(4)}, above the $${SINGLE_STEP_COST_PAUSE.toFixed(2)} single-step pause threshold.`);
    }
    if (report.cost.total >= COST_STOP_THRESHOLD || report.cost.total >= COST_BUDGET) {
      throw new Error(`Cumulative LLM cost $${report.cost.total.toFixed(4)} reached stop threshold.`);
    }
    countTest(true);
    return result;
  } catch (err) {
    status = 'fail';
    error = err.message;
    report.llmFlows.push({ name, status, cost: 0, durationMs: Date.now() - started, error: redact(error) });
    addFailure('High', `LLM flow: ${name}`, error, [`Run flow "${name}"`]);
    countTest(false);
    if (/cost|budget|threshold/i.test(error)) throw err;
    return null;
  }
}

function attachCapture(page, bucket) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.consoleErrors.push(redact(msg.text()));
  });
  page.on('pageerror', (err) => {
    bucket.pageErrors.push(redact(err.stack || err.message));
  });
  page.on('response', async (res) => {
    const status = res.status();
    if (status < 400) return;
    const url = res.url();
    if (status === 401 && EXPECTED_401.some((pattern) => pattern.test(url))) return;
    let text = '';
    try { text = await res.text(); } catch {}
    bucket.networkErrors.push({ status, url, body: bodyTextPreview(text) });
  });
}

function routeHasErrorText(text) {
  return /something went wrong|error boundary|application error|failed to load|uncaught/i.test(text || '');
}

async function login(page, password) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input', { timeout: 30000 });
  const username = page.getByTestId('login-username');
  const passwordInput = page.getByTestId('login-password');
  if ((await username.count()) > 0) {
    await username.fill(ADMIN_USERNAME);
    await passwordInput.fill(password);
  } else {
    await page.locator('input[type="text"],input[name="username"],input[autocomplete="username"]').first().fill(ADMIN_USERNAME);
    await page.locator('input[type="password"]').first().fill(password);
  }
  const loginResponsePromise = page.waitForResponse((res) => res.url().includes('/api/auth/login'), { timeout: 30000 });
  const submit = page.getByTestId('login-submit');
  if ((await submit.count()) > 0) await submit.click();
  else await page.locator('button[type="submit"],button').filter({ hasText: /log in|sign in/i }).first().click();
  const loginResponse = await loginResponsePromise.catch(() => null);
  const status = loginResponse?.status() || 0;
  let responseBody = '';
  if (loginResponse) {
    try { responseBody = await loginResponse.text(); } catch {}
  }
  if (!loginResponse || status >= 400) {
    throw new Error(`Admin login failed HTTP ${status}: ${bodyTextPreview(responseBody)}`);
  }
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (page.url().includes('/login')) {
    throw new Error(`Admin login submitted but stayed on /login. Body: ${(await page.locator('body').innerText()).slice(0, 500)}`);
  }
}

async function testRoute(page, label, url) {
  const bucket = { consoleErrors: [], pageErrors: [], networkErrors: [] };
  attachCapture(page, bucket);
  const started = Date.now();
  let status = 'pass';
  let errorCount = 0;
  let screenshotPath = null;
  try {
    await page.goto(`${BASE_URL}${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.locator('body').waitFor({ timeout: 10000 });
    const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    errorCount = bucket.consoleErrors.length + bucket.pageErrors.length + bucket.networkErrors.length + (routeHasErrorText(text) ? 1 : 0);
    if (errorCount > 0) {
      status = 'fail';
      screenshotPath = await screenshot(page, `route-${label}`);
      addFailure(
        bucket.networkErrors.some((e) => e.status >= 500) || bucket.pageErrors.length ? 'Critical' : 'Medium',
        `Route ${url}`,
        [
          ...bucket.pageErrors,
          ...bucket.consoleErrors,
          ...bucket.networkErrors.map((e) => `${e.status} ${e.url}: ${e.body}`),
          routeHasErrorText(text) ? 'Page body contains application error text.' : '',
        ].filter(Boolean).join('\n'),
        [`Navigate to ${url}`],
        { screenshot: screenshotPath }
      );
    }
    countTest(status === 'pass');
  } catch (err) {
    status = 'fail';
    errorCount += 1;
    screenshotPath = await screenshot(page, `route-${label}`);
    addFailure('Critical', `Route ${url}`, err.message, [`Navigate to ${url}`], { screenshot: screenshotPath });
    countTest(false);
  }
  report.routes.push({
    route: url,
    label,
    status,
    errorCount,
    durationMs: Date.now() - started,
    screenshot: screenshotPath,
  });
}

function shouldSkipClick(label) {
  const normalized = String(label || '').trim();
  if (!normalized) return true;
  return SKIP_CLICK_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function enumerateInteractions(page, scopeLabel, limit = 60) {
  const locators = await page.locator('button, a[href], [role="button"]').evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .map((node, index) => ({
        index,
        text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('href') || '').trim().slice(0, 120),
        tag: node.tagName.toLowerCase(),
      }))
  ).catch(() => []);

  const targets = locators.slice(0, limit);
  for (const target of targets) {
    if (shouldSkipClick(target.text)) continue;
    const bucket = { consoleErrors: [], pageErrors: [], networkErrors: [] };
    attachCapture(page, bucket);
    try {
      const selector = 'button, a[href], [role="button"]';
      const element = page.locator(selector).nth(target.index);
      await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      const beforeUrl = page.url();
      await element.click({ timeout: 5000 }).catch((err) => {
        throw new Error(`Click failed for "${target.text || target.tag}": ${err.message}`);
      });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await sleep(250);
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      const errors = [
        ...bucket.pageErrors,
        ...bucket.consoleErrors,
        ...bucket.networkErrors.map((e) => `${e.status} ${e.url}: ${e.body}`),
      ];
      if (routeHasErrorText(bodyText)) errors.push('Page body contains application error text.');
      if (errors.length > 0) {
        const shot = await screenshot(page, `click-${scopeLabel}-${target.index}`);
        addFailure('Medium', `${scopeLabel} click "${target.text}"`, errors.join('\n'), [`Open ${scopeLabel}`, `Click "${target.text}"`], { screenshot: shot });
        countTest(false);
      } else {
        countTest(true);
      }
      if (page.url() !== beforeUrl && !page.url().includes('/login')) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => page.goto(beforeUrl, { waitUntil: 'domcontentloaded' }));
      }
    } catch (err) {
      const shot = await screenshot(page, `click-${scopeLabel}-${target.index}`);
      addFailure('Medium', `${scopeLabel} click "${target.text || target.tag}"`, err.message, [`Open ${scopeLabel}`, `Click "${target.text || target.tag}"`], { screenshot: shot });
      countTest(false);
    }
  }

  const inputs = await page.locator('input:not([type="hidden"]):not([type="file"]), textarea, select').count().catch(() => 0);
  for (let i = 0; i < Math.min(inputs, 40); i += 1) {
    try {
      const input = page.locator('input:not([type="hidden"]):not([type="file"]), textarea, select').nth(i);
      const type = await input.getAttribute('type').catch(() => '');
      const disabled = await input.isDisabled().catch(() => true);
      if (disabled || /password|secret|key/i.test(type || '')) continue;
      await input.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await input.focus({ timeout: 3000 });
      if ((await input.evaluate((el) => el.tagName.toLowerCase())) === 'select') {
        const options = await input.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value).filter(Boolean)).catch(() => []);
        if (options.length > 0) await input.selectOption(options[0]).catch(() => {});
      } else {
        const previous = await input.inputValue().catch(() => '');
        await input.fill(`${previous} qa`).catch(() => {});
        await input.blur().catch(() => {});
        await input.fill(previous).catch(() => {});
      }
      countTest(true);
    } catch (err) {
      addFailure('Low', `${scopeLabel} input ${i}`, err.message, [`Open ${scopeLabel}`, `Focus/edit input ${i}`]);
      countTest(false);
    }
  }
}

async function createTestProject(request, timestamp) {
  const payload = {
    name: `QA-Test-${timestamp}`,
    brand_name: `QA Brand ${timestamp}`,
    niche: 'QA automated smoke testing',
    product_description: 'A small synthetic offer used only for automated QA. It helps small teams produce clearer daily marketing plans.',
    sales_page_content: 'QA fixture. This project exists only during the comprehensive handoff test pass and should be archived or deleted during cleanup.',
  };
  const result = await apiJson(request, 'POST', '/api/projects', payload, { timeout: 90000 });
  report.fixtures.testProject = { id: result.body.id, name: payload.name };
  countTest(true);
  return result.body;
}

async function testSettingsPersist(page) {
  const before = await pageFetchJson(page, 'GET', '/api/settings');
  if (!before.ok) throw new Error(`Settings read failed HTTP ${before.status}`);
  const original = before.data || {};
  const patch = {
    gemini_rate_1k: '0.067',
    gemini_rate_2k: '0.101',
    gemini_rate_4k: '0.151',
  };
  const save = await pageFetchJson(page, 'PUT', '/api/settings', patch);
  if (!save.ok) throw new Error(`Settings save failed HTTP ${save.status}: ${bodyTextPreview(save.data)}`);
  const after = await pageFetchJson(page, 'GET', '/api/settings');
  const persisted = Object.entries(patch).every(([key, value]) => String(after.data?.[key]) === value);
  if (!persisted) throw new Error(`Settings did not persist expected Gemini rate values: ${bodyTextPreview(after.data)}`);
  const restore = {};
  for (const key of Object.keys(patch)) {
    if (original[key] !== undefined && original[key] !== null) restore[key] = original[key];
  }
  if (Object.keys(restore).length > 0) await pageFetchJson(page, 'PUT', '/api/settings', restore);
  countTest(true);
}

async function runApiKeyTestsViaUi(page) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const labels = [
    { name: 'OpenAI API key test', service: 'openai', endpoint: '/api/settings/test-openai' },
    { name: 'Gemini API key test', service: 'gemini', endpoint: '/api/settings/test-gemini' },
    { name: 'Anthropic API key test', service: 'anthropic', endpoint: '/api/settings/test-anthropic' },
  ];
  const results = {};
  const testButtons = page.getByRole('button', { name: /^Test$/ });
  for (let i = 0; i < labels.length; i += 1) {
    const item = labels[i];
    const bucket = { consoleErrors: [], pageErrors: [], networkErrors: [] };
    attachCapture(page, bucket);
    let uiClickError = '';
    const button = testButtons.nth(i);
    if (await button.count()) {
      await button.scrollIntoViewIfNeeded({ timeout: 5000 }).catch((err) => { uiClickError = err.message; });
      if (!uiClickError) await button.click({ timeout: 5000 }).catch((err) => { uiClickError = err.message; });
      await page.waitForTimeout(3500);
    } else {
      uiClickError = `Could not find Test button index ${i}`;
    }
    const direct = await pageFetchJson(page, 'POST', item.endpoint, {}, 45000).catch((err) => ({
      ok: false,
      status: 0,
      data: { error: err.message },
    }));
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const line = bodyText.split('\n').find((lineText) => /OpenAI API key|Gemini API key|Anthropic API key|Failed:|valid|returned|configured|testing/i.test(lineText) && lineText.length < 250) || '';
    results[item.service] = {
      displayed: line,
      directStatus: direct.status,
      directBody: direct.data,
      uiClickError,
      consoleErrors: bucket.consoleErrors,
      networkErrors: bucket.networkErrors,
      pageErrors: bucket.pageErrors,
    };
    const failed = uiClickError || bucket.pageErrors.length || bucket.consoleErrors.length || bucket.networkErrors.some((e) => e.status >= 500) || !direct.ok || /Failed:/i.test(line);
    if (failed) {
      addFailure(
        direct.status >= 500 ? 'Critical' : 'High',
        item.name,
        [
          line,
          uiClickError ? `UI click error: ${uiClickError}` : '',
          !direct.ok ? `Direct endpoint HTTP ${direct.status}: ${bodyTextPreview(direct.data)}` : '',
          ...bucket.consoleErrors,
        ].filter(Boolean).join('\n'),
        [`Open /settings`, `Click ${item.service} Test`, `POST ${item.endpoint}`]
      );
      countTest(false);
    } else {
      countTest(true);
    }
  }
  return results;
}

function pngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAAAA3NCSVQICAjb4U/gAAABJElEQVR4nO3RMQEAIAzAsIF/z0MGRxMFfXpnJ4C5OQF4Y4AxwBhgDDAFGAPMAWaAMcAYYAwYAxwBhgBjgDHAGGAMMAaYAcwAY4AxwBhgDDAGGAOMAcYAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYPwBMucCrRmg1i0AAAAASUVORK5CYII=',
    'base64'
  );
}

async function runTemplateAnalysis(page, request, projectId) {
  const upload = await request.post(`${BASE_URL}/api/projects/${projectId}/templates`, {
    multipart: {
      image: { name: 'qa-template.png', mimeType: 'image/png', buffer: pngBuffer() },
      description: 'QA template fixture. Delete after analysis.',
    },
    timeout: 90000,
  });
  const uploadBody = await upload.json().catch(async () => ({ raw: await upload.text().catch(() => '') }));
  if (!upload.ok()) throw new Error(`Template upload failed HTTP ${upload.status()}: ${bodyTextPreview(uploadBody)}`);
  const templateId = uploadBody.id;
  try {
    const analysis = await pageFetchJson(page, 'POST', `/api/projects/${projectId}/templates/${templateId}/analyze`, { force: true }, 180000);
    if (!analysis.ok) throw new Error(`Template analysis failed HTTP ${analysis.status}: ${bodyTextPreview(analysis.data)}`);
    if (!analysis.data?.analysis) throw new Error(`Template analysis returned no analysis: ${bodyTextPreview(analysis.data)}`);
    return { templateId, analysis: analysis.data.analysis };
  } finally {
    await apiJson(request, 'DELETE', `/api/projects/${projectId}/templates/${templateId}`, undefined, { allowFailure: true });
  }
}

async function chooseHeadlineAngles() {
  const { getConductorAngles } = await import('../convexClient.js');
  const angles = await getConductorAngles(CCW_PROJECT_ID);
  const archived = angles.filter((angle) => String(angle.status || '').toLowerCase() === 'archived');
  const direct = archived.filter((angle) => /direct/i.test(`${angle.source || ''} ${angle.name || ''}`));
  const selected = (direct.length >= 3 ? direct : archived).slice(0, 3);
  if (selected.length < 3) throw new Error(`Only found ${selected.length} archived angles for headline preview.`);
  return selected.map((angle) => ({ id: angle.externalId, name: angle.name, status: angle.status, source: angle.source }));
}

async function runHeadlinePreviewScript() {
  const angles = await chooseHeadlineAngles();
  const runs = [];
  for (const angle of angles) {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['backend/scripts/previewDirectOfferHeadlines.js', '--angle', angle.id], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`previewDirectOfferHeadlines exited ${code}: ${stderr || stdout}`));
      });
    });
    const headlines = output.stdout
      .split('\n')
      .filter((line) => /^\d+\.\s+/.test(line))
      .slice(0, 16)
      .map((line) => line.replace(/^\d+\.\s+/, ''));
    runs.push({ angle, headlineCount: headlines.length, headlines: headlines.slice(0, 5) });
    if (headlines.length === 0) throw new Error(`Headline preview returned no headlines for ${angle.name}`);
  }
  return runs;
}

async function runDocSynthesis(page, projectId) {
  const researchContent = [
    'QA automated test research packet for a fictional productivity coaching offer.',
    'Offer: a simple 7-day planning sprint that helps busy agency owners organize campaigns, reduce missed handoffs, and create a repeatable daily work rhythm.',
    'Audience: small business owners and marketing teams who feel scattered, are skeptical of complex productivity systems, and want a practical process they can start today.',
    'Core benefits: clearer priorities, fewer stalled tasks, better team visibility, and a calmer end-of-day review.',
    'Proof constraints: this is synthetic QA content, so avoid unverifiable claims and use cautious language.',
  ].join('\n\n');
  const result = await pageFetchSse(page, `/api/projects/${projectId}/generate-docs-manual`, { researchContent }, 8 * 60 * 1000);
  if (!result.ok || !result.done) {
    throw new Error(`Doc synthesis stream failed HTTP ${result.status}: ${bodyTextPreview(result.text || result.events?.slice(-5))}`);
  }
  const docs = await pageFetchJson(page, 'GET', `/api/projects/${projectId}/docs`, undefined, 60000);
  if (!docs.ok) throw new Error(`Docs fetch failed HTTP ${docs.status}: ${bodyTextPreview(docs.data)}`);
  const found = new Set((docs.data?.docs || []).map((doc) => doc.doc_type));
  const missing = DOC_TYPES.filter((type) => !found.has(type));
  if (missing.length) throw new Error(`Doc synthesis missing docs: ${missing.join(', ')}`);
  return { generatedDocs: [...found].filter((type) => DOC_TYPES.includes(type)), eventCount: result.events.length };
}

async function runAdGeneration(page, projectId) {
  const product = pngBuffer().toString('base64');
  const result = await pageFetchSse(page, `/api/projects/${projectId}/generate-ad`, {
    mode: 'mode1',
    aspect_ratio: '1:1',
    angle: 'QA smoke test angle: help agency owners reduce daily campaign chaos.',
    headline: 'Turn scattered campaign work into a clear daily plan',
    body_copy: 'A simple planning sprint for busy teams that need cleaner handoffs and calmer execution.',
    product_image: product,
    product_image_mime: 'image/png',
    skip_product_image: false,
  }, 10 * 60 * 1000);
  if (!result.ok || !result.done) {
    throw new Error(`Ad generation stream failed HTTP ${result.status}: ${bodyTextPreview(result.text || result.events?.slice(-5))}`);
  }
  const ads = await pageFetchJson(page, 'GET', `/api/projects/${projectId}/ads`, undefined, 60000);
  if (!ads.ok) throw new Error(`Ads fetch failed HTTP ${ads.status}: ${bodyTextPreview(ads.data)}`);
  const latest = (ads.data?.ads || [])[0];
  const completed = (ads.data?.ads || []).find((ad) => ad.status === 'completed' && (ad.imageUrl || ad.thumbnailUrl || ad.storageId));
  if (!completed) throw new Error(`No completed ad with image found. Latest: ${bodyTextPreview(latest)}`);
  return { adId: completed.id, status: completed.status, hasImage: true };
}

async function createPosterUser(request, timestamp) {
  const username = `qa-poster-${timestamp}`;
  const password = `QaPoster-${timestamp}-${crypto.randomBytes(5).toString('hex')}!`;
  const result = await apiJson(request, 'POST', '/api/users', {
    username,
    display_name: username,
    password,
    role: 'poster',
  });
  report.fixtures.posterUser = { id: result.body.user.id, username };
  countTest(true);
  return { id: result.body.user.id, username, password };
}

async function logout(page) {
  await pageFetchJson(page, 'POST', '/api/auth/logout', undefined, 30000).catch(() => null);
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
}

async function loginAs(page, username, password) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input', { timeout: 30000 });
  await page.locator('input[type="text"],input[name="username"],input[autocomplete="username"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"],button').filter({ hasText: /log in|sign in/i }).first().click();
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  if (page.url().includes('/login')) throw new Error(`Login failed for ${username}`);
}

async function runRoleTests(browser, adminPassword, projectId, posterUser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await loginAs(page, posterUser.username, posterUser.password);
    await page.goto(`${BASE_URL}/projects/${projectId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const body = await page.locator('body').innerText().catch(() => '');
    if (!/Ad Pipeline/i.test(body) || /Ad Studio|Automation|Project Settings|Settings/i.test(body)) {
      throw new Error('Poster nav visibility is wrong: expected only Ad Pipeline/Tracker project navigation.');
    }
    const forbidden = [
      { url: '/settings', expected: /settings/i, label: 'settings' },
      { url: '/projects/new', expected: /new project/i, label: 'project creation' },
      { url: `/projects/${projectId}?tab=automation`, expected: /automation|creative director/i, label: 'automation tab' },
    ];
    const violations = [];
    for (const item of forbidden) {
      await page.goto(`${BASE_URL}${item.url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      const text = await page.locator('body').innerText().catch(() => '');
      if (item.expected.test(text) && !/not authorized|insufficient|login/i.test(text)) {
        violations.push(`Poster can access ${item.label} via ${item.url}`);
      }
    }
    if (violations.length) throw new Error(violations.join('; '));
    countTest(true);
  } finally {
    await ctx.close();
  }

  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  try {
    await loginAs(adminPage, ADMIN_USERNAME, adminPassword);
    countTest(true);
  } finally {
    await adminCtx.close();
  }
}

async function cleanup(request, projectId, posterUserId) {
  if (projectId) {
    await apiJson(request, 'DELETE', `/api/projects/${projectId}`, undefined, { allowFailure: true, timeout: 90000 })
      .then((res) => report.cleanup.push({ fixture: 'test project', method: 'archive via API', status: res.ok ? 'ok' : 'failed', detail: `HTTP ${res.status}` }))
      .catch((err) => report.cleanup.push({ fixture: 'test project', method: 'archive via API', status: 'failed', detail: redact(err.message) }));
  }
  if (posterUserId) {
    await apiJson(request, 'DELETE', `/api/users/${posterUserId}`, undefined, { allowFailure: true })
      .then((res) => report.cleanup.push({ fixture: 'poster user', method: 'HTTP user CRUD', status: res.ok ? 'ok' : 'failed', detail: `HTTP ${res.status}` }))
      .catch((err) => report.cleanup.push({ fixture: 'poster user', method: 'HTTP user CRUD', status: 'failed', detail: redact(err.message) }));
  }
}

async function directFinalCleanup() {
  try {
    const { getAllUsers, deleteUser, getArchivedProjectSummaries, getProjectSummaries, archiveProject } = await import('../convexClient.js');
    const users = await getAllUsers();
    for (const user of users.filter((row) => /^qa-poster-/.test(row.username || ''))) {
      await deleteUser(user.externalId);
      report.cleanup.push({ fixture: `poster user ${user.username}`, method: 'direct Convex user CRUD helper', status: 'ok', detail: 'deleted' });
    }

    const activeProjectsBefore = await getProjectSummaries();
    for (const project of activeProjectsBefore.filter((row) => /^QA-Test-/.test(row.name || ''))) {
      await archiveProject(project.id);
      report.cleanup.push({ fixture: `test project ${project.name}`, method: 'direct Convex project archive helper', status: 'ok', detail: 'archived' });
    }

    const refreshedUsers = await getAllUsers();
    const testAdmin = refreshedUsers.find((user) => user.username === ADMIN_USERNAME);
    const activeAdmins = refreshedUsers.filter((user) => user.role === 'admin' && user.is_active !== false);
    if (testAdmin && activeAdmins.length > 1) {
      await deleteUser(testAdmin.externalId);
      report.cleanup.push({ fixture: 'test admin user', method: 'direct Convex user CRUD helper', status: 'ok', detail: 'deleted' });
    } else if (testAdmin) {
      report.cleanup.push({ fixture: 'test admin user', method: 'direct Convex user CRUD helper', status: 'blocked', detail: 'would remove last active admin' });
      addFailure('Critical', 'Cleanup: test admin user', 'Could not delete test admin user because it appears to be the last active admin.', ['Run cleanup']);
    } else {
      report.cleanup.push({ fixture: 'test admin user', method: 'direct Convex user CRUD helper', status: 'ok', detail: 'already absent' });
    }

    const afterUsers = await getAllUsers();
    const qaUsers = afterUsers.filter((user) => user.username === ADMIN_USERNAME || /^qa-poster-/.test(user.username || ''));
    const activeProjects = await getProjectSummaries();
    const archivedProjects = await getArchivedProjectSummaries();
    const qaActiveProjects = activeProjects.filter((project) => /^QA-Test-/.test(project.name || ''));
    const qaArchivedProjects = archivedProjects.filter((project) => /^QA-Test-/.test(project.name || ''));
    report.cleanup.push({ fixture: 'cleanup verification', method: 'Convex queries', status: qaUsers.length === 0 && qaActiveProjects.length === 0 ? 'ok' : 'failed', detail: `${qaUsers.length} QA users, ${qaActiveProjects.length} active QA projects, ${qaArchivedProjects.length} archived QA projects` });
    if (qaUsers.length > 0) addFailure('Critical', 'Cleanup verification', `${qaUsers.length} QA users remain.`, ['Query users after cleanup']);
    if (qaActiveProjects.length > 0) addFailure('Critical', 'Cleanup verification', `${qaActiveProjects.length} active QA projects remain.`, ['Query active projects after cleanup']);
    if (qaArchivedProjects.length > 0) {
      addFailure('Medium', 'Cleanup verification', `${qaArchivedProjects.length} QA project row(s) remain archived because the existing project delete path is archival, not hard delete.`, ['Create QA project', 'Delete via existing project API', 'Query archived projects']);
    }
  } catch (err) {
    report.cleanup.push({ fixture: 'final cleanup verification', method: 'Convex direct', status: 'failed', detail: redact(err.message) });
    addFailure('Critical', 'Cleanup verification', err.message, ['Run final cleanup verification']);
  }
}

function severityCounts() {
  return ['Critical', 'High', 'Medium', 'Low'].reduce((acc, sev) => {
    acc[sev.toLowerCase()] = report.failures.filter((failure) => failure.severity === sev).length;
    return acc;
  }, {});
}

function formatReport() {
  const counts = severityCounts();
  const runtimeMs = Date.now() - new Date(report.startedAt).getTime();
  const routesTable = report.routes.map((route) => `| ${route.route} | ${route.status} | ${route.errorCount} |`).join('\n');
  const flows = report.llmFlows.map((flow) => `| ${flow.name} | ${flow.status} | $${Number(flow.cost || 0).toFixed(4)} | ${flow.error || JSON.stringify(flow.details || {}).slice(0, 180)} |`).join('\n');
  const grouped = ['Critical', 'High', 'Medium', 'Low'].map((sev) => {
    const items = report.failures.filter((failure) => failure.severity === sev);
    if (!items.length) return `#### ${sev}\nNone.`;
    return `#### ${sev}\n` + items.map((failure, i) => [
      `${i + 1}. Location: ${failure.location}`,
      `   Error: ${failure.message}`,
      `   Steps: ${failure.steps?.join(' -> ') || 'N/A'}`,
      `   Recommended priority: ${sev}`,
      failure.screenshot ? `   Screenshot: ${failure.screenshot}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');
  }).join('\n\n');
  const cleanup = report.cleanup.map((item) => `- ${item.fixture}: ${item.status} (${item.method}; ${item.detail})`).join('\n');
  const blockers = report.blockers.length ? report.blockers.map((b) => `- ${b}`).join('\n') : 'None.';

  return [
    '### Summary',
    `- Total tests run: ${report.totalTests}`,
    `- Pass count: ${report.passed}`,
    `- Fail count by severity: critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}`,
    `- Total LLM cost incurred: $${Number(report.cost.total || 0).toFixed(4)}${report.cost.start === null ? ' (cost endpoint unavailable for baseline)' : ''}`,
    `- Total runtime: ${Math.round(runtimeMs / 1000)}s`,
    '',
    '### Test infrastructure',
    `- Test script path: ${report.scriptPath}`,
    `- Test target: ${report.target}`,
    `- Test fixtures created: project ${report.fixtures.testProject?.name || 'not created'}, poster ${report.fixtures.posterUser?.username || 'not created'}, admin ${report.fixtures.adminUser}`,
    `- Storage state: ${STORAGE_STATE_PATH}`,
    '',
    '### Routes tested',
    '| Route | Status | Error count |',
    '|---|---:|---:|',
    routesTable || '| none | n/a | n/a |',
    '',
    '### LLM flows',
    '| Flow | Result | Cost | Details |',
    '|---|---:|---:|---|',
    flows || '| none | n/a | $0.0000 | n/a |',
    '',
    '### Errors found (categorized)',
    grouped,
    '',
    '### Test fixtures cleanup confirmation',
    cleanup || 'No cleanup actions recorded.',
    '',
    '### Issues that block running the suite',
    blockers,
  ].join('\n');
}

async function main() {
  await ensureDir(ARTIFACT_DIR);
  const adminPassword = await readPassword();
  if (!adminPassword) throw new Error('Missing admin password on stdin or THRIVE_ADMIN_PASSWORD.');

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();
  const capture = { consoleErrors: [], pageErrors: [], networkErrors: [] };
  attachCapture(page, capture);
  let testProject = null;
  let poster = null;

  try {
    await testRoute(page, 'public-login', '/login');
    await login(page, adminPassword);
    await context.storageState({ path: STORAGE_STATE_PATH });
    countTest(true);
    const costStart = await getCostSnapshot(page);
    report.cost.start = costStart.available ? costStart.value : null;

    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    testProject = await createTestProject(context.request, timestamp);

    const adminRoutes = [
      ['home', '/'],
      ['projects', '/projects'],
      ['projects-new', '/projects/new'],
      ['project-detail', `/projects/${testProject.id}`],
      ['settings', '/settings'],
      ['agents', '/agents'],
      ['ad-tracker', '/ad-tracker'],
      ['project-docs', `/projects/${testProject.id}?tab=overview&subtab=docs`],
      ['project-ad-studio', `/projects/${testProject.id}?tab=ads`],
      ['project-templates', `/projects/${testProject.id}?tab=overview&subtab=templates`],
      ['project-inspiration', `/projects/${testProject.id}?tab=overview&subtab=templates`],
      ['project-automation', `/projects/${testProject.id}?tab=automation`],
      ['project-analytics', `/projects/${testProject.id}?tab=analytics`],
      ['project-observation', `/projects/${testProject.id}?tab=observation`],
      ['project-meta', `/projects/${testProject.id}?tab=overview&subtab=meta`],
      ['project-settings', `/projects/${testProject.id}?tab=overview&subtab=general`],
    ];
    for (const [label, route] of adminRoutes) {
      await testRoute(page, label, route);
      await enumerateInteractions(page, label, 24);
    }

    await testSettingsPersist(page).catch((err) => {
      addFailure('High', 'Settings save/persist', err.message, ['GET /api/settings', 'PUT editable Gemini rate fields', 'GET /api/settings']);
      countTest(false);
    });

    await withCost(page, 'API key tests (Settings admin UI)', () => runApiKeyTestsViaUi(page));
    await withCost(page, 'Template upload + GPT analysis', () => runTemplateAnalysis(page, context.request, testProject.id), testProject.id);
    await withCost(page, 'Headline preview script (3 archived angles)', () => runHeadlinePreviewScript());
    await withCost(page, 'Foundational doc synthesis', () => runDocSynthesis(page, testProject.id), testProject.id);
    await withCost(page, 'Manual Mode 1 ad generation with image', () => runAdGeneration(page, testProject.id), testProject.id);

    poster = await createPosterUser(context.request, timestamp);
    await runRoleTests(browser, adminPassword, testProject.id, poster).catch((err) => {
      addFailure('High', 'Role-based access enforcement', err.message, ['Create poster user', 'Log in as poster', 'Probe restricted routes']);
      countTest(false);
    });
  } catch (err) {
    addFailure('Critical', 'Suite execution', err.message, ['Run comprehensive suite']);
    report.blockers.push(redact(err.message));
  } finally {
    try {
      await cleanup(context.request, testProject?.id, poster?.id);
    } catch (err) {
      addFailure('Critical', 'Fixture cleanup', err.message, ['Cleanup fixtures']);
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await directFinalCleanup();
    report.finishedAt = new Date().toISOString();
    const markdown = formatReport();
    await fs.writeFile(path.join(ARTIFACT_DIR, 'report.md'), markdown);
    process.stdout.write(markdown + '\n');
  }
}

main().catch(async (err) => {
  addFailure('Critical', 'Runner bootstrap', err.message, ['Start runner']);
  report.blockers.push(redact(err.message));
  const markdown = formatReport();
  await ensureDir(ARTIFACT_DIR).catch(() => {});
  await fs.writeFile(path.join(ARTIFACT_DIR, 'report.md'), markdown).catch(() => {});
  process.stdout.write(markdown + '\n');
  process.exitCode = 1;
});

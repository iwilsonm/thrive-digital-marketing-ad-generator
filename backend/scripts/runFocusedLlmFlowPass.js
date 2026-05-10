#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = 'https://thrive-digital-marketing-ad-generat.vercel.app';
const PROD_CONVEX_URL = process.env.THRIVE_PROD_CONVEX_URL || 'https://cheery-cobra-258.convex.cloud';
process.env.CONVEX_URL = PROD_CONVEX_URL;

const ADMIN_USERNAME = process.env.THRIVE_ADMIN_USERNAME || 'test';
const ARTIFACT_DIR = path.join(REPO_ROOT, '.tmp', `focused-llm-pass-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const STORAGE_STATE_PATH = path.join(ARTIFACT_DIR, 'admin-storage-state.json');
const HEADLESS = process.env.HEADLESS !== '0';
const COST_BUDGET = 10;
const DOC_TYPES = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];

const report = {
  startedAt: Date.now(),
  tests: 0,
  pass: 0,
  failures: [],
  flows: [],
  cleanup: [],
  blockers: [],
  totalCost: 0,
  fixtures: {
    project: null,
    poster: null,
    adminDeleted: false,
  },
};

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redact(value) {
  let text = String(value || '');
  const secret = process.env.THRIVE_ADMIN_PASSWORD || '';
  if (secret) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  return text;
}

function noteTest(ok) {
  report.tests += 1;
  if (ok) report.pass += 1;
}

function addError(severity, location, message, steps, priority = severity) {
  report.failures.push({ severity, location, message: redact(message), steps, priority });
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
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}

function capture(page) {
  const bucket = { consoleErrors: [], networkErrors: [], pageErrors: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.consoleErrors.push(redact(msg.text()));
  });
  page.on('pageerror', (err) => bucket.pageErrors.push(redact(err.stack || err.message)));
  page.on('response', async (res) => {
    const status = res.status();
    if (status < 400) return;
    const url = res.url();
    if (status === 401 && /\/api\/auth\/session|\/api\/auth\/login/.test(url)) return;
    let body = '';
    try { body = await res.text(); } catch {}
    bucket.networkErrors.push({ status, url, body: redact(body.slice(0, 500)) });
  });
  return bucket;
}

async function login(page, password, username = ADMIN_USERNAME) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('login-username').waitFor({ timeout: 30000 });
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  const loginResponse = page.waitForResponse((res) => res.url().includes('/api/auth/login'), { timeout: 30000 });
  await page.getByTestId('login-submit').click();
  const res = await loginResponse;
  const body = await res.text().catch(() => '');
  if (!res.ok()) throw new Error(`Login failed HTTP ${res.status()}: ${body}`);
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (page.url().includes('/login')) throw new Error('Login submitted but remained on login page.');
}

async function fetchJson(page, method, url, body, timeoutMs = 60000) {
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

async function fetchSse(page, url, body, timeoutMs = 10 * 60 * 1000) {
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
        if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => ''), events };
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
            if (raw === '[DONE]') return { ok: true, status: res.status, done: true, events };
            try { events.push(JSON.parse(raw)); } catch { events.push({ raw }); }
          }
        }
        return { ok: true, status: res.status, done: false, events };
      } catch (err) {
        return { ok: false, status: 0, text: err.message, events };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, body, timeoutMs }
  );
}

async function getProjectCost(page, projectId) {
  if (!projectId) return 0;
  const res = await fetchJson(page, 'GET', `/api/projects/${projectId}/costs`, undefined, 45000);
  if (!res.ok) return 0;
  const raw = res.data || {};
  return Number(raw?.month?.total ?? raw?.total ?? raw?.total_cost ?? 0) || 0;
}

async function recordFlow(page, name, fn, projectId = null) {
  const before = await getProjectCost(page, projectId);
  const started = Date.now();
  try {
    const result = await fn();
    const after = await getProjectCost(page, projectId);
    const cost = Math.max(0, after - before);
    report.totalCost += cost;
    if (report.totalCost > COST_BUDGET) throw new Error(`Cost budget exceeded: $${report.totalCost.toFixed(4)}`);
    report.flows.push({ name, result: 'PASS', cost, notes: result?.notes || JSON.stringify(result || {}).slice(0, 220) });
    noteTest(true);
    return result;
  } catch (err) {
    const after = await getProjectCost(page, projectId).catch(() => before);
    const cost = Math.max(0, after - before);
    report.totalCost += cost;
    report.flows.push({ name, result: 'FAIL', cost, notes: redact(err.message) });
    addError(/401|auth|login/i.test(err.message) ? 'Critical' : 'High', name, err.stack || err.message, [`Run ${name}`]);
    noteTest(false);
    return null;
  } finally {
    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds > 300) {
      report.flows.push({ name: `${name} duration note`, result: 'INFO', cost: 0, notes: `${seconds}s` });
    }
  }
}

async function createProjectViaUi(page, timestamp) {
  await page.goto(`${BASE_URL}/projects/new`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const values = {
    name: `QA-Test-${timestamp}`,
    brand_name: `QA Brand ${timestamp}`,
    niche: 'QA focused LLM smoke test',
    sales_page_content: 'Synthetic QA offer for a seven day planning sprint that helps small marketing teams create clearer campaign handoffs, avoid missed tasks, and produce calmer daily execution. This is test-only content.',
    product_description: 'A synthetic planning sprint offer used only for QA automation.',
  };
  await page.locator('input[name="name"]').fill(values.name);
  await page.locator('input[name="brand_name"]').fill(values.brand_name);
  await page.locator('input[name="niche"]').fill(values.niche);
  await page.locator('textarea[name="sales_page_content"]').fill(values.sales_page_content);
  await page.locator('textarea[name="product_description"]').fill(values.product_description);
  const responsePromise = page.waitForResponse((res) => res.url().endsWith('/api/projects') && res.request().method() === 'POST', { timeout: 90000 });
  await page.getByRole('button', { name: /^Create Project$/ }).click();
  const res = await responsePromise;
  const body = await res.json().catch(async () => ({ raw: await res.text().catch(() => '') }));
  if (!res.ok()) throw new Error(`Project UI create failed HTTP ${res.status()}: ${JSON.stringify(body)}`);
  await page.waitForURL(/\/projects\/[0-9a-f-]+/i, { timeout: 30000 }).catch(() => {});
  report.fixtures.project = { id: body.id, name: values.name };
  return body;
}

async function clickApiKeyTest(page, label, endpoint) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const clicked = await page.evaluate((label) => {
    const candidates = [...document.querySelectorAll('div')]
      .filter((el) => (el.innerText || '').includes(label))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    for (const el of candidates) {
      const button = [...el.querySelectorAll('button')].find((btn) => /^Test$/i.test((btn.innerText || '').trim()));
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }, label);
  await page.waitForTimeout(3000);
  const direct = await fetchJson(page, 'POST', endpoint, {}, 60000);
  if (!clicked) throw new Error(`Could not find/click ${label} Test button. Direct endpoint HTTP ${direct.status}: ${JSON.stringify(direct.data)}`);
  if (!direct.ok) throw new Error(`${label} endpoint HTTP ${direct.status}: ${JSON.stringify(direct.data)}`);
  return { notes: direct.data?.message || 'Key test passed' };
}

async function settingsPersist(page, projectId) {
  const original = await fetchJson(page, 'GET', `/api/projects/${projectId}`);
  if (!original.ok) throw new Error(`Project read failed HTTP ${original.status}`);
  const marker = `QA persist marker ${Date.now()}`;
  const save = await fetchJson(page, 'PUT', `/api/projects/${projectId}`, { prompt_guidelines: marker });
  if (!save.ok) throw new Error(`Project setting save failed HTTP ${save.status}: ${JSON.stringify(save.data)}`);
  await page.goto(`${BASE_URL}/projects/${projectId}?tab=overview&subtab=general`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  const reread = await fetchJson(page, 'GET', `/api/projects/${projectId}`);
  if (reread.data?.prompt_guidelines !== marker) throw new Error(`Prompt guidelines did not persist. Got ${reread.data?.prompt_guidelines || '(empty)'}`);
  await fetchJson(page, 'PUT', `/api/projects/${projectId}`, { prompt_guidelines: original.data?.prompt_guidelines || '' });
  return { notes: 'Project Settings prompt_guidelines saved, refreshed, verified, restored.' };
}

function pngBuffer() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAAAA3NCSVQICAjb4U/gAAABJElEQVR4nO3RMQEAIAzAsIF/z0MGRxMFfXpnJ4C5OQF4Y4AxwBhgDDAFGAPMAWaAMcAYYAwYAxwBhgBjgDHAGGAMMAaYAcwAY4AxwBhgDDAGGAOMAcYAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYAwYAxgDzABjgDHAGGAMMAaYAcwAY4AxwBhgDDAGmAHMAGOAMcAYYPwBMucCrRmg1i0AAAAASUVORK5CYII=', 'base64');
}

async function templateAnalysis(page, context, projectId) {
  await page.goto(`${BASE_URL}/projects/${projectId}?tab=overview&subtab=templates`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const upload = await context.request.post(`${BASE_URL}/api/projects/${projectId}/templates`, {
    multipart: {
      image: { name: 'qa-template.png', mimeType: 'image/png', buffer: pngBuffer() },
      description: 'QA focused pass template',
    },
    timeout: 90000,
  });
  const uploadBody = await upload.json().catch(async () => ({ raw: await upload.text().catch(() => '') }));
  if (!upload.ok()) throw new Error(`Template upload HTTP ${upload.status()}: ${JSON.stringify(uploadBody)}`);
  const analyze = await fetchJson(page, 'POST', `/api/projects/${projectId}/templates/${uploadBody.id}/analyze`, { force: true }, 180000);
  if (!analyze.ok) throw new Error(`Template analysis HTTP ${analyze.status}: ${JSON.stringify(analyze.data)}`);
  if (!analyze.data?.analysis?.layout_description) throw new Error(`Template analysis missing layout_description: ${JSON.stringify(analyze.data)}`);
  return { templateId: uploadBody.id, notes: `Analysis rendered via API: ${analyze.data.analysis.layout_description}` };
}

async function docSynthesis(page, projectId) {
  await page.goto(`${BASE_URL}/projects/${projectId}?tab=overview&subtab=docs`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const researchContent = [
    'QA research packet for a fictional planning sprint offer.',
    'The offer helps overwhelmed marketing teams replace scattered Slack follow-ups with a daily campaign execution ritual.',
    'Audience: small agency owners, media buyers, and creative leads who have too many active tasks and unclear handoffs.',
    'Pain points: missed launch details, ad variants stuck in review, unclear ownership, and late-day stress.',
    'Desired outcome: a clear morning plan, visible blockers, faster reviews, and calmer end-of-day closeout.',
    'Objections: users dislike complicated productivity systems, worry setup will take too long, and need a practical lightweight method.',
    'Use cautious language. This is synthetic QA content. Do not claim studies, guarantees, revenue lifts, or client outcomes.',
  ].join('\n\n');
  const stream = await fetchSse(page, `/api/projects/${projectId}/generate-docs-manual`, { researchContent }, 10 * 60 * 1000);
  if (!stream.ok || !stream.done) throw new Error(`Doc synthesis HTTP ${stream.status}: ${stream.text || JSON.stringify(stream.events.slice(-5))}`);
  const docs = await fetchJson(page, 'GET', `/api/projects/${projectId}/docs`, undefined, 60000);
  if (!docs.ok) throw new Error(`Docs fetch HTTP ${docs.status}: ${JSON.stringify(docs.data)}`);
  const present = new Set((docs.data?.docs || []).map((doc) => doc.doc_type));
  const missing = DOC_TYPES.filter((type) => !present.has(type));
  if (missing.length) throw new Error(`Missing docs: ${missing.join(', ')}`);
  return { notes: `Generated docs: ${DOC_TYPES.join(', ')}; events=${stream.events.length}` };
}

async function adGeneration(page, projectId) {
  await page.goto(`${BASE_URL}/projects/${projectId}?tab=ads`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('ad-studio-generator').waitFor({ timeout: 60000 });
  const stream = await fetchSse(page, `/api/projects/${projectId}/generate-ad`, {
    mode: 'mode1',
    aspect_ratio: '1:1',
    angle: 'QA angle: simplify chaotic campaign handoffs.',
    headline: 'Make every campaign day easier to finish',
    body_copy: 'A lightweight planning sprint for small teams that need clearer handoffs and calmer execution.',
    product_image: pngBuffer().toString('base64'),
    product_image_mime: 'image/png',
  }, 12 * 60 * 1000);
  if (!stream.ok || !stream.done) throw new Error(`Ad generation HTTP ${stream.status}: ${stream.text || JSON.stringify(stream.events.slice(-5))}`);
  const ads = await fetchJson(page, 'GET', `/api/projects/${projectId}/ads`, undefined, 60000);
  const completed = (ads.data?.ads || []).find((ad) => ad.status === 'completed' && (ad.imageUrl || ad.thumbnailUrl || ad.storageId));
  if (!completed) throw new Error(`No completed ad with image. Ads: ${JSON.stringify((ads.data?.ads || []).slice(0, 3))}`);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('ad-gallery').waitFor({ timeout: 60000 });
  return { notes: `Completed ad ${completed.id} rendered in gallery.` };
}

async function createPoster(page, timestamp) {
  const username = `qa-poster-${timestamp}`;
  const password = `QaPoster-${timestamp}-${crypto.randomBytes(4).toString('hex')}!`;
  const res = await fetchJson(page, 'POST', '/api/users', {
    username,
    display_name: username,
    password,
    role: 'poster',
  });
  if (!res.ok) throw new Error(`Create poster HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  report.fixtures.poster = { id: res.data.user.id, username };
  return { id: res.data.user.id, username, password };
}

async function roleAccess(browser, adminPassword, projectId, timestamp) {
  const adminContext = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const adminPage = await adminContext.newPage();
  const poster = await createPoster(adminPage, timestamp);
  await fetchJson(adminPage, 'POST', '/api/auth/logout');
  await adminContext.close();

  const posterContext = await browser.newContext();
  const posterPage = await posterContext.newPage();
  await login(posterPage, poster.password, poster.username);
  await posterPage.goto(`${BASE_URL}/projects/${projectId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await posterPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const navText = await posterPage.locator('body').innerText().catch(() => '');
  const navOk = /Ad Pipeline|Tracker/i.test(navText) && !/Ad Studio|Automation|Settings/i.test(navText);
  const probes = [];
  for (const url of ['/settings', '/projects/new', `/projects/${projectId}?tab=automation`]) {
    await posterPage.goto(`${BASE_URL}${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await posterPage.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    const text = await posterPage.locator('body').innerText().catch(() => '');
    probes.push({ url, blocked: !/Settings|New Project|Creative Director|Automation/i.test(text) });
  }
  await fetchJson(posterPage, 'POST', '/api/auth/logout').catch(() => null);
  await posterContext.close();

  const adminContext2 = await browser.newContext();
  const adminPage2 = await adminContext2.newPage();
  await login(adminPage2, adminPassword, ADMIN_USERNAME);
  const del = await fetchJson(adminPage2, 'DELETE', `/api/users/${poster.id}`);
  await adminContext2.storageState({ path: STORAGE_STATE_PATH });
  await adminContext2.close();
  if (!del.ok) throw new Error(`Delete poster HTTP ${del.status}: ${JSON.stringify(del.data)}`);
  if (!navOk || probes.some((probe) => !probe.blocked)) throw new Error(`Poster access violation: navOk=${navOk}, probes=${JSON.stringify(probes)}`);
  return { notes: `Poster ${poster.username} restricted and deleted.` };
}

async function cleanup(projectId, posterId) {
  const {
    getAllUsers,
    deleteUser,
    getProjectSummaries,
    getArchivedProjectSummaries,
    archiveProject,
    getAdsByProject,
    getTemplateImagesByProject,
    mutationWithRetry,
    api,
  } = await import('../convexClient.js');

  if (projectId) {
    try {
      const ads = await getAdsByProject(projectId);
      for (const ad of ads) await mutationWithRetry(api.adCreatives.remove, { externalId: ad.id });
      report.cleanup.push(`Deleted ${ads.length} ad(s) for test project.`);
    } catch (err) {
      report.cleanup.push(`Ad cleanup failed: ${redact(err.message)}`);
    }
    try {
      const templates = await getTemplateImagesByProject(projectId);
      for (const tmpl of templates) await mutationWithRetry(api.templateImages.remove, { externalId: tmpl.externalId });
      report.cleanup.push(`Deleted ${templates.length} template(s) for test project.`);
    } catch (err) {
      report.cleanup.push(`Template cleanup failed: ${redact(err.message)}`);
    }
    try {
      const docs = await mutationWithRetry(api.foundationalDocs.removeByProject, { projectId });
      report.cleanup.push(`Deleted ${docs.deleted || 0} foundational doc(s) for test project.`);
    } catch (err) {
      report.cleanup.push(`Doc cleanup failed: ${redact(err.message)}`);
    }
    try {
      await archiveProject(projectId);
      report.cleanup.push('Archived test project via existing project delete/archive semantics.');
    } catch (err) {
      report.cleanup.push(`Project archive failed: ${redact(err.message)}`);
    }
  }

  const users = await getAllUsers();
  for (const user of users.filter((u) => u.externalId === posterId || /^qa-poster-/.test(u.username || ''))) {
    try {
      await deleteUser(user.externalId);
      report.cleanup.push(`Deleted poster user ${user.username}.`);
    } catch (err) {
      report.cleanup.push(`Poster cleanup failed for ${user.username}: ${redact(err.message)}`);
    }
  }
  const refreshedUsers = await getAllUsers();
  const admin = refreshedUsers.find((user) => user.username === ADMIN_USERNAME);
  if (admin) {
    try {
      await deleteUser(admin.externalId);
      report.fixtures.adminDeleted = true;
      report.cleanup.push('Test admin user deleted.');
    } catch (err) {
      report.cleanup.push(`Test admin deletion failed: ${redact(err.message)}`);
    }
  } else {
    report.fixtures.adminDeleted = true;
    report.cleanup.push('Test admin user already absent.');
  }

  const afterUsers = await getAllUsers();
  const activeProjects = await getProjectSummaries();
  const archivedProjects = await getArchivedProjectSummaries();
  const qaUsers = afterUsers.filter((user) => user.username === ADMIN_USERNAME || /^qa-poster-/.test(user.username || ''));
  const qaActive = activeProjects.filter((project) => /^QA-Test-/.test(project.name || ''));
  const qaArchived = archivedProjects.filter((project) => /^QA-Test-/.test(project.name || ''));
  report.cleanup.push(`Verification: ${qaUsers.length} QA users, ${qaActive.length} active QA projects, ${qaArchived.length} archived QA projects.`);
  if (qaUsers.length || qaActive.length) {
    addError('Critical', 'Cleanup verification', `Remaining fixtures: users=${qaUsers.length}, activeProjects=${qaActive.length}`, ['Run final production cleanup verification']);
  }
  if (qaArchived.length) {
    addError('Medium', 'Cleanup verification', `${qaArchived.length} QA project row(s) remain archived because the existing project delete path archives instead of hard-deleting project records.`, ['Create test project', 'Clean associated assets', 'Archive project', 'Query archived projects']);
  }
}

function severityCounts() {
  const out = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const failure of report.failures) out[failure.severity.toLowerCase()] += 1;
  return out;
}

function format() {
  const counts = severityCounts();
  const rows = [
    'API key — OpenAI',
    'API key — Anthropic',
    'API key — Gemini',
    'Settings save/persist',
    'Template upload + GPT analysis',
    'Foundational doc synthesis',
    'Manual Mode 1 ad generation',
    'Role-based access enforcement',
  ].map((name) => {
    const flow = report.flows.find((item) => item.name === name);
    return `| ${name} | ${flow?.result || 'NOT RUN'} | $${Number(flow?.cost || 0).toFixed(4)} | ${redact(flow?.notes || '')} |`;
  }).join('\n');
  const grouped = ['Critical', 'High', 'Medium', 'Low'].map((sev) => {
    const items = report.failures.filter((item) => item.severity === sev);
    if (!items.length) return `#### ${sev}\nNone.`;
    return `#### ${sev}\n` + items.map((item, idx) =>
      `${idx + 1}. Location: ${item.location}\n   Error: ${item.message}\n   Repro steps: ${(item.steps || []).join(' -> ')}\n   Recommended priority: ${item.priority}`
    ).join('\n\n');
  }).join('\n\n');
  const blockers = report.blockers.length ? report.blockers.map((b) => `- ${redact(b)}`).join('\n') : 'None.';
  return [
    '### Pass 2 Summary',
    `- Total tests run: ${report.tests}`,
    `- Pass count: ${report.pass}`,
    `- Fail count by severity: critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}`,
    `- Total LLM cost incurred: $${report.totalCost.toFixed(4)}`,
    `- Total runtime: ${Math.round((Date.now() - report.startedAt) / 1000)}s`,
    '',
    '### Pass 2 LLM flow results',
    '| Flow | Result | Cost | Notes |',
    '|---|---|---|---|',
    rows,
    '',
    '### Pass 2 Errors found (categorized)',
    grouped,
    '',
    '### Pass 2 Test fixture cleanup',
    report.cleanup.map((line) => `- ${line}`).join('\n') || '- No cleanup actions recorded.',
    '',
    '### Pass 2 Issues that block running the suite',
    blockers,
  ].join('\n');
}

async function main() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const password = await readPassword();
  if (!password) throw new Error('Missing admin password.');
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();
  const bucket = capture(page);
  let projectId = null;
  let posterId = null;

  try {
    await login(page, password);
    await context.storageState({ path: STORAGE_STATE_PATH });
    noteTest(true);
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const project = await createProjectViaUi(page, timestamp);
    projectId = project.id;
    noteTest(true);

    await recordFlow(page, 'API key — OpenAI', () => clickApiKeyTest(page, 'OpenAI API Key', '/api/settings/test-openai'));
    await recordFlow(page, 'API key — Anthropic', () => clickApiKeyTest(page, 'Anthropic API Key', '/api/settings/test-anthropic'));
    await recordFlow(page, 'API key — Gemini', () => clickApiKeyTest(page, 'Gemini API Key', '/api/settings/test-gemini'));
    await recordFlow(page, 'Settings save/persist', () => settingsPersist(page, projectId), projectId);
    await recordFlow(page, 'Template upload + GPT analysis', () => templateAnalysis(page, context, projectId), projectId);
    await recordFlow(page, 'Foundational doc synthesis', () => docSynthesis(page, projectId), projectId);
    await recordFlow(page, 'Manual Mode 1 ad generation', () => adGeneration(page, projectId), projectId);
    const roleResult = await recordFlow(page, 'Role-based access enforcement', async () => {
      const result = await roleAccess(browser, password, projectId, timestamp);
      posterId = report.fixtures.poster?.id || null;
      return result;
    });
    if (!roleResult && report.fixtures.poster?.id) posterId = report.fixtures.poster.id;

    if (bucket.pageErrors.length || bucket.consoleErrors.length) {
      addError('Medium', 'Browser console/page errors', [...bucket.pageErrors, ...bucket.consoleErrors].join('\n'), ['Run focused Pass 2 flows']);
    }
    for (const net of bucket.networkErrors.filter((e) => !(e.status === 401 && /\/settings|\/projects\/new/.test(e.url)))) {
      addError(net.status >= 500 ? 'Critical' : 'Medium', 'Network error capture', `${net.status} ${net.url}: ${net.body}`, ['Run focused Pass 2 flows']);
    }
  } catch (err) {
    addError(/login|auth|401/i.test(err.message) ? 'Critical' : 'High', 'Pass 2 suite execution', err.stack || err.message, ['Run focused Pass 2 suite']);
    report.blockers.push(err.message);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await cleanup(projectId, posterId).catch((err) => {
      addError('Critical', 'Fixture cleanup', err.stack || err.message, ['Cleanup Pass 2 fixtures']);
    });
    const output = format();
    await fs.writeFile(path.join(ARTIFACT_DIR, 'report.md'), output);
    process.stdout.write(output + '\n');
  }
}

main().catch(async (err) => {
  addError('Critical', 'Pass 2 bootstrap', err.stack || err.message, ['Start focused Pass 2 runner']);
  const output = format();
  await fs.mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(ARTIFACT_DIR, 'report.md'), output).catch(() => {});
  process.stdout.write(output + '\n');
  process.exitCode = 1;
});

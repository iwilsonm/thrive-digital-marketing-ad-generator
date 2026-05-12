import { normalizeArrayFields, normalizeArrayResponse } from './utils/collections';
import { createApiErrorFromResponse, normalizeApiError, normalizeFetchException, parseResponseBody } from './utils/apiErrors';

const API_BASE = '/api';

async function throwForResponseError(res, fallback = 'Request failed') {
  throw await createApiErrorFromResponse(res, fallback);
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
  } catch (err) {
    throw normalizeFetchException(err, 'Request failed');
  }

  if (res.status === 401 && !path.includes('/auth/')) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }

  if (!res.ok) {
    await throwForResponseError(res);
  }

  const { parsed, rawText } = await parseResponseBody(res);
  if (rawText && parsed?.raw_body) {
    throw normalizeApiError({
      status: res.status,
      data: parsed,
      rawText,
      fallback: 'Invalid response from server',
    });
  }
  return parsed;
}

/**
 * Stream SSE from a POST endpoint (no body).
 * @param {string} path - API path
 * @param {(event: object) => void} onEvent - Called for each parsed SSE event
 * @returns {{ abort: () => void, done: Promise<void> }}
 */
function streamSSE(path, onEvent) {
  const controller = new AbortController();

  const done = (async () => {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      });
    } catch (err) {
      throw normalizeFetchException(err, 'Stream failed');
    }

    if (!res.ok) {
      await throwForResponseError(res, 'Stream failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;

    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            sawDone = true;
            return;
          }
          try {
            onEvent(JSON.parse(data));
          } catch {}
        }
      }
    }

    if (!sawDone) {
      throw new Error('The generation stream ended before the server confirmed completion. The app will keep checking the saved ad status.');
    }
  })();

  return { abort: () => controller.abort(), done };
}

/**
 * Stream SSE from a POST endpoint with a JSON body.
 * Same as streamSSE but sends request body (needed for manual research submission).
 * @param {string} path - API path
 * @param {object} body - JSON body to send
 * @param {(event: object) => void} onEvent - Called for each parsed SSE event
 * @returns {{ abort: () => void, done: Promise<void> }}
 */
function streamSSEWithBody(path, body, onEvent) {
  const controller = new AbortController();

  const done = (async () => {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      throw normalizeFetchException(err, 'Stream failed');
    }

    if (!res.ok) {
      await throwForResponseError(res, 'Stream failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;

    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            sawDone = true;
            return;
          }
          try {
            onEvent(JSON.parse(data));
          } catch {}
        }
      }
    }

    if (!sawDone) {
      throw new Error('The generation stream ended before the server confirmed completion. The app will keep checking the saved ad status.');
    }
  })();

  return { abort: () => controller.abort(), done };
}

// ─── Request Cache (tiered TTLs) ──────────────────────────────────────────────
// Caches read-only GET responses so back-navigation doesn't re-fetch.
// Mutations invalidate related entries immediately.
const _requestCache = new Map();

// Per-path TTLs — longer for data that rarely changes mid-session
function _getCacheTTL(path) {
  if (path === '/auth/session') return 5 * 60 * 1000;    // 5 min
  if (path === '/projects/options') return 2 * 60 * 1000; // 2 min
  if (path === '/projects/archived') return 2 * 60 * 1000; // 2 min
  if (path === '/projects') return 2 * 60 * 1000;         // 2 min
  if (path.match(/^\/projects\/[^/]+$/)) return 2 * 60 * 1000; // 2 min
  if (path === '/conductor/pipeline-status') return 30 * 1000; // 30s
  if (path.match(/^\/deployments/)) return 60 * 1000;     // 1 min
  if (path.match(/^\/conductor\//)) return 2 * 60 * 1000; // 2 min
  if (path.match(/^\/costs/)) return 2 * 60 * 1000;       // 2 min
  if (path.match(/\/landing-pages$/)) return 2 * 60 * 1000; // 2 min
  return 30 * 1000; // 30s default
}

function cachedRequest(path) {
  const cached = _requestCache.get(path);
  if (cached && Date.now() - cached.time < _getCacheTTL(path)) return Promise.resolve(cached.data);
  return request(path).then(data => {
    _requestCache.set(path, { data, time: Date.now() });
    return data;
  });
}

function invalidateCache(...paths) {
  for (const p of paths) _requestCache.delete(p);
}

function invalidateCacheWhere(predicate) {
  for (const key of _requestCache.keys()) {
    if (predicate(key)) _requestCache.delete(key);
  }
}

function invalidateDeploymentCache(projectId = null) {
  invalidateCache('/deployments');
  if (projectId) {
    invalidateCache(`/deployments?projectId=${projectId}`);
  } else {
    invalidateCacheWhere(key => key.startsWith('/deployments?projectId='));
  }
}

// Exported for use by components after SSE completions (e.g., doc generation)
export function invalidateProjectCache(projectId) {
  invalidateCache('/projects', '/projects/archived', '/projects/options', `/projects/${projectId}`, `/projects/${projectId}/stats`);
}

// Phase 6.20 — DEPRECATED-warn tracking for the legacy flex_ad adapter.
// Each adapter method warns once per session at first call. Phase 6.30
// removes the adapter entirely.
const _adapterWarned = {
  getFlexAds: false,
  createFlexAd: false,
  updateFlexAd: false,
  deleteFlexAd: false,
  restoreFlexAd: false,
};

export const api = {
  // Auth
  getSession: () => cachedRequest('/auth/session'),
  setup: (username, password) => request('/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }).then(r => { invalidateCache('/auth/session'); return r; }),
  logout: () => request('/auth/logout', { method: 'POST' }).then(r => { _requestCache.clear(); localStorage.removeItem('auth_state'); return r; }),
  changePassword: (currentPassword, newPassword) => request('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
  updateProfile: ({ displayName, username }) => request('/auth/profile', { method: 'PUT', body: JSON.stringify({ displayName, username }) }).then(r => { invalidateCache('/auth/session'); return r; }),

  // User Management (admin only)
  getUsers: () => request('/users'),
  createUser: (data) => request('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  resetUserPassword: (id, newPassword) => request(`/users/${id}/reset-password`, { method: 'PUT', body: JSON.stringify({ newPassword }) }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // Projects
  getProjects: () =>
    cachedRequest('/projects').then(data => normalizeArrayResponse(data, 'projects', 'api.getProjects.projects').projects),
  getArchivedProjects: () =>
    cachedRequest('/projects/archived').then(data => normalizeArrayResponse(data, 'projects', 'api.getArchivedProjects.projects').projects),
  getProjectOptions: () =>
    cachedRequest('/projects/options').then(data => normalizeArrayResponse(data, 'projects', 'api.getProjectOptions.projects')),
  getProject: (id) => cachedRequest(`/projects/${id}`),
  getProjectStats: (id) => request(`/projects/${id}/stats`),
  createProject: (data) => request('/projects', { method: 'POST', body: JSON.stringify(data) }).then(r => { invalidateCache('/projects', '/projects/options'); return r; }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }).then(r => { invalidateCache('/projects', '/projects/options', `/projects/${id}`); return r; }),
  archiveProject: (id) => request(`/projects/${id}/archive`, { method: 'PATCH' }).then(r => { invalidateProjectCache(id); return r; }),
  unarchiveProject: (id) => request(`/projects/${id}/unarchive`, { method: 'PATCH' }).then(r => { invalidateProjectCache(id); return r; }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }).then(r => { invalidateProjectCache(id); return r; }),

  // Foundational Documents
  getDocs: (projectId) => request(`/projects/${projectId}/docs`),
  deleteDocs: (projectId) =>
    request(`/projects/${projectId}/docs`, { method: 'DELETE' })
      .then(r => { invalidateProjectCache(projectId); return r; }),
  updateDoc: (projectId, docId, content) => request(`/projects/${projectId}/docs/${docId}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  approveDoc: (projectId, docId) => request(`/projects/${projectId}/docs/${docId}/approve`, { method: 'PUT' }),

  // Research prompts for manual research flow
  getResearchPrompts: (projectId) => request(`/projects/${projectId}/research-prompts`),

  // Direct upload of foundational documents (bypass generation entirely)
  uploadDocs: (projectId, docs) => request(`/projects/${projectId}/upload-docs`, { method: 'POST', body: JSON.stringify({ docs }) }),

  // Copy Correction — find and fix inaccurate info in docs
  correctDocs: (projectId, correction) =>
    request(`/projects/${projectId}/correct-docs`, { method: 'POST', body: JSON.stringify({ correction }) }),
  applyCorrections: (projectId, corrections, correctionText) =>
    request(`/projects/${projectId}/apply-corrections`, { method: 'POST', body: JSON.stringify({ corrections, correction_text: correctionText }) }),
  getCorrectionHistory: (projectId) =>
    request(`/projects/${projectId}/correction-history`),
  revertCorrection: (projectId, correctionId) =>
    request(`/projects/${projectId}/revert-correction`, { method: 'POST', body: JSON.stringify({ correction_id: correctionId }) }),

  // SSE streams — returns an abort controller, calls onEvent for each SSE message
  regenerateDoc: (projectId, docType, onEvent) => streamSSE(`/projects/${projectId}/generate-doc/${docType}`, onEvent),
  generateDocsManual: (projectId, researchContent, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/generate-docs-manual`, { researchContent }, onEvent),

  // Upload & extraction
  extractText: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    let res;
    try {
      res = await fetch(`${API_BASE}/upload/extract-text`, {
        method: 'POST',
        credentials: 'include',
        body: formData
        // No Content-Type header — browser sets multipart boundary automatically
      });
    } catch (err) {
      throw normalizeFetchException(err, 'Text extraction failed');
    }
    if (!res.ok) await throwForResponseError(res, 'Text extraction failed');
    const { parsed } = await parseResponseBody(res);
    return parsed;
  },
  autoDescribe: (salesPageContent) => request('/upload/auto-describe', { method: 'POST', body: JSON.stringify({ sales_page_content: salesPageContent }) }),
  fetchSalesPageFromUrl: (url) => request('/upload/fetch-url', { method: 'POST', body: JSON.stringify({ url }) }),

  // Google Drive
  driveStatus: () => request('/drive/status'),
  driveUploadServiceAccount: (content) => request('/drive/upload-service-account', { method: 'POST', body: JSON.stringify({ content }) }),
  driveTest: () => request('/drive/test', { method: 'POST' }),
  driveFolders: (parentId) => request(`/drive/folders${parentId ? `?parentId=${parentId}` : ''}`),
  driveFolderInfo: (folderId) => request(`/drive/folders/${folderId}`),

  // Inspiration Folder
  getInspirationImages: (projectId) =>
    request(`/projects/${projectId}/inspiration`).then(data => normalizeArrayResponse(data, 'images', 'api.getInspirationImages.images')),
  syncInspiration: (projectId) => request(`/projects/${projectId}/inspiration/sync`, { method: 'POST' }),

  // Template Images
  getTemplates: (projectId, options = {}) => {
    const qs = options.includeArchived ? '?include_archived=true' : '';
    return request(`/projects/${projectId}/templates${qs}`).then(data => normalizeArrayResponse(data, 'templates', 'api.getTemplates.templates'));
  },
  uploadTemplate: async (projectId, file, descriptionOrOptions = '') => {
    // Backwards-compatible: 3rd arg may be a string (legacy `description`) or an options object `{ description, signal }`.
    const opts = typeof descriptionOrOptions === 'string'
      ? { description: descriptionOrOptions }
      : (descriptionOrOptions || {});
    const { description = '', signal } = opts;
    const formData = new FormData();
    formData.append('image', file);
    if (description) formData.append('description', description);
    let res;
    try {
      res = await fetch(`${API_BASE}/projects/${projectId}/templates`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
        signal
      });
    } catch (err) {
      throw normalizeFetchException(err, 'Template upload failed');
    }
    if (!res.ok) await throwForResponseError(res, 'Template upload failed');
    const { parsed } = await parseResponseBody(res);
    return parsed;
  },
  updateTemplate: (projectId, imageId, descriptionOrFields) => {
    const body = typeof descriptionOrFields === 'object' && descriptionOrFields !== null
      ? descriptionOrFields
      : { description: descriptionOrFields };
    return request(`/projects/${projectId}/templates/${imageId}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteTemplate: (projectId, imageId) =>
    request(`/projects/${projectId}/templates/${imageId}`, { method: 'DELETE' }),
  adoptSharedTemplates: (projectId) =>
    request(`/projects/${projectId}/templates/adopt-shared`, { method: 'POST' }).then(r => {
      invalidateProjectCache(projectId);
      return r;
    }),
  analyzeTemplate: (projectId, templateId, force = false) =>
    request(`/projects/${projectId}/templates/${templateId}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ force })
    }),

  // Project Product Image
  uploadProductImage: async (projectId, file) => {
    const formData = new FormData();
    formData.append('image', file);
    let res;
    try {
      res = await fetch(`${API_BASE}/projects/${projectId}/product-image`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
    } catch (err) {
      throw normalizeFetchException(err, 'Product image upload failed');
    }
    if (!res.ok) await throwForResponseError(res, 'Product image upload failed');
    const { parsed } = await parseResponseBody(res);
    return parsed;
  },
  deleteProductImage: (projectId) =>
    request(`/projects/${projectId}/product-image`, { method: 'DELETE' }),

  // Ad Generation
  generateAd: (projectId, options, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/generate-ad`, options, onEvent),
  regenerateImage: (projectId, options, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/regenerate-image`, options, onEvent),
  editPrompt: (projectId, originalPrompt, editInstruction, referenceImage, referenceImageMime) =>
    request(`/projects/${projectId}/edit-prompt`, {
      method: 'POST',
      body: JSON.stringify({
        original_prompt: originalPrompt,
        edit_instruction: editInstruction,
        ...(referenceImage ? { reference_image: referenceImage, reference_image_mime: referenceImageMime } : {})
      })
    }),
  getAds: (projectId) =>
    request(`/projects/${projectId}/ads`).then(data => normalizeArrayResponse(data, 'ads', 'api.getAds.ads')),
  getInProgressAds: (projectId) => request(`/projects/${projectId}/ads/in-progress`),
  getAd: (projectId, adId) => request(`/projects/${projectId}/ads/${adId}`),
  cancelAd: (projectId, adId) =>
    request(`/projects/${projectId}/ads/${adId}/cancel`, { method: 'POST' }),
  deleteAd: (projectId, adId) =>
    request(`/projects/${projectId}/ads/${adId}`, { method: 'DELETE' }),
  updateAdTags: (projectId, adId, tags) =>
    request(`/projects/${projectId}/ads/${adId}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) }),
  toggleAdFavorite: (projectId, adId, isFavorite) =>
    request(`/projects/${projectId}/ads/${adId}/favorite`, { method: 'PATCH', body: JSON.stringify({ is_favorite: isFavorite }) }),

  // Batch Jobs
  getBatches: (projectId) => request(`/projects/${projectId}/batches`),
  getBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}`),
  createBatch: (projectId, data) => request(`/projects/${projectId}/batches`, { method: 'POST', body: JSON.stringify(data) }),
  updateBatch: (projectId, batchId, data) => request(`/projects/${projectId}/batches/${batchId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}`, { method: 'DELETE' }),
  runBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}/run`, { method: 'POST' }),
  cancelBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}/cancel`, { method: 'POST' }),

  // Costs
  getCosts: () => cachedRequest('/costs'),
  getProjectCosts: (projectId) => cachedRequest(`/projects/${projectId}/costs`),
  getCostHistory: (days = 30, projectId) => {
    let url = `/costs/history?days=${days}`;
    if (projectId) url += `&project_id=${projectId}`;
    return cachedRequest(url);
  },
  getCostHistoryRange: (startDate, endDate, projectId) => {
    const params = new URLSearchParams({ start: startDate, end: endDate });
    if (projectId) params.set('project_id', projectId);
    return cachedRequest(`/costs/history?${params.toString()}`);
  },
  getRecurringCosts: () => cachedRequest('/costs/recurring'),
  getCostRates: () => cachedRequest('/costs/rates'),
  getAgentCosts: (days = 30) => request(`/costs/agents?days=${days}`),

  // Settings
  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  deleteSetting: (key) => request(`/settings/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  testOpenAI: (apiKey = '') =>
    request('/settings/test-openai', {
      method: 'POST',
      ...(apiKey ? { body: JSON.stringify({ api_key: apiKey }) } : {}),
    }),
  testOpenAIImage: () => request('/settings/test-openai-image', { method: 'POST' }),
  testGemini: (apiKey = '') =>
    request('/settings/test-gemini', {
      method: 'POST',
      ...(apiKey ? { body: JSON.stringify({ api_key: apiKey }) } : {}),
    }),
  // Phase 2 (PEF item G) — verify a specific OpenAI chat model is available.
  testOpenAIModel: (model, apiKey = '') =>
    request('/settings/test-model', {
      method: 'POST',
      body: JSON.stringify(apiKey ? { model, api_key: apiKey } : { model }),
      headers: { 'Content-Type': 'application/json' },
    }),
  testDrive: () => request('/settings/test-drive', { method: 'POST' }),
  refreshGeminiRates: () => request('/settings/refresh-gemini-rates', { method: 'POST' }),

  // Dashboard Todos
  getTodos: () => cachedRequest('/settings/todos'),
  saveTodos: (todos) => request('/settings/todos', { method: 'PUT', body: JSON.stringify({ todos }) }).then(r => { invalidateCache('/settings/todos'); return r; }),

  // Conductor (Dacia Creative Director)
  getConductorConfig: (projectId) => cachedRequest(`/conductor/config/${projectId}`),
  updateConductorConfig: (projectId, data) => request(`/conductor/config/${projectId}`, { method: 'PUT', body: JSON.stringify(data) }).then(r => { invalidateCache(`/conductor/config/${projectId}`, '/conductor/pipeline-status'); return r; }),
  getAllConductorConfigs: () => cachedRequest('/conductor/configs'),

  getConductorAngles: (projectId) =>
    cachedRequest(`/conductor/angles/${projectId}`).then(data => normalizeArrayResponse(data, 'angles', 'api.getConductorAngles.angles')),
  getConductorActiveAngles: (projectId) =>
    cachedRequest(`/conductor/angles/${projectId}/active`).then(data => normalizeArrayResponse(data, 'angles', 'api.getConductorActiveAngles.angles')),
  createConductorAngle: (projectId, data) => request(`/conductor/angles/${projectId}`, { method: 'POST', body: JSON.stringify(data) }).then(r => { invalidateCache(`/conductor/angles/${projectId}`, `/conductor/angles/${projectId}/active`); return r; }),
  updateConductorAngle: (projectId, angleId, data) => request(`/conductor/angles/${projectId}/${angleId}`, { method: 'PUT', body: JSON.stringify(data) }).then(r => { invalidateCache(`/conductor/angles/${projectId}`, `/conductor/angles/${projectId}/active`); return r; }),
  deleteConductorAngle: (projectId, angleId) => request(`/conductor/angles/${projectId}/${angleId}`, { method: 'DELETE' }).then(r => { invalidateCache(`/conductor/angles/${projectId}`, `/conductor/angles/${projectId}/active`); return r; }),
  getConductorRuns: (projectId, limit) =>
    request(`/conductor/runs/${projectId}${limit ? `?limit=${limit}` : ''}`).then(data => normalizeArrayResponse(data, 'runs', 'api.getConductorRuns.runs')),
  getConductorTestQueue: (projectId, limit) =>
    request(`/conductor/test-run/queue/${projectId}${limit ? `?limit=${limit}` : ''}`).then(data => normalizeArrayResponse(data, 'runs', 'api.getConductorTestQueue.runs')),
  triggerConductorRun: (projectId) => request(`/conductor/run/${projectId}`, { method: 'POST' }),
  triggerConductorTestRun: (projectId, body, onEvent) => streamSSEWithBody(`/conductor/test-run/${projectId}`, body, onEvent),
  getTestRunProgress: (projectId) => request(`/conductor/test-run/progress/${projectId}`),
  cancelTestRun: (projectId, runId = null) => request(`/conductor/test-run/cancel/${projectId}`, {
    method: 'POST',
    body: runId ? JSON.stringify({ runId }) : undefined,
  }),
  getConductorPlaybooks: (projectId) =>
    cachedRequest(`/conductor/playbooks/${projectId}`).then(data => normalizeArrayResponse(data, 'playbooks', 'api.getConductorPlaybooks.playbooks')),
  getConductorPlaybook: (projectId, angleName) => request(`/conductor/playbooks/${projectId}/${encodeURIComponent(angleName)}`),
  triggerLearningStep: (projectId, angleName, scoredAds) => request('/conductor/learn', { method: 'POST', body: JSON.stringify({ projectId, angleName, scoredAds }) }),
  getConductorPipelineStatus: () => cachedRequest('/conductor/pipeline-status'),

  // Phase 2A — Meta integration
  initMetaOAuth: (projectId) =>
    request('/meta/oauth/init', { method: 'POST', body: JSON.stringify({ projectId }) }),
  getMetaConnectionStatus: (projectId) =>
    request(`/meta/connection-status?projectId=${projectId}`),
  getMetaAdAccounts: (projectId) =>
    request(`/meta/ad-accounts?projectId=${projectId}`).then(d => d?.accounts ?? []),
  selectMetaAdAccount: (projectId, payload) =>
    request('/meta/select-account', { method: 'POST', body: JSON.stringify({ projectId, ...payload }) }),
  setMetaIntegrationPath: (projectId, path) =>
    request('/meta/integration-path', { method: 'POST', body: JSON.stringify({ projectId, path }) }),
  setMetaReadPath: (projectId, path) =>
    request('/meta/read-path', { method: 'POST', body: JSON.stringify({ projectId, path }) }),
  checkMetaMcpAccess: (projectId) =>
    request('/meta/mcp-access/check', { method: 'POST', body: JSON.stringify({ projectId }) }),
  disconnectMeta: (projectId) =>
    request('/meta/disconnect', { method: 'POST', body: JSON.stringify({ projectId }) }),
  getMetaCampaigns: (projectId) =>
    request(`/meta/campaigns?projectId=${projectId}`).then(d => d?.campaigns ?? []),
  // Phase 2B
  getMetaPages: (projectId) =>
    request(`/meta/pages?projectId=${projectId}`).then(d => d?.pages ?? []),
  selectMetaPage: (projectId, payload) =>
    request('/meta/select-page', { method: 'POST', body: JSON.stringify({ projectId, ...payload }) }),
  postAdSetToMeta: (projectId, adSetId, options = {}) =>
    request(`/projects/${projectId}/ad-sets/${adSetId}/post-to-meta`, { method: 'POST', body: JSON.stringify(options) })
      .then(r => { invalidateDeploymentCache(projectId); return r; }),
  postDeploymentToMeta: (projectId, deploymentId, options = {}) =>
    request(`/deployments/${deploymentId}/post-to-meta`, { method: 'POST', body: JSON.stringify({ projectId, ...options }) })
      .then(r => { invalidateDeploymentCache(projectId); return r; }),

  // Phase 1 — Staging Page
  getStagingPending: (projectId) =>
    request(`/projects/${projectId}/staging/pending`).then(data => data?.groups ?? []),
  getStagingRejected: (projectId) =>
    request(`/projects/${projectId}/staging/rejected`).then(data => data?.ads ?? []),
  getStagingPromoted: (projectId) =>
    request(`/projects/${projectId}/staging/promoted`).then(data => data?.adSets ?? []),
  updateAdSetMetaSettings: (projectId, adSetId, fields) =>
    request(`/projects/${projectId}/staging/adsets/${adSetId}/meta-settings`, { method: 'PUT', body: JSON.stringify(fields) }),
  promoteAdSet: (projectId, adSetId) =>
    request(`/projects/${projectId}/staging/adsets/${adSetId}/promote`, { method: 'POST' }),
  regroupAds: (projectId, adIds, targetAdSetId) =>
    request(`/projects/${projectId}/staging/regroup`, { method: 'POST', body: JSON.stringify({ adIds, targetAdSetId }) }),
  createEmptyAdSet: (projectId, body) =>
    request(`/projects/${projectId}/staging/adsets/new`, { method: 'POST', body: JSON.stringify(body) }),
  forcePromoteAd: (projectId, adId) =>
    request(`/projects/${projectId}/ads/${adId}/force-promote`, { method: 'POST' }),

  // Agent Monitor (Dacia Creative Filter)
  getFilterStatus: () => request('/agent-monitor/filter/status'),
  runFilterDryRun: () => request('/agent-monitor/filter/run', { method: 'POST' }),
  runFilterLive: () => request('/agent-monitor/filter/run-live', { method: 'POST' }),
  toggleFilterPause: () => request('/agent-monitor/filter/pause', { method: 'POST' }),
  getFilterVolumes: () =>
    request('/agent-monitor/filter/volumes').then(data => normalizeArrayResponse(data, 'projects', 'api.getFilterVolumes.projects')),
  updateFilterVolume: (projectId, value) => request(`/agent-monitor/filter/volumes/${projectId}`, { method: 'PUT', body: JSON.stringify({ scout_daily_flex_ads: value }) }),

  // Performance Tracker / Deployments
  getDeployments: () =>
    cachedRequest('/deployments').then(data => normalizeArrayResponse(data, 'deployments', 'api.getDeployments.deployments')),
  getProjectDeployments: (projectId, options = {}) => {
    const path = `/deployments?projectId=${projectId}`;
    return options.force ? request(path) : cachedRequest(path);
  },
  createDeployments: (projectIdOrAdIds, maybeAdIds) => {
    const hasProjectId = !Array.isArray(projectIdOrAdIds);
    const projectId = hasProjectId ? projectIdOrAdIds : null;
    const adIds = hasProjectId ? maybeAdIds : projectIdOrAdIds;
    return request('/deployments', { method: 'POST', body: JSON.stringify({ adIds }) }).then(r => {
      invalidateCache('/deployments');
      if (projectId) invalidateCache(`/deployments?projectId=${projectId}`);
      return r;
    });
  },
  updateDeployment: (id, fields) => request(`/deployments/${id}`, { method: 'PUT', body: JSON.stringify(fields) }).then(r => { invalidateDeploymentCache(); return r; }),
  updateDeploymentStatus: (id, status) => request(`/deployments/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }).then(r => { invalidateDeploymentCache(); return r; }),
  updateDeploymentPostedBy: (id, posted_by) => request(`/deployments/${id}/posted-by`, { method: 'PUT', body: JSON.stringify({ posted_by }) }).then(r => { invalidateDeploymentCache(); return r; }),
  deleteDeployment: (id) => request(`/deployments/${id}`, { method: 'DELETE' }).then(r => { invalidateDeploymentCache(); return r; }),
  restoreDeployment: (id) => request(`/deployments/${id}/restore`, { method: 'POST' }).then(r => { invalidateDeploymentCache(); return r; }),
  getDeletedDeployments: (projectId) => request(`/deployments/deleted${projectId ? `?projectId=${projectId}` : ''}`),
  renameAllDeployments: () => request('/deployments/rename-all', { method: 'POST' }),
  backfillHeadlines: () => request('/deployments/backfill-headlines', { method: 'POST' }),

  // Campaigns & Ad Sets (local organization)
  getCampaigns: (projectId) =>
    request(`/deployments/campaigns?projectId=${projectId}`).then(data =>
      normalizeArrayFields(data, {
        campaigns: 'api.getCampaigns.campaigns',
        adSets: 'api.getCampaigns.adSets',
      })
    ),
  createCampaign: (projectId, name) => request('/deployments/campaigns', { method: 'POST', body: JSON.stringify({ projectId, name }) }),
  updateCampaign: (id, fields) => request(`/deployments/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(fields) }),
  deleteCampaign: (id) => request(`/deployments/campaigns/${id}`, { method: 'DELETE' }),
  createAdSet: (campaignId, name, projectId) => request(`/deployments/campaigns/${campaignId}/adsets`, { method: 'POST', body: JSON.stringify({ name, projectId }) }),
  updateAdSet: (id, fields) => request(`/deployments/adsets/${id}`, { method: 'PUT', body: JSON.stringify(fields) }),
  deleteAdSet: (id) => request(`/deployments/adsets/${id}`, { method: 'DELETE' }),
  moveToUnplanned: (deploymentIds) => request('/deployments/move-to-unplanned', { method: 'POST', body: JSON.stringify({ deploymentIds }) }),
  moveToPlanner: (deploymentIds) => request('/deployments/move-to-planner', { method: 'POST', body: JSON.stringify({ deploymentIds }) }),
  assignToAdSet: (deploymentIds, campaignId, adsetId) => request('/deployments/assign-to-adset', { method: 'POST', body: JSON.stringify({ deploymentIds, campaignId, adsetId }) }),
  unassignFromAdSet: (deploymentIds) => request('/deployments/unassign', { method: 'POST', body: JSON.stringify({ deploymentIds }) }),

  // Duplicate
  duplicateDeployment: (id, overrides) => request(`/deployments/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ overrides }) }),

  // Phase 6 — Flex Ads removed. The legacy UI (CampaignsView/ReadyToPostView/
  // PostedView) calls these methods expecting flex_ad-shaped data. The adapter
  // below fetches real ad_sets + their deployments and returns objects shaped
  // like flex_ads so the existing rendering keeps working unchanged.
  //
  // Phase 6.20 — adapter is DEPRECATED. Each method emits one console.warn
  // per session at first call, with the immediate caller frame extracted from
  // the stack. Phase 6.30 (future) deletes the adapter entirely after
  // BulkEditPanel/AdTracker/AgentMonitor migrate to native ad_set methods.
  getFlexAds: async (projectId) => {
    if (!_adapterWarned.getFlexAds) {
      _adapterWarned.getFlexAds = true;
      const caller = (new Error().stack || '').split('\n')[2]?.trim() || '?';
      console.warn(`[DEPRECATED] api.getFlexAds — use api.getAdSets in new code. Called from: ${caller}`);
    }
    // Fetch all ad_sets for the project (any lifecycle) + all deployments,
    // group deployments by local_adset_id, and return flex_ad-shaped objects.
    const [adSets, depRes] = await Promise.all([
      request(`/projects/${projectId}/ad-sets`).then(d => d?.adSets ?? []),
      request(`/deployments?projectId=${projectId}`).then(d => d?.deployments ?? []),
    ]);
    const deps = Array.isArray(depRes) ? depRes : (depRes?.deployments ?? []);
    const byAdSet = new Map();
    for (const dep of deps) {
      if (!dep.local_adset_id) continue;
      const arr = byAdSet.get(dep.local_adset_id) || [];
      arr.push(dep);
      byAdSet.set(dep.local_adset_id, arr);
    }
    // Map each ad_set to a flex_ad-shaped object. Copy fields are derived from
    // the first deployment in the group (all members share the same copy).
    const flexAds = (adSets || []).map((s) => {
      const children = byAdSet.get(s.externalId) || [];
      const sample = children[0] || {};
      let primary_texts = '[]';
      let headlines = '[]';
      try { primary_texts = sample.primary_texts || JSON.stringify(JSON.parse(sample.primary_texts || '[]')); } catch { primary_texts = '[]'; }
      try { headlines = sample.ad_headlines || JSON.stringify(JSON.parse(sample.ad_headlines || '[]')); } catch { headlines = '[]'; }
      return {
        id: s.externalId,
        externalId: s.externalId,
        project_id: s.project_id,
        ad_set_id: s.externalId,                // unified model: ad_set IS the wrapper
        name: s.name || '',
        child_deployment_ids: JSON.stringify(children.map((d) => d.externalId)),
        primary_texts,
        headlines,
        destination_url: sample.destination_url || '',
        display_link: sample.display_link || '',
        cta_button: sample.cta_button || '',
        facebook_page: sample.facebook_page || '',
        planned_date: sample.planned_date || '',
        posted_by: sample.posted_by || '',
        duplicate_adset_name: sample.duplicate_adset_name || '',
        notes: '',
        posting_day: '',
        angle_name: '',                          // angle stored on s.angle_id, not surfaced
        lp_primary_url: '',                      // LP feature removed in Phase 6
        lp_secondary_url: '',
        gauntlet_lp_urls: '',
        destination_urls_used: '',
        lifecycle_status: s.lifecycle_status || '', // Phase 6 — exposed for filtering
        created_at: s.created_at || '',
        updated_at: s.updated_at || '',
        deleted_at: '',
      };
    });
    return { flexAds };
  },
  getFlexAdCount: (_projectId, _angleName) => Promise.resolve({ count: 0 }),
  // Phase 6 — Combine into Ad Set. Old call signature: (projectId, adSetId, name, deploymentIds)
  // where adSetId was always '' (or pre-existing). New signature creates a fresh ad_set with
  // these deployments. We ignore the legacy adSetId param.
  createFlexAd: (projectId, _legacyAdSetId, name, deploymentIds) => {
    if (!_adapterWarned.createFlexAd) {
      _adapterWarned.createFlexAd = true;
      const caller = (new Error().stack || '').split('\n')[2]?.trim() || '?';
      console.warn(`[DEPRECATED] api.createFlexAd — use api.createAdSetFromAds in new code. Called from: ${caller}`);
    }
    return request(`/projects/${projectId}/ad-sets`, {
      method: 'POST',
      body: JSON.stringify({
        name: name || `Manual Ad Set — ${new Date().toISOString().slice(0, 10)}`,
        deployment_ids: deploymentIds,
      }),
    }).then((r) => { invalidateDeploymentCache(projectId); return { success: true, id: r.adSetId }; });
  },
  // Phase 6 — Update flex_ad → update ad_set. Maps flex-ad-shape fields to
  // ad_set-compatible fields (name, campaign, lifecycle). Copy/CTA fields go
  // to deployments via a separate code path (handled elsewhere).
  updateFlexAd: (id, fields) => {
    if (!_adapterWarned.updateFlexAd) {
      _adapterWarned.updateFlexAd = true;
      const caller = (new Error().stack || '').split('\n')[2]?.trim() || '?';
      console.warn(`[DEPRECATED] api.updateFlexAd — use api.updateAdSetUnified for ad_set fields, or api.updateDeployment for per-deployment fields. Called from: ${caller}`);
    }
    // Phase 6 — uses flat /ad-sets/:id route (project-agnostic, looked up from
    // the ad_set's project_id server-side). Maps flex-ad shape fields to the
    // ad_set whitelist; copy/destination/CTA changes are now per-deployment
    // and handled elsewhere by the legacy UI.
    const adSetFields = {};
    if (fields.name !== undefined) adSetFields.name = fields.name;
    // The legacy `ad_set_id` field on flex_ads was the parent campaign_id
    // pointer. In unified model, the ad_set IS the wrapper, so this mapping
    // doesn't apply directly. Skip unless explicitly relevant.
    if (Object.keys(adSetFields).length === 0) return Promise.resolve({ success: true });
    return request(`/ad-sets/${id}`, { method: 'PUT', body: JSON.stringify(adSetFields) }).then(r => { invalidateDeploymentCache(); return r; }).catch((err) => {
      console.warn('[Phase 6] updateFlexAd legacy path:', err.message);
      return { success: true };
    });
  },
  updateFlexAdPostedBy: (deploymentId, posted_by) =>
    request(`/deployments/${deploymentId}/posted-by`, { method: 'PUT', body: JSON.stringify({ posted_by }) }).then(r => { invalidateDeploymentCache(); return r; }),
  // Phase 6 — Delete flex_ad → ungroup ad_set (deletes ad_set, detaches deployments).
  // The legacy call signature is just (id), with no projectId. We route through
  // a wildcard projectId since the backend validates membership.
  deleteFlexAd: (id) => {
    if (!_adapterWarned.deleteFlexAd) {
      _adapterWarned.deleteFlexAd = true;
      const caller = (new Error().stack || '').split('\n')[2]?.trim() || '?';
      console.warn(`[DEPRECATED] api.deleteFlexAd — use api.ungroupAdSet in new code. Called from: ${caller}`);
    }
    return request(`/ad-sets/${id}/ungroup`, { method: 'POST' }).then(r => { invalidateDeploymentCache(); return r; }).catch((err) => {
      console.warn('[Phase 6] deleteFlexAd legacy path:', err.message);
      return { success: true };
    });
  },
  restoreFlexAd: (_id) => {
    if (!_adapterWarned.restoreFlexAd) {
      _adapterWarned.restoreFlexAd = true;
      const caller = (new Error().stack || '').split('\n')[2]?.trim() || '?';
      console.warn(`[DEPRECATED] api.restoreFlexAd — no native equivalent. Phase 6.30 removes. Called from: ${caller}`);
    }
    return Promise.resolve({ success: true });
  },

  // Phase 6 — Unified Ad Set CRUD. Replaces flex_ad creation in the Planner,
  // staging promotion, and the unified pipeline view.
  getAdSets: (projectId, lifecycles = null) => {
    const lc = Array.isArray(lifecycles) && lifecycles.length > 0
      ? `?lifecycle=${encodeURIComponent(lifecycles.join(','))}` : '';
    return request(`/projects/${projectId}/ad-sets${lc}`).then(d => d?.adSets ?? []);
  },
  createAdSetFromAds: (projectId, { name, campaign_id, deployment_ids, create_new_campaign, angle_id }) =>
    request(`/projects/${projectId}/ad-sets`, {
      method: 'POST',
      body: JSON.stringify({ name, campaign_id, deployment_ids, create_new_campaign, angle_id }),
    }).then(result => {
      invalidateCache(`/deployments?projectId=${projectId}`);
      return result;
    }),
  updateAdSetUnified: (projectId, adSetId, fields) =>
    request(`/projects/${projectId}/ad-sets/${adSetId}`, { method: 'PUT', body: JSON.stringify(fields) }).then(r => { invalidateDeploymentCache(projectId); return r; }),
  moveAdSetToReady: (projectId, adSetId) =>
    request(`/projects/${projectId}/ad-sets/${adSetId}/move-to-ready`, { method: 'POST' }).then(r => { invalidateDeploymentCache(projectId); return r; }),
  ungroupAdSet: (projectId, adSetId) =>
    request(`/projects/${projectId}/ad-sets/${adSetId}/ungroup`, { method: 'POST' }).then(r => { invalidateDeploymentCache(projectId); return r; }),
  lockDeployments: (projectId, deployment_ids, ttlMs) =>
    request(`/projects/${projectId}/lock-deployments`, {
      method: 'POST',
      body: JSON.stringify({ deployment_ids, ttlMs }),
    }),

  // Primary Text & Headline Generation (sidebar)
  generatePrimaryText: (deploymentId, flexAdId, direction, messages, options = {}) =>
    request(`/deployments/${deploymentId}/generate-primary-text`, { method: 'POST', body: JSON.stringify({ flexAdId, direction, messages, ...options }) }),
  generateAdHeadlines: (deploymentId, primaryTexts, flexAdId, direction, messages, options = {}) =>
    request(`/deployments/${deploymentId}/generate-ad-headlines`, { method: 'POST', body: JSON.stringify({ primaryTexts, flexAdId, direction, messages, ...options }) }),

  // Ad Studio — inline generation helpers for composing a single ad
  generateAdAngle: (projectId) =>
    request(`/projects/${projectId}/generate-angle`, { method: 'POST' }),
  generateAdHeadline: (projectId, { angle }) =>
    request(`/projects/${projectId}/generate-headline`, {
      method: 'POST',
      body: JSON.stringify({ angle: angle || undefined })
    }),
  generateAdBodyCopy: (projectId, { headline, angle, style }) =>
    request(`/projects/${projectId}/generate-body-copy`, {
      method: 'POST',
      body: JSON.stringify({ headline, angle, style: style || 'short' })
    }),

  // Settings — API-key connectivity tests
  testAnthropic: (apiKey = '') => request('/settings/test-anthropic', {
    method: 'POST',
    body: JSON.stringify(apiKey ? { api_key: apiKey } : {}),
  }),

  // ────────────────────────────────────────────────
  // Phase 5 — Analytics tab
  // ────────────────────────────────────────────────
  getAnalyticsCampaigns: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/campaigns${qs ? `?${qs}` : ''}`);
  },
  getAnalyticsAdSets: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/adsets${qs ? `?${qs}` : ''}`);
  },
  getAnalyticsAds: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/ads${qs ? `?${qs}` : ''}`);
  },
  getAnalyticsTimeseries: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/timeseries${qs ? `?${qs}` : ''}`);
  },
  getAnalyticsHourly: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/hourly${qs ? `?${qs}` : ''}`);
  },

  // Tags CRUD
  getTags: (projectId) => request(`/projects/${projectId}/tags`),
  createTag: (projectId, { name, color }) =>
    request(`/projects/${projectId}/tags`, { method: 'POST', body: JSON.stringify({ name, color }) }),
  updateTag: (projectId, tagId, { name, color }) =>
    request(`/projects/${projectId}/tags/${tagId}`, { method: 'PUT', body: JSON.stringify({ name, color }) }),
  deleteTag: (projectId, tagId) =>
    request(`/projects/${projectId}/tags/${tagId}`, { method: 'DELETE' }),

  // Tag assignments
  getTagAssignments: (projectId, entityType) =>
    request(`/projects/${projectId}/tags/assignments?entity_type=${encodeURIComponent(entityType)}`),
  applyTag: (projectId, { tag_id, entity_type, entity_id, entity_id_kind = 'meta' }) =>
    request(`/projects/${projectId}/tags/assignments`, {
      method: 'POST',
      body: JSON.stringify({ tag_id, entity_type, entity_id, entity_id_kind }),
    }),
  removeTagAssignment: (projectId, { tag_id, entity_id, entity_type }) =>
    request(`/projects/${projectId}/tags/assignments`, {
      method: 'DELETE',
      body: JSON.stringify({ tag_id, entity_id, entity_type }),
    }),
  applyTagsBulk: (projectId, { tag_id, entity_type, entity_ids, entity_id_kind = 'meta' }) =>
    request(`/projects/${projectId}/tags/assignments/bulk`, {
      method: 'POST',
      body: JSON.stringify({ tag_id, entity_type, entity_ids, entity_id_kind }),
    }),
  removeTagAssignmentsBulk: (projectId, { tag_id, entity_type, entity_ids }) =>
    request(`/projects/${projectId}/tags/assignments/bulk`, {
      method: 'DELETE',
      body: JSON.stringify({ tag_id, entity_type, entity_ids }),
    }),

  // Entity notes
  getEntityNotes: (projectId, entityType) =>
    request(`/projects/${projectId}/entity-notes?entity_type=${encodeURIComponent(entityType)}`),
  updateEntityNote: (projectId, { entity_type, entity_id, entity_id_kind = 'meta', note }) =>
    request(`/projects/${projectId}/entity-notes`, {
      method: 'PATCH',
      body: JSON.stringify({ entity_type, entity_id, entity_id_kind, note }),
    }),
  appendEntityNotesBulk: (projectId, { entity_type, entity_ids, entity_id_kind = 'meta', note }) =>
    request(`/projects/${projectId}/entity-notes/bulk`, {
      method: 'POST',
      body: JSON.stringify({ entity_type, entity_ids, entity_id_kind, note }),
    }),
  updateEntityNotesBulk: (projectId, { entity_type, entity_ids, entity_id_kind = 'meta', note = '', mode = 'append' }) =>
    request(`/projects/${projectId}/entity-notes/bulk`, {
      method: 'POST',
      body: JSON.stringify({ entity_type, entity_ids, entity_id_kind, note, mode }),
    }),

  // Saved views
  getSavedViews: (projectId) => request(`/projects/${projectId}/analytics/views`),
  createSavedView: (projectId, { name, scope, level, config }) =>
    request(`/projects/${projectId}/analytics/views`, {
      method: 'POST',
      body: JSON.stringify({ name, scope, level, config }),
    }),
  updateSavedView: (projectId, viewId, updates) =>
    request(`/projects/${projectId}/analytics/views/${viewId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
  deleteSavedView: (projectId, viewId) =>
    request(`/projects/${projectId}/analytics/views/${viewId}`, { method: 'DELETE' }),

  // ────────────────────────────────────────────────
  // Phase 3 — Observation, benchmark, archive
  // ────────────────────────────────────────────────
  getObservationConfig: (projectId) => request(`/projects/${projectId}/observation/config`),
  updateObservationConfig: (projectId, body) =>
    request(`/projects/${projectId}/observation/config`, { method: 'PUT', body: JSON.stringify(body) }),
  suggestObservationDefaults: (projectId) =>
    request(`/projects/${projectId}/observation/suggest`, { method: 'POST' }),

  getObservationAdSets: (projectId) =>
    request(`/projects/${projectId}/observation/ad-sets`),
  getObservationAdSet: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}`),
  refreshObservationSnapshot: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/snapshot`, { method: 'POST' }),
  markObservation: (projectId, adSetId, { verdict, reason }) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/mark`, {
      method: 'POST',
      body: JSON.stringify({ verdict, reason }),
    }),
  pauseObservation: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/pause`, { method: 'POST' }),
  resumeObservation: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/resume`, { method: 'POST' }),
  extendObservation: (projectId, adSetId, additional_days) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/extend`, {
      method: 'POST',
      body: JSON.stringify({ additional_days }),
    }),

  getObservationHealth: (projectId) =>
    request(`/projects/${projectId}/observation/health`),

  getArchivedAngles: (projectId) =>
    request(`/projects/${projectId}/angles/archived`),
  archiveAngle: (projectId, angleId, reason) =>
    request(`/projects/${projectId}/angles/${angleId}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unarchiveAngle: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/unarchive`, { method: 'POST' }),

  // Admin
  runObservationCron: (dryRun = false) =>
    request(`/admin/observation/cron-run${dryRun ? '?dry_run=1' : ''}`, { method: 'POST' }),
  getLastObservationCron: () => request('/admin/observation/last-cron'),

  // ────────────────────────────────────────────────
  // Phase 4 — Sub-angle derivation + lineage
  // ────────────────────────────────────────────────
  deriveSubAnglesNow: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/derive-now`, { method: 'POST' }),
  getSubAngles: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/sub-angles`),
  getLineage: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/lineage`),
  deleteAngleLineage: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/lineage`, { method: 'DELETE' }),
  getRecentlyDerived: (projectId, days = 7) =>
    request(`/projects/${projectId}/angles/recently-derived?days=${days}`),
  getPendingReviewAngles: (projectId) =>
    request(`/projects/${projectId}/angles/pending-review`),
  approveSubAngle: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/approve`, { method: 'POST' }),
  rejectSubAngle: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/reject`, { method: 'POST' }),

  // ────────────────────────────────────────────────
  // Phase 9 — Reconciliation (link unobserved Meta ads to CF)
  // ──���─────────────────────────────────────────────
  getUnlinkedAdSets: (projectId) =>
    request(`/projects/${projectId}/reconciliation/unlinked-adsets`),
  getArchivedUnlinkedAdSets: (projectId) =>
    request(`/projects/${projectId}/reconciliation/archived-unlinked-adsets`),
  getUnlinkedAds: (projectId, metaAdsetId) =>
    request(`/projects/${projectId}/reconciliation/unlinked-ads?metaAdsetId=${metaAdsetId}`),
  archiveUnlinkedAdSets: (projectId, adSets) =>
    request(`/projects/${projectId}/reconciliation/archive-unlinked-adsets`, {
      method: 'POST',
      body: JSON.stringify({ ad_sets: adSets }),
    }),
  unarchiveUnlinkedAdSets: (projectId, metaAdsetIds) =>
    request(`/projects/${projectId}/reconciliation/unarchive-unlinked-adsets`, {
      method: 'POST',
      body: JSON.stringify({ meta_adset_ids: metaAdsetIds }),
    }),
  linkAdSet: (projectId, data) =>
    request(`/projects/${projectId}/reconciliation/link-adset`, { method: 'POST', body: JSON.stringify(data) }),
  linkAd: (projectId, data) =>
    request(`/projects/${projectId}/reconciliation/link-ad`, { method: 'POST', body: JSON.stringify(data) }),
};

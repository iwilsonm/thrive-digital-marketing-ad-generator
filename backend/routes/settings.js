import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth, requireRole } from '../auth.js';
import { getSetting, setSetting, deleteSetting, getAllSettings, getDashboardTodos, replaceDashboardTodos } from '../convexClient.js';
import { getDriveClient } from './drive.js';
import { refreshGeminiRates } from '../services/costTracker.js';
import { generateImage as generateOpenAIImage } from '../services/openaiImage.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// Sensitive keys that should be masked when returning
const SENSITIVE_KEYS = ['auth_password_hash', 'session_secret'];
const CONFIGURED_SECRET_PLACEHOLDER = 'Configured';
const API_KEY_KEYS = ['openai_api_key', 'gemini_api_key', 'anthropic_api_key', 'cloudflare_api_token', 'meta_app_secret', 'google_service_account_json'];
const ALLOWED_SETTING_KEYS = [
  'openai_api_key',
  'gemini_api_key',
  'anthropic_api_key',
  'meta_app_id',
  'meta_app_secret',
  'google_service_account_json',
  'default_drive_folder_id',
  'gemini_rate_1k',
  'gemini_rate_2k',
  'gemini_rate_4k',
  'openai_gpt_image_2_input_rate_per_million',
  'openai_gpt_image_2_output_rate_per_million',
  'openai_gpt_image_2_rates_updated_at',
  'cloudflare_account_id',
  'cloudflare_api_token',
  'cloudflare_pages_projects',
  'pinned_project_ids',  // JSON array of project externalIds (global pinning)
];

// Phase 6.25 — removed `enable_phase1_staging:<projectId>` regex branch.
// The Staging tab and its toggle are gone (Phase 6 unified the pipeline).
// Do not re-add without a real consumer.
function isAllowedSettingKey(key) {
  return ALLOWED_SETTING_KEYS.includes(key);
}

function normalizeSettingValue(key, value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return value;
  if (API_KEY_KEYS.includes(key) || key.startsWith('meta_')) {
    return value.trim();
  }
  return value;
}

function isAnthropicModelNotFound(err) {
  const status = err?.status || err?.statusCode;
  const type = err?.error?.type || err?.type;
  return (status === 404 || type === 'not_found_error') && /model/i.test(err?.message || '');
}

async function testAnthropicKey(apiKey) {
  const client = new Anthropic({ apiKey });
  const models = ['claude-sonnet-4-6', 'claude-sonnet-4-5'];
  let lastErr = null;

  for (const model of models) {
    try {
      await client.messages.create({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      });
      return model;
    } catch (err) {
      lastErr = err;
      if (!isAnthropicModelNotFound(err)) throw err;
    }
  }

  throw lastErr || new Error('Anthropic test failed');
}

// Get all settings (mask sensitive values)
router.get('/', async (req, res) => {
  const settings = await getAllSettings();
  const masked = { ...settings };

  for (const key of SENSITIVE_KEYS) {
    delete masked[key];
  }
  for (const key of API_KEY_KEYS) {
    if (masked[key]) {
      masked[key] = CONFIGURED_SECRET_PLACEHOLDER;
    }
  }

  res.json(masked);
});

// Update settings
router.put('/', async (req, res) => {
  try {
    const saved = [];
    for (const [key, value] of Object.entries(req.body || {})) {
      if (value !== undefined && isAllowedSettingKey(key)) {
        const normalized = normalizeSettingValue(key, value);
        await setSetting(key, normalized);
        saved.push(key);
      }
    }

    res.json({ success: true, saved });
  } catch (err) {
    console.error('[Settings] Save failed:', err.message);
    res.status(500).json({
      error: 'Settings could not be saved. Check that your session is still active and try again. If this keeps happening, the settings database write failed.',
    });
  }
});

// Remove a saved credential/setting. Used for API keys and Meta app credentials
// so admins can intentionally disable integrations without writing blank strings.
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    if (!isAllowedSettingKey(key)) {
      return res.status(400).json({ error: 'This setting cannot be removed from the app.' });
    }
    await deleteSetting(key);
    res.json({ success: true, removed: key });
  } catch (err) {
    console.error('[Settings] Delete failed:', err.message);
    res.status(500).json({ error: 'Setting could not be removed. Please try again.' });
  }
});

// Test OpenAI connection
router.post('/test-openai', async (req, res) => {
  const candidateKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  const apiKey = candidateKey || await getSetting('openai_api_key');
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured' });

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      return res.status(400).json({ error: `OpenAI API returned ${response.status}` });
    }
    res.json({ success: true, message: 'OpenAI API key is valid' });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

router.post('/test-openai-image', async (req, res) => {
  try {
    await generateOpenAIImage(
      'Simple product-style test image with the word OK on a plain white card.',
      '1:1',
      null,
      {
        projectId: null,
        operation: 'settings_openai_image_test',
        quality: 'low',
      }
    );
    res.json({ ok: true, success: true, message: 'GPT Image 2 test generation succeeded.' });
  } catch (err) {
    const status = err?.status || err?.statusCode || 400;
    const orgVerification = /verify|verification|organization|org/i.test(err?.message || '');
    res.status(status >= 500 ? 500 : 400).json({
      ok: false,
      success: false,
      error: orgVerification
        ? `OpenAI organization verification may be required for GPT Image 2: ${err.message}`
        : err.message,
      code: err.code || err.error?.code || null,
      userActionable: err.userActionable ?? true,
      actionUrl: err.actionUrl || 'https://platform.openai.com/settings/organization/general',
      actionLabel: err.actionLabel || 'OpenAI organization settings',
    });
  }
});

// Phase 2 (PEF item G) — verify a specific OpenAI chat model is callable
// before Ian saves it as `openai_lp_image_strategy_model`. Catches typos and
// model deprecations at config time instead of at runtime mid-generation.
router.post('/test-model', async (req, res) => {
  const { model } = req.body || {};
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model (string) required in body' });
  }
  const candidateKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  const apiKey = candidateKey || await getSetting('openai_api_key');
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured' });

  try {
    // Fire a 1-token chat call. If the model is invalid OpenAI returns 404
    // model_not_found. If it's valid, the call returns a tiny response.
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.trim(),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });

    if (response.ok) {
      return res.json({ success: true, model: model.trim(), message: `Model "${model.trim()}" is available.` });
    }

    let errorBody = null;
    try { errorBody = await response.json(); } catch { errorBody = null; }
    const errorCode = errorBody?.error?.code || null;
    const errorMsg = errorBody?.error?.message || `HTTP ${response.status}`;

    if (response.status === 404 || errorCode === 'model_not_found') {
      return res.status(400).json({
        error: `Model "${model.trim()}" not available. ${errorMsg}`,
        code: 'model_not_found',
      });
    }
    return res.status(400).json({ error: errorMsg, code: errorCode });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Test Gemini connection
router.post('/test-gemini', async (req, res) => {
  const candidateKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  const apiKey = candidateKey || await getSetting('gemini_api_key');
  if (!apiKey) return res.status(400).json({ error: 'Gemini API key not configured' });

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) {
      return res.status(400).json({ error: `Gemini API returned ${response.status}` });
    }
    res.json({ success: true, message: 'Gemini API key is valid' });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Test Google Drive connection
router.post('/test-drive', async (req, res) => {
  try {
    const drive = await getDriveClient();
    const response = await drive.about.get({ fields: 'user' });
    res.json({
      success: true,
      message: `Connected as ${response.data.user?.displayName || 'service account'}`
    });
  } catch (err) {
    res.status(500).json({ error: `Drive connection failed: ${err.message}` });
  }
});

// Test Anthropic connection
router.post('/test-anthropic', async (req, res) => {
  const candidateKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  const apiKey = candidateKey || await getSetting('anthropic_api_key');
  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });

  try {
    const model = await testAnthropicKey(apiKey);
    res.json({ success: true, model, message: 'Anthropic API key is valid for Creative Filter QA.' });
  } catch (err) {
    res.status(400).json({ error: `Anthropic test failed: ${err.message}` });
  }
});

// =============================================
// Dashboard To-Do List (dedicated Convex table)
// =============================================

router.get('/todos', async (req, res) => {
  try {
    const todos = await getDashboardTodos();
    res.json({ todos });
  } catch {
    res.json({ todos: [] });
  }
});

router.put('/todos', async (req, res) => {
  const { todos } = req.body;
  if (!Array.isArray(todos)) return res.status(400).json({ error: 'todos must be an array' });
  await replaceDashboardTodos(todos);
  res.json({ success: true });
});

// Refresh Gemini image rates from Google pricing page
router.post('/refresh-gemini-rates', async (req, res) => {
  try {
    const result = await refreshGeminiRates();
    if (result.refreshed) {
      res.json({ success: true, rates: result.rates });
    } else {
      res.json({ success: false, message: result.reason });
    }
  } catch (err) {
    res.status(500).json({ error: `Rate refresh failed: ${err.message}` });
  }
});

export default router;

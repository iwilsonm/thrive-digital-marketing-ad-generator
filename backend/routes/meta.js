// Phase 2A — Meta integration routes.
// OAuth init / callback / status / disconnect, ad-account picker, integration-path toggle.
// All require auth + admin/manager role except the OAuth callback (Facebook redirects
// with no session cookie due to sameSite=Lax) and the cron refresh endpoint
// (validated by Vercel's cron header).

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireRole } from '../auth.js';
import { isValidCronBearer } from '../security.js';
import {
  getProject,
  getProjectRawForMeta,
  getProjectsWithExpiringMetaTokens,
  updateProject,
  getSetting,
  getMetaMcpDiagnostic,
  upsertMetaMcpDiagnostic,
  getUserByExternalId,
  convexClient,
  api,
} from '../convexClient.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeShortLivedForLongLived,
  refreshLongLivedToken,
  getMe,
  getAdAccounts,
  getPages,
  getCampaigns,
  getAdSets,
  getAds,
  getInsights,
  isTokenInvalidError,
  META_OAUTH_SCOPES,
} from '../services/metaApi.js';
import {
  MCPReadUnavailableError,
  checkMetaMcpReadAccess,
  getCampaignsWithInsightsViaMcp,
  getAdSetsWithInsightsViaMcp,
  getAdsWithInsightsViaMcp,
} from '../services/metaMcpRead.js';
import { MCPNotAuthorizedError } from '../services/metaMcp.js';

const router = Router();

const REDIRECT_URI = process.env.META_OAUTH_REDIRECT_URI
  || 'https://thrive-digital-marketing-ad-generat.vercel.app/api/meta/oauth/callback';

// Cookie name for state + PKCE binding. Single cookie holds all the OAuth-init
// session data across the redirect to FB and back. We don't depend on
// cookie-parser middleware — there's a tiny inline reader below since the
// session cookie is sameSite=strict (won't survive Facebook redirect) and
// adding a parser dep just for one cookie is overkill.
const META_OAUTH_COOKIE = 'meta_oauth_state';

function readCookie(req, name) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Helper — compute SHA-256 PKCE challenge from a code_verifier
function pkceChallenge(verifier) {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function isMcpRead(project) {
  return (project?.meta_read_path || 'api') === 'mcp';
}

async function mcpReadArgs(project, opts, projectId) {
  return {
    anthropicApiKey: await getSetting('anthropic_api_key'),
    metaToken: project.meta_access_token,
    accountId: project.meta_account_id,
    opts,
    projectId,
  };
}

function sendMetaReadError(res, err) {
  if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.', code: 'TOKEN_EXPIRED' });
  if (err instanceof MCPReadUnavailableError || err instanceof MCPNotAuthorizedError || err.code === 'MCP_READ_UNAVAILABLE' || err.code === 'MCP_NOT_AUTHORIZED') {
    return res.status(err.status || 424).json({
      error: 'Meta MCP is connected, but this ad account does not expose the read tools Analytics and Observation need. Go to Project Settings → Meta and switch Analytics & Observation Read Path to API.',
      code: err.code || 'MCP_READ_UNAVAILABLE',
      details: err.message,
      action: 'SWITCH_READ_PATH_TO_API',
      settings_path: 'overview',
      settings_subtab: 'meta',
    });
  }
  return res.status(500).json({ error: err.message });
}

function sanitizeDiagnostic(row) {
  if (!row) return null;
  return {
    status: row.status,
    read_access: row.read_access,
    posting_access: row.posting_access,
    reason_code: row.reason_code,
    read_reason_code: row.read_reason_code || row.reason_code,
    posting_reason_code: row.posting_reason_code || row.reason_code,
    user_message: row.user_message,
    technical_details: row.technical_details || '',
    checked_at: row.checked_at,
    meta_account_id: row.meta_account_id,
  };
}

function diagnosticResult({
  project,
  status,
  readAccess,
  postingAccess,
  reasonCode,
  readReasonCode,
  postingReasonCode,
  userMessage,
  technicalDetails = '',
}) {
  return {
    project_id: project?.externalId,
    meta_account_id: project?.meta_account_id || '',
    status,
    read_access: readAccess,
    posting_access: postingAccess,
    reason_code: reasonCode,
    read_reason_code: readReasonCode || reasonCode,
    posting_reason_code: postingReasonCode || reasonCode,
    user_message: userMessage,
    technical_details: technicalDetails,
    checked_at: new Date().toISOString(),
  };
}

async function persistDiagnostic(result) {
  if (!result?.project_id || !result?.meta_account_id) return result;
  await upsertMetaMcpDiagnostic(result);
  return result;
}

async function runMcpAccessDiagnostic(projectId) {
  const project = await getProjectRawForMeta(projectId);
  if (!project) {
    const err = new Error('Project not found');
    err.statusCode = 404;
    throw err;
  }

  if (!project.meta_access_token) {
    return diagnosticResult({
      project,
      status: 'setup_issue',
      readAccess: 'not_available',
      postingAccess: 'not_available',
      reasonCode: 'NO_META_CONNECTION',
      readReasonCode: 'NO_META_CONNECTION',
      postingReasonCode: 'NO_META_CONNECTION',
      userMessage: 'Connect Meta before checking MCP access.',
    });
  }

  if (!project.meta_account_id) {
    return diagnosticResult({
      project,
      status: 'setup_issue',
      readAccess: 'not_available',
      postingAccess: 'not_available',
      reasonCode: 'NO_AD_ACCOUNT',
      readReasonCode: 'NO_AD_ACCOUNT',
      postingReasonCode: 'NO_AD_ACCOUNT',
      userMessage: 'Select the Meta ad account this project should use before checking MCP access.',
    });
  }

  const anthropicApiKey = await getSetting('anthropic_api_key');
  if (!anthropicApiKey) {
    return await persistDiagnostic(diagnosticResult({
      project,
      status: 'setup_issue',
      readAccess: 'not_available',
      postingAccess: project.meta_page_id ? 'not_available' : 'not_checked',
      reasonCode: 'NO_ANTHROPIC_KEY',
      readReasonCode: 'NO_ANTHROPIC_KEY',
      postingReasonCode: project.meta_page_id ? 'NO_ANTHROPIC_KEY' : 'NO_PAGE',
      userMessage: 'Add an Anthropic API key in global Settings before using Meta MCP.',
    }));
  }

  const postingAccess = project.meta_page_id ? 'configuration_ready' : 'needs_setup';
  const postingReasonCode = project.meta_page_id ? 'MCP_POSTING_CONFIGURATION_READY' : 'NO_PAGE';

  try {
    await checkMetaMcpReadAccess({
      anthropicApiKey,
      metaToken: project.meta_access_token,
      accountId: project.meta_account_id,
      opts: { datePreset: 'last_7d' },
      projectId,
    });
    return await persistDiagnostic(diagnosticResult({
      project,
      status: 'available',
      readAccess: 'available',
      postingAccess,
      reasonCode: 'MCP_AVAILABLE',
      readReasonCode: 'MCP_READ_AVAILABLE',
      postingReasonCode,
      userMessage: project.meta_page_id
        ? 'Meta MCP reads are available. Posting is configured to use MCP and is ready to try from Ready to Post.'
        : 'Meta MCP read access is available. Select a Facebook Page before posting through MCP.',
    }));
  } catch (err) {
    if (isTokenInvalidError(err)) {
      return await persistDiagnostic(diagnosticResult({
        project,
        status: 'setup_issue',
        readAccess: 'not_available',
        postingAccess: 'not_available',
        reasonCode: 'TOKEN_EXPIRED',
        readReasonCode: 'TOKEN_EXPIRED',
        postingReasonCode: 'TOKEN_EXPIRED',
        userMessage: 'The Meta token expired or was revoked. Reconnect Meta, then check MCP access again.',
        technicalDetails: err.message,
      }));
    }
    if (err instanceof MCPNotAuthorizedError || err.code === 'MCP_NOT_AUTHORIZED') {
      return await persistDiagnostic(diagnosticResult({
        project,
        status: 'not_available',
        readAccess: 'not_available',
        postingAccess: 'not_available',
        reasonCode: 'META_MCP_NOT_ENABLED',
        readReasonCode: 'META_MCP_NOT_ENABLED',
        postingReasonCode: 'META_MCP_NOT_ENABLED',
        userMessage: 'Meta did not authorize MCP for this selected ad account/app. API reads can still work, but MCP is not available for this account right now.',
        technicalDetails: err.message,
      }));
    }
    if (err instanceof MCPReadUnavailableError || err.code === 'MCP_READ_UNAVAILABLE') {
      return await persistDiagnostic(diagnosticResult({
        project,
        status: postingAccess === 'configuration_ready' ? 'partial' : 'not_available',
        readAccess: 'not_available',
        postingAccess,
        reasonCode: 'MCP_READ_UNAVAILABLE',
        readReasonCode: 'MCP_READ_UNAVAILABLE',
        postingReasonCode,
        userMessage: project.meta_page_id
          ? 'Meta MCP connected, but the read tools needed by Analytics/Observation are not available for this account/app. API reads can still work, and MCP posting is configured.'
          : 'Meta MCP connected, but the read tools needed by Analytics/Observation are not available for this account/app. Select a Facebook Page before posting through MCP.',
        technicalDetails: err.message,
      }));
    }
    return await persistDiagnostic(diagnosticResult({
      project,
      status: 'unknown',
      readAccess: 'not_checked',
      postingAccess,
      reasonCode: 'UNKNOWN_MCP_ERROR',
      readReasonCode: 'UNKNOWN_MCP_ERROR',
      postingReasonCode,
      userMessage: 'The MCP read check hit an unexpected connector error. Try again, or use API reads while access is being confirmed.',
      technicalDetails: err.message,
    }));
  }
}

async function getMetaAppCreds() {
  const [appId, appSecret] = await Promise.all([
    getSetting('meta_app_id'),
    getSetting('meta_app_secret'),
  ]);
  if (!appId || !appSecret) {
    const err = new Error('Meta App ID + Secret not configured. Set them in Settings → API Keys.');
    err.statusCode = 400;
    throw err;
  }
  return { appId, appSecret };
}

// ────────────────────────────────────────────────
// OAuth init — generate the Facebook authorize URL
// ────────────────────────────────────────────────

router.post('/oauth/init', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { appId } = await getMetaAppCreds();
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = pkceChallenge(codeVerifier);

    // Bind state + verifier + projectId in an HttpOnly cookie. Cookie persists
    // through the FB round-trip; callback validates the state matches.
    const cookieValue = JSON.stringify({ state, codeVerifier, projectId, t: Date.now() });
    res.cookie(META_OAUTH_COOKIE, cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',          // 'lax' allows cookie on top-level redirect from facebook.com
      maxAge: 10 * 60 * 1000,   // 10 minutes — OAuth dances should complete fast
      path: '/api/meta',
    });

    const authUrl = buildAuthorizeUrl({
      clientId: appId,
      redirectUri: REDIRECT_URI,
      state,
      codeChallenge,
    });
    res.json({ authUrl });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// OAuth callback — Facebook redirects user here with code+state
// ────────────────────────────────────────────────

// Public — no requireAuth (sameSite=Lax + the bound cookie is enough verification)
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;

  function htmlClose(payload) {
    // Posts message to opener, then closes. Origin is locked to current page.
    const json = JSON.stringify(payload);
    return `<!DOCTYPE html><html><body><script>
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'meta-oauth-result', payload: ${json} }, window.location.origin);
        }
      } catch (e) {}
      setTimeout(function(){ window.close(); }, 50);
    </script><p>You can close this window.</p></body></html>`;
  }

  try {
    if (oauthError) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: error_description || oauthError }));
    }
    if (!code || !state) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'Missing code or state' }));
    }

    // Read + clear state cookie
    const raw = readCookie(req, META_OAUTH_COOKIE);
    if (!raw) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'OAuth session cookie missing — was the popup opened from CF?' }));
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(400).type('html').send(htmlClose({ ok: false, error: 'Corrupt OAuth session cookie' })); }
    res.clearCookie(META_OAUTH_COOKIE, { path: '/api/meta' });

    if (parsed.state !== state) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'State mismatch (possible CSRF)' }));
    }
    const { codeVerifier, projectId } = parsed;
    if (!projectId) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'projectId missing from session' }));
    }

    const { appId, appSecret } = await getMetaAppCreds();

    // Step 1: code → short-lived token
    const short = await exchangeCodeForToken({
      clientId: appId,
      clientSecret: appSecret,
      code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
    });

    // Step 2: short-lived → long-lived (~60 days)
    const long = await exchangeShortLivedForLongLived({
      clientId: appId,
      clientSecret: appSecret,
      shortLivedToken: short.access_token,
    });

    // Step 3: who are we
    const me = await getMe(long.access_token);

    // Step 4: persist on the project
    const expiresAt = Date.now() + ((long.expires_in || 60 * 24 * 3600) * 1000);
    await updateProject(projectId, {
      meta_access_token: long.access_token,
      meta_token_expires_at: expiresAt,
      meta_user_id: me.id,
      meta_user_name: me.name,
      meta_integration_path: 'mcp', // sensible default; user can switch later
      meta_connected_at: Date.now(),
    });

    res.type('html').send(htmlClose({ ok: true }));
  } catch (err) {
    res.status(500).type('html').send(htmlClose({ ok: false, error: err.message }));
  }
});

// ────────────────────────────────────────────────
// Status / disconnect
// ────────────────────────────────────────────────

router.get('/connection-status', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const diagnostic = project.meta_account_id
      ? await getMetaMcpDiagnostic(projectId, project.meta_account_id)
      : null;
    res.json({
      connected: !!project.meta_connected,
      user_id: project.meta_user_id,
      user_name: project.meta_user_name,
      account_id: project.meta_account_id,
      account_name: project.meta_account_name,
      business_id: project.meta_business_id,
      integration_path: project.meta_integration_path || 'mcp',
      posting_path: project.meta_integration_path || 'mcp',
      read_path: project.meta_read_path || 'api',
      connected_at: project.meta_connected_at,
      token_expires_at: project.meta_token_expires_at,
      // Phase 2B
      page_id: project.meta_page_id,
      page_name: project.meta_page_name,
      mcp_access: sanitizeDiagnostic(diagnostic),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disconnect', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Update with empty strings (Convex v.optional(v.string()) accepts empty string)
    // and 0/null for timestamp + ids. Effectively clears the connection.
    await updateProject(projectId, {
      meta_access_token: '',
      meta_token_expires_at: 0,
      meta_user_id: '',
      meta_user_name: '',
      meta_account_id: '',
      meta_account_name: '',
      meta_business_id: '',
      meta_connected_at: 0,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Ad account picker / selection
// ────────────────────────────────────────────────

router.get('/ad-accounts', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token) {
      return res.status(400).json({ error: 'Project not connected to Meta' });
    }
    try {
      const accounts = await getAdAccounts(raw.meta_access_token);
      res.json({ accounts });
    } catch (err) {
      if (isTokenInvalidError(err)) {
        // Token expired / revoked — clear and prompt reconnect
        await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
        return res.status(401).json({ error: 'Meta token expired. Please reconnect.' });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 2B — list available Facebook Pages for the connected user
router.get('/pages', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token) {
      return res.status(400).json({ error: 'Project not connected to Meta' });
    }
    try {
      const pages = await getPages(raw.meta_access_token);
      res.json({ pages });
    } catch (err) {
      if (isTokenInvalidError(err)) {
        await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
        return res.status(401).json({ error: 'Meta token expired. Please reconnect.' });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 2B — persist FB Page selection on the project
router.post('/select-page', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, pageId, pageName } = req.body || {};
    if (!projectId || !pageId) return res.status(400).json({ error: 'projectId + pageId required' });
    await updateProject(projectId, {
      meta_page_id: pageId,
      meta_page_name: pageName || '',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/select-account', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, accountId, accountName, businessId } = req.body || {};
    if (!projectId || !accountId) return res.status(400).json({ error: 'projectId + accountId required' });
    await updateProject(projectId, {
      meta_account_id: accountId,
      meta_account_name: accountName || '',
      meta_business_id: businessId || '',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/integration-path', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, path } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (path !== 'mcp' && path !== 'api') {
      return res.status(400).json({ error: 'path must be "mcp" or "api"' });
    }
    await updateProject(projectId, { meta_integration_path: path });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/read-path', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, path } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (path !== 'mcp' && path !== 'api') {
      return res.status(400).json({ error: 'path must be "mcp" or "api"' });
    }
    await updateProject(projectId, { meta_read_path: path });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mcp-access/check', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const result = await runMcpAccessDiagnostic(projectId);
    res.json(sanitizeDiagnostic(result));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Read endpoints (campaigns / ad sets / ads / insights) — for Analytics tab + 2C
// ────────────────────────────────────────────────

router.get('/campaigns', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token || !raw?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select ad account first.' });
    }
    const campaigns = isMcpRead(raw)
      ? await getCampaignsWithInsightsViaMcp(await mcpReadArgs(raw, { datePreset: 'last_7d' }, projectId))
      : await getCampaigns(raw.meta_access_token, raw.meta_account_id);
    res.json({ campaigns });
  } catch (err) {
    sendMetaReadError(res, err);
  }
});

router.get('/adsets', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, campaignId } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token || !raw?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select ad account first.' });
    }
    const readOpts = { datePreset: 'last_7d', campaignId: campaignId || null };
    const adsets = isMcpRead(raw)
      ? await getAdSetsWithInsightsViaMcp(await mcpReadArgs(raw, readOpts, projectId))
      : await getAdSets(raw.meta_access_token, raw.meta_account_id, campaignId || null);
    res.json({ adsets });
  } catch (err) {
    sendMetaReadError(res, err);
  }
});

router.get('/ads', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, adsetId } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token) return res.status(400).json({ error: 'Connect Meta first.' });
    if (!adsetId) return res.status(400).json({ error: 'adsetId required' });
    const readOpts = { datePreset: 'last_7d', adsetId };
    const ads = isMcpRead(raw)
      ? await getAdsWithInsightsViaMcp(await mcpReadArgs(raw, readOpts, projectId))
      : await getAds(raw.meta_access_token, adsetId);
    res.json({ ads });
  } catch (err) {
    sendMetaReadError(res, err);
  }
});

router.get('/insights', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, objectId, datePreset } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token) return res.status(400).json({ error: 'Connect Meta first.' });
    if (!objectId) return res.status(400).json({ error: 'objectId required' });
    if (isMcpRead(raw)) {
      throw new MCPReadUnavailableError('Object-level insights are not yet supported through the Meta MCP read adapter.');
    }
    const insights = await getInsights(raw.meta_access_token, objectId, { datePreset: datePreset || 'last_7d' });
    res.json({ insights });
  } catch (err) {
    sendMetaReadError(res, err);
  }
});

// ────────────────────────────────────────────────
// Vercel Cron — daily token refresh
// ────────────────────────────────────────────────
//
// Vercel's cron jobs hit this endpoint with Authorization: Bearer ${CRON_SECRET}.
// We also accept an authenticated admin session for manual testing.

router.post('/oauth/refresh', async (req, res) => {
  const cronAuthorized = isValidCronBearer(req);
  if (!cronAuthorized) {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = await getUserByExternalId(req.session.userId);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin permissions required' });
    }
  }

  try {
    const { appId, appSecret } = await getMetaAppCreds();
    // Refresh tokens expiring within 7 days
    const projects = await getProjectsWithExpiringMetaTokens(7 * 24 * 3600 * 1000);
    const results = [];

    for (const p of projects) {
      try {
        const fresh = await refreshLongLivedToken({
          clientId: appId,
          clientSecret: appSecret,
          currentToken: p.meta_access_token,
        });
        const expiresAt = Date.now() + ((fresh.expires_in || 60 * 24 * 3600) * 1000);
        await updateProject(p.externalId, {
          meta_access_token: fresh.access_token,
          meta_token_expires_at: expiresAt,
        });
        results.push({ projectId: p.externalId, refreshed: true, expires_at: expiresAt });
      } catch (err) {
        if (isTokenInvalidError(err)) {
          await updateProject(p.externalId, { meta_access_token: '', meta_token_expires_at: 0 });
          results.push({ projectId: p.externalId, refreshed: false, cleared: true, error: err.message });
        } else {
          results.push({ projectId: p.externalId, refreshed: false, error: err.message });
        }
      }
    }

    res.json({ scanned: projects.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

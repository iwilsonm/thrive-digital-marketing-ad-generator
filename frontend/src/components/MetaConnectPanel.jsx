import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import InfoTooltip from './InfoTooltip';

// Phase 2A — Per-project Meta OAuth + ad-account picker + integration path toggle.
// Lives as the "Meta" sub-tab inside Project Settings. No data is shown until the
// user clicks "Connect Meta Account" and completes the OAuth dance in a popup.
//
// On the popup completing, it postMessages back here with { type: 'meta-oauth-result',
// payload: { ok, error? } }. We listen for that and refetch connection status.
export default function MetaConnectPanel({ projectId }) {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  // Phase 2B — Facebook Page picker
  const [pages, setPages] = useState([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkingMcp, setCheckingMcp] = useState(false);
  const [error, setError] = useState('');

  const mcpAccess = status?.mcp_access || null;
  const currentReadPath = status?.read_path || 'api';
  const currentPostingPath = status?.posting_path || status?.integration_path || 'mcp';
  const activeMcpAccess = mcpAccess?.meta_account_id === status?.account_id ? mcpAccess : null;

  const mcpToneClasses = {
    success: 'border-ed-green/30 bg-ed-green/10 text-ed-green',
    warning: 'border-orange-200 bg-orange-50 text-orange-800',
    danger: 'border-ed-rust/25 bg-ed-rust/10 text-ed-rust',
    neutral: 'border-ed-line bg-cream text-ed-ink2',
  };

  const buildReadStatus = () => {
    if (!status?.account_id) {
      return {
        label: 'Select an ad account',
        tone: 'neutral',
        current: 'No ad account selected',
        access: 'Not checked',
        meaning: 'Analytics and Observation need a Meta ad account before access can be checked.',
        next: 'Select the ad account this project should use.',
      };
    }
    if (currentReadPath === 'api') {
      return {
        label: 'Working through API',
        tone: 'success',
        current: 'Read Path is API',
        access: activeMcpAccess?.read_access === 'available'
          ? 'API selected; MCP reads also checked as available'
          : 'API reads are selected',
        meaning: activeMcpAccess?.read_reason_code === 'MCP_READ_UNAVAILABLE'
          ? 'This is the right setup for this account: Meta does not expose MCP analytics tools here, so Analytics and Observation should use API.'
          : 'Analytics and Observation will use the stable Meta Marketing API read path.',
        next: 'No action needed.',
      };
    }
    if (!activeMcpAccess) {
      return {
        label: 'Not checked for this account yet',
        tone: 'warning',
        current: 'Read Path is MCP',
        access: 'Unknown for this selected ad account',
        meaning: 'MCP read availability can vary by Meta ad account. Analytics and Observation may fail until this is checked.',
        next: 'Click Check MCP Access, or switch to API reads for the stable path.',
        action: 'switch_read_api',
      };
    }
    if (activeMcpAccess.read_access === 'available') {
      return {
        label: 'MCP reads available',
        tone: 'success',
        current: 'Read Path is MCP',
        access: 'Meta exposed the MCP read tools this app needs',
        meaning: 'Analytics and Observation can read campaigns, ad sets, ads, and performance through MCP.',
        next: 'No action needed.',
      };
    }
    if (activeMcpAccess.read_reason_code === 'MCP_READ_UNAVAILABLE') {
      return {
        label: 'MCP reads unavailable',
        tone: 'danger',
        current: 'Read Path is MCP',
        access: 'MCP is connected, but Meta is not exposing analytics read tools for this account/app',
        meaning: 'Analytics and Observation will not work through MCP on this account right now. This does not automatically mean MCP posting is broken.',
        next: 'Switch Analytics & Observation Read Path to API.',
        action: 'switch_read_api',
      };
    }
    if (['NO_META_CONNECTION', 'NO_AD_ACCOUNT', 'NO_ANTHROPIC_KEY', 'TOKEN_EXPIRED', 'META_MCP_NOT_ENABLED'].includes(activeMcpAccess.read_reason_code)) {
      return {
        label: 'Needs setup',
        tone: activeMcpAccess.read_reason_code === 'META_MCP_NOT_ENABLED' ? 'danger' : 'warning',
        current: 'Read Path is MCP',
        access: activeMcpAccess.user_message || 'MCP reads are not ready.',
        meaning: 'Analytics and Observation need the setup issue fixed or the read path switched to API.',
        next: activeMcpAccess.read_reason_code === 'TOKEN_EXPIRED'
          ? 'Reconnect Meta, then check access again.'
          : 'Use API reads while MCP setup or account access is being resolved.',
        action: activeMcpAccess.read_reason_code === 'TOKEN_EXPIRED' ? 'reconnect' : 'switch_read_api',
      };
    }
    return {
      label: 'Not confirmed',
      tone: 'warning',
      current: 'Read Path is MCP',
      access: 'The last MCP read check did not return a clear result',
      meaning: 'Analytics and Observation may fail through MCP until this is checked again.',
      next: 'Click Check MCP Access again, or switch reads to API.',
      action: 'switch_read_api',
    };
  };

  const buildPostingStatus = () => {
    if (!status?.account_id) {
      return {
        label: 'Select an ad account',
        tone: 'neutral',
        current: 'No ad account selected',
        access: 'Not checked',
        meaning: 'Ready-to-Post needs an ad account before posting setup can be checked.',
        next: 'Select the ad account this project should use.',
      };
    }
    if (currentPostingPath === 'api') {
      return {
        label: 'Direct API selected',
        tone: 'warning',
        current: 'Posting Path is Direct API',
        access: 'Ready-to-Post will use the Meta Marketing API directly',
        meaning: 'This is separate from Analytics reads. Direct API posting can carry account risk.',
        next: 'Use MCP posting unless you intentionally want Direct API posting.',
        action: 'switch_posting_mcp',
      };
    }
    if (!status.page_id) {
      return {
        label: 'Needs Facebook Page',
        tone: 'warning',
        current: 'Posting Path is MCP',
        access: 'MCP posting cannot be prepared until a Facebook Page is selected',
        meaning: 'Posting uses a Page identity. This is why accounts can show MCP connected but still need setup before posting.',
        next: pages.length > 0 ? 'Select a Facebook Page in the Page list above.' : 'Reconnect Meta with Page-list permission, then select a Facebook Page.',
        action: pages.length > 0 ? null : 'reconnect',
      };
    }
    if (!activeMcpAccess) {
      return {
        label: 'Not checked',
        tone: 'warning',
        current: 'Posting Path is MCP',
        access: 'Configured with an ad account and Page, but MCP account access has not been checked here yet',
        meaning: 'Ready-to-Post is set up to try MCP posting. Checking access can catch account-level MCP blocks earlier.',
        next: 'Click Check MCP Access.',
      };
    }
    if (activeMcpAccess.posting_access === 'available' || activeMcpAccess.posting_access === 'configuration_ready') {
      return {
        label: 'Ready through MCP',
        tone: 'success',
        current: 'Posting Path is MCP',
        access: activeMcpAccess.posting_access === 'available'
          ? 'MCP access check passed and a Facebook Page is selected'
          : 'MCP posting is configured with an ad account and Facebook Page',
        meaning: activeMcpAccess.read_reason_code === 'MCP_READ_UNAVAILABLE'
          ? 'Reads still need API on this account, but Ready-to-Post can remain on MCP posting.'
          : 'Ready-to-Post can use the connector path when you post ad sets.',
        next: 'No action needed.',
      };
    }
    if (activeMcpAccess.posting_reason_code === 'META_MCP_NOT_ENABLED') {
      return {
        label: 'MCP posting not authorized',
        tone: 'danger',
        current: 'Posting Path is MCP',
        access: 'Meta did not authorize MCP for this ad account/app',
        meaning: 'Ready-to-Post cannot post through MCP for this selected account right now.',
        next: 'Use API posting only if you intentionally accept that path, or use an MCP-enabled account.',
      };
    }
    return {
      label: 'Not confirmed',
      tone: 'warning',
      current: 'Posting Path is MCP',
      access: activeMcpAccess.user_message || 'Posting access is not confirmed.',
      meaning: 'Posting setup needs attention before relying on MCP.',
      next: 'Click Check MCP Access after the ad account and Page are selected.',
    };
  };

  const readStatusView = buildReadStatus();
  const postingStatusView = buildPostingStatus();

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getMetaConnectionStatus(projectId);
      setStatus(s);
      if (s?.connected) {
        setAccountsLoading(true);
        try {
          const list = await api.getMetaAdAccounts(projectId);
          setAccounts(list);
        } catch (err) {
          if (/expired|reconnect/i.test(err?.message || '')) {
            // token died; status will reflect that on next loadStatus
            await loadStatus();
          } else {
            setError(err?.message || 'Could not load ad accounts');
          }
        } finally {
          setAccountsLoading(false);
        }
        // Phase 2B — load Pages too. Independent of accounts; Pages are
        // user-scoped (`/me/accounts`) not account-scoped.
        setPagesLoading(true);
        try {
          const list = await api.getMetaPages(projectId);
          setPages(list);
        } catch (err) {
          // Don't bail the whole panel; just log
          console.warn('Pages load failed:', err?.message);
          setPages([]);
        } finally {
          setPagesLoading(false);
        }
      } else {
        setAccounts([]);
        setPages([]);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load connection status');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { setLoading(true); loadStatus(); }, [loadStatus]);

  // Listen for the OAuth popup posting back to us
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'meta-oauth-result') return;
      const { ok, error: errMsg } = event.data.payload || {};
      if (ok) {
        toast.success('Meta account connected');
        loadStatus();
      } else {
        setError(errMsg || 'Meta OAuth failed');
        toast.error(errMsg || 'Meta OAuth failed');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadStatus, toast]);

  // Polling state for the OAuth-completion fallback (postMessage from the popup
  // can be blocked by Cross-Origin-Opener-Policy when the popup navigates to
  // facebook.com and back). We poll connection-status until the backend shows
  // a token, or until the popup is closed, or until a 5-minute timeout.
  const pollIntervalRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const popupRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleConnect = async () => {
    setBusy(true); setError('');
    try {
      const { authUrl } = await api.initMetaOAuth(projectId);
      const w = 600, h = 720;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(authUrl, 'meta-oauth', `width=${w},height=${h},left=${left},top=${top}`);
      popupRef.current = popup;

      // Capture a snapshot of "currently connected?" before the user authorizes
      // so we can detect the transition false → true. Otherwise on a re-connect
      // we'd see "still connected" and stop polling immediately.
      const beforeStatus = await api.getMetaConnectionStatus(projectId).catch(() => null);
      const wasConnectedBefore = !!beforeStatus?.connected;

      // Polling fallback: every 2s, check backend status. Stop on detect, on
      // popup close, or after 5 min.
      stopPolling();
      pollIntervalRef.current = setInterval(async () => {
        try {
          const s = await api.getMetaConnectionStatus(projectId);
          if (s?.connected && !wasConnectedBefore) {
            stopPolling();
            toast.success('Meta account connected');
            try { popupRef.current?.close(); } catch {}
            await loadStatus();
          } else if (popupRef.current && popupRef.current.closed) {
            // Popup closed without completing — stop polling silently
            stopPolling();
          }
        } catch { /* keep polling */ }
      }, 2000);
      pollTimeoutRef.current = setTimeout(() => {
        stopPolling();
      }, 5 * 60 * 1000);
    } catch (err) {
      setError(err?.message || 'Could not start Meta OAuth');
      toast.error(err?.message || 'Could not start Meta OAuth');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect this project from Meta? Stored token will be cleared.')) return;
    setBusy(true);
    try {
      await api.disconnectMeta(projectId);
      toast.success('Disconnected from Meta');
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Disconnect failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectAccount = async (acct) => {
    setBusy(true);
    try {
      await api.selectMetaAdAccount(projectId, {
        accountId: acct.id,
        accountName: acct.name,
        businessId: acct.business?.id,
      });
      setStatus((prev) => prev ? {
        ...prev,
        account_id: acct.id,
        account_name: acct.name,
        business_id: acct.business?.id || null,
        mcp_access: null,
      } : prev);
      toast.success(`Selected ${acct.name}`);
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Could not select account');
    } finally {
      setBusy(false);
    }
  };

  // Phase 2B — pick a Facebook Page for posting ads from
  const handleSelectPage = async (pg) => {
    setBusy(true);
    try {
      await api.selectMetaPage(projectId, {
        pageId: pg.id,
        pageName: pg.name,
      });
      toast.success(`Page set to ${pg.name}`);
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Could not select Page');
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePostingPath = async (path) => {
    setBusy(true);
    try {
      await api.setMetaIntegrationPath(projectId, path);
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Could not change posting path');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleReadPath = async (path) => {
    setBusy(true);
    try {
      await api.setMetaReadPath(projectId, path);
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Could not change read path');
    } finally {
      setBusy(false);
    }
  };

  const handleCheckMcpAccess = async () => {
    setCheckingMcp(true);
    setError('');
    try {
      const result = await api.checkMetaMcpAccess(projectId);
      setStatus((prev) => prev ? { ...prev, mcp_access: result } : prev);
      if (result?.status === 'available') {
        toast.success('MCP access confirmed for this account');
      } else if (result?.status === 'partial') {
        toast.success('MCP check complete: API reads recommended, MCP posting may still be usable');
      } else if (result?.read_reason_code === 'MCP_READ_UNAVAILABLE') {
        toast.error('MCP reads unavailable. Use API for Analytics and Observation.');
      } else {
        toast.error(result?.user_message || 'MCP access check needs setup');
      }
    } catch (err) {
      toast.error(err?.message || 'Could not check MCP access');
    } finally {
      setCheckingMcp(false);
    }
  };

  if (loading) {
    return <div className="ed-card p-6 text-sm text-ed-ink2">Loading Meta connection…</div>;
  }

  return (
    <div className="ed-card p-6 space-y-5">
      <div>
        <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight flex items-center gap-1">
          Meta integration
          <InfoTooltip text="Connect the Meta ad account and Facebook Page this project should use for analytics, posting, and observation." position="right" />
        </h2>
        <p className="text-xs text-ed-ink2 mt-1">
          Connect this project to Meta so the app can read performance data, prepare posts, and track posted ad sets through Observation.
        </p>
      </div>

      {!status?.connected && (
        <div>
          <div className="rounded-xl border border-ed-line bg-ed-bg/60 p-4 mb-4">
            <h3 className="text-[13px] font-semibold text-ed-ink mb-2">Meta setup checklist</h3>
            <ol className="list-decimal pl-4 space-y-1.5 text-[12px] text-ed-ink2 leading-relaxed">
              <li>In global Settings, save the Meta App ID and App Secret from the Meta developer app.</li>
              <li>In Meta's OAuth settings, add this exact redirect URI: <code className="bg-cream px-1 rounded">https://thrive-digital-marketing-ad-generat.vercel.app/api/meta/oauth/callback</code>.</li>
              <li>Make sure the Meta user connecting here has access to the ad account and at least one Facebook Page.</li>
              <li>Click Connect, approve the requested ads and Page-list permissions, then select this project's ad account and Page.</li>
            </ol>
            <p className="text-[11px] text-ed-ink3 mt-3 leading-relaxed">
              Common setup errors usually mean the App ID/Secret are missing, the redirect URI does not match exactly, the Meta user cannot access an ad account/Page, or the token expired and needs reconnecting.
            </p>
          </div>
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy}
            className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'Connect Meta Account'}
          </button>
          {error && <div className="mt-3 text-sm text-ed-rust">{error}</div>}
          <p className="mt-3 text-xs text-ed-ink3">
            Requires Meta App ID + Secret in global Settings. Create one Facebook App once at
            developers.facebook.com; ThriveCampaigns reuses it for every project's OAuth.
          </p>
        </div>
      )}

      {status?.connected && (
        <>
          <div className="bg-ed-green/10 border border-ed-green/20 rounded-lg p-3 text-sm">
            <div className="font-semibold text-ed-green">✓ Connected</div>
            <div className="text-xs text-ed-ink2 mt-1">
              As <strong>{status.user_name}</strong> ({status.user_id})
              {status.token_expires_at && (
                <span> · token refreshes daily, currently valid until {new Date(status.token_expires_at).toLocaleDateString()}</span>
              )}
            </div>
          </div>

          {/* Ad account picker */}
          <div>
            <div className="text-xs font-semibold text-ed-ink2 mb-1">Ad account</div>
            {status.account_id ? (
              <div className="flex items-center justify-between gap-2 bg-cream rounded p-2 text-sm">
                <div>
                  <div className="font-semibold">{status.account_name || status.account_id}</div>
                  <div className="text-xs text-ed-ink3">{status.account_id}</div>
                </div>
                <button type="button" onClick={() => loadStatus()} className="ed-ghost text-xs">Re-pick</button>
              </div>
            ) : null}
            {(!status.account_id || accountsLoading || accounts.length > 0) && (
              <div className="mt-2">
                <div className="text-xs text-ed-ink2 mb-1">
                  {status.account_id ? 'Switch to a different account:' : 'Select the ad account this project should use:'}
                </div>
                {accountsLoading && <div className="text-xs text-ed-ink3">Loading accounts…</div>}
                {!accountsLoading && accounts.length === 0 && (
                  <div className="text-xs text-ed-ink3">No ad accounts available for this Meta user.</div>
                )}
                {!accountsLoading && accounts.length > 0 && (
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {accounts.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => handleSelectAccount(a)}
                        disabled={busy || a.id === status.account_id}
                        className={`w-full text-left p-2 rounded text-sm transition ${a.id === status.account_id ? 'bg-ed-green/10 border border-ed-green/30' : 'hover:bg-ed-bg'} disabled:cursor-not-allowed`}
                      >
                        <div className="font-semibold">{a.name}</div>
                        <div className="text-xs text-ed-ink3">{a.id} · {a.business?.name || 'No business'}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Facebook Page picker */}
          <div>
            <div className="text-xs font-semibold text-ed-ink2 mb-1">Facebook Page</div>
            {!status.account_id ? (
              <div className="text-xs text-ed-ink3">Pick an ad account first.</div>
            ) : (
              <>
                {status.page_id && (
                  <div className="bg-cream rounded p-2 text-sm flex items-center justify-between">
                    <div>
                      <div className="font-semibold">{status.page_name || status.page_id}</div>
                      <div className="text-xs text-ed-ink3">{status.page_id}</div>
                    </div>
                    <span className="text-xs text-ed-green">✓ Page selected</span>
                  </div>
                )}
                {pagesLoading && <div className="text-xs text-ed-ink3">Loading Pages…</div>}
                {!pagesLoading && pages.length === 0 && (
                  <div className="text-xs text-ed-ink3 bg-cream rounded p-2">
                    No Pages are visible to ThriveCampaigns for this Meta connection. Posting requires Page-list permission plus admin/editor access to at least one Facebook Page. Reconnect Meta after approving the Page-list permission, then select the Page here.
                  </div>
                )}
                {!pagesLoading && pages.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs text-ed-ink2 mb-1">
                      {status.page_id ? 'Switch to a different Page:' : 'Select the Page to post ads from:'}
                    </div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {pages.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleSelectPage(p)}
                          disabled={busy || p.id === status.page_id}
                          className={`w-full text-left p-2 rounded text-sm transition ${p.id === status.page_id ? 'bg-ed-green/10 border border-ed-green/30' : 'hover:bg-ed-bg'} disabled:cursor-not-allowed`}
                        >
                          <div className="font-semibold">{p.name}</div>
                          <div className="text-xs text-ed-ink3">{p.id} · {p.category || 'Page'}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* MCP access diagnostics */}
          <div className="border-t border-cream pt-4">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="text-xs font-semibold text-ed-ink2 flex items-center gap-1">
                  Meta Connection Status
                  <InfoTooltip text="Reads power Analytics/Observation. Posting powers Ready-to-Post. MCP access can differ for each capability and by ad account." position="right" />
                </div>
                <p className="text-[11px] text-ed-ink3 mt-1 leading-relaxed">
                  This shows what the selected ad account can do and the exact setting to change when Meta limits MCP.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCheckMcpAccess}
                disabled={busy || checkingMcp || !status.account_id}
                className="shrink-0 px-3 py-1.5 rounded-[7px] text-[12px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
              >
                {checkingMcp ? 'Checking...' : 'Check MCP Access'}
              </button>
            </div>
            <div className="space-y-2">
              {[
                ['Analytics & Observation', readStatusView],
                ['Ready-to-Post Posting', postingStatusView],
              ].map(([title, view]) => (
                <div key={title} className={`rounded-lg border p-3 text-xs ${mcpToneClasses[view.tone] || mcpToneClasses.neutral}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold">{title}: {view.label}</div>
                      <div className="mt-2 grid gap-1 text-[11px] leading-relaxed text-ed-ink2">
                        <div><strong>Current setting:</strong> {view.current}</div>
                        <div><strong>What access you have:</strong> {view.access}</div>
                        <div><strong>What this means:</strong> {view.meaning}</div>
                        <div><strong>What to do next:</strong> {view.next}</div>
                      </div>
                    </div>
                    {view.action === 'switch_read_api' && (
                      <button
                        type="button"
                        onClick={() => handleToggleReadPath('api')}
                        disabled={busy || currentReadPath === 'api'}
                        className="shrink-0 px-3 py-1.5 rounded-[7px] text-[12px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
                      >
                        Use API Reads
                      </button>
                    )}
                    {view.action === 'switch_posting_mcp' && (
                      <button
                        type="button"
                        onClick={() => handleTogglePostingPath('mcp')}
                        disabled={busy || currentPostingPath === 'mcp'}
                        className="shrink-0 px-3 py-1.5 rounded-[7px] text-[12px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
                      >
                        Use MCP Posting
                      </button>
                    )}
                    {view.action === 'reconnect' && (
                      <button
                        type="button"
                        onClick={handleConnect}
                        disabled={busy}
                        className="shrink-0 px-3 py-1.5 rounded-[7px] text-[12px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
                      >
                        Reconnect Meta
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {activeMcpAccess?.checked_at && (
              <div className="mt-2 text-[11px] text-ed-ink3">
                Last checked {new Date(activeMcpAccess.checked_at).toLocaleString()} for {activeMcpAccess.meta_account_id}.
                {activeMcpAccess.read_reason_code && <> Read reason: {activeMcpAccess.read_reason_code}.</>}
                {activeMcpAccess.posting_reason_code && <> Posting reason: {activeMcpAccess.posting_reason_code}.</>}
              </div>
            )}
            {currentReadPath === 'api' && currentPostingPath === 'mcp' && (
              <div className="mt-2 text-xs text-ed-green bg-ed-green/10 border border-ed-green/20 p-2 rounded">
                Recommended mixed setup: Analytics and Observation use API reads, while Ready-to-Post uses MCP posting.
              </div>
            )}
          </div>

          {/* Read path toggle */}
          <div className="border-t border-cream pt-4">
            <div className="text-xs font-semibold text-ed-ink2 mb-1 flex items-center gap-1">
              Analytics & Observation Read Path
              <InfoTooltip text="Choose how Analytics and Observation pull campaigns, ad sets, ads, and performance data from Meta." position="right" />
            </div>
            <p className="text-[11px] text-ed-ink3 mb-2">
              API is the current stable read path. MCP reads use the Meta connector when Meta exposes the required read tools for this account/app.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleToggleReadPath('api')}
                disabled={busy || currentReadPath === 'api'}
                className={`flex-1 text-sm px-3 py-2 rounded ${currentReadPath === 'api' ? 'bg-ed-accent text-white' : 'bg-cream text-ed-ink hover:bg-cream/70'} disabled:opacity-100 disabled:cursor-default`}
              >
                API — current stable path
              </button>
              <button
                type="button"
                onClick={() => handleToggleReadPath('mcp')}
                disabled={busy || currentReadPath === 'mcp'}
                className={`flex-1 text-sm px-3 py-2 rounded ${currentReadPath === 'mcp' ? 'bg-ed-accent text-white' : 'bg-cream text-ed-ink hover:bg-cream/70'} disabled:opacity-100 disabled:cursor-default`}
              >
                MCP — connector reads
              </button>
            </div>
            {currentReadPath === 'mcp' && (
              <div className="mt-2 text-xs text-ed-ink2 bg-cream border border-ed-line p-2 rounded">
                MCP read mode will not silently fall back to API. If Meta's MCP server does not authorize read tools, Analytics and Observation will show a clear MCP read error.
              </div>
            )}
          </div>

          {/* Posting path toggle */}
          <div className="border-t border-cream pt-4">
            <div className="text-xs font-semibold text-ed-ink2 mb-1 flex items-center gap-1">
              Posting Path
              <InfoTooltip text="Choose how this app creates Meta ad sets and ads when you post from Ready to Post." position="right" />
            </div>
            <p className="text-[11px] text-ed-ink3 mb-2">
              MCP routes ad set/ad creation through the connector path. Direct API uses Meta's Marketing API directly for posting.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleTogglePostingPath('mcp')}
                disabled={busy || currentPostingPath === 'mcp'}
                className={`flex-1 text-sm px-3 py-2 rounded ${currentPostingPath === 'mcp' ? 'bg-ed-accent text-white' : 'bg-cream text-ed-ink hover:bg-cream/70'} disabled:opacity-100 disabled:cursor-default`}
              >
                MCP — recommended
              </button>
              <button
                type="button"
                onClick={() => handleTogglePostingPath('api')}
                disabled={busy || currentPostingPath === 'api'}
                className={`flex-1 text-sm px-3 py-2 rounded ${currentPostingPath === 'api' ? 'bg-ed-accent text-white' : 'bg-cream text-ed-ink hover:bg-cream/70'} disabled:opacity-100 disabled:cursor-default`}
              >
                Direct API
              </button>
            </div>
            {currentPostingPath === 'api' && (
              <div className="mt-2 text-xs text-orange-700 bg-orange-50 border border-orange-200 p-2 rounded">
                <strong>Warning:</strong> Direct API posting can carry account risk. Use the connector path unless you intentionally want the faster direct route.
              </div>
            )}
            {currentReadPath !== currentPostingPath && (
              <div className="mt-2 text-xs text-ed-ink2 bg-cream border border-ed-line p-2 rounded">
                Reads are using {currentReadPath.toUpperCase()}; posting is using {currentPostingPath.toUpperCase()}.
              </div>
            )}
          </div>

          {/* Disconnect */}
          <div className="border-t border-cream pt-4">
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
              className="ed-ghost text-xs"
            >
              Disconnect Meta
            </button>
          </div>

          {error && <div className="text-sm text-ed-rust">{error}</div>}
        </>
      )}
    </div>
  );
}

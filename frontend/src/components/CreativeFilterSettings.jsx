import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import InfoTooltip from './InfoTooltip';

function FieldLabel({ children, tooltip }) {
  return (
    <label className="text-[12px] font-medium text-ed-ink2 mb-1 flex items-center gap-1">
      {children}
      {tooltip && <InfoTooltip text={tooltip} position="right" />}
    </label>
  );
}

function AutoPostSettings({ projectId }) {
  const toast = useToast();
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getConductorConfig(projectId).then(c => setConfig(c)).catch(() => {});
  }, [projectId]);

  if (!config) return null;

  const form = {
    auto_post_enabled: config.auto_post_enabled ?? false,
    auto_post_max_daily_sets: config.auto_post_max_daily_sets ?? 10,
    auto_post_max_daily_budget_cents: config.auto_post_max_daily_budget_cents ?? 5000,
    auto_post_require_min_score: config.auto_post_require_min_score ?? 0,
    auto_post_pause_on_error: config.auto_post_pause_on_error !== false,
    auto_post_error_threshold: config.auto_post_error_threshold ?? 3,
  };

  const update = (field, value) => setConfig(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateConductorConfig(projectId, {
        auto_post_enabled: config.auto_post_enabled ?? false,
        auto_post_max_daily_sets: config.auto_post_max_daily_sets ?? 10,
        auto_post_max_daily_budget_cents: config.auto_post_max_daily_budget_cents ?? 5000,
        auto_post_require_min_score: config.auto_post_require_min_score ?? 0,
        auto_post_pause_on_error: config.auto_post_pause_on_error !== false,
        auto_post_error_threshold: config.auto_post_error_threshold ?? 3,
      });
      toast.success('Auto-post settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const todayCount = config.auto_post_today_count ?? 0;
  const consecutiveErrors = config.auto_post_consecutive_errors ?? 0;
  const pausedReason = config.auto_post_paused_reason;
  const lastPosted = config.auto_post_last_posted_at ? new Date(config.auto_post_last_posted_at).toLocaleString() : 'Never';

  return (
    <div className="mt-6 pt-6 border-t border-ed-line">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-6 h-6 rounded-lg bg-ed-accent/10 flex items-center justify-center">
          <svg className="w-3.5 h-3.5 text-ed-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight">Auto-Posting to Meta</h2>
        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
          form.auto_post_enabled ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-bg text-ed-ink2'
        }`}>
          {form.auto_post_enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p className="text-[12px] text-ed-ink2 mb-4">
        When enabled, ad sets that pass the Creative Filter are automatically posted to Meta as ACTIVE ads. Safety gates prevent runaway spend.
      </p>

      {pausedReason && (
        <div className="rounded-xl bg-ed-rust/5 border border-ed-rust/15 p-3 mb-4">
          <p className="text-[11px] font-semibold text-ed-rust mb-0.5">Auto-post paused</p>
          <p className="text-[10px] text-ed-ink2">{pausedReason}</p>
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-ed-ink">Enable Auto-Post</p>
            <p className="text-[11px] text-ed-ink3">Automatically post approved ad sets to Meta as ACTIVE.</p>
          </div>
          <button
            onClick={() => {
              update('auto_post_enabled', !config.auto_post_enabled);
              if (pausedReason) {
                update('auto_post_paused_reason', null);
                update('auto_post_consecutive_errors', 0);
              }
            }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.auto_post_enabled ? 'bg-ed-green' : 'bg-ed-line'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-ed-surface shadow transition-transform ${
              config.auto_post_enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <FieldLabel tooltip="Maximum number of ad sets auto-posted per day. Prevents runaway posting.">Max Ad Sets Per Day</FieldLabel>
            <input
              type="number" min={1} max={50}
              value={form.auto_post_max_daily_sets}
              onChange={e => update('auto_post_max_daily_sets', Number(e.target.value) || 10)}
              className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] text-[13px]"
            />
          </div>
          <div>
            <FieldLabel tooltip="Maximum cumulative daily budget (in dollars) across all auto-posted ad sets.">Max Daily Budget ($)</FieldLabel>
            <input
              type="number" min={1} step={1}
              value={Math.round((form.auto_post_max_daily_budget_cents) / 100)}
              onChange={e => update('auto_post_max_daily_budget_cents', (Number(e.target.value) || 50) * 100)}
              className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] text-[13px]"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <FieldLabel tooltip="Minimum filter score (0-10) required for auto-posting. Set to 0 to skip this gate.">Min Filter Score</FieldLabel>
            <input
              type="number" min={0} max={10} step={0.5}
              value={form.auto_post_require_min_score}
              onChange={e => update('auto_post_require_min_score', Number(e.target.value) || 0)}
              className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] text-[13px]"
            />
          </div>
          <div>
            <FieldLabel tooltip="Number of consecutive posting errors before auto-post is paused.">Error Threshold</FieldLabel>
            <input
              type="number" min={1} max={20}
              value={form.auto_post_error_threshold}
              onChange={e => update('auto_post_error_threshold', Number(e.target.value) || 3)}
              className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] text-[13px]"
            />
          </div>
        </div>

        <div className="rounded-xl bg-ed-bg border border-ed-line p-3">
          <p className="text-[11px] font-semibold text-ed-ink mb-1.5">Status</p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] text-ed-ink3">Today's Posts</p>
              <p className="text-[13px] font-mono text-ed-ink">{todayCount}</p>
            </div>
            <div>
              <p className="text-[10px] text-ed-ink3">Last Posted</p>
              <p className="text-[13px] font-mono text-ed-ink">{lastPosted}</p>
            </div>
            <div>
              <p className="text-[10px] text-ed-ink3">Consecutive Errors</p>
              <p className={`text-[13px] font-mono ${consecutiveErrors > 0 ? 'text-ed-rust' : 'text-ed-ink'}`}>{consecutiveErrors}</p>
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-black/5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[12px] px-4 py-1.5"
          >
            {saving ? 'Saving...' : 'Save Auto-Post Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CreativeFilterSettings({ projectId, project, onSave, embedded = false }) {
  const toast = useToast();
  const [campaigns, setCampaigns] = useState([]);
  const [form, setForm] = useState({
    scout_enabled: true,
    scout_default_campaign: '',
  });
  const [saving, setSaving] = useState(false);
  const [showAddCampaign, setShowAddCampaign] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState('');
  const [addingCampaign, setAddingCampaign] = useState(false);

  // Load campaigns for dropdown
  const loadCampaigns = useCallback(async () => {
    try {
      const data = await api.getCampaigns(projectId);
      setCampaigns(data.campaigns || []);
    } catch {
      // No campaigns yet — that's fine
    }
  }, [projectId]);

  // Sync form from project data
  useEffect(() => {
    if (!project) return;
    setForm({
      scout_enabled: project.scout_enabled !== false, // default true
      scout_default_campaign: project.scout_default_campaign || project.default_campaign_id || '',
    });
  }, [project]);

  // Load campaigns on mount
  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const automationCampaignId = form.scout_default_campaign || '';
      const updates = {
        ...(!embedded ? { scout_enabled: form.scout_enabled } : {}),
        scout_default_campaign: automationCampaignId,
        default_campaign_id: automationCampaignId,
      };
      await api.updateProject(projectId, updates);
      if (onSave) await onSave();
      toast.success('Creative Filter settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={embedded ? '' : 'ed-card p-6'}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-ed-accent/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-ed-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </div>
          <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight">Creative Filter QA & Ready-to-Post Defaults</h2>
          {!embedded && (
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              project?.scout_enabled !== false ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-bg text-ed-ink2'
            }`}>
              {project?.scout_enabled !== false ? 'Enabled' : 'Disabled'}
            </span>
          )}
        </div>
      </div>
      <p className="text-[12px] text-ed-ink2 mb-4">
        The Creative Director generates ad variations for an angle. The Creative Filter QA-scores them, keeps approved ads, rejects failed ads, and builds Ready-to-Post ad sets once the approved-ad target is reached.
      </p>

      <div className="space-y-4">
        {/* Enable/Disable toggle */}
        {!embedded && (
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-ed-ink">Enable Creative Filter</p>
            <p className="text-[11px] text-ed-ink3">Score completed generation batches and build Ready-to-Post ad sets.</p>
          </div>
          <button
            onClick={() => setForm(p => ({ ...p, scout_enabled: !p.scout_enabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              form.scout_enabled ? 'bg-ed-green' : 'bg-ed-line'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-ed-surface shadow transition-transform ${
              form.scout_enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
        )}

        <div className="rounded-xl bg-ed-green/5 border border-ed-green/15 p-3">
          <p className="text-[11px] font-semibold text-ed-ink mb-1">How QA completion works</p>
          <p className="text-[10px] leading-relaxed text-ed-ink2">
            Ads Per Ad Set is the approved-ad target. If some generated ads fail QA, approved ads stay attached to the same ad-set slot and the Director runs top-up batches until the target is reached or the retry limit is hit.
          </p>
        </div>

        {/* Automation Campaign */}
        <div>
          <FieldLabel tooltip="This is the campaign in your connected Meta ad account where Creative Director and Creative Filter ad sets will be prepared. It does not post ads by itself.">Meta Campaign for Automated Ad Sets</FieldLabel>
          {campaigns.length > 0 ? (
            <div className="flex items-center gap-2">
              <select
                value={form.scout_default_campaign}
                onChange={e => setForm(p => ({ ...p, scout_default_campaign: e.target.value }))}
                className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] text-[13px] flex-1"
              >
                <option value="">Select a campaign...</option>
                {campaigns.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowAddCampaign(true)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-ed-accent bg-ed-accent/10 hover:bg-ed-accent/15 transition-colors flex-shrink-0"
              >+ Add</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-[11px] text-ed-ink3 flex-1">No campaigns found.</p>
              <button
                onClick={() => setShowAddCampaign(true)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-ed-accent bg-ed-accent/10 hover:bg-ed-accent/15 transition-colors flex-shrink-0"
              >+ Create Campaign</button>
            </div>
          )}
          {showAddCampaign && (
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={newCampaignName}
                onChange={e => setNewCampaignName(e.target.value)}
                placeholder="Campaign name..."
                className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] flex-1 text-[13px]"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && newCampaignName.trim()) {
                    (async () => {
                      setAddingCampaign(true);
                      try {
                        const res = await api.createCampaign(projectId, newCampaignName.trim());
                        await loadCampaigns();
                        if (res?.id) setForm(p => ({ ...p, scout_default_campaign: res.id }));
                        setNewCampaignName('');
                        setShowAddCampaign(false);
                      } catch { toast.error('Failed to create campaign'); }
                      finally { setAddingCampaign(false); }
                    })();
                  }
                  if (e.key === 'Escape') { setShowAddCampaign(false); setNewCampaignName(''); }
                }}
              />
              <button
                disabled={addingCampaign || !newCampaignName.trim()}
                onClick={async () => {
                  if (!newCampaignName.trim()) return;
                  setAddingCampaign(true);
                  try {
                    const res = await api.createCampaign(projectId, newCampaignName.trim());
                    await loadCampaigns();
                    if (res?.id) setForm(p => ({ ...p, scout_default_campaign: res.id }));
                    setNewCampaignName('');
                    setShowAddCampaign(false);
                  } catch { toast.error('Failed to create campaign'); }
                  finally { setAddingCampaign(false); }
                }}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50 flex-shrink-0"
              >{addingCampaign ? '...' : 'Create'}</button>
              <button
                onClick={() => { setShowAddCampaign(false); setNewCampaignName(''); }}
                className="px-2 py-1.5 rounded-lg text-[11px] text-ed-ink2 hover:bg-black/5 transition-colors flex-shrink-0"
              >Cancel</button>
            </div>
          )}
          <p className="text-[10px] text-ed-ink3 mt-1.5">Creative Director and Creative Filter prepare Ready-to-Post ad sets under this Meta campaign by default.</p>
        </div>

        {/* Save button */}
        <div className="pt-2 border-t border-black/5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[12px] px-4 py-1.5"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      <AutoPostSettings projectId={projectId} />
    </div>
  );
}

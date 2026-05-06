import { useState, useEffect } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import InfoTooltip from './InfoTooltip';

// Per-project Creative Director deployment settings.
// Fields:
//   - ad_sets_per_cycle: integer, Director cycle config (legacy fallback: config.ads_per_batch)
//   - ads_per_ad_set: integer (1-20 hard cap), Director cycle config
//   - default_campaign_id: campaigns.externalId, default Meta campaign for new ad sets
//   - adset_default_template: JSON, Meta defaults applied to every new ad set
export default function CreativeDirectorSettings({ project, onSaved, embedded = false }) {
  const toast = useToast();
  const [adSetsPerCycle, setAdSetsPerCycle] = useState('');
  const [adsPerAdSet, setAdsPerAdSet] = useState('');
  const [defaultCampaignId, setDefaultCampaignId] = useState('');
  const [adsetTemplate, setAdsetTemplate] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const showProductionShape = !embedded;
  const showDefaultCampaign = !embedded;

  // Learning and angle-expansion settings.
  const [healthBias, setHealthBias] = useState(false);
  const [derivationEnabled, setDerivationEnabled] = useState(true);
  const [derivationMode, setDerivationMode] = useState('auto');

  useEffect(() => {
    if (!project) return;
    setAdSetsPerCycle(project.ad_sets_per_cycle != null ? String(project.ad_sets_per_cycle) : '');
    setAdsPerAdSet(project.ads_per_ad_set != null ? String(project.ads_per_ad_set) : '');
    setDefaultCampaignId(project.default_campaign_id || '');
    setAdsetTemplate(project.adset_default_template || '');
    setError('');
  }, [project]);

  // Load campaigns for the default-campaign picker + learning config.
  useEffect(() => {
    if (!project?.id) return;
    (async () => {
      try {
        const list = await api.getCampaigns?.(project.id);
        setCampaigns(Array.isArray(list?.campaigns) ? list.campaigns : Array.isArray(list) ? list : []);
      } catch { setCampaigns([]); }
      // Load conductor_config learning fields.
      try {
        const cfg = await api.getConductorConfig?.(project.id);
        if (cfg) {
          setHealthBias(cfg.health_bias === true);
          setDerivationEnabled(cfg.sub_angle_derivation_enabled !== false);
          setDerivationMode(cfg.sub_angle_derivation_mode || 'auto');
        }
      } catch { /* OK if endpoint not present */ }
    })();
  }, [project?.id]);

  const handleSave = async () => {
    setError('');
    // Validate ads_per_ad_set hard cap.
    const aps = adsPerAdSet ? Number(adsPerAdSet) : null;
    if (showProductionShape && aps != null && (!Number.isInteger(aps) || aps < 1 || aps > 20)) {
      setError('Ads per ad set must be an integer between 1 and 20');
      return;
    }
    const asc = adSetsPerCycle ? Number(adSetsPerCycle) : null;
    if (showProductionShape && asc != null && (!Number.isInteger(asc) || asc < 1)) {
      setError('Ad sets per cycle must be a positive integer');
      return;
    }
    if (adsetTemplate && adsetTemplate.trim()) {
      try { JSON.parse(adsetTemplate); }
      catch (e) { setError(`Ad-set template JSON invalid: ${e.message}`); return; }
    }

    setSaving(true);
    try {
      const fields = {};
      if (showProductionShape && asc != null) fields.ad_sets_per_cycle = asc;
      if (showProductionShape && aps != null) fields.ads_per_ad_set = aps;
      if (showDefaultCampaign && defaultCampaignId) fields.default_campaign_id = defaultCampaignId;
      if (adsetTemplate?.trim()) fields.adset_default_template = adsetTemplate.trim();
      if (Object.keys(fields).length > 0) {
        await api.updateProject(project.id, fields);
      }
      // Save learning fields (best-effort if endpoint exists).
      try {
        await api.updateConductorConfig?.(project.id, {
          health_bias: healthBias,
          sub_angle_derivation_enabled: derivationEnabled,
          sub_angle_derivation_mode: derivationMode,
        });
      } catch { /* OK */ }
      toast.success('Creative Director settings saved');
      onSaved?.();
    } catch (err) {
      setError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={embedded ? 'space-y-5' : 'ed-card p-6 space-y-5'}>
      {!embedded && (
        <div>
          <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight">Creative Director Deployment Settings</h2>
          <p className="text-xs text-ed-ink2 mt-1">Advanced defaults for automated ad sets and angle learning.</p>
        </div>
      )}

      {showProductionShape && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Ad set target" hint="How many ad sets the Director generates each run.">
            <input
              type="number" min="1"
              value={adSetsPerCycle}
              onChange={(e) => setAdSetsPerCycle(e.target.value)}
              placeholder="default 5"
              className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
            />
          </Field>
          <Field label="Ads per ad set" hint="1-20. Default is 5.">
            <input
              type="number" min="1" max="20"
              value={adsPerAdSet}
              onChange={(e) => setAdsPerAdSet(e.target.value)}
              placeholder="default 5"
              className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
            />
          </Field>
        </div>
      )}

      {showDefaultCampaign && (
        <Field
          label="Meta Campaign for Automated Ad Sets"
          hint="This is the campaign in your connected Meta ad account where Creative Director/Creative Filter ad sets will be prepared. It does not post ads by itself."
        >
          <select
            value={defaultCampaignId}
            onChange={(e) => setDefaultCampaignId(e.target.value)}
            className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
          >
            <option value="">None - auto-create [Default] on first generation run</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="Advanced Meta defaults"
        hint="Optional. Leave blank unless you want every automated ad set to start with the same Meta budget, targeting, schedule, or optimization settings."
        tooltip="This expects Meta settings in JSON format. Beginners can leave it blank and set campaign/ad-set details later in the Ad Pipeline."
      >
        <textarea
          rows={6}
          value={adsetTemplate}
          onChange={(e) => setAdsetTemplate(e.target.value)}
          placeholder={`{\n  "budget_type": "daily",\n  "budget_amount_cents": 5000,\n  "targeting": { "age_min": 25, "age_max": 65, "geo_locations": { "countries": ["US"] } },\n  "optimization_goal": "CONVERSIONS",\n  "billing_event": "IMPRESSIONS"\n}`}
          className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] font-mono text-xs"
        />
      </Field>

      <div className="border-t border-cream pt-4 space-y-3">
        <h3 className="text-[13px] font-serif font-[420] text-ed-ink">Learning & Angle Expansion</h3>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={healthBias}
            onChange={(e) => setHealthBias(e.target.checked)}
            className="w-5 h-5 mt-0.5"
          />
          <div>
            <div className="text-[13px] font-serif font-[420] text-ed-ink">Favor proven angles</div>
            <div className="text-[11px] text-ed-ink2">When on, angles with better observation results are selected more often. New angle variations still get a short exploration boost so they can be tested fairly.</div>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={derivationEnabled}
            onChange={(e) => setDerivationEnabled(e.target.checked)}
            className="w-5 h-5 mt-0.5"
          />
          <div>
            <div className="text-[13px] font-serif font-[420] text-ed-ink">Create new angle variations from winners</div>
            <div className="text-[11px] text-ed-ink2">When an angle gets enough passing observation results, the system can propose related angle variations that preserve the same brand direction.</div>
          </div>
        </label>

        {derivationEnabled && (
          <div className="ml-8">
            <div className="text-[11px] font-medium text-ed-ink2 mb-1">Angle variation approval</div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={derivationMode === 'auto'} onChange={() => setDerivationMode('auto')} />
                <span className="text-[12px] text-ed-ink">Auto — new angle variations activate immediately</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={derivationMode === 'review'} onChange={() => setDerivationMode('review')} />
                <span className="text-[12px] text-ed-ink">Review — new angle variations wait for approval before activation</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {error && <div className="text-sm text-ed-rust">{error}</div>}

      <div className="flex justify-end">
        <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, tooltip, children }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-ed-ink2 flex items-center gap-1">
        {label}
        {tooltip && <InfoTooltip text={tooltip} position="right" />}
      </span>
      {hint && <span className="text-[11px] text-ed-ink3 block mb-1">{hint}</span>}
      {children}
    </label>
  );
}

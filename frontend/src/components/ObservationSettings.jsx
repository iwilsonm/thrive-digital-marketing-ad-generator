// Phase 3 — Observation settings sub-tab in Project Settings.
// Composite benchmark: min_spend gate + ROAS|CPA primary + optional CTR floor.

import { useState, useEffect } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import InfoTooltip from './InfoTooltip';

export default function ObservationSettings({ projectId }) {
  const toast = useToast();
  const [config, setConfig] = useState(null);
  const [currency, setCurrency] = useState('USD');
  const [version, setVersion] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [observingCount, setObservingCount] = useState(0);
  const [form, setForm] = useState({});

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      setLoading(true);
      try {
        const [{ benchmark, account_currency, version }, health] = await Promise.all([
          api.getObservationConfig(projectId),
          api.getObservationHealth(projectId).catch(() => ({ counts: { observing: 0 } })),
        ]);
        setConfig(benchmark);
        setCurrency(account_currency);
        setVersion(version);
        setObservingCount(health?.counts?.observing || 0);
        setForm({
          observation_enabled: benchmark.enabled !== false,
          observation_window_days: benchmark.window_days,
          benchmark_min_spend: benchmark.min_spend,
          benchmark_primary_gate: benchmark.primary_gate,
          benchmark_roas_min: benchmark.roas_min,
          benchmark_cpa_max: benchmark.cpa_max,
          benchmark_ctr_min: benchmark.ctr_min,
          benchmark_action_type: benchmark.action_type,
          archive_min_sample: benchmark.min_sample,
          archive_min_unique_posting_days: benchmark.min_unique_posting_days,
        });
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId]);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await api.updateObservationConfig(projectId, form);
      setVersion(result.version);
      toast.success('Saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSuggest = async () => {
    setSaving(true);
    try {
      const { suggestion, based_on } = await api.suggestObservationDefaults(projectId);
      if (!confirm(
        `Suggested defaults from your last 90 days:\n\n` +
        `  Min spend: ${suggestion.min_spend} ${currency}\n` +
        `  ROAS minimum: ${suggestion.roas_min}\n\n` +
        `Based on ${based_on?.daily_avg_spend?.toFixed(2) || '—'} ${currency}/day average spend, ` +
        `${based_on?.last_90d_median_roas?.toFixed(2) || '—'} median ROAS.\n\n` +
        `Apply?`
      )) return;
      setForm((p) => ({
        ...p,
        benchmark_min_spend: suggestion.min_spend,
        benchmark_roas_min: suggestion.roas_min,
      }));
      toast.success('Defaults loaded — click Save to apply');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-[12px] text-ed-ink3">Loading observation settings…</div>;
  }

  return (
    <div className="space-y-5">
      <div className="ed-card p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-[14px] font-serif font-[420] text-ed-ink">Observation & Benchmark</h3>
            <p className="text-[11px] text-ed-ink3 mt-0.5">
              Posted ad sets are watched for the window below. At the end, the benchmark decides whether the angle should keep running, needs more data, or should be archived.
            </p>
            <p className="text-[10px] text-ed-ink3 mt-1">
              Account currency: <strong>{currency}</strong> · Benchmark version: v{version}
            </p>
          </div>
          <button onClick={handleSuggest} disabled={saving} className="ed-ghost text-[11px]">
            Auto-suggest from 90d
          </button>
        </div>

        {observingCount > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-ed-accent/5 border border-ed-accent/30 text-[11px] text-ed-ink">
            <strong>{observingCount} ad set{observingCount === 1 ? '' : 's'} currently observing.</strong> Changes you save will apply to their next evaluation.
          </div>
        )}

        <div className="space-y-4">
          <Toggle
            label="Observation enabled"
            tooltip="When off, no daily snapshots or terminal evaluations run for this project."
            value={form.observation_enabled}
            onChange={(v) => set('observation_enabled', v)}
          />

          <Field
            label="Observation window (days)"
            tooltip="How many days an ad set should collect Meta performance data before the system decides whether it passed or failed. Default is 12."
            type="number" min={1} max={60}
            value={form.observation_window_days}
            onChange={(v) => set('observation_window_days', parseInt(v, 10) || 12)}
          />

          <hr className="border-ed-line" />

          <h4 className="text-[12px] font-semibold text-ed-ink2 uppercase tracking-wider">Benchmark rules</h4>

          <Field
            label={`Minimum spend before judging (${currency})`}
            tooltip="The ad set must spend at least this much before the system trusts the result. Very low spend means Meta did not give it enough delivery, so the result is treated separately from a true performance failure."
            type="number" step="0.01" min={0}
            value={form.benchmark_min_spend}
            onChange={(v) => set('benchmark_min_spend', parseFloat(v) || 0)}
          />

          <SegmentedControl
            label="Main success metric"
            value={form.benchmark_primary_gate}
            options={[
              { id: 'roas', label: 'ROAS (return on ad spend)' },
              { id: 'cpa', label: 'CPA (cost per action)' },
            ]}
            onChange={(v) => set('benchmark_primary_gate', v)}
          />

          {form.benchmark_primary_gate === 'roas' ? (
            <Field
              label="Minimum ROAS"
              tooltip="Return on ad spend. Example: 1.5 means the ad set must return at least $1.50 for every $1.00 spent."
              type="number" step="0.1" min={0}
              value={form.benchmark_roas_min}
              onChange={(v) => set('benchmark_roas_min', parseFloat(v) || 0)}
            />
          ) : (
            <Field
              label={`Maximum CPA (${currency})`}
              tooltip="Cost per action. The ad set passes only if the chosen action costs this amount or less."
              type="number" step="0.01" min={0}
              value={form.benchmark_cpa_max}
              onChange={(v) => set('benchmark_cpa_max', parseFloat(v) || 0)}
            />
          )}

          <Field
            label="Optional CTR minimum"
            tooltip="Click-through-rate guardrail. Enter 0.01 for 1%, or leave blank if CTR should not affect the verdict."
            type="text"
            placeholder="e.g. 0.01 or leave blank"
            value={form.benchmark_ctr_min === '' || form.benchmark_ctr_min == null ? '' : String(form.benchmark_ctr_min)}
            onChange={(v) => set('benchmark_ctr_min', v === '' ? '' : v)}
          />

          <Field
            label="Meta event used for ROAS or CPA"
            tooltip="The Meta Pixel event the system should evaluate. Stores usually use purchase; lead-gen usually uses lead. It must match the event tracked in Meta."
            type="text"
            value={form.benchmark_action_type}
            onChange={(v) => set('benchmark_action_type', v)}
          />

          <hr className="border-ed-line" />

          <h4 className="text-[12px] font-semibold text-ed-ink2 uppercase tracking-wider">Angle archiving</h4>

          <Field
            label="Ad sets tested before archiving can happen"
            tooltip="The system will not archive an angle until this many ad sets have completed observation. This prevents one unlucky test from shutting down an angle."
            type="number" min={1} max={100}
            value={form.archive_min_sample}
            onChange={(v) => set('archive_min_sample', parseInt(v, 10) || 5)}
          />

          <Field
            label="Different posting days required"
            tooltip="Failed ad sets must span at least this many different calendar days before the angle can be archived. This protects against judging everything from one bad posting day."
            type="number" min={1} max={30}
            value={form.archive_min_unique_posting_days}
            onChange={(v) => set('archive_min_unique_posting_days', parseInt(v, 10) || 1)}
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[12px]">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, tooltip, type = 'text', value, onChange, ...rest }) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-ed-ink2 mb-1">
        {label}
        {tooltip && <InfoTooltip text={tooltip} position="right" />}
      </label>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] text-[13px]"
        {...rest}
      />
    </div>
  );
}

function Toggle({ label, tooltip, value, onChange }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4" />
      <span className="text-[12px] text-ed-ink">{label}</span>
      {tooltip && <InfoTooltip text={tooltip} position="right" />}
    </label>
  );
}

function SegmentedControl({ label, value, options, onChange }) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-ed-ink2 mb-1">{label}</label>
      <div className="segmented-control">
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={value === opt.id ? 'active' : ''}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Phase 3 — Drawer showing snapshots, sparkline, manual actions for one ad set.
// Phase 6.20a — extended with SubAnglesSection (Phase 4) when ad_set has
// passed verdict + an angle_id. Surfaces sub-angles derived from this ad_set's
// parent angle so Marco can see Phase 4 sub-angle derivation in context.

import { useState, useEffect } from 'react';
import { api } from '../../api';
import { useToast } from '../Toast';
import SubAnglesSection from '../conductor/SubAnglesSection';

export default function AdSetTimeline({ projectId, adSetId, open, onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Phase 6.20a — parent angle resolution for SubAnglesSection
  const [parentAngle, setParentAngle] = useState(null);

  useEffect(() => {
    if (!open || !adSetId) return;
    (async () => {
      setLoading(true);
      setParentAngle(null);
      try {
        const payload = await api.getObservationAdSet(projectId, adSetId);
        setData(payload);
        // If passed + has angle_id, resolve the parent angle for SubAnglesSection
        const adSet = payload?.ad_set;
        if (adSet?.lifecycle_status === 'passed' && adSet.angle_id) {
          try {
            const result = await api.getConductorAngles(projectId);
            const angles = Array.isArray(result) ? result : (result?.angles || []);
            const parent = angles.find((a) => a.externalId === adSet.angle_id);
            if (parent) setParentAngle(parent);
          } catch { /* SubAnglesSection just won't render */ }
        }
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, adSetId, projectId]);

  if (!open) return null;

  const adSet = data?.ad_set;
  const snapshots = data?.snapshots || [];
  const result = (data?.results || [])[0];
  const benchmark = data?.benchmark;
  const currency = adSet?.account_currency || 'USD';

  const handleAction = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      toast.success(successMsg);
      const fresh = await api.getObservationAdSet(projectId, adSetId);
      setData(fresh);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div
        className="bg-ed-surface w-full max-w-6xl h-[92vh] sm:h-[85vh] rounded-xl shadow-card overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-ed-surface border-b border-ed-line px-5 py-3 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-ed-ink truncate">
              {adSet?.name || 'Loading…'}
              {adSet?.is_demo && (
                <span className="ml-2 inline-flex px-1.5 py-0.5 rounded bg-ed-bg text-[9px] font-medium text-ed-ink2 align-middle">
                  Demo
                </span>
              )}
            </h3>
            {result && (
              <p className="text-[11px] text-ed-ink3 truncate">{result.reason}</p>
            )}
          </div>
          <button onClick={onClose} className="text-ed-ink2 hover:text-ed-ink text-[18px] leading-none ml-3">×</button>
        </div>

        {loading && <div className="p-5 text-[12px] text-ed-ink3">Loading…</div>}

        {!loading && data && (
          <div className="p-5 space-y-5 overflow-y-auto">
            <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-5">
              <div className="space-y-5">
                <BenchmarkSummary adSet={adSet} result={result} benchmark={benchmark} currency={currency} />
                <Sparkline snapshots={snapshots} currency={currency} />
                <Snapshots snapshots={snapshots} currency={currency} />
              </div>
              <div className="space-y-5">
                <AdSetSummary adSet={adSet} />
                <ChildrenSection children={adSet?.children || []} />
              </div>
            </div>

            <div className="border-t border-ed-line pt-4 space-y-2">
              <h4 className="text-[12px] font-semibold text-ed-ink">Actions</h4>
              {(adSet.lifecycle_status === 'observing') && (
                <>
                  <div className="flex gap-2 flex-wrap">
                    {adSet.is_paused ? (
                      <button
                        disabled={busy}
                        onClick={() => handleAction(() => api.resumeObservation(projectId, adSetId), 'Observation resumed')}
                        className="ed-ghost text-[11px]"
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => handleAction(() => api.pauseObservation(projectId, adSetId), 'Observation paused')}
                        className="ed-ghost text-[11px]"
                      >
                        Pause
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => {
                        const n = parseInt(prompt('Extend by how many additional days?', '12'), 10);
                        if (n > 0) handleAction(() => api.extendObservation(projectId, adSetId, n), `Extended by ${n} days`);
                      }}
                      className="ed-ghost text-[11px]"
                    >
                      Extend window
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => handleAction(() => api.refreshObservationSnapshot(projectId, adSetId), 'Snapshot refreshed')}
                      className="ed-ghost text-[11px]"
                    >
                      Refresh snapshot
                    </button>
                  </div>
                  <div className="flex gap-2 flex-wrap pt-2">
                    <ManualMarkButton
                      kind="passed"
                      onMark={(reason) => handleAction(() => api.markObservation(projectId, adSetId, { verdict: 'manual_passed', reason }), 'Marked passed')}
                    />
                    <ManualMarkButton
                      kind="failed"
                      angleId={adSet.angle_id}
                      onMark={(reason) => handleAction(() => api.markObservation(projectId, adSetId, { verdict: 'manual_failed', reason }), 'Marked failed')}
                    />
                  </div>
                </>
              )}
              {(adSet.lifecycle_status !== 'observing') && (
                <p className="text-[11px] text-ed-ink3">
                  This ad set has reached a terminal verdict. Re-extend to resume observation.
                </p>
              )}
            </div>

            {/* Phase 6.20a — SubAnglesSection (Phase 4). Only renders for
                passed verdicts with a parent angle resolved. Shows derived
                sub-angles from this ad set's parent angle. */}
            {parentAngle && adSet.lifecycle_status === 'passed' && (
              <div className="border-t border-ed-accent/30 pt-4 overflow-y-auto max-h-96">
                <h4 className="text-[12px] font-semibold text-ed-ink mb-2">
                  Sub-angles derived from this ad set's angle
                </h4>
                <SubAnglesSection
                  projectId={projectId}
                  parentAngle={parentAngle}
                  onChanged={onChanged}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AdSetSummary({ adSet }) {
  if (!adSet) return null;
  return (
    <div className="card p-4 bg-ed-bg/40">
      <div className="text-[11px] font-semibold text-ed-ink2 uppercase tracking-wider mb-2">Summary</div>
      <div className="space-y-2 text-[12px]">
        <SummaryRow label="Campaign" value={adSet.campaign_name} />
        <SummaryRow label="Angle" value={adSet.angle_name} />
        <SummaryRow label="Lifecycle" value={adSet.lifecycle_status} />
        <SummaryRow label="Posted" value={adSet.posted_at ? adSet.posted_at.slice(0, 10) : ''} />
        <SummaryRow label="Ads" value={String(adSet.child_count ?? adSet.children?.length ?? 0)} />
      </div>
    </div>
  );
}

function SummaryRow({ label, value }) {
  return (
    <div className="grid grid-cols-[90px_1fr] gap-3">
      <span className="text-ed-ink3">{label}</span>
      <span className="text-ed-ink break-words">{value || '—'}</span>
    </div>
  );
}

function ChildrenSection({ children }) {
  return (
    <div className="card p-4 bg-ed-bg/40">
      <div className="text-[11px] font-semibold text-ed-ink2 uppercase tracking-wider mb-2">Ads</div>
      {children.length === 0 ? (
        <div className="text-[11px] text-ed-ink3">No child ads are attached to this ad set.</div>
      ) : (
        <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
          {children.map((child) => (
            <div key={child.externalId} className="flex gap-3 p-2 rounded-lg bg-ed-surface border border-ed-line">
              {child.thumbnail_url ? (
                <img src={child.thumbnail_url} alt="" className="w-14 h-14 rounded-lg object-cover bg-ed-bg flex-shrink-0" loading="lazy" />
              ) : (
                <div className="w-14 h-14 rounded-lg bg-ed-bg flex items-center justify-center text-ed-ink3 flex-shrink-0">—</div>
              )}
              <div className="min-w-0 flex-1 text-[11px]">
                <div className="font-medium text-ed-ink truncate">{child.name || child.headline || 'Untitled ad'}</div>
                <div className="text-ed-ink3 truncate">{child.angle_name || child.status || ''}</div>
                <div className="text-ed-ink2 mt-1 max-h-9 overflow-hidden">{child.body_copy || child.headline || 'No copy'}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BenchmarkSummary({ adSet, result, benchmark, currency }) {
  if (!benchmark) return null;
  const fmtMoney = (v) => currency === 'USD' ? `$${(v || 0).toFixed(2)}` : `${Math.round(v || 0).toLocaleString()} ${currency}`;
  const fmtNum = (v) => (v || 0).toLocaleString();
  const fmtPct = (v) => `${(v || 0).toFixed(2)}%`;
  const m = result || adSet;

  return (
    <div className="card p-4 bg-ed-bg/40">
      <div className="text-[11px] font-semibold text-ed-ink2 uppercase tracking-wider mb-2">
        Benchmark — {benchmark.primary_gate.toUpperCase()} ≥ {benchmark.primary_gate === 'roas' ? benchmark.roas_min : fmtMoney(benchmark.cpa_max)}, min {fmtMoney(benchmark.min_spend)} spend
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Metric label="Spend" value={fmtMoney(m.spend || 0)} />
        <Metric label="Impressions" value={fmtNum(m.impressions || 0)} />
        <Metric label="Clicks" value={fmtNum(m.clicks || 0)} />
        <Metric label="CTR" value={fmtPct(m.ctr || 0)} />
        <Metric label="ROAS" value={(m.roas || 0).toFixed(2)} />
        <Metric label="Conversions" value={fmtNum(m.conversions || 0)} />
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-[10px] text-ed-ink3">{label}</div>
      <div className="text-[14px] font-semibold text-ed-ink tabular-nums">{value}</div>
    </div>
  );
}

function Sparkline({ snapshots, currency }) {
  if (!snapshots || snapshots.length === 0) return null;
  const w = 460, h = 80, pad = 8;
  const data = snapshots.map((s) => s.spend || 0);
  const max = Math.max(...data, 0.01);
  const points = data.map((v, i) => {
    const x = pad + (i / Math.max(1, data.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div>
      <div className="text-[11px] font-semibold text-ed-ink2 uppercase tracking-wider mb-1">Daily spend</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-20 bg-ed-surface rounded border border-ed-line">
        <polyline points={points} fill="none" stroke="#62B462" strokeWidth="1.5" />
        {data.map((v, i) => {
          const x = pad + (i / Math.max(1, data.length - 1)) * (w - pad * 2);
          const y = h - pad - (v / max) * (h - pad * 2);
          return <circle key={i} cx={x} cy={y} r="2" fill="#62B462" />;
        })}
      </svg>
    </div>
  );
}

function Snapshots({ snapshots, currency }) {
  if (!snapshots || snapshots.length === 0) {
    return <div className="text-[11px] text-ed-ink3">No daily snapshots yet.</div>;
  }
  const fmtMoney = (v) => currency === 'USD' ? `$${(v || 0).toFixed(2)}` : `${Math.round(v || 0).toLocaleString()} ${currency}`;
  return (
    <div>
      <div className="text-[11px] font-semibold text-ed-ink2 uppercase tracking-wider mb-1">Day-by-day</div>
      <div className="text-[11px] divide-y divide-gray-100">
        {snapshots.map((s) => (
          <div key={s.day_index} className="flex items-center gap-3 py-1">
            <span className="text-ed-ink3 w-12">Day {s.day_index}</span>
            <span className="text-ed-ink tabular-nums w-20">{fmtMoney(s.spend)}</span>
            <span className="text-ed-ink2 tabular-nums w-16">{s.clicks || 0} clicks</span>
            {s.roas != null && <span className="text-ed-ink2 tabular-nums">ROAS {s.roas.toFixed(2)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ManualMarkButton({ kind, angleId, onMark }) {
  const cls = kind === 'passed'
    ? 'ed-ghost text-[11px] text-ed-green border-ed-green/30 hover:border-ed-green'
    : 'ed-ghost text-[11px] text-red-500 border-red-200 hover:border-red-400';
  const label = kind === 'passed' ? 'Mark Passed' : 'Mark Failed';
  return (
    <button
      onClick={() => {
        const consequence = kind === 'failed' && angleId
          ? '\n\nThis may contribute to angle archive if the angle hits its failure threshold.'
          : '';
        const reason = prompt(`${label} — reason (optional):${consequence}`, '');
        if (reason !== null) onMark(reason);
      }}
      className={cls}
    >
      {label}
    </button>
  );
}

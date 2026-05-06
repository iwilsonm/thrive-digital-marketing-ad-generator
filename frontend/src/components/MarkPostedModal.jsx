// Phase 6.20 — Manual Mark as Posted with backdate picker.
// Used in ReadyToPostView when the user posts to Meta in Ads Manager
// outside Dacia Automation's automatic posting path and wants to log the
// post date so Phase 3
// observation cycle starts ticking from the correct day.
//
// Constraints (per Phase 6.10 PEF + Phase 6.20 fortifications):
// - Backdate cap: 30 days
// - Warning at >14 days (stale-conditions warning, mirrors Phase 3 pause copy)
// - Hint at >12 days: cron will evaluate immediately on next tick

import { useState } from 'react';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BACKDATE_DAYS = 30;
const WARN_BACKDATE_DAYS = 14;
const CRON_HINT_DAYS = 12;

function daysAgoIso(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function minDateForCustom() {
  return new Date(Date.now() - MAX_BACKDATE_DAYS * DAY_MS).toISOString().slice(0, 10);
}

export default function MarkPostedModal({ open, count, onClose, onConfirm }) {
  // Mode: 'today' | '1d' | '2d' | 'custom'
  const [mode, setMode] = useState('today');
  const [customDate, setCustomDate] = useState(todayDateOnly());
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const resolvePostedAt = () => {
    if (mode === 'today') return new Date().toISOString();
    if (mode === '1d') return daysAgoIso(1);
    if (mode === '2d') return daysAgoIso(2);
    // custom — convert YYYY-MM-DD to ISO at noon UTC to avoid timezone edge cases
    return new Date(`${customDate}T12:00:00.000Z`).toISOString();
  };

  const computeDaysAgo = () => {
    const ts = new Date(resolvePostedAt()).getTime();
    return Math.floor((Date.now() - ts) / DAY_MS);
  };

  const daysAgo = computeDaysAgo();
  const showWarn = daysAgo > WARN_BACKDATE_DAYS;
  const showCronHint = daysAgo > CRON_HINT_DAYS;
  const overCap = daysAgo > MAX_BACKDATE_DAYS;
  const canSave = !overCap && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onConfirm(resolvePostedAt());
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={saving ? undefined : onClose} />
      <div className="relative bg-ed-surface rounded-2xl shadow-card w-[440px] max-w-full">
        <div className="px-5 py-4 border-b border-cream">
          <h2 className="text-[15px] font-semibold text-ed-ink">Mark as Posted Manually</h2>
          <p className="text-[11px] text-ed-ink2 mt-0.5">
            This only logs the post in Dacia Automation. It will not create anything in Meta. When did you post {count === 1 ? 'this ad' : `these ${count} ads`}?
          </p>
        </div>

        <div className="p-5 space-y-3">
          {[
            { id: 'today', label: 'Today (now)' },
            { id: '1d', label: '1 day ago' },
            { id: '2d', label: '2 days ago' },
            { id: 'custom', label: 'Custom date' },
          ].map((opt) => (
            <label key={opt.id} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={mode === opt.id}
                onChange={() => setMode(opt.id)}
              />
              <span className="text-[13px] text-ed-ink">{opt.label}</span>
            </label>
          ))}

          {mode === 'custom' && (
            <div className="ml-6 mt-1">
              <input
                type="date"
                value={customDate}
                min={minDateForCustom()}
                max={todayDateOnly()}
                onChange={(e) => setCustomDate(e.target.value)}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[13px] w-full"
              />
              <div className="text-[10px] text-ed-ink3 mt-1">
                Max 30 days back. Beyond this is unsupported.
              </div>
            </div>
          )}

          {showCronHint && !overCap && (
            <div className="text-[11px] bg-ed-accent/10 border border-ed-accent/30 rounded-lg p-2.5 text-ed-ink">
              <strong>Heads up:</strong> backdate is {daysAgo} days. Observation will evaluate this on the next scheduled check (1am ICT).
              Lifecycle may flip to a terminal verdict (passed / failed / etc.) by morning. Verify your benchmark settings.
            </div>
          )}
          {showWarn && !overCap && (
            <div className="text-[11px] bg-ed-rust/10 border border-ed-rust/30 rounded-lg p-2.5 text-ed-rust">
              <strong>Note:</strong> backdating &gt;{WARN_BACKDATE_DAYS} days. Results may not reflect the original test conditions
              (creative + audience may be stale).
            </div>
          )}
          {overCap && (
            <div className="text-[11px] bg-ed-rust/10 border border-ed-rust/30 rounded-lg p-2.5 text-ed-rust">
              Backdate cap is {MAX_BACKDATE_DAYS} days. Pick a more recent date.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-cream flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="ed-ghost text-[12px] px-4 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[12px] px-4 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Marking…' : 'Mark Manually'}
          </button>
        </div>
      </div>
    </div>
  );
}

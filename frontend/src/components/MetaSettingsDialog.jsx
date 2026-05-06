import { useState, useEffect } from 'react';

// Phase 1 — Staging Page: edit Meta-side settings for a single ad set.
// Targeting / budget / schedule / optimization / billing.
// Backed by /api/projects/:id/staging/adsets/:adSetId/meta-settings.
// Phase 1 stays minimal — Meta's targeting builder is not reproduced;
// targeting is a free-text JSON field. Phase 2 adds the dual integration
// path; richer targeting UI can come there.
export default function MetaSettingsDialog({ open, adSet, onClose, onSave }) {
  const [name, setName] = useState('');
  const [budgetType, setBudgetType] = useState('daily');
  const [budgetCents, setBudgetCents] = useState('');
  const [optimizationGoal, setOptimizationGoal] = useState('');
  const [billingEvent, setBillingEvent] = useState('');
  const [scheduleStart, setScheduleStart] = useState('');
  const [scheduleEnd, setScheduleEnd] = useState('');
  const [targetingJson, setTargetingJson] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!adSet) return;
    setName(adSet.name || '');
    setBudgetType(adSet.meta_budget_type || 'daily');
    setBudgetCents(adSet.meta_budget_amount_cents != null ? String(adSet.meta_budget_amount_cents) : '');
    setOptimizationGoal(adSet.meta_optimization_goal || '');
    setBillingEvent(adSet.meta_billing_event || '');
    setTargetingJson(adSet.meta_targeting || '');
    let parsedSchedule = null;
    try {
      parsedSchedule = adSet.meta_schedule ? JSON.parse(adSet.meta_schedule) : null;
    } catch { parsedSchedule = null; }
    setScheduleStart(parsedSchedule?.start_time || '');
    setScheduleEnd(parsedSchedule?.end_time || '');
    setError('');
  }, [adSet]);

  if (!open || !adSet) return null;

  const handleSave = async () => {
    setError('');
    // Validate targeting JSON if present
    if (targetingJson && targetingJson.trim()) {
      try { JSON.parse(targetingJson); }
      catch (e) { setError(`Targeting JSON invalid: ${e.message}`); return; }
    }
    const fields = {
      name: name || undefined,
      meta_budget_type: budgetType || undefined,
      meta_budget_amount_cents: budgetCents ? Number(budgetCents) : undefined,
      meta_optimization_goal: optimizationGoal || undefined,
      meta_billing_event: billingEvent || undefined,
      meta_targeting: targetingJson?.trim() || undefined,
    };
    if (scheduleStart || scheduleEnd) {
      fields.meta_schedule = JSON.stringify({
        start_time: scheduleStart || undefined,
        end_time: scheduleEnd || undefined,
      });
    }
    setSaving(true);
    try {
      await onSave?.(adSet.id, fields);
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-ed-surface rounded-2xl shadow-card-hover max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-ed-ink mb-1">Edit Meta settings</h3>
        <p className="text-xs text-ed-ink2 mb-4">Per-ad-set Meta config. Defaults inherited from the project's Ad-Set Defaults; override here.</p>

        <div className="space-y-3">
          <Field label="Ad set name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Budget type">
              <select value={budgetType} onChange={(e) => setBudgetType(e.target.value)} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full">
                <option value="daily">Daily</option>
                <option value="lifetime">Lifetime</option>
              </select>
            </Field>
            <Field label="Budget (cents)">
              <input
                type="number"
                min="0"
                value={budgetCents}
                onChange={(e) => setBudgetCents(e.target.value)}
                placeholder="e.g. 5000 = $50.00"
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Schedule start">
              <input
                type="datetime-local"
                value={scheduleStart}
                onChange={(e) => setScheduleStart(e.target.value)}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full"
              />
            </Field>
            <Field label="Schedule end (optional)">
              <input
                type="datetime-local"
                value={scheduleEnd}
                onChange={(e) => setScheduleEnd(e.target.value)}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Optimization goal">
              <input
                type="text"
                value={optimizationGoal}
                onChange={(e) => setOptimizationGoal(e.target.value)}
                placeholder="e.g. CONVERSIONS"
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full"
              />
            </Field>
            <Field label="Billing event">
              <input
                type="text"
                value={billingEvent}
                onChange={(e) => setBillingEvent(e.target.value)}
                placeholder="e.g. IMPRESSIONS"
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full"
              />
            </Field>
          </div>

          <Field label="Targeting (JSON)">
            <textarea
              value={targetingJson}
              onChange={(e) => setTargetingJson(e.target.value)}
              rows={5}
              placeholder='{"age_min":25,"age_max":65,"geo_locations":{"countries":["US"]}}'
              className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full font-mono text-xs"
            />
          </Field>
        </div>

        {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="ed-ghost">Cancel</button>
          <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-ed-ink2 block mb-1">{label}</span>
      {children}
    </label>
  );
}

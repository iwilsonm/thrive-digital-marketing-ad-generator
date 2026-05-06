// Phase 6.10 — Combine into Ad Set modal.
// Replaces the legacy "Combine into Flex Ad" button. Validates name, picks
// campaign (existing OR create-new inline), soft-locks deployments for 90s
// while the user fills in the form, calls api.createAdSetFromAds on save.

import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';

const NAME_PATTERN = /^[a-zA-Z0-9 _\-—.]+$/; // letters, digits, space, underscore, hyphen, em-dash, period
const LOCK_REFRESH_MS = 30_000; // refresh soft-lock every 30s
const LOCK_TTL_MS = 90_000;

export default function CombineIntoAdSetModal({
  open,
  projectId,
  deploymentIds,
  campaigns,
  defaultCampaignId,
  existingAdSetNames,
  onClose,
  onSuccess,
}) {
  const [name, setName] = useState('');
  const [campaignMode, setCampaignMode] = useState('existing');
  const [existingCampaignId, setExistingCampaignId] = useState('');
  const [newCampaignName, setNewCampaignName] = useState('');
  const [saving, setSaving] = useState(false);
  const [lockError, setLockError] = useState(null);
  const lockTimerRef = useRef(null);
  const savingRef = useRef(false);

  // Reset state on open + acquire soft-lock
  useEffect(() => {
    if (!open) return;
    setName('');
    setCampaignMode('existing');
    setExistingCampaignId(defaultCampaignId || '');
    setNewCampaignName('');
    setLockError(null);

    let cancelled = false;
    (async () => {
      try {
        await api.lockDeployments(projectId, deploymentIds, LOCK_TTL_MS);
        if (cancelled) return;
        // Refresh lock periodically while modal is open
        lockTimerRef.current = setInterval(() => {
          api.lockDeployments(projectId, deploymentIds, LOCK_TTL_MS).catch(() => {
            // Silently swallow refresh errors; surface only on explicit save
          });
        }, LOCK_REFRESH_MS);
      } catch {
        if (cancelled) return;
        // Soft-locks are only advisory. They prevent accidental concurrent
        // edits, but a stale lock should not show a scary Convex server error
        // or block the normal create flow.
        setLockError(null);
      }
    })();

    return () => {
      cancelled = true;
      if (lockTimerRef.current) {
        clearInterval(lockTimerRef.current);
        lockTimerRef.current = null;
      }
    };
  }, [open, projectId, deploymentIds, defaultCampaignId]);

  if (!open) return null;

  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= 80 && NAME_PATTERN.test(trimmedName);
  const nameCollides = existingAdSetNames?.has(trimmedName);
  const newCampaignTrimmed = newCampaignName.trim();
  const newCampaignValid = campaignMode === 'new'
    ? newCampaignTrimmed.length >= 1 && newCampaignTrimmed.length <= 80 && NAME_PATTERN.test(newCampaignTrimmed)
    : true;
  const campaignValid = campaignMode === 'existing' ? true : newCampaignValid;
  const canSave = nameValid && campaignValid && deploymentIds.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const body = {
        name: trimmedName,
        deployment_ids: deploymentIds,
      };
      if (campaignMode === 'new') {
        body.create_new_campaign = newCampaignTrimmed;
      } else if (existingCampaignId) {
        body.campaign_id = existingCampaignId;
      }
      const result = await api.createAdSetFromAds(projectId, body);
      setLockError(null);
      onSuccess?.(result);
      onClose?.();
    } catch (err) {
      setLockError(err.message || 'Failed to create ad set');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={saving ? undefined : onClose} />
      <div className="relative bg-ed-surface rounded-2xl shadow-card w-[480px] max-w-full">
        <div className="px-5 py-4 border-b border-cream">
          <h2 className="text-[15px] font-semibold text-ed-ink flex items-center gap-1">
            Combine into Ad Set
            <InfoTooltip text="An ad set groups selected ads under one campaign/ad-set name for Ready to Post and Meta posting." position="right" />
          </h2>
          <p className="text-[11px] text-ed-ink2 mt-0.5">
            Grouping {deploymentIds.length} ad{deploymentIds.length === 1 ? '' : 's'} into a new ad set. Choose a campaign now, or leave it blank to use this project&apos;s default campaign.
          </p>
        </div>

        <div className="p-5 space-y-4">
          {/* Ad set name */}
          <div>
            <label className="text-[12px] font-medium text-ed-ink mb-1 flex items-center gap-1">
              Ad set name <span className="text-ed-rust">*</span>
              <InfoTooltip text="Use a clear name for the group of ads, usually based on the angle or test you are running." position="right" />
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Skeptic to Believer — Test 1"
              className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[13px] w-full"
              maxLength={80}
            />
            <div className="text-[10px] mt-1 flex items-center gap-2">
              <span className={trimmedName.length > 80 ? 'text-ed-rust' : 'text-ed-ink3'}>
                {trimmedName.length}/80
              </span>
              {trimmedName && !NAME_PATTERN.test(trimmedName) && (
                <span className="text-ed-rust">Use letters, digits, spaces, hyphens, underscores only</span>
              )}
              {nameCollides && (
                <span className="text-ed-accent">⚠ Name already exists in this project</span>
              )}
            </div>
          </div>

          {/* Campaign picker */}
          <div>
            <label className="text-[12px] font-medium text-ed-ink mb-1 flex items-center gap-1">
              Campaign <span className="text-ed-ink3 font-normal">(optional)</span>
              <InfoTooltip text="Choose the campaign where this ad set belongs, create a new local campaign name, or leave blank to use the project's default campaign." position="right" />
            </label>
            <div className="flex items-center gap-3 mb-2">
              <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                <input
                  type="radio"
                  checked={campaignMode === 'existing'}
                  onChange={() => setCampaignMode('existing')}
                />
                <span className="text-ed-ink">Existing</span>
              </label>
              <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                <input
                  type="radio"
                  checked={campaignMode === 'new'}
                  onChange={() => setCampaignMode('new')}
                />
                <span className="text-ed-ink">+ Create new</span>
              </label>
            </div>
            {campaignMode === 'existing' ? (
              <select
                value={existingCampaignId}
                onChange={(e) => setExistingCampaignId(e.target.value)}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[13px] w-full"
              >
                <option value="">Use project default campaign</option>
                {(campaigns || []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={newCampaignName}
                onChange={(e) => setNewCampaignName(e.target.value)}
                placeholder="New campaign name"
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[13px] w-full"
                maxLength={80}
              />
            )}
            {campaignMode === 'new' && newCampaignTrimmed && !NAME_PATTERN.test(newCampaignTrimmed) && (
              <div className="text-[10px] text-ed-rust mt-1">
                Use letters, digits, spaces, hyphens, underscores only
              </div>
            )}
          </div>

          {/* Save error */}
          {lockError && (
            <div className="text-[12px] text-ed-rust bg-ed-rust/10 border border-ed-rust/30 rounded-lg p-2.5">
              {lockError}
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
            {saving ? 'Creating…' : 'Create Ad Set'}
          </button>
        </div>
      </div>
    </div>
  );
}

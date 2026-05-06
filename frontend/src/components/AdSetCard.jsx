import { useState, useMemo } from 'react';
import { api } from '../api';
// Phase 6.20a — render lifecycle pill on terminal/observing states (Phase 3)
import ObservationPill from './observation/ObservationPill';

// Phase 1 — Staging Page: a single ad-set card.
// Shows the angle name, ad-set name, member ads (3-up thumbnail grid),
// and (when not in regroup mode) per-set actions: Edit Meta settings,
// Promote to Ready-to-Post.
//
// In regroup mode, the ads themselves become selectable checkboxes and
// per-set actions are hidden.
export default function AdSetCard({
  adSet,
  ads,
  regroupMode = false,
  selectedAdIds,           // Set<string>
  onToggleAdSelection,     // (adId: string) => void
  onEditMetaSettings,      // (adSet) => void
  onPromote,               // (adSet) => void
  onForcePromoteAd,        // (adId) => void  // only used in Rejected view
  onPostToMeta,            // (adSet) => void  // Phase 2B: Promoted variant only
  isPosting = false,       // Phase 2B: Promoted variant only
  metaAccountId = null,    // Phase 2B: for Ads Manager link on Posted variant
  readOnly = false,
  variant = 'pending',     // 'pending' | 'rejected' | 'promoted' | 'posted'
}) {
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');

  const handlePromote = async () => {
    if (promoting) return;
    setPromoteError('');
    setPromoting(true);
    try {
      await onPromote?.(adSet);
    } catch (err) {
      setPromoteError(err?.message || 'Failed to promote ad set');
    } finally {
      setPromoting(false);
    }
  };

  const adCount = ads?.length ?? 0;

  return (
    <div className="ed-card p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-ed-ink3 font-semibold">
            {adSet.angle_id ? 'Angle' : 'Untitled angle'}
          </div>
          <div className="text-sm font-semibold text-ed-ink truncate">{adSet.name || `Ad set ${adSet.id.slice(0, 8)}`}</div>
          <div className="text-xs text-ed-ink2 mt-0.5 flex items-center gap-2">
            <span>{adCount} ad{adCount === 1 ? '' : 's'}</span>
            {/* Phase 6.20a — lifecycle pill (Phase 3 component). Renders for
                observing/terminal lifecycles. Draft/ready get nothing here
                (status implied by which view contains the card). */}
            {['observing', 'passed', 'failed', 'failed_external', 'insufficient_data'].includes(adSet.lifecycle_status) && (
              <ObservationPill adSet={adSet} />
            )}
          </div>
        </div>
        {!readOnly && !regroupMode && variant === 'pending' && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onEditMetaSettings?.(adSet)}
              className="ed-ghost text-xs px-2 py-1"
            >
              Edit Meta settings
            </button>
            <button
              type="button"
              onClick={handlePromote}
              disabled={promoting || adCount === 0}
              className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-xs px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {promoting ? 'Promoting…' : 'Promote to Ready-to-Post'}
            </button>
          </div>
        )}
        {/* Phase 2B — Promoted variant: Post-to-Meta button */}
        {variant === 'promoted' && !readOnly && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPostToMeta?.(adSet)}
              disabled={isPosting}
              className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-xs px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPosting ? 'Posting…' : 'Post to Meta'}
            </button>
          </div>
        )}
        {/* Phase 2B — Posted variant: link to Ads Manager */}
        {variant === 'posted' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-ed-green font-semibold">✓ Posted</span>
            {adSet.meta_adset_id && metaAccountId && (
              <a
                href={`https://business.facebook.com/adsmanager/manage/adsets?act=${metaAccountId.replace(/^act_/, '')}&selected_adset_ids=${adSet.meta_adset_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ed-ghost text-xs px-2 py-1"
              >
                Open in Ads Manager →
              </a>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(ads || []).slice(0, 6).map((ad) => (
          <AdThumbnail
            key={ad.id}
            ad={ad}
            selectable={regroupMode || variant === 'rejected'}
            selected={selectedAdIds?.has(ad.id) || false}
            onToggle={() => onToggleAdSelection?.(ad.id)}
            onForcePromote={variant === 'rejected' ? () => onForcePromoteAd?.(ad.id) : null}
            showRejection={variant === 'rejected'}
          />
        ))}
        {ads?.length > 6 && (
          <div className="aspect-square bg-cream rounded flex items-center justify-center text-xs text-ed-ink2">
            +{ads.length - 6} more
          </div>
        )}
      </div>

      {promoteError && (
        <div className="mt-2 text-xs text-red-600">{promoteError}</div>
      )}
    </div>
  );
}

function AdThumbnail({ ad, selectable, selected, onToggle, onForcePromote, showRejection }) {
  const imgUrl = useMemo(() => ad.storageId
    ? `/api/projects/${ad.project_id}/ads/${ad.id}/image`
    : null, [ad.id, ad.project_id, ad.storageId]);

  const reasons = useMemo(() => {
    if (!ad.filter_reasons) return [];
    try {
      const parsed = JSON.parse(ad.filter_reasons);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [ad.filter_reasons]);

  return (
    <div
      className={`relative aspect-square rounded overflow-hidden border ${selected ? 'border-ed-accent border-2' : 'border-transparent'} ${selectable ? 'cursor-pointer' : ''}`}
      onClick={selectable ? onToggle : undefined}
    >
      {imgUrl ? (
        <img src={imgUrl} alt={ad.headline || ad.id} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-cream flex items-center justify-center text-[10px] text-ed-ink3">
          {ad.status || 'no image'}
        </div>
      )}

      {selectable && (
        <div className={`absolute top-1 right-1 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? 'bg-ed-accent border-ed-accent text-white' : 'bg-ed-surface/80 border-white/80'}`}>
          {selected && <span className="text-xs leading-none">✓</span>}
        </div>
      )}

      {showRejection && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] p-1">
          <div className="font-semibold">Score: {ad.filter_score != null ? ad.filter_score.toFixed(2) : '—'}</div>
          {reasons.length > 0 && (
            <div className="truncate">{reasons[0]}</div>
          )}
          {onForcePromote && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onForcePromote(); }}
              className="mt-1 px-2 py-0.5 bg-ed-accent text-white rounded text-[10px] font-semibold"
            >
              Force-promote
            </button>
          )}
        </div>
      )}
    </div>
  );
}

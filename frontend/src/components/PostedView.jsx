import { useState, useEffect } from 'react';
import { api } from '../api';
import ObservationPill from './observation/ObservationPill';
import AdSetTimeline from './observation/AdSetTimeline';
import FilterTabs from './shared/FilterTabs';
import ThumbnailRow from './shared/ThumbnailRow';
import MetricCell from './shared/MetricCell';

/**
 * PostedView — Phase 6.20b native rendering. Iterates ad_sets directly
 * (no flex_ad adapter shape). Member deployments resolved via
 * `deployments.filter(d => d.local_adset_id === adSet.externalId)`.
 *
 * Lifecycle filter: shows ad_sets in observing / passed / failed /
 * failed_external / insufficient_data. Standalone posted deployments
 * (no parent ad_set) still render as single-ad cards for back-compat.
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, isPoster
 */
export default function PostedView({ projectId, deployments, setDeployments, addToast, loadDeployments, isPoster }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [postedAdSets, setPostedAdSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sendingBackIds, setSendingBackIds] = useState(new Set());
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [observationAdSets, setObservationAdSets] = useState([]);
  const [activeAdSetId, setActiveAdSetId] = useState(null);
  const [lifecycleFilter, setLifecycleFilter] = useState('all');

  const toggleCardExpanded = (key) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  useEffect(() => { loadData(); }, [projectId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [campData, postedSets, obsData] = await Promise.all([
        api.getCampaigns(projectId),
        api.getAdSets(projectId, ['observing', 'passed', 'failed', 'failed_external', 'insufficient_data']),
        api.getObservationAdSets(projectId).then((r) => r?.ad_sets || []).catch(() => []),
      ]);
      setCampaigns(campData.campaigns || []);
      setAdSets(campData.adSets || []);
      setPostedAdSets(Array.isArray(postedSets) ? postedSets : []);
      setObservationAdSets(obsData);
    } catch (err) {
      console.error('PostedView loadData error:', err);
    }
    setLoading(false);
  };

  const postedDeps = deployments.filter(d => d.status === 'posted');

  // ── Helpers ──────────────────────────────────────────────────────────────

  const resolveLocation = (dep) => {
    if (dep.campaign_name || dep.ad_set_name) {
      return { campaignName: dep.campaign_name || null, adSetName: dep.ad_set_name || null };
    }
    const adSet = adSets.find(a => a.id === dep.local_adset_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => adSets.filter(a => a.campaign_id === c.id).some(a => a.id === dep.local_adset_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const resolveAdSetLocation = (adSet) => {
    const children = getAdSetChildDeps(adSet);
    if (children.length > 0 && (children[0].campaign_name || children[0].ad_set_name)) {
      return {
        campaignName: children[0].campaign_name || null,
        adSetName: children[0].ad_set_name || adSet.name || null,
      };
    }
    const campaign = campaigns.find(c => c.id === adSet.campaign_id);
    return {
      campaignName: campaign?.name || null,
      adSetName: adSet.name || null,
    };
  };

  const getAdSetChildDeps = (adSet) => {
    return postedDeps.filter(d => d.local_adset_id === adSet.externalId);
  };

  const adSetHasPostedChildren = (adSet) => getAdSetChildDeps(adSet).length > 0;

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return dateStr; }
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleSendBack = async (depId) => {
    setSendingBackIds(prev => new Set(prev).add(depId));
    try {
      await api.updateDeploymentStatus(depId, 'ready_to_post');
      setDeployments(prev => prev.map(d => d.id === depId ? { ...d, status: 'ready_to_post' } : d));
      addToast('Sent back to Ready to Post', 'success');
    } catch { addToast('Failed to send back', 'error'); }
    setSendingBackIds(prev => { const next = new Set(prev); next.delete(depId); return next; });
  };

  const handleSendBackAdSet = async (adSet) => {
    const sendId = `adset-${adSet.externalId}`;
    setSendingBackIds(prev => new Set(prev).add(sendId));
    try {
      const childDeps = getAdSetChildDeps(adSet);
      await Promise.all([
        api.updateAdSetUnified(projectId, adSet.externalId, { lifecycle_status: 'ready' }).catch(() => {}),
        ...childDeps.map(d => api.updateDeploymentStatus(d.id, 'ready_to_post')),
      ]);
      setDeployments(prev => prev.map(d => {
        if (childDeps.some(cd => cd.id === d.id)) return { ...d, status: 'ready_to_post' };
        return d;
      }));
      addToast(`${childDeps.length} ads sent back to Ready to Post`, 'success');
      loadData();
    } catch { addToast('Failed to send back', 'error'); }
    setSendingBackIds(prev => { const next = new Set(prev); next.delete(sendId); return next; });
  };

  // ── Card Renderers ──────────────────────────────────────────────────────

  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const postedDate = dep.posted_date ? new Date(dep.posted_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
    const isSendingBack = sendingBackIds.has(dep.id);
    const { campaignName } = resolveLocation(dep);
    const isExpanded = expandedCards.has(dep.id);

    return (
      <div key={dep.id} className="border border-ed-line rounded-xl bg-white overflow-hidden">
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="text-[15px] font-serif text-ed-ink leading-tight">{name}</h3>
              <p className="text-[11px] text-ed-ink3 mt-0.5">
                {postedDate ? `Posted ${postedDate}` : 'Posted'} · single ad{campaignName ? ` · ${campaignName}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="inline-block px-2 py-0.5 rounded bg-ed-green/10 text-ed-green text-[9px] font-bold uppercase tracking-wider">Posted</span>
              <button onClick={() => handleSendBack(dep.id)} disabled={isSendingBack}
                className="text-[11px] text-ed-ink2 hover:text-ed-accent transition-colors disabled:opacity-50"
              >
                {isSendingBack ? 'Sending...' : 'Send back'}
              </button>
            </div>
          </div>

          {/* Thumbnail */}
          {thumbUrl && (
            <div className="mt-3">
              <ThumbnailRow
                images={[{ url: thumbUrl, aspectRatio: dep.ad?.aspect_ratio, label: dep.ad?.image_model }]}
                maxVisible={1}
              />
            </div>
          )}
        </div>

        {/* Expand toggle footer */}
        {(dep.destination_url || dep.display_link || dep.cta_button || dep.facebook_page) && (
          <>
            {isExpanded && (
              <div className="px-5 pb-4 space-y-2.5 border-t border-ed-line pt-3 text-[12px]">
                {dep.destination_url && (
                  <div><span className="text-ed-ink2">URL:</span> <a href={dep.destination_url} target="_blank" rel="noopener noreferrer" className="text-ed-accent hover:underline break-all">{dep.destination_url}</a></div>
                )}
                {dep.display_link && (
                  <div><span className="text-ed-ink2">Display Link:</span> <span className="text-ed-ink">{dep.display_link}</span></div>
                )}
                {dep.cta_button && (
                  <div><span className="text-ed-ink2">CTA:</span> <span className="font-medium text-ed-green">{dep.cta_button.replace(/_/g, ' ')}</span></div>
                )}
                {dep.facebook_page && (
                  <div><span className="text-ed-ink2">Facebook Page:</span> <span className="font-medium text-ed-ink">{dep.facebook_page}</span></div>
                )}
              </div>
            )}
            <div className="px-5 py-2 border-t border-ed-line bg-ed-bg flex items-center justify-center">
              <button
                onClick={() => toggleCardExpanded(dep.id)}
                className="flex items-center gap-1 text-[11px] font-medium text-ed-ink2 hover:text-ed-accent transition-colors"
              >
                <svg className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                {isExpanded ? 'Hide details' : 'Show details'}
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderAdSetCard = (adSet) => {
    const childDeps = getAdSetChildDeps(adSet);
    if (childDeps.length === 0) return null;

    const sample = childDeps[0] || {};
    const postedDate = sample.posted_date || adSet.posted_at;
    const postedDateFmt = postedDate ? new Date(postedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
    const sendId = `adset-${adSet.externalId}`;
    const isSendingBack = sendingBackIds.has(sendId);
    const { campaignName } = resolveAdSetLocation(adSet);
    const isExpanded = expandedCards.has(sendId);
    const canDemote = adSet.lifecycle_status === 'observing' || adSet.lifecycle_status === 'posted';
    const enriched = observationAdSets.find((s) => s.externalId === adSet.externalId);
    const angleName = enriched?.angle_name || null;

    const metaAdSetId = adSet.meta_adset_id;
    const metaCampaignId = adSet.meta_campaign_id;

    return (
      <div key={adSet.externalId} className="border border-ed-line rounded-xl bg-white overflow-hidden">
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="text-[15px] font-serif text-ed-ink leading-tight">{adSet.name || 'Ad Set'}</h3>
              <p className="text-[11px] text-ed-ink3 mt-0.5">
                {postedDateFmt ? `Posted ${postedDateFmt}` : 'Posted'} · {childDeps.length} ad{childDeps.length !== 1 ? 's' : ''}{angleName ? ` · ${angleName} angle` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              {enriched ? (
                <ObservationPill adSet={enriched} onClick={() => setActiveAdSetId(adSet.externalId)} />
              ) : (
                <span className="inline-block px-2 py-0.5 rounded bg-ed-green/10 text-ed-green text-[9px] font-bold uppercase tracking-wider">Posted</span>
              )}
              {metaAdSetId && metaCampaignId && (
                <a
                  href={`https://adsmanager.facebook.com/adsmanager/manage/adsets?act=${metaCampaignId}&selected_adset_ids=${metaAdSetId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-ed-ink2 hover:text-ed-accent transition-colors"
                >
                  Open in Meta
                </a>
              )}
              {canDemote && (
                <button onClick={() => handleSendBackAdSet(adSet)} disabled={isSendingBack}
                  className="text-[11px] text-ed-ink2 hover:text-ed-accent transition-colors disabled:opacity-50"
                >
                  {isSendingBack ? 'Sending...' : 'Send back'}
                </button>
              )}
            </div>
          </div>

          {/* Thumbnail Row */}
          <div className="mt-3">
            <ThumbnailRow
              images={childDeps.map(d => ({ url: d.imageUrl, aspectRatio: d.ad?.aspect_ratio, label: d.ad?.image_model }))}
              maxVisible={6}
            />
          </div>

          {/* Performance Metrics Row */}
          {enriched && enriched.spend > 0 && (
            <div className="grid grid-cols-5 gap-4 mt-3 pt-3 border-t border-ed-line bg-ed-bg rounded-lg px-4 py-3">
              <MetricCell label="SPEND" value={enriched.spend != null ? `$${Number(enriched.spend).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : null} />
              <MetricCell label="ROAS" value={enriched.roas != null ? Number(enriched.roas).toFixed(2) : null} />
              <MetricCell label="CPA" value={enriched.cpa != null ? `$${Number(enriched.cpa).toFixed(2)}` : null} />
              <MetricCell label="CTR" value={enriched.ctr != null ? `${Number(enriched.ctr).toFixed(2)}%` : null} />
              <MetricCell label="IMPRESSIONS" value={enriched.impressions != null ? Number(enriched.impressions).toLocaleString() : null} />
            </div>
          )}
        </div>

        {/* Collapsible details */}
        {isExpanded && (
          <div className="px-5 pb-4 space-y-3 border-t border-ed-line pt-3">
            {campaignName && (
              <div className="text-[11px] text-ed-ink2">Campaign: <span className="font-medium text-ed-ink">{campaignName}</span></div>
            )}
            {sample.posted_by && (
              <div className="text-[11px] text-ed-ink2">Posted by: <span className="font-medium text-ed-ink">{sample.posted_by}</span></div>
            )}
            <div className="text-[12px] space-y-2">
              {sample.destination_url && (
                <div><span className="text-ed-ink2">URL:</span> <a href={sample.destination_url} target="_blank" rel="noopener noreferrer" className="text-ed-accent hover:underline break-all">{sample.destination_url}</a></div>
              )}
              {sample.display_link && (
                <div><span className="text-ed-ink2">Display Link:</span> <span className="text-ed-ink">{sample.display_link}</span></div>
              )}
              {sample.cta_button && (
                <div><span className="text-ed-ink2">CTA:</span> <span className="font-medium text-ed-green">{sample.cta_button.replace(/_/g, ' ')}</span></div>
              )}
              {sample.facebook_page && (
                <div><span className="text-ed-ink2">Facebook Page:</span> <span className="font-medium text-ed-ink">{sample.facebook_page}</span></div>
              )}
            </div>
          </div>
        )}

        {/* Expand toggle footer */}
        <div className="px-5 py-2 border-t border-ed-line bg-ed-bg flex items-center justify-center">
          <button
            onClick={() => toggleCardExpanded(sendId)}
            className="flex items-center gap-1 text-[11px] font-medium text-ed-ink2 hover:text-ed-accent transition-colors"
          >
            <svg className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {isExpanded ? 'Hide details' : 'Show details'}
          </button>
        </div>
      </div>
    );
  };

  // ── Build card list ──────────────────────────────────────────────────────

  const buildCardList = () => {
    const cards = [];
    const adSetMemberDepIds = new Set();
    postedAdSets.forEach((adSet) => {
      const children = getAdSetChildDeps(adSet);
      children.forEach((d) => adSetMemberDepIds.add(d.id));
    });
    postedDeps.forEach(dep => {
      if (adSetMemberDepIds.has(dep.id)) return;
      cards.push({ type: 'single', dep, postedDate: dep.posted_date || '', key: dep.id, lifecycle: 'posted' });
    });
    postedAdSets.forEach(adSet => {
      if (!adSetHasPostedChildren(adSet)) return;
      const childDeps = getAdSetChildDeps(adSet);
      cards.push({
        type: 'adset',
        adSet,
        postedDate: childDeps[0]?.posted_date || adSet.posted_at || '',
        key: `adset-${adSet.externalId}`,
        lifecycle: adSet.lifecycle_status || 'posted',
      });
    });
    cards.sort((a, b) => {
      if (a.postedDate && b.postedDate) return b.postedDate.localeCompare(a.postedDate);
      if (a.postedDate) return -1;
      if (b.postedDate) return 1;
      return 0;
    });
    return cards;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) return <div className="text-center py-12 text-ed-ink2 text-[13px]">Loading...</div>;

  if (postedDeps.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-ed-green/5 flex items-center justify-center">
          <svg className="w-6 h-6 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-[14px] font-medium text-ed-ink">No posted ads yet</p>
        <p className="text-[12px] text-ed-ink2 mt-1">When ads are marked as posted from the Ready to Post view, they'll appear here.</p>
      </div>
    );
  }

  const cardList = buildCardList();

  const lifecycleCounts = {};
  let totalCount = 0;
  cardList.forEach(card => {
    totalCount++;
    const lc = card.lifecycle || 'posted';
    lifecycleCounts[lc] = (lifecycleCounts[lc] || 0) + 1;
  });
  const lifecycleTabs = [
    { label: 'All', count: totalCount, value: 'all' },
    ...Object.entries(lifecycleCounts).map(([status, count]) => ({
      label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '),
      count,
      value: status,
    })),
  ];

  const filteredCardList = lifecycleFilter === 'all' ? cardList : cardList.filter(c => (c.lifecycle || 'posted') === lifecycleFilter);

  return (
    <div className="space-y-5">
      {/* Status filter tabs */}
      {lifecycleTabs.length > 2 && (
        <FilterTabs tabs={lifecycleTabs} activeValue={lifecycleFilter} onChange={setLifecycleFilter} />
      )}

      {/* Info text */}
      <span className="text-[11px] text-ed-ink3">
        Showing {filteredCardList.length} of {cardList.length} · sorted by recent
      </span>

      {/* Cards */}
      <div className="space-y-4">
        {filteredCardList.map(card => card.type === 'single' ? renderAdCard(card.dep) : renderAdSetCard(card.adSet))}
      </div>

      <AdSetTimeline
        projectId={projectId}
        adSetId={activeAdSetId}
        open={!!activeAdSetId}
        onClose={() => setActiveAdSetId(null)}
        onChanged={loadData}
      />
    </div>
  );
}

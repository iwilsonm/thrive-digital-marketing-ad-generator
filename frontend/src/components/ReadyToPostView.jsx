import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import JSZip from 'jszip';
import { api } from '../api';
import { ensureArray } from '../utils/collections';
import ConfirmDialog from './ConfirmDialog';
import InfoTooltip from './InfoTooltip';
import { fetchBlobOrThrow } from '../utils/downloads';
// Phase 6.20a — backdate picker on manual Mark as Posted
import MarkPostedModal from './MarkPostedModal';

// Phase 6.20b — Drop the api.js flex_ad adapter from this view. Compose the
// flex-shape inline from native ad_sets + deployments, route writes natively
// via api.updateAdSetUnified + api.updateDeployment + api.ungroupAdSet. The
// internal data shape is preserved so the render layer below is unchanged.
function composeFlexFromAdSet(adSet, deployments) {
  const children = (deployments || []).filter(d => d.local_adset_id === adSet.externalId);
  const sample = children[0] || {};
  return {
    id: adSet.externalId,
    externalId: adSet.externalId,
    project_id: adSet.project_id,
    ad_set_id: adSet.externalId,
    name: adSet.name || '',
    child_deployment_ids: JSON.stringify(children.map(d => d.externalId)),
    primary_texts: sample.primary_texts || '[]',
    headlines: sample.ad_headlines || '[]',
    destination_url: sample.destination_url || '',
    display_link: sample.display_link || '',
    cta_button: sample.cta_button || '',
    facebook_page: sample.facebook_page || '',
    planned_date: sample.planned_date || '',
    posted_by: sample.posted_by || '',
    duplicate_adset_name: sample.duplicate_adset_name || '',
    notes: sample.notes || '',
    ad_name: sample.ad_name || '',
    angle_id: adSet.angle_id || null,
    angle_name: adSet.angle_name || sample.ad?.angle_name || sample.ad?.angle || '',
    lifecycle_status: adSet.lifecycle_status || '',
    ready_source: adSet.ready_source || '',
    ready_at: adSet.ready_at || '',
    lp_primary_url: '',
    lp_secondary_url: '',
    gauntlet_lp_urls: '',
    destination_urls_used: '',
    created_at: adSet.created_at || '',
    updated_at: adSet.updated_at || '',
  };
}

// Phase 6.20b — split a save payload between ad_set-level fields (name) and
// per-deployment fields (everything else). Returns { adSetFields, depFields }.
const AD_SET_SCALAR_FIELDS = new Set(['name', 'campaign_id']);
function splitAdSetWriteFields(fields) {
  const adSetFields = {};
  const depFields = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (k.startsWith('_')) continue;
    if (AD_SET_SCALAR_FIELDS.has(k)) adSetFields[k] = v;
    else depFields[k] = v;
  }
  return { adSetFields, depFields };
}

function parseTextList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === '' || value === 'null') return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function PostToMetaModal({
  open,
  items,
  postingPath,
  deliveryMode,
  setDeliveryMode,
  scheduleTime,
  setScheduleTime,
  riskAccepted,
  setRiskAccepted,
  apiConfirmText,
  setApiConfirmText,
  error,
  busy,
  onClose,
  onConfirm,
}) {
  if (!open || typeof document === 'undefined') return null;
  const isApi = postingPath === 'api';
  const needsSchedule = deliveryMode === 'scheduled';
  const canConfirm = !busy
    && riskAccepted
    && (!needsSchedule || !!scheduleTime)
    && (!isApi || apiConfirmText === 'POST VIA API');
  const count = (items || []).reduce((sum, item) => sum + (item.count || 1), 0);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-[560px] max-h-[92vh] overflow-hidden rounded-2xl bg-ed-surface shadow-card-hover">
        <div className="px-5 py-4 border-b border-ed-line">
          <p className="text-[10px] uppercase tracking-[0.18em] text-ed-rust font-bold">Meta posting risk acknowledgement</p>
          <h2 className="text-[18px] font-semibold text-ed-ink mt-1">Post to Meta</h2>
          <p className="text-[12px] text-ed-ink2 mt-1">
            This will create Meta ad objects for {count} ad{count === 1 ? '' : 's'} using the selected Posting Path.
          </p>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(92vh - 154px)' }}>
          <div className={`rounded-xl border p-4 ${isApi ? 'border-ed-rust/50 bg-ed-rust/10' : 'border-ed-accent/30 bg-ed-accent/10'}`}>
            <p className={`text-[12px] font-bold ${isApi ? 'text-ed-rust' : 'text-ed-ink'}`}>
              {isApi ? 'Severe Direct API posting warning' : 'Automatic posting warning'}
            </p>
            <p className={`text-[12px] leading-relaxed mt-2 ${isApi ? 'text-ed-rust' : 'text-ed-ink2'}`}>
              {isApi
                ? 'Direct API posting is not recommended. Historically, some advertisers have had accounts restricted or banned after posting ads through the API. By continuing, you accept that risk and understand Dacia Automation assumes no responsibility.'
                : 'This will automatically create ad objects in Meta. Automatic posting carries inherent account and delivery risk. Dacia Automation does not assume responsibility for account restrictions, rejected ads, delivery problems, or spend created after you choose to post.'}
            </p>
          </div>

          <div className="rounded-xl border border-ed-line p-4 space-y-3">
            <p className="text-[12px] font-semibold text-ed-ink">Delivery</p>
            {[
              { id: 'active', label: 'Active now', helper: 'Create the Meta ads as active immediately.' },
              { id: 'scheduled', label: 'Schedule start time', helper: 'Create the ads active with a future start time.' },
              { id: 'paused', label: 'Create paused', helper: 'Create the ads paused so you can review in Ads Manager first.' },
            ].map((option) => (
              <label key={option.id} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={deliveryMode === option.id}
                  onChange={() => setDeliveryMode(option.id)}
                  className="mt-0.5 rounded-full border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20"
                />
                <span>
                  <span className="block text-[13px] font-medium text-ed-ink">{option.label}</span>
                  <span className="block text-[11px] text-ed-ink2">{option.helper}</span>
                </span>
              </label>
            ))}
            {needsSchedule && (
              <input
                type="datetime-local"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[13px] w-full"
              />
            )}
          </div>

          <label className="flex items-start gap-2 rounded-xl border border-ed-line p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={riskAccepted}
              onChange={(e) => setRiskAccepted(e.target.checked)}
              className="mt-0.5 rounded border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20"
            />
            <span className="text-[12px] text-ed-ink2 leading-relaxed">
              I understand this posts to Meta automatically, carries inherent risk, and Dacia Automation assumes no responsibility for restrictions, rejected ads, delivery issues, or spend after I choose to post.
            </span>
          </label>

          {isApi && (
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-ed-rust">Type POST VIA API to continue</label>
              <input
                value={apiConfirmText}
                onChange={(e) => setApiConfirmText(e.target.value)}
                placeholder="POST VIA API"
                className="input-apple !border-ed-rust/40 focus:!ring-ed-rust/20 focus:!border-ed-rust text-[13px] w-full mt-1"
              />
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-ed-rust/30 bg-ed-rust/10 p-3 text-[12px] text-ed-rust leading-relaxed">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-ed-line flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="ed-ghost text-[12px] px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 rounded-lg text-[12px] font-bold text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isApi ? 'bg-ed-rust hover:bg-ed-rust/90' : 'bg-ed-accent hover:bg-ed-accent/90'}`}
          >
            {busy ? 'Posting...' : isApi ? 'Post via API — I accept the risk' : 'Post to Meta'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * ReadyToPostView — Employee-facing view for posting ads to Meta Ads Manager.
 *
 * Designed to be extremely clear for employees who may not be familiar with
 * Meta's interface. Every section is explicitly labeled with plain-English
 * descriptions and helper text explaining where things go in Ads Manager.
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner
 */
export default function ReadyToPostView({ projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner, isPoster, highlightAdSetId, highlightFlexAdId, onHighlightDone }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmPosted, setConfirmPosted] = useState(null);
  // Phase 6.20a — backdate picker on manual Mark as Posted. Modal opens
  // when user confirms; on save passes a chosen posted_at to the handler.
  const [markPostedModal, setMarkPostedModal] = useState(null); // { flexAd, deploymentId } | null
  const [deleteFlexConfirm, setDeleteFlexConfirm] = useState(null);
  const [markingPostedIds, setMarkingPostedIds] = useState(new Set());
  const [sendingBackIds, setSendingBackIds] = useState(new Set());
  const [bulkMarkingAll, setBulkMarkingAll] = useState(false);
  const [selectedImages, setSelectedImages] = useState({});
  const [downloadingAll, setDownloadingAll] = useState(new Set());
  const [downloadingSelected, setDownloadingSelected] = useState(new Set());
  const [downloadingSingle, setDownloadingSingle] = useState(new Set());
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [loadError, setLoadError] = useState(null);
  const [copiedItems, setCopiedItems] = useState(new Set()); // Track copied primary texts / headlines by "cardKey-section-index"
  const [editingNotes, setEditingNotes] = useState(null); // cardKey of the card whose notes are being edited
  const [notesValue, setNotesValue] = useState(''); // current textarea value
  const [savingNotes, setSavingNotes] = useState(false);
  const [editingCard, setEditingCard] = useState(null); // cardKey of card being edited (admin only)
  const [editFields, setEditFields] = useState({}); // temp edit values
  const [savingEdit, setSavingEdit] = useState(false);
  const [editingSection, setEditingSection] = useState(null); // `${cardKey}:${section}`
  const [sectionFields, setSectionFields] = useState({});
  const [savingSection, setSavingSection] = useState(null);
  const [generatingSection, setGeneratingSection] = useState(null);
  const [generationCounts, setGenerationCounts] = useState({});
  const [sortBy, setSortBy] = useState('newest');
  const [selectedCards, setSelectedCards] = useState(new Map()); // Map<cardKey, 'flex'|'single'>
  const [bulkMarking, setBulkMarking] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [metaStatus, setMetaStatus] = useState(null);
  const [postMetaModal, setPostMetaModal] = useState(null); // { items: [{ type, id, label, count }] } | null
  const [postingMeta, setPostingMeta] = useState(false);
  const [postMetaError, setPostMetaError] = useState('');
  const [postDeliveryMode, setPostDeliveryMode] = useState('active');
  const [postScheduleTime, setPostScheduleTime] = useState('');
  const [postRiskAccepted, setPostRiskAccepted] = useState(false);
  const [apiConfirmText, setApiConfirmText] = useState('');

  const toggleCardSelection = (cardKey, cardType) => {
    setSelectedCards(prev => {
      const next = new Map(prev);
      if (next.has(cardKey)) next.delete(cardKey);
      else next.set(cardKey, cardType);
      return next;
    });
  };

  // Clear selection on sort change.
  useEffect(() => { setSelectedCards(new Map()); }, [sortBy]);

  // Highlight + scroll to flex ad from deep link
  const requestedHighlightId = highlightAdSetId || highlightFlexAdId || null;
  const [highlightedId, setHighlightedId] = useState(requestedHighlightId);
  const highlightRef = useRef(null);
  const missingHighlightReportedRef = useRef(null);

  useEffect(() => {
    setHighlightedId(requestedHighlightId);
    if (requestedHighlightId) {
      setExpandedCards(prev => new Set(prev).add(`flex-${requestedHighlightId}`));
      missingHighlightReportedRef.current = null;
    }
  }, [requestedHighlightId]);

  useEffect(() => {
    if (highlightedId && highlightRef.current && !loading) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Clear highlight after animation
      const timer = setTimeout(() => {
        setHighlightedId(null);
        onHighlightDone?.();
      }, 2500);
      return () => clearTimeout(timer);
    }
    if (
      highlightedId &&
      !loading &&
      (safeFlexAds.length === 0 || !safeFlexAds.some(f => f.id === highlightedId)) &&
      missingHighlightReportedRef.current !== highlightedId
    ) {
      missingHighlightReportedRef.current = highlightedId;
      addToast('Could not find that Ready-to-Post ad set. It may have been moved, deleted, or not created.', 'error');
      setHighlightedId(null);
      onHighlightDone?.();
    }
  }, [highlightedId, loading, flexAds]);

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
    setLoadError(null);
    try {
      // Phase 6.20b — native ad_set fetch (lifecycle='ready') + inline compose
      // of flex-shape from current deployments prop. No api.js adapter call.
      const [campData, readyAdSets, metaConnection] = await Promise.all([
        api.getCampaigns(projectId),
        api.getAdSets(projectId, ['ready']),
        api.getMetaConnectionStatus(projectId).catch(() => null),
      ]);
      const safeReady = Array.isArray(readyAdSets) ? readyAdSets : (readyAdSets?.adSets ?? []);
      setCampaigns(ensureArray(campData?.campaigns, 'ReadyToPostView.campaigns'));
      setAdSets(ensureArray(campData?.adSets, 'ReadyToPostView.adSets'));
      setMetaStatus(metaConnection);
      const composed = safeReady.map(s => composeFlexFromAdSet(s, deployments));
      setFlexAds(composed);
    } catch (err) {
      console.error('ReadyToPostView loadData error:', err);
      setLoadError('Failed to load campaign data. Please refresh the page.');
    }
    setLoading(false);
  };

  const safeDeployments = ensureArray(deployments, 'ReadyToPostView.deployments');
  const safeCampaigns = ensureArray(campaigns, 'ReadyToPostView.campaignsState');
  const safeAdSets = ensureArray(adSets, 'ReadyToPostView.adSetsState');
  const safeFlexAds = ensureArray(flexAds, 'ReadyToPostView.flexAdsState');
  const readyDeps = safeDeployments.filter(d => d.status === 'ready_to_post');

  // ── Helpers ──────────────────────────────────────────────────────────────

  const resolveLocation = (dep) => {
    const adSet = safeAdSets.find(a => a.id === dep.local_adset_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = safeCampaigns.find(c => safeAdSets.filter(a => a.campaign_id === c.id).some(a => a.id === dep.local_adset_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const resolveFlexLocation = (flexAd) => {
    const adSet = safeAdSets.find(a => a.id === flexAd.ad_set_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = safeCampaigns.find(c => safeAdSets.filter(a => a.campaign_id === c.id).some(a => a.id === flexAd.ad_set_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const getFlexChildDeps = (flexAd) => {
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    return readyDeps.filter(d => childIds.includes(d.id));
  };

  const flexHasReadyChildren = (flexAd) => getFlexChildDeps(flexAd).length > 0;

  const resolveSelectedReadyCards = () => {
    const singleIds = new Set();
    const flexIds = new Set();
    const flexChildIds = new Set();
    const deploymentIds = new Set();
    for (const [cardKey, cardType] of selectedCards) {
      if (cardType === 'flex') {
        const flexId = cardKey.replace(/^flex-/, '');
        const flexAd = safeFlexAds.find(f => f.id === flexId);
        if (!flexAd) continue;
        flexIds.add(flexAd.id);
        getFlexChildDeps(flexAd).forEach(d => {
          flexChildIds.add(d.id);
          deploymentIds.add(d.id);
        });
      } else {
        const dep = readyDeps.find(d => d.id === cardKey);
        if (!dep) continue;
        singleIds.add(dep.id);
        deploymentIds.add(dep.id);
      }
    }
    return { singleIds, flexIds, flexChildIds, deploymentIds };
  };

  const removeSelectedReadyCardsFromView = ({ singleIds = new Set(), flexIds = new Set(), flexChildIds = new Set(), status = 'posted', postedAt = null } = {}) => {
    setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').filter(f => !flexIds.has(f.id)));
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState')
      .filter(d => !singleIds.has(d.id))
      .map(d => {
        if (flexChildIds.has(d.id)) {
          if (status === 'posted') {
            return { ...d, status: 'posted', posted_date: postedAt || new Date().toISOString() };
          }
          return { ...d, status, local_adset_id: '', flex_ad_id: '' };
        }
        return d;
      })
    );
    setSelectedCards(new Map());
  };

  const getPostingPath = () => metaStatus?.posting_path || metaStatus?.integration_path || 'mcp';

  const resetPostMetaState = () => {
    setPostDeliveryMode('active');
    setPostScheduleTime('');
    setPostRiskAccepted(false);
    setApiConfirmText('');
    setPostMetaError('');
  };

  const openPostToMetaModal = (items) => {
    resetPostMetaState();
    setPostMetaModal({ items: ensureArray(items, 'ReadyToPostView.postMetaItems') });
  };

  const closePostToMetaModal = () => {
    if (postingMeta) return;
    setPostMetaModal(null);
    setPostMetaError('');
  };

  const selectedItemsForMetaPost = () => {
    const items = [];
    for (const [cardKey, cardType] of selectedCards) {
      if (cardType === 'flex') {
        const flexId = cardKey.replace(/^flex-/, '');
        const flexAd = safeFlexAds.find(f => f.id === flexId);
        if (!flexAd) continue;
        const childCount = getFlexChildDeps(flexAd).length || 1;
        items.push({ type: 'flex', id: flexAd.id, label: flexAd.name || 'Ready ad set', count: childCount });
      } else {
        const dep = readyDeps.find(d => d.id === cardKey);
        if (!dep) continue;
        items.push({ type: 'single', id: dep.id, label: dep.ad_name || dep.ad?.headline || 'Ready ad', count: 1 });
      }
    }
    return items;
  };

  const removePostedMetaItemsFromView = (items, postedAt = new Date().toISOString()) => {
    const singleIds = new Set();
    const flexIds = new Set();
    const flexChildIds = new Set();
    ensureArray(items, 'ReadyToPostView.postedMetaItems').forEach((item) => {
      if (item.type === 'flex') {
        flexIds.add(item.id);
        const flexAd = safeFlexAds.find(f => f.id === item.id);
        if (flexAd) getFlexChildDeps(flexAd).forEach(d => flexChildIds.add(d.id));
      } else {
        singleIds.add(item.id);
      }
    });
    removeSelectedReadyCardsFromView({ singleIds, flexIds, flexChildIds, status: 'posted', postedAt });
  };

  const buildMetaPostOptions = () => ({
    deliveryMode: postDeliveryMode,
    adStatus: postDeliveryMode === 'paused' ? 'PAUSED' : 'ACTIVE',
    scheduleStartTime: postDeliveryMode === 'scheduled' && postScheduleTime
      ? new Date(postScheduleTime).toISOString()
      : null,
    apiRiskAccepted: getPostingPath() === 'api' && apiConfirmText === 'POST VIA API',
  });

  const formatMetaPostError = (err) => {
    const parts = [];
    if (err?.message) parts.push(err.message);
    if (err?.code) parts.push(`Code: ${err.code}`);
    if (err?.stage) parts.push(`Stage: ${err.stage}`);
    if (err?.details) parts.push(`Details: ${err.details}`);
    return parts.join(' · ') || 'Meta posting failed. The item stayed in Ready to Post.';
  };

  const handlePostToMetaConfirmed = async () => {
    const items = ensureArray(postMetaModal?.items, 'ReadyToPostView.postMetaModal.items');
    if (items.length === 0) {
      setPostMetaError('Nothing selected to post.');
      return;
    }
    setPostingMeta(true);
    setPostMetaError('');
    const options = buildMetaPostOptions();
    const succeeded = [];
    try {
      for (const item of items) {
        if (item.type === 'flex') {
          await api.postAdSetToMeta(projectId, item.id, options);
        } else {
          await api.postDeploymentToMeta(projectId, item.id, options);
        }
        succeeded.push(item);
      }
      const postedAt = new Date().toISOString();
      removePostedMetaItemsFromView(succeeded, postedAt);
      addToast(`Posted ${items.length} item${items.length !== 1 ? 's' : ''} to Meta`, 'success');
      setPostMetaModal(null);
      setPostMetaError('');
      await Promise.all([loadDeployments(), loadData()]);
    } catch (err) {
      if (succeeded.length > 0) {
        removePostedMetaItemsFromView(succeeded, new Date().toISOString());
        await Promise.all([loadDeployments(), loadData()]).catch(() => {});
      }
      setPostMetaError(formatMetaPostError(err));
      addToast('Meta posting failed. The item stayed in Ready to Post unless Meta confirmed it first.', 'error');
    } finally {
      setPostingMeta(false);
    }
  };

  const copyToClipboard = async (text, label) => {
    try { await navigator.clipboard.writeText(text); addToast(`${label} copied`, 'success'); }
    catch { addToast('Failed to copy', 'error'); }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return dateStr; }
  };

  const formatAddedDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return null; }
  };

  const parseCount = (jsonStr) => parseTextList(jsonStr).length;

  const sectionEditKey = (cardKey, section) => `${cardKey}:${section}`;

  const startSectionEdit = (cardKey, section, fields = {}) => {
    setEditingSection(sectionEditKey(cardKey, section));
    setSectionFields(fields);
  };

  const cancelSectionEdit = () => {
    setEditingSection(null);
    setSectionFields({});
  };

  const updateSectionField = (key, value) => {
    setSectionFields(prev => ({ ...prev, [key]: value }));
  };

  const updateSectionArrayItem = (key, index, value) => {
    setSectionFields(prev => {
      const arr = [...(prev[key] || [])];
      arr[index] = value;
      return { ...prev, [key]: arr };
    });
  };

  const addSectionArrayItem = (key) => {
    setSectionFields(prev => ({ ...prev, [key]: [...(prev[key] || []), ''] }));
  };

  const removeSectionArrayItem = (key, index) => {
    setSectionFields(prev => {
      const arr = [...(prev[key] || [])];
      arr.splice(index, 1);
      return { ...prev, [key]: arr };
    });
  };

  const formatReadySource = (source, fallbackName = '') => {
    if (source === 'creative_director') return 'Creative Director';
    if (source === 'manual_planner') return 'Manual Planner';
    if (/^Director\s+—/i.test(fallbackName || '')) return 'Creative Director';
    return 'Manual Planner';
  };

  const resolveReadyTimestamp = (item, children = []) => (
    item?.ready_at ||
    item?.updated_at ||
    item?.created_at ||
    children.find(d => d.created_at)?.created_at ||
    ''
  );

  const extractDirectorAngleFromName = (name = '') => {
    const match = String(name || '').match(/^Director\s+—\s+(.+?)\s+#\d+\s+—/);
    return match?.[1]?.trim() || '';
  };

  const resolveAngleName = (item, children = []) => {
    return (
      item?.angle_name ||
      children.find(d => d.ad?.angle_name)?.ad?.angle_name ||
      children.find(d => d.ad?.angle)?.ad?.angle ||
      extractDirectorAngleFromName(item?.name || '') ||
      ''
    );
  };

  // ── Notes ──────────────────────────────────────────────────────────────

  const startEditingNotes = (cardKey, currentNotes) => {
    setEditingNotes(cardKey);
    setNotesValue(currentNotes || '');
  };

  const saveNotes = async (id, isFlexCard = false) => {
    setSavingNotes(true);
    try {
      const trimmed = notesValue.trim() || '';
      if (isFlexCard) {
        // Phase 6.20b — flex card notes are stored on each child deployment.
        // Write to all children so any future re-derivation picks it up.
        const flexAd = safeFlexAds.find(f => f.id === id);
        const children = flexAd ? getFlexChildDeps(flexAd) : [];
        await Promise.all(children.map(d => api.updateDeployment(d.id, { notes: trimmed })));
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
          children.some(c => c.id === d.id) ? { ...d, notes: trimmed } : d
        ));
        setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f => f.id === id ? { ...f, notes: trimmed } : f));
      } else {
        await api.updateDeployment(id, { notes: trimmed });
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === id ? { ...d, notes: trimmed } : d));
      }
      addToast('Notes saved', 'success');
    } catch {
      addToast('Failed to save notes', 'error');
    }
    setSavingNotes(false);
    setEditingNotes(null);
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleMarkPosted = async (depId) => {
    // Optimistic UI update — immediate feedback
    const dep = readyDeps.find(d => d.id === depId);
    const { campaignName, adSetName } = dep ? resolveLocation(dep) : {};
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => {
      if (d.id !== depId) return d;
      return {
        ...d,
        status: 'posted',
        posted_date: new Date().toISOString(),
        ...(campaignName ? { campaign_name: campaignName } : {}),
        ...(adSetName ? { ad_set_name: adSetName } : {}),
        ...(dep?.destination_url ? { landing_page_url: dep.destination_url } : {}),
      };
    }));
    addToast('Marked as posted manually', 'success');
    setConfirmPosted(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // API calls in background
    try {
      const carryOverFields = {};
      if (campaignName) carryOverFields.campaign_name = campaignName;
      if (adSetName) carryOverFields.ad_set_name = adSetName;
      if (dep?.destination_url) carryOverFields.landing_page_url = dep.destination_url;
      // Fire both calls in parallel
      await Promise.all([
        Object.keys(carryOverFields).length > 0 ? api.updateDeployment(depId, carryOverFields) : Promise.resolve(),
        api.updateDeploymentStatus(depId, 'posted'),
      ]);
    } catch {
      addToast('Failed to save manual posted status — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleMarkFlexPosted = async (flexAd, postedAtIso = null) => {
    // Phase 6.20a — postedAtIso optional. When provided (from MarkPostedModal),
    // sets ad_set.posted_at to that ISO timestamp so Phase 3 cron observation
    // ticks from the chosen date. Default = now (today).
    const effectivePostedAt = postedAtIso || new Date().toISOString();
    // Optimistic UI update — immediate feedback
    const childDeps = getFlexChildDeps(flexAd);
    const { campaignName, adSetName } = resolveFlexLocation(flexAd);
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => {
      if (!childIds.includes(d.id)) return d;
      return {
        ...d,
        status: 'posted',
        posted_date: new Date().toISOString(),
        ...(campaignName ? { campaign_name: campaignName } : {}),
        ...(adSetName ? { ad_set_name: adSetName } : {}),
        ...(flexAd.destination_url ? { landing_page_url: flexAd.destination_url } : {}),
      };
    }));
    addToast(`${childDeps.length} ads marked as posted manually`, 'success');
    setConfirmPosted(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // API calls in background — all in parallel.
    // Phase 6.10 — also flip the parent ad_set lifecycle to 'observing' so
    // Phase 3 cron picks it up. flexAd.id IS the ad_set externalId via the
    // adapter. posted_at is set to NOW; for backdating, use the dedicated
    // manual-mark modal (added separately).
    try {
      const carryOverFields = {};
      if (campaignName) carryOverFields.campaign_name = campaignName;
      if (adSetName) carryOverFields.ad_set_name = adSetName;
      if (flexAd.destination_url) carryOverFields.landing_page_url = flexAd.destination_url;
      await Promise.all([
        ...childDeps.map(d =>
          Promise.all([
            Object.keys(carryOverFields).length > 0 ? api.updateDeployment(d.id, carryOverFields) : Promise.resolve(),
            api.updateDeploymentStatus(d.id, 'posted'),
          ])
        ),
        api.updateAdSetUnified(projectId, flexAd.id, {
          lifecycle_status: 'observing',
          posted_at: effectivePostedAt,
        }).catch(() => { /* best-effort lifecycle sync; deployments status remains source of truth for this view */ }),
      ]);
    } catch {
      addToast('Failed to save manual posted status — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleSendBack = async (depId) => {
    // Optimistic UI update
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === depId ? { ...d, status: 'selected' } : d));
    addToast('Sent back to Planner', 'success');
    try {
      await api.updateDeploymentStatus(depId, 'selected');
    } catch {
      addToast('Failed to send back — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleSendBackFlex = async (flexAd) => {
    // Optimistic UI update
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => {
      if (childIds.includes(d.id)) return { ...d, status: 'selected' };
      return d;
    }));
    addToast('Sent back to Planner', 'success');
    try {
      const childDeps = getFlexChildDeps(flexAd);
      await Promise.all(childDeps.map(d => api.updateDeploymentStatus(d.id, 'selected')));
    } catch {
      addToast('Failed to send back — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleDeleteFlexAd = async (flexAdId) => {
    setDeleteFlexConfirm(null);
    setFlexAds(prev => prev.filter(f => f.id !== flexAdId));
    addToast('Ad set removed', 'success');
    try {
      // Phase 6.20b — native ungroup. Detaches deployments back to selected
      // and deletes the ad_set wrapper. Backend cascade handled server-side.
      await api.ungroupAdSet(projectId, flexAdId);
    } catch {
      addToast('Failed to delete ad set', 'error');
      loadDeployments();
    }
  };

  const handleBulkMarkAllPosted = async () => {
    if (readyDeps.length === 0) return;
    setBulkMarkingAll(true);
    try {
      await Promise.all(readyDeps.map(d => api.updateDeploymentStatus(d.id, 'posted')));
      setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
        d.status === 'ready_to_post' ? { ...d, status: 'posted', posted_date: new Date().toISOString() } : d
      ));
      addToast(`${readyDeps.length} ads marked as posted`, 'success');
    } catch { addToast('Failed to update some ads', 'error'); }
    setBulkMarkingAll(false);
  };

  // ── Admin Edit Helpers ──────────────────────────────────────────────────────

  const startEditing = (cardKey, data, isFlex = false) => {
    // Resolve current campaign ID and ad set name
    let currentCampaignId = '';
    let currentAdSetName = '';
    if (isFlex) {
      const adSet = safeAdSets.find(a => a.id === data.ad_set_id);
      if (adSet) {
        currentCampaignId = safeCampaigns.find(c => safeAdSets.filter(a => a.campaign_id === c.id).some(a => a.id === data.ad_set_id))?.id || '';
        currentAdSetName = adSet.name || '';
      }
    } else {
      currentCampaignId = data.local_campaign_id || '';
      const adSet = safeAdSets.find(a => a.id === data.local_adset_id);
      currentAdSetName = adSet?.name || '';
    }

    const fields = isFlex
      ? {
          name: data.name || '',
          _campaign_id: currentCampaignId,
          _ad_set_name: currentAdSetName,
          ad_set_id: data.ad_set_id || '',
          destination_url: data.destination_url || '',
          display_link: data.display_link || '',
          cta_button: data.cta_button || '',
          facebook_page: data.facebook_page || '',
          duplicate_adset_name: data.duplicate_adset_name || '',
          primary_texts: parseTextList(data.primary_texts),
          headlines: parseTextList(data.headlines),
        }
      : {
          ad_name: data.ad_name || data.ad?.headline || '',
          local_campaign_id: currentCampaignId,
          _ad_set_name: currentAdSetName,
          local_adset_id: data.local_adset_id || '',
          destination_url: data.destination_url || '',
          display_link: data.display_link || '',
          cta_button: data.cta_button || '',
          facebook_page: data.facebook_page || '',
          duplicate_adset_name: data.duplicate_adset_name || '',
          primary_texts: parseTextList(data.primary_texts),
          ad_headlines: parseTextList(data.ad_headlines),
        };
    setEditFields(fields);
    setEditingCard(cardKey);
  };

  const saveEditing = async (id, isFlex = false) => {
    setSavingEdit(true);
    try {
      const payload = { ...editFields };
      const newCampaignId = isFlex ? payload._campaign_id : payload.local_campaign_id;
      const adSetNameTyped = (payload._ad_set_name || '').trim();

      // Validate: if campaign selected, ad set name is required
      if (newCampaignId && !adSetNameTyped) {
        addToast('Please enter an ad set name', 'error');
        setSavingEdit(false);
        return;
      }

      // Remove helper fields that aren't real DB fields
      delete payload._campaign_id;
      delete payload._ad_set_name;

      if (isFlex) {
        if (newCampaignId) payload.campaign_id = newCampaignId;
        if (adSetNameTyped) payload.name = adSetNameTyped;
      }

      // Serialize arrays back to JSON strings
      if (isFlex) {
        payload.primary_texts = JSON.stringify(parseTextList(payload.primary_texts));
        payload.headlines = JSON.stringify(parseTextList(payload.headlines));
      } else {
        payload.primary_texts = JSON.stringify(parseTextList(payload.primary_texts));
        payload.ad_headlines = JSON.stringify(parseTextList(payload.ad_headlines));
      }

      // Resolve ad set: find or create by name under the selected campaign
      const adSetKey = isFlex ? 'ad_set_id' : 'local_adset_id';
      const currentAdSetId = payload[adSetKey] || '';

      if (!isFlex && newCampaignId && adSetNameTyped) {
        // Look for existing ad set by name under this campaign
        const existingAdSet = safeAdSets.find(a => a.campaign_id === newCampaignId && a.name === adSetNameTyped);
        if (existingAdSet) {
          payload[adSetKey] = existingAdSet.id;
        } else {
          // Check if the current ad set just needs to be moved to the new campaign
          const currentAdSet = currentAdSetId ? safeAdSets.find(a => a.id === currentAdSetId) : null;
          if (currentAdSet && currentAdSet.name === adSetNameTyped && currentAdSet.campaign_id !== newCampaignId) {
            // Move existing ad set to new campaign
            await api.updateAdSet(currentAdSetId, { campaign_id: newCampaignId });
            setAdSets(prev => ensureArray(prev, 'ReadyToPostView.adSetsState').map(a => a.id === currentAdSetId ? { ...a, campaign_id: newCampaignId } : a));
            payload[adSetKey] = currentAdSetId;
          } else {
            // Create new ad set under the new campaign
            const result = await api.createAdSet(newCampaignId, adSetNameTyped, projectId);
            const newAdSetId = result.id;
            setAdSets(prev => [...ensureArray(prev, 'ReadyToPostView.adSetsState'), { id: newAdSetId, name: adSetNameTyped, campaign_id: newCampaignId, project_id: projectId }]);
            payload[adSetKey] = newAdSetId;
          }
        }
      }

      // For non-flex ads, ensure local_campaign_id is set
      if (!isFlex && newCampaignId) {
        payload.local_campaign_id = newCampaignId;
      }

      if (isFlex) {
        // Phase 6.20b — split the payload between ad_set fields (name +
        // ad_set_id reassignment via legacy `ad_set_id` key) and per-deployment
        // fields (destination_url, display_link, cta_button, facebook_page,
        // duplicate_adset_name, primary_texts, headlines→ad_headlines, etc).
        // The sidebar already handled ad_set_id reassignment above (creating /
        // moving the ad_set as needed), so what remains here is the field-set.
        const flexAd = safeFlexAds.find(f => f.id === id);
        const children = flexAd ? getFlexChildDeps(flexAd) : [];
        const { adSetFields, depFields } = splitAdSetWriteFields(payload);
        // Map flex-shape `headlines` → deployment field `ad_headlines`
        if (depFields.headlines !== undefined) {
          depFields.ad_headlines = depFields.headlines;
          delete depFields.headlines;
        }
        // ad_set_id is the wrapper itself in unified model; not a settable
        // field on the ad_set update route. Drop it from the payload —
        // re-parenting was already done above by createAdSet/updateAdSet.
        delete adSetFields.ad_set_id;
        delete depFields.ad_set_id;
        const writes = [];
        if (Object.keys(adSetFields).length > 0) {
          writes.push(api.updateAdSetUnified(projectId, id, adSetFields));
        }
        if (Object.keys(depFields).length > 0 && children.length > 0) {
          writes.push(...children.map(d => api.updateDeployment(d.id, depFields)));
        }
        await Promise.all(writes);
        // Optimistic local updates: sync the in-memory flex-shape and
        // deployment objects so the next render shows the new values without
        // a roundtrip.
        setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f => f.id === id ? { ...f, ...payload } : f));
        if (Object.keys(adSetFields).length > 0) {
          setAdSets(prev => ensureArray(prev, 'ReadyToPostView.adSetsState').map(a =>
            a.id === id ? { ...a, ...adSetFields } : a
          ));
        }
        if (Object.keys(depFields).length > 0) {
          setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
            children.some(c => c.id === d.id) ? { ...d, ...depFields } : d
          ));
        }
      } else {
        await api.updateDeployment(id, payload);
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === id ? { ...d, ...payload } : d));
      }
      addToast('Changes saved', 'success');

      // Collapse the card after saving
      setExpandedCards(prev => {
        const next = new Set(prev);
        const cardKey = isFlex ? `flex-${id}` : id;
        next.delete(cardKey);
        return next;
      });
      setEditingCard(null);
      setEditFields({});

      // Don't call loadData() here — it sets loading=true which remounts the whole view.
      // Local state updates above (setFlexAds/setAdSets/setDeployments) are sufficient.
    } catch (err) {
      console.error('Failed to save editing:', err);
      addToast('Failed to save changes', 'error');
    }
    setSavingEdit(false);
  };

  const saveChildAdName = async (dep, value) => {
    const nextName = (value || '').trim();
    const currentName = dep.ad_name || dep.ad?.headline || '';
    if (nextName === currentName) return;
    try {
      await api.updateDeployment(dep.id, { ad_name: nextName });
      setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
        d.id === dep.id ? { ...d, ad_name: nextName } : d
      ));
      addToast('Ad name saved', 'success');
    } catch {
      addToast('Failed to save ad name', 'error');
    }
  };

  const resolvePlacementCampaignId = async () => {
    const mode = sectionFields.campaign_mode || 'existing';
    if (mode !== 'new') return sectionFields.campaign_id || '';

    const name = (sectionFields.new_campaign_name || '').trim();
    if (!name) {
      addToast('Please enter a campaign name', 'error');
      return null;
    }

    const existing = safeCampaigns.find(c => (c.name || '').trim().toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;

    const result = await api.createCampaign(projectId, name);
    const newCampaignId = result.id;
    setCampaigns(prev => [
      ...ensureArray(prev, 'ReadyToPostView.campaignsState'),
      { id: newCampaignId, name, project_id: projectId },
    ]);
    return newCampaignId;
  };

  const savePlacementSection = async ({ id, cardKey, isFlex, currentAdSetId = '', currentDeployment = null }) => {
    setSavingSection(sectionEditKey(cardKey, 'placement'));
    try {
      const newCampaignId = await resolvePlacementCampaignId();
      if (newCampaignId === null) {
        setSavingSection(null);
        return;
      }
      const adSetNameTyped = (sectionFields.ad_set_name || '').trim();
      const adNameTyped = (sectionFields.ad_name || '').trim();

      if (newCampaignId && !adSetNameTyped) {
        addToast('Please enter an ad set name', 'error');
        setSavingSection(null);
        return;
      }

      if (isFlex) {
        const adSetFields = {};
        if (newCampaignId) adSetFields.campaign_id = newCampaignId;
        if (adSetNameTyped) adSetFields.name = adSetNameTyped;
        const children = getFlexChildDeps(safeFlexAds.find(f => f.id === id));
        const writes = [];
        if (Object.keys(adSetFields).length > 0) writes.push(api.updateAdSetUnified(projectId, id, adSetFields));
        if (adNameTyped && children.length > 0) writes.push(...children.map(d => api.updateDeployment(d.id, { ad_name: adNameTyped })));
        if (writes.length > 0) {
          await Promise.all(writes);
          setAdSets(prev => ensureArray(prev, 'ReadyToPostView.adSetsState').map(a =>
            a.id === id ? { ...a, ...adSetFields } : a
          ));
          setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f =>
            f.id === id ? { ...f, ...adSetFields, name: adSetFields.name ?? f.name, ad_name: adNameTyped || f.ad_name } : f
          ));
          if (adNameTyped) {
            setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
              children.some(c => c.id === d.id) ? { ...d, ad_name: adNameTyped } : d
            ));
          }
        }
      } else {
        const payload = {};
        let resolvedAdSetId = currentAdSetId || currentDeployment?.local_adset_id || '';

        if ((newCampaignId || resolvedAdSetId) && adSetNameTyped) {
          const targetCampaignId = newCampaignId || safeAdSets.find(a => a.id === resolvedAdSetId)?.campaign_id || '';
          const existingAdSet = targetCampaignId
            ? safeAdSets.find(a => a.campaign_id === targetCampaignId && a.name === adSetNameTyped)
            : null;
          if (existingAdSet) {
            resolvedAdSetId = existingAdSet.id;
          } else {
            const currentAdSet = resolvedAdSetId ? safeAdSets.find(a => a.id === resolvedAdSetId) : null;
            if (currentAdSet) {
              const updateFields = { name: adSetNameTyped };
              if (targetCampaignId) updateFields.campaign_id = targetCampaignId;
              await api.updateAdSetUnified(projectId, resolvedAdSetId, updateFields);
              setAdSets(prev => ensureArray(prev, 'ReadyToPostView.adSetsState').map(a =>
                a.id === resolvedAdSetId ? { ...a, ...updateFields } : a
              ));
            } else if (targetCampaignId) {
              const result = await api.createAdSet(targetCampaignId, adSetNameTyped, projectId);
              resolvedAdSetId = result.id;
              setAdSets(prev => [
                ...ensureArray(prev, 'ReadyToPostView.adSetsState'),
                { id: resolvedAdSetId, name: adSetNameTyped, campaign_id: targetCampaignId, project_id: projectId },
              ]);
            }
          }
          if (targetCampaignId) payload.local_campaign_id = targetCampaignId;
          payload.local_adset_id = resolvedAdSetId;
        }

        if (adNameTyped) payload.ad_name = adNameTyped;
        if (Object.keys(payload).length > 0) {
          await api.updateDeployment(id, payload);
          setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
            d.id === id ? { ...d, ...payload } : d
          ));
        }
      }

      addToast('Placement saved', 'success');
      cancelSectionEdit();
    } catch (err) {
      console.error('Failed to save placement section:', err);
      addToast('Failed to save placement', 'error');
    }
    setSavingSection(null);
  };

  const persistTextSectionItems = async ({ id, isFlex, field, items }) => {
    const cleanItems = (items || []).map(item => (item || '').trim()).filter(Boolean);
    const json = JSON.stringify(cleanItems);
    const depField = field === 'primary_texts' ? 'primary_texts' : 'ad_headlines';
    const flexField = field === 'primary_texts' ? 'primary_texts' : 'headlines';

    if (isFlex) {
      const flexAd = safeFlexAds.find(f => f.id === id);
      const children = flexAd ? getFlexChildDeps(flexAd) : [];
      await Promise.all(children.map(d => api.updateDeployment(d.id, { [depField]: json })));
      setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
        children.some(c => c.id === d.id) ? { ...d, [depField]: json } : d
      ));
      setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f =>
        f.id === id ? { ...f, [flexField]: json } : f
      ));
    } else {
      await api.updateDeployment(id, { [depField]: json });
      setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
        d.id === id ? { ...d, [depField]: json } : d
      ));
    }

    return cleanItems;
  };

  const saveTextSection = async ({ id, cardKey, isFlex, field }) => {
    setSavingSection(sectionEditKey(cardKey, field));
    try {
      await persistTextSectionItems({ id, isFlex, field, items: sectionFields.items || [] });
      addToast(field === 'primary_texts' ? 'Primary text saved' : 'Headlines saved', 'success');
      cancelSectionEdit();
    } catch (err) {
      console.error('Failed to save text section:', err);
      addToast('Failed to save copy', 'error');
    }
    setSavingSection(null);
  };

  const generateTextSection = async ({ id, cardKey, isFlex, field, currentItems, replaceIndex = null }) => {
    const isHeadline = field === 'headlines' || field === 'ad_headlines';
    const sectionKey = sectionEditKey(cardKey, field);
    const generateKey = `${sectionKey}:${replaceIndex === null ? 'all' : `replace-${replaceIndex}`}`;
    const count = replaceIndex === null ? (generationCounts[sectionKey] || 5) : 1;
    setGeneratingSection(generateKey);
    try {
      const dep = isFlex ? getFlexChildDeps(safeFlexAds.find(f => f.id === id))[0] : safeDeployments.find(d => d.id === id);
      if (!dep) throw new Error('No deployment available for copy generation');
      const flexAdId = isFlex ? id : undefined;
      const options = { count, replaceIndex, existingItems: currentItems };
      let generated = [];

      if (isHeadline) {
        const source = isFlex ? safeFlexAds.find(f => f.id === id)?.primary_texts : dep.primary_texts;
        const primaryTexts = parseTextList(source);
        if (primaryTexts.length === 0) {
          throw new Error('Generate primary text before generating headlines');
        }
        const result = await api.generateAdHeadlines(dep.id, primaryTexts, flexAdId, undefined, undefined, options);
        generated = parseTextList(result?.headlines || []);
      } else {
        const result = await api.generatePrimaryText(dep.id, flexAdId, undefined, undefined, options);
        generated = parseTextList(result?.primary_texts || []);
      }

      if (generated.length === 0) throw new Error('No copy returned');
      const nextItems = replaceIndex === null
        ? generated.slice(0, count)
        : currentItems.map((item, index) => index === replaceIndex ? generated[0] : item);

      await persistTextSectionItems({ id, isFlex, field, items: nextItems });
      addToast(replaceIndex === null ? 'Copy generated' : 'Variation regenerated', 'success');
    } catch (err) {
      console.error('Failed to generate Ready-to-Post copy:', err);
      addToast(err.message || 'Failed to generate copy', 'error');
    }
    setGeneratingSection(null);
  };

  const saveAdNamesSection = async (flexAd, cardKey) => {
    setSavingSection(sectionEditKey(cardKey, 'ad_names'));
    try {
      const children = getFlexChildDeps(flexAd);
      const names = sectionFields.names || {};
      const changed = children.filter(d => {
        const nextName = (names[d.id] || '').trim();
        const currentName = d.ad_name || d.ad?.headline || '';
        return nextName && nextName !== currentName;
      });
      await Promise.all(changed.map(d => api.updateDeployment(d.id, { ad_name: names[d.id].trim() })));
      if (changed.length > 0) {
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
          names[d.id] ? { ...d, ad_name: names[d.id].trim() } : d
        ));
      }
      addToast('Ad names saved', 'success');
      cancelSectionEdit();
    } catch (err) {
      console.error('Failed to save ad names:', err);
      addToast('Failed to save ad names', 'error');
    }
    setSavingSection(null);
  };

  const updateEditField = (key, value) => {
    setEditFields(prev => ({ ...prev, [key]: value }));
  };

  const updateEditArrayItem = (key, index, value) => {
    setEditFields(prev => {
      const arr = [...(prev[key] || [])];
      arr[index] = value;
      return { ...prev, [key]: arr };
    });
  };

  const addEditArrayItem = (key) => {
    setEditFields(prev => ({ ...prev, [key]: [...(prev[key] || []), ''] }));
  };

  const removeEditArrayItem = (key, index) => {
    setEditFields(prev => {
      const arr = [...(prev[key] || [])];
      arr.splice(index, 1);
      return { ...prev, [key]: arr };
    });
  };

  // Pencil icon for edit button
  const EditPencilIcon = () => (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  );

  // ── Download Helpers ──────────────────────────────────────────────────────

  const downloadSingleImage = async (dep) => {
    if (!dep.imageUrl) return;
    setDownloadingSingle(prev => new Set(prev).add(dep.id));
    try {
      const blob = await fetchBlobOrThrow(dep.imageUrl, 'Image download failed');
      const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
      const name = (dep.ad_name || dep.ad?.headline || dep.id || 'ad').replace(/[^a-z0-9]/gi, '-').slice(0, 40);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${name}${ext}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { addToast('Failed to download image', 'error'); }
    setDownloadingSingle(prev => { const next = new Set(prev); next.delete(dep.id); return next; });
  };

  const downloadMultipleImages = async (depsToDownload, cardKey) => {
    const withImages = depsToDownload.filter(d => d.imageUrl);
    if (withImages.length === 0) { addToast('No images to download', 'error'); return; }
    if (withImages.length === 1) { await downloadSingleImage(withImages[0]); return; }
    const stateSet = cardKey.startsWith('selected-') ? setDownloadingSelected : setDownloadingAll;
    const stateKey = cardKey.replace('selected-', '');
    stateSet(prev => new Set(prev).add(stateKey));
    try {
      const results = await Promise.allSettled(withImages.map(async (dep) => {
        const blob = await fetchBlobOrThrow(dep.imageUrl, 'Image download failed');
        const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
        return { dep, blob, ext };
      }));
      const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (fulfilled.length === 0) { addToast('Failed to download images', 'error'); return; }
      const zip = new JSZip(); const usedNames = new Set();
      for (const { dep, blob, ext } of fulfilled) {
        let baseName = (dep.ad_name || dep.ad?.headline || dep.id || 'ad').replace(/[^a-z0-9]/gi, '-').slice(0, 40);
        let fileName = `${baseName}${ext}`; let counter = 1;
        while (usedNames.has(fileName)) { fileName = `${baseName}-${counter}${ext}`; counter++; }
        usedNames.add(fileName); zip.file(fileName, blob);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a'); a.href = url; a.download = `ad-creatives-${fulfilled.length}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast(`Downloaded ${fulfilled.length} images`, 'success');
    } catch { addToast('Failed to create ZIP', 'error'); }
    stateSet(prev => { const next = new Set(prev); next.delete(stateKey); return next; });
  };

  const toggleImageSelection = (cardKey, depId) => {
    setSelectedImages(prev => {
      const current = prev[cardKey] || new Set(); const next = new Set(current);
      if (next.has(depId)) next.delete(depId); else next.add(depId);
      return { ...prev, [cardKey]: next };
    });
  };

  const toggleSelectAll = (cardKey, allDepIds) => {
    setSelectedImages(prev => {
      const current = prev[cardKey] || new Set();
      const allSelected = allDepIds.every(id => current.has(id));
      return { ...prev, [cardKey]: allSelected ? new Set() : new Set(allDepIds) };
    });
  };

  // ── Reusable UI ──────────────────────────────────────────────────────────

  // Render numbered text items with copy-tracking strikethrough
  const renderNumberedTexts = (jsonStr, sectionLabel, helper, cardKey, sectionId) => {
    const items = parseTextList(jsonStr);
    if (items.length === 0) return null;
    const allText = items.join('\n\n');
    const allCopied = items.every((_, i) => copiedItems.has(`${cardKey}-${sectionId}-${i}`));

    const handleCopyItem = (text, label, index) => {
      copyToClipboard(text, label);
      setCopiedItems(prev => new Set(prev).add(`${cardKey}-${sectionId}-${index}`));
    };

    const handleCopyAll = () => {
      copyToClipboard(allText, 'All ' + sectionId);
      // Mark all items as copied
      const next = new Set(copiedItems);
      items.forEach((_, i) => next.add(`${cardKey}-${sectionId}-${i}`));
      setCopiedItems(next);
    };

    return (
      <div className="border border-ed-line rounded-xl p-4 bg-ed-surface">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-widest mb-1">{sectionLabel}</span>
            {helper && <p className="text-[11px] text-ed-ink2 mt-0.5 leading-relaxed">{helper}</p>}
          </div>
          <button onClick={(e) => { e.stopPropagation(); handleCopyAll(); }}
            className={`inline-flex items-center gap-1 rounded-md font-medium hover:bg-ed-accent/10 transition-colors flex-shrink-0 px-2 py-1 text-[10px] ${
              allCopied ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-accent/5 text-ed-accent'
            }`}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {allCopied ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              )}
            </svg>
            {allCopied ? 'All Copied' : 'Copy All'}
          </button>
        </div>
        <div className="space-y-2">
          {items.map((text, i) => {
            const itemKey = `${cardKey}-${sectionId}-${i}`;
            const isCopied = copiedItems.has(itemKey);
            return (
              <div key={i} className={`flex items-start gap-2.5 rounded-lg p-3 transition-all duration-300 ${isCopied ? 'bg-ed-green/5 border border-ed-green/10' : 'bg-ed-bg'}`}>
                <span className={`text-[12px] font-bold rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors duration-300 ${
                  isCopied ? 'bg-ed-green text-white' : 'bg-ed-accent text-white'
                }`}>{isCopied ? '✓' : i + 1}</span>
                <div className={`flex-1 text-[13px] whitespace-pre-wrap leading-relaxed transition-all duration-300 ${
                  isCopied ? 'line-through text-ed-ink2/60 decoration-ed-green/40' : 'text-ed-ink'
                }`}>{text}</div>
                <button onClick={(e) => { e.stopPropagation(); handleCopyItem(text, 'Copy', i); }}
                  className={`inline-flex items-center gap-1 rounded-md font-medium transition-colors flex-shrink-0 px-1.5 py-0.5 text-[9px] ${
                    isCopied ? 'bg-ed-green/10 text-ed-green hover:bg-ed-green/15' : 'bg-ed-accent/5 text-ed-accent hover:bg-ed-accent/10'
                  }`}>
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {isCopied ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    )}
                  </svg>
                  {isCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Card Sections ──────────────────────────────────────────────────────

  // Copy button with crossout tracking — for ad set name, rename, and ad name rows
  const CopyTrackBtn = ({ itemKey, text, label }) => {
    const isCopied = copiedItems.has(itemKey);
    const handleCopy = (e) => {
      e.stopPropagation();
      copyToClipboard(text, label);
      setCopiedItems(prev => new Set(prev).add(itemKey));
    };
    return (
      <button onClick={handleCopy}
        className={`inline-flex items-center gap-1 rounded-md font-medium transition-colors flex-shrink-0 px-1.5 py-0.5 text-[9px] ${
          isCopied ? 'bg-ed-green/10 text-ed-green hover:bg-ed-green/15' : 'bg-ed-accent/5 text-ed-accent hover:bg-ed-accent/10'
        }`}>
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {isCopied ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          )}
        </svg>
        {isCopied ? 'Copied' : 'Copy'}
      </button>
    );
  };

  const SectionEditButton = ({ onClick, label = 'Edit' }) => {
    if (isPoster) return null;
    return (
      <button
        onClick={onClick}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-ed-ink2 hover:text-ed-ink hover:bg-ed-bg transition-colors"
      >
        <EditPencilIcon />
        {label}
      </button>
    );
  };

  const OriginMeta = ({ source, timestamp, fallbackName, angleName }) => (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ed-ink2">
      {angleName && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-ed-bg border border-ed-line">
          <span className="font-semibold text-ed-ink">Angle:</span>
          {angleName}
        </span>
      )}
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-ed-bg border border-ed-line">
        <span className="font-semibold text-ed-ink">Source:</span>
        {formatReadySource(source, fallbackName)}
      </span>
      {timestamp && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-ed-bg border border-ed-line">
          <span className="font-semibold text-ed-ink">Ready since:</span>
          {formatAddedDate(timestamp) || timestamp}
        </span>
      )}
    </div>
  );

  const PlacementEditForm = ({ cardKey, isFlex, id, currentAdSetId, currentDeployment }) => {
    const saveKey = sectionEditKey(cardKey, 'placement');
    const campaignMode = sectionFields.campaign_mode || 'existing';
    return (
      <div className="mt-3 pt-3 border-t border-ed-accent/15 space-y-3">
        <div>
          <label className="text-[10px] text-ed-ink2 font-medium block mb-1">Campaign</label>
          <div className="inline-flex rounded-lg border border-ed-line bg-ed-bg p-0.5 mb-2">
            {[
              ['existing', 'Existing'],
              ['new', 'New'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => updateSectionField('campaign_mode', mode)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  campaignMode === mode ? 'bg-white text-ed-accent shadow-sm' : 'text-ed-ink2 hover:text-ed-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {campaignMode === 'new' ? (
            <input
              type="text"
              value={sectionFields.new_campaign_name || ''}
              onChange={e => updateSectionField('new_campaign_name', e.target.value)}
              placeholder="New campaign name..."
              className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ed-accent/20"
            />
          ) : (
            <select
              value={sectionFields.campaign_id || ''}
              onChange={e => updateSectionField('campaign_id', e.target.value)}
              className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-ed-accent/20 cursor-pointer"
            >
              <option value="">Select a campaign...</option>
              {safeCampaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="text-[10px] text-ed-ink2 font-medium block mb-1">Ad Set Name</label>
          <input
            type="text"
            value={sectionFields.ad_set_name || ''}
            onChange={e => updateSectionField('ad_set_name', e.target.value)}
            className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ed-accent/20"
          />
        </div>
        <div>
          <label className="text-[10px] text-ed-ink2 font-medium block mb-1">Ad Name</label>
          <input
            type="text"
            value={sectionFields.ad_name || ''}
            onChange={e => updateSectionField('ad_name', e.target.value)}
            className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ed-accent/20"
          />
          {isFlex && (
            <p className="text-[10px] text-ed-ink3 mt-1">This updates the top-level ad name for the grouped card. Individual image names can still be edited in Ad Names.</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button onClick={cancelSectionEdit}
            className="px-2.5 py-1 rounded-md text-[11px] text-ed-ink2 hover:bg-ed-bg transition-colors">Cancel</button>
          <button
            onClick={() => savePlacementSection({ id, cardKey, isFlex, currentAdSetId, currentDeployment })}
            disabled={savingSection === saveKey}
            className="px-3 py-1 rounded-md text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
          >
            {savingSection === saveKey ? 'Saving...' : 'Save Placement'}
          </button>
        </div>
      </div>
    );
  };

  const EditableTextListSection = ({ value, sectionLabel, helper, cardKey, sectionId, id, isFlex, field }) => {
    const items = parseTextList(value);
    const allText = items.join('\n\n');
    const allCopied = items.length > 0 && items.every((_, i) => copiedItems.has(`${cardKey}-${sectionId}-${i}`));
    const editKey = sectionEditKey(cardKey, field);
    const isEditing = editingSection === editKey;
    const generationCount = generationCounts[editKey] || 5;
    const generatingAll = generatingSection === `${editKey}:all`;
    const itemLabel = field === 'primary_texts' ? 'primary text' : 'headline';

    const handleCopyItem = (text, label, index) => {
      copyToClipboard(text, label);
      setCopiedItems(prev => new Set(prev).add(`${cardKey}-${sectionId}-${index}`));
    };

    const handleCopyAll = () => {
      copyToClipboard(allText, 'All ' + sectionId);
      const next = new Set(copiedItems);
      items.forEach((_, i) => next.add(`${cardKey}-${sectionId}-${i}`));
      setCopiedItems(next);
    };

    return (
      <div className="border border-ed-line rounded-xl p-4 bg-ed-surface">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-widest mb-1">{sectionLabel}</span>
            {helper && <p className="text-[11px] text-ed-ink2 mt-0.5 leading-relaxed">{helper}</p>}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
            {!isEditing && !isPoster && (
              <div className="inline-flex items-center gap-1 rounded-lg border border-ed-line bg-white px-1.5 py-1">
                <select
                  value={generationCount}
                  onChange={(e) => setGenerationCounts(prev => ({ ...prev, [editKey]: Number(e.target.value) }))}
                  className="bg-transparent text-[10px] text-ed-ink2 focus:outline-none"
                  aria-label={`Number of ${itemLabel} variations to generate`}
                >
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    generateTextSection({ id, cardKey, isFlex, field, currentItems: items });
                  }}
                  disabled={!!generatingSection || !!savingSection}
                  className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-ed-green text-white hover:bg-ed-green/90 transition-colors disabled:opacity-50"
                >
                  {generatingAll ? 'Generating...' : 'Generate'}
                </button>
              </div>
            )}
            {!isEditing && items.length > 0 && (
              <button onClick={(e) => { e.stopPropagation(); handleCopyAll(); }}
                className={`inline-flex items-center gap-1 rounded-md font-medium hover:bg-ed-accent/10 transition-colors px-2 py-1 text-[10px] ${
                  allCopied ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-accent/5 text-ed-accent'
                }`}>
                {allCopied ? 'All Copied' : 'Copy All'}
              </button>
            )}
            {!isEditing && (
              <SectionEditButton
                onClick={() => startSectionEdit(cardKey, field, { items })}
                label={items.length > 0 ? 'Edit' : 'Add'}
              />
            )}
          </div>
        </div>

        {isEditing ? (
          <div className="space-y-2">
            {(sectionFields.items || ['']).map((text, i) => (
              <div key={i} className="flex items-start gap-2">
                <textarea
                  value={text}
                  onChange={e => updateSectionArrayItem('items', i, e.target.value)}
                  rows={field === 'primary_texts' ? 3 : 1}
                  className="flex-1 text-[13px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ed-accent/20 resize-y"
                />
                <button
                  onClick={() => removeSectionArrayItem('items', i)}
                  className="px-2 py-1 rounded-md text-[10px] text-ed-rust hover:bg-ed-rust/10"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              onClick={() => addSectionArrayItem('items')}
              className="px-2.5 py-1 rounded-md text-[11px] text-ed-accent hover:bg-ed-accent/10 transition-colors"
            >
              Add variation
            </button>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button onClick={cancelSectionEdit}
                className="px-2.5 py-1 rounded-md text-[11px] text-ed-ink2 hover:bg-ed-bg transition-colors">Cancel</button>
              <button
                onClick={() => saveTextSection({ id, cardKey, isFlex, field })}
                disabled={savingSection === editKey}
                className="px-3 py-1 rounded-md text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
              >
                {savingSection === editKey ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        ) : items.length > 0 ? (
          <div className="space-y-2">
            {items.map((text, i) => {
              const itemKey = `${cardKey}-${sectionId}-${i}`;
              const isCopied = copiedItems.has(itemKey);
              return (
                <div key={i} className={`flex items-start gap-2.5 rounded-lg p-3 transition-all duration-300 ${isCopied ? 'bg-ed-green/5 border border-ed-green/10' : 'bg-ed-bg'}`}>
                  <span className={`text-[12px] font-bold rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors duration-300 ${
                    isCopied ? 'bg-ed-green text-white' : 'bg-ed-accent text-white'
                  }`}>{isCopied ? '✓' : i + 1}</span>
                  <div className={`flex-1 text-[13px] whitespace-pre-wrap leading-relaxed transition-all duration-300 ${
                    isCopied ? 'line-through text-ed-ink2/60 decoration-ed-green/40' : 'text-ed-ink'
                  }`}>{text}</div>
                  <button onClick={(e) => { e.stopPropagation(); handleCopyItem(text, 'Copy', i); }}
                    className={`inline-flex items-center gap-1 rounded-md font-medium transition-colors flex-shrink-0 px-1.5 py-0.5 text-[9px] ${
                      isCopied ? 'bg-ed-green/10 text-ed-green hover:bg-ed-green/15' : 'bg-ed-accent/5 text-ed-accent hover:bg-ed-accent/10'
                    }`}>
                    {isCopied ? 'Copied' : 'Copy'}
                  </button>
                  {!isPoster && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        generateTextSection({ id, cardKey, isFlex, field, currentItems: items, replaceIndex: i });
                      }}
                      disabled={!!generatingSection || !!savingSection}
                      className="inline-flex items-center gap-1 rounded-md font-medium transition-colors flex-shrink-0 px-1.5 py-0.5 text-[9px] bg-ed-green/10 text-ed-green hover:bg-ed-green/15 disabled:opacity-50"
                    >
                      {generatingSection === `${editKey}:replace-${i}` ? 'Regenerating...' : 'Regenerate'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[12px] text-ed-ink3 italic">No {itemLabel} variations yet.</p>
        )}
      </div>
    );
  };

  const AdNamesSection = ({ flexAd, cardKey, childDeps }) => {
    if (isPoster) return null;
    const editKey = sectionEditKey(cardKey, 'ad_names');
    const isEditing = editingSection === editKey;
    return (
      <div className="border border-ed-line rounded-xl p-4 bg-ed-surface">
        <div className="flex items-center justify-between mb-3">
          <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-widest">Ad Names</span>
          {!isEditing && (
            <SectionEditButton
              onClick={() => {
                const names = {};
                childDeps.forEach(d => { names[d.id] = d.ad_name || d.ad?.headline || ''; });
                startSectionEdit(cardKey, 'ad_names', { names });
              }}
            />
          )}
        </div>
        {isEditing ? (
          <div className="space-y-2">
            {childDeps.map((d, i) => (
              <div key={d.id} className="grid grid-cols-[36px_1fr] gap-2 items-center">
                {d.imageUrl ? <img src={d.imageUrl} alt="" className="w-9 h-9 object-cover rounded-lg bg-ed-bg" loading="lazy" /> : <div className="w-9 h-9 rounded-lg bg-ed-bg" />}
                <input
                  type="text"
                  value={sectionFields.names?.[d.id] || ''}
                  onChange={e => updateSectionField('names', { ...(sectionFields.names || {}), [d.id]: e.target.value })}
                  placeholder={`Ad ${i + 1} name`}
                  className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ed-accent/20"
                />
              </div>
            ))}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button onClick={cancelSectionEdit}
                className="px-2.5 py-1 rounded-md text-[11px] text-ed-ink2 hover:bg-ed-bg transition-colors">Cancel</button>
              <button
                onClick={() => saveAdNamesSection(flexAd, cardKey)}
                disabled={savingSection === editKey}
                className="px-3 py-1 rounded-md text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
              >
                {savingSection === editKey ? 'Saving...' : 'Save Ad Names'}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {childDeps.map((d, i) => (
              <div key={d.id} className="text-[12px] text-ed-ink bg-ed-bg rounded-lg px-3 py-2">
                <span className="text-ed-ink2">Ad {i + 1}: </span>
                <span className="font-semibold">{d.ad_name || d.ad?.headline || 'Unnamed ad'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // "Post in" section: Campaign + Ad Set + Ad Name
  const PostInSection = ({ campaignName, adSetName, duplicateAdSetName, adName, cardKey, onEdit, editContent }) => {
    if (!campaignName && !adSetName) {
      return (
        <div className="bg-[rgba(56,166,56,0.06)] border-2 border-ed-accent/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <svg className="w-5 h-5 text-ed-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span className="text-[13px] font-bold text-ed-accent">Not Assigned to a Campaign</span>
          </div>
          <p className="text-[12px] text-ed-ink2">This ad hasn't been assigned to a campaign and ad set yet. Send it back to the Planner to assign it.</p>
        </div>
      );
    }

    const adsetKey = `${cardKey}-adset`;
    const adnameKey = `${cardKey}-adname`;
    const adsetCopied = copiedItems.has(adsetKey);
    const adnameCopied = copiedItems.has(adnameKey);

    return (
      <div className="bg-ed-accent/5 border-2 border-ed-accent/15 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <span className="inline-block px-2 py-0.5 rounded bg-ed-accent text-white text-[10px] font-bold uppercase tracking-widest">Post This Ad In</span>
          {!editContent && <SectionEditButton onClick={onEdit} />}
        </div>
        <div className="space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-wider w-20 text-center flex-shrink-0">Campaign</span>
            <span className="text-[15px] font-bold text-ed-ink">{campaignName}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-wider w-20 text-center flex-shrink-0">Ad Set</span>
            <span className={`text-[15px] font-bold flex-1 transition-all duration-300 ${adsetCopied ? 'line-through text-ed-ink2/60 decoration-ed-green/40' : 'text-ed-ink'}`}>{adSetName}</span>
            <CopyTrackBtn itemKey={adsetKey} text={adSetName} label="Ad Set Name" />
          </div>
          {adName && (
            <div className="flex items-center gap-3">
              <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-wider w-20 text-center flex-shrink-0">Ad Name</span>
              <span className={`text-[15px] font-bold flex-1 transition-all duration-300 ${adnameCopied ? 'line-through text-ed-ink2/60 decoration-ed-green/40' : 'text-ed-ink'}`}>{adName}</span>
              <CopyTrackBtn itemKey={adnameKey} text={adName} label="Ad Name" />
            </div>
          )}
        </div>
        {editContent}
      </div>
    );
  };

  // Website URL section — big, clear, prominent
  // Website URL section — supports single URL or multiple URLs (gauntlet/legacy)
  // urls: optional array of { url, label?, score?, type? } for multiple URLs
  // flexAdId + usedIndices + onMarkUsed: optional, for cross-out tracking on flex ads
  const WebsiteUrlSection = ({ url, urls, cardKey, flexAdId, usedIndices = [], onMarkUsed, instructionText }) => {
    const hasMultiple = urls && urls.length > 0;
    if (!url && !hasMultiple) return null;

    // Single URL mode (individual deployments, or flex ads with just one URL)
    if (!hasMultiple) {
      const itemKey = `${cardKey}-url`;
      const isCopied = copiedItems.has(itemKey);
      const handleCopy = () => {
        copyToClipboard(url, 'Website URL');
        setCopiedItems(prev => new Set(prev).add(itemKey));
      };
      return (
        <div className={`border-2 rounded-xl p-4 transition-all duration-300 ${isCopied ? 'border-ed-green/25 bg-ed-green/5' : 'border-ed-accent/25 bg-[rgba(56,166,56,0.06)]'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-1 transition-colors duration-300 ${isCopied ? 'bg-ed-green/15 text-ed-green' : 'bg-[rgba(56,166,56,0.12)] text-ed-accent'}`}>Website URL</span>
              <p className="text-[11px] text-ed-ink2 mb-2">Paste this into the <strong>"Website URL"</strong> field in Ads Manager.</p>
              <div className={`bg-white rounded-lg px-3 py-2 border transition-all duration-300 ${isCopied ? 'border-ed-green/20' : 'border-ed-accent/20'}`}>
                <a href={url} target="_blank" rel="noopener noreferrer"
                  className={`text-[13px] font-medium hover:underline break-all transition-all duration-300 ${isCopied ? 'line-through text-ed-ink2/60 decoration-ed-green/40' : 'text-ed-accent'}`}
                >{url}</a>
              </div>
            </div>
            <button onClick={handleCopy}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-white text-[11px] font-bold transition-colors flex-shrink-0 shadow-sm ${isCopied ? 'bg-ed-green hover:bg-ed-green/90' : 'bg-ed-accent hover:bg-ed-accent/90'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isCopied
                  ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                }
              </svg>
              {isCopied ? 'Copied' : 'Copy URL'}
            </button>
          </div>
        </div>
      );
    }

    // Multiple URLs mode (gauntlet + legacy + PDP)
    const anyCopied = urls.some((_, i) => copiedItems.has(`${cardKey}-url-${i}`));
    return (
      <div className={`border-2 rounded-xl p-4 transition-all duration-300 ${anyCopied ? 'border-ed-green/25 bg-ed-green/5' : 'border-ed-accent/25 bg-[rgba(56,166,56,0.06)]'}`}>
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-1 transition-colors duration-300 ${anyCopied ? 'bg-ed-green/15 text-ed-green' : 'bg-[rgba(56,166,56,0.12)] text-ed-accent'}`}>Website URL</span>
        <p className="text-[11px] text-ed-ink2 mb-2">Paste into the <strong>"Website URL"</strong> field in Ads Manager.</p>
        <div className="space-y-1.5">
          {urls.map((entry, i) => {
            const itemKey = `${cardKey}-url-${i}`;
            const isCopied = copiedItems.has(itemKey);
            const isUsed = usedIndices.includes(i);
            const handleCopy = async () => {
              copyToClipboard(entry.url, entry.label || `URL ${i + 1}`);
              setCopiedItems(prev => new Set(prev).add(itemKey));
              if (onMarkUsed && !isUsed) onMarkUsed(i);
            };
            return (
              <div key={i} className={`flex items-center gap-2 ${isUsed ? 'opacity-50' : ''}`}>
                <span className="text-[10px] text-ed-ink2 w-6 flex-shrink-0 font-medium">{i + 1}.</span>
                {entry.label && <span className="text-[10px] text-ed-ink2 flex-shrink-0 w-28 truncate">{entry.label}</span>}
                {entry.score != null && <span className="text-[10px] text-ed-green flex-shrink-0">({entry.score}/10)</span>}
                <div className={`flex-1 min-w-0 bg-white rounded-lg px-2.5 py-1.5 border transition-all duration-300 ${isCopied ? 'border-ed-green/20' : 'border-ed-accent/20'}`}>
                  <a href={entry.url} target="_blank" rel="noopener noreferrer"
                    className={`text-[12px] font-medium hover:underline break-all transition-all duration-300 ${isCopied || isUsed ? 'line-through text-ed-ink2/60' : 'text-ed-accent'}`}>
                    {entry.url}
                  </a>
                </div>
                <button onClick={handleCopy}
                  className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-white text-[10px] font-bold transition-colors flex-shrink-0 shadow-sm ${isCopied ? 'bg-ed-green hover:bg-ed-green/90' : 'bg-ed-accent hover:bg-ed-accent/90'}`}>
                  {isCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            );
          })}
        </div>
        {instructionText && (
          <p className="text-[10px] text-ed-ink2 italic pt-2">{instructionText}</p>
        )}
      </div>
    );
  };

  // Call to Action section — clear
  const CallToActionSection = ({ cta }) => {
    if (!cta) return null;
    return (
      <div className="border border-ed-line rounded-xl p-4 bg-ed-surface">
        <span className="inline-block px-2 py-0.5 rounded bg-ed-green/10 text-ed-green text-[10px] font-bold uppercase tracking-widest mb-1">Call to Action</span>
        <p className="text-[11px] text-ed-ink2 mb-2">Select <strong>"{cta.replace(/_/g, ' ')}"</strong> from the "Call to Action" dropdown in Ads Manager.</p>
        <span className="inline-block px-4 py-1.5 rounded-full bg-ed-green/10 text-ed-green text-[14px] font-bold border border-ed-green/20">
          {cta.replace(/_/g, ' ')}
        </span>
      </div>
    );
  };

  // Display Link section — shown instead of website URL in ad
  const DisplayLinkSection = ({ displayLink, cardKey }) => {
    if (!displayLink || !displayLink.trim()) return null;
    const itemKey = `${cardKey}-displaylink`;
    const isCopied = copiedItems.has(itemKey);
    const handleCopy = () => {
      copyToClipboard(displayLink, 'Display Link');
      setCopiedItems(prev => new Set(prev).add(itemKey));
    };
    return (
      <div className={`border-2 rounded-xl p-4 transition-all duration-300 ${isCopied ? 'border-ed-green/15 bg-ed-green/5' : 'border-ed-accent/15 bg-ed-accent/5'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-1 transition-colors duration-300 ${isCopied ? 'bg-ed-green/15 text-ed-green' : 'bg-ed-accent/10 text-ed-accent'}`}>Display Link</span>
            <p className="text-[11px] text-ed-ink2 mb-2">Enter this into the <strong>"Display Link"</strong> field in Ads Manager (under the Website URL).</p>
            <div className={`bg-white rounded-lg px-3 py-2 border transition-all duration-300 ${isCopied ? 'border-ed-green/15' : 'border-ed-accent/15'}`}>
              <span className={`text-[13px] font-medium break-all transition-all duration-300 ${isCopied ? 'line-through text-ed-ink2/60 decoration-ed-green/40' : 'text-ed-accent'}`}>{displayLink}</span>
            </div>
          </div>
          <button onClick={handleCopy}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-white text-[11px] font-bold transition-colors flex-shrink-0 shadow-sm ${isCopied ? 'bg-ed-green hover:bg-ed-green/90' : 'bg-ed-accent hover:bg-ed-accent/90'}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isCopied
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              }
            </svg>
            {isCopied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    );
  };

  // Facebook Page section — which page to post from
  const FacebookPageSection = ({ page }) => {
    if (!page) return null;
    return (
      <div className="border-2 border-ed-accent/15 bg-ed-accent/5 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-widest mb-1">Facebook Page</span>
            <p className="text-[11px] text-ed-ink2 mb-2">Make sure you are posting from the correct Facebook Page. Select <strong>"{page}"</strong> as your Page identity in Ads Manager.</p>
            <div className="bg-white rounded-lg px-3 py-2 border border-ed-accent/15">
              <span className="text-[14px] font-bold text-ed-ink">{page}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Notes section — editable textarea at the bottom of cards
  const NotesSection = ({ notes, cardKey, depId, isFlexCard = false }) => {
    const isEditing = editingNotes === cardKey;
    return (
      <div className="border border-ed-line rounded-xl p-4 bg-ed-surface">
        <div className="flex items-center justify-between mb-2">
          <span className="inline-block px-2 py-0.5 rounded bg-ed-bg text-ed-ink2 text-[10px] font-bold uppercase tracking-widest">Notes</span>
          {!isEditing && (
            <button
              onClick={() => startEditingNotes(cardKey, notes)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-ed-ink2 hover:text-ed-ink hover:bg-ed-bg transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
              Edit
            </button>
          )}
        </div>
        {isEditing ? (
          <div>
            <textarea
              value={notesValue}
              onChange={e => setNotesValue(e.target.value)}
              placeholder="Add notes..."
              rows={3}
              className="w-full text-[13px] text-ed-ink bg-ed-bg border border-ed-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ed-accent/20 resize-y"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 mt-2">
              <button
                onClick={() => setEditingNotes(null)}
                className="px-2.5 py-1 rounded-md text-[11px] text-ed-ink2 hover:bg-ed-bg transition-colors"
              >Cancel</button>
              <button
                onClick={() => saveNotes(depId, isFlexCard)}
                disabled={savingNotes}
                className="px-3 py-1 rounded-md text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
              >{savingNotes ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => startEditingNotes(cardKey, notes)}
            className="cursor-pointer rounded-lg px-3 py-2 bg-ed-bg min-h-[2.5rem] hover:bg-ed-accent/5 transition-colors"
          >
            {notes ? (
              <p className="text-[13px] text-ed-ink whitespace-pre-wrap">{notes}</p>
            ) : (
              <p className="text-[12px] text-ed-ink3 italic">Click to add notes...</p>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Admin Edit Panel ──────────────────────────────────────────────────────

  const EditPanel = ({ cardKey, id, isFlex = false }) => {
    if (editingCard !== cardKey || isPoster) return null;
    const nameKey = isFlex ? 'name' : 'ad_name';
    const headlineKey = isFlex ? 'headlines' : 'ad_headlines';

    return (
      <div className="border-2 border-ed-accent/30 bg-[rgba(56,166,56,0.06)] rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[rgba(56,166,56,0.12)] text-ed-accent text-[10px] font-bold uppercase tracking-widest">
            <EditPencilIcon /> Edit Ad Details
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => { setEditingCard(null); setEditFields({}); }}
              className="px-2.5 py-1 rounded-md text-[11px] text-ed-ink2 hover:bg-ed-bg transition-colors">Cancel</button>
            <button onClick={() => saveEditing(id, isFlex)} disabled={savingEdit}
              className="px-3 py-1 rounded-md text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50">
              {savingEdit ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>

        {!isFlex && (
          <div>
            <label className="text-[10px] text-ed-ink2 font-medium block mb-1">Ad Name</label>
            <input type="text" value={editFields[nameKey] || ''} onChange={e => updateEditField(nameKey, e.target.value)}
              className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ed-accent/20" />
          </div>
        )}

        {/* Campaign */}
        <div>
          <label className="text-[10px] text-ed-ink2 font-medium block mb-1">Campaign</label>
          <select
            value={isFlex ? (editFields._campaign_id || '') : (editFields.local_campaign_id || '')}
            onChange={e => {
              const campId = e.target.value;
              if (isFlex) {
                updateEditField('_campaign_id', campId);
              } else {
                updateEditField('local_campaign_id', campId);
              }
            }}
            className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-ed-accent/20 cursor-pointer"
          >
            <option value="">Select a campaign...</option>
            {safeCampaigns.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Ad Set Name */}
        <div>
          <label className="text-[10px] text-ed-ink2 font-medium block mb-1">Ad Set Name</label>
          <input type="text" value={editFields._ad_set_name || ''} onChange={e => updateEditField('_ad_set_name', e.target.value)}
            className="w-full text-[12px] text-ed-ink bg-white border border-ed-line rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ed-accent/20" placeholder="Type ad set name..." />
          <p className="text-[10px] text-ed-ink3 mt-0.5">Type a name. If it matches an existing ad set, it will be reused. Otherwise a new one is created.</p>
        </div>

        {/* Save/Cancel bottom */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-ed-accent/20">
          <button onClick={() => { setEditingCard(null); setEditFields({}); }}
            className="px-3 py-1.5 rounded-md text-[11px] text-ed-ink2 hover:bg-ed-bg transition-colors">Cancel</button>
          <button onClick={() => saveEditing(id, isFlex)} disabled={savingEdit}
            className="px-4 py-1.5 rounded-md text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50">
            {savingEdit ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    );
  };

  // ── Card Renderers ──────────────────────────────────────────────────────

  // Single ad card — collapsed by default, shows name + campaign + ad set at top
  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const isMarking = markingPostedIds.has(dep.id);
    const isSendingBack = sendingBackIds.has(dep.id);
    const { campaignName, adSetName } = resolveLocation(dep);
    const isExpanded = expandedCards.has(dep.id);
    const placementEditKey = sectionEditKey(dep.id, 'placement');

    return (
      <div key={dep.id} className="border border-ed-line rounded-xl bg-white overflow-hidden">
        {/* Always-visible header: Ad Name, Campaign, Ad Set */}
        <div className="px-5 py-4 space-y-3">
          {/* Ad Name + Format badge */}
          <div className="flex items-start justify-between gap-3">
            {!isPoster && (
              <label className="flex-shrink-0 mt-1 cursor-pointer" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedCards.has(dep.id)}
                  onChange={() => toggleCardSelection(dep.id, 'single')}
                  className="rounded border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20 w-4 h-4"
                />
              </label>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[14px] leading-tight mb-1.5">
                <span className="text-ed-ink2 font-medium">Ad Name: </span>
                <span className="font-bold text-ed-ink">{name}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[9px] font-bold uppercase tracking-wider">Ad Format: Single Image</span>
              </div>
            </div>
            {thumbUrl && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setPreviewImage(dep); }}
                className="w-14 h-14 rounded-xl bg-ed-bg flex-shrink-0 overflow-hidden cursor-zoom-in"
                title="Preview image"
              >
                <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
              </button>
            )}
          </div>

          <OriginMeta
            source={dep.ready_source || ''}
            timestamp={resolveReadyTimestamp(dep)}
            fallbackName={name}
            angleName={resolveAngleName(dep)}
          />

          {dep.meta_post_error && (
            <div className="mt-3 rounded-lg border border-ed-rust/30 bg-ed-rust/10 px-3 py-2 text-[11px] text-ed-rust">
              Meta posting issue: {dep.meta_post_error}
            </div>
          )}

          {/* Campaign + Ad Set + Duplicate Ad Set — always visible */}
          <PostInSection
            campaignName={campaignName}
            adSetName={adSetName}
            duplicateAdSetName={dep.duplicate_adset_name}
            adName={name}
            cardKey={dep.id}
            onEdit={() => startSectionEdit(dep.id, 'placement', {
              campaign_mode: 'existing',
              campaign_id: dep.local_campaign_id || '',
              new_campaign_name: '',
              ad_set_name: adSetName || '',
              ad_name: name || '',
            })}
            editContent={editingSection === placementEditKey ? (
              <PlacementEditForm
                cardKey={dep.id}
                id={dep.id}
                isFlex={false}
                currentAdSetId={dep.local_adset_id || ''}
                currentDeployment={dep}
              />
            ) : null}
          />

          {/* Expand/Collapse toggle */}
          <button
            onClick={() => toggleCardExpanded(dep.id)}
            className="flex items-center justify-center w-full gap-1 text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 py-1.5 rounded-md cursor-pointer transition-all mt-2"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {isExpanded ? 'Hide Ad Details' : 'Show Ad Details'}
            {!isExpanded && (
              <span className="text-[10px] text-ed-accent/70 font-normal">
                ({[thumbUrl && 'Image', dep.primary_texts && parseCount(dep.primary_texts) > 0 && 'Primary Text', dep.ad_headlines && parseCount(dep.ad_headlines) > 0 && 'Headline', 'Notes'].filter(Boolean).join(', ')})
              </span>
            )}
          </button>
        </div>

        {/* Collapsible details */}
        {isExpanded && (
          <div className="px-5 pb-5 space-y-4 border-t border-ed-line pt-4">
            {/* Image */}
            {thumbUrl && (
              <div className="border border-ed-line rounded-xl p-4 bg-ed-surface">
                <div className="flex items-center justify-between mb-3">
                  <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-widest">Ad Creative</span>
                  <button onClick={() => downloadSingleImage(dep)} disabled={downloadingSingle.has(dep.id)}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-ed-accent text-white text-[12px] font-bold hover:bg-ed-accent/90 transition-colors disabled:opacity-50 shadow-sm"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {downloadingSingle.has(dep.id) ? 'Downloading...' : 'Download Image'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewImage(dep)}
                  className="block w-full max-w-[150px] rounded-xl bg-ed-bg overflow-hidden cursor-zoom-in"
                  title="Preview image"
                >
                  <img src={thumbUrl} alt="" className="w-full rounded-xl bg-ed-bg" loading="lazy" />
                </button>
              </div>
            )}

            {/* Primary Text */}
            <EditableTextListSection
              value={dep.primary_texts}
              sectionLabel={`Primary Text — ${parseCount(dep.primary_texts)} Variation${parseCount(dep.primary_texts) !== 1 ? 's' : ''}`}
              helper='Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.'
              cardKey={dep.id}
              sectionId="primary"
              id={dep.id}
              isFlex={false}
              field="primary_texts"
            />

            {/* Headline */}
            <EditableTextListSection
              value={dep.ad_headlines}
              sectionLabel={`Headline — ${parseCount(dep.ad_headlines)} Variation${parseCount(dep.ad_headlines) !== 1 ? 's' : ''}`}
              helper='Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.'
              cardKey={dep.id}
              sectionId="headline"
              id={dep.id}
              isFlex={false}
              field="ad_headlines"
            />

            {/* Notes */}
            <NotesSection notes={dep.notes} cardKey={dep.id} depId={dep.id} />
          </div>
        )}

        {/* Actions — always visible */}
        <div className="px-5 py-3.5 border-t border-ed-line bg-ed-bg/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {!isPoster && (
              <button onClick={() => handleSendBack(dep.id)} disabled={isSendingBack}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ed-ink2 hover:text-ed-ink hover:bg-ed-bg transition-colors disabled:opacity-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                {isSendingBack ? 'Sending...' : 'Send Back to Planner'}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!isPoster && (
              <button
                type="button"
                onClick={() => openPostToMetaModal([{ type: 'single', id: dep.id, label: name || 'Ready ad', count: 1 }])}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-white bg-ed-accent hover:bg-ed-accent/90 transition-colors shadow-sm"
              >
                Post to Meta
              </button>
            )}
            {confirmPosted === dep.id ? (
              <div className="flex items-center gap-2">
                <button onClick={() => setConfirmPosted(null)} className="px-2.5 py-1.5 rounded-lg text-[11px] text-ed-ink2 hover:bg-white transition-colors">Cancel</button>
                <button onClick={() => handleMarkPosted(dep.id)} disabled={isMarking}
                  className="px-4 py-2 rounded-lg text-[12px] font-bold bg-ed-green text-white hover:bg-ed-green/90 transition-colors disabled:opacity-50"
                >{isMarking ? 'Updating...' : 'Confirm Manual Post'}</button>
              </div>
            ) : (
              <button onClick={() => setConfirmPosted(dep.id)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-ed-green bg-ed-green/10 hover:bg-ed-green/15 border border-ed-green/30 transition-colors shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mark as Posted Manually
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Flex ad card — collapsed by default, shows name + campaign + ad set at top
  const renderFlexCard = (flexAd) => {
    const childDeps = getFlexChildDeps(flexAd);
    if (childDeps.length === 0) return null;

    const flexId = `flex-${flexAd.id}`;
    const isMarking = markingPostedIds.has(flexId);
    const isSendingBack = sendingBackIds.has(flexId);
    const { campaignName, adSetName } = resolveFlexLocation(flexAd);
    const cardKey = flexId;
    const selected = selectedImages[cardKey] || new Set();
    const depsWithImages = childDeps.filter(d => d.imageUrl);
    const allSelected = depsWithImages.length > 0 && depsWithImages.every(d => selected.has(d.id));
    const someSelected = selected.size > 0;
    const isDownloadingAll = downloadingAll.has(cardKey);
    const isDownloadingSelected = downloadingSelected.has(cardKey);
    const isExpanded = expandedCards.has(flexId);
    const placementEditKey = sectionEditKey(flexId, 'placement');
    const childPostErrors = childDeps.map(d => d.meta_post_error).filter(Boolean);

    return (
      <div
        key={flexAd.id}
        ref={flexAd.id === highlightedId ? highlightRef : undefined}
        className={`border rounded-xl bg-white overflow-hidden transition-all duration-700 ${flexAd.id === highlightedId ? 'border-ed-accent ring-2 ring-ed-accent/30' : 'border-ed-line'}`}
      >
        {/* Always-visible header: Ad Name, Campaign, Ad Set */}
        <div className="px-5 py-4 space-y-3">
          {/* Ad Name + Format badge + small thumbnails */}
          <div className="flex items-start justify-between gap-3">
            {!isPoster && (
              <label className="flex-shrink-0 mt-1 cursor-pointer" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedCards.has(flexId)}
                  onChange={() => toggleCardSelection(flexId, 'flex')}
                  className="rounded border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20 w-4 h-4"
                />
              </label>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[14px] leading-tight mb-1.5">
                <span className="text-ed-ink2 font-medium">Ad Set: </span>
                <span className="font-bold text-ed-ink">{flexAd.name || 'Ad Set'}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[9px] font-bold uppercase tracking-wider">
                  Ad Set: Multiple Ads
                  <InfoTooltip text="This card groups several ads that will be posted under the same campaign and Meta ad set." position="right" />
                </span>
              </div>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              {childDeps.slice(0, 3).map(d => d.imageUrl ? (
                <img key={d.id} src={d.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg bg-ed-bg" loading="lazy" />
              ) : (
                <div key={d.id} className="w-10 h-10 rounded-lg bg-ed-line" />
              ))}
              {childDeps.length > 3 && (
                <div className="w-10 h-10 rounded-lg bg-ed-bg flex items-center justify-center text-[10px] text-ed-ink3 font-medium">+{childDeps.length - 3}</div>
              )}
            </div>
          </div>

          <OriginMeta
            source={flexAd.ready_source || ''}
            timestamp={resolveReadyTimestamp(flexAd, childDeps)}
            fallbackName={flexAd.name || ''}
            angleName={resolveAngleName(flexAd, childDeps)}
          />

          {childPostErrors.length > 0 && (
            <div className="mt-3 rounded-lg border border-ed-rust/30 bg-ed-rust/10 px-3 py-2 text-[11px] text-ed-rust">
              Meta posting issue: {childPostErrors[0]}
            </div>
          )}

          {/* Campaign + Ad Set + Duplicate Ad Set — always visible */}
          <PostInSection
            campaignName={campaignName}
            adSetName={adSetName}
            duplicateAdSetName={flexAd.duplicate_adset_name}
            adName={flexAd.ad_name || flexAd.name || 'Ad Set'}
            cardKey={flexId}
            onEdit={() => {
              const adSet = safeAdSets.find(a => a.id === flexAd.ad_set_id);
              startSectionEdit(flexId, 'placement', {
                campaign_mode: 'existing',
                campaign_id: adSet?.campaign_id || '',
                new_campaign_name: '',
                ad_set_name: adSet?.name || flexAd.name || '',
                ad_name: flexAd.ad_name || flexAd.name || '',
              });
            }}
            editContent={editingSection === placementEditKey ? (
              <PlacementEditForm
                cardKey={flexId}
                id={flexAd.id}
                isFlex
                currentAdSetId={flexAd.ad_set_id}
              />
            ) : null}
          />

          {/* Expand/Collapse toggle */}
          <button
            onClick={() => toggleCardExpanded(flexId)}
            className="flex items-center justify-center w-full gap-1 text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 py-1.5 rounded-md cursor-pointer transition-all mt-2"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {isExpanded ? 'Hide Ad Details' : 'Show Ad Details'}
            {!isExpanded && (
              <span className="text-[10px] text-ed-accent/70 font-normal">
                ({[depsWithImages.length > 0 && `${depsWithImages.length} Images`, flexAd.primary_texts && parseCount(flexAd.primary_texts) > 0 && 'Primary Text', flexAd.headlines && parseCount(flexAd.headlines) > 0 && 'Headline', 'Notes'].filter(Boolean).join(', ')})
              </span>
            )}
          </button>
        </div>

        {/* Collapsible details */}
        {isExpanded && (
          <div className="px-5 pb-5 space-y-4 border-t border-ed-line pt-4">
            {/* Ad Creatives with download */}
            <div className="border border-ed-line rounded-xl p-4 bg-ed-surface">
              <div className="mb-1">
                <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[10px] font-bold uppercase tracking-widest mb-1">
                  Ad Creatives — {depsWithImages.length} Image{depsWithImages.length !== 1 ? 's' : ''}
                </span>
                <p className="text-[11px] text-ed-ink2 mt-0.5 leading-relaxed">Upload ALL of these images. Meta will automatically rotate them and show the best-performing image to each person.</p>
              </div>

              {/* Download bar */}
              <div className="flex items-center gap-2 mt-3 mb-3">
                <button onClick={() => downloadMultipleImages(depsWithImages, cardKey)}
                  disabled={isDownloadingAll || depsWithImages.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-ed-accent text-white text-[13px] font-bold hover:bg-ed-accent/90 transition-colors disabled:opacity-50 shadow-sm"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {isDownloadingAll ? 'Zipping...' : `Download All Images (${depsWithImages.length})`}
                </button>
                {someSelected && (
                  <button onClick={() => { const selectedDeps = childDeps.filter(d => selected.has(d.id)); downloadMultipleImages(selectedDeps, `selected-${cardKey}`); }}
                    disabled={isDownloadingSelected}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[rgba(56,166,56,0.06)] text-ed-accent text-[11px] font-bold hover:bg-[rgba(56,166,56,0.12)] transition-colors disabled:opacity-50"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {isDownloadingSelected ? '...' : `Download Selected (${selected.size})`}
                  </button>
                )}
              </div>

              {/* Select All */}
              {depsWithImages.length > 1 && (
                <label className="flex items-center gap-2 mb-2.5 cursor-pointer select-none">
                  <input type="checkbox" checked={allSelected}
                    onChange={() => toggleSelectAll(cardKey, depsWithImages.map(d => d.id))}
                    className="rounded border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20 w-4 h-4" />
                  <span className="text-[12px] text-ed-ink2 font-medium">Select All</span>
                </label>
              )}

              {/* Image grid */}
              <div className="grid grid-cols-5 gap-2">
                {childDeps.map(d => {
                  const isSelected = selected.has(d.id);
                  const isSingleDl = downloadingSingle.has(d.id);
                  return (
                    <div key={d.id} className="relative group">
                      {d.imageUrl && (
                        <label className="absolute top-2 left-2 z-10 cursor-pointer">
                          <input type="checkbox" checked={isSelected}
                            onChange={() => toggleImageSelection(cardKey, d.id)}
                            className="rounded border-white/80 text-ed-accent focus:ring-ed-accent/20 w-4 h-4 shadow-sm" />
                        </label>
                      )}
                      {d.imageUrl ? (
                        <button
                          type="button"
                          onClick={() => setPreviewImage(d)}
                          className={`w-full aspect-square rounded-xl bg-ed-bg overflow-hidden cursor-zoom-in transition-all ${isSelected ? 'ring-2 ring-ed-accent ring-offset-2' : ''}`}
                          title="Preview image"
                        >
                          <img src={d.imageUrl} alt=""
                            className="w-full h-full object-cover"
                            loading="lazy" />
                        </button>
                      ) : (
                        <div className="w-full aspect-square rounded-xl bg-ed-bg" />
                      )}
                      {d.imageUrl && (
                        <button onClick={() => downloadSingleImage(d)} disabled={isSingleDl}
                          className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-white/90 text-ed-accent hover:bg-white shadow-sm opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity disabled:opacity-50"
                          title="Download this image">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </button>
                      )}
                      {!isPoster ? (
                        <div className="text-[10px] text-ed-ink2 mt-1 truncate">{d.ad_name || d.ad?.headline || ''}</div>
                      ) : (
                        <div className="text-[10px] text-ed-ink2 mt-1 truncate">{d.ad_name || d.ad?.headline || ''}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <AdNamesSection flexAd={flexAd} cardKey={cardKey} childDeps={childDeps} />

            {/* Primary Text */}
            <EditableTextListSection
              value={flexAd.primary_texts}
              sectionLabel={`Primary Text — ${parseCount(flexAd.primary_texts)} Variation${parseCount(flexAd.primary_texts) !== 1 ? 's' : ''}`}
              helper='Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.'
              cardKey={flexId}
              sectionId="primary"
              id={flexAd.id}
              isFlex
              field="primary_texts"
            />

            {/* Headline */}
            <EditableTextListSection
              value={flexAd.headlines}
              sectionLabel={`Headline — ${parseCount(flexAd.headlines)} Variation${parseCount(flexAd.headlines) !== 1 ? 's' : ''}`}
              helper='Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.'
              cardKey={flexId}
              sectionId="headline"
              id={flexAd.id}
              isFlex
              field="headlines"
            />

            {/* Notes */}
            <NotesSection notes={flexAd.notes} cardKey={flexId} depId={flexAd.id} isFlexCard />
          </div>
        )}

        {/* Actions — always visible */}
        <div className="px-5 py-3.5 border-t border-ed-line bg-ed-bg/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {!isPoster && (
              <button onClick={() => handleSendBackFlex(flexAd)} disabled={isSendingBack}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ed-ink2 hover:text-ed-ink hover:bg-ed-bg transition-colors disabled:opacity-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                {isSendingBack ? 'Sending...' : 'Send Back to Planner'}
              </button>
            )}
            {!isPoster && (
              <button onClick={() => setDeleteFlexConfirm(flexAd.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ed-rust hover:text-ed-rust hover:bg-ed-rust/10 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!isPoster && (
              <button
                type="button"
                onClick={() => openPostToMetaModal([{ type: 'flex', id: flexAd.id, label: flexAd.name || 'Ready ad set', count: childDeps.length }])}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-white bg-ed-accent hover:bg-ed-accent/90 transition-colors shadow-sm"
              >
                Post to Meta
              </button>
            )}
            {confirmPosted === flexId ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ed-ink2">{childDeps.length} ad{childDeps.length !== 1 ? 's' : ''}</span>
                <button onClick={() => setConfirmPosted(null)} className="px-2.5 py-1.5 rounded-lg text-[11px] text-ed-ink2 hover:bg-white transition-colors">Cancel</button>
                <button onClick={() => { setConfirmPosted(null); setMarkPostedModal({ flexAd, count: childDeps.length }); }} disabled={isMarking}
                  className="px-4 py-2 rounded-lg text-[12px] font-bold bg-ed-green text-white hover:bg-ed-green/90 transition-colors disabled:opacity-50"
                >{isMarking ? 'Updating...' : 'Pick date…'}</button>
              </div>
            ) : (
              <button onClick={() => setConfirmPosted(flexId)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-ed-green bg-ed-green/10 hover:bg-ed-green/15 border border-ed-green/30 transition-colors shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mark as Posted Manually
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ── Build flat sorted list ──────────────────────────────────────────────

  const buildCardList = () => {
    const cards = [];
    const flexChildIds = new Set();
    safeFlexAds.forEach(fa => {
      try { (fa.child_deployment_ids ? JSON.parse(fa.child_deployment_ids) : []).forEach(id => flexChildIds.add(id)); } catch { /* ignore */ }
    });
    readyDeps.forEach(dep => {
      if (flexChildIds.has(dep.id)) return;
      const { campaignName, adSetName } = resolveLocation(dep);
      cards.push({ type: 'single', dep, campaignName: campaignName || '', adSetName: adSetName || '', plannedDate: dep.planned_date || '', createdAt: dep.created_at || '', name: dep.ad_name || '', key: dep.id });
    });
    safeFlexAds.forEach(fa => {
      if (!flexHasReadyChildren(fa)) return;
      const { campaignName, adSetName } = resolveFlexLocation(fa);
      cards.push({ type: 'flex', flexAd: fa, campaignName: campaignName || '', adSetName: adSetName || '', plannedDate: fa.planned_date || '', createdAt: fa.created_at || '', name: fa.name || '', key: `flex-${fa.id}` });
    });
    // Sort based on selected sort option
    cards.sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        case 'oldest':
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        case 'campaign': {
          const aU = !a.campaignName, bU = !b.campaignName;
          if (aU !== bU) return aU ? -1 : 1;
          if (a.campaignName !== b.campaignName) return a.campaignName.localeCompare(b.campaignName);
          if (a.adSetName !== b.adSetName) return a.adSetName.localeCompare(b.adSetName);
          return 0;
        }
        case 'name':
          return a.name.localeCompare(b.name);
        default:
          return (b.createdAt || '').localeCompare(a.createdAt || '');
      }
    });
    return cards;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) return <div className="text-center py-12 text-ed-ink2 text-[13px]">Loading...</div>;

  if (loadError) {
    return (
      <div className="text-center py-16">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-ed-rust/10 flex items-center justify-center">
          <svg className="w-6 h-6 text-ed-rust" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <p className="text-[14px] font-medium text-ed-ink">Something went wrong</p>
        <p className="text-[12px] text-ed-ink2 mt-1">{loadError}</p>
        <button onClick={loadData} className="mt-4 px-4 py-2 rounded-lg bg-ed-accent text-white text-[12px] font-medium hover:bg-ed-accent/90 transition-colors">
          Try Again
        </button>
      </div>
    );
  }

  if (readyDeps.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-ed-accent/5 flex items-center justify-center">
          <svg className="w-6 h-6 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        </div>
        <p className="text-[14px] font-medium text-ed-ink">No ads ready to post</p>
        <p className="text-[12px] text-ed-ink2 mt-1">When ads are marked "Ready to Post" in the Planner, they'll appear here.</p>
      </div>
    );
  }

  const cardList = buildCardList();

  return (
    <div className="space-y-5">
      {/* Summary + Sort */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px]">
            <span className="font-bold text-ed-ink">{cardList.length}</span>
            <span className="text-ed-ink2 ml-1.5">ad{cardList.length !== 1 ? 's' : ''} ready to post</span>
          </div>
          <p className="text-[11px] text-ed-ink2 mt-0.5">These ads are ready to be posted in Meta Ads Manager. Expand each card to see the full details and copy the content.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="text-[12px] text-ed-ink bg-ed-bg border border-ed-line rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-ed-accent/20 cursor-pointer"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="campaign">Campaign → Ad Set</option>
            <option value="name">Name (A-Z)</option>
          </select>
        </div>
      </div>

      {/* Bulk actions toolbar — visible when cards are selected or for select all */}
      {!isPoster && cardList.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 bg-ed-bg rounded-xl">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selectedCards.size > 0 && selectedCards.size === cardList.length}
                onChange={() => {
                  if (selectedCards.size === cardList.length) {
                    setSelectedCards(new Map());
                  } else {
                    const all = new Map();
                    cardList.forEach(c => all.set(c.key, c.type));
                    setSelectedCards(all);
                  }
                }}
                className="rounded border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20 w-4 h-4"
              />
              <span className="text-[11px] text-ed-ink2 font-medium">
                {selectedCards.size === cardList.length ? 'Deselect All' : 'Select All'}
              </span>
            </label>
            {selectedCards.size > 0 && (
              <span className="text-[11px] text-ed-accent font-semibold">{selectedCards.size} selected</span>
            )}
          </div>
        </div>
      )}

      {!isPoster && selectedCards.size > 0 && !bulkDeleteConfirm && !postMetaModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed left-3 right-3 sm:left-1/2 sm:right-auto sm:w-fit sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 bottom-4 z-[70] flex flex-wrap items-center justify-center gap-2 rounded-xl border border-ed-accent/20 bg-ed-surface/95 px-3 py-2 shadow-lg shadow-ed-ink/10 backdrop-blur pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <span className="text-[11px] text-ed-accent font-semibold mr-1">{selectedCards.size} selected</span>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const items = selectedItemsForMetaPost();
              if (items.length === 0) {
                addToast('Selected ads are no longer available. Refreshing...', 'error');
                loadDeployments();
                return;
              }
              openPostToMetaModal(items);
            }}
            disabled={postingMeta}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
          >
            Post to Meta ({selectedCards.size})
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation();
              setBulkMarking(true);
              try {
                const { singleIds, flexIds, flexChildIds, deploymentIds } = resolveSelectedReadyCards();
                if (deploymentIds.size === 0) {
                  addToast('Selected ads are no longer available. Refreshing...', 'error');
                  await loadDeployments();
                  return;
                }
                const postedAt = new Date().toISOString();
                await Promise.all([
                  ...[...deploymentIds].map(id => api.updateDeploymentStatus(id, 'posted')),
                  ...[...flexIds].map(id => api.updateAdSetUnified(projectId, id, {
                    lifecycle_status: 'observing',
                    posted_at: postedAt,
                  }).catch(() => {})),
                ]);
                removeSelectedReadyCardsFromView({
                  singleIds,
                  flexIds,
                  flexChildIds,
                  status: 'posted',
                  postedAt,
                });
                addToast(`Marked ${selectedCards.size} ad${selectedCards.size !== 1 ? 's' : ''} as posted manually`, 'success');
                loadDeployments();
              } catch {
                addToast('Failed to mark as posted manually', 'error');
              } finally {
                setBulkMarking(false);
              }
            }}
            disabled={bulkMarking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-ed-green text-white hover:bg-ed-green/90 transition-colors disabled:opacity-50"
          >
            {bulkMarking ? 'Marking...' : `Mark as Posted Manually (${selectedCards.size})`}
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setBulkDeleteConfirm(true); }}
            disabled={bulkDeleting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ed-rust border border-ed-rust/30 hover:bg-ed-rust/10 transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {bulkDeleting ? 'Deleting...' : `Delete (${selectedCards.size})`}
          </button>
        </div>,
        document.body
      )}

      {/* Cards */}
      <div className="space-y-5">
        {cardList.map(card => card.type === 'single' ? renderAdCard(card.dep) : renderFlexCard(card.flexAd))}
      </div>

      <ConfirmDialog
        open={deleteFlexConfirm !== null}
        title="Remove Ad Set from Ready to Post?"
        message="This removes the ad set from Ready to Post and returns its child ads to the pipeline. The original generated ads stay in Ad Studio."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() => handleDeleteFlexAd(deleteFlexConfirm)}
        onCancel={() => setDeleteFlexConfirm(null)}
      />

      <ConfirmDialog
        open={bulkDeleteConfirm}
        title={`Delete ${selectedCards.size} ad${selectedCards.size !== 1 ? 's' : ''}?`}
        message="This will permanently remove the selected ads from Ready to Post. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        busy={bulkDeleting}
        onConfirm={async () => {
          setBulkDeleting(true);
          try {
            const { singleIds, flexIds, flexChildIds } = resolveSelectedReadyCards();
            const deletes = [];
            // Phase 6.20b — native ungroup instead of legacy adapter delete.
            flexIds.forEach(id => deletes.push(api.ungroupAdSet(projectId, id)));
            flexChildIds.forEach(id => deletes.push(api.updateDeploymentStatus(id, 'selected')));
            singleIds.forEach(id => deletes.push(api.deleteDeployment(id)));
            if (deletes.length === 0) {
              addToast('Selected ads are no longer available. Refreshing...', 'error');
              await loadDeployments();
              return;
            }
            await Promise.all(deletes);
            removeSelectedReadyCardsFromView({
              singleIds,
              flexIds,
              flexChildIds,
              status: 'selected',
            });
            addToast(`Deleted ${selectedCards.size} ad${selectedCards.size !== 1 ? 's' : ''}`, 'success');
            loadDeployments();
          } catch {
            addToast('Failed to delete some ads', 'error');
          } finally {
            setBulkDeleting(false);
            setBulkDeleteConfirm(false);
          }
        }}
        onCancel={() => setBulkDeleteConfirm(false)}
      />

      {previewImage && createPortal(
        <div
          className="fixed inset-0 z-[95] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="bg-ed-surface rounded-2xl shadow-card-hover max-w-5xl w-full max-h-[92vh] overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ed-line">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ed-ink truncate">
                  {previewImage.ad_name || previewImage.ad?.headline || 'Ready to Post image'}
                </p>
                <p className="text-[11px] text-ed-ink3">Preview</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadSingleImage(previewImage)}
                  disabled={downloadingSingle.has(previewImage.id)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ed-accent text-white text-[12px] font-bold hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
                >
                  {downloadingSingle.has(previewImage.id) ? 'Downloading...' : 'Download'}
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewImage(null)}
                  className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-ed-ink3 hover:text-ed-ink2 hover:bg-black/10 transition-all"
                  aria-label="Close preview"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="bg-ed-bg p-3 flex items-center justify-center" style={{ maxHeight: 'calc(92vh - 64px)' }}>
              <img
                src={previewImage.imageUrl}
                alt={previewImage.ad_name || previewImage.ad?.headline || 'Ready to Post image'}
                className="max-w-full object-contain rounded-xl"
                style={{ maxHeight: 'calc(92vh - 96px)' }}
              />
            </div>
          </div>
        </div>,
        document.body
      )}

      <PostToMetaModal
        open={!!postMetaModal}
        items={postMetaModal?.items || []}
        postingPath={getPostingPath()}
        deliveryMode={postDeliveryMode}
        setDeliveryMode={setPostDeliveryMode}
        scheduleTime={postScheduleTime}
        setScheduleTime={setPostScheduleTime}
        riskAccepted={postRiskAccepted}
        setRiskAccepted={setPostRiskAccepted}
        apiConfirmText={apiConfirmText}
        setApiConfirmText={setApiConfirmText}
        error={postMetaError}
        busy={postingMeta}
        onClose={closePostToMetaModal}
        onConfirm={handlePostToMetaConfirmed}
      />

      {/* Phase 6.20a — Mark as Posted backdate modal. Opens when user clicks
          "Pick date…" on a flex/ad_set; on save, calls handleMarkFlexPosted
          with the chosen ISO timestamp (or now if Today). */}
      {markPostedModal && (
        <MarkPostedModal
          open={true}
          count={markPostedModal.count}
          onClose={() => setMarkPostedModal(null)}
          onConfirm={async (postedAtIso) => {
            await handleMarkFlexPosted(markPostedModal.flexAd, postedAtIso);
          }}
        />
      )}
    </div>
  );
}

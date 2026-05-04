import { useState, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { api } from '../api';
import { ensureArray } from '../utils/collections';
import ConfirmDialog from './ConfirmDialog';
import BulkEditPanel from './BulkEditPanel';
import InfoTooltip from './InfoTooltip';
// Phase 6.20a — backdate picker on manual Mark as Posted
import MarkPostedModal from './MarkPostedModal';
import FilterTabs from './shared/FilterTabs';
import ThumbnailRow from './shared/ThumbnailRow';

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
    angle_id: adSet.angle_id || null,
    lifecycle_status: adSet.lifecycle_status || '',
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
  const [sortBy, setSortBy] = useState('newest');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [selectedCards, setSelectedCards] = useState(new Map()); // Map<cardKey, 'flex'|'single'>
  const [bulkMarking, setBulkMarking] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

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
      const [campData, readyAdSets] = await Promise.all([
        api.getCampaigns(projectId),
        api.getAdSets(projectId, ['ready']),
      ]);
      const safeReady = Array.isArray(readyAdSets) ? readyAdSets : (readyAdSets?.adSets ?? []);
      setCampaigns(ensureArray(campData?.campaigns, 'ReadyToPostView.campaigns'));
      setAdSets(ensureArray(campData?.adSets, 'ReadyToPostView.adSets'));
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
    addToast('Marked as posted', 'success');
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
      addToast('Failed to save posted status — refreshing...', 'error');
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
    addToast(`${childDeps.length} ads marked as posted`, 'success');
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
      addToast('Failed to save posted status — refreshing...', 'error');
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

  // ── Posted By ──────────────────────────────────────────────────────────────

  const handlePostedByChange = async (depId, value, isFlex = false) => {
    try {
      if (isFlex) {
        // Phase 6.20b — fan out posted_by to every child deployment of the
        // ad_set. The flex-shape "posted_by" displayed in the card is sampled
        // from children[0]; writing to all children keeps the field
        // consistent if a child is reordered later.
        const flexAd = safeFlexAds.find(f => f.id === depId);
        const children = flexAd ? getFlexChildDeps(flexAd) : [];
        await Promise.all(children.map(d => api.updateDeploymentPostedBy(d.id, value || '')));
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
          children.some(c => c.id === d.id) ? { ...d, posted_by: value } : d
        ));
        setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f => f.id === depId ? { ...f, posted_by: value } : f));
      } else {
        await api.updateDeploymentPostedBy(depId, value || '');
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === depId ? { ...d, posted_by: value } : d));
      }
    } catch {
      addToast('Failed to save', 'error');
    }
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
      const response = await fetch(dep.imageUrl);
      const blob = await response.blob();
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
        const res = await fetch(dep.imageUrl); const blob = await res.blob();
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

  // "Post in" section: Campaign + Ad Set + Ad Name
  const PostInSection = ({ campaignName, adSetName, duplicateAdSetName, adName, cardKey }) => {
    if (!campaignName && !adSetName) {
      return (
        <div className="bg-[rgba(168,84,59,0.06)] border-2 border-ed-accent/30 rounded-xl p-4">
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
        <span className="inline-block px-2 py-0.5 rounded bg-ed-accent text-white text-[10px] font-bold uppercase tracking-widest mb-3">Post This Ad In</span>
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
        <div className={`border-2 rounded-xl p-4 transition-all duration-300 ${isCopied ? 'border-ed-green/25 bg-ed-green/5' : 'border-ed-accent/25 bg-[rgba(168,84,59,0.06)]'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-1 transition-colors duration-300 ${isCopied ? 'bg-ed-green/15 text-ed-green' : 'bg-[rgba(168,84,59,0.12)] text-ed-accent'}`}>Website URL</span>
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
      <div className={`border-2 rounded-xl p-4 transition-all duration-300 ${anyCopied ? 'border-ed-green/25 bg-ed-green/5' : 'border-ed-accent/25 bg-[rgba(168,84,59,0.06)]'}`}>
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-1 transition-colors duration-300 ${anyCopied ? 'bg-ed-green/15 text-ed-green' : 'bg-[rgba(168,84,59,0.12)] text-ed-accent'}`}>Website URL</span>
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

  const PostedByDropdown = ({ value, onChange }) => (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-ed-ink2">Posted by:</span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="text-[12px] font-semibold text-ed-ink bg-ed-bg border border-ed-line rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-ed-accent/20 cursor-pointer"
      >
        <option value="">Select...</option>
        <option value="Corinne">Corinne</option>
        <option value="Liz">Liz</option>
        <option value="Ian">Ian</option>
      </select>
    </div>
  );

  // ── Admin Edit Panel ──────────────────────────────────────────────────────

  const EditPanel = ({ cardKey, id, isFlex = false }) => {
    if (editingCard !== cardKey || isPoster) return null;
    const nameKey = isFlex ? 'name' : 'ad_name';
    const headlineKey = isFlex ? 'headlines' : 'ad_headlines';

    return (
      <div className="border-2 border-ed-accent/30 bg-[rgba(168,84,59,0.06)] rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[rgba(168,84,59,0.12)] text-ed-accent text-[10px] font-bold uppercase tracking-widest">
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

    return (
      <div key={dep.id} className="border border-ed-line rounded-xl bg-white overflow-hidden">
        {/* Always-visible header */}
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            {!isPoster && (
              <label className="flex-shrink-0 mt-0.5 cursor-pointer" onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={selectedCards.has(dep.id)} onChange={() => toggleCardSelection(dep.id, 'single')} className="rounded border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20 w-4 h-4" />
              </label>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="text-[15px] font-serif text-ed-ink leading-tight">{name}</h3>
              <p className="text-[11px] text-ed-ink3 mt-0.5">
                {campaignName || 'No campaign'} · created {dep.created_at ? new Date(dep.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'} · page: {dep.facebook_page || '—'}
              </p>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <div className="flex items-center gap-3 text-center">
                <div><span className="text-[13px] font-mono text-ed-ink font-medium">{parseCount(dep.ad_headlines)}</span><div className="text-[8px] uppercase tracking-wider text-ed-ink3 font-medium">HEADLINES</div></div>
                <div><span className="text-[13px] font-mono text-ed-ink font-medium">{parseCount(dep.primary_texts)}</span><div className="text-[8px] uppercase tracking-wider text-ed-ink3 font-medium">BODY</div></div>
              </div>
              {!isPoster && (
                <>
                  <button onClick={() => toggleCardExpanded(dep.id)} className="text-[11px] text-ed-ink2 hover:text-ed-accent transition-colors">Edit</button>
                  <button onClick={() => handleSendBack(dep.id, 'single')} disabled={isSendingBack} className="text-[11px] text-ed-ink2 hover:text-ed-accent transition-colors disabled:opacity-50">Send back</button>
                </>
              )}
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

          {/* QA Readiness Strip */}
          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-ed-line">
            {(() => {
              const hasPage = !!dep.facebook_page;
              const hasUrl = !!dep.destination_url;
              const headlineCount = parseCount(dep.ad_headlines);
              const primaryCount = parseCount(dep.primary_texts);
              const hasImage = !!thumbUrl;
              return (
                <>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${hasPage ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{hasPage ? '✓' : '!'} Page set</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${hasUrl ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{hasUrl ? '✓' : '!'} URL valid</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${headlineCount > 0 ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{headlineCount > 0 ? '✓' : '!'} Headlines ({headlineCount})</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${primaryCount > 0 ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{primaryCount > 0 ? '✓' : '!'} Primary text ({primaryCount})</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${hasImage ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{hasImage ? '✓' : '!'} Has image</span>
                </>
              );
            })()}
          </div>
        </div>

        {/* Collapsible details */}
        {isExpanded && (
          <div className="px-5 pb-5 space-y-4 border-t border-ed-line pt-4">
            {/* Campaign + Ad Set */}
            <PostInSection campaignName={campaignName} adSetName={adSetName} duplicateAdSetName={dep.duplicate_adset_name} adName={name} cardKey={dep.id} />

            {/* Admin Edit Panel */}
            <EditPanel cardKey={dep.id} id={dep.id} isFlex={false} />

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
                <img src={thumbUrl} alt="" className="w-full max-w-[150px] rounded-xl bg-ed-bg" loading="lazy" />
              </div>
            )}

            {/* Primary Text */}
            {renderNumberedTexts(
              dep.primary_texts,
              `Primary Text \u2014 ${parseCount(dep.primary_texts)} Variation${parseCount(dep.primary_texts) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.',
              dep.id, 'primary'
            )}

            {/* Headline */}
            {renderNumberedTexts(
              dep.ad_headlines,
              `Headline \u2014 ${parseCount(dep.ad_headlines)} Variation${parseCount(dep.ad_headlines) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.',
              dep.id, 'headline'
            )}

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
            {!isPoster && editingCard !== dep.id && (
              <button onClick={() => startEditing(dep.id, dep, false)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ed-accent hover:text-ed-accent/80 hover:bg-[rgba(168,84,59,0.06)] transition-colors"
              >
                <EditPencilIcon />
                Edit
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <PostedByDropdown value={dep.posted_by} onChange={(val) => handlePostedByChange(dep.id, val)} />
            {confirmPosted === dep.id ? (
              <div className="flex items-center gap-2">
                <button onClick={() => setConfirmPosted(null)} className="px-2.5 py-1.5 rounded-lg text-[11px] text-ed-ink2 hover:bg-white transition-colors">Cancel</button>
                <button onClick={() => handleMarkPosted(dep.id)} disabled={isMarking}
                  className="px-4 py-2 rounded-lg text-[12px] font-bold bg-ed-green text-white hover:bg-ed-green/90 transition-colors disabled:opacity-50"
                >{isMarking ? 'Updating...' : 'Confirm Posted'}</button>
              </div>
            ) : (
              <button onClick={() => setConfirmPosted(dep.id)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-white bg-ed-green hover:bg-ed-green/90 transition-colors shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mark as Posted
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

    return (
      <div
        key={flexAd.id}
        ref={flexAd.id === highlightedId ? highlightRef : undefined}
        className={`border rounded-xl bg-white overflow-hidden transition-all duration-700 ${flexAd.id === highlightedId ? 'border-ed-accent ring-2 ring-ed-accent/30' : 'border-ed-line'}`}
      >
        {/* Always-visible header */}
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            {!isPoster && (
              <label className="flex-shrink-0 mt-0.5 cursor-pointer" onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={selectedCards.has(flexId)} onChange={() => toggleCardSelection(flexId, 'flex')} className="rounded border-ed-accent/30 text-ed-accent focus:ring-ed-accent/20 w-4 h-4" />
              </label>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="text-[15px] font-serif text-ed-ink leading-tight">{flexAd.name || 'Ad Set'}</h3>
              <p className="text-[11px] text-ed-ink3 mt-0.5">
                {campaignName || 'No campaign'} · created {flexAd.created_at ? new Date(flexAd.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'} · {childDeps.length} ad{childDeps.length !== 1 ? 's' : ''} · page: {flexAd.facebook_page || '—'}
              </p>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <div className="flex items-center gap-3 text-center">
                <div><span className="text-[13px] font-mono text-ed-ink font-medium">{childDeps.length}</span><div className="text-[8px] uppercase tracking-wider text-ed-ink3 font-medium">ADS</div></div>
                <div><span className="text-[13px] font-mono text-ed-ink font-medium">{parseCount(flexAd.headlines)}</span><div className="text-[8px] uppercase tracking-wider text-ed-ink3 font-medium">HEADLINES</div></div>
                <div><span className="text-[13px] font-mono text-ed-ink font-medium">{parseCount(flexAd.primary_texts)}</span><div className="text-[8px] uppercase tracking-wider text-ed-ink3 font-medium">BODY</div></div>
              </div>
              {!isPoster && (
                <>
                  <button onClick={() => toggleCardExpanded(flexId)} className="text-[11px] text-ed-ink2 hover:text-ed-accent transition-colors">Edit</button>
                  <button onClick={() => handleSendBackFlex(flexAd)} disabled={isSendingBack} className="text-[11px] text-ed-ink2 hover:text-ed-accent transition-colors disabled:opacity-50">Send back</button>
                </>
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

          {/* QA Readiness Strip */}
          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-ed-line">
            {(() => {
              const hasPage = !!flexAd.facebook_page;
              const hasUrl = !!flexAd.destination_url;
              const headlineCount = parseCount(flexAd.headlines);
              const primaryCount = parseCount(flexAd.primary_texts);
              const allHaveImage = childDeps.every(d => d.imageUrl);
              return (
                <>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${hasPage ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{hasPage ? '✓' : '!'} Page set</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${hasUrl ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{hasUrl ? '✓' : '!'} URL valid</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${headlineCount > 0 ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{headlineCount > 0 ? '✓' : '!'} Headlines ({headlineCount})</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${primaryCount > 0 ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{primaryCount > 0 ? '✓' : '!'} Primary text ({primaryCount})</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${allHaveImage ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-rust/10 text-ed-rust'}`}>{allHaveImage ? '✓' : '!'} All ads have image</span>
                </>
              );
            })()}
          </div>
        </div>

        {/* Collapsible details */}
        {isExpanded && (
          <div className="px-5 pb-5 space-y-4 border-t border-ed-line pt-4">
            {/* Campaign + Ad Set + Duplicate Ad Set */}
            <PostInSection campaignName={campaignName} adSetName={adSetName} duplicateAdSetName={flexAd.duplicate_adset_name} adName={flexAd.name || 'Ad Set'} cardKey={flexId} />

            {/* Admin Edit Panel */}
            <EditPanel cardKey={flexId} id={flexAd.id} isFlex />

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
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[rgba(168,84,59,0.06)] text-ed-accent text-[11px] font-bold hover:bg-[rgba(168,84,59,0.12)] transition-colors disabled:opacity-50"
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
                        <img src={d.imageUrl} alt=""
                          className={`w-full aspect-square object-cover rounded-xl bg-ed-bg transition-all ${isSelected ? 'ring-2 ring-ed-accent ring-offset-2' : ''}`}
                          loading="lazy" />
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
                        <input
                          type="text"
                          defaultValue={d.ad_name || d.ad?.headline || ''}
                          onBlur={(e) => saveChildAdName(d, e.target.value)}
                          className="mt-1 w-full text-[10px] text-ed-ink2 bg-white border border-ed-line rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-ed-accent/20"
                          aria-label="Ad name"
                        />
                      ) : (
                        <div className="text-[10px] text-ed-ink2 mt-1 truncate">{d.ad_name || d.ad?.headline || ''}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Primary Text */}
            {renderNumberedTexts(
              flexAd.primary_texts,
              `Primary Text — ${parseCount(flexAd.primary_texts)} Variation${parseCount(flexAd.primary_texts) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.',
              flexId, 'primary'
            )}

            {/* Headline */}
            {renderNumberedTexts(
              flexAd.headlines,
              `Headline — ${parseCount(flexAd.headlines)} Variation${parseCount(flexAd.headlines) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.',
              flexId, 'headline'
            )}

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
            {!isPoster && editingCard !== flexId && (
              <button onClick={() => startEditing(flexId, flexAd, true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ed-accent hover:text-ed-accent/80 hover:bg-[rgba(168,84,59,0.06)] transition-colors"
              >
                <EditPencilIcon />
                Edit
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
          <div className="flex items-center gap-3">
            <PostedByDropdown value={flexAd.posted_by} onChange={(val) => handlePostedByChange(flexAd.id, val, true)} />
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
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-white bg-ed-green hover:bg-ed-green/90 transition-colors shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mark as Posted
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
  const filteredCardList = campaignFilter === 'all' ? cardList : cardList.filter(c => (c.campaignName || 'Uncategorized') === campaignFilter);

  return (
    <div className="space-y-5">
      {/* Campaign filter tabs */}
      {(() => {
        const campaignCounts = {};
        let totalCount = 0;
        cardList.forEach(card => {
          totalCount++;
          const camp = card.campaignName || 'Uncategorized';
          campaignCounts[camp] = (campaignCounts[camp] || 0) + 1;
        });
        const tabs = [
          { label: 'All', count: totalCount, value: 'all' },
          ...Object.entries(campaignCounts).map(([name, count]) => ({
            label: name,
            count,
            value: name,
          })),
        ];
        return tabs.length > 2 ? (
          <FilterTabs tabs={tabs} activeValue={campaignFilter} onChange={setCampaignFilter} />
        ) : null;
      })()}

      {/* Sort info */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-ed-ink3">
          Sorted by {sortBy === 'oldest' ? 'oldest in queue' : sortBy === 'newest' ? 'newest first' : sortBy === 'campaign' ? 'campaign' : 'name'} · {cardList.length} ad set{cardList.length !== 1 ? 's' : ''} · {readyDeps.length} ad{readyDeps.length !== 1 ? 's' : ''}
        </span>
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
          {selectedCards.size > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setBulkMarking(true);
                  try {
                    const updates = [];
                    for (const [cardKey, cardType] of selectedCards) {
                      if (cardType === 'flex') {
                        const fa = flexAds.find(f => `flex-${f.id}` === cardKey);
                        if (fa) {
                          const children = getFlexChildDeps(fa);
                          children.forEach(d => updates.push(api.updateDeploymentStatus(d.id, 'posted')));
                        }
                      } else {
                        updates.push(api.updateDeploymentStatus(cardKey, 'posted'));
                      }
                    }
                    await Promise.all(updates);
                    setDeployments(prev => prev.map(d => selectedCards.has(d.id) || [...selectedCards.keys()].some(k => {
                      const fa = flexAds.find(f => `flex-${f.id}` === k);
                      return fa && getFlexChildDeps(fa).some(cd => cd.id === d.id);
                    }) ? { ...d, status: 'posted', posted_date: new Date().toISOString() } : d));
                    addToast(`Marked ${selectedCards.size} ad${selectedCards.size !== 1 ? 's' : ''} as posted`, 'success');
                    setSelectedCards(new Map());
                  } catch {
                    addToast('Failed to mark as posted', 'error');
                  } finally {
                    setBulkMarking(false);
                  }
                }}
                disabled={bulkMarking}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-ed-green text-white hover:bg-ed-green/90 transition-colors disabled:opacity-50"
              >
                {bulkMarking ? 'Marking...' : `Mark as Posted (${selectedCards.size})`}
              </button>
              <button
                onClick={() => setBulkEditing(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors"
              >
                Edit Selected ({selectedCards.size})
              </button>
              <button
                onClick={() => setBulkDeleteConfirm(true)}
                disabled={bulkDeleting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ed-rust border border-ed-rust/30 hover:bg-ed-rust/10 transition-colors disabled:opacity-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                {bulkDeleting ? 'Deleting...' : `Delete (${selectedCards.size})`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Bulk Edit Panel */}
      {bulkEditing && selectedCards.size > 0 && (
        <BulkEditPanel
          selectedCards={selectedCards}
          campaigns={campaigns}
          addToast={addToast}
          onSave={() => {
            setBulkEditing(false);
            setSelectedCards(new Map());
            loadDeployments();
          }}
          onCancel={() => setBulkEditing(false)}
        />
      )}

      {/* Cards */}
      <div className="space-y-5">
        {filteredCardList.map(card => card.type === 'single' ? renderAdCard(card.dep) : renderFlexCard(card.flexAd))}
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
            const deletes = [];
            for (const [cardKey, cardType] of selectedCards) {
              if (cardType === 'flex') {
                const flexId = cardKey.replace('flex-', '');
                // Phase 6.20b — native ungroup instead of legacy adapter delete
                deletes.push(api.ungroupAdSet(projectId, flexId));
              } else {
                deletes.push(api.deleteDeployment(cardKey));
              }
            }
            await Promise.all(deletes);
            // Optimistic UI removal
            const flexIdsToRemove = new Set();
            const depIdsToRemove = new Set();
            for (const [cardKey, cardType] of selectedCards) {
              if (cardType === 'flex') flexIdsToRemove.add(cardKey.replace('flex-', ''));
              else depIdsToRemove.add(cardKey);
            }
            setFlexAds(prev => prev.filter(f => !flexIdsToRemove.has(f.id)));
            setDeployments(prev => prev.filter(d => !depIdsToRemove.has(d.id)));
            addToast(`Deleted ${selectedCards.size} ad${selectedCards.size !== 1 ? 's' : ''}`, 'success');
            setSelectedCards(new Map());
          } catch {
            addToast('Failed to delete some ads', 'error');
          } finally {
            setBulkDeleting(false);
            setBulkDeleteConfirm(false);
          }
        }}
        onCancel={() => setBulkDeleteConfirm(false)}
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

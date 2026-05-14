import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import JSZip from 'jszip';
import { api } from '../api';
import BatchManager from './BatchManager';
import GenerationQueue from './GenerationQueue';
import InfoTooltip from './InfoTooltip';
import PromptGuidelinesEditor from './PromptGuidelinesEditor';
import TemplateTagHelp from './TemplateTagHelp';
import EditorialPageHeader from './editorial/EditorialPageHeader';
import { useToast } from './Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import { usePolling } from '../hooks/usePolling';
import { ensureArray } from '../utils/collections';
import { fetchBlobOrThrow } from '../utils/downloads';
import { resizeImageForUpload, estimateBase64BodyBytes, MAX_COMBINED_BODY_BYTES } from '../utils/imageResize';
import { IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL, getImageModelDescription } from '../utils/imageModels';

// Helper: resize a file then base64-encode it. Logs the size delta to console for diagnostics.
async function resizeAndBase64(file) {
  const resized = await resizeImageForUpload(file);
  if (file.size > resized.size) {
    console.info(`[AdStudio] Image resized: ${(file.size / 1024 / 1024).toFixed(2)} MB -> ${(resized.size / 1024 / 1024).toFixed(2)} MB`);
  }
  const base64 = await fileToBase64(resized);
  return { base64, mime: resized.type, file: resized };
}

const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1 (Square)' },
  { value: '9:16', label: '9:16 (Story)' },
  { value: '16:9', label: '16:9 (Landscape)' },
  { value: '4:5', label: '4:5 (Portrait)' }
];

const STATUS_STEPS = [
  { status: 'generating_copy', label: 'Creative Direction', icon: '1' },
  { status: 'generating_image', label: 'Image Generation', icon: '2' },
  { status: 'completed', label: 'Complete', icon: '3' }
];

// Template source options
const TEMPLATE_RANDOM = 'random';      // Random from Drive folder
const TEMPLATE_UPLOAD = 'upload';      // Upload one-off image
const TEMPLATE_SELECT = 'select';      // Pick from uploaded templates
const TEMPLATE_PICKER_BATCH_SIZE = 24;
const CUSTOM_ANGLE_MODE = '__custom__';

function getTemplateTags(templates = []) {
  return [...new Set((templates || [])
    .filter(t => !t.archived_at)
    .flatMap(t => Array.isArray(t.tags) ? t.tags : [])
    .map(tag => String(tag || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

// Normalize date strings — handles ISO with/without Z, Convex _creationTime numbers, etc.
function parseDate(dateStr) {
  if (!dateStr) return null;
  // If it's a number (Convex _creationTime is ms since epoch)
  if (typeof dateStr === 'number') return new Date(dateStr);
  // If ISO string missing timezone suffix, append Z to treat as UTC
  const str = String(dateStr);
  const d = new Date(str.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) && !str.match(/[Zz+\-]\d{0,4}$/) ? str + 'Z' : str);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

// Full date+time for gallery cards (e.g. "Feb 18 · 9:04 PM")
function formatDateTime(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function getAdGeneratedAt(ad) {
  return ad?.completed_at || ad?.created_at;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function normalizeAdRecord(ad) {
  if (!ad) return ad;
  return {
    ...ad,
    has_edit_prompt: ad.has_edit_prompt ?? !!getEditablePrompt(ad),
  };
}

function getEditablePrompt(ad) {
  const candidates = [
    ad?.image_prompt,
    ad?.gpt_creative_output,
  ];
  const prompt = candidates.find(value => typeof value === 'string' && value.trim());
  return prompt ? prompt.trim() : '';
}

function hasAdDetail(ad) {
  // Detect whether an ad has been fully hydrated (ad list endpoints return a lighter shape).
  // The gallery list includes media URLs and copy fields, but not the canonical prompt field.
  return !!ad && Object.prototype.hasOwnProperty.call(ad, 'image_prompt');
}

const DISPLAYABLE_IMAGE_STATUSES = new Set(['completed', 'staging', 'quality_rejected']);
const ACTIVE_GENERATION_STATUSES = new Set(['pending', 'queued', 'preparing', 'generating_copy', 'generating_image']);

function generationErrorUpdates(event) {
  return {
    error: event.error || event.message || 'Generation failed.',
    errorCode: event.code || null,
    errorActionUrl: event.actionUrl || null,
    errorActionLabel: event.actionLabel || null,
    status: null,
  };
}
const FAILED_LIKE_STATUSES = new Set(['failed', 'quality_rejected']);

function hasAdImage(ad) {
  return !!ad && !!(ad.imageUrl || ad.thumbnailUrl || ad.storageId);
}

function hasRenderableAdImage(ad) {
  return !!ad && !!(ad.imageUrl || ad.thumbnailUrl);
}

function isCompletedImageReady(ad) {
  return !!ad && ad.status === 'completed' && hasRenderableAdImage(ad);
}

function isDisplayableImageAd(ad) {
  return !!ad && DISPLAYABLE_IMAGE_STATUSES.has(ad.status) && hasAdImage(ad);
}

function isDownloadableImageAd(ad) {
  return isDisplayableImageAd(ad) && !!ad.imageUrl;
}

function isPipelineSendableAd(ad, deployedAdIds = new Set()) {
  return isDisplayableImageAd(ad)
    && ad.status !== 'quality_rejected'
    && !deployedAdIds.has(ad.id);
}

function isFailedLikeAd(ad) {
  return !!ad && FAILED_LIKE_STATUSES.has(ad.status);
}

function isActiveGeneratingAd(ad) {
  return !!ad && ACTIVE_GENERATION_STATUSES.has(ad.status);
}

function isSelectableAd(ad) {
  return isDisplayableImageAd(ad) || isFailedLikeAd(ad);
}

function getGalleryStatusMeta(ad) {
  if (ad?.status === 'staging') {
    return {
      label: 'QA Passed',
      className: 'bg-teal/10 text-teal',
      title: 'Creative Filter approved this ad. It may already be part of a Ready-to-Post ad set.',
    };
  }
  if (ad?.status === 'quality_rejected') {
    return {
      label: 'QA Rejected',
      className: 'bg-red-100/80 text-red-600',
      title: 'Creative Filter rejected this ad. The image is saved and can be reviewed or deleted.',
    };
  }
  if (ad?.status === 'failed') {
    return {
      label: 'Failed',
      className: 'bg-red-100/80 text-red-600',
      title: ad.error_message || 'Generation failed.',
    };
  }
  if (isActiveGeneratingAd(ad)) {
    return {
      label: 'Generating',
      className: 'bg-navy/10 text-navy',
      title: 'This ad is still generating.',
    };
  }
  if (ad?.status === 'completed') {
    return {
      label: 'Completed',
      className: 'bg-white/80 backdrop-blur-sm text-textmid',
      title: 'Generated image is complete.',
    };
  }
  return {
    label: 'Ad',
    className: 'bg-navy/10 text-navy',
    title: ad?.status ? `Status: ${ad.status}` : 'Ad',
  };
}

export default function AdStudio({ projectId, project, conductorAngles = [], onOpenPipeline }) {
  const toast = useToast();
  const navigate = useNavigate();

  // Optional fields collapse
  const [optionalOpen, setOptionalOpen] = useState(false);

  // Generation controls
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [angle, setAngle] = useState('');
  const [angleModeOverride, setAngleModeOverride] = useState('');
  const angleTouchedRef = useRef(false);
  const [headline, setHeadline] = useState('');
  const [bodyCopy, setBodyCopy] = useState('');

  // Body copy generation
  const [bodyCopyStyle, setBodyCopyStyle] = useState('short');
  const [generatingBody, setGeneratingBody] = useState(false);

  // Auto-generate states for optional fields
  const [generatingAngle, setGeneratingAngle] = useState(false);
  const [generatingHeadline, setGeneratingHeadline] = useState(false);

  // Prompt editing (for iterative refinement from past ads)
  const [customPrompt, setCustomPrompt] = useState('');
  const [parentAdId, setParentAdId] = useState(null);
  const [editMode, setEditMode] = useState('describe'); // 'describe' (AI edit) or 'direct' (raw prompt)
  const [editInstruction, setEditInstruction] = useState('');
  const [isApplyingEdit, setIsApplyingEdit] = useState(false);
  const [originalPromptRef, setOriginalPromptRef] = useState(''); // stores original prompt before edits
  const [promptUpdated, setPromptUpdated] = useState(false); // true after Step 1 (Update Prompt) completes
  const [editingAdImage, setEditingAdImage] = useState(null); // image URL of the ad being edited
  const [editPanelFlash, setEditPanelFlash] = useState(false);
  const editPanelRef = useRef(null);
  const editTextareaRef = useRef(null);

  // Reference image for edit (attached alongside describe-edit instruction)
  const [editReferenceFile, setEditReferenceFile] = useState(null);
  const [editReferencePreview, setEditReferencePreview] = useState(null);
  const [editRefDragOver, setEditRefDragOver] = useState(false);
  const editReferenceInputRef = useRef(null);

  // Template source
  const [templateSource, setTemplateSource] = useState(TEMPLATE_RANDOM);
  const [templateTag, setTemplateTag] = useState('');

  // Upload one-off image
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [uploadedPreviews, setUploadedPreviews] = useState([]);
  const uploadedFile = uploadedFiles[0] || null;
  const uploadedPreview = uploadedPreviews[0]?.url || null;
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Select from all templates (Drive + uploaded)
  const [driveImages, setDriveImages] = useState([]);
  const [uploadedTemplates, setUploadedTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  // Selection stores both the id and the source ('drive' or 'uploaded')
  const [selectedTemplate, setSelectedTemplate] = useState(null); // { id, source }
  const [visibleTemplateCount, setVisibleTemplateCount] = useState(TEMPLATE_PICKER_BATCH_SIZE);
  const templatesPrefetchedRef = useRef('');
  // Auto-collapse the Pick Template grid once a template is selected, so the
  // user doesn't have to scroll past hundreds of pixels of thumbnails to reach
  // the rest of the form. A "Change" button on the compact pill re-expands.
  const [pickerCollapsed, setPickerCollapsed] = useState(false);

  // Template analysis (GPT-4.1-mini vision)
  const [templateAnalysis, setTemplateAnalysis] = useState(null);
  const [analyzingTemplate, setAnalyzingTemplate] = useState(false);
  const [skipProductImage, setSkipProductImage] = useState(false);

  // Image generation model
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);

  // Product image
  const [productFiles, setProductFiles] = useState([]);
  const [productPreviews, setProductPreviews] = useState([]);
  const productFile = productFiles[0] || null;
  // When the user uploads a per-ad product image AND the project has none yet,
  // they can opt to also persist this upload as the project's default product
  // image. Toggle is OFF by default; reset on project change.
  const [saveProductAsDefault, setSaveProductAsDefault] = useState(false);
  const [productDragOver, setProductDragOver] = useState(false);
  const productFileInputRef = useRef(null);

  // Generation state — supports multiple concurrent generations
  // Each entry: { id, status, message, error, warning, stream }
  const [activeGens, setActiveGens] = useState([]);
  const [genError, setGenError] = useState('');
  const [genQueueExpanded, setGenQueueExpanded] = useState(true);
  const genIdCounter = useRef(0);
  const singleGenerationQueueRef = useRef(Promise.resolve());
  const queueRef = useRef(null);

  // Derived count of in-progress generations
  const activeGenCount = activeGens.filter(g => g.status && g.status !== 'completed' && g.status !== 'cancelled' && !g.error).length;

  // Gallery
  const { data: ads, setData: setAds, loading: loadingAds, refetch: loadAds } = useAsyncData(
    () => api.getAds(projectId).then(d => ensureArray(d?.ads, 'AdStudio.ads').map(normalizeAdRecord)),
    [projectId]
  );
  const [viewAd, setViewAd] = useState(null);
  const [viewAdLoading, setViewAdLoading] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState('individual'); // 'individual' | 'batch' | 'all'
  const [galleryView, setGalleryView] = useState('grid'); // 'grid' | 'list'
  const [dateRange, setDateRange] = useState('4d'); // applied range
  const [pendingRange, setPendingRange] = useState('4d'); // dropdown selection (not yet applied)
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Tags
  const [tagEditAd, setTagEditAd] = useState(null); // ad being tag-edited
  const [tagInput, setTagInput] = useState('');
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState('');

  // Multi-select for bulk actions
  const [selectedAdIds, setSelectedAdIds] = useState(new Set());
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);
  const galleryRef = useRef(null);
  const [bulkBarInGalleryRange, setBulkBarInGalleryRange] = useState(false);

  const activeConductorAngles = useMemo(() => {
    return ensureArray(conductorAngles, 'AdStudio.conductorAngles')
      .filter(a => a?.status === 'active');
  }, [conductorAngles]);

  const directOfferAngleName = useMemo(() => {
    return activeConductorAngles.find(a => a?.is_system_default === true)?.name || '';
  }, [activeConductorAngles]);

  const angleMode = useMemo(() => {
    if (angleModeOverride === CUSTOM_ANGLE_MODE) return CUSTOM_ANGLE_MODE;
    if (!angle.trim()) return '';
    return activeConductorAngles.some(a => a?.name === angle) ? angle : CUSTOM_ANGLE_MODE;
  }, [activeConductorAngles, angle, angleModeOverride]);

  const handleAngleModeChange = useCallback((value) => {
    angleTouchedRef.current = true;
    if (value === CUSTOM_ANGLE_MODE) {
      setAngleModeOverride(CUSTOM_ANGLE_MODE);
      return;
    }
    setAngleModeOverride('');
    setAngle(value);
  }, []);

  useEffect(() => {
    // Reset form state when project changes
    angleTouchedRef.current = false;
    setAngleModeOverride('');
    setAngle('');
    setHeadline('');
    setBodyCopy('');
    setCustomPrompt('');
    setParentAdId(null);
    setSelectedTemplate(null);
    setTemplateAnalysis(null);
    setSkipProductImage(false);
    setSaveProductAsDefault(false);
    setViewAd(null);
    setViewAdLoading(false);
    setOptionalOpen(false);
  }, [projectId]);

  useEffect(() => {
    if (!directOfferAngleName || angleTouchedRef.current) return;
    setAngle(prev => (prev.trim() ? prev : directOfferAngleName));
  }, [directOfferAngleName, projectId]);

  const mergeAdData = useCallback((nextAd) => {
    if (!nextAd) return null;
    const normalized = normalizeAdRecord(nextAd);
    setAds(prev => prev.map(ad => ad.id === normalized.id ? { ...ad, ...normalized } : ad));
    setViewAd(prev => prev && prev.id === normalized.id ? { ...prev, ...normalized } : prev);
    return normalized;
  }, [setAds]);

  const hydrateAd = useCallback(async (ad) => {
    if (!ad) return null;
    if (hasAdDetail(ad)) return ad;
    const detail = await api.getAd(projectId, ad.id);
    return mergeAdData(detail);
  }, [mergeAdData, projectId]);

  const openAdDetails = useCallback(async (ad) => {
    if (!isDisplayableImageAd(ad)) return null;
    setViewAd(ad);
    if (hasAdDetail(ad)) return ad;
    setViewAdLoading(true);
    try {
      return await hydrateAd(ad);
    } catch (err) {
      toast.error(err.message || 'Failed to load ad details.');
      return ad;
    } finally {
      setViewAdLoading(false);
    }
  }, [hydrateAd, toast]);

  useEffect(() => {
    if (!viewAd || typeof document === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [viewAd]);

  const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
  const QUEUE_WATCHDOG_MS = 10 * 60 * 1000;

  const syncInProgressAds = useCallback(async ({ cancelledRef } = {}) => {
    try {
      const data = await api.getInProgressAds(projectId);
      if (cancelledRef?.current || !data.ads || data.ads.length === 0) return;

      const now = Date.now();

      const restoredGens = data.ads
        .map(ad => {
          const progressAt = new Date(ad.last_progress_at || ad.created_at).getTime();
          const appearsStuck = Number.isFinite(progressAt) && (now - progressAt) > STUCK_THRESHOLD_MS;
          return {
            id: `restored-${ad.id}`,
            adExternalId: ad.id,
            label: ad.angle || ad.aspect_ratio || '',
            status: ad.status,
            message: ad.status === 'generating_copy'
              ? 'Creative direction in progress...'
              : appearsStuck
                ? 'Generation appears stuck; checking server recovery...'
                : 'Image generation in progress...',
            error: '',
            warning: '',
            progress: ad.status === 'generating_copy' ? 25 : 65,
            startTime: new Date(ad.created_at).getTime(),
            lastEventAt: progressAt || Date.now(),
            source: 'restored',
          };
        });

      if (restoredGens.length === 0) return;

      setActiveGens(prev => {
        const existingAdIds = new Set(prev.filter(g => g.adExternalId).map(g => g.adExternalId));
        const newGens = restoredGens.filter(g => !existingAdIds.has(g.adExternalId));
        if (newGens.length === 0) return prev;
        return [...prev, ...newGens];
      });
    } catch (err) {
      console.error('Failed to restore generation queue:', err);
    }
  }, [STUCK_THRESHOLD_MS, projectId]);

  // Restore in-progress ads immediately, then keep discovering server-side
  // generation work so progress bars cannot disappear until a page refresh.
  useEffect(() => {
    const cancelledRef = { current: false };
    syncInProgressAds({ cancelledRef });
    return () => { cancelledRef.current = true; };
  }, [syncInProgressAds]);

  usePolling(() => syncInProgressAds(), 5000, !!projectId);

  // Poll for status updates on restored queue items.
  const trackedGenerationCount = activeGens.filter(g => g.adExternalId && g.status !== 'completed' && g.status !== 'cancelled' && !g.error).length;

  usePolling(async () => {
    try {
      const data = await api.getInProgressAds(projectId);
      const inProgressMap = new Map(ensureArray(data?.ads, 'AdStudio.inProgressAds').map(a => [a.id, a]));

      const currentTracked = activeGens.filter(g => g.adExternalId && g.status !== 'completed' && g.status !== 'cancelled' && !g.error);
      const disappeared = currentTracked.filter(g => !inProgressMap.has(g.adExternalId));

      const finalAds = {};
      await Promise.all(disappeared.map(async (g) => {
        try {
          const ad = await api.getAd(projectId, g.adExternalId);
          finalAds[g.adExternalId] = normalizeAdRecord(ad);
        } catch (err) {
          finalAds[g.adExternalId] = {
            id: g.adExternalId,
            status: 'unknown',
            error_message: err.message || 'Could not verify generation status yet.',
          };
        }
      }));

      setActiveGens(prev => prev.map(g => {
        if (g.status === 'completed' || g.error) return g;
        if (!g.adExternalId) return g;

        if (!inProgressMap.has(g.adExternalId)) {
          const finalAd = finalAds[g.adExternalId];
          if (finalAd?.status === 'failed') {
            return { ...g, status: null, error: finalAd.error_message || 'Generation failed on server', progress: 0 };
          }
          if (finalAd?.status === 'cancelled' || finalAd?.status === 'canceled') {
            return { ...g, status: 'cancelled', message: 'Cancelled', progress: 0, cancelling: false };
          }
          if (isCompletedImageReady(finalAd)) {
            return { ...g, status: 'completed', message: 'Ad generated successfully!', progress: 100 };
          }
          return {
            ...g,
            status: 'generating_image',
            message: finalAd?.status === 'completed' ? 'Finalizing image preview...' : 'Verifying generation status...',
            progress: Math.max(g.progress || 0, 95),
          };
        }

        const currentAd = inProgressMap.get(g.adExternalId);
        if (currentAd && currentAd.status !== g.status) {
          const progressAt = new Date(currentAd.last_progress_at || currentAd.created_at).getTime();
          return {
            ...g,
            status: currentAd.status,
            message: currentAd.status === 'generating_image'
              ? 'Image generation in progress...'
              : 'Creative direction in progress...',
            progress: currentAd.status === 'generating_image' ? 65 : 25,
            lastEventAt: Number.isFinite(progressAt) ? progressAt : Date.now(),
          };
        }

        if (currentAd) {
          const progressAt = new Date(currentAd.last_progress_at || currentAd.created_at).getTime();
          if (Number.isFinite(progressAt) && progressAt !== g.lastEventAt) {
            return { ...g, lastEventAt: progressAt };
          }
        }

        return g;
      }));

      const finalAdRows = Object.values(finalAds).filter(ad => ad?.id && (ad.status === 'failed' || ad.status === 'cancelled' || ad.status === 'canceled' || isCompletedImageReady(ad)));
      const completedAds = finalAdRows.filter(isCompletedImageReady);
      if (finalAdRows.length > 0) {
        setAds(prev => {
          const next = [...prev];
          for (const ad of finalAdRows) {
            const idx = next.findIndex(existing => existing.id === ad.id);
            if (idx >= 0) next[idx] = { ...next[idx], ...ad };
            else next.unshift(ad);
          }
          return next;
        });
        loadAds();
      }
      if (completedAds.length > 0) {
        const completedAdIds = new Set(completedAds.map(ad => ad.id));
        setTimeout(() => {
          setActiveGens(prev => prev.filter(g => !(g.adExternalId && completedAdIds.has(g.adExternalId) && g.status === 'completed')));
        }, 5000);
      }
    } catch (err) {
      console.error('Queue poll error:', err);
    }
  }, 5000, trackedGenerationCount > 0);

  useEffect(() => {
    if (activeGens.length === 0) return undefined;
    const interval = setInterval(() => {
      const now = Date.now();
      setActiveGens(prev => prev.map(g => {
        if (!g.status || g.status === 'completed' || g.status === 'cancelled' || g.error) return g;
        const lastEventAt = g.lastEventAt || g.startTime || now;
        if (now - lastEventAt < QUEUE_WATCHDOG_MS) return g;
        return {
          ...g,
          status: null,
          progress: 0,
          error: 'Generation may have failed — no progress has arrived for more than 10 minutes. Refresh the page to check saved status, then retry if needed.',
        };
      }));
    }, 30 * 1000);
    return () => clearInterval(interval);
  }, [activeGens.length, QUEUE_WATCHDOG_MS]);

  // Prefill was previously populated from the Copywriter tab's Quote Mining flow.
  // That feature has been removed; the ref stays as a template-analysis-race guard in case
  // any future prefill source triggers body-copy generation on mount.
  const prefillBodyGenRef = useRef(false);

  // Load all templates when selecting "Pick a Template"
  useEffect(() => {
    if (templateSource === TEMPLATE_SELECT && driveImages.length === 0 && uploadedTemplates.length === 0) {
      loadTemplates();
    }
  }, [templateSource]);

  useEffect(() => {
    if (templateSource === TEMPLATE_SELECT) {
      setVisibleTemplateCount(TEMPLATE_PICKER_BATCH_SIZE);
    }
  }, [templateSource, projectId]);

  useEffect(() => {
    if (!projectId || templatesPrefetchedRef.current === projectId) return undefined;
    templatesPrefetchedRef.current = projectId;
    const timer = setTimeout(() => {
      loadTemplates({ showSpinner: false });
    }, 700);
    return () => clearTimeout(timer);
  }, [projectId]);

  // Clear selectedTemplate when leaving the Pick Template tab. Otherwise a
  // previously-selected template lingers and its async analysis can flip
  // skipProductImage AFTER the user has moved to a different mode.
  useEffect(() => {
    if (templateSource !== TEMPLATE_SELECT && selectedTemplate) {
      setSelectedTemplate(null);
    }
  }, [templateSource]);

  // Mirror picker collapsed/expanded state to the current selection. Selection
  // present → grid hidden, compact pill shown. Selection absent → grid shown.
  // The "Change" button manually flips this back to expanded WITHOUT changing
  // selectedTemplate; picking a new template inside the re-expanded grid then
  // re-fires this effect (selectedTemplate.id changes) and auto-collapses again.
  useEffect(() => {
    setPickerCollapsed(!!selectedTemplate);
  }, [selectedTemplate?.id]);

  // ── Template analysis (GPT-4.1-mini vision) — triggers when an uploaded template is selected ──
  useEffect(() => {
    // Only analyze uploaded templates (not Drive inspiration images)
    if (!selectedTemplate || selectedTemplate.source !== 'uploaded') {
      setTemplateAnalysis(null);
      setAnalyzingTemplate(false);
      // Note: do NOT auto-mutate skipProductImage here. The toggle is purely
      // user-controlled — the analysis card's "Product image: recommended /
      // not needed" badge is informational only. Resetting it would undo a
      // user's manual choice when they leave the picker or pick a Drive
      // template (which doesn't get analyzed).
      return;
    }

    // Check if analysis is already cached in local state
    const cached = uploadedTemplates.find(t => t.id === selectedTemplate.id);
    if (cached?.analysis) {
      try {
        const parsed = typeof cached.analysis === 'string' ? JSON.parse(cached.analysis) : cached.analysis;
        setTemplateAnalysis(parsed);
        if (parsed.recommended_style) setBodyCopyStyle(parsed.recommended_style);
        // Auto-regenerate body copy if headline exists and prefill isn't actively generating
        if (headline.trim() && parsed.recommended_style && !prefillBodyGenRef.current) {
          handleRegenerateBody(parsed.recommended_style);
        }
        return;
      } catch { /* parse failed, fetch from API */ }
    }

    // Fetch analysis from API
    let cancelled = false;
    setAnalyzingTemplate(true);
    setTemplateAnalysis(null);

    api.analyzeTemplate(projectId, selectedTemplate.id)
      .then(data => {
        if (cancelled) return;
        const analysis = data.analysis;
        setTemplateAnalysis(analysis);
        if (analysis.recommended_style) setBodyCopyStyle(analysis.recommended_style);

        // Update local cache so re-selecting doesn't re-fetch
        setUploadedTemplates(prev => prev.map(t =>
          t.id === selectedTemplate.id ? { ...t, analysis: JSON.stringify(analysis) } : t
        ));

        // Auto-regenerate body copy if headline exists and prefill isn't actively generating
        if (headline.trim() && analysis.recommended_style && !prefillBodyGenRef.current) {
          handleRegenerateBody(analysis.recommended_style);
        }
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Template analysis failed:', err);
        toast.error('Template analysis failed');
      })
      .finally(() => {
        if (!cancelled) setAnalyzingTemplate(false);
      });

    return () => { cancelled = true; };
  }, [selectedTemplate?.id]);

  // Auto-generate an angle from foundational docs. If a headline / body copy
  // already exist, regenerate them against the new angle (cascade) — the angle
  // dictates the tone for downstream copy, so they need to be re-aligned.
  const handleGenerateAngle = async () => {
    // Snapshot whether downstream fields are populated BEFORE we change anything.
    const hadHeadline = !!headline.trim();
    const hadBodyCopy = !!bodyCopy.trim();

    setGeneratingAngle(true);
    let newAngle = '';
    try {
      const data = await api.generateAdAngle(projectId);
      if (!data.angle) {
        setGeneratingAngle(false);
        return;
      }
      newAngle = data.angle;
      angleTouchedRef.current = true;
      setAngleModeOverride('');
      setAngle(newAngle);
    } catch (err) {
      console.error('Failed to generate angle:', err);
      toast.error(err.message || 'Angle generation failed');
      setGeneratingAngle(false);
      return;
    }
    setGeneratingAngle(false);

    // Cascade 1: if a headline was set, regenerate it against the new angle.
    let newHeadline = headline.trim();
    let headlineFailed = false;
    if (hadHeadline) {
      setGeneratingHeadline(true);
      try {
        const headlineData = await api.generateAdHeadline(projectId, { angle: newAngle });
        if (headlineData.headline) {
          newHeadline = headlineData.headline;
          setHeadline(newHeadline);
        }
      } catch (err) {
        headlineFailed = true;
        console.error('Failed to regenerate headline:', err);
        toast.error(err.message || 'Headline regeneration failed');
      } finally {
        setGeneratingHeadline(false);
      }
    }

    // Cascade 2: if body copy was set, regenerate it against the new angle.
    // Skip if headline regeneration failed — the body would be anchored on a
    // stale headline mismatched with the new angle.
    if (hadBodyCopy && !headlineFailed) {
      setGeneratingBody(true);
      try {
        const bodyData = await api.generateAdBodyCopy(projectId, {
          headline: newHeadline,
          angle: newAngle,
          style: bodyCopyStyle,
        });
        setBodyCopy(bodyData.body_copy || '');
      } catch (err) {
        console.error('Failed to regenerate body copy:', err);
        toast.error(err.message || 'Body copy regeneration failed');
      } finally {
        setGeneratingBody(false);
      }
    }
  };

  // Auto-generate a headline from foundational docs + current angle
  const handleGenerateHeadline = async () => {
    setGeneratingHeadline(true);
    try {
      const data = await api.generateAdHeadline(projectId, { angle: angle || '' });
      if (data.headline) {
        setHeadline(data.headline);
      }
    } catch (err) {
      console.error('Failed to generate headline:', err);
      toast.error(err.message || 'Headline generation failed');
    } finally {
      setGeneratingHeadline(false);
    }
  };

  // Auto-generate headline + body copy from current angle
  const handleGenerateFromAngle = async () => {
    setGeneratingHeadline(true);
    try {
      const headlineData = await api.generateAdHeadline(projectId, { angle: angle || '' });
      if (headlineData.headline) {
        setHeadline(headlineData.headline);
        // Now generate body copy with the new headline
        setGeneratingBody(true);
        setGeneratingHeadline(false);
        try {
          const bodyData = await api.generateAdBodyCopy(projectId, {
            headline: headlineData.headline,
            angle: angle || '',
            style: bodyCopyStyle,
          });
          setBodyCopy(bodyData.body_copy || '');
        } catch (bodyErr) {
          console.error('Failed to generate body copy:', bodyErr);
          toast.error('Body copy generation failed');
        } finally {
          setGeneratingBody(false);
        }
      }
    } catch (err) {
      console.error('Failed to generate headline:', err);
      toast.error(err.message || 'Headline generation failed');
      setGeneratingHeadline(false);
    }
  };

  // Generate / regenerate body copy from current headline + style
  const handleRegenerateBody = async (styleOverride) => {
    const useStyle = styleOverride || bodyCopyStyle;
    setGeneratingBody(true);
    try {
      const data = await api.generateAdBodyCopy(projectId, {
        headline: headline.trim(),
        angle: angle || '',
        style: useStyle,
      });
      setBodyCopy(data.body_copy || '');
    } catch (err) {
      console.error('Failed to generate body copy:', err);
      toast.error(err?.message || 'Body copy generation failed');
    } finally {
      setGeneratingBody(false);
    }
  };

  const loadTemplates = async ({ showSpinner = true } = {}) => {
    if (showSpinner) setLoadingTemplates(true);
    try {
      const [driveData, uploadedData] = await Promise.all([
        api.getInspirationImages(projectId).catch(() => ({ images: [] })),
        api.getTemplates(projectId).catch(() => ({ templates: [] }))
      ]);
      setDriveImages(ensureArray(driveData?.images, 'AdStudio.driveImages'));
      setUploadedTemplates(ensureArray(uploadedData?.templates, 'AdStudio.uploadedTemplates'));
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      if (showSpinner) setLoadingTemplates(false);
    }
  };

  // --- Upload handling ---
  const handleFileSelected = useCallback((files, { append = false } = {}) => {
    const incoming = Array.from(files || []).filter(Boolean);
    if (incoming.length === 0) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const invalid = incoming.find(file => !allowed.includes('.' + file.name.split('.').pop().toLowerCase()));
    if (invalid) {
      const ext = '.' + invalid.name.split('.').pop().toLowerCase();
      setGenError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    const combined = append ? [...uploadedFiles, ...incoming] : incoming;
    const selected = combined.slice(0, 10);
    if (combined.length > 10) {
      setGenError('Use up to 10 template images per generation.');
    } else {
      setGenError('');
    }
    setUploadedPreviews(prev => {
      prev.forEach(item => URL.revokeObjectURL(item.url));
      return selected.map(file => ({ file, url: URL.createObjectURL(file) }));
    });
    setUploadedFiles(selected);
    setTemplateSource(TEMPLATE_UPLOAD);
  }, [uploadedFiles]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) handleFileSelected(e.dataTransfer.files, { append: true });
  }, [handleFileSelected]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const clearUploadedImage = () => {
    setUploadedFiles([]);
    uploadedPreviews.forEach(item => URL.revokeObjectURL(item.url));
    setUploadedPreviews([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeUploadedImageAt = (indexToRemove) => {
    setUploadedPreviews(prev => {
      const removed = prev[indexToRemove];
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return prev.filter((_, index) => index !== indexToRemove);
    });
    setUploadedFiles(prev => {
      const next = prev.filter((_, index) => index !== indexToRemove);
      if (next.length === 0 && fileInputRef.current) fileInputRef.current.value = '';
      return next;
    });
  };

  // --- Product image handling ---
  const handleProductFileSelected = useCallback((files, { append = false } = {}) => {
    const incoming = Array.from(files || []).filter(Boolean);
    if (incoming.length === 0) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const invalid = incoming.find(file => !allowed.includes('.' + file.name.split('.').pop().toLowerCase()));
    if (invalid) {
      const ext = '.' + invalid.name.split('.').pop().toLowerCase();
      setGenError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    const combined = append ? [...productFiles, ...incoming] : incoming;
    const selected = combined.slice(0, 10);
    if (combined.length > 10) {
      setGenError('Use up to 10 reference images per generation.');
    } else {
      setGenError('');
    }
    setProductPreviews(prev => {
      prev.forEach(item => URL.revokeObjectURL(item.url));
      return selected.map(file => ({ file, url: URL.createObjectURL(file) }));
    });
    setProductFiles(selected);
  }, [productFiles]);

  const handleProductDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(false);
    if (e.dataTransfer?.files?.length) handleProductFileSelected(e.dataTransfer.files, { append: true });
  }, [handleProductFileSelected]);

  const handleProductDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(true);
  }, []);

  const handleProductDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(false);
  }, []);

  const clearProductImage = () => {
    setProductFiles([]);
    productPreviews.forEach(item => URL.revokeObjectURL(item.url));
    setProductPreviews([]);
    if (productFileInputRef.current) productFileInputRef.current.value = '';
  };

  const removeProductImageAt = (indexToRemove) => {
    setProductPreviews(prev => {
      const removed = prev[indexToRemove];
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return prev.filter((_, index) => index !== indexToRemove);
    });
    setProductFiles(prev => {
      const next = prev.filter((_, index) => index !== indexToRemove);
      if (next.length === 0 && productFileInputRef.current) productFileInputRef.current.value = '';
      return next;
    });
  };

  // --- Generation ---
  const isCustomPromptMode = customPrompt.trim().length > 0;

  // Helper to update a specific generation entry
  const updateGen = (genId, updates) => {
    setActiveGens(prev => prev.map(g => g.id === genId ? { ...g, ...updates, lastEventAt: Date.now() } : g));
  };

  // Remove a completed/errored generation from the list
  const dismissGen = (genId) => {
    setActiveGens(prev => prev.filter(g => g.id !== genId));
  };

  // --- Tag management ---
  const QUICK_TAGS = ['Winner', 'Test', 'Control', 'V2', 'Review'];

  const handleAddTag = async (ad, tag) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const current = ad.tags || [];
    if (current.includes(trimmed)) return;
    const newTags = [...current, trimmed];
    // Optimistic update
    setAds(prev => prev.map(a => a.id === ad.id ? { ...a, tags: newTags } : a));
    if (tagEditAd?.id === ad.id) setTagEditAd(prev => prev ? { ...prev, tags: newTags } : null);
    if (viewAd?.id === ad.id) setViewAd(prev => prev ? { ...prev, tags: newTags } : null);
    try {
      await api.updateAdTags(projectId, ad.id, newTags);
    } catch (err) {
      console.error('Failed to save tag:', err);
      // Revert on failure
      setAds(prev => prev.map(a => a.id === ad.id ? { ...a, tags: current } : a));
    }
  };

  const handleRemoveTag = async (ad, tag) => {
    const current = ad.tags || [];
    const newTags = current.filter(t => t !== tag);
    // Optimistic update
    setAds(prev => prev.map(a => a.id === ad.id ? { ...a, tags: newTags } : a));
    if (tagEditAd?.id === ad.id) setTagEditAd(prev => prev ? { ...prev, tags: newTags } : null);
    if (viewAd?.id === ad.id) setViewAd(prev => prev ? { ...prev, tags: newTags } : null);
    try {
      await api.updateAdTags(projectId, ad.id, newTags);
    } catch (err) {
      console.error('Failed to remove tag:', err);
      setAds(prev => prev.map(a => a.id === ad.id ? { ...a, tags: current } : a));
    }
  };

  const handleToggleFavorite = async (ad, e) => {
    if (e) e.stopPropagation();
    const newFavorite = !ad.is_favorite;
    // Optimistic update
    setAds(prev => prev.map(a => a.id === ad.id ? { ...a, is_favorite: newFavorite } : a));
    if (viewAd?.id === ad.id) setViewAd(prev => prev ? { ...prev, is_favorite: newFavorite } : null);
    try {
      await api.toggleAdFavorite(projectId, ad.id, newFavorite);
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
      setAds(prev => prev.map(a => a.id === ad.id ? { ...a, is_favorite: !newFavorite } : a));
      if (viewAd?.id === ad.id) setViewAd(prev => prev ? { ...prev, is_favorite: !newFavorite } : null);
    }
  };

  // Bulk tag functions for multi-select action bar
  const handleBulkAddTag = async (tag) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const selectedAdsArr = ads.filter(a => selectedAdIds.has(a.id));
    // Only update ads that don't already have this tag
    const adsToUpdate = selectedAdsArr.filter(a => !(a.tags || []).includes(trimmed));
    if (adsToUpdate.length === 0) return;

    // Optimistic update
    setAds(prev => prev.map(a => {
      if (!selectedAdIds.has(a.id)) return a;
      const current = a.tags || [];
      if (current.includes(trimmed)) return a;
      return { ...a, tags: [...current, trimmed] };
    }));

    // API calls in parallel
    await Promise.allSettled(
      adsToUpdate.map(ad => {
        const newTags = [...(ad.tags || []), trimmed];
        return api.updateAdTags(projectId, ad.id, newTags).catch(err => {
          console.error(`Failed to add tag to ad ${ad.id}:`, err);
        });
      })
    );
  };

  const handleBulkRemoveTag = async (tag) => {
    const selectedAdsArr = ads.filter(a => selectedAdIds.has(a.id));
    const adsToUpdate = selectedAdsArr.filter(a => (a.tags || []).includes(tag));
    if (adsToUpdate.length === 0) return;

    // Optimistic update
    setAds(prev => prev.map(a => {
      if (!selectedAdIds.has(a.id)) return a;
      const current = a.tags || [];
      if (!current.includes(tag)) return a;
      return { ...a, tags: current.filter(t => t !== tag) };
    }));

    // API calls in parallel
    await Promise.allSettled(
      adsToUpdate.map(ad => {
        const newTags = (ad.tags || []).filter(t => t !== tag);
        return api.updateAdTags(projectId, ad.id, newTags).catch(err => {
          console.error(`Failed to remove tag from ad ${ad.id}:`, err);
        });
      })
    );
  };

  const scrollToQueue = () => {
    queueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleGenerationCompleteEvent = (genId, eventAd, successMessage) => {
    const nextAd = normalizeAdRecord(eventAd);
    if (isCompletedImageReady(nextAd)) {
      updateGen(genId, {
        status: 'completed',
        message: successMessage,
        progress: 100,
        adExternalId: nextAd.id,
        source: 'sse',
      });
      setAds(prev => [nextAd, ...prev.filter(ad => ad.id !== nextAd.id)]);
      return;
    }

    updateGen(genId, {
      status: 'generating_image',
      message: 'Finalizing image preview...',
      progress: 95,
      adExternalId: nextAd.id,
      source: 'sse',
    });
  };

  const handleGenerationCancelledEvent = (genId, message = 'Cancelled') => {
    updateGen(genId, {
      status: 'cancelled',
      message,
      progress: 0,
      error: '',
      warning: '',
      cancelling: false,
      source: 'sse',
    });
    loadAds();
  };

  const handleCancelGeneration = async (gen) => {
    if (!gen?.adExternalId || gen.cancelling || gen.status === 'cancelled' || gen.status === 'completed') return;
    updateGen(gen.id, {
      cancelling: true,
      message: 'Cancelling...',
      warning: '',
    });
    try {
      await api.cancelAd(projectId, gen.adExternalId);
      gen.stream?.abort?.();
      updateGen(gen.id, {
        message: 'Cancellation requested...',
        cancelling: true,
      });
    } catch (err) {
      if (err?.status === 409) {
        toast.info('Generation already finished — refresh to see result.');
      } else {
        toast.error(err.message || 'Failed to cancel generation.');
      }
      updateGen(gen.id, { cancelling: false });
    }
  };

  const handleGenerationErrorAction = useCallback((gen) => {
    if (gen?.errorCode === 'MISSING_PRODUCT_DESCRIPTION' && gen.errorActionUrl) {
      navigate(gen.errorActionUrl);
    }
  }, [navigate]);

  const handleGenerate = async () => {
    // Create a unique ID for this generation
    const genId = ++genIdCounter.current;
    const genLabel = angle || aspectRatio;

    // Validation first (before adding to active list)
    if (!isCustomPromptMode) {
      if (templateSource === TEMPLATE_UPLOAD && !uploadedFile) {
        toast.error('Please upload a template image or switch to "Random from Folder".');
        return;
      }
      if (templateSource === TEMPLATE_SELECT && !selectedTemplate) {
        toast.error('Please select a template image.');
        return;
      }
    }

    // Add this generation to active list
    const isWaitingForTurn = activeGenCount > 0;
    const now = Date.now();
    const newGen = { id: genId, label: genLabel, status: isWaitingForTurn ? 'queued' : 'preparing', message: isWaitingForTurn ? 'Waiting for the current ad to finish...' : 'Preparing...', error: '', warning: '', progress: isWaitingForTurn ? 0 : 1, startTime: now, lastEventAt: now };
    setActiveGens(prev => [...prev, newGen]);

    // Notify with toast + scroll link
    toast.info(
      <span>
        Generation started{' '}
        <button
          onClick={scrollToQueue}
          className="underline font-semibold hover:text-ed-accent/80 transition-colors"
        >
          View Queue ↓
        </button>
      </span>
    );

    const previousGeneration = singleGenerationQueueRef.current.catch(() => {});
    const queuedRun = (async () => {
    await previousGeneration;
    updateGen(genId, { status: 'preparing', message: 'Preparing...', progress: 1 });

    // Track resized File objects across all attachments for the pre-flight combined-size check.
    const resizedFiles = [];

    // Helper: pre-flight check combined-attachment size against Vercel's gateway limit.
    const exceedsCombinedSizeLimit = () => {
      if (estimateBase64BodyBytes(resizedFiles) > MAX_COMBINED_BODY_BYTES) {
        updateGen(genId, {
          error: 'Combined image data is too large. Try fewer or smaller images.',
          status: null
        });
        return true;
      }
      return false;
    };

    // Helper: attach product image if present (with auto-resize for Vercel body limits)
    const attachProductImage = async (opts) => {
      if (productFiles.length > 0) {
        const sourceFiles = [...productFiles];
        const productImages = [];
        try {
          for (const sourceFile of sourceFiles) {
            const { base64, mime, file: resized } = await resizeAndBase64(sourceFile);
            productImages.push({ base64, mimeType: mime });
            resizedFiles.push(resized);
          }
          if (sourceFiles.length !== productFiles.length || sourceFiles.some((file, index) => file !== productFiles[index])) return false;
          opts.product_images = productImages;
          if (productImages[0]) {
            opts.product_image = productImages[0].base64;
            opts.product_image_mime = productImages[0].mimeType;
          }
        } catch (err) {
          updateGen(genId, { error: err.message || 'Failed to read the reference images.', status: null });
          return false;
        }
      }
      return true;
    };

    // SSE event handler scoped to this generation
    const handleEvent = (event) => {
      if (event.type === 'status') {
        if (event.adId) {
          // First event with adId: link this gen to its DB record + remove any restored duplicate
          setActiveGens(prev => prev
            .filter(g => !(g.source === 'restored' && g.adExternalId === event.adId))
            .map(g => g.id === genId
              ? { ...g, status: event.status, message: event.message, progress: event.progress || 0, adExternalId: event.adId, source: 'sse', lastEventAt: Date.now() }
              : g
            )
          );
        } else {
          updateGen(genId, { status: event.status, message: event.message, progress: event.progress || 0 });
        }
      } else if (event.type === 'warning') {
        updateGen(genId, { warning: event.message });
      } else if (event.type === 'complete') {
        handleGenerationCompleteEvent(genId, event.ad, 'Ad generated successfully!');
      } else if (event.type === 'cancelled') {
        handleGenerationCancelledEvent(genId, event.message || 'Cancelled');
      } else if (event.type === 'error') {
        updateGen(genId, generationErrorUpdates(event));
      }
    };

    const hadOneTimeProductFiles = productFiles.length > 0;
    let uploadedExtraReferenceImages = [];
    let stream;

    if (isCustomPromptMode) {
      updateGen(genId, { status: 'generating_image', message: 'Generating image with custom prompt...', progress: 10 });

      const options = {
        image_prompt: customPrompt.trim(),
        aspect_ratio: aspectRatio,
        image_model: imageModel,
        parent_ad_id: parentAdId || undefined,
        angle: angle || undefined,
        headline: headline || undefined,
        body_copy: bodyCopy || undefined,
        skip_product_image: skipProductImage || undefined,
        save_as_project_default: saveProductAsDefault || undefined
      };

      if (!(await attachProductImage(options))) return;

          // Use the edit reference as the image input for Gemini rendering.
          if (editReferenceFile) {
            const sourceRef = editReferenceFile;
            try {
              const { base64, mime, file: resized } = await resizeAndBase64(sourceRef);
              if (sourceRef === editReferenceFile) {
                options.reference_image = base64;
                options.reference_image_mime = mime;
                if (!options.product_image) {
                  options.product_image = base64;
                  options.product_image_mime = mime;
                }
            resizedFiles.push(resized);
          }
        } catch { /* non-fatal — proceed without the reference image */ }
      }

      if (exceedsCombinedSizeLimit()) return;
      stream = api.regenerateImage(projectId, options, handleEvent);
      updateGen(genId, { stream });
    } else if (templateSource === TEMPLATE_SELECT && selectedTemplate) {
      updateGen(genId, { status: 'generating_copy', message: 'Starting template-based generation...' });

      const options = {
        aspect_ratio: aspectRatio,
        image_model: imageModel,
        angle: angle || undefined,
        headline: headline || undefined,
        body_copy: bodyCopy || undefined,
        skip_product_image: skipProductImage || undefined,
        save_as_project_default: saveProductAsDefault || undefined
      };

      if (selectedTemplate.source === 'drive') {
        options.mode = 'mode1';
        options.inspiration_image_id = selectedTemplate.id;
      } else {
        options.mode = 'mode2';
        options.template_image_id = selectedTemplate.id;
      }

      if (!(await attachProductImage(options))) return;

      if (exceedsCombinedSizeLimit()) return;
      stream = api.generateAd(projectId, options, handleEvent);
      updateGen(genId, { stream });
    } else {
      updateGen(genId, { status: 'generating_copy', message: 'Starting ad generation...' });

      const options = {
        mode: 'mode1',
        aspect_ratio: aspectRatio,
        image_model: imageModel,
        angle: angle || undefined,
        headline: headline || undefined,
        body_copy: bodyCopy || undefined,
        skip_product_image: skipProductImage || undefined,
        save_as_project_default: saveProductAsDefault || undefined
      };
      if (templateSource === TEMPLATE_RANDOM && templateTag) {
        options.template_tag = templateTag;
      }

      if (templateSource === TEMPLATE_UPLOAD && uploadedFiles.length > 0) {
        const sourceUploaded = [...uploadedFiles];
        const uploadedImages = [];
        try {
          for (const sourceFile of sourceUploaded) {
            const { base64, mime, file: resized } = await resizeAndBase64(sourceFile);
            uploadedImages.push({ base64, mimeType: mime });
            resizedFiles.push(resized);
          }
          if (sourceUploaded.length !== uploadedFiles.length || sourceUploaded.some((file, index) => file !== uploadedFiles[index])) return; // user replaced mid-resize; abandon
          options.uploaded_images = uploadedImages;
          if (uploadedImages[0]) {
            options.uploaded_image = uploadedImages[0].base64;
            options.uploaded_image_mime = uploadedImages[0].mimeType;
          }
          uploadedExtraReferenceImages = uploadedImages.slice(1);
        } catch (err) {
          updateGen(genId, { error: err.message || 'Failed to read the uploaded images.', status: null });
          return;
        }
      }

      if (!(await attachProductImage(options))) return;
      if (uploadedExtraReferenceImages.length > 0) {
        const existingRefs = Array.isArray(options.product_images) ? options.product_images : [];
        const combinedRefs = [...existingRefs, ...uploadedExtraReferenceImages];
        if (combinedRefs.length > 10) {
          updateGen(genId, { error: 'Combined image references are limited to 10. Remove a template or reference image and try again.', status: null });
          return;
        }
        options.product_images = combinedRefs;
        if (combinedRefs[0]) {
          options.product_image = combinedRefs[0].base64;
          options.product_image_mime = combinedRefs[0].mimeType;
        }
      }

      if (exceedsCombinedSizeLimit()) return;
      stream = api.generateAd(projectId, options, handleEvent);
      updateGen(genId, { stream });
    }

    if (hadOneTimeProductFiles && !saveProductAsDefault) {
      clearProductImage();
    }

    await stream.done
      .then(() => {
        // Auto-dismiss successful generations after 5 seconds
        setTimeout(() => {
          setActiveGens(prev => {
            const gen = prev.find(g => g.id === genId);
            if (gen && gen.status === 'completed' && !gen.error) {
              return prev.filter(g => g.id !== genId);
            }
            return prev;
          });
        }, 5000);
      })
      .catch(err => {
        setActiveGens(prev => prev.map(g => {
          if (g.id !== genId) return g;
          if (g.cancelling) {
            return { ...g, status: 'cancelled', message: 'Cancelled', progress: 0, cancelling: false, warning: '' };
          }
          if (g.adExternalId) {
            return {
              ...g,
              status: g.status || 'generating_image',
              message: 'Connection ended; checking saved ad status...',
              warning: err.message,
              progress: Math.max(g.progress || 0, 80),
              lastEventAt: Date.now(),
            };
          }
          return { ...g, error: err.message, status: null };
        }));
      });
    })();
    singleGenerationQueueRef.current = queuedRun.catch(() => {});
    return queuedRun;
  };

  const handleDelete = async (adId) => {
    if (!confirm('Delete this ad? The local file will be removed. The Drive copy (if any) will remain.')) return;
    try {
      await api.deleteAd(projectId, adId);
      setAds(prev => prev.filter(a => a.id !== adId));
      setSelectedAdIds(prev => {
        if (prev.has(adId)) { const next = new Set(prev); next.delete(adId); return next; }
        return prev;
      });
      if (viewAd?.id === adId) setViewAd(null);
    } catch (err) {
      toast.error(err.message);
    }
  };

  // No longer needed — progress steps are computed per-generation in the JSX

  // Download ad image to local device
  const handleDownload = async (ad, e) => {
    if (e) e.stopPropagation();
    try {
      const blob = await fetchBlobOrThrow(ad.imageUrl, 'Image download failed');
      const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
      const filename = `ad_${ad.angle ? ad.angle.replace(/[^a-z0-9]/gi, '-').slice(0, 30) : ad.id.slice(0, 8)}_${ad.aspect_ratio.replace(':', 'x')}${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Failed to download image');
    }
  };

  // --- Multi-select helpers ---
  const toggleAdSelection = (adId, e) => {
    if (e) e.stopPropagation();
    setSelectedAdIds(prev => {
      const next = new Set(prev);
      if (next.has(adId)) next.delete(adId);
      else next.add(adId);
      return next;
    });
  };

  const selectAllFiltered = () => {
    const selectableIds = filteredAds
      .filter(isSelectableAd)
      .map(ad => ad.id);
    setSelectedAdIds(new Set(selectableIds));
  };

  const clearSelection = () => { setSelectedAdIds(new Set()); setBulkTagOpen(false); setBulkTagInput(''); };

  // --- Deployed ad tracking ---
  const [deployedAdIds, setDeployedAdIds] = useState(new Set());
  useEffect(() => {
    api.getProjectDeployments(projectId).then(data => {
      const ids = new Set(ensureArray(data?.deployments, 'AdStudio.deployments').map(d => d.ad_id));
      setDeployedAdIds(ids);
    }).catch(() => {});
  }, [projectId]);

  const selectedCount = selectedAdIds.size;
  const selectedAdsForBulk = ads.filter(ad => selectedAdIds.has(ad.id));
  const pipelineSendableSelectedCount = selectedAdsForBulk.filter(ad => isPipelineSendableAd(ad, deployedAdIds)).length;
  const downloadableSelectedCount = selectedAdsForBulk.filter(isDownloadableImageAd).length;

  useEffect(() => {
    setSelectedAdIds(prev => {
      if (prev.size === 0) return prev;
      const selectableIds = new Set(ads.filter(isSelectableAd).map(ad => ad.id));
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (selectableIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [ads]);

  useEffect(() => {
    if (selectedCount === 0 && bulkTagOpen) {
      setBulkTagOpen(false);
      setBulkTagInput('');
    }
  }, [selectedCount, bulkTagOpen]);

  // --- Deploy to Ad Tracker ---
  const handleDeploy = async () => {
    if (selectedAdIds.size === 0) return;
    const deployableAds = ads.filter(ad => selectedAdIds.has(ad.id) && isPipelineSendableAd(ad, deployedAdIds));
    if (deployableAds.length === 0) {
      toast.addToast('No selected ads are eligible to send. QA rejected, failed, and already-deployed ads are skipped.', 'info');
      return;
    }
    setIsDeploying(true);
    const adIds = deployableAds.map(ad => ad.id);
    // Optimistic: immediately mark as deployed so badges appear
    setDeployedAdIds(prev => {
      const next = new Set(prev);
      adIds.forEach(id => next.add(id));
      return next;
    });
    clearSelection();
    try {
      const result = await api.createDeployments(projectId, adIds);
      const created = Number(result.created) || 0;
      const skipped = Number(result.skipped) || 0;
      const msg = created > 0
        ? `${created} ad${created !== 1 ? 's' : ''} sent to Ad Pipeline -> Queue${skipped > 0 ? ` (${skipped} already there)` : ''}`
        : 'All eligible selected ads are already in Ad Pipeline -> Queue';
      toast.addToast(
        msg,
        created > 0 ? 'success' : 'info',
        8000,
        onOpenPipeline ? { label: 'Open Pipeline', onClick: onOpenPipeline } : null
      );
      const data = await api.getProjectDeployments(projectId, { force: true });
      const ids = new Set(ensureArray(data?.deployments, 'AdStudio.deployments').map(d => d.ad_id));
      setDeployedAdIds(ids);
    } catch (err) {
      // Revert optimistic update on failure
      setDeployedAdIds(prev => {
        const next = new Set(prev);
        adIds.forEach(id => next.delete(id));
        return next;
      });
      toast.addToast('Failed to send to Ad Pipeline', 'error');
    } finally {
      setIsDeploying(false);
    }
  };

  // --- Bulk download ---
  const handleBulkDownload = async () => {
    if (selectedAdIds.size === 0) return;
    setIsBulkDownloading(true);
    try {
      const zip = new JSZip();
      const selectedAds = ads.filter(ad => selectedAdIds.has(ad.id) && isDownloadableImageAd(ad));

      if (selectedAds.length === 0) {
        toast.error('No selected ads have downloadable images.');
        return;
      }

      const results = await Promise.allSettled(
        selectedAds.map(async (ad) => {
          const blob = await fetchBlobOrThrow(ad.imageUrl, 'Image download failed');
          const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
          const filename = `ad_${ad.angle ? ad.angle.replace(/[^a-z0-9]/gi, '-').slice(0, 30) : ad.id.slice(0, 8)}_${ad.aspect_ratio.replace(':', 'x')}${ext}`;
          return { filename, blob };
        })
      );

      let addedCount = 0;
      const usedNames = new Set();
      for (const result of results) {
        if (result.status === 'fulfilled') {
          let name = result.value.filename;
          if (usedNames.has(name)) {
            const parts = name.split('.');
            const ext = parts.pop();
            let counter = 2;
            while (usedNames.has(`${parts.join('.')}_${counter}.${ext}`)) counter++;
            name = `${parts.join('.')}_${counter}.${ext}`;
          }
          usedNames.add(name);
          zip.file(name, result.value.blob);
          addedCount++;
        }
      }

      if (addedCount === 0) {
        toast.error('Failed to download any images.');
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ads_${addedCount}_images.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const failedCount = results.filter(r => r.status === 'rejected').length;
      if (failedCount > 0) {
        toast.success(`Downloaded ${addedCount} ads. ${failedCount} failed to fetch.`);
      } else {
        toast.success(`Downloaded ${addedCount} ads as zip.`);
      }
      clearSelection();
    } catch (err) {
      console.error('Bulk download failed:', err);
      toast.error('Failed to create zip file.');
    } finally {
      setIsBulkDownloading(false);
    }
  };

  // --- Bulk delete ---
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const handleBulkDelete = async () => {
    const count = selectedAdIds.size;
    if (count === 0) return;
    if (!confirm(`Delete ${count} ad${count !== 1 ? 's' : ''}? Local files will be removed. Drive copies (if any) will remain.`)) return;
    setIsBulkDeleting(true);
    try {
      const ids = [...selectedAdIds];
      const results = await Promise.allSettled(
        ids.map(id => api.deleteAd(projectId, id))
      );
      const succeeded = ids.filter((_, i) => results[i].status === 'fulfilled');
      const failed = ids.filter((_, i) => results[i].status === 'rejected');
      if (succeeded.length > 0) {
        setAds(prev => prev.filter(a => !succeeded.includes(a.id)));
        clearSelection();
        if (viewAd && succeeded.includes(viewAd.id)) setViewAd(null);
      }
      if (failed.length > 0) {
        toast.error(`Deleted ${succeeded.length} ads. ${failed.length} failed.`);
      } else {
        toast.success(`Deleted ${succeeded.length} ad${succeeded.length !== 1 ? 's' : ''}.`);
      }
    } catch (err) {
      toast.error('Bulk delete failed.');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  // Regenerate an ad with the same parameters
  const handleRegenerate = async (ad, e) => {
    if (e) e.stopPropagation();
    if (viewAd) setViewAd(null);

    let sourceAd = ad;
    let sourcePrompt = getEditablePrompt(sourceAd);
    if (ad.generation_mode === 'image_only') {
      try {
        sourceAd = await hydrateAd(ad);
        sourcePrompt = getEditablePrompt(sourceAd);
      } catch (err) {
        toast.error(err.message || 'Failed to load ad details.');
        return;
      }
      if (!sourcePrompt) {
        toast.error('This ad does not have a saved generation prompt, so image editing is unavailable.');
        return;
      }
    }

    const genId = ++genIdCounter.current;
    const genLabel = sourceAd.angle || sourceAd.aspect_ratio || 'Regeneration';

    const isWaitingForTurn = activeGenCount > 0;
    const newGen = {
      id: genId,
      label: genLabel,
      status: isWaitingForTurn ? 'queued' : 'preparing',
      message: isWaitingForTurn ? 'Waiting for the current ad to finish...' : 'Preparing regeneration...',
      error: '',
      warning: '',
      progress: isWaitingForTurn ? 0 : 1,
      startTime: Date.now(),
      lastEventAt: Date.now()
    };
    setActiveGens(prev => [...prev, newGen]);

    toast.info(
      <span>
        Regenerating ad{' '}
        <button onClick={scrollToQueue} className="underline font-semibold hover:text-ed-accent/80 transition-colors">View Queue ↓</button>
      </span>
    );

    const previousGeneration = singleGenerationQueueRef.current.catch(() => {});
    const queuedRun = (async () => {
    await previousGeneration;
    updateGen(genId, { status: 'preparing', message: 'Preparing regeneration...', progress: 1 });

    const handleEvent = (event) => {
      if (event.type === 'status') {
        if (event.adId) {
          setActiveGens(prev => prev
            .filter(g => !(g.source === 'restored' && g.adExternalId === event.adId))
            .map(g => g.id === genId
              ? { ...g, status: event.status, message: event.message, progress: event.progress || 0, adExternalId: event.adId, source: 'sse', lastEventAt: Date.now() }
              : g
            )
          );
        } else {
          updateGen(genId, { status: event.status, message: event.message, progress: event.progress || 0 });
        }
      } else if (event.type === 'warning') {
        updateGen(genId, { warning: event.message });
      } else if (event.type === 'complete') {
        handleGenerationCompleteEvent(genId, event.ad, 'Ad regenerated successfully!');
      } else if (event.type === 'cancelled') {
        handleGenerationCancelledEvent(genId, event.message || 'Cancelled');
      } else if (event.type === 'error') {
        updateGen(genId, generationErrorUpdates(event));
      }
    };

    let stream;

    if (sourceAd.generation_mode === 'image_only' && sourcePrompt) {
      // Prompt-edit ads: regenerate image with the same prompt
      updateGen(genId, { status: 'generating_image', message: 'Regenerating image...', progress: 10 });
      stream = api.regenerateImage(projectId, {
        image_prompt: sourcePrompt,
        aspect_ratio: sourceAd.aspect_ratio || '1:1',
        parent_ad_id: sourceAd.id,
        angle: sourceAd.angle || undefined,
        headline: sourceAd.headline || undefined,
        body_copy: sourceAd.body_copy || undefined,
      }, handleEvent);
      updateGen(genId, { stream });
    } else if (sourceAd.generation_mode === 'mode2' && sourceAd.template_image_id) {
      // Template-based ads: regenerate with same template
      updateGen(genId, { status: 'generating_copy', message: 'Regenerating template-based ad...', progress: 5 });
      stream = api.generateAd(projectId, {
        mode: 'mode2',
        template_image_id: sourceAd.template_image_id,
        aspect_ratio: sourceAd.aspect_ratio || '1:1',
        angle: sourceAd.angle || undefined,
        headline: sourceAd.headline || undefined,
        body_copy: sourceAd.body_copy || undefined,
      }, handleEvent);
      updateGen(genId, { stream });
    } else {
      // Standard mode1 ads: regenerate with random inspiration
      updateGen(genId, { status: 'generating_copy', message: 'Regenerating ad...', progress: 5 });
      stream = api.generateAd(projectId, {
        mode: 'mode1',
        aspect_ratio: sourceAd.aspect_ratio || '1:1',
        angle: sourceAd.angle || undefined,
        headline: sourceAd.headline || undefined,
        body_copy: sourceAd.body_copy || undefined,
      }, handleEvent);
      updateGen(genId, { stream });
    }

    await stream.done
      .then(() => {
        setTimeout(() => {
          setActiveGens(prev => {
            const gen = prev.find(g => g.id === genId);
            if (gen && gen.status === 'completed' && !gen.error) {
              return prev.filter(g => g.id !== genId);
            }
            return prev;
          });
        }, 5000);
      })
      .catch(err => {
        setActiveGens(prev => prev.map(g => {
          if (g.id !== genId) return g;
          if (g.cancelling) {
            return { ...g, status: 'cancelled', message: 'Cancelled', progress: 0, cancelling: false, warning: '' };
          }
          if (g.adExternalId) {
            return {
              ...g,
              status: g.status || 'generating_image',
              message: 'Connection ended; checking saved ad status...',
              warning: err.message,
              progress: Math.max(g.progress || 0, 80),
              lastEventAt: Date.now(),
            };
          }
          return { ...g, error: err.message, status: null };
        }));
      });
    })();
    singleGenerationQueueRef.current = queuedRun.catch(() => {});
    return queuedRun;
  };

  const handleRetryImageFromSavedPrompt = async (ad, e) => {
    if (e) e.stopPropagation();
    if (viewAd) setViewAd(null);

    let sourceAd;
    try {
      sourceAd = await hydrateAd(ad);
    } catch (err) {
      toast.error(err.message || 'Failed to load the saved prompt.');
      return;
    }

    const sourcePrompt = getEditablePrompt(sourceAd);
    if (!sourcePrompt) {
      toast.error('This failed ad does not have a saved image prompt, so it cannot be repaired automatically.');
      return;
    }

    const genId = ++genIdCounter.current;
    const genLabel = sourceAd.angle || sourceAd.aspect_ratio || 'Image retry';
    const isWaitingForTurn = activeGenCount > 0;

    setActiveGens(prev => [...prev, {
      id: genId,
      label: genLabel,
      status: isWaitingForTurn ? 'queued' : 'preparing',
      message: isWaitingForTurn ? 'Waiting for the current ad to finish...' : 'Retrying image from saved prompt...',
      error: '',
      warning: '',
      progress: isWaitingForTurn ? 0 : 1,
      startTime: Date.now(),
      lastEventAt: Date.now(),
    }]);

    toast.info(
      <span>
        Retrying image from the saved prompt{' '}
        <button onClick={scrollToQueue} className="underline font-semibold hover:text-ed-accent/80 transition-colors">View Queue ↓</button>
      </span>
    );

    const previousGeneration = singleGenerationQueueRef.current.catch(() => {});
    const queuedRun = (async () => {
      await previousGeneration;
      updateGen(genId, { status: 'generating_image', message: 'Retrying image from saved prompt...', progress: 10 });

      const handleEvent = (event) => {
        if (event.type === 'status') {
          if (event.adId) {
            setActiveGens(prev => prev
              .filter(g => !(g.source === 'restored' && g.adExternalId === event.adId))
              .map(g => g.id === genId
                ? { ...g, status: event.status, message: event.message, progress: event.progress || 0, adExternalId: event.adId, source: 'sse', lastEventAt: Date.now() }
                : g
              )
            );
          } else {
            updateGen(genId, { status: event.status, message: event.message, progress: event.progress || 0 });
          }
        } else if (event.type === 'warning') {
          updateGen(genId, { warning: event.message });
        } else if (event.type === 'complete') {
          handleGenerationCompleteEvent(genId, event.ad, 'Image retry completed!');
        } else if (event.type === 'cancelled') {
          handleGenerationCancelledEvent(genId, event.message || 'Cancelled');
        } else if (event.type === 'error') {
          updateGen(genId, generationErrorUpdates(event));
        }
      };

      const stream = api.regenerateImage(projectId, {
        image_prompt: sourcePrompt,
        aspect_ratio: sourceAd.aspect_ratio || '1:1',
        image_model: sourceAd.image_model || imageModel,
        parent_ad_id: sourceAd.id,
        angle: sourceAd.angle || undefined,
        headline: sourceAd.headline || undefined,
        body_copy: sourceAd.body_copy || undefined,
      }, handleEvent);
      updateGen(genId, { stream });

      await stream.done
        .then(() => {
          setTimeout(() => {
            setActiveGens(prev => {
              const gen = prev.find(g => g.id === genId);
              if (gen && gen.status === 'completed' && !gen.error) {
                return prev.filter(g => g.id !== genId);
              }
              return prev;
            });
          }, 5000);
        })
        .catch(err => {
          setActiveGens(prev => prev.map(g => {
            if (g.id !== genId) return g;
            if (g.cancelling) {
              return { ...g, status: 'cancelled', message: 'Cancelled', progress: 0, cancelling: false, warning: '' };
            }
            if (g.adExternalId) {
              return {
                ...g,
                status: g.status || 'generating_image',
                message: 'Connection ended; checking saved ad status...',
                warning: err.message,
                progress: Math.max(g.progress || 0, 80),
                lastEventAt: Date.now(),
              };
            }
            return { ...g, error: err.message, status: null };
          }));
        });
    })();

    singleGenerationQueueRef.current = queuedRun.catch(() => {});
    return queuedRun;
  };

  // Edit prompt workflow — load ad's prompt into editor and scroll to top
  const handleEditPrompt = async (ad, e) => {
    if (e) e.stopPropagation();
    let editableAd = ad;
    try {
      editableAd = await hydrateAd(ad);
    } catch (err) {
      toast.error(err.message || 'Failed to load ad details.');
      return;
    }
    const editablePrompt = getEditablePrompt(editableAd);
    if (!editablePrompt) {
      toast.error('This ad does not have a saved generation prompt, so image editing is unavailable.');
      return;
    }
    setCustomPrompt(editablePrompt);
    setOriginalPromptRef(editablePrompt);
    setParentAdId(editableAd.id);
    setEditingAdImage(editableAd.imageUrl || editableAd.thumbnailUrl || ad.imageUrl || ad.thumbnailUrl || null);
    setAspectRatio(editableAd.aspect_ratio || '1:1');
    if (editableAd.angle) {
      angleTouchedRef.current = true;
      setAngleModeOverride('');
      setAngle(editableAd.angle);
    }
    if (editableAd.headline) setHeadline(editableAd.headline);
    if (editableAd.body_copy) setBodyCopy(editableAd.body_copy);
    setEditMode('describe');
    setEditInstruction('');
    setViewAd(null);
    // Scroll edit panel into center of screen after React renders it, then flash + focus
    setTimeout(() => {
      if (editPanelRef.current) {
        editPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setEditPanelFlash(true);
        setTimeout(() => setEditPanelFlash(false), 1500);
        // Focus the textarea after scroll settles
        setTimeout(() => {
          if (editTextareaRef.current) editTextareaRef.current.focus();
        }, 500);
      }
    }, 100);
  };

  // Redo — load an ad's settings back into the generation form for iteration
  const handleRedo = async (ad, e) => {
    if (e) e.stopPropagation();

    // Load core settings
    if (ad.angle) {
      angleTouchedRef.current = true;
      setAngleModeOverride('');
      setAngle(ad.angle);
    }
    if (ad.headline) setHeadline(ad.headline);
    if (ad.body_copy) setBodyCopy(ad.body_copy);
    if (ad.aspect_ratio) setAspectRatio(ad.aspect_ratio);

    // If template-based, re-select the template (loading templates if needed)
    if (ad.generation_mode === 'mode2' && ad.template_image_id) {
      const trySelectTemplate = (drive, uploaded) => {
        const driveMatch = drive.find(img => img.id === ad.template_image_id);
        const uploadMatch = uploaded.find(img => img.id === ad.template_image_id);
        if (driveMatch) {
          setSelectedTemplate({ id: driveMatch.id, source: 'drive' });
          return true;
        } else if (uploadMatch) {
          setSelectedTemplate({ id: uploadMatch.id, source: 'uploaded' });
          return true;
        }
        return false;
      };

      setTemplateSource(TEMPLATE_SELECT);

      // If templates are already loaded, select immediately
      if (driveImages.length > 0 || uploadedTemplates.length > 0) {
        if (!trySelectTemplate(driveImages, uploadedTemplates)) {
          toast.info('Original template no longer available — using template picker');
        }
      } else {
        // Templates not loaded yet — fetch them, then select
        try {
          const [driveData, uploadedData] = await Promise.all([
            api.getInspirationImages(projectId).catch(() => ({ images: [] })),
            api.getTemplates(projectId).catch(() => ({ templates: [] }))
          ]);
          const drive = ensureArray(driveData?.images, 'AdStudio.driveImages');
          const uploaded = ensureArray(uploadedData?.templates, 'AdStudio.uploadedTemplates');
          setDriveImages(drive);
          setUploadedTemplates(uploaded);
          if (!trySelectTemplate(drive, uploaded)) {
            toast.info('Original template no longer available — using template picker');
          }
        } catch {
          toast.info('Could not load templates — select one manually');
        }
      }
    }

    // Clear custom prompt mode so we're in fresh generation mode
    setCustomPrompt('');
    setParentAdId(null);
    setEditingAdImage(null);
    setOriginalPromptRef('');
    setPromptUpdated(false);

    // Close modal if open
    if (viewAd) setViewAd(null);

    // Scroll to top of the form
    window.scrollTo({ top: 0, behavior: 'smooth' });

    toast.success(
      <span>
        Settings reused
        {ad.angle ? <span className="text-ed-green/70"> · {ad.angle}</span> : ''}
      </span>
    );
  };

  // Apply AI edit — send instruction to GPT which modifies the prompt
  const handleApplyEdit = async () => {
    if (!editInstruction.trim()) {
      toast.error('Please describe the edit you want to make.');
      return;
    }
    setIsApplyingEdit(true);
    try {
      // If a reference image is attached, resize + base64-encode and send along
      let referenceImage = null;
      let referenceImageMime = null;
      if (editReferenceFile) {
        const sourceRef = editReferenceFile;
        try {
          const { base64, mime } = await resizeAndBase64(sourceRef);
          if (sourceRef === editReferenceFile) {
            referenceImage = base64;
            referenceImageMime = mime;
          }
        } catch (err) {
          // Non-fatal — proceed without the image
          console.warn('Failed to read reference image, proceeding without it:', err.message);
        }
      }
      const result = await api.editPrompt(projectId, customPrompt, editInstruction.trim(), referenceImage, referenceImageMime);
      setCustomPrompt(result.revised_prompt);
      setEditInstruction('');
      setEditMode('direct'); // Switch to direct view so user can see the modified prompt
      setPromptUpdated(true);
      toast.success('Prompt updated — review it below, then hit Generate Image.');
    } catch (err) {
      toast.error(err.message || 'Failed to apply edit.');
    } finally {
      setIsApplyingEdit(false);
    }
  };

  // Filtered ads based on gallery filter (type) then date range
  // Stale-detection threshold: matches backend STUCK_ADS_THRESHOLD_MIN.
  // Long-running requests heartbeat; if they stop doing so, surface zombies.
  const typeFilteredAds = ads.filter(ad => {
    // Hide in-progress ads from gallery (they show in the queue instead) — but only if FRESH.
    // Ads stuck in generating_* > 5 min are zombies (Vercel function timeout, crash, etc.).
    // Surface them so Marco can see and dismiss them. Backend cleanup will flip status to 'failed' on next gallery load.
    if (isActiveGeneratingAd(ad)) {
      const ts = new Date(ad.created_at).getTime();
      const isStale = Number.isFinite(ts) && (Date.now() - ts > STUCK_THRESHOLD_MS);
      if (!isStale) return false;
    }
    if (galleryFilter === 'favorites') return !!ad.is_favorite;
    if (galleryFilter === 'individual') return !ad.auto_generated && !ad.batch_job_id;
    if (galleryFilter === 'batch') return !!ad.auto_generated || !!ad.batch_job_id;
    return true; // 'all'
  });

  const dateFilteredAds = typeFilteredAds.filter(ad => {
    if (dateRange === 'all') return true;
    const adDate = parseDate(ad.created_at);
    if (!adDate) return true; // show ads with unparseable dates
    const now = new Date();
    if (dateRange === 'today') {
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return adDate >= startOfToday;
    }
    if (dateRange === 'yesterday') {
      const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return adDate >= startOfYesterday;
    }
    if (dateRange === 'custom') {
      if (customFrom) {
        const from = new Date(customFrom + 'T00:00:00');
        if (adDate < from) return false;
      }
      if (customTo) {
        const to = new Date(customTo + 'T23:59:59');
        if (adDate > to) return false;
      }
      return true;
    }
    const daysMap = { '4d': 4, '7d': 7, '14d': 14, '30d': 30 };
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysMap[dateRange]);
    return adDate >= cutoff;
  });

  const filteredAds = searchQuery.trim()
    ? dateFilteredAds.filter(ad => {
        const q = searchQuery.trim().toLowerCase();
        return (ad.headline && ad.headline.toLowerCase().includes(q))
          || (ad.angle_name && ad.angle_name.toLowerCase().includes(q))
          || (ad.body_copy && ad.body_copy.toLowerCase().includes(q))
          || (ad.angle && ad.angle !== 'undefined' && ad.angle.toLowerCase().includes(q));
      })
    : dateFilteredAds;

  const hiddenByDateCount = typeFilteredAds.length - dateFilteredAds.length;

  // Client-side pagination — render a limited number of ads for responsiveness
  const AD_PAGE_SIZE = 24;
  const [displayCount, setDisplayCount] = useState(AD_PAGE_SIZE);
  const visibleAds = filteredAds.slice(0, displayCount);
  const hasMoreAds = displayCount < filteredAds.length;

  // Clear selection and reset pagination when filter changes
  useEffect(() => {
    setSelectedAdIds(new Set());
    setDisplayCount(AD_PAGE_SIZE);
  }, [galleryFilter, dateRange, searchQuery]);

  // Counts for filter labels
  const individualCount = ads.filter(a => !a.auto_generated && !a.batch_job_id).length;
  const batchCount = ads.filter(a => !!a.auto_generated || !!a.batch_job_id).length;
  const favoritesCount = ads.filter(a => !!a.is_favorite).length;
  const selectableFilteredAds = filteredAds.filter(isSelectableAd);
  const allFilteredSelected = selectableFilteredAds.length > 0 && selectableFilteredAds.every(ad => selectedAdIds.has(ad.id));
  const deployButtonTitle = pipelineSendableSelectedCount === 0
    ? 'No selected ads are eligible to send. QA rejected, failed, and already-deployed ads are skipped.'
    : pipelineSendableSelectedCount < selectedCount
      ? `Send ${pipelineSendableSelectedCount} eligible ad${pipelineSendableSelectedCount !== 1 ? 's' : ''} to Ad Pipeline. QA rejected, failed, and already-deployed ads will be skipped.`
      : 'Send selected ads to Ad Pipeline';
  const downloadButtonTitle = downloadableSelectedCount === 0
    ? 'No selected ads have downloadable images.'
    : downloadableSelectedCount < selectedCount
      ? `Download ${downloadableSelectedCount} image ad${downloadableSelectedCount !== 1 ? 's' : ''}. Failed ads without images will be skipped.`
      : 'Download selected ads';

  useEffect(() => {
    if (selectedCount === 0) {
      setBulkBarInGalleryRange(false);
      return undefined;
    }

    const updateBulkBarRange = () => {
      const gallery = galleryRef.current;
      if (!gallery) {
        setBulkBarInGalleryRange(false);
        return;
      }
      const rect = gallery.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      setBulkBarInGalleryRange(rect.bottom > 0 && rect.top < viewportHeight);
    };

    updateBulkBarRange();
    window.addEventListener('scroll', updateBulkBarRange, { passive: true });
    window.addEventListener('resize', updateBulkBarRange);
    return () => {
      window.removeEventListener('scroll', updateBulkBarRange);
      window.removeEventListener('resize', updateBulkBarRange);
    };
  }, [selectedCount, galleryView, displayCount, filteredAds.length]);

  useEffect(() => {
    if (!bulkBarInGalleryRange && bulkTagOpen) {
      setBulkTagOpen(false);
      setBulkTagInput('');
    }
  }, [bulkBarInGalleryRange, bulkTagOpen]);

  const shouldShowBulkBar = selectedCount > 0 && bulkBarInGalleryRange && typeof document !== 'undefined';

  // Find template name for modal display
  const getTemplateName = (templateId) => {
    const t = uploadedTemplates.find(t => t.id === templateId);
    return t ? (t.description || t.filename) : templateId?.slice(0, 8);
  };

  // Compute template usage counts from ads in the last 30 days for popularity sorting
  const templateUsageCounts = useMemo(() => {
    const counts = {};
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const ad of ads) {
      const adDate = ad.created_at ? new Date(ad.created_at) : null;
      if (adDate && adDate < thirtyDaysAgo) continue;
      if (ad.template_image_id) {
        counts[ad.template_image_id] = (counts[ad.template_image_id] || 0) + 1;
      }
      if (ad.inspiration_image_id) {
        counts[ad.inspiration_image_id] = (counts[ad.inspiration_image_id] || 0) + 1;
      }
    }
    return counts;
  }, [ads]);

  // Sort templates by popularity (most used in last 30 days first)
  const sortedDriveImages = useMemo(() => {
    return [...driveImages].sort((a, b) => (templateUsageCounts[b.id] || 0) - (templateUsageCounts[a.id] || 0));
  }, [driveImages, templateUsageCounts]);

  const sortedUploadedTemplates = useMemo(() => {
    return [...uploadedTemplates].sort((a, b) => (templateUsageCounts[b.id] || 0) - (templateUsageCounts[a.id] || 0));
  }, [uploadedTemplates, templateUsageCounts]);
  const templateTags = useMemo(() => getTemplateTags(uploadedTemplates), [uploadedTemplates]);

  const totalTemplateCount = sortedDriveImages.length + sortedUploadedTemplates.length;
  const visibleDriveImages = sortedDriveImages.slice(0, visibleTemplateCount);
  const visibleUploadedTemplates = sortedUploadedTemplates.slice(
    0,
    Math.max(0, visibleTemplateCount - sortedDriveImages.length)
  );
  const renderedTemplateCount = visibleDriveImages.length + visibleUploadedTemplates.length;
  const hasMorePickerTemplates = renderedTemplateCount < totalTemplateCount;
  const handleTemplatePickerScroll = (e) => {
    if (!hasMorePickerTemplates) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 96) {
      setVisibleTemplateCount(prev => Math.min(prev + TEMPLATE_PICKER_BATCH_SIZE, totalTemplateCount));
    }
  };
  const expandTemplatePicker = () => {
    if (selectedTemplate) {
      const driveIndex = selectedTemplate.source === 'drive'
        ? sortedDriveImages.findIndex(img => img.id === selectedTemplate.id)
        : -1;
      const uploadedIndex = selectedTemplate.source === 'uploaded'
        ? sortedUploadedTemplates.findIndex(t => t.id === selectedTemplate.id)
        : -1;
      const selectedIndex = driveIndex >= 0
        ? driveIndex
        : uploadedIndex >= 0
          ? sortedDriveImages.length + uploadedIndex
          : -1;
      if (selectedIndex >= 0) {
        setVisibleTemplateCount(prev => Math.max(prev, Math.ceil((selectedIndex + 1) / TEMPLATE_PICKER_BATCH_SIZE) * TEMPLATE_PICKER_BATCH_SIZE));
      }
    }
    setPickerCollapsed(false);
  };


  return (
    <div className="space-y-6">
      {/* Editorial page header */}
      <div className="-mx-4 sm:-mx-6 lg:-mx-8 -mt-8 mb-2">
        <EditorialPageHeader
          eyebrow={`${(project?.brand || project?.name || 'AD STUDIO').toUpperCase()} · AD STUDIO`}
          title="Ad Studio"
          meta="Generate individual ad creatives or run batch generation with angle-based prompts."
        />
      </div>

      {/* Generation Controls */}
      <div data-testid="ad-studio-generator" className="ed-card p-6 md:p-8">
        <div className="mb-5">
          <h3 className="font-serif text-[20px] tracking-[-0.01em] text-ed-ink mb-1 flex items-center gap-1.5">
            Generate ad
            <InfoTooltip text="Create one ad creative at a time. Pick a template reference, decide whether to include the product image, then choose the image generator." position="right" />
          </h3>
          <p className="text-[12.5px] text-ed-ink3 leading-[1.5]">
            Select a template image source, configure options, and generate a new ad creative.
          </p>
        </div>

        {/* ── REQUIRED FIELDS ── */}

        {/* Aspect Ratio */}
        <div className="mb-5">
          <label className="text-[11px] uppercase tracking-[0.14em] text-ed-ink3 mb-2 flex items-center gap-1 font-geist">
            Aspect Ratio
            <InfoTooltip text="The image shape for the final ad. Choose the ratio that matches the placement you plan to use in Meta." position="right" />
          </label>
          <div className="segmented-control max-w-md">
            {ASPECT_RATIOS.map(ar => {
              const subLabel = ar.label.match(/\(([^)]+)\)/)?.[1] || '';
              return (
                <button
                  key={ar.value}
                  type="button"
                  onClick={() => setAspectRatio(ar.value)}
                  className={aspectRatio === ar.value ? 'active' : ''}
                >
                  <span className="font-mono-ed text-[12.5px]">{ar.value}</span>
                  {subLabel && <span className="ml-1.5 text-[11px] opacity-70">{subLabel}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Template Image Source — hidden when using a custom prompt */}
        {!isCustomPromptMode && (
          <div className="mb-5">
            <label className="text-[11px] uppercase tracking-[0.14em] text-ed-ink3 mb-2 flex items-center gap-1 font-geist">
              Template Image
              <InfoTooltip text="The layout/style reference for the new ad. The model should follow the structure while replacing content with this project's product and copy." position="right" />
            </label>
            <p className="text-[11px] text-ed-ink3 mb-3">
              Choose the reference ad image the AI will analyze and recreate in your brand's style.
            </p>

            {/* Source toggle */}
            <div className="segmented-control mb-3">
              <button
                onClick={() => setTemplateSource(TEMPLATE_RANDOM)}
                className={templateSource === TEMPLATE_RANDOM ? 'active' : ''}
              >
                Random Template
              </button>
              <button
                onClick={() => setTemplateSource(TEMPLATE_UPLOAD)}
                className={templateSource === TEMPLATE_UPLOAD ? 'active' : ''}
              >
                Manual Upload
              </button>
              <button
                onClick={() => setTemplateSource(TEMPLATE_SELECT)}
                className={templateSource === TEMPLATE_SELECT ? 'active' : ''}
              >
                Pick Template
              </button>
            </div>

            {/* Random from folder */}
            {templateSource === TEMPLATE_RANDOM && (
              <div className="p-4 bg-ed-bg border border-ed-line rounded-xl">
                <div className="flex items-center gap-2 mb-1">
                  <svg className="w-4 h-4 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
                  </svg>
                  <p className="text-[13px] font-medium text-ed-ink2">Random from Templates Folder</p>
                </div>
                <p className="text-[11px] text-ed-ink3">
                  The system will randomly pick a template from your uploaded templates.
                </p>
                <div className="mt-3">
                  <label className="text-[10px] uppercase tracking-[0.08em] text-ed-ink3 font-medium">Template Tag</label>
                  <select
                    value={templateTag}
                    onChange={e => setTemplateTag(e.target.value)}
                    className="mt-1 text-[12px] text-ed-ink bg-ed-surface border border-ed-line rounded-lg px-2 py-1.5 w-full"
                  >
                    <option value="">Any active template</option>
                    {templateTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                  </select>
                  <p className="text-[10px] text-ed-ink3 mt-1">
                    Optional. Choose a tag to make random generation use only matching active templates.
                  </p>
                  <TemplateTagHelp projectId={projectId} hasTags={templateTags.length > 0} />
                </div>
              </div>
            )}

            {/* Upload one-off image */}
            {templateSource === TEMPLATE_UPLOAD && (
              <div>
                {uploadedFiles.length > 0 ? (
                  <div className="p-3 bg-ed-bg border border-ed-line rounded-xl">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-ed-ink">
                          {uploadedFiles.length} template image{uploadedFiles.length === 1 ? '' : 's'} uploaded
                        </p>
                        <p className="text-[11px] text-ed-ink3 mt-0.5">
                          {(uploadedFiles.reduce((sum, file) => sum + file.size, 0) / 1024).toFixed(0)} KB total
                        </p>
                      </div>
                      <button
                        onClick={clearUploadedImage}
                        className="text-[12px] text-ed-rust hover:text-ed-rust transition-colors disabled:opacity-50"
                      >
                        Remove all
                      </button>
                    </div>
                    <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                      {uploadedPreviews.map(({ file, url }, index) => (
                        <div
                          key={`${file.name}-${index}`}
                          data-testid={`adstudio-template-thumb-${index}`}
                          className="group relative rounded-lg overflow-hidden border border-ed-line aspect-square bg-white"
                        >
                          <img
                            src={url}
                            alt="Uploaded template"
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            aria-label={`Remove template image ${index + 1}`}
                            data-testid={`adstudio-template-remove-${index}`}
                            onClick={() => removeUploadedImageAt(index)}
                            className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[12px] leading-none flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:bg-ed-rust"
                          >
                            ×
                          </button>
                          <div className="absolute inset-x-0 bottom-0 bg-black/55 text-white text-[9px] px-1 py-0.5 truncate">
                            {file.name}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    data-testid="adstudio-template-dropzone"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragEnter={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
                      dragOver ? 'border-ed-accent bg-ed-accent/5' :
                      'border-ed-line hover:border-ed-accent/30 hover:bg-ed-bg'
                    }`}
                  >
                    <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-ed-bg flex items-center justify-center">
                      <svg className="w-5 h-5 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    </div>
                    <p className={`text-[13px] font-medium ${dragOver ? 'text-ed-accent' : 'text-ed-ink2'}`}>
                      {dragOver ? 'Drop image here' : 'Drop a reference ad image here, or click to browse'}
                    </p>
                    <p className="text-[11px] text-ed-ink3 mt-1">JPG, PNG, WebP, or GIF</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  data-testid="adstudio-template-input"
                  type="file"
                  multiple
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  onChange={e => { if (e.target.files?.length) handleFileSelected(e.target.files); }}
                  className="hidden"
                />
              </div>
            )}

            {/* Pick from all templates (Drive + Uploaded) */}
            {templateSource === TEMPLATE_SELECT && (
              <div>
                {!pickerCollapsed && (loadingTemplates ? (
                  <div className="text-ed-ink3 text-center py-8 text-sm">Loading templates...</div>
                ) : driveImages.length === 0 && uploadedTemplates.length === 0 ? (
                  <div className="p-6 bg-ed-bg border border-ed-line rounded-xl text-center">
                    <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-ed-bg flex items-center justify-center">
                      <svg className="w-5 h-5 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                      </svg>
                    </div>
                    <p className="text-[13px] text-ed-ink2 font-medium mb-1">No Templates Available</p>
                    <p className="text-[11px] text-ed-ink3">
                      Upload reference templates in the Template Library tab to use them here.
                    </p>
                  </div>
                ) : (
                  <div
                    className="max-h-[360px] overflow-y-auto rounded-xl pr-1 scrollbar-thin space-y-4"
                    onScroll={handleTemplatePickerScroll}
                  >
                    {/* Drive templates — sorted by popularity (last 30 days) */}
                    {visibleDriveImages.length > 0 && (
                      <div>
                        <p className="text-[11px] text-ed-ink3 font-medium mb-2">
                          Drive Templates <span className="text-ed-ink3">({driveImages.length})</span>
                        </p>
                        <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2">
                          {visibleDriveImages.map(img => {
                            const isSelected = selectedTemplate?.id === img.id && selectedTemplate?.source === 'drive';
                            const useCount = templateUsageCounts[img.id] || 0;
                            return (
                              <button
                                key={`drive-${img.id}`}
                                onClick={() => setSelectedTemplate(
                                  isSelected ? null : { id: img.id, source: 'drive' }
                                )}

                                className={`group relative rounded-xl overflow-hidden border-2 transition-all aspect-square ${
                                  isSelected
                                    ? 'border-ed-accent ring-2 ring-ed-accent/20 shadow-md'
                                    : 'border-ed-line hover:border-ed-line'
                                } cursor-pointer`}
                              >
                                <img
                                  src={img.thumbnailUrl}
                                  alt={img.name || img.id}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                                {isSelected && (
                                  <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-ed-accent/50 flex items-center justify-center shadow-sm">
                                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                    </svg>
                                  </div>
                                )}
                                {useCount > 0 && !isSelected && (
                                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md bg-ed-bg0 backdrop-blur-sm text-white text-[9px] font-bold">
                                    {useCount}×
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Uploaded templates — sorted by popularity (last 30 days) */}
                    {visibleUploadedTemplates.length > 0 && (
                      <div>
                        <p className="text-[11px] text-ed-ink3 font-medium mb-2">
                          Uploaded Templates <span className="text-ed-ink3">({uploadedTemplates.length})</span>
                        </p>
                        <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2">
                          {visibleUploadedTemplates.map(t => {
                            const isSelected = selectedTemplate?.id === t.id && selectedTemplate?.source === 'uploaded';
                            const useCount = templateUsageCounts[t.id] || 0;
                            return (
                              <button
                                key={`uploaded-${t.id}`}
                                onClick={() => setSelectedTemplate(
                                  isSelected ? null : { id: t.id, source: 'uploaded' }
                                )}

                                className={`group relative rounded-xl overflow-hidden border-2 transition-all aspect-square ${
                                  isSelected
                                    ? 'border-ed-accent ring-2 ring-ed-accent/20 shadow-md'
                                    : 'border-ed-line hover:border-ed-line'
                                } cursor-pointer`}
                              >
                                <img
                                  src={t.thumbnailUrl}
                                  alt={t.description || t.filename}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                                {isSelected && (
                                  <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-ed-accent/50 flex items-center justify-center shadow-sm">
                                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                    </svg>
                                  </div>
                                )}
                                {useCount > 0 && !isSelected && (
                                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md bg-ed-bg0 backdrop-blur-sm text-white text-[9px] font-bold">
                                    {useCount}×
                                  </div>
                                )}
                                {(t.description || t.filename) && (
                                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/50 to-transparent p-1.5">
                                    <p className="text-[10px] text-white truncate font-medium">
                                      {t.description || t.filename}
                                    </p>
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {hasMorePickerTemplates && (
                      <div className="py-2 text-center">
                        <button
                          type="button"
                          onClick={() => setVisibleTemplateCount(prev => Math.min(prev + TEMPLATE_PICKER_BATCH_SIZE, totalTemplateCount))}
                          className="text-[11px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 px-3 py-1.5 rounded-md transition-colors"
                        >
                          Load more templates ({totalTemplateCount - renderedTemplateCount} remaining)
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                {/* Compact pill — auto-replaces the grid once a template is selected,
                    so the user doesn't have to scroll past hundreds of pixels of thumbnails
                    to reach the rest of the form. Click "Change" to re-expand the grid. */}
                {pickerCollapsed && selectedTemplate && (() => {
                  const matchedDrive = selectedTemplate.source === 'drive'
                    ? driveImages.find(i => i.id === selectedTemplate.id)
                    : null;
                  const matchedUploaded = selectedTemplate.source === 'uploaded'
                    ? uploadedTemplates.find(t => t.id === selectedTemplate.id)
                    : null;
                  const thumbnailUrl = matchedDrive?.thumbnailUrl || matchedUploaded?.thumbnailUrl;
                  const displayName = matchedDrive
                    ? (matchedDrive.name || selectedTemplate.id).slice(0, 30)
                    : getTemplateName(selectedTemplate.id);
                  return (
                    <div className="flex items-center gap-3 p-3 bg-ed-accent/5 border border-ed-accent/15 rounded-xl">
                      {thumbnailUrl ? (
                        <img
                          src={thumbnailUrl}
                          alt="Selected template"
                          className="w-12 h-12 object-cover rounded-lg border border-ed-accent/15 flex-shrink-0"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-ed-accent/10 border border-ed-accent/15 flex items-center justify-center flex-shrink-0">
                          <svg className="w-5 h-5 text-ed-accent/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-ed-accent truncate">
                          Selected template: {displayName}
                        </p>
                        <p className="text-[10px] text-ed-accent/60">
                          {selectedTemplate.source === 'drive' ? 'Drive' : 'Uploaded'} template — click Change to pick a different one
                        </p>
                      </div>
                      <button
                        onClick={expandTemplatePicker}
                        className="text-[11px] font-semibold text-ed-accent hover:text-ed-accent/80 px-2.5 py-1.5 rounded-md bg-white/50 hover:bg-white border border-ed-accent/15 transition-colors flex-shrink-0"
                      >
                        Change
                      </button>
                      <button
                        onClick={() => setSelectedTemplate(null)}
                        className="text-[11px] text-ed-ink3 hover:text-ed-rust transition-colors flex-shrink-0"
                      >
                        Clear
                      </button>
                    </div>
                  );
                })()}

                {/* Existing text indicator — only when grid is expanded (collapsed view uses the pill above instead) */}
                {selectedTemplate && !pickerCollapsed && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-ed-accent font-medium">
                        Selected: {selectedTemplate.source === 'drive'
                          ? (driveImages.find(i => i.id === selectedTemplate.id)?.name || selectedTemplate.id).slice(0, 20)
                          : getTemplateName(selectedTemplate.id)
                        }
                      </span>
                      <span className="text-[10px] text-ed-ink3">
                        ({selectedTemplate.source === 'drive' ? 'Drive' : 'Uploaded'})
                      </span>
                      <button
                        onClick={() => setSelectedTemplate(null)}
                        className="text-[11px] text-ed-ink3 hover:text-ed-ink2 transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )}

        {/* Product Image (project-level + optional per-ad override) */}
        <div className="mb-5">
          <label className="text-[11px] uppercase tracking-[0.14em] text-ed-ink3 mb-2 flex items-center gap-1 font-geist">
            Product Image
            <InfoTooltip text="The product reference used for this ad. The project default is used unless you choose a different image for this generation." position="right" />
          </label>

          {/* Product image toggle + indicator — always shown when project has a product image */}
          {project?.productImageUrl && !productFile && (
            <div className={`flex items-center gap-3 p-2.5 rounded-xl mb-2 ${
              skipProductImage
                ? 'bg-ed-accent/5 border border-ed-accent/15'
                : 'bg-ed-green/5 border border-ed-green/15'
            }`}>
              <button
                onClick={() => setSkipProductImage(prev => !prev)}
                className={`relative w-9 h-[20px] rounded-full transition-colors flex-shrink-0 cursor-pointer ${
                  !skipProductImage ? 'bg-ed-green' : 'bg-ed-ink3'
                }`}
              >
                <span className={`absolute top-[2px] left-[2px] w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  !skipProductImage ? 'translate-x-[16px]' : ''
                }`} />
              </button>
              {!skipProductImage && (
                <img
                  src={project.productImageUrl}
                  alt="Project product"
                  className="w-8 h-8 object-cover rounded-lg border border-ed-green/15 flex-shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className={`text-[11px] font-medium ${skipProductImage ? 'text-ed-accent' : 'text-ed-green'}`}>
                  {skipProductImage ? 'Product image off for this ad' : 'Using project product image'}
                </p>
                <p className={`text-[10px] ${skipProductImage ? 'text-ed-accent' : 'text-ed-green'}`}>
                  {skipProductImage
                    ? 'Toggle on to include product image'
                    : 'This only affects the next ad you generate. Your project default stays unchanged.'
                  }
                </p>
              </div>
              {!skipProductImage && (
                <button
                  onClick={() => productFileInputRef.current?.click()}
                  className="text-[10px] text-ed-ink3 hover:text-ed-ink2 transition-colors text-right leading-tight max-w-[92px] sm:max-w-none"
                >
                  Use different image for this ad
                </button>
              )}
            </div>
          )}

          {/* Per-ad override: show when user has uploaded one or more references OR when no project image */}
          {productFiles.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 p-3 bg-ed-bg border border-ed-line rounded-xl">
                <div className="grid grid-cols-5 gap-1.5 flex-shrink-0">
                  {productPreviews.slice(0, 10).map((item, index) => (
                    <div
                      key={`${item.file.name}-${index}`}
                      data-testid={`adstudio-reference-thumb-${index}`}
                      className="group relative w-10 h-10 rounded-lg overflow-hidden border border-ed-line bg-white"
                    >
                      <img
                        src={item.url}
                        alt={`Reference ${index + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <button
                        type="button"
                        aria-label={`Remove reference image ${index + 1}`}
                        data-testid={`adstudio-reference-remove-${index}`}
                        onClick={() => removeProductImageAt(index)}
                        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white text-[11px] leading-none flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:bg-ed-rust"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-ed-ink truncate">One-time reference image override</p>
                  <p className="text-[10px] text-ed-ink3">
                    {productFiles.length} image{productFiles.length === 1 ? '' : 's'} · {(productFiles.reduce((sum, file) => sum + file.size, 0) / 1024).toFixed(0)} KB total
                  </p>
                  {project?.productImageUrl && (
                    <p className="text-[10px] text-ed-ink3 mt-0.5">This only affects the next ad you generate. Your project default stays unchanged.</p>
                  )}
                  <p className="text-[10px] text-ed-ink3 mt-1">Tip: 1-4 reference images works best. With more, your prompt guidelines should tell the model how to use them.</p>
                </div>
                <button
                  onClick={clearProductImage}
                  className="text-[11px] text-ed-rust hover:text-ed-rust transition-colors"
                >
                  Remove
                </button>
              </div>
              {/* Save-as-project-default toggle — only when project has no image yet.
                  Matches the Product Image toggle pattern elsewhere on this page. */}
              {!project?.productImageUrl && (
                <div className={`flex items-start gap-3 p-2.5 rounded-xl ${
                  saveProductAsDefault
                    ? 'bg-ed-green/5 border border-ed-green/15'
                    : 'bg-ed-accent/5 border border-ed-accent/10'
                }`}>
                  <button
                    type="button"
                    onClick={() => setSaveProductAsDefault(prev => !prev)}
                    aria-label="Save as project default"
                    className={`relative w-9 h-[20px] rounded-full transition-colors flex-shrink-0 cursor-pointer mt-0.5 ${
                      saveProductAsDefault ? 'bg-ed-green' : 'bg-ed-ink3'
                    }`}
                  >
                    <span className={`absolute top-[2px] left-[2px] w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      saveProductAsDefault ? 'translate-x-[16px]' : ''
                    }`} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[11px] font-semibold leading-snug ${saveProductAsDefault ? 'text-ed-green' : 'text-ed-accent/80'}`}>
                      Save as project default
                    </p>
                    <p className={`text-[10px] mt-0.5 leading-snug ${saveProductAsDefault ? 'text-ed-green/80' : 'text-ed-accent/60'}`}>
                      Future ads in this project will automatically use the first image.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : !project?.productImageUrl ? (
            <div
              data-testid="adstudio-reference-dropzone"
              onClick={() => productFileInputRef.current?.click()}
              onDragOver={handleProductDragOver}
              onDragEnter={handleProductDragOver}
              onDragLeave={handleProductDragLeave}
              onDrop={handleProductDrop}
              className={`border-2 border-dashed rounded-xl p-3 text-center cursor-pointer transition-all ${
                productDragOver ? 'border-ed-accent bg-ed-accent/5' :
                'border-ed-line hover:border-ed-accent/30 hover:bg-ed-bg'
              }`}
            >
              <svg className="w-5 h-5 mx-auto mb-1 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
                  <p className={`text-[11px] font-medium ${productDragOver ? 'text-ed-accent' : 'text-ed-ink2'}`}>
                    {productDragOver ? 'Drop reference images here' : 'Drop reference images, or click to browse'}
                  </p>
                  <p className="text-[10px] text-ed-ink3 mt-0.5">Up to 10 images. Or set one in Project Settings for all ads.</p>
                  <p className="text-[10px] text-ed-ink3 mt-0.5">Tip: 1-4 reference images works best. With more, your prompt guidelines should tell the model how to use them.</p>
                </div>
              ) : null}
              <input
                ref={productFileInputRef}
                data-testid="adstudio-reference-input"
                type="file"
                multiple
                accept=".jpg,.jpeg,.png,.webp,.gif"
                onChange={e => { if (e.target.files?.length) handleProductFileSelected(e.target.files); }}
                className="hidden"
              />
              {genError && (
                <div
                  data-testid="adstudio-generation-error"
                  className="p-3 bg-ed-rust/5 border border-ed-rust/15 rounded-xl text-[12px] text-ed-rust"
                >
                  {genError}
                </div>
              )}
        </div>

        {/* ── OPTIONAL FIELDS (collapsible) ── */}
        <div className="my-6">
          <button
            data-testid="optional-fields-toggle"
            onClick={() => setOptionalOpen(prev => !prev)}
            className="w-full flex items-center justify-between px-4 py-3 bg-ed-bg border border-ed-line rounded-xl hover:border-ed-ink3 transition-colors text-left"
          >
            <div>
              <span className="font-serif text-[14.5px] text-ed-ink">Optional · Topic, Headline, Body</span>
              <p className="text-[11.5px] text-ed-ink3 mt-0.5 font-geist">Topic, headline, body copy, image generator, and prompt guidelines.</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ed-ink3 font-geist whitespace-nowrap ml-3">
              {optionalOpen ? 'Hide' : 'Edit'}
              <svg
                className={`w-3.5 h-3.5 transition-transform duration-200 ${optionalOpen ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </span>
          </button>

          {optionalOpen && (
            <div className="pt-5 pb-1 fade-in">
              {/* Image model selector */}
              <div className="mb-5">
                <label className="text-[11px] uppercase tracking-[0.14em] text-ed-ink3 mb-2 flex items-center gap-1 font-geist">
                  Image Generator
                  <InfoTooltip text="Choose which image provider renders the final ad. Gemini is the default; GPT Image 2 uses OpenAI image credits." position="right" />
                </label>
                <select
                  value={imageModel}
                  onChange={e => setImageModel(e.target.value)}
                  className="text-[12px] text-ed-ink bg-ed-bg border border-ed-line rounded-lg px-3 py-2 w-full cursor-pointer hover:border-ed-accent/30 transition-colors"
                >
                  {IMAGE_MODEL_OPTIONS.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <p className="text-[10px] text-ed-ink3 mt-1">
                  {getImageModelDescription(imageModel)}
                </p>
              </div>

              {(angle.trim() || headline.trim() || bodyCopy.trim()) && (
                <div className="flex justify-end mb-1">
                  <button
                    onClick={() => { angleTouchedRef.current = true; setAngleModeOverride(''); setAngle(''); setHeadline(''); setBodyCopy(''); }}
                    className="text-[10px] text-ed-ink3 hover:text-ed-rust transition-colors"
                  >
                    Clear fields
                  </button>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                {/* Ad Topic / Angle */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-[13px] font-medium text-ed-ink2">
                      Ad Topic / Angle
                    </label>
                    <button
                      onClick={handleGenerateAngle}
                      disabled={generatingAngle}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-ed-accent hover:text-ed-accent/80 disabled:opacity-50 transition-colors"
                    >
                      {generatingAngle ? (
                        <>
                          <div className="w-3 h-3 rounded-full border-2 border-ed-accent/30 border-t-ed-accent animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                          </svg>
                          Generate
                        </>
                      )}
                    </button>
                  </div>
                  <select
                    data-testid="ad-angle-select"
                    value={angleMode}
                    onChange={e => handleAngleModeChange(e.target.value)}
                    className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                    disabled={generatingAngle}
                  >
                    <option value="">No angle / template-only</option>
                    {activeConductorAngles.map(a => (
                      <option key={a.externalId || a.name} value={a.name}>
                        {a.is_system_default ? `${a.name} (Direct Offer default)` : a.name}
                      </option>
                    ))}
                    <option value={CUSTOM_ANGLE_MODE}>Custom…</option>
                  </select>
                  {angleMode === CUSTOM_ANGLE_MODE && (
                    <input
                      data-testid="ad-angle-input"
                      value={angle}
                      onChange={e => { angleTouchedRef.current = true; setAngleModeOverride(CUSTOM_ANGLE_MODE); setAngle(e.target.value); }}
                      placeholder={generatingAngle ? 'Generating angle...' : 'e.g., "customer transformation story"'}
                      className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent mt-2"
                      disabled={generatingAngle}
                    />
                  )}
                </div>

                {/* Headline */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-[13px] font-medium text-ed-ink2">
                      Headline
                    </label>
                    <button
                      onClick={handleGenerateHeadline}
                      disabled={generatingHeadline}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-ed-accent hover:text-ed-accent/80 disabled:opacity-50 transition-colors"
                    >
                      {generatingHeadline ? (
                        <>
                          <div className="w-3 h-3 rounded-full border-2 border-ed-accent/30 border-t-ed-accent animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                          </svg>
                          Generate
                        </>
                      )}
                    </button>
                  </div>
                  <input
                    data-testid="ad-headline-input"
                    value={headline}
                    onChange={e => setHeadline(e.target.value)}
                    placeholder={generatingHeadline ? 'Generating headline...' : 'e.g., "Transform Your Skin in 30 Days"'}
                    className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                    disabled={generatingHeadline}
                  />
                </div>

                {/* Smart generate prompt — appears when angle is set but headline/body are empty */}
                {angle.trim() && !headline.trim() && !bodyCopy.trim() && !generatingHeadline && !generatingBody && (
                  <div className="md:col-span-2">
                    <button
                      onClick={handleGenerateFromAngle}
                      className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-ed-accent/5 to-ed-accent/10 border border-ed-accent/15 hover:border-ed-accent/30 hover:from-ed-accent/10 hover:to-ed-accent/15 transition-all flex items-center justify-center gap-2 group"
                    >
                      <svg className="w-4 h-4 text-ed-accent group-hover:text-ed-accent transition-colors" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                      </svg>
                      <span className="text-[12px] font-semibold text-ed-accent group-hover:text-ed-accent transition-colors">
                        Generate headline & body copy for this angle
                      </span>
                    </button>
                  </div>
                )}

                {/* Body Copy — full width, with style selector + regenerate */}
                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-[13px] font-medium text-ed-ink2">
                      Body Copy
                    </label>
                    <button
                      onClick={() => handleRegenerateBody()}
                      disabled={generatingBody}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-ed-accent hover:text-ed-accent/80 disabled:opacity-50 transition-colors"
                    >
                      {generatingBody ? (
                        <>
                          <div className="w-3 h-3 rounded-full border-2 border-ed-accent/30 border-t-ed-accent animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                          </svg>
                          Generate
                        </>
                      )}
                    </button>
                  </div>

                  {/* Style selector */}
                  <div className="flex gap-1 mb-2">
                    {[
                      { value: 'short', label: 'Short', desc: '1-2 sentences' },
                      { value: 'bullets', label: 'Bullets', desc: '3-5 points' },
                      { value: 'paragraph', label: 'Paragraph', desc: '2-3 sentences' },
                      { value: 'story', label: 'Story', desc: 'Narrative hook' },
                    ].map(s => (
                      <button
                        key={s.value}
                        onClick={() => {
                          setBodyCopyStyle(s.value);
                          // Auto-regenerate if there's already body copy and a headline
                          if (bodyCopy && headline.trim()) {
                            handleRegenerateBody(s.value);
                          }
                        }}
                        className={`flex-1 px-2 py-1.5 rounded-lg text-center transition-all ${
                          bodyCopyStyle === s.value
                            ? 'bg-ed-accent/10 border border-ed-accent/20 text-ed-accent shadow-sm'
                            : 'bg-ed-bg border border-ed-line text-ed-ink2 hover:bg-ed-bg'
                        }`}
                      >
                        <p className="text-[11px] font-semibold">{s.label}</p>
                        <p className="text-[9px] opacity-60">{s.desc}</p>
                      </button>
                    ))}
                  </div>

                  <textarea
                    data-testid="ad-body-copy-input"
                    value={bodyCopy}
                    onChange={e => setBodyCopy(e.target.value)}
                    placeholder={generatingBody ? 'Generating body copy...' : 'Type body copy or click Generate to auto-create...'}
                    rows={3}
                    className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent resize-none text-[13px]"
                    disabled={generatingBody}
                  />
                </div>
              </div>

              <PromptGuidelinesEditor
                projectId={projectId}
                initialValue={project?.prompt_guidelines || ''}
                className="mb-2"
              />
            </div>
          )}
        </div>

        {/* Image Edit Panel — only shown when iterating on a past ad's prompt */}
        {isCustomPromptMode && (
          <div
            ref={editPanelRef}
            className={`mb-5 p-4 border rounded-xl transition-all duration-700 ${
              editPanelFlash
                ? 'bg-ed-accent/10 border-ed-accent shadow-lg shadow-ed-accent/20 ring-2 ring-ed-accent/30'
                : 'bg-ed-accent/5 border-ed-accent/15'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <label className="block text-[13px] font-semibold text-ed-accent">
                Edit Image
              </label>
              <button
                onClick={() => { setCustomPrompt(''); setParentAdId(null); setEditingAdImage(null); setEditInstruction(''); setOriginalPromptRef(''); setEditMode('describe'); setPromptUpdated(false); setEditReferenceFile(null); if (editReferencePreview) URL.revokeObjectURL(editReferencePreview); setEditReferencePreview(null); }}
                className="text-[12px] text-ed-rust hover:text-ed-rust transition-colors"
              >
                Exit editing
              </button>
            </div>
            {/* Preview of the ad being edited */}
            {editingAdImage && (
              <div className="flex justify-center mb-3">
                <img
                  src={editingAdImage}
                  alt="Ad being edited"
                  className="max-h-96 rounded-lg border border-ed-accent/15 shadow-sm object-contain"
                />
              </div>
            )}

            {/* Mode tabs */}
            <div className="flex gap-1 mb-3 bg-ed-bg border border-ed-line rounded-[9px] p-[3px]">
              <button
                onClick={() => setEditMode('describe')}
                className={`flex-1 text-[12px] py-1.5 px-3 rounded-md transition-all font-medium ${
                  editMode === 'describe'
                    ? 'bg-ed-surface text-ed-ink shadow-sm'
                    : 'text-ed-ink2 hover:text-ed-ink'
                }`}
              >
                Describe Edit
              </button>
              <button
                onClick={() => setEditMode('direct')}
                className={`flex-1 text-[12px] py-1.5 px-3 rounded-md transition-all font-medium ${
                  editMode === 'direct'
                    ? 'bg-ed-surface text-ed-ink shadow-sm'
                    : 'text-ed-ink2 hover:text-ed-ink'
                }`}
              >
                Edit Prompt Directly
              </button>
            </div>

            {editMode === 'describe' ? (
              /* Describe Edit mode — natural language + optional reference image */
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-semibold text-ed-accent bg-ed-accent/10 px-1.5 py-0.5 rounded">Step 1</span>
                  <p className="text-[11px] text-ed-accent/70">
                    Describe what to change — AI will rewrite the prompt for you.
                  </p>
                </div>
                <textarea
                  ref={editTextareaRef}
                  value={editInstruction}
                  onChange={e => setEditInstruction(e.target.value)}
                  rows={3}
                  placeholder={'e.g., "Change the background to warm orange sunset tones" or "The product shown is wrong \u2014 I\u2019ve attached the correct one"'}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent resize-none border-ed-accent/30 bg-white text-[13px] mb-2"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isApplyingEdit) {
                      e.preventDefault();
                      handleApplyEdit();
                    }
                  }}
                />

                {/* Reference image upload */}
                {editReferenceFile && editReferencePreview ? (
                  <div className="flex items-center gap-3 mb-2 p-2 bg-ed-accent/5 border border-ed-accent/10 rounded-lg">
                    <img
                      src={editReferencePreview}
                      alt="Reference"
                      className="w-10 h-10 object-cover rounded-lg border border-ed-accent/15"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-ed-ink truncate">{editReferenceFile.name}</p>
                      <p className="text-[10px] text-ed-ink3">{(editReferenceFile.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button
                      onClick={() => {
                        setEditReferenceFile(null);
                        if (editReferencePreview) URL.revokeObjectURL(editReferencePreview);
                        setEditReferencePreview(null);
                        if (editReferenceInputRef.current) editReferenceInputRef.current.value = '';
                      }}
                      className="text-[11px] text-ed-rust hover:text-ed-rust transition-colors flex-shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div
                    onClick={() => editReferenceInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setEditRefDragOver(true); }}
                    onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setEditRefDragOver(true); }}
                    onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setEditRefDragOver(false); }}
                    onDrop={e => {
                      e.preventDefault(); e.stopPropagation(); setEditRefDragOver(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file && file.type.startsWith('image/')) {
                        setEditReferenceFile(file);
                        setEditReferencePreview(URL.createObjectURL(file));
                      }
                    }}
                    className={`flex flex-col items-center justify-center gap-1 mb-2 px-3 py-4 rounded-lg border-2 border-dashed cursor-pointer transition-all ${
                      editRefDragOver
                        ? 'border-ed-accent bg-ed-accent/5 text-ed-accent'
                        : 'border-ed-accent/30 bg-ed-accent/5 hover:border-ed-accent hover:bg-ed-accent/10 text-ed-accent hover:text-ed-accent/80'
                    }`}
                  >
                    <svg className="w-5 h-5 mb-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                    <span className="text-[12px] font-medium">
                      {editRefDragOver ? 'Drop image here' : 'Attach a reference image'}
                    </span>
                    {!editRefDragOver && (
                      <span className="text-[10px] text-ed-accent/60">
                        Click to browse or drag & drop
                      </span>
                    )}
                  </div>
                )}
                <input
                  ref={editReferenceInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setEditReferenceFile(file);
                      setEditReferencePreview(URL.createObjectURL(file));
                    }
                  }}
                  className="hidden"
                />

                {/* Product image toggle inside edit panel */}
                {project?.productImageUrl && !productFile && (
                  <div className={`flex items-center gap-3 p-2 rounded-lg mb-2 ${
                    skipProductImage
                      ? 'bg-ed-accent/5 border border-ed-accent/15'
                      : 'bg-ed-green/5 border border-ed-green/15'
                  }`}>
                    <button
                      onClick={() => setSkipProductImage(prev => !prev)}
                      className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 cursor-pointer ${
                        !skipProductImage ? 'bg-ed-green' : 'bg-ed-ink3'
                      }`}
                    >
                      <span className={`absolute top-[2px] left-[2px] w-3.5 h-3.5 bg-white rounded-full shadow transition-transform ${
                        !skipProductImage ? 'translate-x-[14px]' : ''
                      }`} />
                    </button>
                    {!skipProductImage && (
                      <img
                        src={project.productImageUrl}
                        alt="Product"
                        className="w-6 h-6 object-cover rounded border border-ed-green/15 flex-shrink-0"
                      />
                    )}
                    <p className={`text-[10px] font-medium ${skipProductImage ? 'text-ed-accent' : 'text-ed-green'}`}>
                      {skipProductImage ? 'Product image off' : 'Product image on'}
                    </p>
                  </div>
                )}

                <button
                  onClick={handleApplyEdit}
                  disabled={isApplyingEdit || !editInstruction.trim()}
                  className={`text-[12px] font-medium px-4 py-2 rounded-lg transition-all ${
                    isApplyingEdit || !editInstruction.trim()
                      ? 'bg-ed-bg text-ed-ink3 cursor-not-allowed'
                      : 'bg-ed-accent text-white hover:bg-ed-accent-light shadow-sm'
                  }`}
                >
                  {isApplyingEdit ? (
                    <span className="flex items-center gap-1.5">
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      Updating prompt...
                    </span>
                  ) : 'Update Prompt'}
                </button>
                <span className="text-[10px] text-ed-ink3 ml-2">{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</span>
              </div>
            ) : (
              /* Direct edit mode — raw prompt textarea */
              <div>
                <p className="text-[11px] text-ed-accent/70 mb-2">
                  Review or tweak the prompt, then generate.
                </p>
                <textarea
                  value={customPrompt}
                  onChange={e => setCustomPrompt(e.target.value)}
                  rows={8}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent resize-none border-ed-accent/30 bg-white font-mono text-[12px]"
                />
                {originalPromptRef && customPrompt !== originalPromptRef && (
                  <button
                    onClick={() => setCustomPrompt(originalPromptRef)}
                    className="text-[11px] text-ed-ink3 hover:text-ed-ink2 mt-1.5 transition-colors"
                  >
                    Reset to original prompt
                  </button>
                )}

                {/* Product image toggle inside direct edit */}
                {project?.productImageUrl && !productFile && (
                  <div className={`flex items-center gap-3 p-2 rounded-lg mt-3 ${
                    skipProductImage
                      ? 'bg-ed-accent/5 border border-ed-accent/15'
                      : 'bg-ed-green/5 border border-ed-green/15'
                  }`}>
                    <button
                      onClick={() => setSkipProductImage(prev => !prev)}
                      className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 cursor-pointer ${
                        !skipProductImage ? 'bg-ed-green' : 'bg-ed-ink3'
                      }`}
                    >
                      <span className={`absolute top-[2px] left-[2px] w-3.5 h-3.5 bg-white rounded-full shadow transition-transform ${
                        !skipProductImage ? 'translate-x-[14px]' : ''
                      }`} />
                    </button>
                    {!skipProductImage && (
                      <img
                        src={project.productImageUrl}
                        alt="Product"
                        className="w-6 h-6 object-cover rounded border border-ed-green/15 flex-shrink-0"
                      />
                    )}
                    <p className={`text-[10px] font-medium ${skipProductImage ? 'text-ed-accent' : 'text-ed-green'}`}>
                      {skipProductImage ? 'Product image off' : 'Product image on'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2 hint — shown after user has updated the prompt via Step 1 */}
        {isCustomPromptMode && promptUpdated && (
          <div className="flex items-center gap-2 mb-2 fade-in">
            <span className="text-[10px] font-semibold text-ed-green bg-ed-green/10 px-1.5 py-0.5 rounded">Step 2</span>
            <p className="text-[11px] text-ed-ink2">
              Review the prompt above, then generate your new image.
            </p>
          </div>
        )}

        {/* Generate Button — always enabled for parallel generation */}
        <div className="flex items-center gap-4 mt-6 pt-5 border-t border-ed-line">
          <button
            data-testid="generate-ad-button"
            onClick={handleGenerate}
            className="ed-cta flex-1 sm:flex-initial sm:min-w-[220px] !py-3 !px-6 !rounded-[10px] !text-[14px]"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0l1.5 5.5L15 7l-5.5 1.5L8 14l-1.5-5.5L1 7l5.5-1.5L8 0z" />
            </svg>
            {isCustomPromptMode
              ? 'Generate Image'
              : 'Generate ad'}
          </button>
          <span className="font-mono-ed text-[11.5px] text-ed-ink3">
            ~Gemini rate · ~18s
          </span>
        </div>

      </div>

      {/* Batch Generation */}
      <BatchManager
        projectId={projectId}
        project={project}
        conductorAngles={conductorAngles}
        onBatchComplete={loadAds}
      />

      {/* Ad Queue */}
      <GenerationQueue
        data-testid="generation-queue"
        ref={queueRef}
        activeGens={activeGens}
        genQueueExpanded={genQueueExpanded}
        setGenQueueExpanded={setGenQueueExpanded}
        activeGenCount={activeGenCount}
        dismissGen={dismissGen}
        onCancelGeneration={handleCancelGeneration}
        onErrorAction={handleGenerationErrorAction}
      />

      {/* Ad Gallery */}
      <div data-testid="ad-gallery" ref={galleryRef} className="pt-4 border-t border-ed-line">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-serif text-[22px] tracking-[-0.01em] text-ed-ink flex items-center gap-1.5">Ad Gallery <InfoTooltip text="All generated ads for this project. QA Passed ads were approved by the Creative Filter and may already be in Ready to Post. QA Rejected ads have images but failed QA, so you can review, tag, download, or delete them." position="right" /></h3>
            {ads.length > 0 && (
              <p className="text-[12px] text-ed-ink3">
                {filteredAds.length} ad{filteredAds.length !== 1 ? 's' : ''}
                {hiddenByDateCount > 0 && ` (${hiddenByDateCount} older hidden)`}
                {galleryFilter !== 'all' && ` · ${ads.length} total`}
              </p>
            )}
          </div>
          {ads.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="segmented-control text-[12px]">
                <button
                  onClick={() => setGalleryFilter('individual')}
                  className={galleryFilter === 'individual' ? 'active' : ''}
                >
                  Individual{individualCount > 0 ? ` (${individualCount})` : ''}
                </button>
                <button
                  onClick={() => setGalleryFilter('batch')}
                  className={galleryFilter === 'batch' ? 'active' : ''}
                >
                  Batch{batchCount > 0 ? ` (${batchCount})` : ''}
                </button>
                <button
                  onClick={() => setGalleryFilter('all')}
                  className={galleryFilter === 'all' ? 'active' : ''}
                >
                  All
                </button>
                {favoritesCount > 0 && (
                  <button
                    onClick={() => setGalleryFilter('favorites')}
                    className={galleryFilter === 'favorites' ? 'active' : ''}
                  >
                    <svg className="w-3 h-3 inline mr-0.5 -mt-0.5" fill={galleryFilter === 'favorites' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" /></svg>
                    {favoritesCount}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <select
                  value={pendingRange}
                  onChange={(e) => setPendingRange(e.target.value)}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px] py-1 px-2 pr-7 w-auto"
                >
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="4d">Last 4 days</option>
                  <option value="7d">Last 7 days</option>
                  <option value="14d">Last 14 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="all">All time</option>
                  <option value="custom">Custom range</option>
                </select>
                {pendingRange === 'custom' && (
                  <>
                    <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[11px] py-1 px-1.5 w-[120px]" />
                    <span className="text-[11px] text-ed-ink3">to</span>
                    <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[11px] py-1 px-1.5 w-[120px]" />
                  </>
                )}
                <button
                  onClick={() => setDateRange(pendingRange)}
                  className="px-2.5 py-1 text-[11px] font-medium bg-ed-accent text-white rounded-md hover:bg-ed-accent-light transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
          {ads.length > 0 && (
            <div className="flex items-center gap-2 ml-2">
              <div className="relative">
                <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search ads..."
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px] py-1 pl-7 pr-2 w-40"
                />
              </div>
              <button
                onClick={() => setGalleryView('grid')}
                className={`p-1.5 rounded-md transition-colors ${galleryView === 'grid' ? 'bg-ed-bg text-ed-ink' : 'text-ed-ink3 hover:text-ed-ink2'}`}
                title="Grid view"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
              </button>
              <button
                onClick={() => setGalleryView('list')}
                className={`p-1.5 rounded-md transition-colors ${galleryView === 'list' ? 'bg-ed-bg text-ed-ink' : 'text-ed-ink3 hover:text-ed-ink2'}`}
                title="List view"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16"><rect x="1" y="1.5" width="14" height="3" rx="0.75"/><rect x="1" y="6.5" width="14" height="3" rx="0.75"/><rect x="1" y="11.5" width="14" height="3" rx="0.75"/></svg>
              </button>
            </div>
          )}
        </div>

        {/* Selection controls */}
        {selectableFilteredAds.length > 0 && !loadingAds && (
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={allFilteredSelected ? clearSelection : selectAllFiltered}
              className="text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 transition-colors"
            >
              {allFilteredSelected ? 'Deselect All' : 'Select All'}
            </button>
            {selectedCount > 0 && (
              <span className="text-[12px] text-ed-ink3">
                {selectedCount} selected
              </span>
            )}
          </div>
        )}

        {loadingAds ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} className="ed-card overflow-hidden animate-pulse">
                <div className="aspect-square bg-ed-line" />
                <div className="p-3">
                  <div className="flex justify-between mb-1">
                    <div className="h-3 w-10 bg-ed-bg rounded" />
                    <div className="h-3 w-14 bg-ed-bg rounded" />
                  </div>
                  <div className="h-3 w-24 bg-ed-line rounded mt-1" />
                </div>
              </div>
            ))}
          </div>
        ) : ads.length === 0 ? (
          <div className="ed-card p-12 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-ed-bg flex items-center justify-center">
              <svg className="w-6 h-6 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <h4 className="font-medium text-ed-ink2 text-[14px] mb-1">No Ads Yet</h4>
            <p className="text-[12px] text-ed-ink3 max-w-sm mx-auto">
              Choose a template source above and click Generate to create your first ad.
            </p>
          </div>
        ) : filteredAds.length === 0 ? (
          <div className="ed-card p-8 text-center">
            <p className="text-[13px] text-ed-ink2 mb-1">No {galleryFilter === 'batch' ? 'batch' : 'individual'} ads yet</p>
            <p className="text-[12px] text-ed-ink3">
              {galleryFilter === 'batch'
                ? 'Run a batch generation to see ads here.'
                : 'Generate an ad above to see it here.'}
            </p>
          </div>
        ) : galleryView === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {visibleAds.map(ad => {
              const statusMeta = getGalleryStatusMeta(ad);
              const displayableImage = isDisplayableImageAd(ad);
              const failedLike = isFailedLikeAd(ad);
              return (
              <div
                key={ad.id}
                className={`group ed-card overflow-hidden transition-all duration-300 ${
                  selectedAdIds.has(ad.id) ? 'ring-2 ring-ed-accent ring-offset-1' : ''
                }`}
              >
                <div
                  className="aspect-square bg-ed-bg cursor-pointer relative overflow-hidden"
                  onClick={() => {
                    if (!isSelectableAd(ad)) return;
                    if (selectedCount > 0) toggleAdSelection(ad.id);
                    else if (displayableImage) void openAdDetails(ad);
                  }}
                >
                  {displayableImage ? (
                    <img
                      src={ad.thumbnailUrl || ad.imageUrl}
                      alt={`Ad - ${ad.angle || 'No angle'}`}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {failedLike ? (
                        <svg className="w-6 h-6 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                      ) : (
                        <div className="w-6 h-6 rounded-full border-2 border-ed-line border-t-ed-accent/60 animate-spin" />
                      )}
                    </div>
                  )}

                  {/* Selection checkbox — visible on hover or when selected */}
                  {isSelectableAd(ad) && (
                    <button
                      onClick={(e) => toggleAdSelection(ad.id, e)}
                      className={`absolute top-2 left-2 z-10 w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-200 ${
                        selectedAdIds.has(ad.id)
                          ? 'bg-ed-accent text-white shadow-sm'
                          : 'bg-black/40 backdrop-blur-sm text-white/90 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:bg-ed-bg0'
                      }`}
                      title={selectedAdIds.has(ad.id) ? 'Deselect' : ad.status === 'quality_rejected' ? 'Select QA rejected ad' : ad.status === 'failed' ? 'Select failed ad' : 'Select for bulk actions'}
                    >
                      {selectedAdIds.has(ad.id) ? (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  )}

                  {/* Status badge */}
                  <div className={`absolute top-2 ${isSelectableAd(ad) ? 'left-10' : 'left-2'} badge ${statusMeta.className}`} title={statusMeta.title}>
                    {statusMeta.label}
                  </div>

                  {/* Action icons — visible on hover */}
                  {displayableImage && (
                    <div className="absolute bottom-2 right-2 flex gap-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200">
                      {/* Download */}
                      <button
                        onClick={(e) => handleDownload(ad, e)}
                        className="w-7 h-7 rounded-lg bg-black/40 backdrop-blur-sm flex items-center justify-center text-white/90 hover:bg-black/60 transition-all"
                        title="Download image"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                        </svg>
                      </button>
                      {/* Regenerate */}
                      <button
                        onClick={(e) => handleRegenerate(ad, e)}
                        className="w-7 h-7 rounded-lg bg-black/40 backdrop-blur-sm flex items-center justify-center text-white/90 hover:bg-black/60 transition-all"
                        title="Regenerate ad"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992" />
                        </svg>
                      </button>
                      {/* Edit prompt */}
                      {ad.has_edit_prompt && (
                        <button
                          onClick={(e) => handleEditPrompt(ad, e)}
                          className="w-7 h-7 rounded-lg bg-black/40 backdrop-blur-sm flex items-center justify-center text-white/90 hover:bg-black/60 transition-all"
                          title="Edit image"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                          </svg>
                        </button>
                      )}
                      {/* Reuse settings */}
                      <button
                        onClick={(e) => handleRedo(ad, e)}
                        className="w-7 h-7 rounded-lg bg-black/40 backdrop-blur-sm flex items-center justify-center text-white/90 hover:bg-black/60 transition-all"
                        title="Reuse settings"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      </button>
                    </div>
                  )}

                  {/* Favorite heart — visible on hover or when favorited */}
                  {ad.status === 'completed' && (
                    <button
                      onClick={(e) => handleToggleFavorite(ad, e)}
                      className={`absolute top-2 right-2 z-10 w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-200 ${
                        ad.is_favorite
                          ? 'text-rose-500 bg-white/90 backdrop-blur-sm shadow-sm'
                          : 'text-white/90 bg-black/40 backdrop-blur-sm opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:bg-ed-bg0'
                      }`}
                      title={ad.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <svg className="w-4 h-4" fill={ad.is_favorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
                      </svg>
                    </button>
                  )}

                  {ad.drive_url && !ad.is_favorite && (
                    <div className="absolute top-2 right-2 badge bg-white/80 backdrop-blur-sm text-ed-ink2">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                    </div>
                  )}

                  {/* Ad Pipeline badge */}
                  {deployedAdIds.has(ad.id) && (
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-1 rounded-lg bg-ed-green/90 backdrop-blur-sm text-white text-[10px] font-semibold shadow-sm">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      Ad Pipeline
                    </div>
                  )}
                </div>

                <div className="p-3">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[11px] text-ed-ink3">{ad.aspect_ratio}</span>
                    <span className="text-[11px] text-ed-ink3">{formatDateTime(getAdGeneratedAt(ad))}</span>
                  </div>
                  <p className="text-[12px] text-ed-ink font-medium truncate" title={ad.headline || ad.angle_name || ''}>
                    {ad.headline || ad.angle_name || 'Untitled'}
                  </p>
                  {ad.status === 'failed' && ad.error_message && (
                    <p className="text-[11px] text-ed-rust mt-1 line-clamp-2" title={ad.error_message}>
                      {ad.error_message}
                    </p>
                  )}
                  {ad.status === 'failed' && ad.has_edit_prompt && (
                    <button
                      onClick={(e) => handleRetryImageFromSavedPrompt(ad, e)}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-ed-accent hover:text-ed-accent/80 transition-colors"
                    >
                      Retry image from saved prompt
                    </button>
                  )}
                  {/* Tags */}
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {(ad.tags || []).slice(0, 3).map(tag => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-ed-accent/5 text-ed-accent rounded-full">{tag}</span>
                    ))}
                    {(ad.tags || []).length > 3 && (
                      <span className="text-[10px] text-ed-ink3">+{ad.tags.length - 3}</span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setTagEditAd(ad); }}
                      className="text-[10px] px-1.5 py-0.5 rounded-full text-ed-ink3 hover:text-ed-accent hover:bg-ed-accent/5 transition-colors"
                      title="Add tag"
                    >
                      + tag
                    </button>
                  </div>
                  <div className="flex gap-2 mt-1.5">
                    {ad.drive_url && (
                      <a
                        href={ad.drive_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-ed-accent hover:text-ed-accent/80 transition-colors"
                        onClick={e => e.stopPropagation()}
                      >
                        Drive
                      </a>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(ad.id); }}
                      className="text-[11px] text-ed-rust hover:text-ed-rust transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        ) : galleryView === 'list' ? (
          /* ---- LIST VIEW ---- */
          <div className="space-y-1">
            {visibleAds.map(ad => {
              const statusMeta = getGalleryStatusMeta(ad);
              const displayableImage = isDisplayableImageAd(ad);
              const failedLike = isFailedLikeAd(ad);
              return (
              <div
                key={ad.id}
                className={`flex items-center gap-3 p-2.5 rounded-xl hover:bg-ed-bg cursor-pointer transition-colors ${
                  selectedAdIds.has(ad.id) ? 'bg-ed-accent/5 ring-1 ring-ed-accent/20' : ''
                }`}
                onClick={() => {
                  if (!isSelectableAd(ad)) return;
                  if (selectedAdIds.size > 0) toggleAdSelection(ad.id);
                  else if (displayableImage) void openAdDetails(ad);
                }}
              >
                {/* Selection checkbox */}
                {isSelectableAd(ad) && (
                  <button
                    onClick={(e) => toggleAdSelection(ad.id, e)}
                    className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-colors ${
                      selectedAdIds.has(ad.id)
                        ? 'bg-ed-accent text-white'
                        : 'border border-ed-line hover:border-ed-line'
                    }`}
                  >
                    {selectedAdIds.has(ad.id) && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    )}
                  </button>
                )}

                {/* Thumbnail */}
                <div className="w-12 h-12 rounded-lg overflow-hidden bg-ed-bg flex-shrink-0">
                  {displayableImage ? (
                    <img src={ad.thumbnailUrl || ad.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
                  ) : failedLike ? (
                    <div className="w-full h-full flex items-center justify-center">
                      <svg className="w-4 h-4 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="w-4 h-4 rounded-full border-2 border-ed-line border-t-ed-accent/60 animate-spin" />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-ed-ink truncate">{ad.headline || ad.angle_name || 'Untitled'}</p>
                  {ad.status === 'failed' && ad.error_message && (
                    <p className="text-[11px] text-ed-rust truncate" title={ad.error_message}>
                      {ad.error_message}
                    </p>
                  )}
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    {(ad.tags || []).slice(0, 4).map(tag => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-ed-accent/5 text-ed-accent rounded-full">{tag}</span>
                    ))}
                    {(ad.tags || []).length > 4 && (
                      <span className="text-[10px] text-ed-ink3">+{ad.tags.length - 4}</span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setTagEditAd(ad); }}
                      className="text-[10px] px-1.5 py-0.5 rounded-full text-ed-ink3 hover:text-ed-accent hover:bg-ed-accent/5 transition-colors"
                      title="Add tag"
                    >
                      + tag
                    </button>
                  </div>
                </div>

                {/* Metadata */}
                <span className="text-[11px] text-ed-ink3 flex-shrink-0 hidden sm:inline">{ad.aspect_ratio}</span>
                <span className="text-[11px] text-ed-ink3 flex-shrink-0 w-32 text-right hidden md:inline">{formatDateTime(getAdGeneratedAt(ad))}</span>
                <span className="text-[10px] px-2 py-0.5 bg-ed-bg text-ed-ink2 rounded-full flex-shrink-0 hidden sm:inline">
                  {(ad.auto_generated || ad.batch_job_id) ? 'Batch' : ad.generation_mode === 'image_only' ? 'Edit' : ad.generation_mode === 'mode2' ? 'Template' : 'Individual'}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 font-medium hidden sm:inline ${statusMeta.className}`} title={statusMeta.title}>
                  {statusMeta.label}
                </span>
                {deployedAdIds.has(ad.id) && (
                  <span className="text-[10px] px-2 py-0.5 bg-ed-green/10 text-ed-green rounded-full flex-shrink-0 font-medium hidden sm:inline">
                    Ad Pipeline
                  </span>
                )}

                {/* Actions */}
                {displayableImage && (
                  <>
                    <button
                      onClick={(e) => handleToggleFavorite(ad, e)}
                      className={`transition-colors flex-shrink-0 ${ad.is_favorite ? 'text-rose-500' : 'text-ed-ink3 hover:text-rose-400'}`}
                      title={ad.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <svg className="w-4 h-4" fill={ad.is_favorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" /></svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRedo(ad, e); }}
                      className="text-[11px] text-ed-ink3 hover:text-ed-accent transition-colors flex-shrink-0"
                      title="Reuse settings"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRegenerate(ad, e); }}
                      className="text-[11px] text-ed-ink3 hover:text-ed-accent transition-colors flex-shrink-0"
                      title="Regenerate"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992" /></svg>
                    </button>
                  </>
                )}
                {ad.status === 'failed' && ad.has_edit_prompt && (
                  <button
                    onClick={(e) => handleRetryImageFromSavedPrompt(ad, e)}
                    className="text-[11px] font-semibold text-ed-accent hover:text-ed-accent/80 transition-colors flex-shrink-0"
                    title="Retry image from saved prompt"
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(ad.id); }}
                  className="text-[11px] text-ed-ink3 hover:text-ed-rust transition-colors flex-shrink-0"
                  title="Delete"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                </button>
              </div>
              );
            })}
          </div>
        ) : null}

        {/* Load More button for pagination */}
        {hasMoreAds && (
          <div className="flex justify-center mt-6">
            <button
              onClick={() => setDisplayCount(c => c + AD_PAGE_SIZE)}
              className="ed-ghost text-[13px] px-6 py-2"
            >
              Load More ({filteredAds.length - displayCount} remaining)
            </button>
          </div>
        )}
      </div>

      {/* Tag editor popover */}
      {tagEditAd && (
        <div className="fixed inset-0 z-50" onClick={() => { setTagEditAd(null); setTagInput(''); }}>
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-ed-surface rounded-xl shadow-xl border border-ed-line p-4 w-80"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[13px] font-semibold text-ed-ink">Tags</h4>
              <button onClick={() => { setTagEditAd(null); setTagInput(''); }} className="text-ed-ink3 hover:text-ed-ink2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Current tags */}
            <div className="flex flex-wrap gap-1.5 mb-3 min-h-[28px]">
              {(tagEditAd.tags || []).map(tag => (
                <span key={tag} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 bg-ed-accent/5 text-ed-accent rounded-full">
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tagEditAd, tag)}
                    className="text-ed-accent/60 hover:text-ed-accent"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </span>
              ))}
              {(!tagEditAd.tags || tagEditAd.tags.length === 0) && (
                <span className="text-[11px] text-ed-ink3">No tags yet</span>
              )}
            </div>

            {/* Add tag input */}
            <form onSubmit={(e) => {
              e.preventDefault();
              if (tagInput.trim()) {
                handleAddTag(tagEditAd, tagInput);
                setTagInput('');
              }
            }}>
              <input
                type="text"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                placeholder="Add a tag..."
                className="w-full text-[12px] px-3 py-2 border border-ed-line rounded-lg focus:outline-none focus:ring-2 focus:ring-ed-accent/20 focus:border-ed-accent"
                autoFocus
              />
            </form>

            {/* Quick-add suggestions */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {QUICK_TAGS.filter(t => !(tagEditAd.tags || []).includes(t)).map(tag => (
                <button
                  key={tag}
                  onClick={() => handleAddTag(tagEditAd, tag)}
                  className="text-[10px] px-2 py-1 bg-ed-bg text-ed-ink2 rounded-full hover:bg-ed-accent/5 hover:text-ed-accent transition-colors"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Full-size ad view modal */}
      {viewAd && createPortal(
        (
        <div
          className="fixed inset-0 bg-ed-bg0 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setViewAd(null)}
        >
          <div
            className="relative max-w-5xl w-full max-h-[90vh] bg-ed-surface rounded-xl overflow-hidden shadow-card-hover flex flex-col md:flex-row fade-in"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex-1 bg-ed-bg flex items-center justify-center p-2 min-h-[300px]">
              <img
                src={viewAd.imageUrl || viewAd.thumbnailUrl}
                alt={`Ad - ${viewAd.angle || 'No angle'}`}
                className="max-w-full max-h-[80vh] object-contain rounded-xl"
              />
            </div>

            <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-ed-line p-5 overflow-y-auto max-h-[40vh] md:max-h-[90vh] scrollbar-thin">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h4 className="text-[15px] font-semibold text-ed-ink tracking-tight">Ad Details</h4>
                  <button
                    onClick={(e) => handleToggleFavorite(viewAd, e)}
                    className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                      viewAd.is_favorite
                        ? 'text-rose-500 bg-rose-50 hover:bg-rose-100'
                        : 'text-ed-ink3 hover:text-rose-400 hover:bg-rose-50'
                    }`}
                    title={viewAd.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <svg className="w-4 h-4" fill={viewAd.is_favorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
                    </svg>
                  </button>
                </div>
                <button
                  onClick={() => setViewAd(null)}
                  className="w-7 h-7 rounded-lg bg-ed-bg flex items-center justify-center text-ed-ink3 hover:text-ed-ink2 hover:bg-ed-bg transition-all"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              {/* Quick Actions — 2-column grid; Edit Image (when present) wraps to its own full-width row */}
              <div className="grid grid-cols-2 gap-2 mb-5">
                <button
                  onClick={(e) => handleDownload(viewAd, e)}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 bg-ed-accent text-white rounded-xl text-[12px] font-medium hover:bg-ed-accent-light transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download
                </button>
                <button
                  onClick={(e) => handleRegenerate(viewAd, e)}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 bg-orange-500 text-white rounded-xl text-[12px] font-medium hover:bg-orange-600 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992" />
                  </svg>
                  Regenerate
                </button>
                {(viewAd.has_edit_prompt || getEditablePrompt(viewAd)) && (
                  <button
                    onClick={(e) => handleEditPrompt(viewAd, e)}
                    className="col-span-2 flex items-center justify-center gap-1.5 py-2 px-3 bg-ed-accent text-white rounded-xl text-[12px] font-medium hover:bg-ed-accent-light transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                    Edit Image
                  </button>
                )}
              </div>
              {/* Reuse settings */}
              <div className="mb-5">
                <button
                  onClick={(e) => handleRedo(viewAd, e)}
                  className="w-full flex items-center justify-center gap-1.5 py-2 px-3 bg-ed-accent/5 text-ed-accent border border-ed-accent/15 rounded-xl text-[12px] font-medium hover:bg-ed-accent/10 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                  Reuse Settings
                </button>
                <p className="text-[10px] text-ed-ink3 mt-1 text-center">
                  Copies this ad's settings into the form so you can iterate on it.
                </p>
              </div>

              {/* Edit workflow explanation */}
              {(viewAd.has_edit_prompt || getEditablePrompt(viewAd)) && (
                <div className="mb-5 p-3 bg-ed-accent/5 border border-ed-accent/10 rounded-xl">
                  <p className="text-[11px] font-medium text-ed-accent mb-1">How editing works</p>
                  <p className="text-[10px] text-ed-accent/70 leading-relaxed">
                    Click "Edit" to open the editor. Describe what you want to change in plain English and AI will update the prompt — or switch to direct editing for manual control. The original ad stays untouched.
                  </p>
                </div>
              )}

              {viewAdLoading && (
                <div className="mb-5 p-3 bg-ed-bg rounded-xl text-[11px] text-ed-ink3">
                  Loading full ad details...
                </div>
              )}

              <div className="space-y-4 text-[13px]">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Source</p>
                    <p className="text-ed-ink text-[12px]">
                      {(viewAd.auto_generated || viewAd.batch_job_id) ? 'Batch' :
                       viewAd.generation_mode === 'image_only' ? 'Prompt Edit' :
                       viewAd.generation_mode === 'mode2' ? 'Template' : 'Individual'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Aspect Ratio</p>
                    <p className="text-ed-ink text-[12px]">{viewAd.aspect_ratio}</p>
                  </div>
                  {(viewAd.text_model || viewAd.image_model) && (
                    <div className="col-span-2">
                      <p className="text-[11px] text-ed-ink3 mb-0.5">Models</p>
                      <p className="text-ed-ink text-[12px]">
                        {[viewAd.text_model, viewAd.image_model].filter(Boolean).join(' + ') || '—'}
                      </p>
                    </div>
                  )}
                </div>
                {viewAd.angle && (
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Ad Topic / Angle</p>
                    <p className="text-ed-ink">{viewAd.angle}</p>
                  </div>
                )}
                {viewAd.headline && (
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Headline</p>
                    <p className="text-ed-ink">{viewAd.headline}</p>
                  </div>
                )}
                {viewAd.body_copy && (
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Body Copy</p>
                    <p className="text-ed-ink">{viewAd.body_copy}</p>
                  </div>
                )}
                {viewAd.template_image_id && (
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Template Image</p>
                    <div className="flex items-center gap-2">
                      <img
                        src={`/api/projects/${projectId}/templates/${viewAd.template_image_id}/file`}
                        alt="Template"
                        className="w-10 h-10 object-cover rounded-lg border border-ed-line"
                      />
                      <span className="text-ed-ink2 text-[12px]">{getTemplateName(viewAd.template_image_id)}</span>
                    </div>
                  </div>
                )}
                {viewAd.parent_ad_id && (
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Derived From</p>
                    <button
                      onClick={() => {
                        const parentAd = ads.find(a => a.id === viewAd.parent_ad_id);
                        if (parentAd) void openAdDetails(parentAd);
                      }}
                      className="text-ed-accent hover:text-ed-accent/80 text-[13px] transition-colors"
                    >
                      View parent ad
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-0.5">Generated</p>
                    <p className="text-ed-ink text-[12px]">{parseDate(getAdGeneratedAt(viewAd))?.toLocaleString() || 'Unknown'}</p>
                  </div>
                  {viewAd.drive_url && (
                    <div>
                      <p className="text-[11px] text-ed-ink3 mb-0.5">Google Drive</p>
                      <a
                        href={viewAd.drive_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ed-accent hover:text-ed-accent/80 text-[12px] transition-colors"
                      >
                        Open in Drive
                      </a>
                    </div>
                  )}
                </div>
                {/* Tags */}
                <div>
                  <p className="text-[11px] text-ed-ink3 mb-1.5">Tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(viewAd.tags || []).map(tag => (
                      <span key={tag} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 bg-ed-accent/5 text-ed-accent rounded-full">
                        {tag}
                        <button
                          onClick={() => handleRemoveTag(viewAd, tag)}
                          className="text-ed-accent/60 hover:text-ed-accent"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </span>
                    ))}
                    <button
                      onClick={() => setTagEditAd(viewAd)}
                      className="text-[11px] px-2 py-1 border border-dashed border-ed-line text-ed-ink3 rounded-full hover:border-ed-accent/30 hover:text-ed-accent transition-colors"
                    >
                      + Add tag
                    </button>
                  </div>
                </div>
                {getEditablePrompt(viewAd) && (
                  <div>
                    <p className="text-[11px] text-ed-ink3 mb-1">Image Prompt</p>
                    <p className="text-ed-ink2 text-[12px] leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap bg-ed-bg p-3 rounded-xl scrollbar-thin font-mono">
                      {getEditablePrompt(viewAd)}
                    </p>
                  </div>
                )}
                <div className="pt-3 border-t border-ed-line">
                  <button
                    onClick={() => handleDelete(viewAd.id)}
                    className="text-[12px] text-ed-rust hover:text-ed-rust transition-colors"
                  >
                    Delete Ad
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        ),
        document.body
      )}
      {/* (Queue is now inline above the Ad Gallery) */}
      {/* Floating bulk action bar */}
      {shouldShowBulkBar && createPortal(
        (
          <div className="fixed left-3 right-3 sm:inset-x-0 bottom-4 sm:bottom-6 mx-auto sm:w-fit max-w-[calc(100vw-1.5rem)] z-[70] fade-in pb-[env(safe-area-inset-bottom)] pointer-events-none">
          {/* Bulk tag popover — floats above the action bar */}
          {bulkTagOpen && (() => {
            // Compute union of tags across all selected ads with counts
            const selectedAdsArr = ads.filter(a => selectedAdIds.has(a.id));
            const tagCounts = {};
            selectedAdsArr.forEach(a => {
              (a.tags || []).forEach(t => {
                tagCounts[t] = (tagCounts[t] || 0) + 1;
              });
            });
            const allTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
            const usedTagNames = allTags.map(([t]) => t);

            return (
              <div
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 bg-ed-surface rounded-xl shadow-xl border border-ed-line p-4 w-80 max-w-[calc(100vw-1.5rem)] pointer-events-auto"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-[13px] font-semibold text-ed-ink">Tag {selectedCount} ad{selectedCount !== 1 ? 's' : ''}</h4>
                  <button onClick={() => { setBulkTagOpen(false); setBulkTagInput(''); }} className="text-ed-ink3 hover:text-ed-ink2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                {/* Current tags across selected ads */}
                <div className="flex flex-wrap gap-1.5 mb-3 min-h-[28px]">
                  {allTags.map(([tag, count]) => (
                    <span key={tag} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 bg-ed-accent/5 text-ed-accent rounded-full">
                      {tag}{count < selectedCount && ` (${count})`}
                      <button
                        onClick={() => handleBulkRemoveTag(tag)}
                        className="text-ed-accent/60 hover:text-ed-accent"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </span>
                  ))}
                  {allTags.length === 0 && (
                    <span className="text-[11px] text-ed-ink3">No tags yet</span>
                  )}
                </div>

                {/* Add tag input */}
                <form onSubmit={(e) => {
                  e.preventDefault();
                  if (bulkTagInput.trim()) {
                    handleBulkAddTag(bulkTagInput);
                    setBulkTagInput('');
                  }
                }}>
                  <input
                    type="text"
                    value={bulkTagInput}
                    onChange={e => setBulkTagInput(e.target.value)}
                    placeholder="Add a tag..."
                    className="w-full text-[12px] px-3 py-2 border border-ed-line rounded-lg focus:outline-none focus:ring-2 focus:ring-ed-accent/20 focus:border-ed-accent"
                    autoFocus
                  />
                </form>

                {/* Quick-add suggestions */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {QUICK_TAGS.filter(t => !usedTagNames.includes(t)).map(tag => (
                    <button
                      key={tag}
                      onClick={() => handleBulkAddTag(tag)}
                      className="text-[10px] px-2 py-1 bg-ed-bg text-ed-ink2 rounded-full hover:bg-ed-accent/5 hover:text-ed-accent transition-colors"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="pointer-events-auto flex items-center gap-1.5 max-w-full overflow-x-auto pl-2 pr-2 py-1.5 bg-ed-accent/95 backdrop-blur-md rounded-xl sm:rounded-full shadow-2xl shadow-ed-accent/30 border border-white/10">
            {/* Count badge + label */}
            <div className="flex items-center gap-2 pl-2 pr-1">
              <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-full bg-ed-accent/20 text-ed-accent text-[11px] font-bold">
                {selectedCount}
              </span>
              <span className="text-[12px] text-white/90 font-medium">
                selected
              </span>
              {(downloadableSelectedCount < selectedCount || pipelineSendableSelectedCount < selectedCount) && (
                <span className="hidden sm:inline text-[10px] text-white/55">
                  {downloadableSelectedCount} downloadable · {pipelineSendableSelectedCount} sendable
                </span>
              )}
            </div>

            <div className="w-px h-5 bg-white/15" />

            <button
              onClick={handleDeploy}
              disabled={isDeploying || pipelineSendableSelectedCount === 0}
              title={deployButtonTitle}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-ed-green hover:bg-ed-green/90 disabled:bg-ed-green/60 disabled:opacity-60 disabled:cursor-not-allowed text-white text-[12px] font-medium rounded-full transition-colors"
            >
              {isDeploying ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
                  </svg>
                  Send to Pipeline
                </>
              )}
            </button>

            <button
              onClick={() => { if (bulkTagOpen) { clearSelection(); } else { setBulkTagOpen(true); setBulkTagInput(''); } }}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 text-white text-[12px] font-medium rounded-full transition-colors ${bulkTagOpen ? 'bg-violet-600 hover:bg-violet-700' : 'bg-violet-500 hover:bg-violet-600'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              Tag
            </button>

            <button
              onClick={handleBulkDownload}
              disabled={isBulkDownloading || downloadableSelectedCount === 0}
              title={downloadButtonTitle}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-ed-accent-light hover:bg-ed-accent-mid disabled:bg-ed-accent-light/60 disabled:opacity-60 disabled:cursor-not-allowed text-white text-[12px] font-medium rounded-full transition-colors"
            >
              {isBulkDownloading ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Zipping...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download
                </>
              )}
            </button>

            <button
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-ed-rust hover:bg-ed-rust/90 disabled:bg-ed-rust/60 text-white text-[12px] font-medium rounded-full transition-colors"
            >
              {isBulkDeleting ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                  Delete
                </>
              )}
            </button>

            <div className="w-px h-5 bg-white/15" />

            <button
              onClick={clearSelection}
              className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/15 text-white/70 hover:text-white flex items-center justify-center transition-colors"
              title="Clear selection"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          </div>
        ),
        document.body
      )}
    </div>
  );
}

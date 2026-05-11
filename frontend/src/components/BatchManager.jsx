import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';
import TemplateTagHelp from './TemplateTagHelp';
import { useToast } from './Toast';
import BatchRow from './BatchRow';
import { usePolling } from '../hooks/usePolling';
import { ensureArray } from '../utils/collections';
import {
  CRON_PRESETS, INTERVAL_UNITS, ASPECT_RATIOS,
  STATUS_COLORS, STATUS_LABELS,
  intervalToCron, cronToLabel, parseCronToInterval,
  getNextRun, formatNextRun, formatDate, formatDuration
} from './batchUtils';

// Template source options (same as AdStudio)
const TEMPLATE_RANDOM = 'random';
const TEMPLATE_UPLOAD = 'upload';
const TEMPLATE_SELECT = 'select';
const CUSTOM_ANGLE_MODE = '__custom__';

const ACTIVE_BATCH_STATUSES = new Set(['queued', 'generating_prompts', 'submitting', 'processing', 'saving_results']);
const LOCAL_BATCH_PROTECT_MS = 2 * 60 * 1000;

function getTemplateTags(templates = []) {
  return [...new Set((templates || [])
    .filter(t => !t.archived_at)
    .flatMap(t => Array.isArray(t.tags) ? t.tags : [])
    .map(tag => String(tag || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function batchTimestamp(batch) {
  const candidates = [
    batch?.completed_at,
    batch?.last_heartbeat_at,
    batch?.started_at,
    batch?.queued_at,
    batch?.created_at,
  ];
  for (const value of candidates) {
    const time = value ? new Date(value).getTime() : 0;
    if (Number.isFinite(time) && time > 0) return time;
  }
  return 0;
}

function sortBatches(list) {
  return [...list].sort((a, b) => batchTimestamp(b) - batchTimestamp(a));
}

function chooseFresherBatch(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return batchTimestamp(incoming) >= batchTimestamp(existing) ? incoming : existing;
}

function isProtectedActiveBatch(batch) {
  return batch?.id && ACTIVE_BATCH_STATUSES.has(batch.status);
}

function upsertBatchIntoList(list, batch) {
  if (!batch?.id) return list;
  const map = new Map((list || []).map(item => [item.id, item]));
  map.set(batch.id, chooseFresherBatch(map.get(batch.id), batch));
  return sortBatches(Array.from(map.values()));
}


export default function BatchManager({ projectId, project, conductorAngles = [], onBatchComplete }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const locallyActiveBatchIdsRef = useRef(new Map());
  const previousBatchesRef = useRef([]);

  // Create form
  const [batchSize, setBatchSize] = useState(5);
  const [batchAngle, setBatchAngle] = useState('');
  const [batchAngleModeOverride, setBatchAngleModeOverride] = useState('');
  const batchAngleTouchedRef = useRef(false);
  const [batchAspectRatio, setBatchAspectRatio] = useState('1:1');
  const [isScheduled, setIsScheduled] = useState(false);
  const [cronPreset, setCronPreset] = useState('0 9 * * *');
  const [intervalAmount, setIntervalAmount] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState('minutes');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Template source
  const [templateSource, setTemplateSource] = useState(TEMPLATE_RANDOM);
  const [templateTag, setTemplateTag] = useState('');
  const [driveImages, setDriveImages] = useState([]);
  const [uploadedTemplates, setUploadedTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplates, setSelectedTemplates] = useState([]); // [{ id, source }, ...]
  const templateTags = useMemo(() => getTemplateTags(uploadedTemplates), [uploadedTemplates]);

  const activeConductorAngles = useMemo(() => {
    return ensureArray(conductorAngles, 'BatchManager.conductorAngles')
      .filter(a => a?.status === 'active');
  }, [conductorAngles]);

  const directOfferAngleName = useMemo(() => {
    return activeConductorAngles.find(a => a?.is_system_default === true)?.name || '';
  }, [activeConductorAngles]);

  const batchAngleMode = useMemo(() => {
    if (batchAngleModeOverride === CUSTOM_ANGLE_MODE) return CUSTOM_ANGLE_MODE;
    if (!batchAngle.trim()) return '';
    return activeConductorAngles.some(a => a?.name === batchAngle) ? batchAngle : CUSTOM_ANGLE_MODE;
  }, [activeConductorAngles, batchAngle, batchAngleModeOverride]);

  const handleBatchAngleModeChange = useCallback((value) => {
    batchAngleTouchedRef.current = true;
    if (value === CUSTOM_ANGLE_MODE) {
      setBatchAngleModeOverride(CUSTOM_ANGLE_MODE);
      return;
    }
    setBatchAngleModeOverride('');
    setBatchAngle(value);
  }, []);

  // Upload one-off template
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Product image for batch
  const [batchProductFile, setBatchProductFile] = useState(null);
  const [batchProductPreview, setBatchProductPreview] = useState(null);
  const [batchProductDragOver, setBatchProductDragOver] = useState(false);
  const [skipProductImage, setSkipProductImage] = useState(false);
  const batchProductInputRef = useRef(null);

  // Derive effective cron expression from preset or custom interval
  const getEffectiveCron = () => {
    if (cronPreset === 'custom') return intervalToCron(intervalAmount, intervalUnit);
    return cronPreset;
  };

  // Queue state
  const [queue, setQueue] = useState([]);
  const [submittingQueue, setSubmittingQueue] = useState(false);

  // Load batches when expanded
  useEffect(() => {
    if (expanded) {
      loadBatches();
    }
  }, [expanded, projectId]);

  useEffect(() => {
    batchAngleTouchedRef.current = false;
    setBatchAngleModeOverride('');
    setBatchAngle('');
  }, [projectId]);

  useEffect(() => {
    if (!directOfferAngleName || batchAngleTouchedRef.current) return;
    setBatchAngle(prev => (prev.trim() ? prev : directOfferAngleName));
  }, [directOfferAngleName, projectId]);

  // Poll for batches — 10s when any batch is active, 30s otherwise
  const hasActiveBatches = batches.some(b => ['queued', 'generating_prompts', 'submitting', 'processing', 'saving_results'].includes(b.status));
  usePolling(() => loadBatches(true), hasActiveBatches ? 10000 : 30000, expanded);

  useEffect(() => {
    const prev = previousBatchesRef.current;
    if (onBatchComplete && prev.length > 0) {
      const newlyCompleted = batches.some(batch =>
        batch.status === 'completed' && prev.find(previous => previous.id === batch.id && previous.status !== 'completed')
      );
      if (newlyCompleted) onBatchComplete();
    }
    previousBatchesRef.current = batches;
  }, [batches, onBatchComplete]);

  // Load templates when template tags or picker choices are needed
  useEffect(() => {
    if ((templateSource === TEMPLATE_SELECT || templateSource === TEMPLATE_RANDOM) && driveImages.length === 0 && uploadedTemplates.length === 0) {
      loadTemplates();
    }
  }, [templateSource]);

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const [driveData, uploadedData] = await Promise.all([
        api.getInspirationImages(projectId).catch(() => ({ images: [] })),
        api.getTemplates(projectId).catch(() => ({ templates: [] }))
      ]);
      setDriveImages(driveData.images || []);
      setUploadedTemplates(uploadedData.templates || []);
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  // File upload handlers for Manual Upload
  const handleFileSelected = useCallback((file) => {
    if (!file) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setCreateError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    setUploadedFile(file);
    setUploadedPreview(URL.createObjectURL(file));
    setTemplateSource(TEMPLATE_UPLOAD);
    setCreateError('');
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelected(file);
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
    setUploadedFile(null);
    if (uploadedPreview) URL.revokeObjectURL(uploadedPreview);
    setUploadedPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Product image handlers
  const handleBatchProductSelected = useCallback((file) => {
    if (!file) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setCreateError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    setBatchProductFile(file);
    setBatchProductPreview(URL.createObjectURL(file));
  }, []);

  const handleBatchProductDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setBatchProductDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleBatchProductSelected(file);
  }, [handleBatchProductSelected]);

  const clearBatchProductImage = () => {
    setBatchProductFile(null);
    if (batchProductPreview) URL.revokeObjectURL(batchProductPreview);
    setBatchProductPreview(null);
    if (batchProductInputRef.current) batchProductInputRef.current.value = '';
  };

  // Helper to convert file to base64
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Build batch config based on current template selection
  const buildBatchConfig = () => {
    const config = {
      batch_size: batchSize,
      angle: batchAngle.trim() || undefined,
      aspect_ratio: batchAspectRatio,
      scheduled: isScheduled,
      schedule_cron: isScheduled ? getEffectiveCron() : undefined,
      run_immediately: !isScheduled
    };

    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length > 0) {
      const driveIds = selectedTemplates.filter(t => t.source === 'drive').map(t => t.id);
      const uploadedIds = selectedTemplates.filter(t => t.source === 'uploaded').map(t => t.id);

      // Single template — backward compatible, use original fields
      if (selectedTemplates.length === 1) {
        if (uploadedIds.length === 1) {
          config.generation_mode = 'mode2';
          config.template_image_id = uploadedIds[0];
        } else {
          config.generation_mode = 'mode1';
          config.inspiration_image_id = driveIds[0];
        }
      } else {
        // Multi-template — pass arrays
        config.generation_mode = uploadedIds.length > 0 && driveIds.length === 0 ? 'mode2' : 'mode1';
        if (driveIds.length > 0) config.inspiration_image_ids = JSON.stringify(driveIds);
        if (uploadedIds.length > 0) config.template_image_ids = JSON.stringify(uploadedIds);
      }
    } else {
      config.generation_mode = 'mode1';
      if (templateSource === TEMPLATE_RANDOM && templateTag) {
        config.template_tag = templateTag;
      }
    }

    return config;
  };

  // Template source display label for queue items
  const getTemplateLabel = () => {
    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length > 0) {
      return `${selectedTemplates.length} template${selectedTemplates.length !== 1 ? 's' : ''} selected`;
    }
    if (templateSource === TEMPLATE_UPLOAD && uploadedFile) {
      return `Upload: ${uploadedFile.name.slice(0, 15)}`;
    }
    return 'Random';
  };

  // Toggle a template in/out of the selectedTemplates array
  const toggleTemplate = (id, source) => {
    setSelectedTemplates(prev => {
      const exists = prev.find(t => t.id === id && t.source === source);
      if (exists) return prev.filter(t => !(t.id === id && t.source === source));
      if (prev.length >= batchSize) return prev; // cap at batch size
      return [...prev, { id, source }];
    });
  };

  const rememberLocalActiveBatch = useCallback((batch) => {
    if (!isProtectedActiveBatch(batch)) return;
    locallyActiveBatchIdsRef.current.set(batch.id, Date.now());
  }, []);

  const forgetExpiredLocalActiveBatches = useCallback(() => {
    const now = Date.now();
    for (const [id, rememberedAt] of locallyActiveBatchIdsRef.current.entries()) {
      if (now - rememberedAt > LOCAL_BATCH_PROTECT_MS) {
        locallyActiveBatchIdsRef.current.delete(id);
      }
    }
  }, []);

  const upsertBatch = useCallback((batch) => {
    if (!batch?.id) return;
    rememberLocalActiveBatch(batch);
    setBatches(prev => upsertBatchIntoList(prev, batch));
  }, [rememberLocalActiveBatch]);

  const loadBatches = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.getBatches(projectId);
      const fetched = data.batches || [];
      forgetExpiredLocalActiveBatches();

      setBatches(prev => {
        const fetchedById = new Map(fetched.map(batch => [batch.id, batch]));
        const prevById = new Map(prev.map(batch => [batch.id, batch]));
        const mergedById = new Map();

        for (const batch of fetched) {
          const previous = prevById.get(batch.id);
          const isLocallyProtected = locallyActiveBatchIdsRef.current.has(batch.id);
          const nextBatch = isLocallyProtected ? chooseFresherBatch(previous, batch) : batch;
          mergedById.set(batch.id, nextBatch);
          if (!isLocallyProtected || nextBatch === batch) {
            locallyActiveBatchIdsRef.current.delete(batch.id);
          }
        }

        for (const previous of prev) {
          const rememberedAt = locallyActiveBatchIdsRef.current.get(previous.id);
          if (!fetchedById.has(previous.id) && rememberedAt && isProtectedActiveBatch(previous)) {
            mergedById.set(previous.id, previous);
          }
        }

        return sortBatches(Array.from(mergedById.values()));
      });
    } catch (err) {
      console.error('Failed to load batches:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleCreate = async () => {
    // Validate template selection
    if (templateSource === TEMPLATE_UPLOAD && !uploadedFile) {
      setCreateError('Please upload a template image or switch to "Random Template".');
      return;
    }
    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length === 0) {
      setCreateError('Please select at least one template image.');
      return;
    }

    setCreating(true);
    setCreateError('');

    try {
      const config = buildBatchConfig();

      // If manual upload, we need to upload the template first, then use mode2
      if (templateSource === TEMPLATE_UPLOAD && uploadedFile) {
        const uploaded = await api.uploadTemplate(projectId, uploadedFile, `Batch upload - ${uploadedFile.name}`);
        config.generation_mode = 'mode2';
        config.template_image_id = uploaded.template?.id || uploaded.id;
      }

      // Attach product image if provided
      if (batchProductFile) {
        const base64 = await fileToBase64(batchProductFile);
        config.product_image = base64;
        config.product_image_mime = batchProductFile.type || 'image/png';
      }

      // Skip product image if toggled
      if (skipProductImage) {
        config.skip_product_image = true;
      }

      const createdBatch = await api.createBatch(projectId, config);
      upsertBatch(createdBatch);

      // Reset form
      setBatchAngle('');
      setIsScheduled(false);
      await loadBatches(true);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRunNow = async (batchId) => {
    try {
      const result = await api.runBatch(projectId, batchId);
      if (result?.batch) upsertBatch(result.batch);
      toast.success('Batch started');
      await loadBatches(true);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleCancel = async (batchId) => {
    if (!confirm('Cancel this batch job?')) return;
    try {
      await api.cancelBatch(projectId, batchId);
      toast.success('Batch cancelled');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleDelete = async (batchId) => {
    if (!confirm('Delete this batch job?')) return;
    try {
      await api.deleteBatch(projectId, batchId);
      setBatches(prev => prev.filter(b => b.id !== batchId));
      toast.success('Batch deleted');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleEditBatch = async (batchId, updates) => {
    try {
      await api.updateBatch(projectId, batchId, updates);
      toast.success('Batch updated');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handlePause = async (batchId) => {
    try {
      await api.updateBatch(projectId, batchId, { scheduled: false });
      toast.success('Automation paused');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleResume = async (batchId) => {
    try {
      await api.updateBatch(projectId, batchId, { scheduled: true });
      toast.success('Automation resumed');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Queue handlers
  const handleAddToQueue = () => {
    // Validate template selection
    if (templateSource === TEMPLATE_UPLOAD && !uploadedFile) {
      setCreateError('Please upload a template image or switch to "Random Template".');
      return;
    }
    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length === 0) {
      setCreateError('Please select at least one template image.');
      return;
    }

    const cronExpression = getEffectiveCron();
    const config = {
      id: Date.now(),
      batch_size: batchSize,
      angle: batchAngle.trim() || '',
      aspect_ratio: batchAspectRatio,
      scheduled: isScheduled,
      schedule_cron: isScheduled ? cronExpression : undefined,
      templateSource,
      templateLabel: getTemplateLabel(),
      templateTag,
      selectedTemplates: selectedTemplates.length > 0 ? [...selectedTemplates] : [],
      uploadedFile: templateSource === TEMPLATE_UPLOAD ? uploadedFile : null
    };
    setQueue(prev => [...prev, config]);
    setBatchAngle('');
    setIsScheduled(false);
  };

  const handleRemoveFromQueue = (tempId) => {
    setQueue(prev => prev.filter(item => item.id !== tempId));
  };

  const handleEditQueueItem = (tempId) => {
    const item = queue.find(q => q.id === tempId);
    if (!item) return;

    // Load values back into the form
    setBatchSize(item.batch_size || 5);
    batchAngleTouchedRef.current = true;
    setBatchAngleModeOverride('');
    setBatchAngle(item.angle || '');
    setBatchAspectRatio(item.aspect_ratio || '1:1');
    setIsScheduled(!!item.scheduled);

    if (item.schedule_cron) {
      // Check if it matches a preset
      const matchingPreset = CRON_PRESETS.find(p => p.value === item.schedule_cron && p.value !== 'custom');
      if (matchingPreset) {
        setCronPreset(matchingPreset.value);
      } else {
        // Try to reverse-parse the cron into interval amount + unit
        setCronPreset('custom');
        const parsed = parseCronToInterval(item.schedule_cron);
        if (parsed) {
          setIntervalAmount(parsed.amount);
          setIntervalUnit(parsed.unit);
        }
      }
    } else {
      setCronPreset('0 9 * * *');
    }

    if (item.templateSource) setTemplateSource(item.templateSource);
    setTemplateTag(item.templateTag || '');
    if (item.selectedTemplate) setSelectedTemplates(Array.isArray(item.selectedTemplate) ? item.selectedTemplate : [item.selectedTemplate]);

    // Remove from queue
    setQueue(prev => prev.filter(q => q.id !== tempId));
  };

  const handleSubmitQueue = async () => {
    if (queue.length === 0) return;
    setSubmittingQueue(true);
    setCreateError('');
    let createdCount = 0;
    const submittedIds = new Set();

    try {
      for (const config of queue) {
        const batchConfig = {
          batch_size: config.batch_size,
          angle: config.angle || undefined,
          aspect_ratio: config.aspect_ratio,
          scheduled: config.scheduled,
          schedule_cron: config.schedule_cron,
          run_immediately: !config.scheduled
        };

        if (config.templateSource === TEMPLATE_SELECT && config.selectedTemplate) {
          if (config.selectedTemplate.source === 'uploaded') {
            batchConfig.generation_mode = 'mode2';
            batchConfig.template_image_id = config.selectedTemplate.id;
          } else {
            batchConfig.generation_mode = 'mode1';
            batchConfig.inspiration_image_id = config.selectedTemplate.id;
          }
        } else if (config.templateSource === TEMPLATE_UPLOAD && config.uploadedFile) {
          // Upload template first
          const uploaded = await api.uploadTemplate(projectId, config.uploadedFile, `Batch upload - ${config.uploadedFile.name}`);
          batchConfig.generation_mode = 'mode2';
          batchConfig.template_image_id = uploaded.template?.id || uploaded.id;
        } else {
          batchConfig.generation_mode = 'mode1';
          if (config.templateSource === TEMPLATE_RANDOM && config.templateTag) {
            batchConfig.template_tag = config.templateTag;
          }
        }

        const createdBatch = await api.createBatch(projectId, batchConfig);
        createdCount += 1;
        submittedIds.add(config.id);
        upsertBatch(createdBatch);
      }

      toast.success(`${queue.length} batch${queue.length !== 1 ? 'es' : ''} created`);
      setQueue([]);
      await loadBatches(true);
    } catch (err) {
      setQueue(prev => prev.filter(item => !submittedIds.has(item.id)));
      const prefix = createdCount > 0
        ? `${createdCount} of ${queue.length} batch${queue.length !== 1 ? 'es' : ''} created. `
        : '';
      setCreateError(`${prefix}Queue submission error: ${err.message}`);
    } finally {
      setSubmittingQueue(false);
    }
  };

  const activeBatches = batches.filter(b =>
    ['queued', 'generating_prompts', 'submitting', 'processing', 'saving_results', 'pending'].includes(b.status)
    || !!b.schedule_cron  // Include all scheduled/paused batches in active section
  );
  const completedBatches = batches.filter(b =>
    ['completed', 'failed'].includes(b.status) && !b.schedule_cron
  );

  return (
    <div className="ed-card overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-black/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-ed-accent to-ed-accent/80 flex items-center justify-center shadow-sm">
            <svg className="w-4.5 h-4.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L12 12.75 6.429 9.75m11.142 0l4.179 2.25-9.75 5.25-9.75-5.25 4.179-2.25" />
            </svg>
          </div>
          <div>
            <h3 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight flex items-center gap-1">
              Batch Generation
              <InfoTooltip text="Create many ads as a background job. Use this when you want volume; use Ad Studio for one-off ads and Creative Director for automated angle-based ad sets." position="right" />
            </h3>
            <p className="text-[12px] text-ed-ink3">
              Generate multiple ads in the background when you need volume.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {activeBatches.length > 0 && (
              <span className="badge bg-ed-accent/10 text-ed-accent">
                {activeBatches.length} active
              </span>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 px-2 py-1 rounded-md transition-all">
            Details
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </span>
        </div>
      </button>

      {/* Expandable content */}
      {expanded && (
        <div className="border-t border-black/5 fade-in">
          {/* Create Batch Form */}
          <div className="p-5 border-b border-black/5">
            <h4 className="text-[13px] font-semibold text-ed-ink mb-3">New Batch</h4>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              {/* Batch size */}
              <div>
                <label className="text-[11px] font-medium text-ed-ink2 mb-1 flex items-center gap-1">
                  Batch Size
                  <InfoTooltip text="How many image attempts this background batch should create. This is generated volume, not the number of ads that will pass QA." position="right" />
                </label>
                <input
                  data-testid="batch-size-input"
                  type="number"
                  min={1}
                  max={50}
                  value={batchSize}
                  onChange={e => setBatchSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                  disabled={creating}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                />
                <p className="text-[10px] text-ed-ink3 mt-0.5">1-50 images</p>
              </div>

              {/* Aspect ratio */}
              <div>
                <label className="text-[11px] font-medium text-ed-ink2 mb-1 flex items-center gap-1">
                  Aspect Ratio
                  <InfoTooltip text="The canvas shape for every generated image in this batch." position="right" />
                </label>
                <select
                  value={batchAspectRatio}
                  onChange={e => setBatchAspectRatio(e.target.value)}
                  disabled={creating}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                >
                  {ASPECT_RATIOS.map(ar => (
                    <option key={ar.value} value={ar.value}>{ar.label}</option>
                  ))}
                </select>
              </div>

              {/* Angle */}
              <div>
                <label className="text-[11px] font-medium text-ed-ink2 mb-1 flex items-center gap-1">
                  Ad Topic / Angle <span className="text-ed-ink3/60">(opt.)</span>
                  <InfoTooltip text="Optional direction for the batch. Leave blank if you want the system to use project context and template guidance only." position="right" />
                </label>
                <select
                  data-testid="batch-angle-select"
                  value={batchAngleMode}
                  onChange={e => handleBatchAngleModeChange(e.target.value)}
                  disabled={creating}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                >
                  <option value="">No angle / template-only</option>
                  {activeConductorAngles.map(a => (
                    <option key={a.externalId || a.name} value={a.name}>
                      {a.is_system_default ? `${a.name} (Direct Offer default)` : a.name}
                    </option>
                  ))}
                  <option value={CUSTOM_ANGLE_MODE}>Custom…</option>
                </select>
                {batchAngleMode === CUSTOM_ANGLE_MODE && (
                  <input
                    data-testid="batch-angle-input"
                    value={batchAngle}
                    onChange={e => { batchAngleTouchedRef.current = true; setBatchAngleModeOverride(CUSTOM_ANGLE_MODE); setBatchAngle(e.target.value); }}
                    disabled={creating}
                    placeholder='e.g., "before & after"'
                    className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent mt-2"
                  />
                )}
              </div>
            </div>

            {/* Template Source */}
            <div className="mb-3">
              <label className="text-[11px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-1">
                Template Image
                <InfoTooltip text="The visual reference used for layout and style. Random uses your library; Manual Upload uses one file; Pick Template lets you choose specific references." position="right" />
              </label>
              <div className="segmented-control mb-2">
                <button
                  onClick={() => setTemplateSource(TEMPLATE_RANDOM)}
                  className={templateSource === TEMPLATE_RANDOM ? 'active' : ''}
                  disabled={creating}
                >
                  Random Template
                </button>
                <button
                  onClick={() => setTemplateSource(TEMPLATE_UPLOAD)}
                  className={templateSource === TEMPLATE_UPLOAD ? 'active' : ''}
                  disabled={creating}
                >
                  Manual Upload
                </button>
                <button
                  onClick={() => setTemplateSource(TEMPLATE_SELECT)}
                  className={templateSource === TEMPLATE_SELECT ? 'active' : ''}
                  disabled={creating}
                >
                  Pick Template
                </button>
              </div>

              {/* Random */}
              {templateSource === TEMPLATE_RANDOM && (
                <div className="p-3 bg-ed-bg border border-black/5 rounded-xl">
                  <p className="text-[11px] text-ed-ink2">
                    Each ad in the batch will use a <strong>different random template</strong> from your uploaded templates.
                  </p>
                  <div className="mt-3">
                    <label className="text-[10px] uppercase tracking-[0.08em] text-ed-ink3 font-medium">Template Tag</label>
                    <select
                      value={templateTag}
                      onChange={e => setTemplateTag(e.target.value)}
                      disabled={creating}
                      className="mt-1 text-[12px] text-ed-ink bg-ed-surface border border-ed-line rounded-lg px-2 py-1.5 w-full"
                    >
                      <option value="">Any active template</option>
                      {templateTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                    </select>
                    <p className="text-[10px] text-ed-ink3 mt-1">
                      Optional. Choose a tag to limit random templates for this batch.
                    </p>
                    <TemplateTagHelp projectId={projectId} hasTags={templateTags.length > 0} />
                  </div>
                </div>
              )}

              {/* Manual Upload */}
              {templateSource === TEMPLATE_UPLOAD && (
                <div>
                  {uploadedFile && uploadedPreview ? (
                    <div className="flex items-center gap-3 p-3 bg-ed-bg border border-black/5 rounded-xl">
                      <img
                        src={uploadedPreview}
                        alt="Uploaded template"
                        className="w-14 h-14 object-cover rounded-lg border border-black/5"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-ed-ink truncate">{uploadedFile.name}</p>
                        <p className="text-[10px] text-ed-ink3">{(uploadedFile.size / 1024).toFixed(0)} KB — all ads in batch use this template</p>
                      </div>
                      <button
                        onClick={clearUploadedImage}
                        disabled={creating}
                        className="text-[11px] text-ed-rust hover:text-ed-rust transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div
                      onClick={() => !creating && fileInputRef.current?.click()}
                      onDragOver={handleDragOver}
                      onDragEnter={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${
                        dragOver ? 'border-ed-accent bg-ed-accent/5' :
                        'border-black/5 hover:border-ed-accent hover:bg-ed-bg'
                      }`}
                    >
                      <p className={`text-[12px] font-medium ${dragOver ? 'text-ed-accent' : 'text-ed-ink2'}`}>
                        {dragOver ? 'Drop image here' : 'Drop a template image, or click to browse'}
                      </p>
                      <p className="text-[10px] text-ed-ink3 mt-0.5">JPG, PNG, WebP, or GIF — all ads in batch use this template</p>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.gif"
                    onChange={e => { if (e.target.files?.[0]) handleFileSelected(e.target.files[0]); }}
                    className="hidden"
                  />
                </div>
              )}

              {/* Pick Template */}
              {templateSource === TEMPLATE_SELECT && (
                <div>
                  {loadingTemplates ? (
                    <div className="text-ed-ink3 text-center py-6 text-[12px]">Loading templates...</div>
                  ) : driveImages.length === 0 && uploadedTemplates.length === 0 ? (
                    <div className="p-4 bg-ed-bg border border-black/5 rounded-xl text-center">
                      <p className="text-[12px] text-ed-ink2 font-medium mb-0.5">No Templates Available</p>
                      <p className="text-[10px] text-ed-ink3">
                        Upload templates in the Template Library tab to use them here.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {driveImages.length > 0 && (
                        <div>
                          <p className="text-[10px] text-ed-ink3 font-medium mb-1.5">
                            Drive Templates <span className="text-ed-ink3/60">({driveImages.length})</span>
                          </p>
                          <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 gap-1.5 max-h-[200px] overflow-y-auto rounded-lg pr-1 scrollbar-thin">
                            {driveImages.map(img => {
                              const selIdx = selectedTemplates.findIndex(t => t.id === img.id && t.source === 'drive');
                              const isSelected = selIdx >= 0;
                              const atMax = selectedTemplates.length >= batchSize && !isSelected;
                              return (
                                <button
                                  key={`drive-${img.id}`}
                                  onClick={() => toggleTemplate(img.id, 'drive')}
                                  disabled={creating || atMax}
                                  className={`group relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                                    isSelected
                                      ? 'border-ed-accent ring-2 ring-ed-accent/20 shadow-md'
                                      : atMax
                                        ? 'border-black/5 opacity-40 cursor-not-allowed'
                                        : 'border-black/5 hover:border-black/10'
                                  } cursor-pointer`}
                                >
                                  <img
                                    src={img.thumbnailUrl}
                                    alt={img.name || img.id}
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                  {isSelected && (
                                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-ed-accent flex items-center justify-center shadow-sm text-[8px] font-bold text-white leading-none">
                                      {selIdx + 1}
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {uploadedTemplates.length > 0 && (
                        <div>
                          <p className="text-[10px] text-ed-ink3 font-medium mb-1.5">
                            Uploaded Templates <span className="text-ed-ink3/60">({uploadedTemplates.length})</span>
                          </p>
                          <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 gap-1.5">
                            {uploadedTemplates.map(t => {
                              const selIdx = selectedTemplates.findIndex(st => st.id === t.id && st.source === 'uploaded');
                              const isSelected = selIdx >= 0;
                              const atMax = selectedTemplates.length >= batchSize && !isSelected;
                              return (
                                <button
                                  key={`uploaded-${t.id}`}
                                  onClick={() => toggleTemplate(t.id, 'uploaded')}
                                  disabled={creating || atMax}
                                  className={`group relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                                    isSelected
                                      ? 'border-ed-accent ring-2 ring-ed-accent/20 shadow-md'
                                      : atMax
                                        ? 'border-black/5 opacity-40 cursor-not-allowed'
                                        : 'border-black/5 hover:border-black/10'
                                  } cursor-pointer`}
                                >
                                  <img
                                    src={t.thumbnailUrl}
                                    alt={t.description || t.filename}
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                  {isSelected && (
                                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-ed-accent flex items-center justify-center shadow-sm text-[8px] font-bold text-white leading-none">
                                      {selIdx + 1}
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {selectedTemplates.length > 0 && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] text-ed-accent font-medium">
                        {selectedTemplates.length} template{selectedTemplates.length !== 1 ? 's' : ''} selected
                      </span>
                      <span className="text-[10px] text-ed-ink3">
                        {selectedTemplates.length === 1
                          ? '— all ads use this template'
                          : selectedTemplates.length >= batchSize
                            ? '— each ad uses a unique template'
                            : `— randomly distributed across ${batchSize} ads`}
                      </span>
                      <button
                        onClick={() => setSelectedTemplates([])}
                        disabled={creating}
                        className="text-[11px] text-ed-ink3 hover:text-ed-ink2 transition-colors"
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                  {selectedTemplates.length === 0 && (driveImages.length > 0 || uploadedTemplates.length > 0) && (
                    <p className="mt-2 text-[10px] text-ed-ink3">
                      Select templates to use in this batch (up to {batchSize}), or leave empty for fully random.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Product Image (project-level + optional per-batch override) */}
            <div className="mb-3">
              <label className="text-[11px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-1">
                Product Image
                <InfoTooltip text="The product reference the image model should preserve. The project default is used unless you choose a different image for this batch." position="right" />
              </label>

              {/* Show project-level product image indicator */}
              {project?.productImageUrl && !batchProductFile && (
                <div className="flex items-center gap-3 p-2.5 bg-ed-green/5 border border-ed-green/15 rounded-xl mb-2">
                  <img
                    src={project.productImageUrl}
                    alt="Project product"
                    className="w-9 h-9 object-cover rounded-lg border border-ed-green/15"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-medium text-ed-green">Using project product image</p>
                    <p className="text-[10px] text-ed-green/70">Used for all ads in this batch unless you choose a different image.</p>
                  </div>
                  <button
                    onClick={() => !creating && batchProductInputRef.current?.click()}
                    className="text-[10px] text-ed-ink3 hover:text-ed-ink2 transition-colors text-right leading-tight max-w-[92px] sm:max-w-none"
                  >
                    Use different image for this batch
                  </button>
                </div>
              )}

              {batchProductFile && batchProductPreview ? (
                <div className="flex items-center gap-3 p-3 bg-ed-bg border border-black/5 rounded-xl">
                  <img
                    src={batchProductPreview}
                    alt="Product image"
                    className="w-12 h-12 object-cover rounded-lg border border-black/5"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-ed-ink truncate">
                      {project?.productImageUrl ? 'Batch-only product image override' : batchProductFile.name}
                    </p>
                    <p className="text-[10px] text-ed-ink3">
                      {project?.productImageUrl ? `${batchProductFile.name} · ` : ''}{(batchProductFile.size / 1024).toFixed(0)} KB
                      {project?.productImageUrl ? ' — overrides the project image for this batch only' : ' — used for all ads in batch'}
                    </p>
                  </div>
                  <button
                    onClick={clearBatchProductImage}
                    disabled={creating}
                    className="text-[11px] text-ed-rust hover:text-ed-rust transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ) : !project?.productImageUrl ? (
                <div
                  onClick={() => !creating && batchProductInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setBatchProductDragOver(true); }}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setBatchProductDragOver(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setBatchProductDragOver(false); }}
                  onDrop={handleBatchProductDrop}
                  className={`border-2 border-dashed rounded-xl p-3 text-center cursor-pointer transition-all ${
                    batchProductDragOver ? 'border-ed-accent bg-ed-accent/5' :
                    'border-black/5 hover:border-ed-accent hover:bg-ed-bg'
                  }`}
                >
                  <svg className="w-5 h-5 mx-auto mb-1 text-ed-ink3/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  <p className={`text-[11px] font-medium ${batchProductDragOver ? 'text-ed-accent' : 'text-ed-ink2'}`}>
                    {batchProductDragOver ? 'Drop product image here' : 'Drop a product image, or click to browse'}
                  </p>
                  <p className="text-[10px] text-ed-ink3 mt-0.5">Or set one in Project Settings for all ads</p>
                </div>
              ) : null}
              <input
                ref={batchProductInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.gif"
                onChange={e => { if (e.target.files?.[0]) handleBatchProductSelected(e.target.files[0]); }}
                className="hidden"
              />

              {/* Skip product image toggle (only when project has one) */}
              {(project?.productImageUrl || batchProductFile) && (
                <button
                  onClick={() => setSkipProductImage(!skipProductImage)}
                  className={`mt-1.5 inline-flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1 rounded-lg transition-all ${
                    skipProductImage
                      ? 'bg-ed-accent/5 text-ed-accent border border-ed-accent/15'
                      : 'text-ed-ink3 hover:text-ed-ink2'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    {skipProductImage
                      ? <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                      : <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178zM15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    }
                  </svg>
                  {skipProductImage ? 'Product image skipped' : 'Skip product image'}
                </button>
              )}
            </div>

            {/* Prompt Guidelines indicator */}
            {project?.prompt_guidelines && (
              <div className="mb-3 p-2.5 bg-ed-accent/5 border border-ed-accent/10 rounded-xl">
                <p className="text-[11px] font-medium text-ed-accent mb-0.5">Prompt Guidelines Active</p>
                <p className="text-[10px] text-ed-accent/60 line-clamp-2">{project.prompt_guidelines}</p>
              </div>
            )}

            {/* Schedule toggle */}
            <div className="flex items-center gap-3 mb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isScheduled}
                  onChange={e => setIsScheduled(e.target.checked)}
                  disabled={creating}
                  className="w-4 h-4 rounded border-black/10 text-ed-accent focus:ring-ed-accent/20"
                />
                <span className="text-[12px] text-ed-ink2 font-medium">Schedule recurring</span>
              </label>
            </div>

            {/* Cron config (shown when scheduled) */}
            {isScheduled && (
              <div className="p-3 bg-ed-bg border border-black/5 rounded-xl mb-3 fade-in">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-ed-ink2 mb-1">
                      Frequency
                    </label>
                    <select
                      value={cronPreset}
                      onChange={e => setCronPreset(e.target.value)}
                      disabled={creating}
                      className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                    >
                      {CRON_PRESETS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  {cronPreset === 'custom' && (
                    <div>
                      <label className="block text-[11px] font-medium text-ed-ink2 mb-1">
                        Run every
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={INTERVAL_UNITS.find(u => u.value === intervalUnit)?.min || 1}
                          max={INTERVAL_UNITS.find(u => u.value === intervalUnit)?.max || 60}
                          value={intervalAmount}
                          onChange={e => {
                            const unit = INTERVAL_UNITS.find(u => u.value === intervalUnit);
                            const val = parseInt(e.target.value) || unit?.min || 1;
                            setIntervalAmount(Math.max(unit?.min || 1, Math.min(unit?.max || 60, val)));
                          }}
                          disabled={creating}
                          className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-20 text-center"
                        />
                        <select
                          value={intervalUnit}
                          onChange={e => {
                            setIntervalUnit(e.target.value);
                            const unit = INTERVAL_UNITS.find(u => u.value === e.target.value);
                            if (unit && intervalAmount < unit.min) setIntervalAmount(unit.min);
                            if (unit && intervalAmount > unit.max) setIntervalAmount(unit.max);
                          }}
                          disabled={creating}
                          className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent flex-1"
                        >
                          {INTERVAL_UNITS.map(u => (
                            <option key={u.value} value={u.value}>{u.label}</option>
                          ))}
                        </select>
                      </div>
                      {intervalUnit === 'weeks' && intervalAmount > 1 && (
                        <p className="text-[10px] text-ed-accent mt-1">
                          Approximated as every {intervalAmount * 7} days
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-ed-ink3 mt-2">
                  Batch will run automatically on this schedule using the template source selected above.
                </p>
              </div>
            )}

            {/* Error */}
            {createError && (
              <div className="mb-3 p-2.5 bg-ed-rust/10 border border-ed-rust/30 text-ed-rust text-[12px] rounded-xl">
                {createError}
              </div>
            )}

            {/* Submit buttons */}
            <div className="flex items-center gap-2">
              <button
                data-testid="batch-generate-button"
                onClick={handleCreate}
                disabled={creating || submittingQueue || (isScheduled && !getEffectiveCron())}
                className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[13px]"
              >
                {creating
                  ? 'Creating...'
                  : isScheduled
                    ? 'Create Scheduled Batch'
                    : `Generate ${batchSize} Ad${batchSize !== 1 ? 's' : ''}`}
              </button>
              <button
                onClick={handleAddToQueue}
                disabled={creating || submittingQueue || (isScheduled && !getEffectiveCron())}
                className="ed-ghost text-[13px]"
              >
                + Add to Queue
              </button>
            </div>

            {/* Batch Queue */}
            {queue.length > 0 && (
              <div className="mt-3 p-4 bg-ed-accent/5 border border-ed-accent/10 rounded-xl fade-in">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-[12px] font-semibold text-ed-accent uppercase tracking-wider">
                    Queue ({queue.length} batch{queue.length !== 1 ? 'es' : ''})
                  </h4>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQueue([])}
                      disabled={submittingQueue}
                      className="text-[11px] text-ed-ink3 hover:text-ed-ink2 transition-colors"
                    >
                      Clear All
                    </button>
                    <button
                      onClick={handleSubmitQueue}
                      disabled={submittingQueue}
                      className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[12px] py-1.5 px-3"
                    >
                      {submittingQueue ? 'Submitting...' : `Submit All (${queue.length})`}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {queue.map(item => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-2.5 bg-white/60 rounded-lg border border-ed-accent/10"
                    >
                      <div className="flex items-center gap-3 text-[12px]">
                        <span className="font-medium text-ed-ink">
                          {item.batch_size} image{item.batch_size !== 1 ? 's' : ''}
                        </span>
                        <span className="text-ed-ink3">{item.aspect_ratio}</span>
                        {item.templateLabel && item.templateLabel !== 'Random' && (
                          <>
                            <span className="text-ed-ink3/60">|</span>
                            <span className="badge bg-ed-accent/10 text-ed-accent text-[10px]">{item.templateLabel}</span>
                          </>
                        )}
                        {item.angle && (
                          <>
                            <span className="text-ed-ink3/60">|</span>
                            <span className="text-ed-ink2 truncate max-w-[120px]">{item.angle}</span>
                          </>
                        )}
                        {item.scheduled && item.schedule_cron && (
                          <span className="badge bg-ed-accent/10 text-ed-accent text-[10px]">
                            {cronToLabel(item.schedule_cron)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleEditQueueItem(item.id)}
                          disabled={submittingQueue}
                          className="text-[11px] text-ed-accent hover:text-ed-accent/80 transition-colors px-1.5"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleRemoveFromQueue(item.id)}
                          disabled={submittingQueue}
                          className="text-[11px] text-ed-rust hover:text-ed-rust transition-colors px-1.5"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Active Batches */}
          {loading ? (
            <div className="p-5 space-y-2">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-ed-bg/50 border border-black/5 animate-pulse">
                  <div className="w-5 h-5 rounded-full bg-ed-line flex-shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="h-3.5 w-20 bg-ed-line rounded" />
                      <div className="h-4 w-16 bg-ed-line rounded-full" />
                    </div>
                    <div className="h-2.5 w-32 bg-ed-bg rounded" />
                  </div>
                  <div className="h-6 w-12 bg-ed-bg rounded" />
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-ed-line/80">
              {activeBatches.length > 0 && (
                <div className="p-5">
                  <h4 className="text-[12px] font-semibold text-ed-ink2 uppercase tracking-wider mb-3">
                    Active
                  </h4>
                  <div className="space-y-2">
                    {activeBatches.map(batch => (
                      <BatchRow
                        key={batch.id}
                        batch={batch}
                        onRunNow={handleRunNow}
                        onCancel={handleCancel}
                        onDelete={handleDelete}
                        onEdit={handleEditBatch}
                        onPause={handlePause}
                        onResume={handleResume}
                      />
                    ))}
                  </div>
                </div>
              )}

              {completedBatches.length > 0 && (
                <div className="p-5">
                  <h4 className="text-[12px] font-semibold text-ed-ink2 uppercase tracking-wider mb-3">
                    History
                  </h4>
                  <div className="space-y-2">
                    {completedBatches.slice(0, 10).map(batch => (
                      <BatchRow
                        key={batch.id}
                        batch={batch}
                        onRunNow={handleRunNow}
                        onCancel={handleCancel}
                        onDelete={handleDelete}
                        onEdit={handleEditBatch}
                        onPause={handlePause}
                        onResume={handleResume}
                      />
                    ))}
                  </div>
                  {completedBatches.length > 10 && (
                    <p className="text-[11px] text-ed-ink3 mt-2">
                      + {completedBatches.length - 10} older batch{completedBatches.length - 10 !== 1 ? 'es' : ''}
                    </p>
                  )}
                </div>
              )}

              {batches.length === 0 && (
                <div className="p-8 text-center">
                  <p className="text-[13px] text-ed-ink2 font-medium mb-1">No Batch Jobs Yet</p>
                  <p className="text-[11px] text-ed-ink3">
                    Create a batch above to generate multiple ads at once.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

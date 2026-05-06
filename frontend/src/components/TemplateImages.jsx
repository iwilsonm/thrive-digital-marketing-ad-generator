import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';
import ConfirmDialog from './ConfirmDialog';
import { useAsyncData } from '../hooks/useAsyncData';

const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // matches multer's 20 MB limit on the backend
const HARD_CAP_FILES = 1000;             // defensive ceiling against a stray "select all" of a Pictures folder
const UPLOAD_CONCURRENCY = 5;            // sliding-window: 5 in flight at any time

function getScrollbarWidth() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth);
}

function normalizeTemplateTags(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map(t => String(t || '').trim()).filter(Boolean))];
}

function templateHasTag(template, tag) {
  if (!tag) return true;
  const normalized = String(tag).trim().toLowerCase();
  return normalizeTemplateTags(template?.tags).some(t => t.toLowerCase() === normalized);
}

/**
 * Templates tab — direct multi-file upload (no Google Drive sync).
 * Up to 500 files at a time (HARD_CAP_FILES is the absolute ceiling), 5 in parallel.
 */
export default function TemplateImages({ projectId }) {
  const { data: project, setData: setProject, refetch: refetchProject } = useAsyncData(
    () => api.getProject(projectId),
    [projectId],
    { initialData: null }
  );

  // Uploaded templates (the only source — Drive sync was dropped)
  const { data: templates, setData: setTemplates, loading: loadingTemplates, refetch: refetchTemplates } = useAsyncData(
    () => api.getTemplates(projectId, { includeArchived: true }).then(d => d.templates || []),
    [projectId]
  );

  // Batch upload state
  const [batch, setBatch] = useState(null); // { total, completed, succeeded, failed: [{ name, reason }] }
  const abortRef = useRef(null);

  // Shared
  const [error, setError] = useState('');
  const [viewImage, setViewImage] = useState(null);
  const [editingDesc, setEditingDesc] = useState(null);
  const [descValue, setDescValue] = useState('');
  const [savingDescId, setSavingDescId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [pendingDeleteImage, setPendingDeleteImage] = useState(null);
  const [selectedTemplateTag, setSelectedTemplateTag] = useState('');
  const [retryingSeed, setRetryingSeed] = useState(false);
  const fileInputRef = useRef(null);

  const uploading = !!batch && batch.completed < batch.total;
  const activeTemplates = useMemo(() => (templates || []).filter(t => !t.archived_at), [templates]);
  const archivedTemplates = useMemo(() => (templates || []).filter(t => t.archived_at), [templates]);
  const templateTags = useMemo(() => {
    return [...new Set((templates || []).flatMap(t => normalizeTemplateTags(t.tags)))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [templates]);
  const filteredActiveTemplates = useMemo(
    () => activeTemplates.filter(t => templateHasTag(t, selectedTemplateTag)),
    [activeTemplates, selectedTemplateTag]
  );
  const filteredArchivedTemplates = useMemo(
    () => archivedTemplates.filter(t => templateHasTag(t, selectedTemplateTag)),
    [archivedTemplates, selectedTemplateTag]
  );

  useEffect(() => {
    if (!viewImage || typeof document === 'undefined') return undefined;

    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = getScrollbarWidth();

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, [viewImage]);

  const handleBatchUpload = useCallback(async (rawFiles) => {
    setError('');
    const incoming = Array.from(rawFiles || []);
    if (incoming.length === 0) return;

    // Filter & collect skip reasons up front so the user sees rejections immediately.
    const accepted = [];
    const skipped = [];
    for (const f of incoming) {
      if (accepted.length >= HARD_CAP_FILES) {
        skipped.push({ name: f.name, reason: `over ${HARD_CAP_FILES}-file cap` });
        continue;
      }
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) {
        skipped.push({ name: f.name, reason: 'unsupported format' });
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        skipped.push({ name: f.name, reason: 'exceeds 20 MB limit' });
        continue;
      }
      accepted.push(f);
    }

    if (accepted.length === 0) {
      setBatch({ total: skipped.length, completed: skipped.length, succeeded: 0, failed: skipped });
      return;
    }

    const total = accepted.length + skipped.length;
    setBatch({ total, completed: skipped.length, succeeded: 0, failed: [...skipped] });

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    let cursor = 0;
    const next = () => (cursor < accepted.length ? accepted[cursor++] : null);

    const worker = async () => {
      while (!signal.aborted) {
        const file = next();
        if (!file) return;
        try {
          const created = await api.uploadTemplate(projectId, file, { signal });
          // Incremental gallery append — user watches the library fill up.
          setTemplates(prev => (prev ? [created, ...prev] : [created]));
          setBatch(b => b && { ...b, completed: b.completed + 1, succeeded: b.succeeded + 1 });
        } catch (err) {
          if (err?.name === 'AbortError' || signal.aborted) return; // silent on user cancel
          setBatch(b => b && {
            ...b,
            completed: b.completed + 1,
            failed: [...b.failed, { name: file.name, reason: err.message || 'upload failed' }]
          });
        }
      }
    };

    const workerCount = Math.min(UPLOAD_CONCURRENCY, accepted.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    abortRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [projectId, setTemplates]);

  const handleCancelUpload = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const handleDismissBatchSummary = useCallback(() => setBatch(null), []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) handleBatchUpload(e.dataTransfer.files);
  }, [handleBatchUpload]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!uploading) setDragOver(true);
  }, [uploading]);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDelete = async () => {
    if (!pendingDeleteImage) return;
    try {
      await api.deleteTemplate(projectId, pendingDeleteImage.id);
      setTemplates(prev => (prev || []).filter(t => t.id !== pendingDeleteImage.id));
      if (viewImage?.id === pendingDeleteImage.id) setViewImage(null);
      setPendingDeleteImage(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveDesc = async (imageId) => {
    setSavingDescId(imageId);
    try {
      await api.updateTemplate(projectId, imageId, descValue);
      setTemplates(prev => (prev || []).map(t => t.id === imageId ? { ...t, description: descValue } : t));
      setEditingDesc(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingDescId(null);
    }
  };

  const updateTemplateLocal = (imageId, fields) => {
    setTemplates(prev => (prev || []).map(t => t.id === imageId ? { ...t, ...fields } : t));
  };

  const handleAddTag = async (tmpl) => {
    const tag = window.prompt('Add template tag');
    const nextTags = normalizeTemplateTags([...(tmpl.tags || []), tag]);
    if (!tag || nextTags.length === (tmpl.tags || []).length) return;
    try {
      const updated = await api.updateTemplate(projectId, tmpl.id, { tags: nextTags });
      updateTemplateLocal(tmpl.id, updated);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveTag = async (tmpl, tag) => {
    const nextTags = normalizeTemplateTags(tmpl.tags || []).filter(t => t !== tag);
    try {
      const updated = await api.updateTemplate(projectId, tmpl.id, { tags: nextTags });
      updateTemplateLocal(tmpl.id, updated);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleArchive = async (tmpl) => {
    try {
      const updated = await api.updateTemplate(projectId, tmpl.id, { archived_at: new Date().toISOString() });
      updateTemplateLocal(tmpl.id, updated);
      if (viewImage?.id === tmpl.id) setViewImage(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUnarchive = async (tmpl) => {
    try {
      const updated = await api.updateTemplate(projectId, tmpl.id, { archived_at: null });
      updateTemplateLocal(tmpl.id, updated);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRetryTemplateSeeding = async () => {
    setRetryingSeed(true);
    setError('');
    try {
      const result = await api.adoptSharedTemplates(projectId);
      setProject(prev => ({
        ...(prev || {}),
        template_seeding_status: result.status || (result.failed?.length ? 'failed' : 'complete'),
        template_seeding_error: result.failed?.length
          ? `${result.failed.length} template${result.failed.length === 1 ? '' : 's'} could not be copied.`
          : (result.warning || ''),
      }));
      await Promise.all([refetchTemplates(), refetchProject()]);
    } catch (err) {
      setError(err.message || 'Template inheritance retry failed.');
      await refetchProject();
    } finally {
      setRetryingSeed(false);
    }
  };

  if (loadingTemplates) {
    return <div className="text-ed-ink3 text-center py-8 animate-pulse text-sm">Loading templates...</div>;
  }

  const progressPct = batch && batch.total > 0 ? Math.round((batch.completed / batch.total) * 100) : 0;
  const batchDone = !!batch && batch.completed >= batch.total;

  return (
    <div className="space-y-6">
      {/* Error */}
      {error && (
        <div className="p-3 bg-ed-rust/10 border border-ed-rust/20 text-ed-rust text-[13px] rounded-xl">
          {error}
        </div>
      )}

      {project && project.template_seeding_status && project.template_seeding_status !== 'complete' && (
        <div className="p-4 rounded-xl border border-ed-accent/20 bg-ed-accent/5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[13px] font-semibold text-ed-ink">
              {project.template_seeding_status === 'in_progress'
                ? 'Template inheritance is running'
                : project.template_seeding_status === 'pending'
                  ? 'Template inheritance is pending'
                  : 'Template inheritance needs attention'}
            </p>
            <p className="text-[12px] text-ed-ink3 mt-0.5">
              {project.template_seeding_status === 'failed'
                ? (project.template_seeding_error || 'Some templates could not be copied into this project. Retry to copy any missing templates.')
                : 'New projects copy templates from existing projects once. This library will become independent after the copy finishes.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleRetryTemplateSeeding}
            disabled={retryingSeed}
            className="ed-ghost text-[12px] px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {retryingSeed ? 'Retrying...' : 'Retry inheritance'}
          </button>
        </div>
      )}

      {/* ===== Templates ===== */}
      <div className="ed-card p-6">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight mb-0.5 flex items-center gap-1">
              Templates
              <InfoTooltip text="Reference ad images used as style guides for AI ad generation. Upload up to 500 at a time." position="right" />
            </h3>
            <p className="text-[12px] text-ed-ink3">
              {activeTemplates.length} active template{activeTemplates.length !== 1 ? 's' : ''} uploaded
              {archivedTemplates.length > 0 ? ` · ${archivedTemplates.length} archived` : ''}
            </p>
          </div>
          <div className="flex flex-col gap-1 md:items-end">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="template-tag-filter" className="text-[10px] uppercase tracking-[0.08em] text-ed-ink3 font-medium">
                Filter by tag
              </label>
              <select
                id="template-tag-filter"
                value={selectedTemplateTag}
                onChange={(e) => setSelectedTemplateTag(e.target.value)}
                disabled={templateTags.length === 0}
                className="text-[12px] text-ed-ink bg-ed-surface border border-ed-line rounded-lg px-2 py-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {templateTags.length === 0 ? (
                  <option value="">No tags yet</option>
                ) : (
                  <>
                    <option value="">All tags</option>
                    {templateTags.map(tag => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </>
                )}
              </select>
              {selectedTemplateTag && (
                <button
                  type="button"
                  onClick={() => setSelectedTemplateTag('')}
                  className="ed-ghost text-[11px] px-2.5 py-1"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-[10px] text-ed-ink3">
              Create tags by clicking Tag on any uploaded template.
            </p>
          </div>
        </div>

        {/* Upload area */}
        <div
          onClick={() => !uploading && fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-5 text-center transition-all mb-4 ${
            uploading ? 'border-black/10 bg-ed-bg cursor-default' :
            dragOver ? 'border-ed-accent bg-ed-accent/5 cursor-pointer' :
            'border-black/10 hover:border-ed-accent hover:bg-ed-bg cursor-pointer'
          }`}
        >
          {batch ? (
            <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-ed-ink2 font-medium">
                  {uploading ? 'Uploading…' : 'Upload complete'}
                </span>
                <span className="text-ed-ink3">
                  {batch.completed} of {batch.total}
                  {batch.failed.length > 0 && <> · <span className="text-ed-rust">{batch.failed.length} failed</span></>}
                </span>
              </div>
              <div className="h-1.5 w-full bg-black/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-ed-accent transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                {uploading ? (
                  <button onClick={handleCancelUpload} className="ed-ghost text-[12px]">Cancel</button>
                ) : (
                  <button onClick={handleDismissBatchSummary} className="ed-ghost text-[12px]">Dismiss</button>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="w-8 h-8 mx-auto mb-2 rounded-lg bg-ed-bg flex items-center justify-center">
                <svg className="w-4 h-4 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              </div>
              <p className={`text-[13px] font-medium ${dragOver ? 'text-ed-accent' : 'text-ed-ink2'}`}>
                {dragOver ? 'Drop images here' : 'Drop up to 500 template images here, or click to browse'}
              </p>
              <p className="text-[10px] text-ed-ink3 mt-0.5">JPG, PNG, WebP, or GIF — up to 20 MB each</p>
            </div>
          )}
        </div>

        {/* Failure summary (only when batch is done AND there are failures) */}
        {batch && batchDone && batch.failed.length > 0 && (
          <div className="mb-4 p-3 bg-ed-rust/10 border border-ed-rust/20 rounded-xl">
            <p className="text-[12px] font-medium text-ed-rust mb-1.5">
              {batch.failed.length} file{batch.failed.length !== 1 ? 's' : ''} failed
            </p>
            <ul className="text-[11px] text-ed-rust space-y-0.5 max-h-40 overflow-y-auto">
              {batch.failed.map((f, i) => (
                <li key={i} className="truncate" title={`${f.name} — ${f.reason}`}>
                  <span className="font-medium">{f.name}</span> — {f.reason}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-ed-rust mt-1.5">To retry, re-select these files and upload again.</p>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.gif"
          multiple
          onChange={e => { if (e.target.files?.length) handleBatchUpload(e.target.files); }}
          className="hidden"
        />

        {/* Templates grid */}
        {activeTemplates.length === 0 ? (
          <div className="text-center py-2">
            <p className="text-[11px] text-ed-ink3">
              Upload reference ads you want the AI to use as style guides.
            </p>
          </div>
        ) : filteredActiveTemplates.length === 0 ? (
          <div className="text-center py-2">
            <p className="text-[11px] text-ed-ink3">
              No active templates match “{selectedTemplateTag}”.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {filteredActiveTemplates.map(tmpl => (
              <div
                key={tmpl.id}
                className="group ed-card overflow-hidden transition-all duration-300"
              >
                <div
                  className="aspect-square bg-ed-bg cursor-pointer"
                  onClick={() => setViewImage(tmpl)}
                >
                  <img
                    src={tmpl.thumbnailUrl}
                    alt={tmpl.filename}
                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                    loading="lazy"
                  />
                </div>
                <div className="p-2.5">
                  <p className="text-[11px] text-ed-ink font-medium truncate" title={tmpl.filename}>
                    {tmpl.filename}
                  </p>
                  {editingDesc === tmpl.id ? (
                    <div className="mt-1 space-y-2">
                      <input
                        value={descValue}
                        onChange={e => setDescValue(e.target.value)}
                        className="flex-1 text-[11px] w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08] py-1 px-2"
                        placeholder="Add description..."
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveDesc(tmpl.id);
                          if (e.key === 'Escape') setEditingDesc(null);
                        }}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleSaveDesc(tmpl.id)}
                          disabled={savingDescId === tmpl.id}
                          className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[11px] px-3 py-1 disabled:opacity-50"
                        >
                          {savingDescId === tmpl.id ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingDesc(null)}
                          disabled={savingDescId === tmpl.id}
                          className="ed-ghost text-[11px] px-3 py-1 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p
                      className="text-[11px] text-ed-ink3 mt-0.5 cursor-pointer hover:text-ed-ink2 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingDesc(tmpl.id);
                        setDescValue(tmpl.description || '');
                      }}
                    >
                      {tmpl.description || 'Click to add description...'}
                    </p>
                  )}
                  {normalizeTemplateTags(tmpl.tags).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {normalizeTemplateTags(tmpl.tags).map(tag => (
                        <span key={tag} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-ed-accent/10 text-ed-accent text-[9px] font-medium">
                          {tag}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleRemoveTag(tmpl, tag); }}
                            className="text-ed-accent/70 hover:text-ed-accent"
                            aria-label={`Remove ${tag} tag`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-1.5 mt-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleAddTag(tmpl); }}
                      className="action-link text-center justify-center rounded-md border border-ed-line/70 px-2 py-1"
                    >
                      Tag
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingDesc(tmpl.id);
                        setDescValue(tmpl.description || '');
                      }}
                      className="action-link text-center justify-center rounded-md border border-ed-line/70 px-2 py-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleArchive(tmpl); }}
                      className="action-link text-center justify-center rounded-md border border-ed-line/70 px-2 py-1"
                    >
                      Archive
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setPendingDeleteImage(tmpl); }}
                      className="action-link-danger text-center justify-center rounded-md border border-ed-rust/20 px-2 py-1"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {archivedTemplates.length > 0 && (
        <details className="ed-card p-6">
          <summary className="cursor-pointer text-[14px] font-serif font-[420] text-ed-ink">
            Archived Templates ({selectedTemplateTag ? filteredArchivedTemplates.length : archivedTemplates.length})
          </summary>
          <p className="text-[11px] text-ed-ink3 mt-1 mb-4">
            Archived templates are hidden from new generation until restored.
          </p>
          {filteredArchivedTemplates.length === 0 ? (
            <p className="text-[11px] text-ed-ink3">
              No archived templates match “{selectedTemplateTag}”.
            </p>
          ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {filteredArchivedTemplates.map(tmpl => (
              <div key={tmpl.id} className="ed-card overflow-hidden opacity-80">
                <div className="aspect-square bg-ed-bg cursor-pointer" onClick={() => setViewImage(tmpl)}>
                  <img src={tmpl.thumbnailUrl} alt={tmpl.filename} className="w-full h-full object-cover" loading="lazy" />
                </div>
                <div className="p-2.5">
                  <p className="text-[11px] text-ed-ink font-medium truncate" title={tmpl.filename}>{tmpl.filename}</p>
                  <p className="text-[10px] text-ed-ink3 mt-0.5">
                    Archived {tmpl.archived_at ? new Date(tmpl.archived_at).toLocaleDateString() : ''}
                  </p>
                  <div className="mt-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleUnarchive(tmpl); }}
                      className="action-link text-center justify-center rounded-md border border-ed-line/70 px-2 py-1 w-full"
                    >
                      Unarchive
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          )}
        </details>
      )}

      {/* Full-size image modal */}
      {viewImage && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setViewImage(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] bg-ed-surface rounded-2xl overflow-hidden shadow-card-hover fade-in"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-ed-line/60">
              <div>
                <p className="text-[14px] font-serif font-[420] text-ed-ink">{viewImage.filename || viewImage.name}</p>
                {viewImage.description && (
                  <p className="text-[12px] text-ed-ink2">{viewImage.description}</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPendingDeleteImage(viewImage)}
                  className="action-link-danger"
                >
                  Delete
                </button>
                <button
                  onClick={() => setViewImage(null)}
                  className="w-7 h-7 rounded-lg bg-black/5 flex items-center justify-center text-ed-ink3 hover:text-ed-ink2 hover:bg-black/10 transition-all"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="p-2 flex items-center justify-center bg-ed-bg" style={{ maxHeight: 'calc(90vh - 80px)' }}>
              <img
                src={viewImage.thumbnailUrl}
                alt={viewImage.name || viewImage.filename}
                className="max-w-full max-h-[80vh] object-contain rounded-xl"
              />
            </div>
          </div>
        </div>,
        document.body
      )}
      <ConfirmDialog
        open={!!pendingDeleteImage}
        title="Delete template image?"
        message="This removes the uploaded template image permanently. This action cannot be undone."
        confirmLabel="Delete Image"
        onCancel={() => setPendingDeleteImage(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

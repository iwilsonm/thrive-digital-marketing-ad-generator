import { useState, useEffect, useRef } from 'react';
import { api, invalidateProjectCache } from '../api';
import DragDropUpload from './DragDropUpload';
import InfoTooltip from './InfoTooltip';
import PipelineProgress from './PipelineProgress';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import { useSSEStream } from '../hooks/useSSEStream';

const DOC_LABELS = {
  research: 'Research Document',
  avatar: 'Avatar Sheet',
  offer_brief: 'Offer Brief',
  necessary_beliefs: 'Necessary Beliefs'
};

const DOC_ORDER = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'Z'); // SQLite stores UTC without timezone suffix
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  // Show relative time for recent updates
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  // Show date for older items
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

const SOURCE_LABELS = {
  uploaded: { label: 'Uploaded', color: 'bg-ed-accent/10 text-ed-accent' },
  generated: { label: 'Generated', color: 'bg-ed-accent/10 text-ed-accent' },
  manual_research: { label: 'Manual Research', color: 'bg-ed-green/10 text-ed-green' }
};

// ─── Relative time helper for correction history ─────────────────────────────
function timeAgo(timestamp) {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Copy Correction Bar ──────────────────────────────────────────────────────
function CopyCorrection({ projectId, onDocsUpdated, onCorrectionApplied }) {
  const [correction, setCorrection] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!correction.trim()) return;
    setSearching(true);
    setError('');
    setResults(null);
    try {
      const data = await api.correctDocs(projectId, correction.trim());
      setResults(data);
    } catch (err) {
      setError(err.message || 'Failed to analyze documents');
    } finally {
      setSearching(false);
    }
  };

  const handleApply = async () => {
    if (!results?.corrections?.length) return;
    setApplying(true);
    setError('');
    try {
      console.log('[CopyCorrection] Applying', results.corrections.length, 'corrections...');
      const resp = await api.applyCorrections(projectId, results.corrections, correction.trim());
      console.log('[CopyCorrection] Apply response:', resp);
      await onDocsUpdated();
      onCorrectionApplied?.();
      setResults(null);
      setCorrection('');
      setError('');
    } catch (err) {
      console.error('[CopyCorrection] Apply failed:', err);
      setError(err.message || 'Failed to apply corrections');
    } finally {
      setApplying(false);
    }
  };

  const handleCancel = () => {
    setResults(null);
    setError('');
    inputRef.current?.focus();
  };

  return (
    <div className="bg-ed-accent/5 border border-ed-accent/15 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded-md bg-ed-accent/10 flex items-center justify-center flex-shrink-0">
          <svg className="w-3.5 h-3.5 text-ed-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </div>
        <span className="text-[13px] font-serif font-[420] text-ed-ink">Fix Inaccurate Info</span>
        <InfoTooltip text="Noticed wrong claims in your ad copy? Describe the correction here and AI will scan all foundational documents to find and fix the source." position="right" />
      </div>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          ref={inputRef}
          value={correction}
          onChange={e => setCorrection(e.target.value)}
          placeholder='e.g. "We offer a lifetime warranty, not 90-day"'
          disabled={searching}
          className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[13px] py-1.5 flex-1"
        />
        <button
          type="submit"
          disabled={!correction.trim() || searching}
          className="px-3 py-1.5 rounded-[7px] text-[12px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-30 whitespace-nowrap"
        >
          {searching ? (
            <span className="flex items-center gap-1.5">
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Scanning...
            </span>
          ) : 'Find & Fix'}
        </button>
      </form>

      {/* Error */}
      {error && (
        <p className="text-[12px] text-ed-rust mt-2">{error}</p>
      )}

      {/* Results preview */}
      {results && (
        <div className="mt-3">
          {results.corrections.length > 0 ? (
            <>
              <p className="text-[12px] font-medium text-ed-ink mb-2">{results.message}</p>
              <div className="space-y-2">
                {results.corrections.map((c, i) => (
                  <div key={i} className="bg-ed-surface rounded-lg border border-ed-line p-3">
                    <p className="text-[11px] font-serif font-[420] text-ed-ink2 uppercase tracking-wider mb-1.5">
                      {c.doc_label}
                    </p>
                    <div className="space-y-1">
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-medium text-ed-rust mt-0.5 flex-shrink-0">OLD</span>
                        <p className="text-[12px] text-ed-rust bg-ed-rust/10 rounded px-2 py-1 line-through">{c.old_text}</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-medium text-ed-green mt-0.5 flex-shrink-0">NEW</span>
                        <p className="text-[12px] text-ed-green bg-ed-green/5 rounded px-2 py-1">{c.new_text}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={handleApply}
                  disabled={applying}
                  className="px-4 py-1.5 rounded-[7px] text-[12px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
                >
                  {applying ? 'Applying...' : `Apply ${results.corrections.length === 1 ? 'Correction' : 'All Corrections'}`}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={applying}
                  className="ed-ghost text-[12px] px-3 py-1.5 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="text-[12px] text-ed-ink2 mt-1">{results.message || 'No matching claims found in any document. Try rephrasing your correction.'}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Changelog — Standalone correction history below doc cards ────────────────
function Changelog({ projectId, onDocsUpdated, refreshKey }) {
  const { data: history, loading, refetch: loadHistory } = useAsyncData(
    () => api.getCorrectionHistory(projectId).then(d => d.history || []).catch(() => []),
    [projectId, refreshKey]
  );
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [reverting, setReverting] = useState(null);
  const [pendingRevertId, setPendingRevertId] = useState(null);

  const handleRevert = async (entryId) => {
    setReverting(entryId);
    try {
      await api.revertCorrection(projectId, entryId);
      await onDocsUpdated();
      await loadHistory();
    } catch {
      // silently fail — the revert button stays enabled
    } finally {
      setReverting(null);
      setPendingRevertId(null);
    }
  };

  if (loading) return null;

  return (
    <div className="ed-card p-5">
      <div
        className={`flex items-center gap-2 ${history.length > 0 ? 'cursor-pointer' : ''}`}
        onClick={() => history.length > 0 && setOpen(!open)}
      >
        {history.length > 0 && (
          <svg
            className={`w-4 h-4 text-ed-ink3 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        )}
        <div className="w-7 h-7 rounded-lg bg-ed-bg flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-ed-ink2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div>
          <h3 className="text-[14px] font-serif font-[420] text-ed-ink tracking-tight">Changelog</h3>
          <p className="text-[11px] text-ed-ink3">
            {history.length === 0
              ? 'No changes recorded yet — edits and AI fixes will appear here'
              : `${history.length} change${history.length !== 1 ? 's' : ''} recorded`}
          </p>
        </div>
      </div>

      {open && history.length > 0 && (
        <div className="mt-4 border border-ed-line/60 rounded-xl overflow-hidden fade-in">
          <div className="max-h-[500px] overflow-y-auto divide-y divide-gray-100">
            {history.map((entry) => {
              const isExpanded = expandedId === entry.id;
              const changeCount = entry.changes?.length || 0;
              return (
                <div key={entry.id} className="px-4 py-3 hover:bg-ed-bg/50 transition-colors">
                  {/* Entry header */}
                  <div
                    className="flex items-center gap-2.5 cursor-pointer group"
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  >
                    <svg
                      className={`w-3.5 h-3.5 text-ed-ink3 flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[13px] text-ed-ink group-hover:text-ed-ink font-medium transition-colors">
                          {entry.correction}
                        </p>
                        {entry.manual ? (
                          <span className="text-[9px] font-semibold uppercase tracking-wider bg-ed-accent/10 text-ed-accent px-1.5 py-0.5 rounded flex-shrink-0">Edit</span>
                        ) : (
                          <span className="text-[9px] font-semibold uppercase tracking-wider bg-ed-accent/10 text-ed-accent px-1.5 py-0.5 rounded flex-shrink-0">AI Fix</span>
                        )}
                      </div>
                      <p className="text-[11px] text-ed-ink3 mt-0.5">
                        {changeCount} doc{changeCount !== 1 ? 's' : ''} changed
                        {' · '}
                        {new Date(entry.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        {' at '}
                        {new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        <span className="text-ed-ink3/60 ml-1">({timeAgo(entry.timestamp)})</span>
                      </p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setPendingRevertId(entry.id); }}
                      disabled={reverting === entry.id}
                      className="action-link-danger disabled:opacity-50 flex-shrink-0"
                    >
                      {reverting === entry.id ? 'Reverting...' : 'Revert'}
                    </button>
                  </div>

                  {/* Expanded diff */}
                  {isExpanded && entry.changes?.length > 0 && (
                    <div className="mt-3 ml-6 space-y-2 fade-in">
                      {entry.changes.map((change, i) => (
                        <div key={i} className="bg-ed-surface rounded-lg border border-ed-line/60 p-3">
                          <p className="text-[11px] font-serif font-[420] text-ed-ink2 uppercase tracking-wider mb-1.5">
                            {change.doc_label || change.doc_type}
                          </p>
                          <div className="space-y-1">
                            <div className="flex items-start gap-2">
                              <span className="text-[10px] font-medium text-ed-rust mt-0.5 flex-shrink-0">OLD</span>
                              <p className="text-[12px] text-ed-rust bg-ed-rust/10 rounded px-2 py-1 line-through">{change.old_text}</p>
                            </div>
                            <div className="flex items-start gap-2">
                              <span className="text-[10px] font-medium text-ed-green mt-0.5 flex-shrink-0">NEW</span>
                              <p className="text-[12px] text-ed-green bg-ed-green/5 rounded px-2 py-1">{change.new_text}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!pendingRevertId}
        title="Revert this correction?"
        message="This restores the foundational documents to the state they were in before the selected correction was applied."
        confirmLabel="Revert Correction"
        busy={!!reverting}
        onCancel={() => setPendingRevertId(null)}
        onConfirm={() => handleRevert(pendingRevertId)}
      />
    </div>
  );
}

export default function FoundationalDocs({ projectId, projectStatus, onDocsChanged }) {
  const toast = useToast();
  const { data: docsData, setData: setDocsData, loading, refetch: loadDocs } = useAsyncData(
    () => api.getDocs(projectId),
    [projectId],
    { initialData: { docs: [], steps: [] } }
  );
  const docs = docsData.docs || [];
  const steps = docsData.steps || [];
  const [changelogRefreshKey, setChangelogRefreshKey] = useState(0);

  // Generation mode: null | 'manual' | 'upload'
  const [generationMode, setGenerationMode] = useState(null);

  // Generation state (shared by auto & manual)
  const { streaming: generating, startStream, cancelStream } = useSSEStream();
  const [currentStep, setCurrentStep] = useState(null);
  const [streamContent, setStreamContent] = useState('');
  const [completedSteps, setCompletedSteps] = useState(new Set());
  const [genError, setGenError] = useState('');

  // Progress bar state
  const [genProgress, setGenProgress] = useState(0);
  const [genProgressMsg, setGenProgressMsg] = useState('');
  const genStartTimeRef = useRef(null);

  // Step-weighted progress: deep research (step 4) takes ~80% of time
  const STEP_PROGRESS = { 1: 2, 2: 4, 3: 6, 4: 8, 5: 55, 6: 70, 7: 82, 8: 92 };
  const STEP_LABELS = {
    1: 'Analyzing sales page...', 2: 'Extracting product claims...', 3: 'Generating research prompt...',
    4: 'Deep research in progress...', 5: 'Synthesizing avatar...', 6: 'Writing offer brief...',
    7: 'Training on methodology...', 8: 'Developing belief documents...',
  };

  // Manual research flow state
  const [manualStep, setManualStep] = useState(1); // 1=prompts, 2=upload, 3=generating
  const [researchPrompts, setResearchPrompts] = useState(null);
  const [manualResearchText, setManualResearchText] = useState('');
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [expandedPrompt, setExpandedPrompt] = useState(null);
  const [copiedPrompt, setCopiedPrompt] = useState(null);

  // Direct upload flow state
  const [uploadDocs, setUploadDocs] = useState({
    research: '',
    avatar: '',
    offer_brief: '',
    necessary_beliefs: ''
  });
  const [savingUpload, setSavingUpload] = useState(false);

  // Editing state
  const [editingDoc, setEditingDoc] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Viewing state
  const [viewDoc, setViewDoc] = useState(null);

  // Regeneration state
  const [regenerating, setRegenerating] = useState(null);
  const [showRemoveAllConfirm, setShowRemoveAllConfirm] = useState(false);
  const [removingDocs, setRemovingDocs] = useState(false);

  const streamRef = useRef(null);

  // Auto-scroll stream content
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamContent]);

  // --- Choice screen handlers ---

  const handleGenerateClick = () => {
    setGenError('');
    handleChooseManual();
  };

  const refreshDocsForDisplay = async () => {
    invalidateProjectCache(projectId);
    const refreshed = await api.getDocs(projectId);
    setDocsData(refreshed);
    await onDocsChanged?.();
    return refreshed;
  };

  const handleChooseManual = async () => {
    setGenerationMode('manual');
    setManualStep(1);
    setManualResearchText('');
    setLoadingPrompts(true);
    setExpandedPrompt(null);
    try {
      const data = await api.getResearchPrompts(projectId);
      setResearchPrompts(data.prompts);
    } catch (err) {
      setGenError('Failed to load research prompts: ' + err.message);
      setGenerationMode(null);
    } finally {
      setLoadingPrompts(false);
    }
  };

  const handleBackToChoice = () => {
    handleBackToList();
  };

  const handleBackToList = () => {
    setGenerationMode(null);
    setManualStep(1);
    setManualResearchText('');
    setResearchPrompts(null);
  };

  // --- Direct upload handlers ---

  const handleChooseUpload = () => {
    setGenerationMode('upload');
    setUploadDocs({ research: '', avatar: '', offer_brief: '', necessary_beliefs: '' });
    setGenError('');
  };

  const handleSaveUploadedDocs = async () => {
    // At minimum, need research doc
    const filledDocs = Object.entries(uploadDocs).filter(([, v]) => v.trim().length > 0);
    if (filledDocs.length === 0) {
      setGenError('Please provide content for at least one document.');
      return;
    }

    setSavingUpload(true);
    setGenError('');
    try {
      await api.uploadDocs(projectId, uploadDocs);
      setGenerationMode(null);
      setUploadDocs({ research: '', avatar: '', offer_brief: '', necessary_beliefs: '' });
      invalidateProjectCache(projectId);
      loadDocs();
      onDocsChanged?.();
    } catch (err) {
      setGenError(err.message);
    } finally {
      setSavingUpload(false);
    }
  };

  // --- Copy prompt to clipboard ---

  const handleCopyPrompt = async (index, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPrompt(index);
      setTimeout(() => setCopiedPrompt(null), 2000);
    } catch {
      // Fallback: select text in a textarea
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopiedPrompt(index);
      setTimeout(() => setCopiedPrompt(null), 2000);
    }
  };

  // --- Manual generation (Steps 5-8 only) ---

  const handleManualGenerate = () => {
    setManualStep(3);
    setGenError('');
    setStreamContent('');
    setCurrentStep(null);
    setCompletedSteps(new Set([1, 2, 3, 4])); // Steps 1-4 already done manually
    setGenProgress(50); // Start at 50% since steps 1-4 are done
    setGenProgressMsg('Starting synthesis...');
    genStartTimeRef.current = Date.now();

    startStream(() => api.generateDocsManual(projectId, manualResearchText, (event) => {
      switch (event.type) {
        case 'step_start':
          setCurrentStep(event);
          setStreamContent('');
          if (STEP_PROGRESS[event.step] !== undefined) {
            setGenProgress(prev => Math.max(prev, STEP_PROGRESS[event.step]));
          }
          setGenProgressMsg(STEP_LABELS[event.step] || event.label || '');
          break;
        case 'chunk':
          setStreamContent(prev => prev + event.text);
          break;
        case 'step_complete':
          setCompletedSteps(prev => new Set([...prev, event.step]));
          if (event.savedAs) loadDocs();
          if (STEP_PROGRESS[event.step] !== undefined) {
            const nextStep = event.step + 1;
            const nextVal = STEP_PROGRESS[nextStep] || (STEP_PROGRESS[event.step] + 5);
            setGenProgress(prev => Math.max(prev, nextVal - 1));
          }
          break;
        case 'error':
          setGenError(event.message);
          break;
      }
    })).then(() => {
      setGenProgress(100);
      setGenProgressMsg('Complete');
      setTimeout(async () => {
        try {
          await refreshDocsForDisplay();
          setCurrentStep(null);
          setGenerationMode(null);
          setManualStep(1);
          setManualResearchText('');
          setGenProgress(0);
          genStartTimeRef.current = null;
        } catch (err) {
          setGenError(`Documents were generated, but the page could not refresh them: ${err.message}`);
        }
      }, 500);
    }).catch(err => {
      if (err.name !== 'AbortError') setGenError(err.message);
    });
  };

  const handleCancel = () => {
    cancelStream();
    setGenerationMode(null);
    setManualStep(1);
  };

  // --- Regeneration ---

  const handleRegenerate = (docType) => {
    setRegenerating(docType);
    setGenError('');
    setStreamContent('');
    setCurrentStep(null);
    setCompletedSteps(new Set());

    startStream(() => api.regenerateDoc(projectId, docType, (event) => {
      switch (event.type) {
        case 'step_start':
          setCurrentStep(event);
          setStreamContent('');
          break;
        case 'chunk':
          setStreamContent(prev => prev + event.text);
          break;
        case 'step_complete':
          setCompletedSteps(prev => new Set([...prev, event.step]));
          break;
        case 'error':
          setGenError(event.message);
          break;
      }
    })).then(() => {
      setRegenerating(null);
      setCurrentStep(null);
      loadDocs();
    }).catch(err => {
      if (err.name !== 'AbortError') setGenError(err.message);
      setRegenerating(null);
    });
  };

  // --- Editing & Approval ---

  const handleEdit = (doc) => {
    setEditingDoc(doc);
    setEditContent(doc.content);
    setViewDoc(null);
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      await api.updateDoc(projectId, editingDoc.id, editContent);
      setEditingDoc(null);
      loadDocs();
      setChangelogRefreshKey(k => k + 1);
      toast.success('Document saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (doc) => {
    try {
      await api.approveDoc(projectId, doc.id);
      loadDocs();
      toast.success('Document approved');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleRemoveAllDocs = async () => {
    setRemovingDocs(true);
    setGenError('');
    try {
      const result = await api.deleteDocs(projectId);
      setViewDoc(null);
      setEditingDoc(null);
      setGenerationMode(null);
      setDocsData(prev => ({ ...(prev || {}), docs: [] }));
      invalidateProjectCache(projectId);
      await loadDocs();
      await onDocsChanged?.();
      toast.success(
        result?.deleted
          ? `Removed ${result.deleted} foundational document${result.deleted === 1 ? '' : 's'}`
          : 'Foundational documents removed'
      );
    } catch (err) {
      toast.error(err.message || 'Failed to remove foundational documents');
    } finally {
      setRemovingDocs(false);
      setShowRemoveAllConfirm(false);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="ed-card p-5 animate-pulse">
            <div className="flex items-start justify-between mb-2">
              <div className="h-4 w-32 bg-ed-line rounded" />
              <div className="h-5 w-16 bg-ed-line rounded-full" />
            </div>
            <div className="h-3 w-20 bg-ed-bg rounded mb-2" />
            <div className="space-y-1.5">
              <div className="h-2.5 w-full bg-ed-bg rounded" />
              <div className="h-2.5 w-3/4 bg-ed-bg rounded" />
              <div className="h-2.5 w-5/6 bg-ed-bg rounded" />
            </div>
            <div className="flex gap-3 mt-3">
              <div className="h-3 w-8 bg-ed-bg rounded" />
              <div className="h-3 w-16 bg-ed-bg rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const hasDocs = docs.length > 0;
  const isGenerating = generating || regenerating;

  // ========================
  // RENDER: Manual Prompts Walkthrough (manualStep 1)
  // ========================
  if (generationMode === 'manual' && manualStep === 1) {
    if (loadingPrompts) {
      return <div className="text-ed-ink3 text-center py-8 animate-pulse">Loading research prompts...</div>;
    }

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-serif font-[420] text-ed-ink">Manual Research Guide</h3>
            <p className="text-sm text-ed-ink2">Step 1 of 2: Complete the 4-step manual research guide</p>
          </div>
          <button onClick={handleBackToChoice} className="text-sm text-ed-ink2 hover:text-ed-ink">
            ← Back
          </button>
        </div>

        <div className="bg-ed-accent/5 border border-ed-accent/15 rounded-lg p-4">
          <p className="text-sm text-ed-accent">
            <strong>How this works:</strong> Open ChatGPT or Claude in a new tab.
            Send Steps 1-3 <strong>in sequence, in the same conversation</strong>.
            Step 3 will generate a detailed research prompt specific to your product.
            For Step 4, open web-based ChatGPT, turn on Deep Research, paste the generated prompt,
            then come back here to upload or paste the completed research.
          </p>
        </div>

        {researchPrompts && researchPrompts.map((p, index) => (
          <div key={p.step} className="border border-ed-line rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedPrompt(expandedPrompt === index ? null : index)}
              className="w-full flex items-center justify-between p-4 bg-ed-bg hover:bg-ed-bg transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="w-7 h-7 bg-ed-accent/10 text-ed-accent rounded-full flex items-center justify-center text-sm font-bold">
                  {p.step}
                </span>
                <div>
                  <h4 className="font-medium text-ed-ink">{p.title}</h4>
                  <p className="text-xs text-ed-ink2">{p.instruction}</p>
                </div>
              </div>
              <span className="text-ed-ink3 text-lg">
                {expandedPrompt === index ? '▼' : '▶'}
              </span>
            </button>

            {expandedPrompt === index && (
              <div className="p-4 border-t border-ed-line">
                {p.prompt ? (
                  <>
                    <div className="flex justify-end mb-2">
                      <button
                        onClick={() => handleCopyPrompt(index, p.prompt)}
                        className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
                          copiedPrompt === index
                            ? 'bg-ed-green/10 text-ed-green'
                            : 'bg-ed-accent/10 text-ed-accent hover:bg-ed-accent/15'
                        }`}
                      >
                        {copiedPrompt === index ? '✓ Copied!' : 'Copy to Clipboard'}
                      </button>
                    </div>
                    <pre className="bg-gray-900 text-gray-100 rounded p-4 text-xs overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap">
                      {p.prompt}
                    </pre>
                  </>
                ) : (
                  <div className="rounded-md border border-ed-line bg-ed-bg p-4 text-sm text-ed-ink2">
                    {p.instruction}
                  </div>
                )}
                {(p.alert || p.tip) && (
                  <div className="mt-3 flex gap-3 rounded-md border-l-4 border-amber-500 bg-amber-50 p-3">
                    <span aria-hidden="true" className="text-lg leading-none text-amber-600">⚠</span>
                    <div className="space-y-2 text-sm text-amber-900">
                      {p.alert && (
                        <p>
                          <strong className="font-semibold">Important:</strong> {p.alert}
                        </p>
                      )}
                      {p.tip && (
                        <p className="text-amber-800">
                          {p.tip.text}
                          {p.tip.linkUrl && p.tip.linkLabel && (
                            <>
                              {' '}
                              <a
                                href={p.tip.linkUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium text-amber-900 underline hover:text-amber-700"
                              >
                                {p.tip.linkLabel}
                              </a>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        <div className="flex justify-end">
          <button
            onClick={() => setManualStep(2)}
            className="bg-ed-accent text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-ed-accent/90"
          >
            Next: Upload Your Research →
          </button>
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Upload/Paste Research (manualStep 2)
  // ========================
  if (generationMode === 'manual' && manualStep === 2) {
    const charCount = manualResearchText.length;
    const isShort = charCount > 0 && charCount < 2000;

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-serif font-[420] text-ed-ink">Upload Your Research</h3>
            <p className="text-sm text-ed-ink2">Step 2 of 2: Paste or upload your completed research document</p>
          </div>
          <button onClick={() => setManualStep(1)} className="text-sm text-ed-ink2 hover:text-ed-ink">
            ← Back to Prompts
          </button>
        </div>

        <div className="bg-ed-bg border border-ed-line rounded-lg p-4">
          <p className="text-sm text-ed-ink">
            After completing your research using the prompts from the previous step,
            paste the full research document below or upload a file (PDF, TXT, or HTML).
          </p>
        </div>

        {/* Drag-and-drop file upload */}
        <DragDropUpload
          label="Drop your research file here, or click to browse"
          sublabel="PDF, TXT, or HTML — we'll extract the text content"
          compact
          onTextExtracted={(result) => setManualResearchText(result.text)}
        />

        {/* Textarea */}
        <textarea
          value={manualResearchText}
          onChange={e => setManualResearchText(e.target.value)}
          placeholder="Paste your completed research document here..."
          className="w-full h-[500px] border border-black/10 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ed-accent resize-y"
        />

        {/* Short warning */}
        {isShort && (
          <div className="bg-ed-accent/5 border border-ed-accent/15 text-ed-accent text-sm rounded p-3">
            Your research document seems short ({charCount.toLocaleString()} characters).
            The SOP recommends at least 6 pages of content for best results.
            You can still proceed, but the quality of the output documents may be limited.
          </div>
        )}

        {/* Error */}
        {genError && (
          <div className="bg-ed-rust/10 border border-ed-rust/30 text-ed-rust text-sm rounded p-3">
            {genError}
          </div>
        )}

        <div className="flex justify-between">
          <button
            onClick={() => setManualStep(1)}
            className="border border-black/10 text-ed-ink px-4 py-2 rounded-md text-sm hover:bg-ed-bg"
          >
            ← Back to Prompts
          </button>
          <button
            onClick={handleManualGenerate}
            disabled={!manualResearchText.trim()}
            className="bg-ed-accent text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-ed-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Generate Documents from Research
          </button>
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Direct Upload Documents
  // ========================
  if (generationMode === 'upload') {
    const filledCount = Object.values(uploadDocs).filter(v => v.trim().length > 0).length;

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-serif font-[420] text-ed-ink">Upload Existing Documents</h3>
            <p className="text-sm text-ed-ink2">Paste or drag & drop your foundational documents</p>
          </div>
          <button onClick={handleBackToChoice} className="text-sm text-ed-ink2 hover:text-ed-ink">
            ← Back
          </button>
        </div>

        <div className="bg-ed-accent/5 border border-ed-accent/15 rounded-lg p-4">
          <p className="text-sm text-ed-accent">
            Upload any or all of the 4 foundational documents. You can paste text directly into each field
            or drag & drop a file. Only documents with content will be saved.
          </p>
        </div>

        {/* Error */}
        {genError && (
          <div className="bg-ed-rust/10 border border-ed-rust/30 text-ed-rust text-sm rounded p-3">
            {genError}
          </div>
        )}

        {DOC_ORDER.map(docType => (
          <div key={docType} className="border border-ed-line rounded-lg overflow-hidden">
            <div className="bg-ed-bg px-4 py-3 flex items-center justify-between">
              <h4 className="font-medium text-ed-ink">{DOC_LABELS[docType]}</h4>
              {uploadDocs[docType].trim().length > 0 && (
                <span className="text-xs text-ed-green">
                  {uploadDocs[docType].length.toLocaleString()} characters
                </span>
              )}
            </div>
            <div className="p-4 space-y-3">
              <DragDropUpload
                compact
                label={`Drop ${DOC_LABELS[docType]} file here, or click to browse`}
                sublabel="PDF, TXT, or HTML"
                onTextExtracted={(result) => {
                  setUploadDocs(prev => ({ ...prev, [docType]: result.text }));
                }}
              />
              <textarea
                value={uploadDocs[docType]}
                onChange={e => setUploadDocs(prev => ({ ...prev, [docType]: e.target.value }))}
                placeholder={`Paste your ${DOC_LABELS[docType]} content here...`}
                className="w-full h-32 border border-black/10 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ed-accent resize-y"
              />
            </div>
          </div>
        ))}

        <div className="flex justify-between items-center">
          <button
            onClick={handleBackToChoice}
            className="border border-black/10 text-ed-ink px-4 py-2 rounded-md text-sm hover:bg-ed-bg"
          >
            ← Back
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-ed-ink2">
              {filledCount} of 4 documents provided
            </span>
            <button
              onClick={handleSaveUploadedDocs}
              disabled={filledCount === 0 || savingUpload}
              className="bg-ed-accent text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-ed-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingUpload ? 'Saving...' : 'Save Documents'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Generation Progress (both auto & manual)
  // ========================
  if (isGenerating || (generationMode === 'manual' && manualStep === 3)) {
    const isManualMode = generationMode === 'manual';

    return (
      <div className="space-y-6">
        {/* Error display */}
        {genError && (
          <div className="bg-ed-rust/10 border border-ed-rust/30 text-ed-rust text-sm rounded p-3">
            {genError}
          </div>
        )}

        <div className="ed-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif font-[420] text-ed-ink">
              {regenerating
                ? `Regenerating ${DOC_LABELS[regenerating]}`
                : isManualMode
                  ? 'Generating Documents from Your Research'
                  : 'Generating Foundational Documents'}
            </h3>
            <button onClick={handleCancel} className="text-sm text-ed-rust hover:text-red-800">
              Cancel
            </button>
          </div>

          {/* Overall progress bar */}
          {!regenerating && (
            <PipelineProgress
              progress={genProgress}
              message={genProgressMsg}
              startTime={genStartTimeRef.current}
              className="mb-4"
            />
          )}

          {/* Step progress */}
          {steps.length > 0 && !regenerating && (
            <div className="mb-4 space-y-1">
              {steps.map(step => {
                const isActive = currentStep?.step === step.id;
                const isDone = completedSteps.has(step.id);
                const isDeepResearch = step.mode === 'deep_research';
                const isManualPreStep = isManualMode && step.id <= 4;

                return (
                  <div key={step.id} className="flex items-center gap-2 text-sm">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                      isDone && isManualPreStep ? 'bg-ed-green/10 text-ed-green' :
                      isDone ? 'bg-ed-green/10 text-ed-green' :
                      isActive && isDeepResearch ? 'bg-ed-accent/10 text-ed-accent-mid animate-pulse' :
                      isActive ? 'bg-ed-accent/10 text-ed-accent animate-pulse' :
                      'bg-ed-bg text-ed-ink3'
                    }`}>
                      {isDone ? '✓' : isDeepResearch && !isManualMode ? '🔍' : step.id}
                    </span>
                    <span className={
                      isActive && isDeepResearch ? 'text-ed-accent-mid font-medium' :
                      isActive ? 'text-ed-accent font-medium' :
                      isDone ? 'text-ed-green' :
                      'text-ed-ink3'
                    }>
                      {isManualPreStep && isDone
                        ? (step.id <= 3 ? 'Prompts Provided (Manual)' : 'Research Uploaded (Manual)')
                        : step.label}
                      {step.savedAs && !isManualPreStep && (
                        <span className="text-xs ml-1">→ saves {DOC_LABELS[step.savedAs]}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Live stream content */}
          {currentStep && streamContent && (
            <div>
              <p className="text-xs text-ed-ink2 mb-2">
                Step {currentStep.step}: {currentStep.label}
                {currentStep.mode === 'deep_research' && ' — Research Complete'}
              </p>
              <div
                ref={streamRef}
                className="bg-ed-bg border border-ed-line rounded p-3 max-h-96 overflow-y-auto font-mono text-xs text-ed-ink whitespace-pre-wrap"
              >
                {streamContent || 'Waiting for response...'}
              </div>
            </div>
          )}

          {/* Waiting state */}
          {currentStep && !streamContent && (
            <div>
              <p className="text-xs text-ed-ink2 mb-2">
                Step {currentStep.step}: {currentStep.label}
              </p>
              <div className="bg-ed-bg border border-ed-line rounded p-3 text-sm text-ed-ink2 animate-pulse">
                Waiting for response...
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Main View (doc list, edit, view)
  // ========================
  return (
    <div className="space-y-6">
      {/* Explanation + Generation controls */}
      {!editingDoc && !viewDoc && (
        <>
          <div className="p-4 bg-ed-bg/80 border border-ed-line/60 rounded-xl">
            <p className="text-[13px] text-ed-ink2 leading-relaxed">
              Foundational documents are the backbone of effective ad generation. The system creates four core documents — a <strong>Research Document</strong>, <strong>Customer Avatar</strong>, <strong>Offer Brief</strong>, and <strong>Necessary Beliefs</strong> — that capture everything about your market, ideal customer, and product positioning. These documents give the AI the context it needs to write compelling, on-brand ad copy every time.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <p className="text-sm text-ed-ink2">
                {hasDocs
                  ? `${docs.length} of 4 documents generated`
                  : 'No documents generated yet. Start the generation process.'}
              </p>
              <InfoTooltip text="Core research documents that guide ad generation: research, avatar, offer brief, and necessary beliefs." position="right" />
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {hasDocs && (
                <button
                  type="button"
                  onClick={() => setShowRemoveAllConfirm(true)}
                  disabled={isGenerating || removingDocs}
                  className="px-4 py-2 rounded-[7px] text-[13px] border border-ed-rust/25 text-ed-rust bg-ed-rust/5 hover:bg-ed-rust/10 transition-colors disabled:opacity-50"
                >
                  {removingDocs ? 'Removing...' : 'Remove All Documents'}
                </button>
              )}
              <button
                onClick={handleChooseUpload}
                className="px-4 py-2 rounded-[7px] text-[13px] border border-ed-line text-ed-ink2 bg-ed-surface hover:bg-ed-bg transition-colors"
              >
                Upload Existing Docs
              </button>
              <button
                onClick={handleGenerateClick}
                className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors"
              >
                {hasDocs ? 'Regenerate All Docs' : 'Generate Foundational Docs'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Error display */}
      {genError && (
        <div className="bg-ed-rust/10 border border-ed-rust/30 text-ed-rust text-sm rounded p-3">
          {genError}
        </div>
      )}

      {/* Copy Correction Bar — fix inaccurate info across all docs */}
      {!editingDoc && !viewDoc && hasDocs && (
        <CopyCorrection projectId={projectId} onDocsUpdated={loadDocs} onCorrectionApplied={() => setChangelogRefreshKey(k => k + 1)} />
      )}

      {/* Editing mode */}
      {editingDoc && (
        <div className="ed-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif font-[420] text-ed-ink">
              Editing: {DOC_LABELS[editingDoc.doc_type]}
            </h3>
            <div className="flex gap-2">
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setEditingDoc(null)}
                className="ed-ghost text-[13px]"
              >
                Cancel
              </button>
            </div>
          </div>
          <textarea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            className="w-full h-[600px] border border-black/10 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ed-accent"
          />
        </div>
      )}

      {/* View mode */}
      {viewDoc && !editingDoc && (() => {
        const viewSourceInfo = SOURCE_LABELS[viewDoc.source] || SOURCE_LABELS.generated;
        const viewLastUpdated = viewDoc.updated_at || viewDoc.created_at;
        return (
          <div className="ed-card p-6">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="font-serif font-[420] text-ed-ink">
                  {DOC_LABELS[viewDoc.doc_type]}
                </h3>
                <span className={`text-xs px-2 py-0.5 rounded-full ${viewSourceInfo.color}`}>
                  {viewSourceInfo.label}
                </span>
                <span className="text-xs text-ed-ink3">v{viewDoc.version}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleEdit(viewDoc)}
                  className="action-link"
                >
                  Edit
                </button>
                {viewDoc.doc_type !== 'research' && (
                  <button
                    onClick={() => handleRegenerate(viewDoc.doc_type)}
                    className="action-link text-ed-accent bg-ed-accent/10 hover:bg-ed-accent/15 hover:text-ed-accent"
                  >
                    Regenerate
                  </button>
                )}
                <button
                  onClick={() => setViewDoc(null)}
                  className="ed-ghost text-[13px]"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3 mb-4 text-xs text-ed-ink3">
              <span title={viewLastUpdated ? new Date(viewLastUpdated + 'Z').toLocaleString() : ''}>
                Last updated: {viewLastUpdated ? new Date(viewLastUpdated + 'Z').toLocaleString() : 'Unknown'}
              </span>
              {viewDoc.content && (
                <span>{viewDoc.content.length.toLocaleString()} characters</span>
              )}
            </div>
            <div className="prose prose-sm max-w-none overflow-y-auto max-h-[600px] whitespace-pre-wrap text-sm text-ed-ink">
              {viewDoc.content}
            </div>
          </div>
        );
      })()}

      {/* Document cards */}
      {!editingDoc && !viewDoc && hasDocs && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {DOC_ORDER.map(docType => {
            const doc = docs.find(d => d.doc_type === docType);
            const isResearch = docType === 'research';
            if (!doc) {
              return (
                <div key={docType} className="ed-card p-5 border-dashed border-black/10">
                  <h3 className="font-medium text-ed-ink3">{DOC_LABELS[docType]}</h3>
                  <p className="text-xs text-ed-ink3 mt-1">Not yet generated</p>
                </div>
              );
            }

            // Check if research was done via API (has ## Sources section) or manually
            const isDeepResearch = isResearch && doc.content?.includes('## Sources');

            // Determine source info for display
            const sourceInfo = SOURCE_LABELS[doc.source] || SOURCE_LABELS.generated;
            const lastUpdated = doc.updated_at || doc.created_at;

            return (
              <div
                key={docType}
                className={`ed-card p-5 hover:shadow-md transition-shadow cursor-pointer ${
                  isResearch ? 'border-ed-accent/15' : 'border-ed-line'
                }`}
                onClick={() => setViewDoc(doc)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {isResearch && <span className="text-sm">🔍</span>}
                    <h3 className="font-medium text-ed-ink">{DOC_LABELS[docType]}</h3>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${sourceInfo.color}`}>
                      {sourceInfo.label}
                    </span>
                    {doc.approved ? (
                      <span className="text-xs bg-ed-green/10 text-ed-green px-2 py-0.5 rounded-full">Approved</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleApprove(doc); }}
                        className="text-xs bg-yellow-50 text-yellow-700 px-2 py-0.5 rounded-full hover:bg-yellow-100"
                      >
                        Approve
                      </button>
                    )}
                    <span className="text-xs text-ed-ink3">v{doc.version}</span>
                  </div>
                </div>

                {/* Timestamp row */}
                <div className="flex items-center gap-3 mb-2 text-xs text-ed-ink3">
                  <span title={lastUpdated ? new Date(lastUpdated + 'Z').toLocaleString() : ''}>
                    Updated {formatDate(lastUpdated)}
                  </span>
                  {doc.content && (
                    <span>{doc.content.length.toLocaleString()} chars</span>
                  )}
                </div>

                <p className="text-xs text-ed-ink2 line-clamp-3">
                  {doc.content?.slice(0, 200)}...
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEdit(doc); }}
                    className="action-link"
                  >
                    Edit
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRegenerate(docType); }}
                    className={`action-link ${isResearch ? '' : 'text-ed-accent bg-ed-accent/10 hover:bg-ed-accent/15 hover:text-ed-accent'}`}
                  >
                    {isResearch ? 'Re-run Deep Research' : 'Regenerate'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Changelog — visible below doc cards */}
      {!editingDoc && !viewDoc && hasDocs && (
        <Changelog projectId={projectId} onDocsUpdated={loadDocs} refreshKey={changelogRefreshKey} />
      )}

      <ConfirmDialog
        open={showRemoveAllConfirm}
        title="Remove all foundational documents?"
        message="This removes the Research Document, Avatar Sheet, Offer Brief, and Necessary Beliefs from this project. The project will return to setup until you upload or regenerate foundational documents."
        confirmLabel="Remove All Documents"
        cancelLabel="Cancel"
        tone="danger"
        busy={removingDocs}
        onConfirm={handleRemoveAllDocs}
        onCancel={() => setShowRemoveAllConfirm(false)}
      />

    </div>
  );
}

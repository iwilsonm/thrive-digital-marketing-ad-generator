import { useState, useEffect, useRef, useCallback, useContext, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';

import CostSummaryCards from '../components/CostSummaryCards';
import InfoTooltip from '../components/InfoTooltip';
import ErrorBoundary from '../components/ErrorBoundary';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import NumberedSettingsRail from '../components/editorial/NumberedSettingsRail';

// Lazy-load heavy tab components — only the active tab's code is downloaded
const FoundationalDocs = lazy(() => import('../components/FoundationalDocs'));
const TemplateImages = lazy(() => import('../components/TemplateImages'));
const AdStudio = lazy(() => import('../components/AdStudio'));
const AdTracker = lazy(() => import('./AdTracker'));
const AgentMonitor = lazy(() => import('../components/AgentMonitor'));
// Phase 2A — Meta integration sub-tab in Project Settings
const MetaConnectPanel = lazy(() => import('../components/MetaConnectPanel'));
// Phase 5 — Notion-style Analytics tab
const AnalyticsTab = lazy(() => import('../components/AnalyticsTab'));
// Phase 3 — Observation tab (settings now live inside the tab)
const ObservationTab = lazy(() => import('../components/ObservationTab'));
const RecentAgentActivity = lazy(() => import('../components/RecentAgentActivity'));

const STATUS_CONFIG = {
  setup: { label: 'Setup', bg: 'bg-ed-gold/10', text: 'text-ed-gold' },
  generating_docs: { label: 'Generating', bg: 'bg-ed-accent/10', text: 'text-ed-accent' },
  docs_ready: { label: 'Ready', bg: 'bg-ed-green/10', text: 'text-ed-green' },
  active: { label: 'Active', bg: 'bg-ed-green/15', text: 'text-ed-green' }
};
const REQUIRED_DOC_TYPES = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];

const LEGACY_SETTINGS_SUBTABS = {
  filter: 'automation',
  creative_director: 'automation',
};

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { user } = useContext(AuthContext);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [availableDocTypes, setAvailableDocTypes] = useState(new Set());
  // Phase 6 — Staging tab removed; ad-set lifecycle is unified inside the
  // Ad Pipeline tab. The legacy `enable_phase1_staging:<projectId>` settings
  // flag is no longer read.
  const [conductorAngles, setConductorAngles] = useState([]);

  // Persist active tab in URL search params so it survives page refresh.
  // Phase 6 — `'staging'` removed from validTabs. Server-side redirect below
  // catches any bookmarked ?tab=staging URLs and redirects to defaultTab.
  const validTabs = ['ads', 'tracker', 'automation', 'overview', 'docs', 'templates', 'analytics', 'observation'];
  const defaultTab = user?.role === 'poster' ? 'tracker' : 'ads';
  const tabFromUrl = searchParams.get('tab');
  const [tab, setTabState] = useState(
    tabFromUrl && validTabs.includes(tabFromUrl) ? tabFromUrl : defaultTab
  );
  const setTab = useCallback((newTab) => {
    setTabState(newTab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Sync tab state when URL changes externally (e.g. sidebar navigation)
  useEffect(() => {
    if (tabFromUrl && validTabs.includes(tabFromUrl) && tabFromUrl !== tab) {
      setTabState(tabFromUrl);
    }
  }, [tabFromUrl]);

  const [projectCosts, setProjectCosts] = useState(null);
  const [costsLoading, setCostsLoading] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Product image state
  const [productImageUploading, setProductImageUploading] = useState(false);
  const [productImageDeleting, setProductImageDeleting] = useState(false);
  // settingsSubTab persists in URL `?subtab=` so refresh holds position.
  const validSubTabs = ['general', 'docs', 'meta', 'templates'];
  const subTabFromUrl = searchParams.get('subtab');
  const normalizedSubTabFromUrl = LEGACY_SETTINGS_SUBTABS[subTabFromUrl] || subTabFromUrl;
  const [settingsSubTab, setSettingsSubTabState] = useState(
    normalizedSubTabFromUrl && validSubTabs.includes(normalizedSubTabFromUrl) ? normalizedSubTabFromUrl : 'general'
  );
  useEffect(() => {
    const mapped = LEGACY_SETTINGS_SUBTABS[subTabFromUrl];
    if (!mapped) return;
    setSettingsSubTabState(mapped);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('subtab', mapped);
      return next;
    }, { replace: true });
  }, [subTabFromUrl, setSearchParams]);
  useEffect(() => {
    if (tab !== 'overview') return;
    if (!normalizedSubTabFromUrl || !validSubTabs.includes(normalizedSubTabFromUrl)) return;
    if (settingsSubTab === normalizedSubTabFromUrl) return;
    setSettingsSubTabState(normalizedSubTabFromUrl);
  }, [tab, normalizedSubTabFromUrl, settingsSubTab]);
  useEffect(() => {
    if (tab !== 'overview') return;
    const raw = searchParams.get('subtab');
    if (raw === 'automation' || raw === 'filter' || raw === 'creative_director') {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', 'automation');
        next.delete('subtab');
        return next;
      }, { replace: true });
    } else if (raw === 'observation') {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', 'observation');
        next.delete('subtab');
        return next;
      }, { replace: true });
    }
  }, [tab, searchParams, setSearchParams]);
  const setSettingsSubTab = useCallback((newSubTab) => {
    setSettingsSubTabState(newSubTab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('subtab', newSubTab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const openPipelineQueue = useCallback(() => {
    setTabState('tracker');
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'tracker');
      next.set('view', 'campaigns');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [productDragOver, setProductDragOver] = useState(false);
  const productFileInputRef = useRef(null);

  const handleProductUpload = useCallback(async (file) => {
    if (!file) return;
    setProductImageUploading(true);
    try {
      await api.uploadProductImage(id, file);
      await loadProject();
      toast.success('Product image uploaded');
    } catch (err) {
      toast.error(err.message || 'Failed to upload product image');
    } finally {
      setProductImageUploading(false);
    }
  }, [id]);

  const handleProductDelete = useCallback(async () => {
    setProductImageDeleting(true);
    try {
      await api.deleteProductImage(id);
      await loadProject();
      toast.success('Product image removed');
    } catch (err) {
      toast.error(err.message || 'Failed to remove product image');
    } finally {
      setProductImageDeleting(false);
    }
  }, [id]);

  const handleProductDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) handleProductUpload(file);
  }, [handleProductUpload]);

  useEffect(() => {
    loadProject();
  }, [id]);

  useEffect(() => {
    if (tab === 'overview' && id) {
      loadProjectCosts();
      loadProjectStats();
    }
  }, [tab, id]);

  // Phase 6 — staging feature flag no longer read. Just load conductor angles
  // for any UI that needs the angle list.
  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const result = await api.getConductorAngles(id);
        const angles = Array.isArray(result) ? result : (result?.angles || []);
        setConductorAngles(angles);
      } catch { setConductorAngles([]); }
    })();
  }, [id]);

  // Phase 6 — server-side redirect for legacy ?tab=staging URLs (bookmarks etc).
  // Runs synchronously during URL parse, before any tab body renders, so no flash.
  useEffect(() => {
    if (tabFromUrl === 'staging') {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', defaultTab);
        return next;
      }, { replace: true });
      setTabState(defaultTab);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProjectCosts = async () => {
    setCostsLoading(true);
    try {
      const data = await api.getProjectCosts(id);
      setProjectCosts(data);
    } catch (err) {
      console.error('Failed to load project costs:', err);
    } finally {
      setCostsLoading(false);
    }
  };

  const loadProjectStats = async () => {
    try {
      const stats = await api.getProjectStats(id);
      setProject(prev => ({ ...(prev || {}), ...stats }));
    } catch (err) {
      console.error('Failed to load project stats:', err);
    }
  };

  const loadProject = async () => {
    try {
      const data = await api.getProject(id);
      setProject(prev => prev ? { ...prev, ...data } : data);
      setForm({
        name: data.name,
        brand_name: data.brand_name,
        niche: data.niche,
        product_description: data.product_description,
        drive_folder_id: data.drive_folder_id,
        inspiration_folder_id: data.inspiration_folder_id,
        prompt_guidelines: data.prompt_guidelines || ''
      });
      api.getDocs(id).then(res => {
        const docs = res?.docs || [];
        const types = new Set(docs.map(d => d.doc_type).filter(Boolean));
        const hasAllRequiredDocs = REQUIRED_DOC_TYPES.every(type => types.has(type));
        setAvailableDocTypes(types);
        if (hasAllRequiredDocs && data.status === 'setup') {
          setProject(prev => ({
            ...(prev || data),
            status: 'docs_ready',
            docCount: Math.max(prev?.docCount || 0, docs.length),
          }));
        }
      }).catch(() => {});
    } catch (err) {
      console.error('Failed to load project:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateProject(id, form);
      await loadProject();
      toast.success('Project saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeletingProject(true);
    try {
      await api.deleteProject(id);
      setShowDeleteConfirm(false);
      toast.success('Project archived');
      navigate('/projects');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeletingProject(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-6 animate-pulse">
          <div className="w-5 h-5 bg-ed-line rounded" />
          <div className="h-7 w-48 bg-ed-line rounded" />
          <div className="h-5 w-14 bg-ed-line rounded-full" />
        </div>
        <div className="mb-6">
          <div className="h-8 w-64 bg-ed-bg rounded-xl animate-pulse" />
        </div>
        <div className="ed-card p-6 animate-pulse">
          <div className="h-4 w-28 bg-ed-line rounded mb-5" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="h-3 w-20 bg-ed-bg rounded mb-1" />
              <div className="h-4 w-32 bg-ed-line rounded" />
            </div>
            <div>
              <div className="h-3 w-16 bg-ed-bg rounded mb-1" />
              <div className="h-4 w-24 bg-ed-line rounded" />
            </div>
          </div>
          <div className="mt-4">
            <div className="h-3 w-28 bg-ed-bg rounded mb-1" />
            <div className="h-12 w-full bg-ed-bg rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center py-16">
          <p className="text-ed-ink2 text-sm mb-4">Project not found</p>
          <Link to="/projects" className="text-ed-accent hover:text-ed-accent/80 text-sm transition-colors">Back to All Projects</Link>
        </div>
      </div>
    );
  }

  // Phase 6 — Staging tab removed; ad-set lifecycle (draft / ready / posted /
  // observing / terminal) lives inside the unified Ad Pipeline tab.
  const allTabs = [
    { id: 'ads', label: 'Ad Studio', tooltip: 'Generate individual ads or run background generation batches.' },
    { id: 'tracker', label: 'Ad Pipeline', tooltip: 'Move ads from Queue to Planner, group them into ad sets, prepare them in Ready to Post, and track Posted work.' },
    { id: 'automation', label: 'Automation', tooltip: 'Creative Director batch planning, Creative Filter scoring, angles, and agent settings.' },
    { id: 'analytics', label: 'Analytics', tooltip: 'Meta campaign, ad set, and ad performance with custom columns, filters, tags, notes, and drilldowns.' },
    { id: 'observation', label: 'Observation', tooltip: 'Track posted ad sets during the observation window and use verdicts to guide which angles keep running.' },
    { id: 'overview', label: 'Project Settings', tooltip: 'Project configuration, foundational docs, Meta setup, and template library.' }
  ];

  // Poster only sees Ad Pipeline tab
  const tabs = user?.role === 'poster'
    ? allTabs.filter(t => t.id === 'tracker')
    : allTabs;

  const hasAllRequiredDocs = REQUIRED_DOC_TYPES.every(type => availableDocTypes.has(type));
  const effectiveProjectStatus = project.status === 'setup' && hasAllRequiredDocs ? 'docs_ready' : project.status;
  const status = STATUS_CONFIG[effectiveProjectStatus] || { label: effectiveProjectStatus, bg: 'bg-ed-bg', text: 'text-ed-ink2' };

  return (
    <div className={`mx-auto px-4 sm:px-6 lg:px-8 py-8 ${tab === 'analytics' || tab === 'observation' ? '' : 'max-w-7xl'}`}>
      <div className="sticky top-0 z-30 -mx-4 sm:-mx-6 lg:-mx-8 mb-6 bg-ed-bg/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-3 border-b border-ed-line">
        <Link to="/projects" className="w-9 h-9 rounded-lg flex items-center justify-center text-ed-ink3 hover:text-ed-ink hover:bg-ed-surface border border-transparent hover:border-ed-line transition-colors flex-shrink-0" aria-label="Back to All Projects">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="font-serif text-[24px] font-[420] tracking-[-0.02em] text-ed-ink">{project.brand_name || project.name}</h1>
          {project.brand_name && project.name && (
            <p className="text-[13px] text-ed-ink2 mt-0.5">{project.name}</p>
          )}
        </div>
        <span className={`badge ${status.bg} ${status.text}`}>
          {status.label}
        </span>
        </div>
      </div>

      {/* Setup banner — visible only when project needs foundational docs */}
      {effectiveProjectStatus === 'setup' && (
        <div className="mb-6 p-4 bg-ed-gold/5 border border-ed-gold/20 rounded-[10px] fade-in">
          <p className="text-[13px] font-medium text-ed-ink mb-3">Complete foundational docs to get started</p>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {[
              { key: 'research', label: 'Research' },
              { key: 'avatar', label: 'Customer Avatar' },
              { key: 'offer_brief', label: 'Offer Brief' },
              { key: 'necessary_beliefs', label: 'Necessary Beliefs' },
            ].map(doc => (
              <div key={doc.key} className="flex items-center gap-2 text-[12px]">
                {availableDocTypes.has(doc.key) ? (
                  <svg className="w-4 h-4 text-ed-green flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <div className="w-4 h-4 rounded-full border-2 border-ed-gold/40 flex-shrink-0" />
                )}
                <span className={availableDocTypes.has(doc.key) ? 'text-ed-green font-medium' : 'text-ed-ink2'}>{doc.label}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => { setTab('overview'); setSettingsSubTab('docs'); }}
            className="px-4 py-1.5 text-[12px] rounded-[7px] bg-ed-accent text-white border border-ed-accent hover:bg-ed-accent/90 transition-colors"
          >
            Generate Docs
          </button>
        </div>
      )}

      {/* Tab navigation moved to sidebar — EditorialLayout handles it */}

      <Suspense fallback={
        <div className="flex items-center justify-center py-16">
          <svg className="w-5 h-5 text-ed-accent animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="31.4 31.4" strokeLinecap="round" />
          </svg>
        </div>
      }>
      <div className="fade-in">
        {/* Project Settings tab */}
        {tab === 'overview' && (
          <>
          <div className="grid" style={{ gridTemplateColumns: '232px minmax(0,1fr)', minHeight: '100%' }}>
          <NumberedSettingsRail
            sections={[
              { id: 'general', num: '01', label: 'General', status: project?.status === 'active' ? 'ok' : project?.status === 'setup' ? 'todo' : 'ok' },
              { id: 'docs', num: '02', label: 'Foundational Docs', status: (project?.docCount || 0) > 0 ? 'ok' : 'todo' },
              { id: 'meta', num: '03', label: 'Meta', status: project?.meta_token ? 'ok' : 'warn' },
              { id: 'templates', num: '04', label: 'Template Library', status: 'ok' },
            ]}
            activeSection={settingsSubTab}
            onSectionChange={setSettingsSubTab}
            eyebrow={project?.brand_name || ''}
            title="Project Settings"
            meta="Configure how this project generates, filters, and observes ads."
          />
          <div className="py-8 px-10 min-w-0">

          {settingsSubTab === 'general' && (
          <>
          <div className="flex items-end justify-between gap-6 mb-2 pb-[14px] border-b border-ed-line">
            <div>
              <h2 className="font-serif text-[26px] font-[420] tracking-[-0.015em] text-ed-ink">General</h2>
              <div className="text-[13px] text-ed-ink2 mt-1.5 leading-[1.55]">Basic information about this project. The sales page powers research generation and ad copy.</div>
            </div>
            <div className="flex items-center gap-[6px] text-[11.5px] text-ed-ink3 flex-shrink-0">
              <span className="w-[6px] h-[6px] rounded-full bg-ed-green" />
              All changes saved
            </div>
          </div>

          {/* Project Name */}
          <div className="grid py-[18px] border-b border-ed-line" style={{ gridTemplateColumns: '200px minmax(0,1fr)', columnGap: 32 }}>
            <div className="pt-[10px]">
              <div className="font-serif text-[15px] tracking-[-0.005em] text-ed-ink">Project name</div>
              <div className="text-[11.5px] text-ed-ink3 mt-1 leading-[1.5]">Used in lists, dashboards, and the project switcher.</div>
            </div>
            <div className="pt-[10px] max-w-[540px]">
              <input
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
              />
            </div>
          </div>

          {/* Brand Name */}
          <div className="grid py-[18px] border-b border-ed-line" style={{ gridTemplateColumns: '200px minmax(0,1fr)', columnGap: 32 }}>
            <div className="pt-[10px]">
              <div className="font-serif text-[15px] tracking-[-0.005em] text-ed-ink">Brand</div>
              <div className="text-[11.5px] text-ed-ink3 mt-1 leading-[1.5]">Parent company or studio.</div>
            </div>
            <div className="pt-[10px] max-w-[540px]">
              <input
                value={form.brand_name}
                onChange={e => setForm(p => ({ ...p, brand_name: e.target.value }))}
                className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
              />
            </div>
          </div>

          {/* Niche / Category */}
          <div className="grid py-[18px] border-b border-ed-line" style={{ gridTemplateColumns: '200px minmax(0,1fr)', columnGap: 32 }}>
            <div className="pt-[10px]">
              <div className="font-serif text-[15px] tracking-[-0.005em] text-ed-ink">Category</div>
              <div className="text-[11.5px] text-ed-ink3 mt-1 leading-[1.5]">Helps the AI choose appropriate angles, claims, and tone.</div>
            </div>
            <div className="pt-[10px] max-w-[540px]">
              <input
                value={form.niche}
                onChange={e => setForm(p => ({ ...p, niche: e.target.value }))}
                className="w-full text-[13.5px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
              />
            </div>
          </div>

          {/* Product Context */}
          <div className="grid py-[18px] border-b border-ed-line" style={{ gridTemplateColumns: '200px minmax(0,1fr)', columnGap: 32 }}>
            <div className="pt-[10px]">
              <div className="font-serif text-[15px] tracking-[-0.005em] text-ed-ink">Product context</div>
              <div className="text-[11.5px] text-ed-ink3 mt-1 leading-[1.5]">Used by ad generation, Creative Director angles, QA, and research docs to understand what you sell.</div>
            </div>
            <div className="pt-[10px] max-w-[540px]">
              <textarea
                value={form.product_description}
                onChange={e => setForm(p => ({ ...p, product_description: e.target.value }))}
                rows={3}
                className="w-full text-[13px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none leading-[1.55] min-h-[96px] resize-y focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
              />
            </div>
          </div>

          {/* Product Image */}
          <div className="grid py-[18px] border-b border-ed-line" style={{ gridTemplateColumns: '200px minmax(0,1fr)', columnGap: 32 }}>
            <div className="pt-[10px]">
              <div className="font-serif text-[15px] tracking-[-0.005em] text-ed-ink">Product image</div>
              <div className="text-[11.5px] text-ed-ink3 mt-1 leading-[1.5]">Used in every ad so Gemini renders your real product.</div>
            </div>
            <div className="pt-[10px] max-w-[540px]">
              {project.productImageUrl ? (
                <div className="flex items-center gap-4 p-3 bg-ed-bg border border-ed-line rounded-[10px]">
                  <img
                    src={project.productImageUrl}
                    alt="Product"
                    className="w-16 h-16 object-cover rounded-lg border border-ed-line"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-ed-ink">Current product image</p>
                    <p className="text-[10px] text-ed-ink3">Used in all ads unless overridden</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => productFileInputRef.current?.click()}
                      disabled={productImageUploading}
                      className="text-[11px] text-ed-accent hover:text-ed-accent/80 transition-colors"
                    >
                      {productImageUploading ? 'Uploading...' : 'Replace'}
                    </button>
                    <button
                      type="button"
                      onClick={handleProductDelete}
                      disabled={productImageDeleting || productImageUploading}
                      className="text-[11px] text-ed-rust hover:text-ed-rust/80 transition-colors"
                    >
                      {productImageDeleting ? 'Removing...' : 'Remove'}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => !productImageUploading && productFileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setProductDragOver(true); }}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setProductDragOver(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setProductDragOver(false); }}
                  onDrop={handleProductDrop}
                  className={`border border-dashed rounded-[10px] p-6 text-center cursor-pointer group transition-colors ${
                    productDragOver ? 'border-ed-accent bg-ed-accent/5' :
                    'border-ed-ink3 hover:border-ed-accent bg-ed-bg'
                  }`}
                >
                  <div className="w-[38px] h-[38px] mx-auto mb-[10px] rounded-full bg-ed-surface flex items-center justify-center text-ed-ink3">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  </div>
                  {productImageUploading ? (
                    <p className="text-[13px] text-ed-accent">Uploading...</p>
                  ) : (
                    <>
                      <p className="text-[13px] text-ed-ink mb-[3px]">
                        {productDragOver ? 'Drop product image here' : 'Drop a product photo, or click to browse'}
                      </p>
                      <p className="text-[11.5px] text-ed-ink3">PNG, JPG, WebP up to 10 MB</p>
                    </>
                  )}
                </div>
              )}
              <input
                ref={productFileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.gif"
                onChange={e => { if (e.target.files?.[0]) { handleProductUpload(e.target.files[0]); e.target.value = ''; } }}
                className="hidden"
              />
            </div>
          </div>

          {/* Prompt Guidelines */}
          <div className="grid py-[18px] border-b border-ed-line" style={{ gridTemplateColumns: '200px minmax(0,1fr)', columnGap: 32 }}>
            <div className="pt-[10px]">
              <div className="font-serif text-[15px] tracking-[-0.005em] text-ed-ink">Prompt guidelines</div>
              <div className="text-[11.5px] text-ed-ink3 mt-1 leading-[1.5]">Rules that AI enforces on every generated image prompt.</div>
            </div>
            <div className="pt-[10px] max-w-[540px]">
              <textarea
                value={form.prompt_guidelines}
                onChange={e => setForm(p => ({ ...p, prompt_guidelines: e.target.value }))}
                rows={3}
                className="w-full text-[13px] text-ed-ink px-3 py-[9px] border border-ed-line rounded-[7px] bg-ed-surface outline-none leading-[1.55] min-h-[96px] resize-y focus:border-ed-accent focus:ring-[3px] focus:ring-ed-accent/[0.08]"
                placeholder='e.g., "Only show one type of produce at a time — never mix fruits/vegetables in the same image"'
              />
              <div className="text-[11.5px] text-ed-ink3 mt-1.5">Use this to fix recurring issues in your ads.</div>
            </div>
          </div>

          {/* Project Status */}
          <div className="grid py-[18px] border-b border-ed-line" style={{ gridTemplateColumns: '200px minmax(0,1fr)', columnGap: 32 }}>
            <div className="pt-[10px]">
              <div className="font-serif text-[15px] tracking-[-0.005em] text-ed-ink">Project status</div>
              <div className="text-[11.5px] text-ed-ink3 mt-1 leading-[1.5]">Save changes or archive this project.</div>
            </div>
            <div className="pt-[10px] flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-[13px] py-[7px] text-[12.5px] rounded-[7px] bg-ed-accent text-white border border-ed-accent hover:bg-ed-accent/90 transition-colors"
              >
                {saving ? 'Saving...' : 'Save changes'}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-[13px] py-[7px] text-[12.5px] rounded-[7px] border border-transparent text-ed-rust hover:bg-ed-rust/[0.06] hover:border-ed-rust/20 transition-colors"
              >
                Archive project
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="flex gap-8 pt-5 pb-2">
            <div>
              <p className="text-[10.5px] uppercase tracking-[0.1em] text-ed-ink3 mb-1">Documents</p>
              <p className="font-mono-ed text-[20px] text-ed-ink">{project.docCount || 0}</p>
            </div>
            <div>
              <p className="text-[10.5px] uppercase tracking-[0.1em] text-ed-ink3 mb-1">Ads Generated</p>
              <p className="font-mono-ed text-[20px] text-ed-ink">{project.adCount || 0}</p>
            </div>
            <div>
              <p className="text-[10.5px] uppercase tracking-[0.1em] text-ed-ink3 mb-1">API Spend</p>
              <p className="font-mono-ed text-[20px] text-ed-ink">
                ${projectCosts?.month?.total?.toFixed(2) || '0.00'}
              </p>
            </div>
            <div>
              <p className="text-[10.5px] uppercase tracking-[0.1em] text-ed-ink3 mb-1">Cost per Ad</p>
              <p className="font-mono-ed text-[20px] text-ed-ink">
                ${projectCosts?.costPerAd?.toFixed(3) || '0.000'}
              </p>
            </div>
          </div>

          {/* Project Cost Tracking */}
          <div className="mt-8 pt-6 border-t border-ed-line">
            <h3 className="font-serif text-[18px] font-[420] tracking-[-0.01em] text-ed-ink mb-4">Project Costs</h3>
            <CostSummaryCards costs={projectCosts} loading={costsLoading} />
          </div>

          <ErrorBoundary level="tab" key="recent_agent_activity">
            <RecentAgentActivity projectId={id} />
          </ErrorBoundary>

          </>
          )}

          {settingsSubTab === 'docs' && (
            <ErrorBoundary level="tab" key="docs">
              <FoundationalDocs projectId={id} projectStatus={effectiveProjectStatus} onDocsChanged={loadProject} />
            </ErrorBoundary>
          )}
          {settingsSubTab === 'meta' && (
            <ErrorBoundary level="tab" key="meta">
              <MetaConnectPanel projectId={id} />
            </ErrorBoundary>
          )}
          {settingsSubTab === 'templates' && (
            <ErrorBoundary level="tab" key="templates">
              <TemplateImages projectId={id} />
            </ErrorBoundary>
          )}
          </div>
          </div>
          </>
        )}
        {tab === 'ads' && (
          <ErrorBoundary level="tab" key="ads">
            <AdStudio projectId={id} project={project} conductorAngles={conductorAngles} onOpenPipeline={openPipelineQueue} />
          </ErrorBoundary>
        )}
        {tab === 'tracker' && (
          <ErrorBoundary level="tab" key="tracker">
            <AdTracker projectId={id} project={project} userRole={user?.role} searchParams={searchParams} setSearchParams={setSearchParams} />
          </ErrorBoundary>
        )}
        {/* Phase 6 — Staging tab removed. Ad-set lifecycle is now inside Ad Pipeline. */}
        {tab === 'analytics' && (
          <ErrorBoundary level="tab" key="analytics">
            <AnalyticsTab projectId={id} project={project} />
          </ErrorBoundary>
        )}
        {tab === 'observation' && (
          <ErrorBoundary level="tab" key="observation">
            <ObservationTab projectId={id} project={project} />
          </ErrorBoundary>
        )}
        {tab === 'automation' && (
          <ErrorBoundary level="tab" key="automation">
            <AgentMonitor projectId={id} project={project} onProjectRefresh={loadProject} />
          </ErrorBoundary>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Are you sure you want to delete this project?"
        message="This will move the project into Archived Projects. No ads, documents, templates, or batches will be deleted, and you can unarchive it later."
        confirmLabel="Yes, archive it"
        cancelLabel="Cancel"
        busy={deletingProject}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
      />
      </Suspense>
    </div>
  );
}

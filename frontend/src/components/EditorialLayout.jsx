import { useState, useEffect, useContext, useCallback } from 'react';
import { Outlet, Link, useNavigate, useLocation, useMatch, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';

const SIDEBAR_KEY = 'sidebar-collapsed';

const TAB_MAP = [
  { key: 'ads',         label: 'Ad Studio',        icon: BoltIcon },
  { key: 'tracker',     label: 'Ad Pipeline',       icon: LayersIcon },
  { key: 'automation',  label: 'Automation',         icon: AutomationIcon },
  { key: 'analytics',   label: 'Analytics',          icon: ChartIcon },
  { key: 'observation', label: 'Observation',        icon: EyeIcon },
  { key: 'overview',    label: 'Project Settings',   icon: CogIcon },
];

function parsePinnedIds(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export default function EditorialLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { user, setUser } = useContext(AuthContext);

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === 'true'; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [pinnedProjects, setPinnedProjects] = useState([]);

  const projectMatch = useMatch('/projects/:id');
  const projectId = projectMatch?.params?.id;
  const activeTab = searchParams.get('tab') || 'ads';

  useEffect(() => {
    document.documentElement.classList.remove('dark');
    localStorage.removeItem('theme');
  }, []);

  useEffect(() => {
    if (!projectId) { setProjectName(''); return; }
    let cancelled = false;
    api.getProject(projectId)
      .then(p => { if (!cancelled) setProjectName(p?.brand_name || p?.name || ''); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  const loadPinnedProjects = useCallback(() => {
    let cancelled = false;
    Promise.all([api.getSettings(), api.getProjects()])
      .then(([settings, projects]) => {
        if (cancelled) return;
        const pinnedIds = parsePinnedIds(settings?.pinned_project_ids);
        const projectList = Array.isArray(projects) ? projects : [];
        const byId = new Map(projectList.map(project => [project.id, project]));
        setPinnedProjects(pinnedIds.map(id => byId.get(id)).filter(Boolean));
      })
      .catch(() => {
        if (!cancelled) setPinnedProjects([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => loadPinnedProjects(), [loadPinnedProjects]);

  useEffect(() => {
    window.addEventListener('pinned-projects-updated', loadPinnedProjects);
    return () => window.removeEventListener('pinned-projects-updated', loadPinnedProjects);
  }, [loadPinnedProjects]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_KEY, String(next)); } catch {}
      return next;
    });
  }, []);

  const handleLogout = async () => {
    try { await api.logout(); } finally {
      setUser(null);
      setMobileOpen(false);
      navigate('/login', { replace: true });
    }
  };

  const handleTabClick = (tabKey) => {
    navigate(`/projects/${projectId}?tab=${tabKey}`);
    setMobileOpen(false);
  };

  const isActive = (path) => location.pathname === path;
  const isProjectsActive = location.pathname === '/projects' || location.pathname.startsWith('/projects/');

  const isPoster = user?.role === 'poster';
  const isAdmin = user?.role === 'admin';

  const visibleTabs = isPoster
    ? TAB_MAP.filter(t => t.key === 'tracker')
    : TAB_MAP;

  const userInitial = (user?.displayName || user?.username || '?')[0].toUpperCase();

  return (
    <div className="flex h-screen bg-ed-bg text-ed-ink font-geist">
      {/* ─── Sidebar (desktop) ─── */}
      <aside
        className={`hidden md:flex flex-col flex-shrink-0 bg-ed-surface border-r border-ed-line relative transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          collapsed ? 'w-[60px] px-2' : 'w-[240px] px-3.5'
        } py-[18px]`}
      >
        {/* Collapse toggle */}
        <button
          onClick={toggleCollapse}
          className="absolute -right-[11px] top-6 w-[22px] h-[22px] rounded-full bg-ed-surface border border-ed-line flex items-center justify-center text-ed-ink3 hover:text-ed-ink hover:border-ed-ink3 z-10 cursor-pointer"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d={collapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'} />
          </svg>
        </button>

        <SidebarContent
          collapsed={collapsed}
          user={user}
          userInitial={userInitial}
          projectId={projectId}
          projectName={projectName}
          activeTab={activeTab}
          visibleTabs={visibleTabs}
          pinnedProjects={pinnedProjects}
          isActive={isActive}
          isProjectsActive={isProjectsActive}
          isPoster={isPoster}
          isAdmin={isAdmin}
          onTabClick={handleTabClick}
          onPinnedProjectClick={() => {}}
          onLogout={handleLogout}
        />
      </aside>

      {/* ─── Main area ─── */}
      <div className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden">
        {/* Mobile topbar */}
        <div className="md:hidden flex items-center justify-between px-4 h-12 bg-ed-surface border-b border-ed-line flex-shrink-0">
          <Link to={isPoster ? '/projects' : '/'} className="flex items-center">
            <img src="/logo-full.png" alt="ThriveCampaigns" className="h-8" />
          </Link>
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-ed-line/40"
          >
            {mobileOpen ? <XIcon /> : <MenuIcon />}
          </button>
        </div>

        {/* Mobile sidebar overlay */}
        {mobileOpen && (
          <>
            <div className="md:hidden fixed inset-0 bg-black/20 z-40" onClick={() => setMobileOpen(false)} />
            <div className="md:hidden fixed left-0 top-0 bottom-0 w-[260px] bg-ed-surface border-r border-ed-line z-50 p-3.5 pt-[18px] overflow-y-auto">
              <SidebarContent
                collapsed={false}
                user={user}
                userInitial={userInitial}
                projectId={projectId}
                projectName={projectName}
                activeTab={activeTab}
                visibleTabs={visibleTabs}
                pinnedProjects={pinnedProjects}
                isActive={isActive}
                isProjectsActive={isProjectsActive}
                isPoster={isPoster}
                isAdmin={isAdmin}
                onTabClick={handleTabClick}
                onPinnedProjectClick={() => setMobileOpen(false)}
                onLogout={handleLogout}
              />
            </div>
          </>
        )}

        {/* Content area — no transform to avoid breaking fixed-position modals */}
        <main className="flex-1 overflow-y-auto bg-ed-bg min-w-0 ed-scrollbar">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SidebarContent({
  collapsed, user, userInitial, projectId, projectName, activeTab,
  visibleTabs, pinnedProjects = [], isActive, isProjectsActive, isPoster, isAdmin,
  onTabClick, onPinnedProjectClick, onLogout,
}) {
  return (
    <div className="flex flex-col gap-[18px] h-full min-h-0">
      {/* Brand */}
      <Link
        to={isPoster ? '/projects' : '/'}
        className={`flex items-center no-underline ${collapsed ? 'justify-center' : 'px-2 pb-1'}`}
      >
        <img
          src={collapsed ? '/logo-mark.png' : '/logo-full.png'}
          alt="ThriveCampaigns"
          className={`flex-shrink-0 ${collapsed ? 'h-8 w-8' : 'h-9 w-auto max-w-[180px]'}`}
        />
      </Link>

      {/* Workspace nav */}
      <div>
        {!collapsed && <SectionLabel>Workspace</SectionLabel>}
        {!isPoster && (
          <NavItem
            active={isActive('/')}
            collapsed={collapsed}
            onClick={() => {}}
            as={Link}
            to="/"
          >
            <HomeIcon /> <NavLabel collapsed={collapsed}>Dashboard</NavLabel>
          </NavItem>
        )}
        <NavItem
          active={isProjectsActive}
          collapsed={collapsed}
          onClick={() => {}}
          as={Link}
          to="/projects"
        >
          <FolderIcon /> <NavLabel collapsed={collapsed}>All Projects</NavLabel>
        </NavItem>
      </div>

      {pinnedProjects.length > 0 && (
        <div>
          {!collapsed && <SectionLabel>Pinned Projects</SectionLabel>}
          {pinnedProjects.map(project => (
            <NavItem
              key={project.id}
              active={locationPathIsProject(projectId, project.id)}
              collapsed={collapsed}
              onClick={onPinnedProjectClick}
              as={Link}
              to={`/projects/${project.id}`}
              title={project.brand_name || project.name}
            >
              <PinIcon /> <NavLabel collapsed={collapsed}>{project.brand_name || project.name}</NavLabel>
            </NavItem>
          ))}
        </div>
      )}

      {/* Project tabs */}
      {projectId && (
        <div>
          {!collapsed && <SectionLabel>{projectName || 'Project'}</SectionLabel>}
          {visibleTabs.map(({ key, label, icon: Icon }) => (
            <NavItem
              key={key}
              active={activeTab === key}
              collapsed={collapsed}
              onClick={() => onTabClick(key)}
            >
              <Icon /> <NavLabel collapsed={collapsed}>{label}</NavLabel>
            </NavItem>
          ))}
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom */}
      <div>
        {isAdmin && (
          <NavItem
            active={isActive('/settings')}
            collapsed={collapsed}
            onClick={() => {}}
            as={Link}
            to="/settings"
          >
            <CogIcon /> <NavLabel collapsed={collapsed}>Settings</NavLabel>
          </NavItem>
        )}

        {/* User chip */}
        <div
          className={`flex items-center gap-[9px] mt-2 pt-3 border-t border-ed-line ${
            collapsed ? 'justify-center' : 'px-2.5'
          }`}
        >
          <div className="w-6 h-6 rounded-full bg-ed-accent text-white flex items-center justify-center text-[11px] font-medium flex-shrink-0">
            {userInitial}
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight min-w-0">
              <span className="text-[12.5px] text-ed-ink truncate">{user?.displayName || user?.username}</span>
              <button onClick={onLogout} className="text-[10.5px] text-ed-ink3 hover:text-ed-accent text-left cursor-pointer">
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function locationPathIsProject(activeProjectId, projectId) {
  return !!activeProjectId && activeProjectId === projectId;
}

function SectionLabel({ children }) {
  return <div className="px-2.5 text-[10.5px] uppercase tracking-[0.12em] text-ed-ink3 mb-1.5">{children}</div>;
}

function NavItem({ children, active, collapsed, onClick, as: Component = 'button', ...rest }) {
  return (
    <Component
      onClick={onClick}
      className={`flex items-center gap-[9px] w-full text-left no-underline rounded-[7px] text-[13px] cursor-pointer transition-colors duration-150 ${
        collapsed ? 'justify-center px-0 py-[7px]' : 'px-2.5 py-[7px]'
      } ${
        active
          ? 'bg-ed-accent/[0.08] text-ed-accent'
          : 'text-ed-ink2 hover:bg-black/[0.03] hover:text-ed-ink'
      }`}
      {...rest}
    >
      {children}
    </Component>
  );
}

function NavLabel({ collapsed, children }) {
  if (collapsed) return null;
  return <span className="truncate">{children}</span>;
}

/* ─── Icons ─── */
function HomeIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function LayersIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
function AutomationIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function CogIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg className="w-5 h-5 text-ed-ink2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg className="w-5 h-5 text-ed-ink2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

import { useState, useEffect, useContext } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';

const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  poster: 'Poster',
};

const ROLE_COLORS = {
  admin: 'bg-gold/15 text-gold',
  manager: 'bg-navy/10 text-navy',
  poster: 'bg-teal/10 text-teal',
};

export default function Layout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, setUser } = useContext(AuthContext);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Force removal of any lingering dark mode classes from the DOM
  useEffect(() => {
    document.documentElement.classList.remove('dark');
    localStorage.removeItem('theme');
  }, []);

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setMobileMenuOpen(false);
      navigate('/login', { replace: true });
    }
  };

  // Build nav links based on role
  const navLinks = [];
  if (user?.role === 'admin' || user?.role === 'manager') {
    navLinks.push({ to: '/', label: 'Dashboard' });
  }
  navLinks.push({ to: '/projects', label: 'All Projects' });
  if (user?.role === 'admin') {
    navLinks.push({ to: '/settings', label: 'Settings' });
  }

  // Check if we're on any project-specific page (e.g. /projects/abc-123)
  const isProjectSubPage = location.pathname.startsWith('/projects/');
  const isProjectsActive = location.pathname === '/projects' || isProjectSubPage;

  return (
    <div className="min-h-screen text-textdark font-sans relative">
      {/* Top Banner Gradient Accent */}
      <div className="h-[3px] w-full bg-gradient-to-r from-navy via-teal to-gold absolute top-0 z-50"></div>
      <nav className="glass-nav sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-8">
              <Link to={user?.role === 'poster' ? '/projects' : '/'} className="flex items-center">
                <img src="/logo-full.svg" alt="Thrive Campaigns" className="h-10" />
              </Link>
              <div className="segmented-control hidden md:inline-flex">
                {navLinks.map(link => {
                  const isActive = link.to === '/projects'
                    ? isProjectsActive
                    : location.pathname === link.to;
                  return (
                    <Link
                      key={link.to}
                      to={link.to}
                      className={isActive ? 'active' : ''}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* User info */}
              {user && (
                <div className="hidden md:flex items-center gap-2">
                  <span className="text-[11px] text-textmid">{user.displayName || user.username}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${ROLE_COLORS[user.role] || 'bg-navy/10 text-navy'}`}>
                    {ROLE_LABELS[user.role] || user.role}
                  </span>
                </div>
              )}
              <button
                onClick={handleLogout}
                className="text-[13px] text-textlight hover:text-black transition-colors duration-200 hidden md:block"
              >
                Sign Out
              </button>
              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/5 transition-colors"
              >
                {mobileMenuOpen ? (
                  <svg className="w-5 h-5 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-black/5 bg-white fade-in">
            <div className="px-4 py-3 space-y-1">
              {/* User info (mobile) */}
              {user && (
                <div className="flex items-center gap-2 px-3 py-2 mb-1">
                  <span className="text-[12px] text-textmid font-medium">{user.displayName || user.username}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${ROLE_COLORS[user.role] || 'bg-navy/10 text-navy'}`}>
                    {ROLE_LABELS[user.role] || user.role}
                  </span>
                </div>
              )}
              {navLinks.map(link => {
                const isActive = link.to === '/projects'
                  ? isProjectsActive
                  : location.pathname === link.to;
                return (
                  <Link
                    key={link.to}
                    to={link.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`block px-3 py-2 rounded-xl text-[14px] font-medium transition-colors ${
                      isActive
                        ? 'bg-navy/10 text-navy'
                        : 'text-textmid hover:bg-black/3'
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
              <button
                onClick={() => { setMobileMenuOpen(false); handleLogout(); }}
                className="block w-full text-left px-3 py-2 rounded-xl text-[14px] font-medium text-red-500 hover:bg-red-50/50 transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        )}
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-fade-in-up">
        {children}
      </main>
    </div>
  );
}

import { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';

export default function Login() {
  const navigate = useNavigate();
  const { setUser } = useContext(AuthContext);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSetup, setIsSetup] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    api.getSession().then(data => {
      if (data.authenticated && data.user) {
        setUser(data.user);
        navigateByRole(data.user.role);
      } else {
        setIsSetup(!data.setupComplete);
      }
      setCheckingSession(false);
    }).catch(() => setCheckingSession(false));
  }, [navigate]);

  const navigateByRole = (role) => {
    if (role === 'poster') {
      navigate('/projects');
    } else {
      navigate('/');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let result;
      if (isSetup) {
        result = await api.setup(username, password);
      } else {
        result = await api.login(username, password);
      }
      setUser(result.user);
      navigateByRole(result.user.role);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ed-bg">
        <div className="text-ed-ink3 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ed-bg font-geist">
      <div className="w-full max-w-sm fade-in">
        <div className="ed-card p-8">
          <div className="text-center mb-6">
            <img src="/logo-full.png" alt="ThriveCampaigns" className="h-12 mx-auto mb-4" />
            <p className="text-[13px] text-ed-ink2 mt-1">
              {isSetup ? 'Create your admin account to get started' : 'Sign in to continue'}
            </p>
          </div>

          {error && (
            <div className="bg-ed-rust/5 border border-ed-rust/15 text-ed-rust text-[13px] rounded-xl p-3 mb-4">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-ed-ink2 mb-1.5">Username</label>
              <input
                data-testid="login-username"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                required
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-ed-ink2 mb-1.5">Password</label>
              <input
                data-testid="login-password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                required
                minLength={6}
              />
            </div>
            <button
              data-testid="login-submit"
              type="submit"
              disabled={loading}
              className="ed-cta w-full py-2.5"
            >
              {loading ? 'Please wait...' : isSetup ? 'Create Admin Account' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

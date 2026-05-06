import { useContext, useEffect, useState } from 'react';
import { api } from '../api';
import { AuthContext } from '../App';

import InfoTooltip from '../components/InfoTooltip';
import TodoWidget from '../components/TodoWidget';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

// ─── Helpers ──────────────────────────────────────────────────────────

// Small status pill for API key fields. Shows ● Configured (teal) when the
// key is set, ○ Not set (muted) when missing. Backend masks key values to
// `prefix...suffix` on GET, so a non-empty string from settings means "set".
function KeyStatusPill({ set }) {
  if (set) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ed-green/10 text-ed-green">
        <span className="w-1.5 h-1.5 rounded-full bg-ed-green" />
        Configured
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-black/5 text-ed-ink3">
      <span className="w-1.5 h-1.5 rounded-full bg-textlight/60" />
      Not set
    </span>
  );
}

const CREDENTIAL_DELETE_COPY = {
  openai_api_key: {
    label: 'OpenAI API Key',
    message: 'Remove the OpenAI API key? Copywriting, Creative Director reasoning, GPT Image 2, and OpenAI checks will stop until a new key is saved.',
  },
  gemini_api_key: {
    label: 'Gemini API Key',
    message: 'Remove the Gemini API key? Gemini image generation and batch image generation will stop until a new key is saved.',
  },
  anthropic_api_key: {
    label: 'Anthropic API Key',
    message: 'Remove the Anthropic API key? Creative Filter QA and Ready-to-Post copy generation will stop until a new key is saved.',
  },
  meta_app_id: {
    label: 'Meta App ID',
    message: 'Remove the Meta App ID? New Meta account connections will not start until the App ID and App Secret are saved again.',
  },
  meta_app_secret: {
    label: 'Meta App Secret',
    message: 'Remove the Meta App Secret? New Meta account connections will not complete until the App ID and App Secret are saved again.',
  },
};

const COMMON_PASSWORDS = new Set([
  '123456',
  '123456789',
  'password',
  'password1',
  'qwerty',
  'letmein',
  'admin123',
  'creativefactory',
]);

function getPasswordGuidance(password, label = 'Password') {
  if (typeof password !== 'string' || password.length < 12) {
    return `${label} must be at least 12 characters.`;
  }
  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) {
    return `${label} is too common. Choose a stronger password.`;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9\W_]/.test(password)) {
    return `${label} must include letters and at least one number or symbol.`;
  }
  return '';
}

function CredentialRemoveButton({ settingKey, settings, onRemove }) {
  if (!settings?.[settingKey]) return null;
  return (
    <button
      type="button"
      onClick={() => onRemove(settingKey)}
      className="ed-ghost text-[13px] whitespace-nowrap text-ed-rust hover:text-ed-rust"
    >
      Remove
    </button>
  );
}

function PasswordInput({ className = '', ...props }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative flex-1 min-w-0">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        className="absolute inset-y-0 right-2 my-auto h-7 w-7 rounded-md flex items-center justify-center text-ed-ink3 hover:text-ed-ink2 hover:bg-black/5 transition-colors"
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide' : 'Show'}
      >
        {visible ? (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c1.72 0 3.344-.414 4.777-1.148M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l12.544 12.544M9.879 9.879a3 3 0 104.243 4.243" /></svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.036 12.322a1.012 1.012 0 010-.644C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.437 0 .644C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
        )}
      </button>
    </div>
  );
}

// ─── User Management Card ─────────────────────────────────────────────
const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin', description: 'Full access to everything' },
  { value: 'manager', label: 'Manager', description: 'All features except Settings & User Management' },
  { value: 'poster', label: 'Poster', description: 'Ready to Post + Posted only' },
];

const ROLE_COLORS = {
  admin: 'bg-ed-accent/15 text-ed-accent',
  manager: 'bg-ed-accent/10 text-ed-accent',
  poster: 'bg-ed-green/10 text-ed-green',
};

function UserManagementCard({ currentUserId, currentUsername }) {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ username: '', display_name: '', password: '', role: 'poster' });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [resetPasswordId, setResetPasswordId] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);

  useEffect(() => { loadUsers(); }, []);

  const loadUsers = async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!createForm.username || !createForm.password || !createForm.role) {
      toast.error('All fields are required');
      return;
    }
    const passwordIssue = getPasswordGuidance(createForm.password);
    if (passwordIssue) {
      toast.error(passwordIssue);
      return;
    }
    setCreating(true);
    try {
      await api.createUser(createForm);
      toast.success(`User "${createForm.username}" created`);
      setCreateForm({ username: '', display_name: '', password: '', role: 'poster' });
      setShowCreate(false);
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (userId) => {
    try {
      await api.updateUser(userId, editForm);
      toast.success('User updated');
      setEditingId(null);
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to update user');
    }
  };

  const handleToggleActive = async (user) => {
    try {
      await api.updateUser(user.id, { is_active: !user.is_active });
      toast.success(user.is_active ? 'User deactivated' : 'User activated');
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to update user');
    }
  };

  const handleResetPassword = async (userId) => {
    const passwordIssue = getPasswordGuidance(newPassword, 'New password');
    if (passwordIssue) {
      toast.error(passwordIssue);
      return;
    }
    setResettingPassword(true);
    try {
      await api.resetUserPassword(userId, newPassword);
      toast.success('Password reset successfully');
      setResetPasswordId(null);
      setNewPassword('');
    } catch (err) {
      toast.error(err.message || 'Failed to reset password');
    } finally {
      setResettingPassword(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteUser) return;
    try {
      await api.deleteUser(pendingDeleteUser.id);
      toast.success(`User "${pendingDeleteUser.username}" deleted`);
      setPendingDeleteUser(null);
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to delete user');
    }
  };

  return (
    <div className="ed-card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight flex items-center gap-2">
          <svg className="w-4 h-4 text-ed-ink2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m0 0V21" />
          </svg>
          User Management
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[11px] px-3 py-1.5"
        >
          {showCreate ? 'Cancel' : '+ New User'}
        </button>
      </div>
      <p className="text-[12px] text-ed-ink3 -mt-2 mb-4">
        Use Reset Password for other users. To change your own password, use Your Password above.
      </p>

      {/* Create user form */}
      {showCreate && (
        <form onSubmit={handleCreate} className="bg-ed-bg rounded-xl p-4 mb-4 space-y-3 border border-black/5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-ed-ink2 mb-1">Username</label>
              <input
                type="text"
                value={createForm.username}
                onChange={e => setCreateForm(prev => ({ ...prev, username: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]"
                required
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-ed-ink2 mb-1">Display Name</label>
              <input
                type="text"
                value={createForm.display_name}
                onChange={e => setCreateForm(prev => ({ ...prev, display_name: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]"
                placeholder="Optional"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-ed-ink2 mb-1">Password</label>
              <PasswordInput
                value={createForm.password}
                onChange={e => setCreateForm(prev => ({ ...prev, password: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]"
                required
                minLength={12}
              />
              <p className="text-[10px] text-ed-ink3 mt-1">
                Minimum 12 characters with letters and at least one number or symbol.
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-ed-ink2 mb-1">Role</label>
              <select
                value={createForm.role}
                onChange={e => setCreateForm(prev => ({ ...prev, role: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]"
              >
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label} — {r.description}</option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" disabled={creating} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[11px] px-4 py-1.5 disabled:opacity-50">
            {creating ? 'Creating...' : 'Create User'}
          </button>
        </form>
      )}

      {/* User list */}
      {loading ? (
        <div className="text-[12px] text-ed-ink3 py-4 text-center">Loading users...</div>
      ) : users.length === 0 ? (
        <div className="text-[12px] text-ed-ink3 py-4 text-center">No users found</div>
      ) : (
        <div className="space-y-2">
          {users.map(rowUser => {
            const isCurrentUser = rowUser.id === currentUserId || rowUser.username === currentUsername;
            return (
            <div key={rowUser.id} className={`rounded-xl border p-3 transition-colors ${rowUser.is_active ? 'border-ed-line bg-ed-surface' : 'border-ed-rust/30 bg-ed-rust/10'}`}>
              {editingId === rowUser.id ? (
                /* Edit mode */
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-medium text-ed-ink2 mb-0.5">Display Name</label>
                      <input
                        type="text"
                        value={editForm.display_name || ''}
                        onChange={e => setEditForm(prev => ({ ...prev, display_name: e.target.value }))}
                        className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-ed-ink2 mb-0.5">Role</label>
                      <select
                        value={editForm.role || ''}
                        onChange={e => setEditForm(prev => ({ ...prev, role: e.target.value }))}
                        className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]"
                      >
                        {ROLE_OPTIONS.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleUpdate(rowUser.id)} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[10px] px-3 py-1">Save</button>
                    <button onClick={() => setEditingId(null)} className="ed-ghost text-[10px] px-3 py-1">Cancel</button>
                  </div>
                </div>
              ) : resetPasswordId === rowUser.id ? (
                /* Reset password mode */
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-ed-ink">Reset password for {rowUser.username}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <PasswordInput
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="New password (min 12 chars)"
                      className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px] flex-1"
                      minLength={12}
                    />
                    <button onClick={() => handleResetPassword(rowUser.id)} disabled={resettingPassword} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[10px] px-3 py-1 disabled:opacity-50">
                      {resettingPassword ? 'Resetting...' : 'Reset Password'}
                    </button>
                    <button onClick={() => { setResetPasswordId(null); setNewPassword(''); }} className="ed-ghost text-[10px] px-3 py-1">Cancel</button>
                  </div>
                </div>
              ) : (
                /* Display mode */
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-ed-ink">{rowUser.display_name || rowUser.username}</span>
                        {rowUser.display_name && rowUser.display_name !== rowUser.username && (
                          <span className="text-[10px] text-ed-ink3">@{rowUser.username}</span>
                        )}
                        {isCurrentUser && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ed-gold/10 text-ed-ink2">
                            You
                          </span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${ROLE_COLORS[rowUser.role] || 'bg-ed-accent/10 text-ed-accent'}`}>
                          {rowUser.role}
                        </span>
                        {!rowUser.is_active && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-red-100 text-red-600">
                            Inactive
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setEditingId(rowUser.id); setEditForm({ display_name: rowUser.display_name, role: rowUser.role }); }}
                      className="action-link"
                    >
                      Edit
                    </button>
                    {!isCurrentUser ? (
                      <button
                        onClick={() => { setResetPasswordId(rowUser.id); setNewPassword(''); }}
                        className="action-link"
                      >
                        Reset Password
                      </button>
                    ) : (
                      <span className="text-[10px] text-ed-ink3 px-2">Use Your Password above</span>
                    )}
                    <button
                      onClick={() => handleToggleActive(rowUser)}
                      className={`text-[10px] px-2 py-1 rounded-lg transition-colors ${
                        rowUser.is_active
                          ? 'text-ed-rust hover:bg-ed-bg'
                          : 'text-ed-green hover:bg-ed-green/10'
                      }`}
                    >
                      {rowUser.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => setPendingDeleteUser(rowUser)}
                      className="action-link-danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
          })}
        </div>
      )}
      <ConfirmDialog
        open={!!pendingDeleteUser}
        title="Delete user?"
        message={pendingDeleteUser ? `Delete user "${pendingDeleteUser.username}"? This cannot be undone.` : ''}
        confirmLabel="Delete User"
        onCancel={() => setPendingDeleteUser(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

export default function Settings() {
  const toast = useToast();
  const { user, setUser } = useContext(AuthContext);
  const [settings, setSettings] = useState({});
  const [form, setForm] = useState({
    openai_api_key: '',
    gemini_api_key: '',
    anthropic_api_key: '',
    gemini_rate_1k: '',
    gemini_rate_2k: '',
    gemini_rate_4k: '',
    openai_image_rate_per_image: '',
    // Phase 2A — Meta integration global config
    meta_app_id: '',
    meta_app_secret: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [testResults, setTestResults] = useState({});
  const [pendingCredentialDelete, setPendingCredentialDelete] = useState(null);
  const [deletingCredential, setDeletingCredential] = useState(false);

  // Gemini rate refresh
  const [refreshingRates, setRefreshingRates] = useState(false);
  const [rateRefreshMsg, setRateRefreshMsg] = useState('');
  const [rateRefreshKind, setRateRefreshKind] = useState('info');

  // Password change
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordMsg, setPasswordMsg] = useState('');
  const [profileForm, setProfileForm] = useState({
    username: user?.username || '',
    displayName: user?.displayName || user?.username || '',
  });
  const [profileMsg, setProfileMsg] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    setProfileForm({
      username: user?.username || '',
      displayName: user?.displayName || user?.username || '',
    });
  }, [user?.displayName, user?.username]);

  const loadSettings = async () => {
    try {
      const data = await api.getSettings();
      setSettings(data);
      setForm(prev => ({
        ...prev,
        gemini_rate_1k: data.gemini_rate_1k || '',
        gemini_rate_2k: data.gemini_rate_2k || '',
        gemini_rate_4k: data.gemini_rate_4k || '',
        openai_image_rate_per_image: data.openai_image_rate_per_image || '',
      }));
      // (Cloudflare Pages projects removed — LP publishing now uses Shopify via Director config)
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const payload = {};
      if (form.openai_api_key.trim()) payload.openai_api_key = form.openai_api_key.trim();
      if (form.gemini_api_key.trim()) payload.gemini_api_key = form.gemini_api_key.trim();
      if (form.anthropic_api_key.trim()) payload.anthropic_api_key = form.anthropic_api_key.trim();
      if (form.gemini_rate_1k) payload.gemini_rate_1k = form.gemini_rate_1k;
      if (form.gemini_rate_2k) payload.gemini_rate_2k = form.gemini_rate_2k;
      if (form.gemini_rate_4k) payload.gemini_rate_4k = form.gemini_rate_4k;
      if (form.openai_image_rate_per_image) payload.openai_image_rate_per_image = form.openai_image_rate_per_image;
      // Phase 2A — Meta integration
      if (form.meta_app_id.trim()) payload.meta_app_id = form.meta_app_id.trim();
      if (form.meta_app_secret.trim()) payload.meta_app_secret = form.meta_app_secret.trim();
      const result = await api.updateSettings(payload);
      const requestedKeys = Object.keys(payload);
      const savedKeys = Array.isArray(result?.saved) ? result.saved : requestedKeys;
      const skipped = requestedKeys.filter(key => !savedKeys.includes(key));
      if (skipped.length > 0) {
        throw new Error(`Some settings were not saved: ${skipped.join(', ')}`);
      }
      toast.success('Settings saved');
      setMessage('');
      setForm(prev => ({ ...prev, openai_api_key: '', gemini_api_key: '', anthropic_api_key: '', meta_app_id: '', meta_app_secret: '' }));
      await loadSettings();
    } catch (err) {
      const message = err.message || 'Failed to save settings';
      setMessage(`Error: ${message}`);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (service) => {
    setTestResults(prev => ({ ...prev, [service]: 'testing...' }));
    try {
      let result;
      if (service === 'openai') {
        result = await api.testOpenAI(form.openai_api_key.trim());
      } else if (service === 'openai_image') {
        result = await api.testOpenAIImage('gpt-image-2', form.openai_api_key.trim());
      } else if (service === 'gemini') {
        result = await api.testGemini(form.gemini_api_key.trim());
      } else if (service === 'anthropic') {
        const candidateKey = form.anthropic_api_key.trim();
        result = await api.testAnthropic(candidateKey);
        if (candidateKey) {
          await api.updateSettings({ anthropic_api_key: candidateKey });
          setForm(prev => ({ ...prev, anthropic_api_key: '' }));
          await loadSettings();
          result = { ...result, message: 'Anthropic API key is valid and saved for Creative Filter QA.' };
          toast.success('Anthropic key tested and saved');
        }
      }
      setTestResults(prev => ({ ...prev, [service]: result.message || (result.success === false ? 'Check failed' : 'Connected!') }));
    } catch (err) {
      setTestResults(prev => ({ ...prev, [service]: `Failed: ${err.message}` }));
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPasswordMsg('');
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordMsg('Error: New password and confirmation do not match');
      return;
    }
    const passwordIssue = getPasswordGuidance(passwordForm.newPassword, 'New password');
    if (passwordIssue) {
      setPasswordMsg(`Error: ${passwordIssue}`);
      return;
    }
    try {
      await api.changePassword(passwordForm.currentPassword, passwordForm.newPassword);
      setPasswordMsg('Password updated successfully');
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      setPasswordMsg(`Error: ${err.message}`);
    }
  };

  const handleProfileSave = async (e) => {
    e.preventDefault();
    setProfileMsg('');
    const displayName = profileForm.displayName.trim();
    const username = profileForm.username.trim();
    if (!username) {
      setProfileMsg('Error: Username is required');
      return;
    }
    if (username.length < 3) {
      setProfileMsg('Error: Username must be at least 3 characters');
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
      setProfileMsg('Error: Username can only use letters, numbers, periods, underscores, and hyphens');
      return;
    }
    if (!displayName) {
      setProfileMsg('Error: Display name is required');
      return;
    }
    setSavingProfile(true);
    try {
      const result = await api.updateProfile({ displayName, username });
      if (result?.user) setUser(result.user);
      setProfileMsg('Profile updated');
      toast.success('Profile updated');
    } catch (err) {
      const message = err.message || 'Failed to update profile';
      setProfileMsg(`Error: ${message}`);
      toast.error(message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleRefreshRates = async () => {
    setRefreshingRates(true);
    setRateRefreshMsg('');
    setRateRefreshKind('info');
    try {
      const result = await api.refreshGeminiRates();
      if (result.success) {
        setRateRefreshMsg('Rates updated successfully!');
        setRateRefreshKind('success');
        await loadSettings();
      } else {
        setRateRefreshMsg(result.message || 'Could not parse rates. Existing rates preserved.');
        setRateRefreshKind('warning');
      }
    } catch (err) {
      setRateRefreshMsg(`Error: ${err.message}`);
      setRateRefreshKind('error');
    } finally {
      setRefreshingRates(false);
    }
  };

  const handleRemoveCredential = async () => {
    if (!pendingCredentialDelete) return;
    setDeletingCredential(true);
    try {
      await api.deleteSetting(pendingCredentialDelete);
      const label = CREDENTIAL_DELETE_COPY[pendingCredentialDelete]?.label || 'Credential';
      setForm(prev => ({ ...prev, [pendingCredentialDelete]: '' }));
      setTestResults(prev => ({ ...prev, [pendingCredentialDelete]: '' }));
      toast.success(`${label} removed`);
      await loadSettings();
      setPendingCredentialDelete(null);
    } catch (err) {
      toast.error(err.message || 'Could not remove credential');
    } finally {
      setDeletingCredential(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="h-7 w-24 bg-ed-line rounded animate-pulse mb-1" />
          <div className="h-3 w-48 bg-ed-bg rounded animate-pulse" />
        </div>
        <div className="space-y-5 max-w-2xl">
          {[0, 1, 2].map(i => (
            <div key={i} className="card p-6 animate-pulse">
              <div className="h-4 w-24 bg-ed-line rounded mb-4" />
              <div className="space-y-4">
                <div>
                  <div className="h-3 w-28 bg-ed-bg rounded mb-1.5" />
                  <div className="h-9 w-full bg-ed-bg rounded-xl" />
                </div>
                <div>
                  <div className="h-3 w-32 bg-ed-bg rounded mb-1.5" />
                  <div className="h-9 w-full bg-ed-bg rounded-xl" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-serif font-[420] text-ed-ink tracking-tight">Settings</h1>
        <p className="text-[13px] text-ed-ink2 mt-0.5">API keys, integrations, and account</p>
      </div>

      <div className="space-y-5 max-w-2xl fade-in">
        {/* My Profile */}
        <div className="ed-card p-6">
          <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight mb-1 flex items-center gap-1">
            My Profile
            <InfoTooltip text="This name is used for the dashboard greeting and the account label in the navigation." position="right" />
          </h2>
          <p className="text-[12px] text-ed-ink3 mb-4">
            Choose the name your dashboard should use when it greets you.
          </p>
          {profileMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              profileMsg.startsWith('Error')
                ? 'bg-ed-rust/10 border border-ed-rust/30 text-ed-rust'
                : 'bg-ed-green/5 border border-ed-green/15 text-ed-green'
            }`}>
              {profileMsg}
            </div>
          )}
          <form onSubmit={handleProfileSave} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-ed-ink2 mb-1.5">Username</label>
              <input
                value={profileForm.username}
                onChange={e => setProfileForm(prev => ({ ...prev, username: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                placeholder="Username"
                autoComplete="username"
                maxLength={50}
              />
              <p className="text-[11px] text-ed-ink3 mt-1">Use this username when signing in.</p>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-ed-ink2 mb-1.5">Greeting Name</label>
              <input
                value={profileForm.displayName}
                onChange={e => setProfileForm(prev => ({ ...prev, displayName: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                placeholder="Your greeting name"
                maxLength={80}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingProfile}
                className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
              >
                {savingProfile ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </form>
        </div>

        {/* Your Password */}
        <div className="ed-card p-6">
          <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight mb-1 flex items-center gap-1">
            Your Password
            <InfoTooltip text="Use this form to change the password for the account you are currently signed into. Admin reset controls are only for other users." position="right" />
          </h2>
          <p className="text-[12px] text-ed-ink3 mb-4">
            Change your own password here. You will need your current password.
          </p>
          {passwordMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              passwordMsg.startsWith('Error')
                ? 'bg-ed-rust/10 border border-ed-rust/30 text-ed-rust'
                : 'bg-ed-green/5 border border-ed-green/15 text-ed-green'
            }`}>
              {passwordMsg}
            </div>
          )}
          <form onSubmit={handlePasswordChange} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-ed-ink2 mb-1.5">Current Password</label>
              <PasswordInput
                value={passwordForm.currentPassword}
                onChange={e => setPasswordForm(p => ({ ...p, currentPassword: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                autoComplete="current-password"
                required
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-ed-ink2 mb-1.5">New Password</label>
              <PasswordInput
                value={passwordForm.newPassword}
                onChange={e => setPasswordForm(p => ({ ...p, newPassword: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                autoComplete="new-password"
                required
                minLength={12}
              />
              <p className="text-[11px] text-ed-ink3 mt-1">
                Minimum 12 characters with letters and at least one number or symbol.
              </p>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-ed-ink2 mb-1.5">Confirm New Password</label>
              <PasswordInput
                value={passwordForm.confirmPassword}
                onChange={e => setPasswordForm(p => ({ ...p, confirmPassword: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                autoComplete="new-password"
                required
                minLength={12}
              />
            </div>
            <button type="submit" className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors">
              Update Your Password
            </button>
          </form>
        </div>

        {/* User Management */}
        <UserManagementCard currentUserId={user?.id} currentUsername={user?.username} />

        {/* API Keys */}
        <div className="ed-card p-6">
          <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight mb-4 flex items-center gap-1">API Keys <InfoTooltip text="Shared API keys used by the app for copy generation, image generation, cost tracking, Meta connection, and automation." position="right" /></h2>

          {message && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              message.startsWith('Error')
                ? 'bg-ed-rust/10 border border-ed-rust/30 text-ed-rust'
                : 'bg-ed-green/5 border border-ed-green/15 text-ed-green'
            }`}>
              {message}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="text-[13px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-2">
                OpenAI API Key
                <KeyStatusPill set={!!settings.openai_api_key} />
                <InfoTooltip text="Used for copywriting, Creative Director reasoning, GPT Image 2 image generation, and quality checks. GPT Image 2 also requires image-model access on the key's OpenAI organization." position="right" />
              </label>
              <div className="flex flex-wrap gap-2">
                <PasswordInput
                  value={form.openai_api_key}
                  onChange={e => setForm(p => ({ ...p, openai_api_key: e.target.value }))}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent flex-1 min-w-[220px]"
                  placeholder={settings.openai_api_key || 'Enter OpenAI API key'}
                />
                <button
                  onClick={() => testConnection('openai')}
                  disabled={testResults.openai === 'testing...'}
                  className="ed-ghost text-[13px] whitespace-nowrap inline-flex items-center gap-1.5"
                >
                  {testResults.openai === 'testing...' && (
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                  )}
                  Test
                </button>
                <button
                  onClick={() => testConnection('openai_image')}
                  disabled={testResults.openai_image === 'testing...'}
                  className="ed-ghost text-[13px] whitespace-nowrap inline-flex items-center gap-1.5"
                  title="Runs a billable low-quality GPT Image 2 access check."
                >
                  {testResults.openai_image === 'testing...' && (
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                  )}
                  Test GPT Image 2
                </button>
                <CredentialRemoveButton settingKey="openai_api_key" settings={settings} onRemove={setPendingCredentialDelete} />
              </div>
              {testResults.openai && <p className="text-[12px] text-ed-ink3 mt-1">{testResults.openai}</p>}
              {testResults.openai_image && <p className="text-[12px] text-ed-ink3 mt-1">{testResults.openai_image}</p>}
            </div>

            <div>
              <label className="text-[13px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-2">
                Gemini API Key
                <KeyStatusPill set={!!settings.gemini_api_key} />
                <InfoTooltip text="Used for Gemini image generation and batch generation. Gemini costs are tracked with the image rates below." position="right" />
              </label>
              <div className="flex gap-2">
                <PasswordInput
                  value={form.gemini_api_key}
                  onChange={e => setForm(p => ({ ...p, gemini_api_key: e.target.value }))}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent flex-1"
                  placeholder={settings.gemini_api_key || 'Enter Gemini API key'}
                />
                <button
                  onClick={() => testConnection('gemini')}
                  disabled={testResults.gemini === 'testing...'}
                  className="ed-ghost text-[13px] whitespace-nowrap inline-flex items-center gap-1.5"
                >
                  {testResults.gemini === 'testing...' && (
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                  )}
                  Test
                </button>
                <CredentialRemoveButton settingKey="gemini_api_key" settings={settings} onRemove={setPendingCredentialDelete} />
              </div>
              {testResults.gemini && <p className="text-[12px] text-ed-ink3 mt-1">{testResults.gemini}</p>}
            </div>

            <div>
              <label className="text-[13px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-2">
                Anthropic API Key
                <KeyStatusPill set={!!settings.anthropic_api_key} />
                <InfoTooltip text="Required for Creative Filter QA and Ready-to-Post copy generation. Test runs will stop before image generation if Anthropic is missing or invalid." position="right" />
              </label>
              <div className="flex gap-2">
                <PasswordInput
                  value={form.anthropic_api_key}
                  onChange={e => setForm(p => ({ ...p, anthropic_api_key: e.target.value }))}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent flex-1"
                  placeholder={settings.anthropic_api_key || 'Enter Anthropic API key'}
                />
                <button
                  onClick={() => testConnection('anthropic')}
                  className="ed-ghost text-[13px] whitespace-nowrap"
                >
                  Test
                </button>
                <CredentialRemoveButton settingKey="anthropic_api_key" settings={settings} onRemove={setPendingCredentialDelete} />
              </div>
              {testResults.anthropic && <p className="text-[12px] text-ed-ink3 mt-1">{testResults.anthropic}</p>}
            </div>

            <details className="rounded-xl border border-ed-line bg-ed-bg/60 px-4 py-3">
              <summary className="cursor-pointer text-[13px] font-medium text-ed-ink">How to set up Meta API access</summary>
              <div className="mt-3 space-y-2 text-[12px] leading-relaxed text-ed-ink2">
                <p>Create one Meta developer app for Thrive Campaigns, then reuse it for every project connection.</p>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Create or open a Meta app at <a className="underline" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">developers.facebook.com/apps</a>.</li>
                  <li>Add Facebook Login for Business and the Marketing API product if Meta prompts for products.</li>
                  <li>In the app's OAuth settings, add this exact redirect URI: <code className="bg-cream px-1 rounded">https://thrive-digital-marketing-ad-generat.vercel.app/api/meta/oauth/callback</code>.</li>
                  <li>Save the app's App ID and App Secret below.</li>
                  <li>Inside each project, open Project Settings &rarr; Meta, connect your Meta account, then choose the ad account and Facebook Page.</li>
                </ol>
                <p>The app requests Meta permissions for ads management, ads read access, business management, and Page listing so it can read analytics, prepare posts, select a Facebook Page, and support Direct API posting when you choose that path.</p>
              </div>
            </details>

            {/* Phase 2A — Meta App credentials. Used for the Facebook OAuth flow when projects connect their ad accounts. */}
            <div>
              <label className="text-[13px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-2">
                Meta App ID
                <KeyStatusPill set={!!settings.meta_app_id} />
                <InfoTooltip text="The Facebook App identifier used when projects connect their Meta ad account." position="right" />
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.meta_app_id}
                  onChange={e => setForm(p => ({ ...p, meta_app_id: e.target.value }))}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent flex-1"
                  placeholder={settings.meta_app_id || 'e.g. 1234567890123456'}
                />
                <CredentialRemoveButton settingKey="meta_app_id" settings={settings} onRemove={setPendingCredentialDelete} />
              </div>
              <p className="text-[11px] text-ed-ink3 mt-1">
                Create a Facebook App at <a className="underline" href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer">developers.facebook.com</a>.
                Set redirect URI to <code className="bg-cream px-1 rounded">https://thrive-digital-marketing-ad-generat.vercel.app/api/meta/oauth/callback</code>.
                Required for any project to connect its Meta ad account.
              </p>
            </div>

            <div>
              <label className="text-[13px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-2">
                Meta App Secret
                <KeyStatusPill set={!!settings.meta_app_secret} />
                <InfoTooltip text="The private secret for the Facebook App. Required for Meta OAuth and kept hidden after saving." position="right" />
              </label>
              <div className="flex gap-2">
                <PasswordInput
                  value={form.meta_app_secret}
                  onChange={e => setForm(p => ({ ...p, meta_app_secret: e.target.value }))}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent flex-1"
                  placeholder={settings.meta_app_secret ? '••••••••' : 'Enter Meta App Secret'}
                />
                <CredentialRemoveButton settingKey="meta_app_secret" settings={settings} onRemove={setPendingCredentialDelete} />
              </div>
            </div>
          </div>
        </div>

        {/* Gemini Rates */}
        <div className="ed-card p-6">
          <div className="flex justify-between items-start mb-1">
            <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight flex items-center gap-1">Gemini Image Rates <InfoTooltip text="Per-image pricing used for Gemini image cost tracking. Refresh pulls the latest known pricing; you can edit manually if pricing changes before the sync catches it." position="right" /></h2>
            <button
              onClick={handleRefreshRates}
              disabled={refreshingRates}
              className="ed-ghost text-[13px] whitespace-nowrap"
            >
              {refreshingRates ? (
                <span className="flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                  Refreshing...
                </span>
              ) : 'Refresh Rates Now'}
            </button>
          </div>
          <p className="text-[12px] text-ed-ink3 mb-4">
            Refresh pulls current Gemini image pricing from Google. You can edit these manually if the pricing page changes before the parser catches up.
            {settings.gemini_rates_updated_at && (
              <span> Last updated: {new Date(settings.gemini_rates_updated_at).toLocaleString()}</span>
            )}
          </p>

          {rateRefreshMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              rateRefreshKind === 'error'
                ? 'bg-ed-rust/10 border border-ed-rust/30 text-ed-rust'
                : rateRefreshKind === 'warning'
                  ? 'bg-ed-gold/10 border border-ed-gold/30 text-ed-ink2'
                : 'bg-ed-green/5 border border-ed-green/15 text-ed-green'
            }`}>
              {rateRefreshMsg}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-[12px] font-medium text-ed-ink2 mb-1.5">1K ($/image)</label>
              <input
                value={form.gemini_rate_1k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_1k: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                placeholder="e.g., 0.067"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-ed-ink2 mb-1.5">2K ($/image)</label>
              <input
                value={form.gemini_rate_2k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_2k: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                placeholder="e.g., 0.101"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-ed-ink2 mb-1.5">4K ($/image)</label>
              <input
                value={form.gemini_rate_4k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_4k: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
                placeholder="e.g., 0.151"
              />
            </div>
          </div>

          <div className="mt-5 pt-5 border-t border-black/5">
            <label className="block text-[12px] font-medium text-ed-ink2 mb-1.5 flex items-center gap-1">
              OpenAI Image ($/image)
              <InfoTooltip text="Manual estimate used for GPT Image 2 cost logging. Actual OpenAI image cost varies by quality, size, and reference-image input tokens. Defaults to $0.04." position="right" />
            </label>
            <input
              value={form.openai_image_rate_per_image}
              onChange={e => setForm(p => ({ ...p, openai_image_rate_per_image: e.target.value }))}
              className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent max-w-xs"
              placeholder="e.g., 0.04"
            />
          </div>
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>

      </div>

      {/* Roadmap */}
      <TodoWidget />
      <ConfirmDialog
        open={!!pendingCredentialDelete}
        title={`Remove ${CREDENTIAL_DELETE_COPY[pendingCredentialDelete]?.label || 'credential'}?`}
        message={CREDENTIAL_DELETE_COPY[pendingCredentialDelete]?.message || 'Remove this saved setting?'}
        confirmLabel="Remove"
        cancelLabel="Keep"
        tone="danger"
        busy={deletingCredential}
        onConfirm={handleRemoveCredential}
        onCancel={() => !deletingCredential && setPendingCredentialDelete(null)}
      />
    </div>
  );
}

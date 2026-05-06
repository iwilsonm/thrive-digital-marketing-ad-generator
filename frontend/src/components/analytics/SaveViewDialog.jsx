import { useState } from 'react';

export default function SaveViewDialog({ open, onClose, onSave }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('private');
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), scope });
      setName('');
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="bg-ed-surface rounded-2xl shadow-card w-[400px] max-w-[92vw] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-ed-ink">Save view</h3>
          <button onClick={onClose} className="text-ed-ink2 hover:text-ed-ink text-[18px] leading-none">×</button>
        </div>

        <label className="block text-[12px] font-medium text-ed-ink2 mb-1">View name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Top spenders"
          className="input-apple text-[13px] mb-4"
        />

        <label className="block text-[12px] font-medium text-ed-ink2 mb-2">Visibility</label>
        <div className="space-y-1.5 mb-5">
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="radio" checked={scope === 'private'} onChange={() => setScope('private')} className="mt-1" />
            <div>
              <div className="text-[13px] text-ed-ink">Private</div>
              <div className="text-[11px] text-ed-ink3">Only you can see this view.</div>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} className="mt-1" />
            <div>
              <div className="text-[13px] text-ed-ink">Shared with project</div>
              <div className="text-[11px] text-ed-ink3">Everyone on this project can see and use it.</div>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="ed-ghost text-[12px]">Cancel</button>
          <button
            onClick={submit}
            disabled={!name.trim() || saving}
            className="px-3 py-1.5 rounded-[6px] text-[11px] bg-ed-accent text-white text-[12px]"
          >
            {saving ? 'Saving…' : 'Save view'}
          </button>
        </div>
      </div>
    </div>
  );
}

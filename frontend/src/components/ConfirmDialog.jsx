import { createPortal } from 'react-dom';

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
  busy = false,
}) {
  if (!open) return null;

  const confirmClass = tone === 'danger'
    ? 'bg-ed-rust hover:bg-ed-rust/90 text-white'
    : 'bg-ed-accent hover:bg-ed-accent/90 text-white';

  const dialog = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 fade-in">
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-sm"
        onClick={() => !busy && onCancel?.()}
      />
      <div className="relative bg-ed-surface border border-ed-line rounded-xl shadow-card w-full max-w-md p-6">
        <h3 className="font-serif text-[16px] font-[420] text-ed-ink tracking-tight">{title}</h3>
        <p className="text-[13px] text-ed-ink2 mt-2">{message}</p>
        <div className="flex items-center justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ed-ghost text-[13px] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`px-4 py-2 rounded-[7px] text-[13px] font-medium transition-colors disabled:opacity-50 ${confirmClass}`}
          >
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(dialog, document.body);
}

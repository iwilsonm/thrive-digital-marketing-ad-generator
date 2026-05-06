// Phase 2B — Warning modal shown before posting via direct Marketing API.
// Marco specified the copy: "People have been banned by posting ads via API."
// Modal fires:
//   1) Once when user toggles integration_path to "api" (caller decides)
//   2) Once per session per project on first Post when path === "api"
//      (state in sessionStorage; key: meta_api_warning_dismissed_<projectId>)

export default function ApiWarningDialog({ open, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-ed-surface rounded-2xl shadow-card-hover max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center text-xl font-bold">!</div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-ed-ink mb-1">Posting via direct API</h3>
            <p className="text-sm text-ed-ink2">
              Direct API posting can carry account risk. The connector path is the safer option when available.
            </p>
            <p className="text-sm text-ed-ink2 mt-2">
              If you understand the risk and want to continue, click <strong>Yes, post via API</strong>. Otherwise cancel and switch to the connector path in Project Settings → Meta.
            </p>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="ed-ghost">Cancel</button>
          <button type="button" onClick={onConfirm} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors bg-orange-600 hover:bg-orange-700">
            Yes, post via API
          </button>
        </div>
      </div>
    </div>
  );
}

// Helper: should the warning fire for this project this session?
export function shouldShowApiWarning(projectId) {
  if (typeof window === 'undefined') return true;
  return !sessionStorage.getItem(`meta_api_warning_dismissed_${projectId}`);
}

// Helper: mark the warning as dismissed for this session
export function markApiWarningDismissed(projectId) {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(`meta_api_warning_dismissed_${projectId}`, '1');
}

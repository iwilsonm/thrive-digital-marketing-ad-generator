import { forwardRef } from 'react';

function formatStartTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function getTimeEstimate(startTime, progress) {
  if (!startTime || progress < 3) return null;
  const elapsed = (Date.now() - startTime) / 1000;
  if (elapsed < 5) return null;
  const rate = progress / elapsed;
  if (rate <= 0) return null;
  const remaining = Math.round((100 - progress) / rate);
  if (remaining < 5) return 'Almost done';
  if (remaining < 60) return `~${remaining}s`;
  return `~${Math.ceil(remaining / 60)}m`;
}

const GenerationQueue = forwardRef(function GenerationQueue(
  { activeGens, genQueueExpanded, setGenQueueExpanded, activeGenCount, dismissGen, onCancelGeneration, onErrorAction, ...props },
  ref
) {
  if (activeGens.length === 0) return null;

  return (
    <div ref={ref} className="ed-card p-4 mb-6 fade-in" {...props}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-ed-green/10 flex items-center justify-center flex-shrink-0">
            {activeGenCount > 0 ? (
              <div className="w-3 h-3 rounded-full border-2 border-ed-green/30 border-t-teal animate-spin" />
            ) : (
              <svg className="w-3 h-3 text-ed-green" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
            )}
          </div>
          <h3 className="text-[14px] font-semibold text-ed-ink tracking-tight">Ad Queue</h3>
          <span className="text-[11px] text-ed-ink3">
            {activeGenCount > 0
              ? `${activeGenCount} generating...`
              : 'All complete'}
          </span>
        </div>
        <button
          onClick={() => setGenQueueExpanded(!genQueueExpanded)}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 px-2 py-1 rounded-md cursor-pointer transition-all"
        >
          <svg className={`w-3.5 h-3.5 transition-transform ${genQueueExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          Details
        </button>
      </div>

      {genQueueExpanded && (
        <div className="space-y-1.5">
          {(() => {
            const pending = activeGens.filter(g => g.status && g.status !== 'completed' && !g.error);

            return activeGens.map((gen) => {
              const queuePos = pending.findIndex(g => g.id === gen.id);
              const batchNum = queuePos >= 0 ? Math.floor(queuePos / 2) : 0;
              const baseSeconds = 50;
              const estSeconds = baseSeconds + batchNum * 60;
              const estLabel = estSeconds < 120 ? `~${estSeconds}s` : `~${(estSeconds / 60).toFixed(1)} min`;

              return (
                <div key={gen.id} className="px-3 py-2 rounded-lg bg-ed-bg/80 space-y-1.5">
                  <div className="flex items-center gap-3">
                    {gen.error ? (
                      <svg className="w-3.5 h-3.5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                    ) : gen.status === 'completed' || gen.status === 'cancelled' ? (
                      <svg className="w-3.5 h-3.5 text-ed-green flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 text-ed-accent animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                      </svg>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className={`text-[12px] font-medium truncate ${gen.error ? 'text-red-600' : gen.status === 'completed' || gen.status === 'cancelled' ? 'text-ed-green' : 'text-ed-ink'}`}>
                        {gen.label && <span className="text-ed-ink3 mr-1.5">{gen.label}</span>}
                        {gen.error || gen.message || 'Starting...'}
                      </p>
                      {gen.warning && (
                        <p className="text-[10px] text-ed-accent truncate">{gen.warning}</p>
                      )}
                      {gen.error && gen.errorCode === 'MISSING_PRODUCT_DESCRIPTION' && gen.errorActionUrl && (
                        <button
                          type="button"
                          onClick={() => onErrorAction?.(gen)}
                          className="mt-1 inline-flex items-center rounded-md bg-ed-rust/10 px-2 py-1 text-[10px] font-semibold text-ed-rust hover:bg-ed-rust/15 transition-colors"
                        >
                          {gen.errorActionLabel || 'Edit Product Description'}
                        </button>
                      )}
                    </div>
                    {!gen.error && gen.status !== 'completed' && gen.status !== 'cancelled' && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-[10px] font-medium text-ed-accent">{gen.progress || 0}%</span>
                        {gen.startTime && getTimeEstimate(gen.startTime, gen.progress || 0) && (
                          <span className="text-[9px] text-ed-ink3">{getTimeEstimate(gen.startTime, gen.progress || 0)}</span>
                        )}
                      </div>
                    )}
                    {!gen.error && gen.status !== 'completed' && gen.status !== 'cancelled' && gen.adExternalId && (
                      <button
                        type="button"
                        onClick={() => onCancelGeneration?.(gen)}
                        disabled={gen.cancelling}
                        className="text-[10px] font-semibold text-ed-rust hover:text-ed-rust disabled:opacity-50 flex-shrink-0 transition-colors px-2 py-1 rounded-md hover:bg-ed-rust/5"
                      >
                        {gen.cancelling ? 'Cancelling...' : 'Cancel'}
                      </button>
                    )}
                    {(gen.error || gen.status === 'completed' || gen.status === 'cancelled') && (
                      <button onClick={() => dismissGen(gen.id)} className="text-ed-ink3/50 hover:text-ed-ink2 flex-shrink-0 transition-colors">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    )}
                  </div>
                  {/* Progress bar — shown for active generations */}
                  {!gen.error && gen.status !== 'completed' && gen.status !== 'cancelled' && (
                    <div className="w-full bg-black/5 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{
                          width: `${Math.max(gen.progress || 0, 2)}%`,
                          background: (gen.progress || 0) >= 100
                            ? '#38A638'
                            : 'linear-gradient(90deg, #38A638, #2F8F2F)',
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
});

export default GenerationQueue;

import { useEffect, useState } from 'react';

/**
 * PipelineProgress — Shared progress bar for all long-running SSE pipelines.
 *
 * Reference implementation: LPAgentSettings.jsx test generation progress bar.
 *
 * Pattern:
 *   Backend emits: { type: 'progress', step: 'step_name', message: '...' }
 *   Frontend maps step names → percentages (STEP_PROGRESS) and labels (STEP_LABELS)
 *   This component renders the progress bar + status line.
 *
 * Props:
 *   progress  (number 0-100)  — current percentage
 *   message   (string)        — current status text
 *   startTime (number|null)   — Date.now() timestamp for time display
 *   timeMode  ('estimate'|'elapsed') — show ETA or elapsed runtime
 *   className (string)        — optional wrapper class
 */
export default function PipelineProgress({ progress = 0, message = '', startTime = null, timeMode = 'estimate', className = '' }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!startTime || progress >= 100) return undefined;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [startTime, progress]);

  const formatElapsed = () => {
    if (!startTime) return null;
    const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    if (elapsed < 5) return null;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    if (mins < 1) return `Elapsed ${secs}s`;
    if (mins < 60) return secs > 0 ? `Elapsed ${mins}m ${secs}s` : `Elapsed ${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `Elapsed ${hours}h ${remMins}m` : `Elapsed ${hours}h`;
  };

  const getTimeEstimate = () => {
    if (!startTime || progress < 3) return null;
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed < 5) return null;
    const rate = progress / elapsed;
    if (rate <= 0) return null;
    const remaining = Math.round((100 - progress) / rate);
    if (remaining < 5) return 'Almost done';
    if (remaining < 60) return `~${remaining}s remaining`;
    return `~${Math.ceil(remaining / 60)}m remaining`;
  };

  const timeLabel = timeMode === 'elapsed' ? formatElapsed() : getTimeEstimate();

  return (
    <div className={`space-y-1.5 ${className}`}>
      {/* Progress bar */}
      <div className="w-full bg-black/5 rounded-full h-2 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${Math.max(progress, 2)}%`,
            background: progress >= 100
              ? '#38A638'
              : 'linear-gradient(90deg, #38A638, #2F8F2F)',
          }}
        />
      </div>
      {/* Status line */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          {progress < 100 && (
            <svg className="w-3 h-3 text-ed-accent animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
          )}
          {progress >= 100 && (
            <svg className="w-3 h-3 text-ed-green flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          )}
          <span className="text-[10px] text-ed-ink2 truncate">{message || 'Starting...'}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <span className={`text-[10px] font-medium ${progress >= 100 ? 'text-ed-green' : 'text-ed-accent'}`}>{progress}%</span>
          {progress < 100 && timeLabel && (
            <span className="text-[9px] text-ed-ink3">{timeLabel}</span>
          )}
        </div>
      </div>
    </div>
  );
}

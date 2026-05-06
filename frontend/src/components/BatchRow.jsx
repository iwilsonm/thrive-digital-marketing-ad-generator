import { useState } from 'react';
import PipelineProgress from './PipelineProgress';
import {
  CRON_PRESETS, INTERVAL_UNITS, ASPECT_RATIOS,
  STATUS_COLORS, STATUS_LABELS,
  intervalToCron, cronToLabel, parseCronToInterval,
  getNextRun, formatNextRun, formatDate, formatDuration
} from './batchUtils';

const LP_STATUS_STYLES = {
  generating: 'bg-ed-accent/10 text-ed-accent',
  published: 'bg-ed-accent/10 text-ed-accent',
  live: 'bg-ed-green/10 text-ed-green',
  failed: 'bg-ed-rust/10 text-ed-rust',
};

function LPBadge({ label, status, url }) {
  const style = LP_STATUS_STYLES[status] || LP_STATUS_STYLES.generating;
  const text = `${label}: ${status.charAt(0).toUpperCase() + status.slice(1)}`;
  if (url && (status === 'live' || status === 'published')) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={`badge text-[10px] ${style} hover:opacity-80`} title={url}>
        {text} ↗
      </a>
    );
  }
  return <span className={`badge text-[10px] ${style}`}>{text}</span>;
}

export default function BatchRow({ batch, onRunNow, onCancel, onDelete, onEdit, onPause, onResume }) {
  const isQueued = batch.status === 'queued';
  const isActive = ['generating_prompts', 'submitting', 'processing', 'saving_results'].includes(batch.status);
  const canRun = ['pending', 'completed', 'failed'].includes(batch.status);
  const canCancel = isQueued || isActive;
  const isPaused = !batch.scheduled && !!batch.schedule_cron;
  const canPause = !!batch.scheduled && !!batch.schedule_cron;
  const canEdit = (!isQueued && !isActive) || !!batch.scheduled;

  const [editing, setEditing] = useState(false);
  const [editSize, setEditSize] = useState(batch.batch_size);
  const [editAngle, setEditAngle] = useState(batch.angle || '');
  const [editAspect, setEditAspect] = useState(batch.aspect_ratio || '1:1');
  const [editScheduled, setEditScheduled] = useState(!!batch.scheduled);
  const [editCronPreset, setEditCronPreset] = useState(() => {
    if (!batch.schedule_cron) return '0 9 * * *';
    const match = CRON_PRESETS.find(p => p.value === batch.schedule_cron && p.value !== 'custom');
    return match ? match.value : 'custom';
  });
  const [editIntervalAmount, setEditIntervalAmount] = useState(() => {
    if (!batch.schedule_cron) return 30;
    const parsed = parseCronToInterval(batch.schedule_cron);
    return parsed ? parsed.amount : 30;
  });
  const [editIntervalUnit, setEditIntervalUnit] = useState(() => {
    if (!batch.schedule_cron) return 'minutes';
    const parsed = parseCronToInterval(batch.schedule_cron);
    return parsed ? parsed.unit : 'minutes';
  });
  const [saving, setSaving] = useState(false);

  const getEditCron = () => {
    if (editCronPreset === 'custom') return intervalToCron(editIntervalAmount, editIntervalUnit);
    return editCronPreset;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onEdit(batch.id, {
        batch_size: editSize,
        angle: editAngle.trim() || '',
        aspect_ratio: editAspect,
        scheduled: editScheduled,
        schedule_cron: editScheduled ? getEditCron() : undefined,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  // Parse batch_stats for progress bar
  let batchStats = null;
  if (batch.batch_stats) {
    try {
      batchStats = typeof batch.batch_stats === 'string' ? JSON.parse(batch.batch_stats) : batch.batch_stats;
    } catch {}
  }
  const progressTotal = batchStats?.totalCount || batchStats?.totalRequests || 0;
  const progressDone = (batchStats?.successfulCount || batchStats?.succeededRequests || 0) + (batchStats?.failedCount || batchStats?.failedRequests || 0);
  const progressPct = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : 0;

  // Parse pipeline_state for stage-level progress
  let pipelineState = null;
  if (batch.pipeline_state) {
    try {
      pipelineState = typeof batch.pipeline_state === 'string' ? JSON.parse(batch.pipeline_state) : batch.pipeline_state;
    } catch {}
  }
  const pipelineStage = pipelineState?.stage ?? null;
  const pipelineCurrent = pipelineState?.current || 0;
  const pipelineTotal = pipelineState?.total || 0;
  const pipelinePct = pipelineStage === 3 && pipelineTotal > 0
    ? Math.round((pipelineCurrent / pipelineTotal) * 100)
    : pipelineStage === 'complete' ? 100
    : pipelineStage === 2 ? 60
    : pipelineStage === 1 ? 30
    : pipelineStage === 0 ? 10
    : 0;

  // Unified progress percentage for the standard progress bar
  const getOverallProgress = () => {
    if (batch.status === 'completed') return { pct: 100, msg: 'Complete' };
    if (batch.status === 'failed') return { pct: 0, msg: batch.error_message || 'Failed' };
    if (batch.status === 'queued') return { pct: 2, msg: 'Queued for batch worker...' };
    if (batch.status === 'generating_prompts' && pipelineState) {
      // Stages 0-3 map to 5-75%
      const stagePcts = { 0: 5, 1: 20, 2: 40, 3: 65 };
      const stageRanges = { 0: [5, 20], 1: [20, 40], 2: [40, 65], 3: [65, 75] };
      const base = stagePcts[pipelineStage] || 5;
      const range = stageRanges[pipelineStage];
      let pct = base;
      if (range && pipelineTotal > 0) {
        pct = range[0] + Math.round((pipelineCurrent / pipelineTotal) * (range[1] - range[0]));
      }
      return { pct, msg: pipelineState.stage_label || `Stage ${pipelineStage}` };
    }
    if (batch.status === 'submitting') return { pct: 80, msg: 'Submitting to image API...' };
    if (batch.status === 'processing') {
      // 85-98% range based on batch_stats
      const pct = progressTotal > 0 ? 85 + Math.round((progressDone / progressTotal) * 13) : 85;
      return { pct, msg: `${progressDone}/${progressTotal} images generated` };
    }
    if (batch.status === 'saving_results') return { pct: 98, msg: 'Saving generated ads...' };
    return { pct: 2, msg: 'Pending...' };
  };

  return (
    <div className="rounded-xl bg-black/[0.02] border border-black/5 hover:bg-black/[0.03] transition-colors">
      <div className="flex items-center gap-3 p-3">
        {/* Status indicator */}
        <div className="flex-shrink-0">
          {isActive ? (
            <div className="w-5 h-5 rounded-full border-2 border-ed-accent/20 border-t-ed-accent animate-spin" />
          ) : isQueued ? (
            <div className="w-5 h-5 rounded-full bg-black/5 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-textmid" />
            </div>
          ) : batch.status === 'completed' ? (
            <div className="w-5 h-5 rounded-full bg-ed-green/10 flex items-center justify-center">
              <svg className="w-3 h-3 text-ed-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          ) : batch.status === 'failed' ? (
            <div className="w-5 h-5 rounded-full bg-ed-rust/10 flex items-center justify-center">
              <svg className="w-3 h-3 text-ed-rust" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
          ) : (
            <div className="w-5 h-5 rounded-full bg-black/5 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-textlight" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium text-ed-ink">
              {batch.batch_size} image{batch.batch_size !== 1 ? 's' : ''}
            </span>
            <span className={`badge text-[10px] ${STATUS_COLORS[batch.status] || STATUS_COLORS.pending}`}>
              {batch.status === 'generating_prompts' && batch.pipeline_state
                ? (() => {
                    try {
                      const ps = JSON.parse(batch.pipeline_state);
                      return ps.stage_label || STATUS_LABELS[batch.status];
                    } catch { return STATUS_LABELS[batch.status]; }
                  })()
                : (STATUS_LABELS[batch.status] || batch.status)}
            </span>
            {batch.schedule_cron ? (
              batch.scheduled ? (
                <span className="badge bg-ed-accent/10 text-ed-accent text-[10px]">
                  {cronToLabel(batch.schedule_cron)}
                </span>
              ) : (
                <span className="badge bg-orange-100/80 text-orange-600 text-[10px]">
                  Paused · {cronToLabel(batch.schedule_cron)}
                </span>
              )
            ) : null}
            {batch.retry_count > 0 && (
              <span className="badge bg-ed-accent/10 text-ed-accent text-[10px]">
                {batch.retry_count}/3 retries
              </span>
            )}
            {batch.lp_primary_status && (
              <LPBadge label="LP1" status={batch.lp_primary_status} url={batch.lp_primary_url} />
            )}
            {batch.lp_secondary_status && (
              <LPBadge label="LP2" status={batch.lp_secondary_status} url={batch.lp_secondary_url} />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[11px] text-ed-ink3">{batch.aspect_ratio}</span>
            {batch.angle && (
              <>
                <span className="text-[11px] text-ed-ink3/60">|</span>
                <span className="text-[11px] text-ed-ink2 truncate" title={batch.angle}>
                  {batch.angle}
                </span>
              </>
            )}
            {batch.completed_count > 0 && (
              <>
                <span className="text-[11px] text-ed-ink3/60">|</span>
                <span className="text-[11px] text-ed-green">{batch.completed_count} saved</span>
                {batch.failed_count > 0 && (
                  <span className="text-[11px] text-ed-rust">· {batch.failed_count} failed</span>
                )}
                {batch.run_count > 1 && (
                  <span className="text-[11px] text-ed-ink3">· {batch.run_count} runs</span>
                )}
              </>
            )}
            {batch.error_message && (
              <>
                <span className="text-[11px] text-ed-ink3/60">|</span>
                <span className="text-[11px] text-ed-rust truncate" title={batch.error_message}>
                  {batch.error_message.slice(0, 50)}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ed-ink3">{formatDate(batch.created_at)}</span>
            {batch.status === 'completed' && formatDuration(batch.started_at, batch.completed_at) && (
              <>
                <span className="text-[10px] text-ed-ink3/60">·</span>
                <span className="text-[10px] text-ed-green">Completed in {formatDuration(batch.started_at, batch.completed_at)}</span>
              </>
            )}
            {!!batch.scheduled && batch.schedule_cron && (() => {
              const next = getNextRun(batch.schedule_cron);
              const label = formatNextRun(next);
              return label ? (
                <>
                  <span className="text-[10px] text-ed-ink3/60">·</span>
                  <span className="text-[10px] text-ed-accent/60">Next: {label}</span>
                </>
              ) : null;
            })()}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {canPause && (
            <button
              onClick={() => onPause(batch.id)}
              className="text-[11px] text-orange-500 hover:text-orange-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-orange-50/50"
              title="Pause automation"
            >
              Pause
            </button>
          )}
          {isPaused && (
            <button
              onClick={() => onResume(batch.id)}
              className="text-[11px] text-ed-green hover:text-ed-green/80 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-ed-green/5"
              title="Resume automation"
            >
              Resume
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => onCancel(batch.id)}
              className="text-[11px] text-ed-accent hover:text-ed-accent/80 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-ed-accent/5"
              title="Cancel batch"
            >
              Cancel
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setEditing(!editing)}
              className="text-[11px] text-ed-ink3 hover:text-ed-ink2 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-black/[0.02]"
              title="Edit batch"
            >
              {editing ? 'Close' : 'Edit'}
            </button>
          )}
          {canRun && (
            <button
              onClick={() => onRunNow(batch.id)}
              className="text-[11px] text-ed-accent hover:text-ed-accent/80 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-ed-accent/5"
              title="Run now"
            >
              Run
            </button>
          )}
          <button
            onClick={() => onDelete(batch.id)}
            className="text-[11px] text-ed-rust hover:text-ed-rust font-medium transition-colors px-2 py-1 rounded-lg hover:bg-ed-rust/5"
            title="Delete"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Inline edit panel */}
      {editing && (
        <div className="px-3 pb-3 pt-1 border-t border-black/5 fade-in">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <div>
              <label className="block text-[10px] font-medium text-ed-ink3 mb-0.5">Batch Size</label>
              <input
                type="number"
                min={1}
                max={50}
                value={editSize}
                onChange={e => setEditSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                disabled={saving}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px] py-1.5"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-ed-ink3 mb-0.5">Aspect Ratio</label>
              <select
                value={editAspect}
                onChange={e => setEditAspect(e.target.value)}
                disabled={saving}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px] py-1.5"
              >
                {ASPECT_RATIOS.map(ar => (
                  <option key={ar.value} value={ar.value}>{ar.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-medium text-ed-ink3 mb-0.5">Ad Topic / Angle</label>
              <input
                value={editAngle}
                onChange={e => setEditAngle(e.target.value)}
                disabled={saving}
                placeholder='e.g., "before & after"'
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px] py-1.5"
              />
            </div>
          </div>

          {/* Schedule editing */}
          <div className="flex items-center gap-2 mb-2">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={editScheduled}
                onChange={e => setEditScheduled(e.target.checked)}
                disabled={saving}
                className="w-3.5 h-3.5 rounded border-black/10 text-ed-accent focus:ring-ed-accent/20"
              />
              <span className="text-[11px] text-ed-ink2 font-medium">Scheduled</span>
            </label>
          </div>
          {editScheduled && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              <select
                value={editCronPreset}
                onChange={e => setEditCronPreset(e.target.value)}
                disabled={saving}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px] py-1.5"
              >
                {CRON_PRESETS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              {editCronPreset === 'custom' && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={INTERVAL_UNITS.find(u => u.value === editIntervalUnit)?.min || 1}
                    max={INTERVAL_UNITS.find(u => u.value === editIntervalUnit)?.max || 60}
                    value={editIntervalAmount}
                    onChange={e => {
                      const unit = INTERVAL_UNITS.find(u => u.value === editIntervalUnit);
                      const val = parseInt(e.target.value) || unit?.min || 1;
                      setEditIntervalAmount(Math.max(unit?.min || 1, Math.min(unit?.max || 60, val)));
                    }}
                    disabled={saving}
                    className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-16 text-center text-[12px] py-1.5"
                  />
                  <select
                    value={editIntervalUnit}
                    onChange={e => {
                      setEditIntervalUnit(e.target.value);
                      const unit = INTERVAL_UNITS.find(u => u.value === e.target.value);
                      if (unit && editIntervalAmount < unit.min) setEditIntervalAmount(unit.min);
                      if (unit && editIntervalAmount > unit.max) setEditIntervalAmount(unit.max);
                    }}
                    disabled={saving}
                    className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent flex-1 text-[12px] py-1.5"
                  >
                    {INTERVAL_UNITS.map(u => (
                      <option key={u.value} value={u.value}>{u.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[11px] py-1 px-3"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="text-[11px] text-ed-ink3 hover:text-ed-ink2 transition-colors px-2 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Progress bar for queued/active batches */}
      {(isQueued || isActive) && (() => {
        const { pct, msg } = getOverallProgress();
        return (
          <div className="px-3 pb-3">
            <PipelineProgress
              progress={pct}
              message={msg}
              startTime={batch.started_at ? new Date(batch.started_at).getTime() : null}
              timeMode="elapsed"
            />
          </div>
        );
      })()}
    </div>
  );
}

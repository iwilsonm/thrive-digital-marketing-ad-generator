import { useState, useEffect, useCallback, useRef, useMemo, useContext } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';
import PipelineProgress from './PipelineProgress';
import { useToast } from './Toast';
import { ensureArray } from '../utils/collections';
import CreativeDirectorSettings from './CreativeDirectorSettings';
import CreativeFilterSettings from './CreativeFilterSettings';
import InfoTooltip from './InfoTooltip';
import TemplateTagHelp from './TemplateTagHelp';
import EditorialPageHeader from './editorial/EditorialPageHeader';
import { buildAnglePromptText } from '../utils/anglePrompt';

const LEVEL_CONFIG = {
  OK:        { color: 'text-ed-green',       icon: '\u2713', bg: 'bg-ed-green/10' },
  INFO:      { color: 'text-ed-ink2',    icon: '\u2022', bg: 'bg-black/5' },
  WARN:      { color: 'text-ed-accent',       icon: '\u26A0', bg: 'bg-ed-accent/10' },
  ERROR:     { color: 'text-ed-rust',    icon: '\u2717', bg: 'bg-ed-rust/10' },
  RESURRECT: { color: 'text-ed-accent-light', icon: '\u21BB', bg: 'bg-ed-accent/10' },
  SCORE:     { color: 'text-purple-500', icon: '\u2605', bg: 'bg-purple-50' },
};

const STATUS_CONFIG = {
  online:  { color: 'text-ed-green',      dot: 'bg-ed-green',      label: 'Online',  pulse: true },
  warning: { color: 'text-ed-accent',      dot: 'bg-ed-accent',      label: 'Delayed', pulse: true },
  offline: { color: 'text-ed-rust',   dot: 'bg-ed-rust',   label: 'Offline', pulse: false },
  paused:  { color: 'text-ed-ink3', dot: 'bg-ed-ink3', label: 'Paused',  pulse: false },
};

function getTemplateTags(templates = []) {
  return [...new Set((templates || [])
    .filter(t => !t.archived_at)
    .flatMap(t => Array.isArray(t.tags) ? t.tags : [])
    .map(tag => String(tag || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function getAngleTags(angles = []) {
  return [...new Set((angles || [])
    .filter(angle => angle.status === 'active' || angle.status === 'testing')
    .flatMap(angle => Array.isArray(angle.tags) ? angle.tags : [])
    .map(tag => String(tag || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function angleHasTag(angle, tag) {
  const normalized = String(tag || '').trim().toLowerCase();
  if (!normalized) return true;
  return Array.isArray(angle?.tags)
    && angle.tags.some(value => String(value || '').trim().toLowerCase() === normalized);
}

const REQUIRED_FOUNDATIONAL_DOC_TYPES = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];

function hasCompleteFoundationalDocs(docs = []) {
  const types = new Set(ensureArray(docs, 'AgentMonitor.director.foundationalDocs').map(doc => doc?.doc_type).filter(Boolean));
  return REQUIRED_FOUNDATIONAL_DOC_TYPES.every(type => types.has(type));
}

function normalizeAngleNameForMatch(name) {
  return String(name || '').trim().toLowerCase();
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return 'just now';
  if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    return `${mins} min${mins !== 1 ? 's' : ''} ago`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours}h ago`;
  }
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeUntil(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((new Date(dateStr).getTime() - Date.now()) / 1000);
  if (diff <= 0) return 'any moment';
  if (diff < 60) return `~${diff}s`;
  const mins = Math.ceil(diff / 60);
  return `~${mins} min`;
}

function formatDateTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms) {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (!totalSeconds) return '0s';

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

function safeParseJSON(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getRunRounds(run) {
  if (!run) return [];
  if (Array.isArray(run.rounds)) {
    return ensureArray(run.rounds, 'AgentMonitor.run.rounds');
  }
  return ensureArray(safeParseJSON(run.rounds_json, []), 'AgentMonitor.run.rounds_json');
}

function getRunBatches(run) {
  if (!run) return [];
  if (Array.isArray(run.batches)) {
    return ensureArray(run.batches, 'AgentMonitor.run.batches');
  }
  return ensureArray(safeParseJSON(run.batches_created, []), 'AgentMonitor.run.batches_created');
}

function getRoundStatusClasses(round) {
  return round.status === 'threshold_reached' ? 'bg-ed-green/10 text-ed-green' : 'bg-ed-accent/10 text-ed-accent';
}

function getRunStatusLabel(run) {
  switch (run.terminal_status) {
    case 'deployed':
      return 'deployed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting_on_gemini':
      return 'waiting on Gemini';
    case 'building_round':
      return 'building next round';
    case 'provider_failed':
      return 'provider failed';
    case 'failed_under_threshold_after_round_cap':
    case 'failed_under_threshold_after_54':
      return 'cap reached';
    case 'generation_failed':
      return 'generation failed';
    case 'grouping_failed':
      return 'grouping failed';
    case 'deploy_failed':
      return 'deploy failed';
    case 'batch_created':
      return 'batch created';
    default:
      return run.status || 'unknown';
  }
}

function getRunStatusClasses(run) {
  if (run.status === 'completed' && run.terminal_status === 'deployed') {
    return 'bg-ed-green/10 text-ed-green';
  }
  if (run.status === 'running') {
    return 'bg-ed-accent/10 text-ed-accent';
  }
  if (run.terminal_status === 'cancelled') {
    return 'bg-black/5 text-ed-ink2';
  }
  if (run.status === 'failed') {
    return 'bg-ed-rust/10 text-ed-rust';
  }
  return 'bg-black/5 text-ed-ink2';
}

function formatLaneLabel(lane) {
  if (!lane) return 'Unassigned';
  return lane
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatFailureLabel(key) {
  const labels = {
    spelling_grammar: 'Spelling / grammar',
    first_line_hook: 'First-line hook',
    cta_at_end: 'CTA at end',
    headline_alignment: 'Headline alignment',
    image_completeness: 'Image completeness',
  };
  return labels[key] || formatLaneLabel(key);
}

function formatBooleanStatus(value) {
  if (value === true) return 'Passed';
  if (value === false) return 'Failed';
  return '—';
}

function getLPStatusClasses(status) {
  switch (status) {
    case 'live':
    case 'published':
    case 'passed':
    case 'passed_dry_run':
      return 'bg-ed-green/10 text-ed-green';
    case 'generating':
    case 'scoring':
    case 'retrying':
      return 'bg-ed-accent/10 text-ed-accent';
    case 'failed':
    case 'error':
    case 'publish_failed':
    case 'smoke_failed':
      return 'bg-ed-rust/10 text-ed-rust';
    case 'skipped':
      return 'bg-black/5 text-ed-ink2';
    default:
      return 'bg-black/5 text-ed-ink2';
  }
}

function getRoundLaneEntries(round) {
  if (!round?.lane_distribution || typeof round.lane_distribution !== 'object') return [];
  return Object.entries(round.lane_distribution)
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => {
      const countDiff = Number(right[1]) - Number(left[1]);
      return countDiff !== 0 ? countDiff : String(left[0]).localeCompare(String(right[0]));
    });
}

function hasHeadlineDiagnostics(round) {
  return (
    round &&
    (
      round.headline_candidates !== undefined ||
      round.duplicate_rejections !== undefined ||
      round.history_rejections !== undefined ||
      getRoundLaneEntries(round).length > 0
    )
  );
}

function RoundHeadlineDiagnostics({ round }) {
  if (!hasHeadlineDiagnostics(round)) return null;

  const laneEntries = getRoundLaneEntries(round);
  const headlineCandidates = Number(round.headline_candidates);
  const duplicateRejections = Number(round.duplicate_rejections);
  const historyRejections = Number(round.history_rejections);
  const headlineCount = Number(round.headline_count);
  const summaryBits = [];

  if (Number.isFinite(headlineCandidates)) summaryBits.push(`${headlineCandidates} candidates`);
  if (Number.isFinite(headlineCount)) summaryBits.push(`${headlineCount} selected`);
  if (Number.isFinite(duplicateRejections)) summaryBits.push(`${duplicateRejections} batch duplicates removed`);
  if (Number.isFinite(historyRejections)) summaryBits.push(`${historyRejections} history conflicts removed`);

  return (
    <div className="mt-2 rounded-lg bg-black/[0.02] border border-black/5 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Headline diversity</p>
        {laneEntries.length > 0 && (
          <span className="text-[9px] text-ed-ink2">{laneEntries.length} lane{laneEntries.length !== 1 ? 's' : ''}</span>
        )}
      </div>
      {summaryBits.length > 0 && (
        <p className="text-[10px] text-ed-ink2 mt-1 leading-relaxed">{summaryBits.join(' · ')}</p>
      )}
      {laneEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {laneEntries.map(([lane, count]) => (
            <span
              key={lane}
              className="inline-flex items-center gap-1 rounded-full bg-ed-surface/80 border border-black/5 px-2 py-1 text-[9px] text-ed-ink"
            >
              <span>{formatLaneLabel(lane)}</span>
              <span className="text-ed-ink2">{count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function getRoundFailedAds(round) {
  return ensureArray(round?.failed_ads, 'AgentMonitor.run.round.failed_ads');
}

function formatFailureBucketLabel(bucket) {
  const labels = {
    image_only: 'Image only',
    copy_only: 'Copy only',
    mixed: 'Mixed',
    headline_alignment: 'Headline alignment',
  };
  return labels[bucket] || formatLaneLabel(bucket);
}

function RoundFailureSummary({ round }) {
  const summary = round?.failure_summary && typeof round.failure_summary === 'object'
    ? round.failure_summary
    : null;
  if (!summary) return null;

  const bucketEntries = Object.entries(summary.bucket_counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  const hardEntries = Object.entries(summary.hard_requirement_counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 4);
  const imageEntries = Object.entries(summary.image_theme_counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 4);

  if (bucketEntries.length === 0 && hardEntries.length === 0 && imageEntries.length === 0) return null;

  return (
    <div className="mt-2 rounded-lg bg-black/[0.02] border border-black/5 px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Failure summary</p>
      {bucketEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {bucketEntries.map(([bucket, count]) => (
            <span key={bucket} className="inline-flex items-center gap-1 rounded-full bg-ed-surface/80 border border-black/5 px-2 py-1 text-[9px] text-ed-ink">
              <span>{formatFailureBucketLabel(bucket)}</span>
              <span className="text-ed-ink2">{count}</span>
            </span>
          ))}
        </div>
      )}
      {hardEntries.length > 0 && (
        <p className="text-[10px] text-ed-ink2 mt-2 leading-relaxed">
          Hard fails: {hardEntries.map(([key, count]) => `${formatFailureLabel(key)} (${count})`).join(' · ')}
        </p>
      )}
      {imageEntries.length > 0 && (
        <p className="text-[10px] text-ed-ink2 mt-1 leading-relaxed">
          Image themes: {imageEntries.map(([key, count]) => `${formatLaneLabel(key)} (${count})`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function RoundRepairSummary({ round }) {
  const summary = round?.repair_summary && typeof round.repair_summary === 'object'
    ? round.repair_summary
    : null;
  if (!summary || Number(summary.attempted) <= 0) return null;

  return (
    <div className="mt-2 rounded-lg bg-ed-green/5 border border-ed-green/15 px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Repair attempts</p>
      <p className="text-[10px] text-ed-ink2 mt-1 leading-relaxed">
        {summary.attempted} attempted · {summary.passed || 0} passed
        {summary.image_attempted ? ` · ${summary.image_attempted} image repairs` : ''}
        {summary.copy_attempted ? ` · ${summary.copy_attempted} copy repairs` : ''}
      </p>
    </div>
  );
}

function RoundFailedAds({ round }) {
  const failedAds = getRoundFailedAds(round);
  if (failedAds.length === 0) return null;

  return (
    <details className="mt-2 rounded-lg bg-ed-rust/10/70 border border-ed-rust/30">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium text-ed-rust">Failed ads</span>
        <span className="text-[10px] text-ed-rust">{failedAds.length} to inspect</span>
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-ed-rust/30 space-y-2">
        {failedAds.map((failedAd, index) => {
          const hardFailures = ensureArray(failedAd.failed_hard_requirements, `AgentMonitor.run.round.failed_ads.${index}.hardFailures`);
          const complianceFlags = ensureArray(failedAd.compliance_flags, `AgentMonitor.run.round.failed_ads.${index}.complianceFlags`);
          const spellingErrors = ensureArray(failedAd.spelling_errors, `AgentMonitor.run.round.failed_ads.${index}.spellingErrors`);
          const weaknesses = ensureArray(failedAd.weaknesses, `AgentMonitor.run.round.failed_ads.${index}.weaknesses`);
          const strengths = ensureArray(failedAd.strengths, `AgentMonitor.run.round.failed_ads.${index}.strengths`);
          const imageIssues = ensureArray(failedAd.image_issues, `AgentMonitor.run.round.failed_ads.${index}.imageIssues`);
          const fellBelowThreshold = !failedAd.error && hardFailures.length === 0;

          return (
            <div key={failedAd.ad_id || `${round.batch_id || 'round'}-${index}`} className="rounded-lg bg-ed-surface/80 border border-ed-rust/30 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium text-ed-ink">
                    Ad {index + 1}{failedAd.ad_id ? ` · ${failedAd.ad_id.slice(0, 8)}...` : ''}
                  </p>
                  {failedAd.headline && (
                    <p className="text-[11px] text-ed-ink mt-1 leading-relaxed">{failedAd.headline}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Score</p>
                  <p className="text-[12px] font-semibold text-ed-rust mt-0.5">{failedAd.overall_score ?? 0}</p>
                </div>
              </div>

              {failedAd.body_copy_preview && (
                <p className="text-[10px] text-ed-ink2 mt-2 leading-relaxed whitespace-pre-line">{failedAd.body_copy_preview}</p>
              )}

              <div className="flex flex-wrap gap-1.5 mt-2">
                {failedAd.failure_bucket && (
                  <span className="inline-flex items-center rounded-full bg-black/5 text-ed-ink px-2 py-1 text-[9px] font-medium">
                    {formatFailureBucketLabel(failedAd.failure_bucket)}
                  </span>
                )}
                {failedAd.recommended_fix && (
                  <span className="inline-flex items-center rounded-full bg-ed-accent/10 text-ed-accent px-2 py-1 text-[9px] font-medium">
                    {formatLaneLabel(failedAd.recommended_fix)}
                  </span>
                )}
                {hardFailures.map((key) => (
                  <span key={key} className="inline-flex items-center rounded-full bg-ed-rust/10 text-ed-rust px-2 py-1 text-[9px] font-medium">
                    Failed {formatFailureLabel(key)}
                  </span>
                ))}
                {fellBelowThreshold && (
                  <span className="inline-flex items-center rounded-full bg-ed-accent/15 text-ed-accent px-2 py-1 text-[9px] font-medium">
                    Below score threshold
                  </span>
                )}
                {failedAd.angle_category && (
                  <span className="inline-flex items-center rounded-full bg-black/5 text-ed-ink2 px-2 py-1 text-[9px]">
                    {failedAd.angle_category}
                  </span>
                )}
                {failedAd.error && (
                  <span className="inline-flex items-center rounded-full bg-ed-rust/10 text-ed-rust px-2 py-1 text-[9px] font-medium">
                    {failedAd.error}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Copy</p>
                  <p className="text-[11px] font-medium text-ed-ink mt-0.5">{failedAd.copy_strength ?? '—'}</p>
                </div>
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Compliance</p>
                  <p className="text-[11px] font-medium text-ed-ink mt-0.5">{failedAd.compliance ?? '—'}</p>
                </div>
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Effectiveness</p>
                  <p className="text-[11px] font-medium text-ed-ink mt-0.5">{failedAd.effectiveness ?? '—'}</p>
                </div>
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Image</p>
                  <p className="text-[11px] font-medium text-ed-ink mt-0.5">{failedAd.image_quality ?? '—'}</p>
                </div>
              </div>

              {(weaknesses.length > 0 || complianceFlags.length > 0 || spellingErrors.length > 0 || imageIssues.length > 0 || strengths.length > 0) && (
                <div className="mt-2 space-y-2">
                  {weaknesses.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Weaknesses</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {weaknesses.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-weakness-${itemIndex}`} className="inline-flex items-center rounded-full bg-ed-rust/10 text-ed-rust border border-ed-rust/30 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {complianceFlags.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Compliance flags</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {complianceFlags.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-flag-${itemIndex}`} className="inline-flex items-center rounded-full bg-ed-accent/10 text-ed-accent border border-ed-accent/20 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {spellingErrors.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Spelling / grammar</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {spellingErrors.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-spelling-${itemIndex}`} className="inline-flex items-center rounded-full bg-ed-rust/10 text-ed-rust border border-ed-rust/30 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {imageIssues.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Image issues</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {imageIssues.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-image-${itemIndex}`} className="inline-flex items-center rounded-full bg-black/[0.02] text-ed-ink2 border border-black/5 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {strengths.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Strengths</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {strengths.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-strength-${itemIndex}`} className="inline-flex items-center rounded-full bg-ed-green/10 text-ed-green border border-ed-green/20 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function RoundLandingPageFunnel({ batchId, lpDetailState, loading }) {
  if (!batchId) return null;
  if (loading) {
    return (
      <div className="mt-2 rounded-lg bg-black/[0.02] border border-black/5 px-3 py-2">
        <p className="text-[10px] text-ed-ink2">Loading landing page funnel details...</p>
      </div>
    );
  }

  if (lpDetailState?.error) {
    return (
      <div className="mt-2 rounded-lg bg-ed-rust/10/70 border border-ed-rust/30 px-3 py-2">
        <p className="text-[10px] text-ed-rust">{lpDetailState.error}</p>
      </div>
    );
  }

  const detail = lpDetailState?.data;
  if (!detail) return null;

  const batch = detail.batch || {};
  const summary = detail.summary || {};
  const landingPages = ensureArray(detail.landingPages, `AgentMonitor.run.lpDetails.${batchId}.landingPages`);
  const narrativeFrames = ensureArray(batch.lp_narrative_frames, `AgentMonitor.run.lpDetails.${batchId}.frames`);
  const publishedUrls = ensureArray(batch.gauntlet_lp_urls, `AgentMonitor.run.lpDetails.${batchId}.urls`);
  const hasLPActivity = landingPages.length > 0 || batch.lp_primary_status || batch.lp_secondary_status || publishedUrls.length > 0;

  if (!hasLPActivity) return null;

  return (
    <details className="mt-2 rounded-lg bg-black/[0.02] border border-black/5">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium text-ed-ink">Landing page funnel</span>
        <span className="text-[10px] text-ed-ink2">
          {landingPages.length > 0
            ? `${summary.published ?? 0}/${summary.total ?? landingPages.length} published`
            : `${batch.lp_primary_status || 'not started'}`}
        </span>
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-ed-ink3">LPs</p>
            <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">{summary.total ?? landingPages.length ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Published</p>
            <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">{summary.published ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Headline Passed</p>
            <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">{summary.headlinePassed ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Avg Score</p>
            <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">{summary.avgScore ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Duration</p>
            <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">
              {summary.totalGenerationDurationMs ? formatDuration(summary.totalGenerationDurationMs) : '—'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-medium text-ed-ink">Primary LP</p>
              <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getLPStatusClasses(batch.lp_primary_status)}`}>
                {batch.lp_primary_status || 'not started'}
              </span>
            </div>
            {batch.lp_primary_url && (
              <a href={batch.lp_primary_url} target="_blank" rel="noreferrer" className="text-[10px] text-ed-accent hover:text-ed-accent mt-1 inline-block break-all">
                {batch.lp_primary_url}
              </a>
            )}
            {batch.lp_primary_error && (
              <p className="text-[10px] text-ed-rust mt-1 leading-relaxed">{batch.lp_primary_error}</p>
            )}
            {batch.lp_primary_retry_count ? (
              <p className="text-[9px] text-ed-ink3 mt-1">Retries: {batch.lp_primary_retry_count}</p>
            ) : null}
          </div>
          <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-medium text-ed-ink">Secondary LP</p>
              <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getLPStatusClasses(batch.lp_secondary_status)}`}>
                {batch.lp_secondary_status || 'not started'}
              </span>
            </div>
            {batch.lp_secondary_url && (
              <a href={batch.lp_secondary_url} target="_blank" rel="noreferrer" className="text-[10px] text-ed-accent hover:text-ed-accent mt-1 inline-block break-all">
                {batch.lp_secondary_url}
              </a>
            )}
            {batch.lp_secondary_error && (
              <p className="text-[10px] text-ed-rust mt-1 leading-relaxed">{batch.lp_secondary_error}</p>
            )}
            {batch.lp_secondary_retry_count ? (
              <p className="text-[9px] text-ed-ink3 mt-1">Retries: {batch.lp_secondary_retry_count}</p>
            ) : null}
          </div>
        </div>

        {narrativeFrames.length > 0 && (
          <div>
            <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Narrative frames</p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {narrativeFrames.map((frame) => (
                <span key={frame} className="inline-flex items-center rounded-full bg-ed-surface/80 border border-black/5 px-2 py-1 text-[9px] text-ed-ink">
                  {formatLaneLabel(frame)}
                </span>
              ))}
            </div>
          </div>
        )}

        {publishedUrls.length > 0 && (
          <div>
            <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Published URLs</p>
            <div className="space-y-1 mt-1">
              {publishedUrls.map((entry, index) => (
                <div key={`${entry.url || entry.frame || index}`} className="rounded-lg bg-ed-surface/70 border border-black/5 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-ed-ink">{formatLaneLabel(entry.frameName || entry.frame || `LP ${index + 1}`)}</span>
                    <span className="text-[9px] text-ed-ink2">{entry.score ?? '—'}/11</span>
                  </div>
                  {entry.url && (
                    <a href={entry.url} target="_blank" rel="noreferrer" className="text-[10px] text-ed-accent hover:text-ed-accent mt-1 inline-block break-all">
                      {entry.url}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {landingPages.length > 0 && (
          <div className="space-y-2">
            {landingPages.map((page) => (
              <details key={page.id} className="rounded-lg bg-ed-surface/70 border border-black/5">
                <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium text-ed-ink">
                      {formatLaneLabel(page.narrative_frame || page.gauntlet_frame || page.name || 'Landing page')}
                    </p>
                    <p className="text-[9px] text-ed-ink3 mt-0.5">
                      {page.id ? `${page.id.slice(0, 8)}...` : '—'} · attempt {page.gauntlet_attempt ?? page.generation_attempts ?? 1}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {page.gauntlet_score != null && (
                      <span className="text-[10px] font-medium text-ed-ink">{page.gauntlet_score}/11</span>
                    )}
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getLPStatusClasses(page.status || page.gauntlet_status)}`}>
                      {page.status || page.gauntlet_status || 'unknown'}
                    </span>
                  </div>
                </summary>
                <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">QA</p>
                      <p className="text-[11px] font-medium text-ed-ink mt-0.5">{page.qa_score ?? '—'}</p>
                    </div>
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Issues</p>
                      <p className="text-[11px] font-medium text-ed-ink mt-0.5">{page.qa_issues_count ?? '—'}</p>
                    </div>
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Smoke</p>
                      <p className="text-[11px] font-medium text-ed-ink mt-0.5">{page.smoke_test_status || '—'}</p>
                    </div>
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Duration</p>
                      <p className="text-[11px] font-medium text-ed-ink mt-0.5">{page.generation_duration_ms ? formatDuration(page.generation_duration_ms) : '—'}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {page.qa_status && (
                      <span className={`inline-flex items-center rounded-full px-2 py-1 text-[9px] border ${page.qa_status === 'passed' ? 'bg-ed-green/10 text-ed-green border-ed-green/20' : 'bg-ed-rust/10 text-ed-rust border-ed-rust/30'}`}>
                        QA {page.qa_status}
                      </span>
                    )}
                    {page.smoke_test_status && (
                      <span className={`inline-flex items-center rounded-full px-2 py-1 text-[9px] border ${page.smoke_test_status === 'passed' ? 'bg-ed-green/10 text-ed-green border-ed-green/20' : 'bg-ed-rust/10 text-ed-rust border-ed-rust/30'}`}>
                        Smoke {page.smoke_test_status}
                      </span>
                    )}
                    {page.gauntlet_retry_type && (
                      <span className="inline-flex items-center rounded-full bg-ed-accent/10 text-ed-accent border border-ed-accent/20 px-2 py-1 text-[9px]">
                        Retry {page.gauntlet_retry_type}
                      </span>
                    )}
                    {page.gauntlet_image_prescore_attempts != null && (
                      <span className="inline-flex items-center rounded-full bg-black/[0.02] text-ed-ink2 border border-black/5 px-2 py-1 text-[9px]">
                        Image prescore attempts {page.gauntlet_image_prescore_attempts}
                      </span>
                    )}
                    {page.fix_attempts != null && (
                      <span className="inline-flex items-center rounded-full bg-black/[0.02] text-ed-ink2 border border-black/5 px-2 py-1 text-[9px]">
                        Fixes {page.fix_attempts}
                      </span>
                    )}
                  </div>

                  {(page.headline_text || page.subheadline_text) && (
                    <div className="space-y-1">
                      {page.headline_text && (
                        <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                          <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Headline</p>
                          <p className="text-[10px] text-ed-ink mt-1 leading-relaxed">{page.headline_text}</p>
                        </div>
                      )}
                      {page.subheadline_text && (
                        <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                          <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Subheadline</p>
                          <p className="text-[10px] text-ed-ink2 mt-1 leading-relaxed">{page.subheadline_text}</p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {page.headline_frame_alignment_status && (
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Frame Fit</p>
                        <p className="text-[11px] font-medium text-ed-ink mt-0.5">{page.headline_frame_alignment_status}</p>
                        {page.headline_frame_alignment_reason && (
                          <p className="text-[9px] text-ed-ink2 mt-1 leading-relaxed">{page.headline_frame_alignment_reason}</p>
                        )}
                      </div>
                    )}
                    {page.headline_uniqueness_status && (
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">5-Frame Uniqueness</p>
                        <p className="text-[11px] font-medium text-ed-ink mt-0.5">{page.headline_uniqueness_status}</p>
                        {page.headline_uniqueness_reason && (
                          <p className="text-[9px] text-ed-ink2 mt-1 leading-relaxed">{page.headline_uniqueness_reason}</p>
                        )}
                        {page.headline_duplicate_of_lp_id && (
                          <p className="text-[9px] text-ed-ink3 mt-1">Duplicate of {page.headline_duplicate_of_lp_id.slice(0, 8)}...</p>
                        )}
                      </div>
                    )}
                    {page.headline_history_status && (
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">History Check</p>
                        <p className="text-[11px] font-medium text-ed-ink mt-0.5">{page.headline_history_status}</p>
                        {page.headline_history_reason && (
                          <p className="text-[9px] text-ed-ink2 mt-1 leading-relaxed">{page.headline_history_reason}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {page.published_url && (
                    <a href={page.published_url} target="_blank" rel="noreferrer" className="text-[10px] text-ed-accent hover:text-ed-accent inline-block break-all">
                      {page.published_url}
                    </a>
                  )}

                  {page.error_message && (
                    <p className="text-[10px] text-ed-rust leading-relaxed">{page.error_message}</p>
                  )}
                  {page.qa_summary && (
                    <p className="text-[10px] text-ed-ink leading-relaxed">{page.qa_summary}</p>
                  )}
                  {page.gauntlet_score_reasoning && (
                    <p className="text-[10px] text-ed-ink2 leading-relaxed">{page.gauntlet_score_reasoning}</p>
                  )}

                  {page.qa_categories && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {Object.entries(page.qa_categories).map(([key, value]) => (
                        <div key={key} className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                          <p className="text-[9px] uppercase tracking-wider text-ed-ink3">{value?.label || formatLaneLabel(key)}</p>
                          <p className="text-[11px] font-medium text-ed-ink mt-0.5">
                            {value?.score ?? '—'}{value?.max ? `/${value.max}` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {ensureArray(page.qa_issues, `AgentMonitor.run.lpDetails.${page.id}.qaIssues`).length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">QA issues</p>
                      <div className="space-y-1 mt-1">
                        {ensureArray(page.qa_issues, `AgentMonitor.run.lpDetails.${page.id}.qaIssuesList`).map((issue, index) => (
                          <div key={`${page.id}-issue-${index}`} className="rounded-lg bg-ed-rust/10/70 border border-ed-rust/30 px-2 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[9px] font-medium text-ed-rust">{issue.severity || 'issue'}</span>
                              {issue.location && <span className="text-[9px] text-ed-ink3">{issue.location}</span>}
                            </div>
                            <p className="text-[10px] text-ed-ink mt-1 leading-relaxed">{issue.description || 'Issue detected'}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {ensureArray(page.smoke_checks, `AgentMonitor.run.lpDetails.${page.id}.smokeChecks`).length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Smoke checks</p>
                      <div className="space-y-1 mt-1">
                        {ensureArray(page.smoke_checks, `AgentMonitor.run.lpDetails.${page.id}.smokeChecksList`).map((check, index) => (
                          <div key={`${page.id}-smoke-${index}`} className={`rounded-lg border px-2 py-2 ${check.passed ? 'bg-ed-green/5 border-ed-green/20' : 'bg-ed-rust/10/70 border-ed-rust/30'}`}>
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-[9px] font-medium ${check.passed ? 'text-ed-green' : 'text-ed-rust'}`}>
                                {check.name}
                              </span>
                              <span className={`text-[9px] ${check.passed ? 'text-ed-green' : 'text-ed-rust'}`}>
                                {formatBooleanStatus(check.passed)}
                              </span>
                            </div>
                            {check.detail && (
                              <p className="text-[10px] text-ed-ink mt-1 leading-relaxed">{check.detail}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(ensureArray(page.smoke_visible_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.visiblePlaceholders`).length > 0 ||
                    ensureArray(page.smoke_raw_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.rawPlaceholders`).length > 0) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Visible Placeholders</p>
                        {ensureArray(page.smoke_visible_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.visiblePlaceholderList`).length > 0 ? (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {ensureArray(page.smoke_visible_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.visiblePlaceholderTags`).map((match, index) => (
                              <span key={`${page.id}-visible-placeholder-${index}`} className="inline-flex items-center rounded-full bg-ed-rust/10 text-ed-rust border border-ed-rust/30 px-2 py-1 text-[9px]">
                                {match}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[10px] text-ed-ink2 mt-1">None detected in rendered page text.</p>
                        )}
                      </div>
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Raw HTML Placeholder Tokens</p>
                        {ensureArray(page.smoke_raw_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.rawPlaceholderList`).length > 0 ? (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {ensureArray(page.smoke_raw_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.rawPlaceholderTags`).map((match, index) => (
                              <span key={`${page.id}-raw-placeholder-${index}`} className="inline-flex items-center rounded-full bg-black/[0.02] text-ed-ink2 border border-black/5 px-2 py-1 text-[9px]">
                                {match}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[10px] text-ed-ink2 mt-1">None found in raw HTML source.</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-3 text-[9px] text-ed-ink3">
                    {page.created_at && <span>Created {formatDateTime(page.created_at)}</span>}
                    {page.updated_at && <span>Updated {formatDateTime(page.updated_at)}</span>}
                    {page.gauntlet_batch_completed_at && <span>Completed {formatDateTime(page.gauntlet_batch_completed_at)}</span>}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function buildServerQueueItem(active, existing = null) {
  return {
    id: existing?.id || active?.runId || active?.id || crypto.randomUUID(),
    status: active?.status === 'complete' ? 'complete' : active?.status === 'error' ? 'error' : 'running',
    progress: typeof active?.progress === 'number' ? active.progress : (existing?.progress || 0),
    phase: active?.phase || existing?.phase || 'Still processing in background...',
    startTime: existing?.startTime || active?.startTime || Date.now(),
    result: active?.result || existing?.result || null,
    angleId: existing?.angleId || null,
    adsPerAdSetTarget: existing?.adsPerAdSetTarget || active?.requiredPasses || active?.result?.required_passes || 5,
    sseConnected: false,
    serverRunId: active?.runId || active?.id || existing?.serverRunId || null,
  };
}

function buildDurableQueueItem(run, existing = null) {
  const runId = getDurableRunId(run);
  const isQueued = run?.status === 'queued';
  const isCancelled = run?.status === 'cancelled' || run?.terminal_status === 'cancelled';
  return {
    id: existing?.id || runId || crypto.randomUUID(),
    status: isCancelled
      ? 'error'
      : isQueued
        ? 'queued'
        : isDurableRunSuccess(run)
          ? 'complete'
          : isDurableRunFailure(run)
            ? 'error'
            : 'running',
    progress: isQueued ? 0 : (existing?.progress || (run?.terminal_status === 'waiting_on_gemini' ? 22 : 0)),
    phase: isQueued
      ? `Queued${run?.queue_position ? ` at position ${run.queue_position}` : ''}.`
      : (run?.decisions || existing?.phase || 'Still processing in background...'),
    startTime: existing?.startTime || run?.started_at || run?.run_at || run?.created_at || Date.now(),
    result: run || existing?.result || null,
    angleId: existing?.angleId || run?.queued_angle_id || null,
    adsPerAdSetTarget: run?.required_passes || existing?.adsPerAdSetTarget || 5,
    templateTag: run?.template_tag || existing?.templateTag || '',
    sseConnected: false,
    serverRunId: runId,
    serverQueued: isQueued,
    queuePosition: run?.queue_position || null,
  };
}

const FINISHED_TEST_RUN_TTL_MS = 5 * 60 * 1000;
const ACTIVE_TEST_RUN_TTL_MS = 2 * 60 * 60 * 1000;
const TEST_RUN_FINAL_RECONCILE_ATTEMPTS = 3;
const TEST_RUN_START_MATCH_WINDOW_MS = 60 * 1000;
const LEGACY_AUTO_POST_LOG_IMPORT_TEXT = "does not provide an export named 'createAutoPostLog'";

function getQueueRunId(item) {
  return item?.serverRunId || item?.result?.runId || item?.result?.externalId || item?.result?.id || null;
}

function getQueueErrorText(item) {
  return [
    item?.phase,
    item?.result?.failure_reason,
    item?.result?.error,
    item?.result?.message,
  ].filter(Boolean).join(' ');
}

function isTerminalQueueItem(item) {
  return item?.status === 'complete' || item?.status === 'completed' || item?.status === 'error';
}

function isQueueRunComplete(item) {
  return item?.status === 'complete' || item?.status === 'completed' || isDurableRunSuccess(item?.result);
}

function isLegacyAutoPostLogQueueItem(item) {
  return item?.status === 'error' && getQueueErrorText(item).includes(LEGACY_AUTO_POST_LOG_IMPORT_TEXT);
}

function cleanupSavedTestRunQueue(queue, now = Date.now()) {
  const safeQueue = ensureArray(queue, 'AgentMonitor.director.cleanupSavedTestRunQueue');
  const finishedCutoff = now - FINISHED_TEST_RUN_TTL_MS;
  const activeCutoff = now - ACTIVE_TEST_RUN_TTL_MS;

  return safeQueue.filter((item) => {
    if (isLegacyAutoPostLogQueueItem(item)) return false;

    if (isTerminalQueueItem(item)) {
      const finishedAt = Number(item.finishedAt || item.completedAt || item.endTime || item.startTime || 0);
      return finishedAt > 0 && finishedAt >= finishedCutoff;
    }

    if (item?.status === 'running' || item?.status === 'queued') {
      const startedAt = Number(item.startTime || item.createdAt || 0);
      return startedAt === 0 || startedAt >= activeCutoff;
    }

    return true;
  });
}

function getDurableRunId(run) {
  return run?.externalId || run?.id || run?.runId || null;
}

function isDurableRunActive(run) {
  return ['running', 'scoring', 'repairing', 'processing'].includes(run?.status) || run?.terminal_status === 'waiting_on_gemini';
}

function isDurableRunSuccess(run) {
  return run?.status === 'completed' && run?.terminal_status === 'deployed';
}

function isDurableRunFailure(run) {
  return run?.status === 'failed' || run?.status === 'cancelled' || String(run?.terminal_status || '').includes('failed') || run?.terminal_status === 'cancelled';
}

function getDurableRunTimeMs(run) {
  const value = run?.run_at || run?.created_at || run?.started_at;
  if (typeof value === 'number') return value;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function findDurableRunForQueueItem(runs, queueItem) {
  const safeRuns = ensureArray(runs, 'AgentMonitor.director.findDurableRunForQueueItem');
  const queueRunId = getQueueRunId(queueItem);
  if (queueRunId) {
    const matchedById = safeRuns.find(run => getDurableRunId(run) === queueRunId);
    if (matchedById) return matchedById;
  }

  const startedAt = Number(queueItem?.startTime || 0);
  if (!startedAt) return null;

  return safeRuns.find((run) => {
    if (run?.run_type && run.run_type !== 'test') return false;
    const runTime = getDurableRunTimeMs(run);
    return runTime > 0 && Math.abs(runTime - startedAt) <= TEST_RUN_START_MATCH_WINDOW_MS;
  }) || null;
}

const VALID_AGENT_TABS = ['director', 'filter'];

export default function AgentMonitor({ projectId: externalProjectId, project: externalProject, onProjectRefresh }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useContext(AuthContext);
  const [filterData, setFilterData] = useState(null);
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const embedded = !!externalProjectId;
  // Standalone mode persists the active agent tab in the URL. Embedded mode
  // stays local so it cannot overwrite ProjectDetail's top-level ?tab value.
  const tabFromUrl = embedded ? null : searchParams.get('tab');
  const [activeTab, setActiveTabState] = useState(
    tabFromUrl && VALID_AGENT_TABS.includes(tabFromUrl) ? tabFromUrl : 'director'
  );
  const setActiveTab = useCallback((newTab) => {
    setActiveTabState(newTab);
    if (embedded) return;
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    }, { replace: true });
  }, [embedded, setSearchParams]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      if (activeTab === 'director') {
        const [filter, pipeline] = await Promise.allSettled([
          api.getFilterStatus(),
          api.getConductorPipelineStatus(),
        ]);
        if (filter.status === 'fulfilled') setFilterData(filter.value);
        if (pipeline.status === 'fulfilled') setPipelineStatus(pipeline.value);
        setError(
          filter.status === 'rejected' &&
          pipeline.status === 'rejected'
        );
      } else if (activeTab === 'filter') {
        const filter = await api.getFilterStatus();
        setFilterData(filter);
        setPipelineStatus(null);
        setError(false);
      } else {
        setPipelineStatus(null);
        setError(false);
      }
    } catch {
      setError(true);
    } finally {
      setStatusLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadStatus();
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [loadStatus]);

  const hasActiveTabData =
    activeTab === 'director'
      ? !!pipelineStatus || !!filterData
      : activeTab === 'filter'
        ? !!filterData
        : true;

  const agentsOnline = [filterData].filter(d => d?.status === 'online').length + (pipelineStatus ? 1 : 0);
  const agentsTotal = [filterData].filter(Boolean).length + 1;

  const tabs = [
    { id: 'director', label: 'Creative Director' },
    { id: 'filter', label: 'Creative Filter' },
  ];
  const headerName = externalProject?.brand
    || externalProject?.brand_name
    || externalProject?.displayName
    || externalProject?.name
    || 'PROJECT';

  return (
    <div className="fade-in space-y-4">
      {/* Dashboard header */}
      {!embedded && (
      <div className="ed-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-ed-accent/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-ed-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight">Agent Dashboard</h2>
              <p className="text-[11px] text-ed-ink3">Creative Director and Creative Filter keep the pipeline moving</p>
            </div>
          </div>
          <span className="text-[11px] text-ed-ink2 font-medium">{agentsOnline}/{agentsTotal} online</span>
        </div>

        {statusLoading && !hasActiveTabData ? (
          <div className="animate-pulse">
            <div className="h-3 w-28 bg-ed-line rounded mb-3" />
            <div className="h-20 bg-ed-bg rounded-xl" />
          </div>
        ) : error && !hasActiveTabData ? (
          <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
            <p className="text-[12px] font-medium text-ed-ink2 mb-1">Status Summary</p>
            <p className="text-[11px] text-ed-ink3">Agent status is temporarily unavailable. The page shell stays interactive while the status endpoints recover.</p>
          </div>
        ) : activeTab === 'director' ? (
          <PipelineOverview data={pipelineStatus} filterData={filterData} />
        ) : (
          <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
            <p className="text-[12px] font-medium text-ed-ink2 mb-1">Status Summary</p>
            <p className="text-[11px] text-ed-ink3">
              Director pipeline metrics load only on the Creative Director tab to keep this page lighter while you work elsewhere.
            </p>
            <div className="flex items-center gap-4 mt-3 text-[10px] text-ed-ink2">
              <span>Director: open tab to load</span>
              <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2013'}</span>
            </div>
          </div>
        )}
      </div>
      )}

      {embedded && (
        <div className="-mx-4 sm:-mx-6 lg:-mx-8 -mt-8 mb-2">
          <EditorialPageHeader
            eyebrow={`${headerName.toUpperCase()} · AUTOMATION`}
            title="Automation"
            meta="Uses two agents to automate ad generation — Creative Director plans batches and selects angles, Creative Filter scores and checks quality."
          />
        </div>
      )}

      {/* Agent Tabs */}
      <div className={embedded ? '' : 'ed-card p-5'}>
        <div className="segmented-control mb-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={activeTab === tab.id ? 'active' : ''}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'director' && (
          <DirectorTab
            onRefresh={loadStatus}
            externalProjectId={externalProjectId}
            externalProject={externalProject}
            userRole={user?.role}
            onProjectRefresh={onProjectRefresh}
          />
        )}
        {activeTab === 'filter' && filterData && (
          <FilterPanel
            data={filterData}
            onRefresh={loadStatus}
            externalProjectId={externalProjectId}
            externalProject={externalProject}
            onProjectRefresh={onProjectRefresh}
          />
        )}
      </div>
    </div>
  );
}

// =============================================
// Pipeline Overview
// =============================================
function PipelineOverview({ data, filterData }) {
  const projects = ensureArray(data?.projects, 'AgentMonitor.pipeline.projects');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Get the next 5 weekdays
  const getUpcomingDays = () => {
    const days = [];
    const now = new Date();
    let d = new Date(now);
    while (days.length < 5) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) {
        days.push({
          date: d.toISOString().split('T')[0],
          dayName: dayNames[dow],
          label: days.length === 0 ? 'Tomorrow' : `${dayNames[dow]} ${d.getDate()}`,
        });
      }
    }
    return days;
  };

  const upcomingDays = getUpcomingDays();

  if (projects.length === 0) {
    return (
      <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
        <p className="text-[12px] font-medium text-ed-ink2 mb-1">Pipeline Overview</p>
        <p className="text-[11px] text-ed-ink3">No projects configured for the Creative Director yet. Enable a project in the Director tab to see pipeline status.</p>
        <div className="flex items-center gap-4 mt-3 text-[10px] text-ed-ink2">
          <span>Director: {'\u2013'}</span>
          <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2013'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
      <p className="text-[12px] font-medium text-ed-ink2 mb-3">Pipeline Overview</p>

      {upcomingDays.slice(0, 3).map(day => (
        <div key={day.date} className="mb-3 last:mb-0">
          <p className="text-[10px] text-ed-ink3 font-medium uppercase tracking-wider mb-1.5">{day.label}</p>
          {projects.map(project => {
            const produced = project.flex_by_day?.[day.date] || 0;
            const target = project.daily_flex_target ?? 5;
            const activeBatches = project.active_batches_by_day?.[day.date] || 0;
            const pct = Math.min((produced / target) * 100, 100);
            const isMet = produced >= target;

            return (
              <div key={project.project_id} className="flex items-center gap-3 mb-1">
                <span className="text-[11px] text-ed-ink font-medium w-32 truncate">{project.brand_name || project.project_name}</span>
                <div className="flex-1 h-2.5 rounded-full bg-black/5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${isMet ? 'bg-ed-green' : 'bg-ed-accent'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] text-ed-ink2 tabular-nums w-16 text-right">
                  {produced}/{target}
                  {isMet && <span className="text-ed-green ml-1">{'\u2713'}</span>}
                </span>
                {activeBatches > 0 && (
                  <span className="text-[9px] text-ed-accent font-medium">{activeBatches} in progress</span>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="flex items-center gap-4 mt-3 pt-2 border-t border-black/5 text-[10px] text-ed-ink2">
        <span>Director {'\u2713'}</span>
        <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2717'}</span>
      </div>
    </div>
  );
}


// =============================================
// Creative Director Tab
// =============================================
function DirectorSetupTipsPanel({ projectId, foundationalDocsComplete, angleCount, customAngleCount, directorEnabled, userRole }) {
  const storageKey = `directorSetupTipsCollapsed:${projectId}`;
  const canView = userRole === 'admin' || userRole === 'manager';
  const state = !foundationalDocsComplete
    ? 'docs'
    : directorEnabled
      ? 'enabled'
      : customAngleCount === 0
        ? 'angles'
        : 'disabled';
  const defaultCollapsed = state === 'enabled';
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  useEffect(() => {
    if (!projectId) return;
    try {
      const saved = localStorage.getItem(storageKey);
      setCollapsed(saved === null ? defaultCollapsed : saved === 'true');
    } catch {
      setCollapsed(defaultCollapsed);
    }
  }, [defaultCollapsed, projectId, storageKey]);

  const setManualCollapsed = (next) => {
    setCollapsed(next);
    try {
      localStorage.setItem(storageKey, next ? 'true' : 'false');
    } catch { /* ignore */ }
  };

  if (!canView) return null;

  const content = {
    docs: {
      summary: 'Complete foundational docs first.',
      title: '⚠️ Complete your foundational docs first',
      paragraphs: [
        "The Creative Director needs your foundational research to generate good angles. Head to the Foundational Docs tab and complete the doc generation. Once those are done, you'll automatically get a default angle here, and you can generate more.",
      ],
    },
    angles: {
      summary: 'Direct Offer ready. No custom angles yet.',
      title: '⚠️ Your project has Direct Offer. Add custom angles for richer testing.',
      paragraphs: [
        'Your project\'s foundational docs are complete and a default Direct Offer angle is ready — that\'s the baseline "just sell the offer" positioning. You CAN run the Director on just Direct Offer, but adding custom angles lets you test multiple positioning narratives, which makes the system meaningfully more useful.',
        'Step 1: Click Copy LLM Prompt. Paste into ChatGPT or Claude. The LLM will walk you through generating 10 angle teasers, picking the ones you like, building a shortlist across batches, and expanding the final shortlist into full briefs.',
        "Step 2: Paste the LLM's markdown into the Import dialog. Each angle in the markdown gets added to your library.",
        'Step 3: Enable the Creative Director (toggle below) to start scheduled runs.',
      ],
    },
    disabled: {
      summary: `${angleCount} active angle${angleCount === 1 ? '' : 's'}. Director is disabled.`,
      title: `✓ You have ${angleCount} angle${angleCount === 1 ? '' : 's'}. Enable the Director to start runs.`,
      paragraphs: [
        'Toggle Enable Creative Director below to start scheduled runs at 7am / 7pm / 1am ICT. Recommended: click Run Test on one angle first to verify the system works end-to-end before relying on schedule.',
        'Want more angles? Click Copy LLM Prompt anytime to generate more candidates with ChatGPT or Claude, then Import the markdown back here. Any angle in your library is editable — click on it to customize.',
      ],
    },
    enabled: {
      summary: 'Director is enabled. Scheduled runs are active.',
      title: '✓ Director is enabled. Scheduled runs at 7am / 7pm / 1am ICT.',
      paragraphs: [
        'Click Run Test on any angle to trigger an immediate batch — recommended after any angle changes. View results in the Staging tab. Need more angles? Use the Copy LLM Prompt workflow anytime.',
      ],
    },
  }[state];

  return (
    <section className={`mb-4 rounded-xl border px-3 py-3 ${foundationalDocsComplete ? 'bg-ed-accent/5 border-ed-accent/10' : 'bg-ed-rust/5 border-ed-rust/10'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[12px] font-serif font-[420] text-ed-ink">Director Setup & Tips</h3>
            {collapsed && (
              <button
                type="button"
                onClick={() => setManualCollapsed(false)}
                className="text-[10px] font-medium text-ed-accent hover:text-ed-accent/80"
              >
                Need help?
              </button>
            )}
          </div>
          {collapsed && <p className="text-[11px] text-ed-ink2 mt-1">{content.summary}</p>}
        </div>
        <button
          type="button"
          onClick={() => setManualCollapsed(!collapsed)}
          className="ed-ghost text-[10px] px-2 py-1 shrink-0"
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <div className="mt-3 space-y-2">
          <p className={`text-[12px] font-medium ${foundationalDocsComplete ? 'text-ed-ink' : 'text-ed-rust'}`}>{content.title}</p>
          {content.paragraphs.map((paragraph) => (
            <p key={paragraph} className="text-[11px] text-ed-ink2 leading-relaxed">{paragraph}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function DirectorSettingsAnglesCallout({ customAngleCount, countsReady, userRole, onGoToAngles }) {
  const canView = userRole === 'admin' || userRole === 'manager';
  if (!canView || !countsReady || customAngleCount > 0) return null;

  return (
    <div className="rounded-xl bg-ed-accent/5 border border-ed-accent/10 px-3 py-3">
      <p className="text-[12px] font-medium text-ed-ink">⚠️ Add custom angles before configuring Director settings</p>
      <p className="text-[11px] text-ed-ink2 mt-1 leading-relaxed">
        Your project's Director can run on just the Direct Offer baseline, but adding custom angles makes test variety meaningful. Head to the Angles tab to generate some — you'll see step-by-step instructions there.
      </p>
      <button
        type="button"
        onClick={onGoToAngles}
        className="mt-3 px-3 py-1.5 rounded-[7px] text-[11px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors"
      >
        Go to Angles
      </button>
    </div>
  );
}

function ImportDedupDialog({ open, result, importing, onImportNewOnly, onImportWithArchived, onCancel }) {
  if (!open || !result) return null;

  const newCount = result.newAngles?.length || 0;
  const archivedMatches = ensureArray(result.archivedMatches, 'AgentMonitor.importDedup.archivedMatches');
  const activeMatches = ensureArray(result.activeMatches, 'AgentMonitor.importDedup.activeMatches');
  const archivedNames = archivedMatches.map(match => match.existingAngle?.name || match.angle?.name).filter(Boolean);
  const activeNames = activeMatches.map(match => match.existingAngle?.name || match.angle?.name).filter(Boolean);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 fade-in">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={() => !importing && onCancel?.()} />
      <div className="relative bg-ed-surface border border-ed-line rounded-xl shadow-card w-full max-w-lg p-6">
        <h3 className="font-serif text-[16px] font-[420] text-ed-ink tracking-tight">Some angles already exist in your library</h3>
        <div className="text-[13px] text-ed-ink2 mt-3 space-y-2">
          <p>{newCount} new angle{newCount !== 1 ? 's' : ''} will be added.</p>
          {archivedNames.length > 0 && (
            <p>{archivedNames.length} angle{archivedNames.length !== 1 ? 's' : ''} match archived entries: {archivedNames.join(', ')}</p>
          )}
          {activeNames.length > 0 && (
            <p>{activeNames.length} angle{activeNames.length !== 1 ? 's' : ''} match active entries: {activeNames.join(', ')}</p>
          )}
          {activeNames.length > 0 && (
            <p className="text-[12px] text-ed-ink3">
              {activeNames.length} angle{activeNames.length !== 1 ? 's' : ''} already exist as active in your library — they will be skipped in any of the actions above. To replace their content, archive them first and re-import.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            disabled={importing}
            className="ed-ghost text-[13px] disabled:opacity-50"
          >
            Cancel
          </button>
          {archivedNames.length > 0 && (
            <button
              type="button"
              onClick={onImportWithArchived}
              disabled={importing}
              className="px-4 py-2 rounded-[7px] text-[13px] font-medium bg-ed-accent hover:bg-ed-accent/90 text-white transition-colors disabled:opacity-50"
            >
              {importing ? 'Working...' : `Import new + reactivate archived (${newCount + archivedNames.length})`}
            </button>
          )}
          <button
            type="button"
            onClick={onImportNewOnly}
            disabled={importing}
            className="px-4 py-2 rounded-[7px] text-[13px] font-medium bg-ed-accent hover:bg-ed-accent/90 text-white transition-colors disabled:opacity-50"
          >
            {importing ? 'Working...' : `Import new only (${newCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}

function DefaultAngleArchiveDialog({ open, angle, busy, onConfirm, onCancel }) {
  if (!open || !angle) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 fade-in">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={() => !busy && onCancel?.()} />
      <div className="relative bg-ed-surface border border-ed-line rounded-xl shadow-card w-full max-w-md p-6">
        <h3 className="font-serif text-[16px] font-[420] text-ed-ink tracking-tight">Archive your project's default angle?</h3>
        <div className="text-[13px] text-ed-ink2 mt-3 space-y-3">
          <p>"{angle.name}" is your project's default angle (auto-seeded after foundational docs complete). It serves as the baseline "just sell the offer" positioning. Archiving it means this project will only run on custom angles you've created.</p>
          <p>If you archive it, you can always restore it from the archived list.</p>
        </div>
        <div className="flex items-center justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ed-ghost text-[13px] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 rounded-[7px] text-[13px] font-medium bg-ed-rust hover:bg-ed-rust/90 text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Archiving...' : 'Archive default angle'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DirectorTab({ onRefresh, externalProjectId, externalProject, userRole, onProjectRefresh }) {
  const toast = useToast();
  const embedded = !!externalProjectId;
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [config, setConfig] = useState(null);
  const [angles, setAngles] = useState([]);
  const [angleOptions, setAngleOptions] = useState([]);
  const [runs, setRuns] = useState([]);
  const [playbooks, setPlaybooks] = useState([]);
  const [foundationalDocs, setFoundationalDocs] = useState([]);
  const [subTab, setSubTab] = useState('settings');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [selectedAngleIds, setSelectedAngleIds] = useState([]);
  const [projectLoading, setProjectLoading] = useState(!externalProjectId);
  const [baseLoading, setBaseLoading] = useState(false);
  const [anglesLoading, setAnglesLoading] = useState(false);
  const [angleOptionsLoading, setAngleOptionsLoading] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [playbooksLoading, setPlaybooksLoading] = useState(false);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [adsPerAdSetDraft, setAdsPerAdSetDraft] = useState(null);
  const [anglesLoadedFor, setAnglesLoadedFor] = useState('');
  const [angleOptionsLoadedFor, setAngleOptionsLoadedFor] = useState('');
  const [runsLoadedFor, setRunsLoadedFor] = useState('');
  const [playbooksLoadedFor, setPlaybooksLoadedFor] = useState('');
  const [campaignsLoadedFor, setCampaignsLoadedFor] = useState('');
  const [foundationalDocsLoadedFor, setFoundationalDocsLoadedFor] = useState('');
  const [runningAction, setRunningAction] = useState(null);
  const [cancelingRunId, setCancelingRunId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState({});
  const [lpDetailsByBatchId, setLpDetailsByBatchId] = useState({});
  const [lpDetailsLoadingByBatchId, setLpDetailsLoadingByBatchId] = useState({});

  const [campaigns, setCampaigns] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [templatesLoadedFor, setTemplatesLoadedFor] = useState('');

  // Angle selection for test runs
  const [selectedAngleId, setSelectedAngleId] = useState('');
  const [testAdSetTargetDraft, setTestAdSetTargetDraft] = useState('');
  const [testTemplateTag, setTestTemplateTag] = useState('');

  // Test run queue — now server-backed. Legacy browser-local queues are cleared
  // on project load so stale pre-deploy items cannot render or auto-start.
  const [testRunQueue, setTestRunQueue] = useState(() => {
    return [];
  });
  const [queueLoadedFor, setQueueLoadedFor] = useState('');
  const safeTestRunQueue = ensureArray(testRunQueue, 'AgentMonitor.director.testRunQueue');
  const activeRun = safeTestRunQueue.find(r => r.status === 'running');
  const queuedRuns = safeTestRunQueue.filter(r => r.status === 'queued' || r.status === 'queueing');
  const queuedCount = safeTestRunQueue.filter(r => r.status === 'queued').length;
  const finishedRuns = safeTestRunQueue.filter(r => isTerminalQueueItem(r));
  const activeRunRecord = activeRun?.result || null;
  const activeRunRounds = getRunRounds(activeRunRecord);
  const activeRunBatches = getRunBatches(activeRunRecord);
  const activeRunRequiredPasses = activeRunRecord?.required_passes || activeRun?.adsPerAdSetTarget || 5;
  const activeRunPassed = activeRunRecord?.total_ads_passed ?? activeRunRounds[activeRunRounds.length - 1]?.cumulative_passed ?? null;
  const showActiveRunBreakdown = activeRun && (activeRunRounds.length > 0 || activeRunBatches.length > 0);
  const activeRunCanceling = !!activeRun && cancelingRunId === activeRun.id;
  const sseActiveRef = useRef(false); // tracks if we have a live SSE connection for the active run
  const abortRef = useRef(null); // stores the SSE abort function for active run cancellation

  useEffect(() => {
    if (!selectedProject) return;
    setQueueLoadedFor('');
    try {
      localStorage.removeItem(`dacia_testRunQueue:${selectedProject}`);
      localStorage.removeItem('dacia_testRunQueue');
      setTestRunQueue([]);
      setQueueLoadedFor(selectedProject);
    } catch {
      setTestRunQueue([]);
      setQueueLoadedFor(selectedProject);
    }
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedProject || queueLoadedFor !== selectedProject) return;
    let cancelled = false;

    const loadServerQueue = async () => {
      try {
        const queueRes = await api.getConductorTestQueue(selectedProject, 50);
        if (cancelled || selectedProjectRef.current !== selectedProject) return;
        const durableRuns = ensureArray(queueRes?.runs ?? queueRes, 'AgentMonitor.director.serverTestRunQueue');
        setTestRunQueue(prev => {
          const safePrev = ensureArray(prev, 'AgentMonitor.director.mergeServerTestRunQueue');
          const byRunId = new Map(safePrev.map(item => [getQueueRunId(item), item]).filter(([id]) => !!id));
          const serverItems = durableRuns.map(run => buildDurableQueueItem(run, byRunId.get(getDurableRunId(run))));
          const serverIds = new Set(serverItems.map(getQueueRunId).filter(Boolean));
          const localItems = safePrev.filter(item => {
            const runId = getQueueRunId(item);
            if (runId && serverIds.has(runId)) return false;
            return !item.serverQueued && (item.status === 'queued' || item.status === 'running' || isTerminalQueueItem(item));
          });
          return cleanupSavedTestRunQueue([...serverItems, ...localItems]);
        });
      } catch {
        // Existing progress polling still reconciles active runs; keep queue polling quiet.
      }
    };

    loadServerQueue();
    const interval = setInterval(loadServerQueue, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [queueLoadedFor, selectedProject]);

  // Auto-clear finished results after 5 minutes
  useEffect(() => {
    if (finishedRuns.length === 0) return;
    const timer = setInterval(() => {
      setTestRunQueue(prev => cleanupSavedTestRunQueue(prev));
    }, 30000);
    return () => clearInterval(timer);
  }, [finishedRuns.length]);

  const navigate = useNavigate();

  // New angle form
  const [showAddAngle, setShowAddAngle] = useState(false);
  const [newAngle, setNewAngle] = useState({ name: '', description: '', prompt_hints: '', priority: 'medium', frame: 'symptom-first', core_buyer: '', symptom_pattern: '', failed_solutions: '', current_belief: '', objection: '', emotional_state: '', scene: '', desired_belief_shift: '', tone: '', avoid_list: '' });

  // Import angles
  const [showImport, setShowImport] = useState(false);
  const [importDragOver, setImportDragOver] = useState(false);
  const [importResult, setImportResult] = useState(null); // { newAngles: [], skipped: [] }
  const [importDedupPrompt, setImportDedupPrompt] = useState(null);
  const [importing, setImporting] = useState(false);
  const [defaultArchivePrompt, setDefaultArchivePrompt] = useState(null);
  const [defaultArchiveBusy, setDefaultArchiveBusy] = useState(false);
  const importFileRef = useRef(null);
  const debounceRef = useRef(null);
  const pendingConfigRef = useRef({});
  const saveInFlightRef = useRef(false);
  const selectedProjectRef = useRef('');

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    if (!externalProjectId) return;
    setProjectLoading(false);
    setProjects(externalProject ? [{
      id: externalProjectId,
      displayName: externalProject.brand_name || externalProject.name,
      ...externalProject,
    }] : []);
    setSelectedProject(externalProjectId);
  }, [externalProjectId, externalProject]);

  useEffect(() => {
    setLpDetailsByBatchId({});
    setLpDetailsLoadingByBatchId({});
  }, [selectedProject]);

  // Load projects list
  useEffect(() => {
    if (externalProjectId) {
      setProjectLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getProjectOptions();
        const list = ensureArray(res?.projects ?? res, 'AgentMonitor.director.projects');
        if (cancelled) return;
        setProjects(list);
        if (list.length > 0 && !selectedProjectRef.current) {
          setSelectedProject(list[0].id);
        }
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setProjectLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [externalProjectId]);

  // Load project-specific data when selection changes
  useEffect(() => {
    if (!selectedProject) return;
    pendingConfigRef.current = {};
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSelectedAngleId('');
    setTestAdSetTargetDraft('');
    setTestTemplateTag('');
    let cancelled = false;
    setBaseLoading(true);
    setAnglesLoading(false);
    setAngleOptionsLoading(false);
    setRunsLoading(false);
    setPlaybooksLoading(false);
    setCampaignsLoading(false);
    setConfig(null);
    setAngles([]);
    setSelectedAngleIds([]);
    setAngleOptions([]);
    setRuns([]);
    setPlaybooks([]);
    setFoundationalDocs([]);
    setCampaigns([]);
    setTemplates([]);
    setAnglesLoadedFor('');
    setAngleOptionsLoadedFor('');
    setRunsLoadedFor('');
    setPlaybooksLoadedFor('');
    setCampaignsLoadedFor('');
    setTemplatesLoadedFor('');
    setFoundationalDocsLoadedFor('');
    setAdsPerAdSetDraft(null);
    (async () => {
      try {
        const [cfgRes, docsRes] = await Promise.allSettled([
          api.getConductorConfig(selectedProject),
          api.getDocs(selectedProject),
        ]);
        if (cancelled) return;
        if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value?.config || null);
        if (docsRes.status === 'fulfilled') {
          setFoundationalDocs(ensureArray(docsRes.value?.docs, 'AgentMonitor.director.foundationalDocs'));
          setFoundationalDocsLoadedFor(selectedProject);
        }
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setBaseLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  const loadAngles = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || anglesLoading || anglesLoadedFor === projectId) return;
    setAnglesLoading(true);
    try {
      const angRes = await api.getConductorAngles(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setAngles(ensureArray(angRes?.angles, 'AgentMonitor.director.angles'));
      setAnglesLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setAnglesLoading(false);
    }
  }, [anglesLoadedFor, anglesLoading]);

  const loadAngleOptions = useCallback(async (projectId = selectedProjectRef.current, { force = false } = {}) => {
    if (!projectId || angleOptionsLoading || (!force && angleOptionsLoadedFor === projectId)) return;
    setAngleOptionsLoading(true);
    try {
      const angRes = await api.getConductorActiveAngles(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setAngleOptions(ensureArray(angRes?.angles, 'AgentMonitor.director.angleOptions'));
      setAngleOptionsLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setAngleOptionsLoading(false);
    }
  }, [angleOptionsLoadedFor, angleOptionsLoading]);

  const loadRuns = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || runsLoading || runsLoadedFor === projectId) return;
    setRunsLoading(true);
    try {
      const runRes = await api.getConductorRuns(projectId, 20);
      if (selectedProjectRef.current !== projectId) return;
      setRuns(ensureArray(runRes?.runs, 'AgentMonitor.director.runs'));
      setRunsLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setRunsLoading(false);
    }
  }, [runsLoadedFor, runsLoading]);

  const loadPlaybooks = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || playbooksLoading || playbooksLoadedFor === projectId) return;
    setPlaybooksLoading(true);
    try {
      const pbRes = await api.getConductorPlaybooks(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setPlaybooks(ensureArray(pbRes?.playbooks, 'AgentMonitor.director.playbooks'));
      setPlaybooksLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setPlaybooksLoading(false);
    }
  }, [playbooksLoadedFor, playbooksLoading]);

  const loadCampaigns = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || campaignsLoading || campaignsLoadedFor === projectId) return;
    setCampaignsLoading(true);
    try {
      const campRes = await api.getCampaigns(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setCampaigns(ensureArray(campRes?.campaigns, 'AgentMonitor.director.campaigns'));
      setCampaignsLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setCampaignsLoading(false);
    }
  }, [campaignsLoadedFor, campaignsLoading]);

  const loadTemplates = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || templatesLoadedFor === projectId) return;
    try {
      const templateRes = await api.getTemplates(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setTemplates(ensureArray(templateRes?.templates, 'AgentMonitor.director.templates'));
      setTemplatesLoadedFor(projectId);
    } catch { /* ignore */ }
  }, [templatesLoadedFor]);

  useEffect(() => {
    if (!selectedProject) return;
    loadAngleOptions(selectedProject);
    loadTemplates(selectedProject);
  }, [loadAngleOptions, loadTemplates, selectedProject]);

  useEffect(() => {
    if (!selectedProject) return;
    if (subTab === 'angles') {
      loadAngles(selectedProject);
      loadPlaybooks(selectedProject);
    }
    if (subTab === 'history') {
      loadRuns(selectedProject);
    }
    if (subTab === 'settings') {
      loadCampaigns(selectedProject);
    }
  }, [loadAngles, loadCampaigns, loadPlaybooks, loadRuns, selectedProject, subTab]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const flushPendingConfig = useCallback(async () => {
    if (!selectedProject || saveInFlightRef.current) return;
    const updates = pendingConfigRef.current;
    if (Object.keys(updates).length === 0) return;

    pendingConfigRef.current = {};
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const res = await api.updateConductorConfig(selectedProject, updates);
      if (res?.config) setConfig(res.config);
    } catch {
      pendingConfigRef.current = { ...updates, ...pendingConfigRef.current };
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
      if (Object.keys(pendingConfigRef.current).length > 0) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(flushPendingConfig, 500);
      }
    }
  }, [selectedProject]);

  const handleSaveConfig = useCallback((updates) => {
    setConfig(prev => ({ ...(prev || {}), ...updates }));
    pendingConfigRef.current = { ...pendingConfigRef.current, ...updates };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushPendingConfig, 500);
  }, [flushPendingConfig]);

  const handleSaveAutomationCampaign = useCallback((campaignId) => {
    const nextCampaignId = campaignId || '';
    handleSaveConfig({ default_campaign_id: nextCampaignId });
    if (!selectedProject) return;
    api.updateProject(selectedProject, {
      default_campaign_id: nextCampaignId,
      scout_default_campaign: nextCampaignId,
    })
      .then(() => onProjectRefresh?.())
      .catch((err) => {
        toast.error(err?.message || 'Could not save automation campaign');
      });
  }, [handleSaveConfig, onProjectRefresh, selectedProject, toast]);

  const handleSaveAdsPerAdSet = useCallback((rawValue) => {
    const parsed = parseInt(rawValue, 10);
    const nextValue = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 20)) : 5;
    setAdsPerAdSetDraft(nextValue);
    handleSaveConfig({ ads_per_batch: nextValue });

    if (embedded && selectedProject) {
      api.updateProject(selectedProject, { ads_per_ad_set: nextValue })
        .then(() => onProjectRefresh?.())
        .catch((err) => {
          toast.error(err?.message || 'Could not save ads per ad set');
        });
    }
  }, [embedded, handleSaveConfig, onProjectRefresh, selectedProject, toast]);

  useEffect(() => {
    if (testTemplateTag || !config?.template_tag) return;
    setTestTemplateTag(config.template_tag);
  }, [config?.template_tag, testTemplateTag]);

  const STEP_PROGRESS = {
    // Compatibility fallback only. Backend progressValue is the source of truth.
    'initializing': 1,
    'selecting_angle': 1,
    'building_prompt': 1,
    'creating_batch': 2,
    'saving_run': 2,
    'launching_batch': 2,
    // Batch pipeline (~3-8 min) — 2-15%
    'batch_brief': 4,
    'batch_headlines': 6,
    'batch_body_copy': 9,
    'batch_image_prompts': 12,
    'batch_submitting': 14,
    'batch_submitted': 15,
    // Gemini processing (~5-20 min) — 15-60%
    'gemini_waiting': 15,
    'gemini_complete': 60,
    // Creative Filter (~2-5 min) — 60-95%
    'filter_scoring': 62,
    'filter_grouping': 82,
    'filter_copy_gen': 86,
    'filter_deploying': 92,
    'filter_complete': 95,
  };

  const handleTestRun = () => {
    const queueItem = {
      id: crypto.randomUUID(),
      status: 'queued',
      progress: 0,
      phase: '',
      startTime: null,
      result: null,
      angleId: selectedAngleId || null,
      adsPerAdSetTarget: testAdSetTargetValue,
      templateTag: testTemplateTag || '',
      sseConnected: false,
      serverRunId: null,
    };

    if (activeRun || queuedCount > 0) {
      setTestRunQueue(prev => [...prev, { ...queueItem, status: 'queueing', phase: 'Adding to queue...' }]);
      const body = {
        ...(queueItem.angleId ? { angle_id: queueItem.angleId } : {}),
        ads_per_ad_set: queueItem.adsPerAdSetTarget || 5,
        ...(queueItem.templateTag ? { template_tag: queueItem.templateTag } : {}),
      };
      const { done } = api.triggerConductorTestRun(selectedProject, body, (event) => {
        if (event.type === 'progress') {
          updateQueueItem(queueItem.id, {
            status: 'running',
            sseConnected: true,
            phase: event.message || 'Starting test run...',
            progress: typeof event.progressValue === 'number' ? event.progressValue : 0,
          });
        } else if (event.type === 'queued') {
          updateQueueItem(queueItem.id, {
            status: 'queued',
            phase: event.message || `Queued at position ${event.queue_position || queuedCount + 1}.`,
            serverRunId: event.runId || null,
            serverQueued: true,
            queuePosition: event.queue_position || null,
            result: event,
          });
        } else if (event.type === 'background') {
          updateQueueItem(queueItem.id, {
            status: 'running',
            sseConnected: false,
            progress: 22,
            phase: event.phase || event.background_message || 'Still processing in background...',
            result: event,
            serverRunId: event.runId || null,
          });
        } else if (event.type === 'complete') {
          updateQueueItem(queueItem.id, {
            status: 'complete',
            progress: 100,
            phase: 'Complete',
            result: event,
            serverRunId: event.runId || null,
          });
        } else if (event.type === 'error') {
          updateQueueItem(queueItem.id, { status: 'error', progress: 0, phase: event.message || 'Failed to queue test run', result: event });
        }
      });
      done.catch((err) => {
        updateQueueItem(queueItem.id, { status: 'error', progress: 0, phase: err.message || 'Failed to queue test run' });
        toast.error(err.message || 'Failed to queue test run');
      });
      setSubTab('history');
      return;
    }

    setTestRunQueue(prev => [...prev, queueItem]);
    setSubTab('history');
  };

  const updateQueueItem = useCallback((id, updates) => {
    setTestRunQueue(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  }, []);

  const finishRun = useCallback((runId, isError) => {
    setTimeout(async () => {
      setRunningAction(null);
      sseActiveRef.current = false;
      abortRef.current = null;
      // Keep completed/errored items visible — don't remove from queue
      // Mark with finishedAt so we can auto-clear later
      setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, finishedAt: Date.now() } : r));
      try {
        const runRes = await api.getConductorRuns(selectedProject, 20);
        setRuns(ensureArray(runRes?.runs, 'AgentMonitor.director.runs'));
        setRunsLoadedFor(selectedProject);
      } catch {}
      if (!isError) onRefresh?.();
    }, isError ? 3000 : 2000);
  }, [selectedProject, onRefresh]);

  // Dismiss a completed/errored result
  const handleDismissResult = useCallback((runId) => {
    setTestRunQueue(prev => prev.filter(r => r.id !== runId));
  }, []);

  // Cancel the active running test run
  const handleCancelRun = useCallback(async () => {
    if (!activeRun || cancelingRunId === activeRun.id) return;
    setCancelingRunId(activeRun.id);
    // Abort SSE connection
    abortRef.current?.();
    abortRef.current = null;
    sseActiveRef.current = false;
    updateQueueItem(activeRun.id, {
      sseConnected: false,
      phase: 'Cancel requested. Asking Gemini/background processing to stop...',
    });
    try {
      const res = await api.cancelTestRun(selectedProject, getQueueRunId(activeRun));
      if (!res?.cancelled) {
        updateQueueItem(activeRun.id, { status: 'error', progress: 0, phase: 'No active run found to cancel.' });
        setRunningAction(null);
      } else {
        updateQueueItem(activeRun.id, {
          status: 'error',
          progress: 0,
          phase: 'Cancelled by user',
          result: { terminal_status: 'cancelled', failure_reason: 'Cancelled by user' },
        });
        setRunningAction(null);
      }
    } catch (err) {
      updateQueueItem(activeRun.id, { status: 'error', progress: 0, phase: err.message || 'Cancel failed' });
      setRunningAction(null);
    } finally {
      setCancelingRunId(null);
    }
  }, [activeRun, cancelingRunId, selectedProject, updateQueueItem]);

  // Remove a queued (not yet running) test run
  const handleRemoveQueued = useCallback(async (runId) => {
    const queued = safeTestRunQueue.find(r => r.id === runId);
    const serverRunId = getQueueRunId(queued);
    if (serverRunId) {
      try {
        await api.cancelTestRun(selectedProject, serverRunId);
      } catch (err) {
        toast.error(err.message || 'Could not cancel queued run');
        return;
      }
    }
    setTestRunQueue(prev => prev.filter(r => r.id !== runId));
  }, [safeTestRunQueue, selectedProject, toast]);

  // Clear all queued runs
  const handleClearQueue = useCallback(async () => {
    const queued = safeTestRunQueue.filter(r => r.status === 'queued' || r.status === 'queueing');
    for (const run of queued) {
      const serverRunId = getQueueRunId(run);
      if (!serverRunId) continue;
      try {
        await api.cancelTestRun(selectedProject, serverRunId);
      } catch (err) {
        toast.error(err.message || 'Could not clear queued run');
        return;
      }
    }
    setTestRunQueue(prev => prev.filter(r => r.status !== 'queued' && r.status !== 'queueing'));
  }, [safeTestRunQueue, selectedProject, toast]);

  const loadLPDetailsForBatch = useCallback(async (batchId) => {
    if (!selectedProject || !batchId) return;
    if (lpDetailsByBatchId[batchId] || lpDetailsLoadingByBatchId[batchId]) return;

    setLpDetailsLoadingByBatchId(prev => ({ ...prev, [batchId]: true }));
    try {
      const data = await api.getConductorBatchLPDetails(selectedProject, batchId);
      setLpDetailsByBatchId(prev => ({ ...prev, [batchId]: { data } }));
    } catch (err) {
      setLpDetailsByBatchId(prev => ({ ...prev, [batchId]: { error: err.message || 'Failed to load LP details.' } }));
    } finally {
      setLpDetailsLoadingByBatchId(prev => ({ ...prev, [batchId]: false }));
    }
  }, [lpDetailsByBatchId, lpDetailsLoadingByBatchId, selectedProject]);

  const toggleRunExpanded = useCallback((runId, batchIds = []) => {
    const willExpand = !expandedRuns[runId];
    setExpandedRuns(prev => ({ ...prev, [runId]: willExpand }));
    if (willExpand) {
      ensureArray(batchIds, `AgentMonitor.run.${runId}.batchIds`)
        .filter(Boolean)
        .forEach((batchId) => {
          loadLPDetailsForBatch(batchId);
        });
    }
  }, [expandedRuns, loadLPDetailsForBatch]);

  // Queue processor — starts next queued run via SSE when no active run
  useEffect(() => {
    if (!selectedProject || queueLoadedFor !== selectedProject) return;
    const running = testRunQueue.find(r => r.status === 'running');
    const nextQueued = testRunQueue.find(r => r.status === 'queued' && !r.serverQueued && !getQueueRunId(r));

    // If there's a running item with a live SSE connection, nothing to do
    if (running && sseActiveRef.current) return;
    // If there's a running item without SSE (restored from localStorage), polling handles it — don't start a new one
    if (running && !sseActiveRef.current) return;
    if (!nextQueued) return;

    const runId = nextQueued.id;
    setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, status: 'running', startTime: Date.now(), phase: 'Starting test run...', sseConnected: true } : r));
    setRunningAction('run');
    sseActiveRef.current = true;

    const body = {
      ...(nextQueued.angleId ? { angle_id: nextQueued.angleId } : {}),
      ads_per_ad_set: nextQueued.adsPerAdSetTarget || 5,
      ...(nextQueued.templateTag ? { template_tag: nextQueued.templateTag } : {}),
    };

    let sawEvent = false;
    const { abort, done } = api.triggerConductorTestRun(selectedProject, body, (event) => {
      sawEvent = true;
      if (event.type === 'progress') {
        const updates = { phase: event.message || '' };

        if (typeof event.progressValue === 'number') {
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, event.progressValue) } : r));
          return;
        }

        if (event.step && STEP_PROGRESS[event.step] !== undefined) {
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, STEP_PROGRESS[event.step]) } : r));
          return;
        }

        if (event.step === 'gemini_polling' && event.elapsed) {
          const pct = 15 + Math.round(Math.min(event.elapsed / 600, 0.95) * 43);
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, pct) } : r));
          return;
        }

        if (event.step === 'filter_scoring' && event.scoringProgress) {
          const { current, total } = event.scoringProgress;
          const pct = 62 + Math.round((current / total) * 18);
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, pct) } : r));
          return;
        }

        if (event.imageProgress) {
          const { current, total } = event.imageProgress;
          const pct = 12 + Math.round((current / total) * 2);
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, pct) } : r));
          return;
        }

        updateQueueItem(runId, updates);
      } else if (event.type === 'complete') {
        const roundsUsed = event.rounds_used || event.rounds?.length || 1;
        const generated = event.total_ads_generated || event.ads_scored || '?';
        const passed = event.ads_passed ?? '?';
        const readyCount = event.ready_to_post_count ?? 0;
        const requiredPasses = event.required_passes || nextQueued.adsPerAdSetTarget || 5;
        const adSetsCreated = event.ad_sets_created ?? event.flex_ads_created ?? 0;
        const msg = adSetsCreated > 0
          ? `Reached ${passed}/${requiredPasses} after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${generated} generated). ${readyCount} Ready to Post ads created.`
          : `Complete — ${passed}/${requiredPasses} passed after ${generated} generated.`;
        updateQueueItem(runId, { status: 'complete', progress: 100, phase: msg, result: event, serverRunId: event.runId || null });
        finishRun(runId, false);
      } else if (event.type === 'background') {
        sseActiveRef.current = false;
        abortRef.current = null;
        updateQueueItem(runId, {
          status: 'running',
          sseConnected: false,
          progress: Math.max(nextQueued.progress || 0, 22),
          phase: event.phase || event.background_message || 'Still processing in background...',
          result: event,
          serverRunId: event.runId || null,
          finalReconcileAttempts: 0,
        });
      } else if (event.type === 'queued') {
        sseActiveRef.current = false;
        abortRef.current = null;
        updateQueueItem(runId, {
          status: 'queued',
          sseConnected: false,
          serverQueued: true,
          progress: 0,
          phase: event.message || `Queued at position ${event.queue_position || 1}.`,
          result: event,
          serverRunId: event.runId || null,
          queuePosition: event.queue_position || null,
        });
      } else if (event.type === 'error') {
        const cancelled = event.terminal_status === 'cancelled' || event.message === 'Cancelled by user';
        updateQueueItem(runId, { status: 'error', progress: 0, phase: event.message || 'Failed', result: event, serverRunId: event.runId || null });
        if (!cancelled) {
          toast.error(event.message || 'Test run failed');
        }
        finishRun(runId, true);
      }
    });

    abortRef.current = abort;

    done.catch((err) => {
      if (err.name !== 'AbortError') {
        sseActiveRef.current = false;
        if (!sawEvent) {
          updateQueueItem(runId, { status: 'error', progress: 0, phase: err.message || 'Failed to start test run' });
          toast.error(err.message || 'Failed to start test run');
          finishRun(runId, true);
          return;
        }
        // SSE disconnected after the run had already started — let polling reconnect.
        updateQueueItem(runId, { sseConnected: false });
      }
    });
  }, [queueLoadedFor, testRunQueue, selectedProject, updateQueueItem, finishRun, toast]);

  // Polling reconnect / hydration — keeps the server-backed progress bar alive after refresh
  useEffect(() => {
    const running = testRunQueue.find(r => r.status === 'running');
    if (sseActiveRef.current) return;
    if (!selectedProject) return;
    if (queueLoadedFor !== selectedProject) return;

    const poll = async () => {
      try {
        const res = await api.getTestRunProgress(selectedProject);
        if (res.active) {
          setRunningAction('run');
          if (running) {
            updateQueueItem(running.id, {
              progress: res.active.progress,
              phase: res.active.phase,
              startTime: running.startTime || res.active.startTime,
              result: res.active.result || running.result || null,
              serverRunId: res.active.runId || res.active.id || running.serverRunId || null,
              finalReconcileAttempts: 0,
            });
          } else {
            setTestRunQueue(prev => {
              const safePrev = ensureArray(prev, 'AgentMonitor.director.testRunQueueState');
              const existing = safePrev.find(item => item.serverRunId && item.serverRunId === (res.active.runId || res.active.id));
              if (existing) {
                return safePrev.map(item => item.id === existing.id ? buildServerQueueItem(res.active, item) : item);
              }
              return [buildServerQueueItem(res.active), ...safePrev];
            });
          }
          return;
        }

        if (!running) {
          setRunningAction(null);
          return;
        }

        // No active tracker: reconcile against durable conductor_runs before deciding the run is done.
        const runRes = await api.getConductorRuns(selectedProject, 20);
        const safeRuns = ensureArray(runRes?.runs, 'AgentMonitor.director.runs');
        setRuns(safeRuns);
        setRunsLoadedFor(selectedProject);
        const matchedRun = findDurableRunForQueueItem(safeRuns, running);
        const activeDurableRun = getQueueRunId(running) ? null : safeRuns.find(run => isDurableRunActive(run));
        const durableRun = matchedRun || activeDurableRun || null;

        if (durableRun && isDurableRunActive(durableRun)) {
          updateQueueItem(running.id, {
            status: 'running',
            progress: Math.max(running.progress || 0, durableRun?.terminal_status === 'waiting_on_gemini' ? 22 : running.progress || 0),
            phase: durableRun?.decisions || 'Still processing in background...',
            result: durableRun || null,
            serverRunId: getDurableRunId(durableRun) || running.serverRunId || null,
          });
          return;
        }

        if (!durableRun) {
          const attempts = Number(running.finalReconcileAttempts || 0) + 1;
          if (attempts <= TEST_RUN_FINAL_RECONCILE_ATTEMPTS) {
            updateQueueItem(running.id, {
              status: 'running',
              sseConnected: false,
              progress: Math.max(running.progress || 0, 22),
              phase: 'Checking final run status...',
              finalReconcileAttempts: attempts,
              serverRunId: running.serverRunId || null,
            });
            return;
          }

          updateQueueItem(running.id, {
            status: 'error',
            progress: 0,
            phase: 'No durable test run record was found after background handoff. Refreshing run history...',
            finalReconcileAttempts: attempts,
            serverRunId: running.serverRunId || null,
          });
          finishRun(running.id, true);
          return;
        }

        const succeeded = isDurableRunSuccess(durableRun);
        const failed = isDurableRunFailure(durableRun);
        if (!succeeded && !failed) {
          updateQueueItem(running.id, {
            status: 'running',
            progress: Math.max(running.progress || 0, durableRun?.terminal_status === 'waiting_on_gemini' ? 22 : running.progress || 0),
            phase: durableRun?.decisions || 'Checking final run status...',
            result: durableRun || null,
            serverRunId: getDurableRunId(durableRun) || running.serverRunId || null,
            finalReconcileAttempts: 0,
          });
          return;
        }

        updateQueueItem(running.id, {
          status: succeeded ? 'complete' : 'error',
          progress: succeeded ? 100 : 0,
          phase: succeeded ? (durableRun?.decisions || 'Complete') : (durableRun?.failure_reason || durableRun?.error || 'Failed'),
          result: durableRun || null,
          serverRunId: getDurableRunId(durableRun) || running.serverRunId || null,
          finalReconcileAttempts: 0,
        });
        finishRun(running.id, !succeeded);
        return; // Stop polling
      } catch {}
    };

    // Poll immediately, then every 3 seconds
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [activeRun?.id, queueLoadedFor, selectedProject, testRunQueue, updateQueueItem, finishRun]);

  const handleAddAngle = async () => {
    if (!newAngle.name) return;
    // Auto-compute description if structured fields are present but description is empty
    let description = newAngle.description;
    if (!description && (newAngle.core_buyer || newAngle.symptom_pattern)) {
      const parts = [];
      if (newAngle.core_buyer) parts.push(`Core Buyer: ${newAngle.core_buyer}`);
      if (newAngle.symptom_pattern) parts.push(`Symptom Pattern: ${newAngle.symptom_pattern}`);
      if (newAngle.objection) parts.push(`Objection: ${newAngle.objection}`);
      if (newAngle.scene) parts.push(`Scene: ${newAngle.scene}`);
      if (newAngle.desired_belief_shift) parts.push(`Desired Belief Shift: ${newAngle.desired_belief_shift}`);
      description = parts.join('\n');
    }
    if (!description) return;
    try {
      await api.createConductorAngle(selectedProject, {
        name: newAngle.name,
        description,
        prompt_hints: newAngle.prompt_hints || undefined,
        source: 'manual',
        status: 'active',
        priority: newAngle.priority || undefined,
        frame: newAngle.frame || undefined,
        core_buyer: newAngle.core_buyer || undefined,
        symptom_pattern: newAngle.symptom_pattern || undefined,
        failed_solutions: newAngle.failed_solutions || undefined,
        current_belief: newAngle.current_belief || undefined,
        objection: newAngle.objection || undefined,
        emotional_state: newAngle.emotional_state || undefined,
        scene: newAngle.scene || undefined,
        desired_belief_shift: newAngle.desired_belief_shift || undefined,
        tone: newAngle.tone || undefined,
        avoid_list: newAngle.avoid_list || undefined,
      });
      setNewAngle({ name: '', description: '', prompt_hints: '', priority: 'medium', frame: 'symptom-first', core_buyer: '', symptom_pattern: '', failed_solutions: '', current_belief: '', objection: '', emotional_state: '', scene: '', desired_belief_shift: '', tone: '', avoid_list: '' });
      setShowAddAngle(false);
      const angRes = await api.getConductorAngles(selectedProject);
      setAngles(ensureArray(angRes?.angles, 'AgentMonitor.director.angles'));
      setAnglesLoadedFor(selectedProject);
      loadAngleOptions(selectedProject, { force: true });
    } catch { /* ignore */ }
  };

  const applyAngleStatusChange = async (angleId, newStatus) => {
    try {
      await api.updateConductorAngle(selectedProject, angleId, { status: newStatus });
      setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(a => a.externalId === angleId ? { ...a, status: newStatus } : a));
      setAngleOptions(prev => {
        const safePrev = ensureArray(prev, 'AgentMonitor.director.angleOptionsState');
        if (newStatus === 'active') {
          const fullMatch = ensureArray(angles, 'AgentMonitor.director.anglesState').find(a => a.externalId === angleId);
          if (fullMatch && !safePrev.some(a => a.externalId === angleId)) return [...safePrev, { ...fullMatch, status: newStatus }];
          return safePrev.map(a => a.externalId === angleId ? { ...a, status: newStatus } : a);
        }
        return safePrev.filter(a => a.externalId !== angleId);
      });
    } catch { /* ignore */ }
  };

  const handleAngleStatusChange = async (angleId, newStatus) => {
    const angle = ensureArray(angles, 'AgentMonitor.director.anglesState').find(a => a.externalId === angleId);
    if (newStatus === 'archived' && angle?.is_system_default === true) {
      setDefaultArchivePrompt({ angle, ids: [angleId] });
      return;
    }
    await applyAngleStatusChange(angleId, newStatus);
  };

  const handleUpdateAngle = async (angleId, updates) => {
    await api.updateConductorAngle(selectedProject, angleId, updates);
    setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(a => a.externalId === angleId ? { ...a, ...updates } : a));
    setAngleOptions(prev => ensureArray(prev, 'AgentMonitor.director.angleOptionsState').map(a => a.externalId === angleId ? { ...a, ...updates } : a));
  };

  const toggleAngleSelected = useCallback((angleId) => {
    setSelectedAngleIds(prev => prev.includes(angleId)
      ? prev.filter(id => id !== angleId)
      : [...prev, angleId]);
  }, []);

  const archiveAngleIds = useCallback(async (angleIds) => {
    const ids = ensureArray(angleIds, 'AgentMonitor.director.archiveAngleIds').filter(Boolean);
    if (!ids.length) return;
    try {
      await Promise.all(ids.map(id => api.updateConductorAngle(selectedProject, id, { status: 'archived' })));
      setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(angle => (
        ids.includes(angle.externalId) ? { ...angle, status: 'archived' } : angle
      )));
      setAngleOptions(prev => ensureArray(prev, 'AgentMonitor.director.angleOptionsState').filter(angle => !ids.includes(angle.externalId)));
      setSelectedAngleIds(prev => prev.filter(id => !ids.includes(id)));
      toast.success(`${ids.length} angle${ids.length !== 1 ? 's' : ''} archived`);
    } catch (err) {
      toast.error(err?.message || 'Failed to archive selected angles');
    }
  }, [selectedProject, toast]);

  const handleArchiveSelectedAngles = useCallback(async () => {
    const ids = selectedAngleIds.filter(Boolean);
    if (!ids.length) return;
    const defaultAngle = ensureArray(angles, 'AgentMonitor.director.anglesState')
      .find(angle => ids.includes(angle.externalId) && angle.is_system_default === true);
    if (defaultAngle) {
      setDefaultArchivePrompt({ angle: defaultAngle, ids });
      return;
    }
    await archiveAngleIds(ids);
  }, [archiveAngleIds, angles, selectedAngleIds]);

  const handleConfirmDefaultArchive = useCallback(async () => {
    if (!defaultArchivePrompt?.ids?.length) return;
    setDefaultArchiveBusy(true);
    try {
      await archiveAngleIds(defaultArchivePrompt.ids);
      setDefaultArchivePrompt(null);
    } finally {
      setDefaultArchiveBusy(false);
    }
  }, [archiveAngleIds, defaultArchivePrompt]);

  // --- Copy LLM prompt for generating a new angle list ---
  // Builds a detailed prompt, embedding the project's brand/product context, that the user
  // can paste into ChatGPT/Claude to get back markdown that pastes directly into Import.
  const [copyingPrompt, setCopyingPrompt] = useState(false);

  const handleCopyAnglePrompt = async () => {
    if (!selectedProject) return;
    setCopyingPrompt(true);
    try {
      const project = await api.getProject(selectedProject);
      const brand = project?.brand_name || project?.name || '(unknown brand)';
      const productName = project?.name || '';
      const niche = project?.niche || '(not specified)';
      const productDesc = project?.product_description || '(not specified)';
      const docsData = await api.getDocs(selectedProject);
      const foundationalDocs = ensureArray(docsData?.docs, 'AgentMonitor.copyAnglePrompt.docs');

      const promptText = buildAnglePromptText({
        brand,
        productName,
        niche,
        productDesc,
        salesPageContent: project?.sales_page_content || '',
        foundationalDocs,
      });
      await navigator.clipboard.writeText(promptText);
      toast.success('Prompt copied. Paste it into ChatGPT/Claude, then save the reply as a .md file and import it here.');
    } catch (err) {
      console.error('[AgentMonitor] Copy angle prompt failed:', err);
      toast.error('Could not copy prompt. ' + (err?.message || ''));
    } finally {
      setCopyingPrompt(false);
    }
  };

  // --- Export angles as markdown ---
  const handleDownloadAngles = () => {
    const allAngles = ensureArray(angles, 'AgentMonitor.director.anglesState');
    if (allAngles.length === 0) return;
    const grouped = { active: [], testing: [], archived: [] };
    allAngles.forEach(a => {
      const bucket = a.status === 'retired' ? grouped.archived : (grouped[a.status] || grouped.active);
      bucket.push(a);
    });

    let md = '# Angles\n\n';
    const writeSection = (list) => {
      list.forEach(a => {
        md += `## ${a.name}\n`;
        md += `- **Status**: ${a.status || 'active'}\n`;
        md += `- **Source**: ${a.source || 'manual'}\n`;
        md += `- **Focused**: ${a.focused ? 'yes' : 'no'}\n`;
        if (a.prompt_hints) md += `- **Prompt Hints**: ${a.prompt_hints}\n`;
        if (a.performance_note) md += `- **Performance Note**: ${a.performance_note}\n`;
        md += `\n${a.description || ''}\n\n---\n\n`;
      });
    };
    if (grouped.active.length) { md += '<!-- Active -->\n\n'; writeSection(grouped.active); }
    if (grouped.testing.length) { md += '<!-- Testing -->\n\n'; writeSection(grouped.testing); }
    if (grouped.archived.length) { md += '<!-- Archived -->\n\n'; writeSection(grouped.archived); }

    const blob = new Blob([md.trim() + '\n'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'angles-export.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Parse markdown into angle objects (supports both old flat + new structured formats) ---
  const SECTION_MAP = {
    'core buyer': 'core_buyer',
    'symptom pattern': 'symptom_pattern',
    'failed solutions': 'failed_solutions',
    'current belief': 'current_belief',
    'objection': 'objection',
    'emotional state': 'emotional_state',
    'scene to center the ad on': 'scene',
    'desired belief shift': 'desired_belief_shift',
    'tone': 'tone',
    'avoid': 'avoid_list',
  };

  const parseAnglesMarkdown = (text) => {
    text = String(text || '').trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
    // Split by --- separators (new format) or ## headings (old format)
    const hasStructuredSections = text.includes('### Core Buyer') || text.includes('### Symptom Pattern');

    if (hasStructuredSections) {
      // New structured format: split by --- separators
      const blocks = text.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
      const parsed = [];
      for (const block of blocks) {
        const titleMatch = block.match(/^##\s+(.+)/m);
        if (!titleMatch) continue;
        const name = titleMatch[1].trim();
        // Skip meta sections
        if (name.startsWith('Removed from') || name === 'De-prioritized or Removed' ||
            name.startsWith('Notes for System') || name.startsWith('Best categories') ||
            name.startsWith('What should') || name.startsWith('Strong output') ||
            name.startsWith('Weak output')) continue;

        const angle = { name, source: 'imported', status: 'active' };

        // Extract metadata bullets
        const statusMatch = block.match(/\*\*Status\*\*:\s*(.+)/i);
        if (statusMatch) angle.status = statusMatch[1].trim().toLowerCase();
        const priorityMatch = block.match(/\*\*Priority\*\*:\s*(.+)/i);
        if (priorityMatch) angle.priority = priorityMatch[1].trim().toLowerCase();
        const frameMatch = block.match(/\*\*Frame\*\*:\s*(.+)/i);
        if (frameMatch) angle.frame = frameMatch[1].trim().toLowerCase();

        // Extract ### sections
        const sectionRegex = /###\s+(.+)\n([\s\S]*?)(?=###|\n---|\n##|$)/g;
        let match;
        while ((match = sectionRegex.exec(block)) !== null) {
          const sectionTitle = match[1].trim().toLowerCase();
          const sectionContent = match[2].trim();
          const fieldKey = SECTION_MAP[sectionTitle];
          if (fieldKey && sectionContent) angle[fieldKey] = sectionContent;
        }

        // Auto-compute description from structured fields
        const descParts = [];
        if (angle.core_buyer) descParts.push(`Core Buyer: ${angle.core_buyer}`);
        if (angle.symptom_pattern) descParts.push(`Symptom Pattern: ${angle.symptom_pattern}`);
        if (angle.objection) descParts.push(`Objection: ${angle.objection}`);
        if (angle.scene) descParts.push(`Scene: ${angle.scene}`);
        if (angle.desired_belief_shift) descParts.push(`Desired Belief Shift: ${angle.desired_belief_shift}`);
        angle.description = descParts.length > 0 ? descParts.join('\n') : 'No structured brief provided.';

        if (angle.name && (angle.core_buyer || angle.symptom_pattern)) parsed.push(angle);
      }
      return parsed;
    }

    // Old flat format fallback
    const sections = text.split(/\n## /).slice(1);
    const parsed = [];
    for (const section of sections) {
      const lines = section.split('\n');
      const name = lines[0].trim();
      if (!name) continue;

      let status = 'active', source = 'manual', focused = false, promptHints = '', performanceNote = '';
      const descLines = [];
      let pastMeta = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const metaMatch = line.match(/^- \*\*(.+?)\*\*:\s*(.+)/);
        if (metaMatch && !pastMeta) {
          const key = metaMatch[1].toLowerCase();
          const val = metaMatch[2].trim();
          if (key === 'status') status = val.toLowerCase();
          else if (key === 'source') source = val.toLowerCase();
          else if (key === 'focused') focused = val.toLowerCase() === 'yes';
          else if (key === 'prompt hints') promptHints = val;
          else if (key === 'performance note') performanceNote = val;
        } else {
          pastMeta = true;
          if (line.trim() !== '---') descLines.push(line);
        }
      }
      const description = descLines.join('\n').trim();
      if (!description) continue;

      parsed.push({ name, description, status, source, focused, prompt_hints: promptHints, performance_note: performanceNote });
    }
    return parsed;
  };

  // --- Handle file read for import ---
  const handleImportFile = (file) => {
    if (!file || !file.name.endsWith('.md')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const parsed = parseAnglesMarkdown(text);
      const existingByName = new Map();
      ensureArray(angles, 'AgentMonitor.director.anglesState').forEach((angle) => {
        const key = normalizeAngleNameForMatch(angle.name);
        if (!key) return;
        if (!existingByName.has(key)) existingByName.set(key, []);
        existingByName.get(key).push(angle);
      });

      const newAngles = [];
      const archivedMatches = [];
      const activeMatches = [];

      parsed.forEach((angle) => {
        const matches = existingByName.get(normalizeAngleNameForMatch(angle.name)) || [];
        const activeMatch = matches.find(existing => existing.status === 'active' || existing.status === 'testing');
        const archivedMatch = matches.find(existing => existing.status === 'archived' || existing.status === 'retired');
        if (activeMatch) {
          activeMatches.push({ angle, existingAngle: activeMatch });
        } else if (archivedMatch) {
          archivedMatches.push({ angle, existingAngle: archivedMatch });
        } else {
          newAngles.push(angle);
        }
      });

      setImportResult({
        newAngles,
        archivedMatches,
        activeMatches,
        skipped: [...archivedMatches.map(match => match.angle), ...activeMatches.map(match => match.angle)],
      });
    };
    reader.readAsText(file);
  };

  const performImport = async ({ newAngles = [], archivedMatches = [] } = {}) => {
    setImporting(true);
    try {
      for (const match of archivedMatches) {
        if (match?.existingAngle?.externalId) {
          await api.updateConductorAngle(selectedProject, match.existingAngle.externalId, { status: 'active' });
        }
      }
      for (const angle of newAngles) {
        await api.createConductorAngle(selectedProject, {
          name: angle.name,
          description: angle.description,
          prompt_hints: angle.prompt_hints || undefined,
          source: angle.source || 'imported',
          status: angle.status || 'active',
          priority: angle.priority || undefined,
          frame: angle.frame || undefined,
          core_buyer: angle.core_buyer || undefined,
          symptom_pattern: angle.symptom_pattern || undefined,
          failed_solutions: angle.failed_solutions || undefined,
          current_belief: angle.current_belief || undefined,
          objection: angle.objection || undefined,
          emotional_state: angle.emotional_state || undefined,
          scene: angle.scene || undefined,
          desired_belief_shift: angle.desired_belief_shift || undefined,
          tone: angle.tone || undefined,
          avoid_list: angle.avoid_list || undefined,
        });
      }
      const angRes = await api.getConductorAngles(selectedProject);
      setAngles(ensureArray(angRes?.angles, 'AgentMonitor.director.angles'));
      setAnglesLoadedFor(selectedProject);
      loadAngleOptions(selectedProject, { force: true });
      setImportResult(null);
      setImportDedupPrompt(null);
      setShowImport(false);
      const importedCount = newAngles.length + archivedMatches.length;
      if (importedCount > 0) toast.success(`${importedCount} angle${importedCount !== 1 ? 's' : ''} imported or restored`);
    } catch (err) {
      toast.error(err?.message || 'Failed to import angles');
    }
    finally { setImporting(false); }
  };

  const handleConfirmImport = async () => {
    if (!importResult) return;
    const hasDuplicates = (importResult.archivedMatches?.length || 0) > 0 || (importResult.activeMatches?.length || 0) > 0;
    if (hasDuplicates) {
      setImportDedupPrompt(importResult);
      return;
    }
    if (!importResult.newAngles?.length) return;
    await performImport({ newAngles: importResult.newAngles });
  };

  const safeProjects = ensureArray(projects, 'AgentMonitor.director.projectsState');
  const safeAngles = ensureArray(angles, 'AgentMonitor.director.anglesState');
  const safeAngleOptions = ensureArray(angleOptions, 'AgentMonitor.director.angleOptionsState');
  const safeRuns = ensureArray(runs, 'AgentMonitor.director.runsState');
  const safeCampaigns = ensureArray(campaigns, 'AgentMonitor.director.campaignsState');
  const templateTags = useMemo(() => getTemplateTags(templates), [templates]);
  const angleTags = useMemo(() => getAngleTags(safeAngles), [safeAngles]);
  const angleTagFilter = config?.angle_tag_filter || '';
  const filteredAngleOptions = useMemo(() => (
    angleTagFilter
      ? safeAngleOptions.filter(angle => angleHasTag(angle, angleTagFilter))
      : safeAngleOptions
  ), [angleTagFilter, safeAngleOptions]);
  const adsPerAdSetValue = adsPerAdSetDraft ?? (
    embedded && externalProject?.ads_per_ad_set != null
      ? externalProject.ads_per_ad_set
      : config?.ads_per_batch ?? 5
  );
  const automationCampaignValue = config?.default_campaign_id
    || externalProject?.scout_default_campaign
    || externalProject?.default_campaign_id
    || '';
  const defaultTestAdSetTarget = Math.max(1, Math.min(20, Number(adsPerAdSetValue) || 5));
  const parsedTestAdSetTarget = Number.parseInt(testAdSetTargetDraft, 10);
  const testAdSetTargetValue = Number.isFinite(parsedTestAdSetTarget)
    ? Math.max(1, Math.min(20, parsedTestAdSetTarget))
    : defaultTestAdSetTarget;

  const subTabs = [
    { id: 'settings', label: 'Settings' },
    { id: 'history', label: 'Run History' },
    { id: 'angles', label: 'Angles' },
  ];

  const pinSystemFirst = (list) => list.sort((a, b) => (b.is_system_default ? 1 : 0) - (a.is_system_default ? 1 : 0));
  const angleCountsReady = anglesLoadedFor === selectedProject || angleOptionsLoadedFor === selectedProject;
  const activeAngleCountSource = anglesLoadedFor === selectedProject
    ? safeAngles.filter(a => a.status === 'active')
    : angleOptionsLoadedFor === selectedProject
      ? safeAngleOptions
      : [];
  const angleCount = activeAngleCountSource.length;
  const customAngleCount = activeAngleCountSource.filter(angle => angle.is_system_default !== true).length;
  const activeAngles = subTab === 'angles' || anglesLoadedFor === selectedProject
    ? pinSystemFirst(safeAngles.filter(a => a.status === 'active'))
    : [];
  const testingAngles = subTab === 'angles' || anglesLoadedFor === selectedProject
    ? safeAngles.filter(a => a.status === 'testing')
    : [];
  const archivedAngles = subTab === 'angles' || anglesLoadedFor === selectedProject
    ? pinSystemFirst(safeAngles.filter(a => a.status === 'archived' || a.status === 'retired'))
    : [];
  const selectableAnglesForBulk = [...activeAngles, ...testingAngles].filter(angle => angle.is_system_default !== true);
  const selectedVisibleAngleCount = selectableAnglesForBulk.filter(angle => selectedAngleIds.includes(angle.externalId)).length;
  const allVisibleAnglesSelected = selectableAnglesForBulk.length > 0 && selectedVisibleAngleCount === selectableAnglesForBulk.length;
  const foundationalDocsComplete = foundationalDocsLoadedFor === selectedProject && hasCompleteFoundationalDocs(foundationalDocs);

  useEffect(() => {
    if (!selectedAngleId) return;
    if (filteredAngleOptions.some(angle => angle.externalId === selectedAngleId)) return;
    setSelectedAngleId('');
  }, [filteredAngleOptions, selectedAngleId]);

  if (projectLoading) return <div className="text-[11px] text-ed-ink3 py-4">{embedded ? 'Loading Director...' : 'Loading projects...'}</div>;
  if (!embedded && safeProjects.length === 0) return <div className="text-[11px] text-ed-ink3 py-4">No projects found.</div>;
  if (!selectedProject) return <div className="text-[11px] text-ed-ink3 py-4">{embedded ? 'Loading Director...' : 'Select a project to load Director settings.'}</div>;

  const canChooseAngle = !angleOptionsLoading;
  const canTriggerTestRun = !baseLoading && !!config && !!selectedAngleId && testAdSetTargetValue >= 1 && testAdSetTargetValue <= 20;

  return (
    <div>
      {/* Project selector + controls */}
      <div className="flex items-center gap-3 mb-4">
        {!embedded && (
          <select
            value={selectedProject}
            onChange={e => setSelectedProject(e.target.value)}
            className="text-[12px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
          >
            {safeProjects.map(p => (
              <option key={p.id} value={p.id}>{p.displayName || p.brand_name || p.name}</option>
            ))}
          </select>
        )}

        <label className={`flex items-center gap-2 text-[11px] ${baseLoading ? 'text-ed-ink3 cursor-not-allowed' : 'text-ed-ink2 cursor-pointer'}`}>
          <div
            onClick={() => {
              if (baseLoading) return;
              handleSaveConfig({ enabled: !(config?.enabled) });
            }}
            className={`relative w-7 h-4 rounded-full transition-colors duration-200 cursor-pointer ${config?.enabled ? 'bg-ed-green/30' : 'bg-black/10'}`}
          >
            <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200 shadow-sm ${config?.enabled ? 'left-3.5 bg-ed-green' : 'left-0.5 bg-ed-ink3'}`} />
          </div>
          <span className="inline-flex items-center gap-1">
            Enable Creative Director
            <InfoTooltip text="When on, the Director runs automatically at 7am / 7pm / 1am ICT. Generated ads land in Staging for review." position="bottom" />
          </span>
        </label>

        <div className="ml-auto grid grid-cols-1 sm:grid-cols-[minmax(180px,260px)_130px_minmax(160px,220px)_auto] items-end gap-2">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-ed-ink3 mb-1">Test Angle</label>
            <select
              data-testid="director-test-angle-select"
              value={selectedAngleId}
              onChange={e => setSelectedAngleId(e.target.value)}
              onFocus={() => {
                if (angleOptionsLoadedFor !== selectedProject) {
                  loadAngleOptions(selectedProject);
                }
              }}
              disabled={!canChooseAngle}
              className="text-[11px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-2 py-1.5 cursor-pointer w-full"
            >
              <option value="">
                {angleOptionsLoading
                  ? 'Loading angles...'
                  : angleTagFilter && filteredAngleOptions.length === 0
                    ? `No active angles tagged "${angleTagFilter}"`
                    : 'Select an angle...'}
              </option>
              {[...filteredAngleOptions].sort((a, b) => (b.is_system_default ? 1 : 0) - (a.is_system_default ? 1 : 0)).map(a => (
                <option key={a.externalId} value={a.externalId}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-ed-ink3 mb-1">Ads in Test Ad Set</label>
            <input
              data-testid="director-test-target-input"
              type="number"
              min="1"
              max="20"
              value={testAdSetTargetDraft === '' ? defaultTestAdSetTarget : testAdSetTargetDraft}
              onChange={(e) => {
                const value = e.target.value;
                if (value === '') {
                  setTestAdSetTargetDraft('');
                  return;
                }
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed)) return;
                setTestAdSetTargetDraft(String(Math.max(1, Math.min(20, parsed))));
              }}
              className="text-[11px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-2 py-1.5 w-full"
              title="Target number of QA-approved ads in this test ad set."
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-ed-ink3 mb-1">Template Tag</label>
            <select
              value={testTemplateTag}
              onChange={e => setTestTemplateTag(e.target.value)}
              onFocus={() => loadTemplates(selectedProject)}
              className="text-[11px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-2 py-1.5 cursor-pointer w-full"
              title="Optional. Limit this test run to active templates with the selected tag."
            >
              <option value="">Any active template</option>
              {templateTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
            </select>
            <TemplateTagHelp projectId={selectedProject} hasTags={templateTags.length > 0} className="text-[9px]" />
          </div>
          <div className="flex items-center gap-1">
            <button
              data-testid="director-test-run-button"
              onClick={handleTestRun}
              disabled={!canTriggerTestRun}
              className="px-3 py-1.5 rounded-[7px] text-[11px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors flex items-center gap-1 disabled:opacity-50"
              title={!selectedAngleId ? 'Select a test angle first.' : `Create a test ad set with ${testAdSetTargetValue} approved ads.`}
            >
              {activeRun ? <><Spinner /> {queuedRuns.length > 0 ? `Running (${queuedRuns.length} queued)` : 'Running...'}</> : queuedRuns.length > 0 ? `Queue Run (${queuedRuns.length} queued)` : 'Test Run'}
            </button>
            <InfoTooltip text="Trigger one immediate batch for this angle. Each test run uses LLM credits (a few dollars per batch). Results land in Staging within 5–15 minutes." position="bottom" />
          </div>
        </div>
      </div>

      {/* Test run progress bar + cancel */}
      {activeRun && (
        <div className="mb-4">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <PipelineProgress
                progress={activeRun.progress}
                message={activeRun.phase}
                startTime={activeRun.startTime}
                timeMode="elapsed"
              />
            </div>
            <button
              onClick={handleCancelRun}
              disabled={activeRunCanceling}
              className="text-[10px] text-ed-rust hover:text-ed-rust font-medium px-2 py-0.5 rounded hover:bg-ed-rust/5 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              title={activeRunCanceling ? 'Cancel request sent' : 'Cancel running test'}
            >
              {activeRunCanceling ? 'Cancelling...' : 'Cancel'}
            </button>
          </div>
          {showActiveRunBreakdown && (
            <details key={activeRun.serverRunId || activeRun.id} className="mt-2 rounded-lg bg-black/[0.02] border border-black/5">
              <summary className="flex items-center justify-between gap-3 cursor-pointer list-none px-3 py-2 text-[11px] text-ed-ink2">
                <span className="font-medium text-ed-ink">Current round details</span>
                <span>
                  {activeRunPassed === null || activeRunPassed === undefined
                    ? 'Show details'
                    : `${activeRunPassed}/${activeRunRequiredPasses} passed so far`}
                </span>
              </summary>
              <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-2">
                {activeRunRounds.length > 0 ? (
                  activeRunRounds.map((round, index) => (
                    <div key={round.batch_id || `${activeRun.id}-${index}`} className="rounded-lg bg-ed-surface/70 border border-black/5 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] font-medium text-ed-ink">Round {round.round || index + 1}</p>
                        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getRoundStatusClasses(round)}`}>
                          {round.status === 'threshold_reached' ? 'threshold reached' : 'below threshold'}
                        </span>
                      </div>
                      <p className="text-[10px] text-ed-ink2 mt-1">
                        Batch {round.batch_id ? `${round.batch_id.slice(0, 8)}...` : '\u2013'}
                      </p>
                      <p className="text-[11px] text-ed-ink mt-1">
                        {round.ads_generated ?? round.ads_scored ?? 0} generated, {round.ads_passed ?? 0}/{round.ads_scored ?? round.ads_generated ?? 0} passed in this round, {round.cumulative_passed ?? 0}/{activeRunRequiredPasses} cumulative.
                      </p>
                      <RoundHeadlineDiagnostics round={round} />
                      {round.completed_at && (
                        <p className="text-[9px] text-ed-ink3 mt-1">{timeAgo(round.completed_at)}</p>
                      )}
                    </div>
                  ))
                ) : (
                  activeRunBatches.map((batch, index) => (
                    <div key={batch.batch_id || `${activeRun.id}-${index}`} className="rounded-lg bg-ed-surface/70 border border-black/5 px-3 py-2">
                      <p className="text-[11px] font-medium text-ed-ink">Batch {index + 1}</p>
                      <p className="text-[10px] text-ed-ink2 mt-1">
                        ID {batch.batch_id ? `${batch.batch_id.slice(0, 8)}...` : '\u2013'} · {batch.ad_count || '\u2013'} ads
                      </p>
                    </div>
                  ))
                )}
              </div>
            </details>
          )}
        </div>
      )}
      {queuedRuns.length > 0 && (
        <div className="mb-4 rounded-lg border border-black/5 bg-black/[0.02] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-ed-ink3">
              {queuedRuns.length} run{queuedRuns.length !== 1 ? 's' : ''} queued{activeRun ? '' : ', waiting for the scheduler...'}
            </p>
            <button
              onClick={handleClearQueue}
              className="text-[10px] text-ed-ink3 hover:text-ed-rust transition-colors"
            >
              Clear queue
            </button>
          </div>
          <div className="mt-2 space-y-1.5">
            {queuedRuns.map((run, index) => (
              <div key={run.id} className="flex items-center justify-between gap-3 rounded-md bg-ed-surface/70 border border-black/5 px-2 py-1.5">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium text-ed-ink">
                    Position {run.queuePosition || index + 1}
                    {run.result?.runId || run.serverRunId ? <span className="text-ed-ink3 font-normal"> · Run {(run.result?.runId || run.serverRunId).slice(0, 8)}</span> : null}
                  </p>
                  <p className="text-[10px] text-ed-ink3 truncate">{run.phase || 'Queued behind the current Creative Director run.'}</p>
                </div>
                <button
                  onClick={() => handleRemoveQueued(run.id)}
                  className="text-[10px] text-ed-rust hover:text-ed-rust font-medium px-2 py-0.5 rounded hover:bg-ed-rust/5 transition-colors shrink-0"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent test run results */}
      {finishedRuns.length > 0 && (
        <div className="mb-4 space-y-2">
          {finishedRuns.map(run => {
            const queueRunId = getQueueRunId(run);
            const complete = isQueueRunComplete(run);
            return (
              <div
                key={run.id}
                className={`flex items-start gap-2 px-3 py-2 rounded-lg text-[11px] ${
                  complete ? 'bg-ed-green/5 border border-ed-green/20' : 'bg-ed-rust/10 border border-ed-rust/30'
                }`}
              >
                <span className="mt-0.5 shrink-0">
                  {complete ? (
                    <svg className="w-3.5 h-3.5 text-ed-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 text-ed-rust" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <p className={`font-medium ${complete ? 'text-ed-green' : 'text-ed-rust'}`}>
                    {complete ? 'Test Run Complete' : 'Test Run Failed'}
                  </p>
                  {queueRunId && (
                    <p className="text-[10px] text-ed-ink3 mt-0.5">Run {queueRunId.slice(0, 8)}</p>
                  )}
                  <p className="text-ed-ink2 mt-0.5">{run.phase}</p>
                  {run.result?.flex_ads_created > 0 && (
                    <button
                      onClick={() => navigate(run.result?.flex_ad_id
                        ? `/projects/${selectedProject}?tab=tracker&view=ready_to_post&adSetId=${run.result.flex_ad_id}`
                        : `/projects/${selectedProject}?tab=tracker&view=ready_to_post`)}
                      className="text-[10px] text-ed-accent hover:text-ed-accent font-medium mt-1 inline-flex items-center gap-1"
                    >
                      View in Ready to Post {'\u2192'}
                    </button>
                  )}
                </div>
                <button
                  onClick={() => handleDismissResult(run.id)}
                  className="text-ed-ink3 hover:text-ed-ink transition-colors shrink-0 mt-0.5"
                  title="Dismiss"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCell value={config?.daily_flex_target ?? '—'} label="Ad Set Target" color="text-ed-ink" />
        <StatCell value={adsPerAdSetValue ?? '—'} label="Ads/Ad Set" color="text-ed-ink" />
        <StatCell value={anglesLoadedFor === selectedProject ? activeAngles.length : '—'} label="Angles" color="text-ed-accent" />
        <StatCell value={runsLoadedFor === selectedProject ? safeRuns.filter(r => r.status === 'completed').length : '—'} label="Runs" color="text-ed-green" />
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-4 border-b border-black/5">
        {subTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={`text-[11px] font-medium py-2 px-3 border-b-2 transition-colors ${
              subTab === tab.id
                ? 'border-ed-accent text-ed-accent'
                : 'border-transparent text-ed-ink2 hover:text-ed-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {subTab === 'angles' && (
        <div>
          {anglesLoading && anglesLoadedFor !== selectedProject && (
            <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3 mb-3">
              <p className="text-[11px] text-ed-ink2">Loading angles...</p>
            </div>
          )}

          <DirectorSetupTipsPanel
            projectId={selectedProject}
            foundationalDocsComplete={foundationalDocsComplete}
            angleCount={angleCount}
            customAngleCount={customAngleCount}
            directorEnabled={!!config?.enabled}
            userRole={userRole}
          />

          {/* Focus mode banner */}
          {activeAngles.some(a => a.focused) && (
            <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-ed-accent/10 border border-ed-accent/20">
              <svg className="w-3.5 h-3.5 text-ed-accent flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <span className="text-[11px] text-ed-accent/90 font-medium">Focus mode — Director will only use focused angles</span>
            </div>
          )}

          {/* Export / Import toolbar */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <button
              onClick={() => {
                if (allVisibleAnglesSelected) {
                  setSelectedAngleIds([]);
                } else {
                  setSelectedAngleIds(selectableAnglesForBulk.map(angle => angle.externalId));
                }
              }}
              disabled={selectableAnglesForBulk.length === 0}
              className="ed-ghost text-[11px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-40"
            >
              <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${
                allVisibleAnglesSelected ? 'bg-ed-accent border-ed-accent text-white' : selectedVisibleAngleCount > 0 ? 'border-ed-accent text-ed-accent' : 'border-ed-line text-transparent'
              }`}>
                {allVisibleAnglesSelected ? '✓' : selectedVisibleAngleCount > 0 ? '–' : '✓'}
              </span>
              Select All
            </button>
            {selectedAngleIds.length > 0 && (
              <>
                <button
                  onClick={handleArchiveSelectedAngles}
                  className="px-3 py-1.5 rounded-[7px] text-[11px] bg-ed-rust text-white hover:bg-ed-rust/90 transition-colors"
                >
                  Archive selected ({selectedAngleIds.length})
                </button>
                <button
                  onClick={() => setSelectedAngleIds([])}
                  className="ed-ghost text-[11px] px-3 py-1.5"
                >
                  Clear
                </button>
              </>
            )}
            <button
              onClick={handleDownloadAngles}
              disabled={safeAngles.length === 0}
              className="ed-ghost text-[11px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-40"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" /></svg>
              Export
            </button>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setShowImport(!showImport); setImportResult(null); setImportDedupPrompt(null); }}
                className={`ed-ghost text-[11px] px-3 py-1.5 flex items-center gap-1.5 ${showImport ? 'ring-1 ring-ed-accent/30' : ''}`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M17 8l-5-5m0 0L7 8m5-5v12" /></svg>
                Import
              </button>
              <InfoTooltip text="Paste the markdown your LLM generated. Each angle in the markdown will be added to your project library." position="bottom" />
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleCopyAnglePrompt}
                disabled={!selectedProject || copyingPrompt}
                className="ed-ghost text-[11px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-40"
              >
                {copyingPrompt ? (
                  <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                )}
                {copyingPrompt ? 'Copying...' : 'Copy LLM Prompt'}
              </button>
              <InfoTooltip text="Copies a custom prompt to your clipboard. Paste it into any capable LLM (ChatGPT, Claude). The LLM walks you through generating angles and you import the result back here." position="bottom" />
            </div>
          </div>

          {/* Import panel */}
          {showImport && (
            <div className="mb-4 rounded-xl bg-ed-bg border border-black/10 p-4">
              {!importResult ? (
                <>
                  <p className="text-[12px] font-medium text-ed-ink mb-2">Import Angles from Markdown</p>
                  <p className="text-[10px] text-ed-ink2 mb-3">Upload a .md file with angles formatted as ## sections. Existing angles (matched by name) will be skipped.</p>
                  <div
                    onClick={() => importFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(false); }}
                    onDrop={(e) => {
                      e.preventDefault(); e.stopPropagation(); setImportDragOver(false);
                      const file = e.dataTransfer?.files?.[0];
                      if (file) handleImportFile(file);
                    }}
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all ${
                      importDragOver ? 'border-ed-accent bg-ed-accent/5' : 'border-ed-line hover:border-ed-accent hover:bg-ed-bg'
                    }`}
                  >
                    <div className="text-2xl text-gray-400 mb-2">{importDragOver ? '📂' : '📄'}</div>
                    <p className={`text-[12px] font-medium ${importDragOver ? 'text-ed-accent' : 'text-ed-ink2'}`}>
                      {importDragOver ? 'Drop file here' : 'Drop your .md file here, or click to browse'}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">Markdown files only (.md)</p>
                  </div>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".md"
                    onChange={(e) => { const file = e.target.files?.[0]; if (file) handleImportFile(file); e.target.value = ''; }}
                    className="hidden"
                  />
                </>
              ) : (
                <>
                  <p className="text-[12px] font-medium text-ed-ink mb-2">Import Preview</p>
                  {importResult.newAngles.length > 0 ? (
                    <div className="mb-3">
                      <p className="text-[11px] text-ed-green font-medium mb-1.5">{importResult.newAngles.length} new angle{importResult.newAngles.length !== 1 ? 's' : ''} to import:</p>
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {importResult.newAngles.map((a, i) => (
                          <div key={i} className="text-[11px] text-ed-ink bg-ed-green/5 rounded px-2.5 py-1.5 border border-ed-green/10">
                            <span className="font-medium">{a.name}</span>
                            <span className="text-ed-ink2 ml-2">{a.description.slice(0, 80)}{a.description.length > 80 ? '...' : ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-ed-ink2 mb-3">No new angles found — all angles in the file already exist.</p>
                  )}
                  {importResult.skipped.length > 0 && (
                    <div className="text-[10px] text-ed-ink3 mb-3 space-y-1">
                      <p>{importResult.skipped.length} angle{importResult.skipped.length !== 1 ? 's' : ''} matched existing library entries.</p>
                      {importResult.archivedMatches?.length > 0 && (
                        <p>{importResult.archivedMatches.length} archived match{importResult.archivedMatches.length !== 1 ? 'es' : ''}: {importResult.archivedMatches.map(match => match.existingAngle?.name || match.angle?.name).join(', ')}</p>
                      )}
                      {importResult.activeMatches?.length > 0 && (
                        <p>{importResult.activeMatches.length} active match{importResult.activeMatches.length !== 1 ? 'es' : ''}: {importResult.activeMatches.map(match => match.existingAngle?.name || match.angle?.name).join(', ')}</p>
                      )}
                    </div>
                  )}
                  <div className="flex gap-2">
                    {(importResult.newAngles.length > 0 || importResult.skipped.length > 0) && (
                      <button onClick={handleConfirmImport} disabled={importing} className="px-3 py-1.5 rounded-[7px] text-[11px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors disabled:opacity-50">
                        {importing ? 'Importing...' : importResult.skipped.length > 0 ? 'Review Import Options' : `Import ${importResult.newAngles.length} Angle${importResult.newAngles.length !== 1 ? 's' : ''}`}
                      </button>
                    )}
                    <button onClick={() => { setImportResult(null); setImportDedupPrompt(null); setShowImport(false); }} className="ed-ghost text-[11px] px-3 py-1.5">Cancel</button>
                    {!importing && importResult.newAngles.length === 0 && importResult.skipped.length === 0 && (
                      <button onClick={() => setImportResult(null)} className="ed-ghost text-[11px] px-3 py-1.5">Try Another File</button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Active angles */}
          {activeAngles.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] text-ed-ink3 font-medium uppercase tracking-wider mb-2">Active</p>
              <div className="space-y-2">
                {activeAngles.map(a => (
                  <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} onUpdate={handleUpdateAngle} selected={selectedAngleIds.includes(a.externalId)} onSelectToggle={toggleAngleSelected} />
                ))}
              </div>
            </div>
          )}

          {/* Testing angles */}
          {testingAngles.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] text-ed-ink3 font-medium uppercase tracking-wider mb-2">Testing (auto-generated)</p>
              <div className="space-y-2">
                {testingAngles.map(a => (
                  <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} onUpdate={handleUpdateAngle} showActions selected={selectedAngleIds.includes(a.externalId)} onSelectToggle={toggleAngleSelected} />
                ))}
              </div>
            </div>
          )}

          {/* Archived — collapsible */}
          {archivedAngles.length > 0 && (
            <div className="mb-4">
              <button
                onClick={() => setArchivedOpen(v => !v)}
                className="flex items-center gap-1.5 mb-2 group cursor-pointer"
              >
                <svg className={`w-3 h-3 text-ed-ink3 transition-transform ${archivedOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <p className="text-[10px] text-ed-ink3 font-medium uppercase tracking-wider group-hover:text-ed-ink2 transition-colors">Archived ({archivedAngles.length})</p>
              </button>
              {archivedOpen && (
                <div className="space-y-2">
                  {archivedAngles.map(a => (
                    <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} onUpdate={handleUpdateAngle} />
                  ))}
                </div>
              )}
            </div>
          )}

          {!baseLoading && activeAngles.length === 0 && testingAngles.length === 0 && archivedAngles.length === 0 && (
            <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3 mb-4">
              <p className="text-[11px] text-ed-ink2 mb-1.5">No angles yet.</p>
              <p className="text-[11px] text-ed-ink3">Add one below, or click <span className="font-medium text-ed-ink2">Copy LLM Prompt</span> above, paste it into ChatGPT or Claude, save the reply as a <code className="bg-black/5 px-1 rounded">.md</code> file, and use <span className="font-medium text-ed-ink2">Import</span> to bulk-load a starter set.</p>
            </div>
          )}

          {/* Add angle */}
          {showAddAngle ? (
            <div className="rounded-xl bg-ed-bg border border-black/10 p-4 mt-2">
              <p className="text-[12px] font-medium text-ed-ink mb-3">New Angle (Creative Brief)</p>
              <input
                type="text"
                placeholder="Angle name (e.g., Broken Sleep / Wake Up at 2 to 4 AM)"
                value={newAngle.name}
                onChange={e => setNewAngle(prev => ({ ...prev, name: e.target.value }))}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px]"
              />
              <div className="grid grid-cols-2 gap-2 mb-2">
                <select value={newAngle.priority} onChange={e => setNewAngle(prev => ({ ...prev, priority: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]">
                  <option value="highest">Priority: Highest</option>
                  <option value="high">Priority: High</option>
                  <option value="medium">Priority: Medium</option>
                  <option value="test">Priority: Test</option>
                </select>
                <select value={newAngle.frame} onChange={e => setNewAngle(prev => ({ ...prev, frame: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]">
                  <option value="symptom-first">Frame: Symptom-first</option>
                  <option value="scam">Frame: Scam</option>
                  <option value="objection-first">Frame: Objection-first</option>
                  <option value="identity-first">Frame: Identity-first</option>
                  <option value="MAHA">Frame: MAHA</option>
                  <option value="news-first">Frame: News-first</option>
                  <option value="consequence-first">Frame: Consequence-first</option>
                </select>
              </div>
              <textarea placeholder="Core Buyer — who is this ad for?" value={newAngle.core_buyer} onChange={e => setNewAngle(prev => ({ ...prev, core_buyer: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Symptom Pattern — what specific experience?" value={newAngle.symptom_pattern} onChange={e => setNewAngle(prev => ({ ...prev, symptom_pattern: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Failed Solutions — what have they already tried?" value={newAngle.failed_solutions} onChange={e => setNewAngle(prev => ({ ...prev, failed_solutions: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Current Belief — what do they believe now?" value={newAngle.current_belief} onChange={e => setNewAngle(prev => ({ ...prev, current_belief: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Objection — primary resistance to the product" value={newAngle.objection} onChange={e => setNewAngle(prev => ({ ...prev, objection: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Emotional State — how do they feel right now?" value={newAngle.emotional_state} onChange={e => setNewAngle(prev => ({ ...prev, emotional_state: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Scene — the specific moment the ad centers on" value={newAngle.scene} onChange={e => setNewAngle(prev => ({ ...prev, scene: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Desired Belief Shift — what should they believe after?" value={newAngle.desired_belief_shift} onChange={e => setNewAngle(prev => ({ ...prev, desired_belief_shift: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-2 text-[12px] h-14 resize-none" />
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input type="text" placeholder="Tone (e.g., Calm, specific, skeptical-friendly)" value={newAngle.tone} onChange={e => setNewAngle(prev => ({ ...prev, tone: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]" />
                <input type="text" placeholder="Avoid (e.g., Generic insomnia language, young models)" value={newAngle.avoid_list} onChange={e => setNewAngle(prev => ({ ...prev, avoid_list: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[12px]" />
              </div>
              <textarea placeholder="Prompt hints — additional creative direction (optional)" value={newAngle.prompt_hints} onChange={e => setNewAngle(prev => ({ ...prev, prompt_hints: e.target.value }))} className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full mb-3 text-[12px] h-14 resize-none" />
              <div className="flex gap-2">
                <button onClick={handleAddAngle} className="px-3 py-1.5 rounded-[7px] text-[11px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors">Save Angle</button>
                <button onClick={() => setShowAddAngle(false)} className="ed-ghost text-[11px] px-3 py-1.5">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddAngle(true)}
              className="ed-ghost text-[11px] px-3 py-1.5 mt-1"
            >
              + Add Angle
            </button>
          )}
        </div>
      )}

      {subTab === 'settings' && !config && (
        <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3">
          <p className="text-[11px] text-ed-ink2">Loading Director settings...</p>
        </div>
      )}

      {subTab === 'settings' && config && (
        <div className="space-y-4">
          <DirectorSettingsAnglesCallout
            customAngleCount={customAngleCount}
            countsReady={angleCountsReady}
            userRole={userRole}
            onGoToAngles={() => setSubTab('angles')}
          />

          <div className="rounded-xl bg-ed-accent/5 border border-ed-accent/10 px-3 py-3">
            <p className="text-[12px] font-medium text-ed-ink">How the Director builds ad sets</p>
            <p className="text-[11px] text-ed-ink2 mt-1 leading-relaxed">
              Each ad set targets one angle. The ads inside that ad set are variations of the same angle, using different templates or creative executions.
            </p>
          </div>

          <SettingsSection title="Schedule" description="Choose when the Creative Director should run for this project.">
            <div>
              <FieldLabel>Run Schedule</FieldLabel>
              <select
                value={config?.run_schedule || 'weekdays'}
                onChange={e => handleSaveConfig({ run_schedule: e.target.value })}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full text-[12px]"
              >
                <option value="daily">Daily (midnight ICT)</option>
                <option value="weekdays">Weekdays — Mon-Fri (midnight ICT)</option>
                <option value="weekly_monday">Weekly on Monday (midnight ICT)</option>
                <option value="custom">Custom</option>
                <option value="manual_only">Manual only</option>
              </select>
              {(config?.run_schedule || 'weekdays') === 'custom' && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day, i) => {
                      let selectedDays = [];
                      try { selectedDays = JSON.parse(config?.run_schedule_days || '[]'); } catch {}
                      const isSelected = selectedDays.includes(i);
                      return (
                        <button
                          key={day}
                          onClick={() => {
                            const updated = isSelected ? selectedDays.filter(d => d !== i) : [...selectedDays, i];
                            handleSaveConfig({ run_schedule_days: JSON.stringify(updated.sort()) });
                          }}
                          className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition-colors ${isSelected ? 'bg-ed-accent text-white' : 'bg-ed-bg text-ed-ink2 hover:bg-ed-line'}`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                  <div>
                    <label className="text-[10px] text-ed-ink3 block mb-0.5">Run at (ICT)</label>
                    <select
                      value={config?.run_schedule_hour ?? 0}
                      onChange={e => handleSaveConfig({ run_schedule_hour: parseInt(e.target.value, 10) })}
                      className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[11px] w-auto"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </SettingsSection>

          <SettingsSection title="Ad Set Production" description="Control how many angle-based ad sets are created and how many ad variations each set contains.">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FieldLabel tooltip="How many ad sets the Creative Director should try to create. Each ad set is centered on one angle.">Ad Set Target</FieldLabel>
                <input
                  type="number"
                  min="0"
                  max="20"
                  value={config.daily_flex_target ?? 5}
                  onChange={e => {
                    const parsed = parseInt(e.target.value, 10);
                    handleSaveConfig({ daily_flex_target: Number.isFinite(parsed) ? parsed : 5 });
                  }}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full text-[12px]"
                />
              </div>
              <div>
                <FieldLabel tooltip="This is the target number of approved ads for each ad set. If some generated ads fail QA, the Director keeps the approved ads and runs top-up batches until it reaches this target or hits the retry limit.">Ads Per Ad Set</FieldLabel>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={adsPerAdSetValue ?? 5}
                  onChange={e => handleSaveAdsPerAdSet(e.target.value)}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full text-[12px]"
                />
                <p className="text-[9px] text-ed-ink3 mt-0.5">Target approved ads, not just generated ads. One ad set targets one angle; top-up batches fill in any QA misses.</p>
              </div>
            </div>

            <div>
              <FieldLabel tooltip="This is the campaign in your connected Meta ad account where Creative Director and Creative Filter ad sets will be prepared. It does not post ads by itself.">Meta Campaign for Automated Ad Sets</FieldLabel>
              {campaignsLoading && campaignsLoadedFor !== selectedProject ? (
                <p className="text-[11px] text-ed-ink3">Loading campaigns...</p>
              ) : safeCampaigns.length > 0 ? (
                <select
                  value={automationCampaignValue}
                  onChange={e => handleSaveAutomationCampaign(e.target.value)}
                  className="text-[12px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer w-full"
                >
                  <option value="">Select a campaign...</option>
                  {safeCampaigns.map(c => (
                    <option key={c.externalId || c.id} value={c.externalId || c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-[11px] text-ed-ink3">No campaigns found — create one in the Ad Pipeline tab first.</p>
              )}
              <p className="text-[9px] text-ed-ink3 mt-0.5">Creative Director and Creative Filter will prepare Ready-to-Post ad sets under this Meta campaign by default.</p>
            </div>
          </SettingsSection>

          <SettingsSection title="Angle Selection" description="Choose how the Director picks the angle each new ad set is built around.">
            <div>
              <FieldLabel tooltip="Controls where angles come from: manual angles, automatically generated angles, or a mix of both.">Angle Mode</FieldLabel>
              <div className="flex gap-3">
                {['manual', 'auto', 'mixed'].map(mode => (
                  <label key={mode} className="flex items-center gap-1.5 text-[11px] text-ed-ink cursor-pointer">
                    <input
                      type="radio"
                      name="angle_mode"
                      checked={config.angle_mode === mode}
                      onChange={() => handleSaveConfig({ angle_mode: mode })}
                      className="accent-navy"
                    />
                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                  </label>
                ))}
              </div>
            </div>

            {config.angle_mode === 'mixed' && (
              <div>
                <FieldLabel tooltip="In mixed mode, this controls how often the Director explores new auto-generated angles instead of using existing manual angles.">Explore Ratio</FieldLabel>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={config.explore_ratio || 0.2}
                  onChange={e => {
                    const parsed = parseFloat(e.target.value);
                    handleSaveConfig({ explore_ratio: Number.isFinite(parsed) ? parsed : 0.2 });
                  }}
                  className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-24 text-[12px]"
                />
                <p className="text-[9px] text-ed-ink3 mt-0.5">Fraction of generation runs used to explore auto-generated angles.</p>
              </div>
            )}

            <div>
              <FieldLabel tooltip="Controls how the Director chooses between available angles when creating new ad sets.">Rotation Strategy</FieldLabel>
              <select
                value={config.angle_rotation || 'round_robin'}
                onChange={e => handleSaveConfig({ angle_rotation: e.target.value })}
                className="text-[12px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
              >
                <option value="round_robin">Round Robin</option>
                <option value="weighted">Weighted (favor least-used)</option>
                <option value="random">Random (weighted)</option>
              </select>
            </div>

            <div>
              <FieldLabel tooltip="Optional. When set, Creative Director will only select active angles with this tag. Leave blank to use all active angles.">Only Use Angles Tagged</FieldLabel>
              <select
                value={angleTagFilter}
                onChange={e => {
                  const next = e.target.value;
                  handleSaveConfig({ angle_tag_filter: next });
                  setSelectedAngleId('');
                }}
                onFocus={() => loadAngles(selectedProject)}
                className="text-[12px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
              >
                <option value="">Any active angle</option>
                {angleTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
              </select>
              <p className="text-[9px] text-ed-ink3 mt-0.5">
                If the selected tag has no active angles, the Director blocks before paid generation starts.
              </p>
            </div>
          </SettingsSection>

          <SettingsSection title="Prompt Guidance" description="Optional copy direction added to Creative Director prompts. Leave blank when you want the angle brief to lead.">
            <div>
              <FieldLabel tooltip="Optional. Scheduled Creative Director runs will randomly use only active uploaded templates with this tag. Leave blank for the normal random template pool.">Template Tag</FieldLabel>
              <select
                value={config.template_tag || ''}
                onChange={e => {
                  const next = e.target.value;
                  handleSaveConfig({ template_tag: next });
                  setTestTemplateTag(prev => prev || next);
                }}
                onFocus={() => loadTemplates(selectedProject)}
                className="text-[12px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
              >
                <option value="">Any active template</option>
                {templateTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
              </select>
              <p className="text-[9px] text-ed-ink3 mt-0.5">Blocks before paid generation if the selected tag has no active templates.</p>
              <TemplateTagHelp projectId={selectedProject} hasTags={templateTags.length > 0} className="text-[9px]" />
            </div>
            <div>
              <FieldLabel>Headline Style</FieldLabel>
              <input
                type="text"
                placeholder="e.g., Short, punchy, curiosity-driven"
                value={config.headline_style || ''}
                onChange={e => handleSaveConfig({ headline_style: e.target.value })}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full text-[12px]"
              />
            </div>

            <div>
              <FieldLabel>Primary Text Style</FieldLabel>
              <input
                type="text"
                placeholder="e.g., Story-based, emotional, 3 paragraphs"
                value={config.primary_text_style || ''}
                onChange={e => handleSaveConfig({ primary_text_style: e.target.value })}
                className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full text-[12px]"
              />
            </div>
          </SettingsSection>

          {saving && <p className="text-[10px] text-ed-ink3">Saving...</p>}
          {embedded && externalProject && (
            <div className="border-t border-black/5 pt-4 mt-4">
              <h3 className="text-[13px] font-serif font-[420] text-ed-ink mb-3">Advanced Meta Defaults & Learning</h3>
              <CreativeDirectorSettings
                project={externalProject}
                onSaved={onProjectRefresh || (() => {})}
                embedded
              />
            </div>
          )}
        </div>
      )}

      {subTab === 'history' && (
        <div>
          {anglesLoadedFor !== selectedProject && (
            <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3 mb-3">
              <p className="text-[11px] text-ed-ink2">Angles stay hidden until you open the Angles tab so the Director loads faster.</p>
            </div>
          )}
          {runsLoading && runsLoadedFor !== selectedProject ? (
            <p className="text-[11px] text-ed-ink3 py-4">Loading run history...</p>
          ) : safeRuns.length === 0 ? (
            <p className="text-[11px] text-ed-ink3 py-4">No runs yet. Click "Test Run" to trigger the Director, or wait for the next scheduled run.</p>
          ) : (
            <div className="space-y-2">
              {safeRuns.map(run => {
                const rounds = getRunRounds(run);
                const batches = getRunBatches(run);
                const flexAdId = run.flex_ad_id || batches.find(batch => batch.flex_ad_id)?.flex_ad_id || null;
                const angleName = rounds[0]?.angle_name || batches[0]?.angle_name || 'Unassigned angle';
                const roundsUsed = run.total_rounds || rounds.length || batches.length || 1;
                const totalGenerated = run.total_ads_generated || batches.reduce((sum, batch) => sum + (Number(batch.ad_count) || 0), 0);
                const totalPassed = run.total_ads_passed ?? rounds[rounds.length - 1]?.cumulative_passed ?? null;
                const requiredPasses = run.required_passes || 5;
                const readyCount = run.ready_to_post_count ?? (flexAdId ? 10 : 0);
                const failureText = run.failure_reason || run.error || '';
                const isExpanded = !!expandedRuns[run.externalId];
                const runBatchIds = [
                  ...new Set(
                    [
                      ...rounds.map((round) => round.batch_id),
                      ...batches.map((batch) => batch.batch_id),
                    ].filter(Boolean)
                  ),
                ];
                const runStartMs = Number(run.run_at);
                const startedAt = formatDateTime(runStartMs);
                const finishedAt = run.duration_ms && Number.isFinite(runStartMs)
                  ? formatDateTime(runStartMs + run.duration_ms)
                  : null;
                const durationLabel = run.duration_ms ? formatDuration(run.duration_ms) : null;

                return (
                  <div
                    key={run.externalId}
                    className="rounded-lg bg-black/[0.02] border border-black/5 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${getRunStatusClasses(run)}`}>
                            {getRunStatusLabel(run)}
                          </span>
                          <span className="text-[10px] text-ed-ink3">{run.run_type}</span>
                          {run.externalId && (
                            <span className="text-[10px] text-ed-ink3">Run {run.externalId.slice(0, 8)}</span>
                          )}
                          <span className="text-[10px] text-ed-ink2 truncate">{angleName}</span>
                        </div>
                        <p className="text-[11px] text-ed-ink leading-relaxed mt-1">
                          {run.decisions || `Run used ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''}.`}
                        </p>
                        {!!failureText && (
                          <p className="text-[11px] text-ed-rust leading-relaxed mt-1">{failureText}</p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Started</p>
                        <p className="text-[10px] text-ed-ink2 mt-0.5 whitespace-nowrap">{startedAt}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                      <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Rounds</p>
                        <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">{roundsUsed}</p>
                      </div>
                      <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Generated</p>
                        <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">{totalGenerated || '\u2013'}</p>
                      </div>
                      <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Passed</p>
                        <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">
                          {totalPassed === null || totalPassed === undefined ? '\u2013' : `${totalPassed}/${requiredPasses}`}
                        </p>
                      </div>
                      <div className="rounded-lg bg-ed-surface/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-ed-ink3">Ready</p>
                        <p className="text-[12px] font-serif font-[420] text-ed-ink mt-0.5">{readyCount}</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 mt-3">
                      <div className="flex flex-wrap items-center gap-3 text-[9px] text-ed-ink3">
                        {durationLabel ? (
                          <span>Duration {durationLabel}</span>
                        ) : (
                          <span>In progress</span>
                        )}
                        {finishedAt && (
                          <span>Finished {finishedAt}</span>
                        )}
                        {batches.length > 0 && (
                          <span>{batches.length} batch{batches.length !== 1 ? 'es' : ''}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {flexAdId && (
                          <button
                            onClick={() => navigate(`/projects/${selectedProject}?tab=tracker&view=ready_to_post&adSetId=${flexAdId}`)}
                            className="text-[10px] text-ed-accent hover:text-ed-accent font-medium"
                          >
                            View in Ready to Post {'\u2192'}
                          </button>
                        )}
                        {(rounds.length > 0 || batches.length > 0) && (
                          <button
                            onClick={() => toggleRunExpanded(run.externalId, runBatchIds)}
                            className="text-[10px] text-ed-ink2 hover:text-ed-accent font-medium"
                          >
                            {isExpanded ? 'Hide details' : 'Show details'}
                          </button>
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-black/5 space-y-2">
                        {rounds.length > 0 ? (
                          <div className="space-y-2">
                            {rounds.map((round, index) => (
                              <div key={round.batch_id || `${run.externalId}-${index}`} className="rounded-lg bg-ed-surface/70 border border-black/5 px-3 py-2">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-[11px] font-medium text-ed-ink">Round {round.round || index + 1}</p>
                                  <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getRoundStatusClasses(round)}`}>
                                    {round.status === 'threshold_reached' ? 'threshold reached' : 'below threshold'}
                                  </span>
                                </div>
                                <p className="text-[10px] text-ed-ink2 mt-1">
                                  Batch {round.batch_id ? `${round.batch_id.slice(0, 8)}...` : '\u2013'}
                                </p>
                                <p className="text-[11px] text-ed-ink mt-1">
                                  {round.ads_generated ?? round.ads_scored ?? 0} generated, {round.ads_passed ?? 0}/{round.ads_scored ?? round.ads_generated ?? 0} passed in this round, {round.cumulative_passed ?? 0}/{requiredPasses} cumulative.
                                </p>
                                <RoundHeadlineDiagnostics round={round} />
                                <RoundFailureSummary round={round} />
                                <RoundRepairSummary round={round} />
                                <RoundFailedAds round={round} />
                                <RoundLandingPageFunnel
                                  batchId={round.batch_id}
                                  lpDetailState={lpDetailsByBatchId[round.batch_id]}
                                  loading={!!lpDetailsLoadingByBatchId[round.batch_id]}
                                />
                                {round.completed_at && (
                                  <p className="text-[9px] text-ed-ink3 mt-1">{timeAgo(round.completed_at)}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : batches.length > 0 ? (
                          <div className="space-y-2">
                            {batches.map((batch, index) => (
                              <div key={batch.batch_id || `${run.externalId}-${index}`} className="rounded-lg bg-ed-surface/70 border border-black/5 px-3 py-2">
                                <p className="text-[11px] font-medium text-ed-ink">Batch {index + 1}</p>
                                <p className="text-[10px] text-ed-ink2 mt-1">
                                  ID {batch.batch_id ? `${batch.batch_id.slice(0, 8)}...` : '\u2013'} · {batch.ad_count || '\u2013'} ads
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <ImportDedupDialog
        open={!!importDedupPrompt}
        result={importDedupPrompt}
        importing={importing}
        onImportNewOnly={() => performImport({ newAngles: importDedupPrompt?.newAngles || [] })}
        onImportWithArchived={() => performImport({
          newAngles: importDedupPrompt?.newAngles || [],
          archivedMatches: importDedupPrompt?.archivedMatches || [],
        })}
        onCancel={() => setImportDedupPrompt(null)}
      />
      <DefaultAngleArchiveDialog
        open={!!defaultArchivePrompt}
        angle={defaultArchivePrompt?.angle}
        busy={defaultArchiveBusy}
        onConfirm={handleConfirmDefaultArchive}
        onCancel={() => setDefaultArchivePrompt(null)}
      />
    </div>
  );
}

// =============================================
// Angle Card
// =============================================
const PRIORITY_OPTIONS = ['highest', 'high', 'medium', 'test'];
const FRAME_OPTIONS = ['symptom-first', 'scam', 'objection-first', 'identity-first', 'MAHA', 'news-first', 'consequence-first'];

function AngleCard({ angle, playbooks, onStatusChange, onUpdate, showActions, selected = false, onSelectToggle }) {
  const pb = ensureArray(playbooks, 'AgentMonitor.angleCard.playbooks').find(p => p.angle_name === angle.name);
  const [expanded, setExpanded] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [fieldValue, setFieldValue] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const destUrls = (() => { try { return angle.destination_urls ? JSON.parse(angle.destination_urls) : []; } catch { return []; } })();
  const angleTags = Array.isArray(angle.tags) ? angle.tags : [];

  const PRIORITY_COLORS = { highest: 'bg-ed-rust/10 text-ed-rust', high: 'bg-ed-accent/15 text-ed-accent', medium: 'bg-ed-accent/10 text-ed-accent', test: 'bg-ed-bg text-ed-ink2' };
  const FRAME_COLORS = { 'symptom-first': 'bg-ed-green/10 text-ed-green', 'scam': 'bg-ed-rust/10 text-ed-rust', 'objection-first': 'bg-amber-50 text-amber-700', 'identity-first': 'bg-purple-50 text-purple-600', 'MAHA': 'bg-blue-50 text-blue-600', 'news-first': 'bg-indigo-50 text-indigo-600', 'consequence-first': 'bg-orange-50 text-orange-600' };

  const startFieldEdit = (field) => {
    setFieldValue(angle[field] || '');
    setEditingField(field);
  };

  const saveField = async (field, value) => {
    setEditingField(null);
    if (value !== (angle[field] || '')) {
      try { await onUpdate(angle.externalId, { [field]: value || undefined }); } catch {}
    }
  };

  const fieldKeyDown = (e, field) => {
    if (e.key === 'Escape') { setEditingField(null); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveField(field, fieldValue); }
  };

  const addTag = async () => {
    if (!onUpdate) return;
    const tag = window.prompt('Add angle tag');
    const trimmed = String(tag || '').trim();
    if (!trimmed) return;
    if (angleTags.some(value => value.toLowerCase() === trimmed.toLowerCase())) return;
    await onUpdate(angle.externalId, { tags: [...angleTags, trimmed] });
  };

  const removeTag = async (tag) => {
    if (!onUpdate) return;
    await onUpdate(angle.externalId, { tags: angleTags.filter(value => value !== tag) });
  };

  // Inline editable text field
  const EditableRow = ({ field, label, valueClass }) => {
    const val = angle[field] || '';
    if (editingField === field) {
      return (
        <div>
          <span className="font-serif font-[420] text-ed-ink text-[11px]">{label}</span>
          <textarea
            autoFocus
            value={fieldValue}
            onChange={e => setFieldValue(e.target.value)}
            onKeyDown={e => fieldKeyDown(e, field)}
            onBlur={() => saveField(field, fieldValue)}
            placeholder={`Add ${label.toLowerCase().replace(':', '')}...`}
            className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent w-full text-[12px] h-14 resize-none mt-0.5"
          />
        </div>
      );
    }
    return (
      <div className="group cursor-pointer" onClick={() => onUpdate && startFieldEdit(field)}>
        <span className="font-serif font-[420] text-ed-ink text-[11px]">{label}</span>{' '}
        {val
          ? <span className={valueClass || 'text-ed-ink2 text-[12px]'}>{val}</span>
          : onUpdate && <span className="text-ed-ink3 text-[11px] italic">Click to add...</span>}
        {onUpdate && val && <span className="text-ed-ink3 text-[9px] ml-1 opacity-0 group-hover:opacity-100 transition-opacity">edit</span>}
      </div>
    );
  };

  return (
    <div className="rounded-lg border bg-white/60 border-black/5">
      {/* Clickable header row */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {onSelectToggle && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectToggle(angle.externalId);
              }}
              className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                selected ? 'bg-ed-accent border-ed-accent text-white' : 'border-ed-line text-transparent hover:border-ed-accent'
              }`}
              title={selected ? 'Deselect angle' : 'Select angle'}
            >
              ✓
            </button>
          )}
          <span className={`text-[11px] text-ed-ink3 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9656;</span>
          <span className="text-[13px] font-medium text-ed-ink">{angle.name}</span>
          {angle.is_system_default && (
            <>
              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-ed-accent/10 text-ed-accent">Direct Offer</span>
              <span
                className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-black/5 text-[10px] text-ed-ink2"
                title="Project default — archiving requires confirmation."
                aria-label="Project default — archiving requires confirmation."
              >
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z" />
                </svg>
              </span>
            </>
          )}
          {angle.priority && <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${PRIORITY_COLORS[angle.priority] || 'bg-ed-bg text-gray-600'}`}>{angle.priority}</span>}
          {angle.frame && <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${FRAME_COLORS[angle.frame] || 'bg-ed-bg text-gray-600'}`}>{angle.frame}</span>}
          {angleTags.map(tag => (
            <span key={tag} className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-ed-accent/10 text-ed-accent">
              {tag}
              {onUpdate && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTag(tag);
                  }}
                  className="text-ed-accent/60 hover:text-ed-rust"
                  title={`Remove ${tag}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {onUpdate && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                addTag();
              }}
              className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-black/5 text-ed-ink2 hover:text-ed-accent"
            >
              + tag
            </button>
          )}
          <span className="text-[10px] text-ed-ink3">used {angle.times_used || 0}x</span>
          {pb && (
            <span className="text-[10px] text-ed-ink2">
              pass: {Math.round((pb.pass_rate || 0) * 100)}%
              {pb.pass_rate > 0.6 ? ' \u2191' : pb.pass_rate < 0.4 ? ' \u2193' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {showActions && (
            <div className="flex gap-1">
              <button onClick={() => onStatusChange(angle.externalId, 'active')} className="text-[10px] text-ed-green hover:underline">Activate</button>
              <button onClick={() => onStatusChange(angle.externalId, 'archived')} className="text-[10px] text-ed-rust hover:underline ml-2">Archive</button>
            </div>
          )}
          {!showActions && angle.status === 'active' && (
            <button onClick={() => onStatusChange(angle.externalId, 'archived')} className="text-[10px] text-ed-ink3 hover:text-ed-rust">Archive</button>
          )}
          {!showActions && (angle.status === 'archived' || angle.status === 'retired') && (
            <button onClick={() => onStatusChange(angle.externalId, 'active')} className="text-[10px] text-ed-green hover:underline">Unarchive</button>
          )}
        </div>
      </div>

      {/* Expanded: inline-editable properties */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-2 text-[12px]">
          {/* Priority & Frame — editable dropdowns */}
          {onUpdate && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="font-serif font-[420] text-ed-ink text-[11px]">Priority:</span>
                <select
                  value={angle.priority || 'medium'}
                  onChange={e => onUpdate(angle.externalId, { priority: e.target.value })}
                  className="text-[11px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-2 py-1 w-full cursor-pointer mt-0.5"
                >
                  {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <span className="font-serif font-[420] text-ed-ink text-[11px]">Frame:</span>
                <select
                  value={angle.frame || 'symptom-first'}
                  onChange={e => onUpdate(angle.externalId, { frame: e.target.value })}
                  className="text-[11px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-2 py-1 w-full cursor-pointer mt-0.5"
                >
                  {FRAME_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            </div>
          )}
          {!onUpdate && (
            <div className="flex gap-3">
              {angle.priority && <div><span className="font-serif font-[420] text-ed-ink text-[11px]">Priority:</span> <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${PRIORITY_COLORS[angle.priority] || ''}`}>{angle.priority}</span></div>}
              {angle.frame && <div><span className="font-serif font-[420] text-ed-ink text-[11px]">Frame:</span> <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${FRAME_COLORS[angle.frame] || ''}`}>{angle.frame}</span></div>}
            </div>
          )}

          {/* Angle name — editable */}
          <EditableRow field="name" label="Name:" />
          <EditableRow field="description" label="Description:" />
          <EditableRow field="core_buyer" label="Core Buyer:" />
          <EditableRow field="symptom_pattern" label="Symptom Pattern:" />
          <EditableRow field="failed_solutions" label="Failed Solutions:" />
          <EditableRow field="current_belief" label="Current Belief:" />
          <EditableRow field="objection" label="Objection:" />
          <EditableRow field="emotional_state" label="Emotional State:" />
          <EditableRow field="scene" label="Scene:" valueClass="text-ed-ink2 text-[12px] italic" />
          <EditableRow field="desired_belief_shift" label="Belief Shift:" valueClass="text-ed-ink2 text-[12px] italic" />
          <EditableRow field="tone" label="Tone:" />
          <EditableRow field="avoid_list" label="Avoid:" valueClass="text-ed-rust text-[12px]" />
          <EditableRow field="prompt_hints" label="Prompt Hints:" />
        </div>
      )}

      {/* Destination URLs section */}
      {expanded && angle.status === 'active' && onUpdate && (
        <div className="px-3 pb-2 pt-1 border-t border-black/5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <svg className="w-3 h-3 text-ed-ink3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" /></svg>
            <span className="text-[10px] font-medium text-ed-ink">Destination URLs</span>
            {destUrls.length === 0 && <span className="text-[9px] text-ed-ink3">(uses project default)</span>}
          </div>
          {destUrls.length > 0 && (
            <div className="space-y-1 mb-1.5">
              {destUrls.map((url, i) => (
                <div key={i} className="flex items-center gap-1.5 group">
                  <span className="text-[10px] text-ed-ink2 truncate flex-1" title={url}>{url}</span>
                  <button
                    onClick={() => {
                      const updated = destUrls.filter((_, idx) => idx !== i);
                      onUpdate(angle.externalId, { destination_urls: updated.length > 0 ? JSON.stringify(updated) : '' });
                    }}
                    className="text-[9px] text-ed-ink3 hover:text-ed-rust opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    title="Remove URL"
                  >&times;</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              type="text"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && urlInput.trim()) {
                  e.preventDefault();
                  const updated = [...destUrls, urlInput.trim()];
                  onUpdate(angle.externalId, { destination_urls: JSON.stringify(updated) });
                  setUrlInput('');
                }
              }}
              placeholder="Add landing page URL..."
              className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent text-[11px] flex-1 py-1"
            />
            <button
              onClick={() => {
                if (urlInput.trim()) {
                  const updated = [...destUrls, urlInput.trim()];
                  onUpdate(angle.externalId, { destination_urls: JSON.stringify(updated) });
                  setUrlInput('');
                }
              }}
              disabled={!urlInput.trim()}
              className="text-[10px] text-ed-accent hover:text-ed-accent disabled:text-ed-ink3 disabled:cursor-not-allowed px-2 py-1 flex-shrink-0"
            >Add</button>
          </div>
        </div>
      )}

    </div>
  );
}

// =============================================
// Agent Panel Wrapper
// =============================================
function AgentPanel({ children, icon, name, subtitle, status, paused, onTogglePause, togglingPause }) {
  const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG.offline;

  return (
    <div>
      {/* Agent header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-ed-accent/10 flex items-center justify-center flex-shrink-0">
            {icon}
          </div>
          <div>
            <p className="text-[13px] font-serif font-[420] text-ed-ink tracking-tight leading-tight">{name}</p>
            <p className="text-[10px] text-ed-ink3">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePause}
            disabled={togglingPause}
            className="group flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title={paused ? 'Resume agent' : 'Pause agent'}
          >
            <div className={`relative w-7 h-4 rounded-full transition-colors duration-200 ${paused ? 'bg-black/10' : 'bg-ed-green/30'}`}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200 shadow-sm ${paused ? 'left-0.5 bg-ed-ink3' : 'left-3.5 bg-ed-green'}`} />
            </div>
          </button>
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot} ${statusCfg.pulse ? 'animate-pulse' : ''}`} />
            <span className={`text-[10px] font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

// =============================================
// Creative Filter Panel
// =============================================
function FilterPanel({ data, onRefresh, externalProjectId, externalProject, onProjectRefresh }) {
  const embedded = !!externalProjectId;
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [volumes, setVolumes] = useState(null);
  const [loadingVolumes, setLoadingVolumes] = useState(false);
  const [savingVolume, setSavingVolume] = useState(null);

  const loadVolumes = useCallback(async () => {
    setLoadingVolumes(true);
    try {
      const res = await api.getFilterVolumes();
      setVolumes(ensureArray(res?.projects, 'AgentMonitor.filter.volumes'));
    } catch { /* ignore */ }
    finally { setLoadingVolumes(false); }
  }, []);

  useEffect(() => {
    if (!embedded) loadVolumes();
  }, [embedded, loadVolumes]);

  const handleVolumeChange = async (projectId, newValue) => {
    setSavingVolume(projectId);
    try {
      await api.updateFilterVolume(projectId, newValue);
      setVolumes(prev => ensureArray(prev, 'AgentMonitor.filter.volumesState').map(p =>
        p.id === projectId ? { ...p, scout_daily_flex_ads: newValue } : p
      ));
    } catch { /* ignore */ }
    finally { setSavingVolume(null); }
  };

  const handleDryRun = async () => {
    setRunningAction('dry');
    try {
      await api.runFilterDryRun();
      setTimeout(onRefresh, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleRunLive = async () => {
    setRunningAction('live');
    try {
      await api.runFilterLive();
      setTimeout(onRefresh, 5000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleTogglePause = async () => {
    setTogglingPause(true);
    try {
      await api.toggleFilterPause();
      await onRefresh();
    } catch { /* ignore */ }
    finally { setTogglingPause(false); }
  };

  const budgetPct = data.budget.daily_budget_cents > 0
    ? (data.budget.spent_cents / data.budget.daily_budget_cents) * 100
    : 0;
  const budgetBarColor = budgetPct < 50 ? 'bg-ed-green' : budgetPct < 80 ? 'bg-ed-accent' : 'bg-ed-rust';
  const allVolumes = ensureArray(volumes, 'AgentMonitor.filter.volumesState').filter(p => p.scout_enabled !== false);
  const visibleVolumes = allVolumes;

  return (
    <AgentPanel
      name="Creative Filter"
      subtitle="Scores generated ads, keeps approved ads, and builds Ready-to-Post ad sets"
      status={data.status}
      paused={data.paused}
      onTogglePause={handleTogglePause}
      togglingPause={togglingPause}
      icon={
        <svg className="w-3 h-3 text-ed-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
      }
    >
      {embedded && (
        <div className="rounded-xl bg-ed-accent/5 border border-ed-accent/10 p-3 mb-3">
          <p className="text-[11px] font-medium text-ed-accent mb-0.5">System-level status</p>
          <p className="text-[10px] text-ed-ink2">
            These controls operate the live QA service. This project's deployment defaults are below; production volume is controlled by Creative Director Ad Set Target.
          </p>
        </div>
      )}
      <BudgetBar spent={data.budget.spent_cents} total={data.budget.daily_budget_cents} pct={budgetPct} barColor={budgetBarColor} />

      <div className="grid grid-cols-5 gap-2 mb-3">
        <StatCell value={data.stats.batches} label="Batches" color="text-ed-ink" />
        <StatCell value={data.stats.scored} label="Scored" color="text-ed-ink" />
        <StatCell value={data.stats.passed} label="Passed" color="text-ed-green" />
        <StatCell value={data.stats.failed} label="Failed" color={data.stats.failed > 0 ? 'text-ed-rust' : 'text-ed-ink'} />
        <StatCell value={data.stats.flexAds} label="Ad Sets" color="text-ed-accent-light" />
      </div>

      <p className="text-[10px] text-ed-ink2 mb-2.5">
        Last: <span className="font-medium text-ed-ink">{timeAgo(data.lastRun)}</span>
        {data.paused ? (
          <span className="text-ed-ink3 ml-1">{'\u00B7'} Paused</span>
        ) : data.nextRun ? (
          <>{' \u00B7 '} Next: <span className="font-medium text-ed-ink">{timeUntil(data.nextRun)}</span></>
        ) : null}
      </p>

      <div className="flex gap-2 mb-3">
        <button
          onClick={handleRunLive}
          disabled={!!runningAction}
          className="px-2.5 py-1 rounded-[7px] text-[11px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'live' ? <><Spinner /> Running...</> : <>{'\u25B6'} Run Now</>}
        </button>
        <button
          onClick={handleDryRun}
          disabled={!!runningAction}
          className="ed-ghost text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'dry' ? <><Spinner /> Running...</> : <>{'\u2699'} Dry Run</>}
        </button>
      </div>

      {/* Per-Brand Daily Volume Controls */}
      {!embedded && (
      <div className="border-t border-black/5 pt-2.5 mb-2.5">
        <p className="text-[11px] font-medium text-ed-ink2 mb-1.5">{embedded ? 'This Project Ad Set Volume' : 'Daily Ad Set Volume'}</p>
        <p className="text-[9px] text-ed-ink3 mb-2">
          Ad sets created per day per brand. Each ad set contains the selected winning images.
        </p>
        {loadingVolumes ? (
          <div className="text-[10px] text-ed-ink3 py-2">Loading projects...</div>
        ) : visibleVolumes.length > 0 ? (
          <div className="space-y-1">
            {visibleVolumes.map(project => (
              <div key={project.id} className="flex items-center justify-between gap-2 py-1.5 px-2.5 rounded-lg bg-white/60">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-ed-ink truncate">
                    {project.brand_name || project.name}
                  </p>
                  <p className="text-[9px] text-ed-ink3">
                    Today: {project.today_flex_ads}/{project.scout_daily_flex_ads} ad sets
                  </p>
                </div>
                <select
                  value={project.scout_daily_flex_ads}
                  onChange={e => handleVolumeChange(project.id, parseInt(e.target.value))}
                  disabled={savingVolume === project.id}
                  className="text-[11px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-2 py-1 w-14 cursor-pointer"
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-ed-ink3 py-1.5">No projects configured.</p>
        )}
      </div>
      )}

      <ActivityLog activity={data.activity} expanded={expanded} onToggle={() => setExpanded(!expanded)} />

      {embedded && externalProject && (
        <div className="border-t border-black/5 pt-3 mt-3">
          <h3 className="text-[13px] font-serif font-[420] text-ed-ink mb-3">QA & Ready-to-Post Defaults</h3>
          <CreativeFilterSettings
            projectId={externalProjectId}
            project={externalProject}
            onSave={onProjectRefresh || (() => {})}
            embedded
          />
        </div>
      )}
    </AgentPanel>
  );
}

// =============================================
// Shared sub-components
// =============================================

function BudgetBar({ spent, total, pct, barColor }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-ed-ink2 font-medium">Budget</span>
        <span className="text-[10px] text-ed-ink2 tabular-nums">
          {spent}{'\u00A2'} / {total}{'\u00A2'}
          <span className="text-ed-ink3 ml-1">
            (${(spent / 100).toFixed(2)} / ${(total / 100).toFixed(2)})
          </span>
        </span>
      </div>
      <div className="h-1 rounded-full bg-black/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

function ActivityLog({ activity, expanded, onToggle }) {
  return (
    <div className="border-t border-black/5 pt-2.5">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full group"
      >
        <span className="text-[11px] font-medium text-ed-ink2">Recent Activity</span>
        <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 px-2 py-1 rounded-md transition-all">
          Details
          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>
      {expanded && (
        <div className="mt-1.5 max-h-44 overflow-y-auto scrollbar-thin">
          {activity && activity.length > 0 ? (
            <div className="space-y-0">
              {activity.map((entry, i) => {
                const cfg = LEVEL_CONFIG[entry.level] || LEVEL_CONFIG.INFO;
                return (
                  <div key={i} className="flex items-start gap-1.5 py-0.5 px-1 rounded hover:bg-black/[0.02]">
                    <span className="text-[9px] text-ed-ink3 font-mono flex-shrink-0 mt-px w-8">
                      {entry.time.slice(0, 5)}
                    </span>
                    <span className={`text-[10px] flex-shrink-0 w-3 text-center ${cfg.color}`}>
                      {cfg.icon}
                    </span>
                    <span className={`text-[10px] ${cfg.color} leading-tight`}>
                      {entry.message}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[10px] text-ed-ink3 py-1.5">No activity recorded today.</p>
          )}
        </div>
      )}
    </div>
  );
}

function StatCell({ value, label, color }) {
  return (
    <div className="text-center py-1.5 px-1 rounded-lg bg-white/60">
      <p className={`text-base font-semibold ${color} tabular-nums leading-tight`}>{value}</p>
      <p className="text-[9px] text-ed-ink3 uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}

function SettingsSection({ title, description, children }) {
  return (
    <section className="rounded-xl bg-white/60 border border-black/5 p-3 space-y-3">
      <div>
        <h3 className="text-[12px] font-serif font-[420] text-ed-ink">{title}</h3>
        {description && <p className="text-[10px] text-ed-ink3 mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function FieldLabel({ children, tooltip }) {
  return (
    <div className="text-[11px] text-ed-ink2 font-medium mb-1 flex items-center gap-1">
      {children}
      {tooltip && <InfoTooltip text={tooltip} position="right" />}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

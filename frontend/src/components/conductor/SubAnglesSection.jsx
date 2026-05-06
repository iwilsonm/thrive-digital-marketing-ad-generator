// Phase 4 — Sub-angles section for the Creative Director angle list.
// Renders under each parent angle: list of children with stats, derive-now,
// approve/reject (review mode), delete-lineage (admin).

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { useToast } from '../Toast';

export default function SubAnglesSection({ projectId, parentAngle, onChanged, isAdmin }) {
  const toast = useToast();
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { sub_angles } = await api.getSubAngles(projectId, parentAngle.externalId);
      setChildren(sub_angles || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, parentAngle.externalId]);

  useEffect(() => { load(); }, [load]);

  const handleDeriveNow = async () => {
    if (!confirm(`Derive new sub-angles from "${parentAngle.name}" now? This will call Claude and may take 5-10s.`)) return;
    setBusy(true);
    try {
      const result = await api.deriveSubAnglesNow(projectId, parentAngle.externalId);
      const derived = result?.result?.derived_count ?? 0;
      if (derived > 0) {
        toast.success(`Derived ${derived} sub-angle${derived === 1 ? '' : 's'}`);
        load();
        onChanged?.();
      } else {
        const skip = result?.result?.skipped?.[0]?.reason || 'no eligible work';
        toast.info(`Skipped: ${skip}`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteLineage = async () => {
    if (!confirm(
      `DELETE "${parentAngle.name}" AND ALL its descendants?\n\n` +
      `This will permanently remove the parent angle and every sub-angle derived from it (and their sub-angles, recursively).\n\n` +
      `Past observation_results stay (audit history).`
    )) return;
    setBusy(true);
    try {
      const result = await api.deleteAngleLineage(projectId, parentAngle.externalId);
      toast.success(`Deleted ${result.removed} angle${result.removed === 1 ? '' : 's'}`);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (childId) => {
    setBusy(true);
    try {
      await api.approveSubAngle(projectId, childId);
      toast.success('Approved');
      load();
      onChanged?.();
    } catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  };

  const handleReject = async (childId) => {
    if (!confirm('Reject this sub-angle? It will be deleted.')) return;
    setBusy(true);
    try {
      await api.rejectSubAngle(projectId, childId);
      toast.success('Rejected');
      load();
      onChanged?.();
    } catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-3 pl-4 border-l-2 border-ed-accent/30">
      <div className="flex items-center gap-2 mb-2">
        <h4 className="text-[12px] font-semibold text-ed-ink2 uppercase tracking-wider">
          Sub-angles ({children.length})
        </h4>
        <button onClick={handleDeriveNow} disabled={busy} className="ed-ghost text-[10px] px-2 py-0.5">
          {busy ? '…' : '+ Derive now'}
        </button>
        {isAdmin && children.length > 0 && (
          <button
            onClick={handleDeleteLineage}
            disabled={busy}
            className="text-[10px] text-red-500 hover:text-red-600 ml-auto"
          >
            Delete lineage
          </button>
        )}
      </div>

      {loading && <div className="text-[11px] text-ed-ink3">Loading…</div>}
      {!loading && children.length === 0 && (
        <div className="text-[11px] text-ed-ink3">No sub-angles yet. Derived automatically when this angle accumulates passing observations.</div>
      )}

      <div className="space-y-2">
        {children.map((c) => {
          const passRate = c.lifetime_pass_rate;
          const isPending = c.status === 'pending_review';
          const isArchived = c.status === 'archived';
          return (
            <div
              key={c.externalId}
              className="flex items-start gap-3 p-2.5 rounded-lg border border-ed-line bg-ed-bg/30"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-ed-ink truncate">{c.name}</span>
                  {isPending && <span className="badge bg-ed-accent/10 text-ed-accent text-[9px]">Pending review</span>}
                  {isArchived && <span className="badge bg-ed-bg text-ed-ink3 text-[9px]">Archived</span>}
                  {!isPending && !isArchived && (
                    <span className="text-[9px] text-ed-green">Active</span>
                  )}
                </div>
                <div className="text-[10px] text-ed-ink3">
                  {c.derived_at ? new Date(c.derived_at).toISOString().slice(0, 10) : ''}
                  {passRate != null && passRate > 0 && (
                    <> · {(passRate * 100).toFixed(0)}% pass rate</>
                  )}
                  {c.frame && c.frame !== parentAngle.frame && (
                    <> · frame: <strong>{c.frame}</strong> (was: {parentAngle.frame || 'none'})</>
                  )}
                </div>
                {c.derivation_reasoning && (
                  <div className="text-[10px] text-ed-ink2 mt-1 italic">"{c.derivation_reasoning}"</div>
                )}
              </div>
              {isPending && (
                <div className="flex gap-1 flex-shrink-0">
                  <button onClick={() => handleApprove(c.externalId)} disabled={busy} className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors text-[10px] px-2 py-0.5">
                    Approve
                  </button>
                  <button onClick={() => handleReject(c.externalId)} disabled={busy} className="text-[10px] text-ed-ink2 hover:text-red-500 px-1">
                    Reject
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

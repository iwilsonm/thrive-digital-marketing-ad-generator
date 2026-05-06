import { useMemo } from 'react';

const COLORS = { passed: '#38a638', observing: '#62b462', failed: '#ef4444', insufficient: '#a3a3a3' };
const ORDER = ['passed', 'observing', 'failed', 'insufficient'];
const LEGEND = [
  ['Passed', '#38a638'],
  ['Observing', '#62b462'],
  ['Failed', '#ef4444'],
  ['Insufficient', '#a3a3a3'],
];

function groupKey(adSet) {
  if (adSet.angle_name) return adSet.angle_name;
  if (adSet.campaign_name) return adSet.campaign_name;
  return 'Ungrouped';
}

export default function VerdictDistributionChart({ adSets }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const adSet of adSets) {
      const key = groupKey(adSet);
      if (!map.has(key)) map.set(key, { passed: 0, observing: 0, failed: 0, insufficient: 0, total: 0 });
      const g = map.get(key);
      const status = adSet.lifecycle_status;
      if (status === 'passed') g.passed++;
      else if (status === 'observing') g.observing++;
      else if (status === 'failed' || status === 'failed_external') g.failed++;
      else if (status === 'insufficient_data') g.insufficient++;
      g.total++;
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [adSets]);

  if (groups.length < 2) return null;

  return (
    <div className="ed-card" style={{ padding: 22 }}>
      <div className="flex justify-between items-end" style={{ marginBottom: 18 }}>
        <div>
          <h3 className="font-serif" style={{ fontSize: 18 }}>Verdict distribution by angle</h3>
          <div className="text-[12px] text-ed-ink3" style={{ marginTop: 2 }}>
            Which angles are working, which aren't
          </div>
        </div>
        <div className="flex gap-3.5" style={{ fontSize: 11 }}>
          {LEGEND.map(([label, color]) => (
            <span key={label} className="inline-flex items-center gap-1.5 text-ed-ink2">
              <span className="rounded-sm flex-shrink-0" style={{ width: 10, height: 10, background: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3.5">
        {groups.map(([name, g]) => {
          const pct = g.total > 0 ? ((g.passed / g.total) * 100).toFixed(0) : 0;
          return (
            <div key={name}>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 6 }}>
                <span className="font-serif text-ed-ink" style={{ fontSize: 14, letterSpacing: '-0.01em' }}>
                  {name}
                </span>
                <span className="font-mono-ed text-ed-ink3" style={{ fontSize: 11 }}>
                  {g.passed}/{g.total} passed · {pct}%
                </span>
              </div>
              <div
                className="flex overflow-hidden"
                style={{ height: 8, background: '#ebebeb', borderRadius: 3 }}
              >
                {ORDER.map((k) => {
                  const v = g[k] || 0;
                  if (v === 0) return null;
                  return (
                    <div
                      key={k}
                      style={{ width: `${(v / g.total) * 100}%`, background: COLORS[k] }}
                      title={`${k}: ${v}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

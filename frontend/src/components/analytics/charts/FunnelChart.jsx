import { fmtCompact } from './chartUtils';

const COLORS = ['#38a638', '#4dae4d', '#62b462', '#8dcc8d', '#b8e4b8'];

export default function FunnelChart({ stages }) {
  if (!stages || stages.length === 0) return null;

  const w = 880, h = 200, padL = 16, padR = 16, padT = 12, padB = 56;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const max = stages[0].value || 1;
  const stepX = innerW / stages.length;

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      {stages.map((s, i) => {
        const cx = padL + i * stepX + stepX / 2;
        const barH = (s.value / max) * innerH;
        const y = padT + (innerH - barH);
        const barW = stepX * 0.78;
        return (
          <g key={s.stage}>
            <rect x={cx - barW / 2} y={y} width={barW} height={barH} fill={COLORS[i % COLORS.length]} rx="2" />
            <text x={cx} y={y - 8} fill="#262626" fontSize="14" fontFamily="'Source Serif 4',Georgia,serif" textAnchor="middle">
              {fmtCompact(s.value)}
            </text>
            <text x={cx} y={h - 30} fill="#262626" fontSize="11.5" fontFamily="JetBrains Mono,monospace" textAnchor="middle" className="uppercase tracking-[0.04em]">
              {s.stage}
            </text>
            {s.rate !== null && s.rate !== undefined && (
              <text x={cx} y={h - 12} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="middle">
                {(s.rate * 100).toFixed(2)}%
              </text>
            )}
            {i < stages.length - 1 && (
              <text x={cx + stepX / 2} y={padT + innerH / 2 + 4} fill="#a3a3a3" fontSize="14" fontFamily="JetBrains Mono,monospace" textAnchor="middle">→</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

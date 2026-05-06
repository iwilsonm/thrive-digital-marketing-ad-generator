import { useMemo } from 'react';
import { fmt$ } from './chartUtils';

const DEFAULT_COLORS = ['#38a638', '#4dae4d', '#62b462', '#8dcc8d', '#b8e4b8', '#a3a3a3', '#737373'];

export default function StackedBarChart({ data, keys, colors = DEFAULT_COLORS, campaignNames = {} }) {
  const w = 880, h = 240, padL = 48, padR = 16, padT = 18, padB = 32;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const { maxT, stepX, barW, grid } = useMemo(() => {
    if (!data || data.length === 0 || !keys || keys.length === 0) return { maxT: 0, stepX: 0, barW: 0, grid: [] };
    const totals = data.map(d => keys.reduce((s, k) => s + (d[k] || 0), 0));
    const mt = Math.max(...totals) || 1;
    const sx = innerW / data.length;
    const bw = sx * 0.62;
    const g = [0, 0.25, 0.5, 0.75, 1].map(t => ({
      y: padT + innerH * t,
      label: fmt$(mt * (1 - t)),
    }));
    return { maxT: mt, stepX: sx, barW: bw, grid: g };
  }, [data, keys]);

  if (!data || data.length === 0 || !keys || keys.length === 0) return null;

  return (
    <div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="block">
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={g.y} y2={g.y} stroke="#ebebeb" strokeWidth="1" />
            <text x={padL - 10} y={g.y + 4} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="end">{g.label}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = padL + i * stepX + stepX / 2;
          let cumY = padT + innerH;
          return (
            <g key={i}>
              {keys.map((k, ki) => {
                const v = d[k] || 0;
                const segH = (v / maxT) * innerH;
                const y = cumY - segH;
                cumY = y;
                return <rect key={k} x={cx - barW / 2} y={y} width={barW} height={Math.max(segH - 1, 0)} fill={colors[ki % colors.length]} rx="1" />;
              })}
              <text x={cx} y={h - 12} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="middle">
                {d.date?.slice(5) || ''}
              </text>
            </g>
          );
        })}
      </svg>
      {keys.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 px-1">
          {keys.map((k, i) => (
            <div key={k} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colors[i % colors.length] }} />
              <span className="font-mono-ed text-[10.5px] text-ed-ink3 truncate max-w-[140px]">
                {campaignNames[k] || k}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

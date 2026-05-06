import { useMemo } from 'react';

const W = 600, H = 220;
const PAD_L = 46, PAD_R = 16, PAD_T = 18, PAD_B = 32;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

const GRID = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
  y: PAD_T + INNER_H * t,
  label: ((1 - t) * 100).toFixed(0) + '%',
}));

export default function PassRateChart({ data }) {
  const { rates, linePath, areaPath } = useMemo(() => {
    if (!data || data.length < 2) return { rates: [], linePath: '', areaPath: '' };

    const stepX = INNER_W / (data.length - 1);
    const xAt = (i) => PAD_L + i * stepX;
    const yAt = (v) => PAD_T + INNER_H * (1 - v);

    const r = data.map((d) => (d.total > 0 ? d.passed / d.total : 0));
    const line = r.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ');
    const area = `${line} L ${xAt(data.length - 1)} ${PAD_T + INNER_H} L ${PAD_L} ${PAD_T + INNER_H} Z`;

    return { rates: r, linePath: line, areaPath: area };
  }, [data]);

  if (!data || data.length < 2) return null;

  const stepX = INNER_W / (data.length - 1);
  const xAt = (i) => PAD_L + i * stepX;
  const yAt = (v) => PAD_T + INNER_H * (1 - v);

  return (
    <div className="ed-card" style={{ padding: 22 }}>
      <div style={{ marginBottom: 14 }}>
        <h3 className="font-serif" style={{ fontSize: 18 }}>Pass rate · trailing 8 weeks</h3>
        <div className="text-[12px] text-ed-ink3" style={{ marginTop: 2 }}>
          Of ad sets that completed observation, share that passed
        </div>
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="obs-pass-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38a638" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#38a638" stopOpacity="0" />
          </linearGradient>
        </defs>
        {GRID.map((g, i) => (
          <g key={i}>
            <line
              x1={PAD_L} x2={W - PAD_R} y1={g.y} y2={g.y}
              stroke={i === 2 ? '#38a638' : '#ebebeb'}
              strokeWidth="1"
              strokeDasharray={i === 2 ? '3 3' : '0'}
              opacity={i === 2 ? 0.5 : 1}
            />
            <text x={PAD_L - 10} y={g.y + 4} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="end">
              {g.label}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="url(#obs-pass-area)" />
        <path d={linePath} fill="none" stroke="#38a638" strokeWidth="1.8" />
        {data.map((d, i) => (
          <g key={i}>
            <circle cx={xAt(i)} cy={yAt(rates[i])} r="3.5" fill="#38a638" stroke="#ffffff" strokeWidth="1.5" />
            <text x={xAt(i)} y={H - 12} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="middle">
              {d.week}
            </text>
          </g>
        ))}
        <text
          x={W - PAD_R} y={PAD_T - 6}
          fill="#a3a3a3" fontSize="9.5" fontFamily="JetBrains Mono,monospace"
          textAnchor="end" letterSpacing="0.06em"
          style={{ textTransform: 'uppercase' }}
        >
          Benchmark · 50%
        </text>
      </svg>
    </div>
  );
}

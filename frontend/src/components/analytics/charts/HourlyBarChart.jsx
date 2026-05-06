import { useMemo } from 'react';

export default function HourlyBarChart({ hours, metric = 'spend' }) {
  const w = 880, h = 160, padL = 48, padR = 16, padT = 12, padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const { values, maxVal } = useMemo(() => {
    if (!hours || hours.length !== 24) return { values: [], maxVal: 0 };
    const vals = hours.map(hr => hr[metric] || 0);
    return { values: vals, maxVal: Math.max(...vals) || 1 };
  }, [hours, metric]);

  if (values.length === 0) return null;

  const barW = (innerW / 24) * 0.72;
  const gap = innerW / 24;

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      {values.map((v, i) => {
        const intensity = v / maxVal;
        const barH = intensity * innerH;
        const x = padL + i * gap + (gap - barW) / 2;
        const y = padT + innerH - barH;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={barH}
            fill={`rgba(56,166,56, ${(intensity * 0.92).toFixed(2)})`}
            rx="2"
          />
        );
      })}
      {[0, 6, 12, 18, 23].map(i => (
        <text key={i} x={padL + i * gap + gap / 2} y={h - 8} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="middle">
          {i.toString().padStart(2, '0')}
        </text>
      ))}
      <text x={padL} y={padT - 2} fill="#a3a3a3" fontSize="10" fontFamily="JetBrains Mono,monospace" className="uppercase tracking-[0.08em]">
        Hour of day
      </text>
    </svg>
  );
}

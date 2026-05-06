import { useState, useMemo, useRef } from 'react';
import { fmt$ } from './chartUtils';

const METRIC_LABELS = {
  spend: 'Spend', roas: 'ROAS', ctr: 'CTR', impressions: 'Impressions', clicks: 'Clicks',
};

export default function TimeseriesChart({ data, primary = 'spend', secondary = 'roas' }) {
  const [hover, setHover] = useState(null);
  const containerRef = useRef(null);
  const w = 880, h = 280, padL = 48, padR = 48, padT = 24, padB = 32;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const { primaryPath, primaryArea, secondaryPath, gridlines, stepX } = useMemo(() => {
    if (!data || data.length < 2) return { primaryPath: '', primaryArea: '', secondaryPath: '', gridlines: [], stepX: 0 };

    const pVals = data.map(d => d[primary]);
    const sVals = data.map(d => d[secondary]);
    const pMax = Math.max(...pVals);
    const pMin = Math.min(...pVals) * 0.85;
    const sMax = Math.max(...sVals);
    const sMin = Math.min(...sVals) * 0.85;
    const step = innerW / (data.length - 1);
    const xAt = (i) => padL + i * step;
    const yP = (v) => padT + innerH * (1 - (v - pMin) / ((pMax - pMin) || 1));
    const yS = (v) => padT + innerH * (1 - (v - sMin) / ((sMax - sMin) || 1));

    const pPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yP(d[primary])}`).join(' ');
    const pArea = `${pPath} L ${xAt(data.length - 1)} ${padT + innerH} L ${padL} ${padT + innerH} Z`;
    const sPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yS(d[secondary])}`).join(' ');

    const lines = [0.25, 0.5, 0.75, 1].map(t => {
      const v = pMin + (pMax - pMin) * (1 - t);
      return { y: padT + innerH * t, label: primary === 'spend' ? fmt$(v) : v.toFixed(1) };
    });

    return { primaryPath: pPath, primaryArea: pArea, secondaryPath: sPath, gridlines: lines, stepX: step };
  }, [data, primary, secondary]);

  if (!data || data.length < 2) return null;

  const xAt = (i) => padL + i * stepX;

  const formatVal = (metric, v) => {
    if (metric === 'spend') return fmt$(v);
    if (metric === 'ctr') return v.toFixed(2) + '%';
    if (metric === 'roas') return v.toFixed(2) + 'x';
    return v.toLocaleString();
  };

  const tooltipX = hover !== null ? (xAt(hover) / w) * 100 : 0;
  const tooltipLeft = hover !== null ? Math.min(tooltipX, 82) : 0;

  return (
    <div className="relative" ref={containerRef}>
      <svg
        width="100%" height={h} viewBox={`0 0 ${w} ${h}`}
        className="block"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="ts-area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38a638" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#38a638" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridlines.map((g, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={g.y} y2={g.y} stroke="#ebebeb" strokeWidth="1" />
            <text x={padL - 10} y={g.y + 4} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="end">{g.label}</text>
          </g>
        ))}

        {data.map((d, i) => i % 2 === 1 && (
          <text key={i} x={xAt(i)} y={h - 10} fill="#a3a3a3" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="middle">
            {d.date.slice(5)}
          </text>
        ))}

        <path d={primaryArea} fill="url(#ts-area-grad)" />
        <path d={primaryPath} fill="none" stroke="#38a638" strokeWidth="1.8" />
        <path d={secondaryPath} fill="none" stroke="#262626" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.7" />

        {data.map((d, i) => (
          <g key={i}>
            <rect x={xAt(i) - stepX / 2} y={padT} width={stepX} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
            {hover === i && (
              <line x1={xAt(i)} x2={xAt(i)} y1={padT} y2={padT + innerH} stroke="#262626" strokeWidth="0.8" opacity="0.4" />
            )}
          </g>
        ))}
      </svg>

      {hover !== null && (
        <div
          className="absolute top-6 pointer-events-none z-10 bg-ed-ink text-white rounded-md px-3 py-2.5 font-mono-ed text-[11.5px] leading-relaxed"
          style={{ left: `${tooltipLeft}%` }}
        >
          <div className="uppercase tracking-[0.06em] opacity-60 mb-1">{data[hover].date}</div>
          <div>{METRIC_LABELS[primary]} <span className="font-medium">{formatVal(primary, data[hover][primary])}</span></div>
          <div className="opacity-70">{METRIC_LABELS[secondary]} {formatVal(secondary, data[hover][secondary])}</div>
        </div>
      )}
    </div>
  );
}

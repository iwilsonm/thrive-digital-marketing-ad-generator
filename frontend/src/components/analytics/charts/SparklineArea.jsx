import { useMemo } from 'react';
import { pathFor, areaFor } from './chartUtils';

export default function SparklineArea({ series, accent = '#38a638', id = 'spark' }) {
  const w = 220, h = 48;
  const linePath = useMemo(() => pathFor(series, w, h, 4, 2), [series]);
  const areaPath = useMemo(() => areaFor(series, w, h, 4, 2), [series]);

  if (!series || series.length < 2) return null;

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block mt-2.5">
      <defs>
        <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.25" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#grad-${id})`} />
      <path d={linePath} fill="none" stroke={accent} strokeWidth="1.4" />
    </svg>
  );
}

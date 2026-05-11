import { useState, useMemo } from 'react';

function formatCost(value) {
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Stacked bar segments (bottom to top): OpenAI → Anthropic → Gemini
const SERVICES = [
  { key: 'openai',     label: 'OpenAI',     color: '#5B8DEF', hoverColor: '#4A7ADE', legendColor: 'bg-[#5B8DEF]',  tooltipColor: 'text-[#8BAFF5]' },
  { key: 'anthropic',  label: 'Anthropic',   color: '#7C6DCD', hoverColor: '#6B5CBC', legendColor: 'bg-[#7C6DCD]',  tooltipColor: 'text-[#9D91DA]' },
  { key: 'gemini',     label: 'Gemini',      color: '#38A638', hoverColor: '#2F8F2F', legendColor: 'bg-ed-green',        tooltipColor: 'text-ed-green' },
];

export default function CostBarChart({ data, loading, rangeLabel, historyRange, setHistoryRange, historyRanges, customStart, setCustomStart, customEnd, setCustomEnd }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return { bars: [], maxValue: 0, yLabels: [] };

    const maxValue = Math.max(...data.map(d => d.total), 0.01);

    // Generate nice Y-axis labels
    const yLabels = [];
    const step = maxValue / 4;
    for (let i = 4; i >= 0; i--) {
      yLabels.push(step * i);
    }

    return { bars: data, maxValue, yLabels };
  }, [data]);

  // Which services actually have data (for legend + tooltip)
  const activeServices = useMemo(() => {
    if (!data || data.length === 0) return [];
    return SERVICES.filter(s => data.some(d => (d[s.key] || 0) > 0));
  }, [data]);

  const grandTotal = useMemo(() => {
    if (!data || data.length === 0) return 0;
    return data.reduce((sum, d) => sum + (d.total || 0), 0);
  }, [data]);

  const rangeHeader = (
    <>
      <h4 className="text-[13px] font-semibold text-ed-ink">{rangeLabel || 'Spend History'}</h4>
      {historyRanges && setHistoryRange && (
        <select
          value={historyRange?.key || '30d'}
          onChange={e => setHistoryRange(historyRanges.find(r => r.key === e.target.value) || historyRanges[2])}
          className="text-[11px] text-ed-ink bg-ed-bg border border-black/10 rounded-lg px-2 py-1 cursor-pointer"
        >
          {historyRanges.map(r => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
      )}
    </>
  );

  if (loading) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-3 mb-4">{rangeHeader}</div>
        <div className="h-40 bg-ed-bg rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-3 mb-4">{rangeHeader}</div>
        <div className="h-32 flex items-center justify-center text-[12px] text-ed-ink3">
          No cost data for this range. Try a different range or generate ads to populate spend history.
        </div>
      </div>
    );
  }

  const { bars, maxValue, yLabels } = chartData;
  const chartHeight = 160;
  const barWidth = Math.max(4, Math.min(14, (100 / bars.length) * 0.7));
  const barGap = Math.max(1, (100 / bars.length) * 0.3);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {rangeHeader}
          <span className="text-[12px] font-semibold text-ed-ink2">Total: {formatCost(grandTotal)}</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-ed-ink3">
          {activeServices.map(s => (
            <span key={s.key} className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${s.legendColor}`} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      {historyRange?.key === 'custom' && setCustomStart && (
        <div className="flex items-center gap-1.5 text-[11px] mb-4">
          <input type="date" value={customStart || ''} onChange={e => setCustomStart(e.target.value)} className="input-apple text-[11px] py-1 px-2 w-[130px]" />
          <span className="text-ed-ink3">to</span>
          <input type="date" value={customEnd || ''} onChange={e => setCustomEnd(e.target.value)} className="input-apple text-[11px] py-1 px-2 w-[130px]" />
        </div>
      )}

      <div className="relative" style={{ height: chartHeight + 30 }}>
        {/* Y-axis labels */}
        <div className="absolute left-0 top-0 bottom-[30px] w-10 flex flex-col justify-between text-[9px] text-ed-ink3 font-mono">
          {yLabels.map((v, i) => (
            <span key={i}>{formatCost(v)}</span>
          ))}
        </div>

        {/* Chart area */}
        <div className="ml-12 relative" style={{ height: chartHeight }}>
          {/* Grid lines */}
          {yLabels.map((_, i) => (
            <div
              key={i}
              className="absolute w-full border-t border-black/5"
              style={{ top: `${(i / (yLabels.length - 1)) * 100}%` }}
            />
          ))}

          {/* SVG Bars */}
          <svg
            width="100%"
            height={chartHeight}
            viewBox={`0 0 ${bars.length * (barWidth + barGap)} ${chartHeight}`}
            preserveAspectRatio="none"
            className="relative z-10"
          >
            {bars.map((bar, i) => {
              const x = i * (barWidth + barGap);
              const isHovered = hoveredIndex === i;

              // Calculate heights for stacked segments
              const segments = SERVICES.map(s => ({
                ...s,
                value: bar[s.key] || 0,
                h: maxValue > 0 ? ((bar[s.key] || 0) / maxValue) * chartHeight : 0,
              })).filter(seg => seg.h > 0);

              // Stack from bottom: first segment at bottom, last at top
              let yOffset = chartHeight;

              return (
                <g
                  key={bar.date}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  className="cursor-pointer"
                >
                  {/* Hover target (full height, invisible) */}
                  <rect x={x} y={0} width={barWidth} height={chartHeight} fill="transparent" />
                  {segments.map(seg => {
                    yOffset -= seg.h;
                    return (
                      <rect
                        key={seg.key}
                        x={x}
                        y={yOffset}
                        width={barWidth}
                        height={seg.h}
                        rx={1}
                        fill={isHovered ? seg.hoverColor : seg.color}
                        className="transition-all duration-150"
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>

        {/* X-axis date labels (show every ~5th) */}
        <div className="ml-12 flex justify-between mt-1 text-[9px] text-ed-ink3">
          {bars.filter((_, i) => i === 0 || i === bars.length - 1 || i % Math.ceil(bars.length / 5) === 0)
            .map(bar => (
              <span key={bar.date}>{formatDateLabel(bar.date)}</span>
            ))}
        </div>

        {/* Tooltip */}
        {hoveredIndex !== null && bars[hoveredIndex] && (
          <div
            className="absolute z-20 bg-ed-accent text-white text-[11px] rounded-lg px-3 py-2 shadow-lg pointer-events-none"
            style={{
              left: `${12 + (hoveredIndex / bars.length) * 85}%`,
              top: 0,
              transform: 'translateX(-50%)'
            }}
          >
            <p className="font-medium mb-0.5">{formatDateLabel(bars[hoveredIndex].date)}</p>
            <p>Total: {formatCost(bars[hoveredIndex].total)}</p>
            {SERVICES.map(s => {
              const val = bars[hoveredIndex][s.key] || 0;
              return val > 0 ? (
                <p key={s.key} className={s.tooltipColor}>{s.label}: {formatCost(val)}</p>
              ) : null;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

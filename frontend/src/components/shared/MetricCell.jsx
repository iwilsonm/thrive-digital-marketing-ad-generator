import React from 'react';

export default function MetricCell({ label, value, delta, deltaDirection }) {
  const displayValue = value == null ? '--' : value;
  const hasDelta = delta != null && delta !== '' && deltaDirection;

  return (
    <div className="metric-cell">
      <span className="metric-cell-label">{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span className="metric-cell-value">{displayValue}</span>
        {hasDelta && (
          <span className={`metric-cell-delta ${deltaDirection === 'up' ? 'positive' : 'negative'}`}>
            {deltaDirection === 'up' ? '+' : ''}{delta}
          </span>
        )}
      </div>
    </div>
  );
}

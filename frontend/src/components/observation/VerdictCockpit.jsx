const TILES = [
  { key: 'observing', label: 'Observing', color: '#62b462' },
  { key: 'passed', label: 'Passed', color: '#38a638' },
  { key: 'failed', label: 'Failed', color: '#ef4444' },
  { key: 'insufficient', label: 'Insufficient', color: '#a3a3a3' },
];

export default function VerdictCockpit({ counts, total, passRate }) {
  return (
    <div className="ed-card" style={{ padding: 22 }}>
      <div style={{ marginBottom: 18 }}>
        <h3 className="font-serif" style={{ fontSize: 18 }}>Current verdicts</h3>
        <div className="text-[12px] text-ed-ink3" style={{ marginTop: 2 }}>
          {total} ad set{total === 1 ? '' : 's'} in observation pipeline
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {TILES.map(({ key, label, color }) => (
          <div
            key={key}
            className="rounded-lg border border-ed-line bg-ed-bg"
            style={{ padding: '14px 14px 12px' }}
          >
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <span
                className="rounded-full flex-shrink-0"
                style={{ width: 8, height: 8, background: color }}
              />
              <span className="text-[10.5px] uppercase font-mono-ed tracking-[0.10em] text-ed-ink3">
                {label}
              </span>
            </div>
            <div className="font-serif text-ed-ink" style={{ fontSize: 28, letterSpacing: '-0.02em' }}>
              {counts[key] || 0}
            </div>
          </div>
        ))}
      </div>

      <div
        className="rounded-lg flex justify-between items-center"
        style={{ marginTop: 18, padding: '14px 16px', background: 'var(--ed-ink, #262626)', color: 'var(--ed-surface, #ffffff)' }}
      >
        <div>
          <div className="font-mono-ed uppercase" style={{ fontSize: 10.5, opacity: 0.6, letterSpacing: '0.1em', marginBottom: 3 }}>
            Pass rate
          </div>
          <div className="font-serif" style={{ fontSize: 24, letterSpacing: '-0.02em' }}>
            {passRate != null ? `${passRate}%` : '—'}
          </div>
        </div>
        <div className="font-mono-ed text-right" style={{ fontSize: 11, opacity: 0.7 }}>
          {counts.passed || 0} pass<br />{counts.failed || 0} fail
        </div>
      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

export const TAG_COLORS = [
  { name: 'gray',   hex: '#787774' },
  { name: 'brown',  hex: '#9F6B53' },
  { name: 'orange', hex: '#D9730D' },
  { name: 'yellow', hex: '#CB912F' },
  { name: 'green',  hex: '#448361' },
  { name: 'blue',   hex: '#337EA9' },
  { name: 'purple', hex: '#9065B0' },
  { name: 'pink',   hex: '#C14C8A' },
  { name: 'red',    hex: '#D44C47' },
];

export default function TagPicker({ allTags, appliedTagIds, onApply, onRemove, onCreate, anchorRef, onClose }) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0].hex);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const ref = useRef(null);
  const width = 256;

  useEffect(() => {
    function updatePosition() {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const gap = 6;
      const menuHeight = Math.min(creating ? 240 : 290, window.innerHeight - gap * 2);
      const opensUp = rect.bottom + gap + menuHeight > window.innerHeight && rect.top > menuHeight;
      const top = opensUp
        ? Math.max(gap, rect.top - menuHeight - gap)
        : Math.min(window.innerHeight - gap, rect.bottom + gap);
      const left = Math.min(
        Math.max(gap, rect.left),
        Math.max(gap, window.innerWidth - width - gap)
      );
      setPosition({ top, left });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, creating]);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target) && anchorRef?.current && !anchorRef.current.contains(e.target)) {
        onClose?.();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose, anchorRef]);

  const filtered = (allTags || []).filter(t =>
    !query || t.name.toLowerCase().includes(query.toLowerCase())
  );

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 w-64 bg-ed-surface border border-ed-line rounded-xl shadow-card p-2"
      style={{ top: position.top, left: position.left }}
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search or create tag…"
        className="w-full text-[12px] px-2 py-1.5 border border-ed-line rounded-lg focus:outline-none focus:border-ed-accent"
      />

      <div className="max-h-44 overflow-y-auto mt-1.5">
        {filtered.length === 0 && !creating && (
          <div className="text-[11px] text-ed-ink3 px-2 py-1.5">No tags match.</div>
        )}
        {filtered.map(tag => {
          const applied = appliedTagIds.includes(tag.externalId);
          return (
            <button
              key={tag.externalId}
              onClick={() => applied ? onRemove(tag) : onApply(tag)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] hover:bg-ed-bg rounded-lg"
            >
              <span className="w-3 h-3 rounded-full" style={{ background: tag.color }} />
              <span className="flex-1 text-left text-ed-ink">{tag.name}</span>
              {applied && (
                <svg className="w-3.5 h-3.5 text-ed-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          );
        })}
      </div>

      <div className="border-t border-ed-line pt-2 mt-1.5">
        {!creating ? (
          <button
            onClick={() => { setCreating(true); setNewName(query); }}
            className="w-full text-left text-[11px] text-ed-accent hover:text-ed-accent/80 px-2 py-1"
          >
            + Create new tag{query ? ` "${query}"` : ''}
          </button>
        ) : (
          <div className="space-y-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Tag name"
              className="w-full text-[12px] px-2 py-1.5 border border-ed-line rounded-lg focus:outline-none focus:border-ed-accent"
            />
            <div className="flex flex-wrap gap-1">
              {TAG_COLORS.map(c => (
                <button
                  key={c.hex}
                  onClick={() => setNewColor(c.hex)}
                  title={c.name}
                  className={`w-5 h-5 rounded-full border-2 ${newColor === c.hex ? 'border-textdark' : 'border-transparent'}`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <button
                disabled={!newName.trim()}
                onClick={async () => {
                  await onCreate({ name: newName.trim(), color: newColor });
                  setCreating(false); setNewName(''); setQuery('');
                }}
                className="px-3 py-1.5 rounded-[6px] text-[11px] bg-ed-accent text-white text-[11px] px-2 py-1"
              >
                Create + apply
              </button>
              <button
                onClick={() => setCreating(false)}
                className="text-[11px] text-ed-ink2 hover:text-ed-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

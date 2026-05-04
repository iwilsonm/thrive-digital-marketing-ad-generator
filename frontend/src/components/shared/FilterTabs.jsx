import React, { useRef, useCallback } from 'react';

export default function FilterTabs({ tabs = [], activeValue, onChange }) {
  const containerRef = useRef(null);

  const handleKeyDown = useCallback((e) => {
    const currentIndex = tabs.findIndex(t => t.value === activeValue);
    let nextIndex = currentIndex;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else {
      return;
    }

    onChange(tabs[nextIndex].value);
    const buttons = containerRef.current?.querySelectorAll('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  }, [tabs, activeValue, onChange]);

  return (
    <div className="filter-tabs" role="tablist" ref={containerRef}>
      {tabs.map(tab => {
        const isActive = tab.value === activeValue;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className="filter-tab"
            onClick={() => onChange(tab.value)}
            onKeyDown={handleKeyDown}
          >
            {tab.label}
            {tab.count != null && <span className="filter-tab-count">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

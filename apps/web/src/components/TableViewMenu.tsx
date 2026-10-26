import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TableViewChoice } from '../table3d/quality.js';
import type { TableView } from '../table3d/useTableView.js';

const CHOICES: { value: TableViewChoice; label: string; hint: string }[] = [
  { value: '2d', label: 'Classic 2D', hint: 'The flat table, seen from above' },
  { value: 'seated', label: '3D — Seated', hint: 'Your own eyes at your seat. Drag to look around' },
  { value: 'standing', label: '3D — Standing', hint: 'On your feet at your seat: the whole table in view' },
];

/** The table header's View menu: the three ways to see the table, plus reduced motion and slow animations. */
export function TableViewMenu({ view }: { view: TableView }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // On a phone the header wraps and this button can sit anywhere in it: the
  // menu then spans the screen just below the button instead of hanging off its edge.
  const [phoneTop, setPhoneTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const btn = rootRef.current?.querySelector('.table-view-toggle');
      setPhoneTop(btn && window.innerWidth <= 600 ? btn.getBoundingClientRect().bottom + 6 : null);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="table-view-menu" ref={rootRef}>
      <button type="button" className="table-view-toggle" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Table view">
        <span aria-hidden="true">🎥</span> View
      </button>
      {open && (
        <div
          className={`table-view-popover${phoneTop !== null ? ' table-view-popover--phone' : ''}`}
          role="dialog"
          aria-label="Table view"
          style={phoneTop !== null ? { top: phoneTop, maxHeight: `calc(100dvh - ${String(phoneTop + 12)}px)` } : undefined}
        >
          {view.fallbackReason && (
            <div className="table-view-now muted">
              Showing the 2D table: {view.fallbackReason === 'no-webgl' ? 'this browser can’t show 3D.' : '3D was too slow on this device.'}
            </div>
          )}
          <div role="radiogroup" aria-label="View">
            {CHOICES.map((c) => (
              <label key={c.value} className="table-view-choice">
                <input type="radio" name="table-view" checked={view.choice === c.value} onChange={() => view.setChoice(c.value)} />
                <span>
                  {c.label}
                  <small>{c.hint}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="table-view-extras">
            <label className="table-view-choice">
              <input type="checkbox" checked={view.reduceMotion} onChange={(e) => view.setReduceMotion(e.target.checked)} />
              <span>
                Reduce motion
                <small>No flying cards or chips; banners stay still</small>
              </span>
            </label>
            <label className="table-view-choice">
              <input type="checkbox" checked={view.slowAnimations} onChange={(e) => view.setSlowAnimations(e.target.checked)} />
              <span>
                Slow animations
                <small>Split-pot announcements stay up longer</small>
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

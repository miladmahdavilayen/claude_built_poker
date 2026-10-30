import type { TableViewChoice } from '../table3d/quality.js';
import type { TableView } from '../table3d/useTableView.js';

const CHOICES: { value: TableViewChoice; label: string; hint: string }[] = [
  { value: '2d', label: 'Classic 2D', hint: 'The flat table, seen from above' },
  { value: 'seated', label: '3D — Seated', hint: 'Your own eyes at your seat. Drag to look around' },
  { value: 'standing', label: '3D — Standing', hint: 'On your feet at your seat: the whole table in view' },
];

/** The table menu's View section: the three ways to see the table, plus reduced motion and slow animations. */
export function TableViewOptions({ view }: { view: TableView }): React.JSX.Element {
  return (
    <div className="table-view-options">
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
  );
}

import { useRef, useState } from 'react';

const REVEAL_PX = 96;
const OPEN_THRESHOLD_PX = 48;
/** How far a pointer must travel sideways before it counts as a swipe rather than a tap or a scroll. */
const DRAG_START_PX = 8;

/**
 * Swipe (or drag, with a mouse) the wrapped item left to reveal a Delete
 * button behind it. The pointer is only captured once the movement is
 * clearly sideways, so taps on buttons inside still work and vertical
 * scrolling on a phone isn't blocked. Delete doesn't act by itself — it
 * calls `onDelete`, and the caller confirms first.
 */
export function SwipeToDelete({ label, onDelete, children }: { label: string; onDelete: () => void; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; y: number; base: number; dragging: boolean } | null>(null);
  const justDragged = useRef(false);
  // The live drag offset. State lags a render behind fast pointer moves, so
  // the release decision reads this, never a possibly-stale `drag`.
  const liveOffset = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    start.current = { x: e.clientX, y: e.clientY, base: open ? -REVEAL_PX : 0, dragging: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.dragging) {
      if (Math.abs(dx) < DRAG_START_PX || Math.abs(dx) < Math.abs(e.clientY - s.y)) return;
      s.dragging = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    liveOffset.current = Math.min(0, Math.max(s.base + dx, -REVEAL_PX));
    setDrag(liveOffset.current);
  };
  const onPointerUp = (): void => {
    const s = start.current;
    start.current = null;
    if (!s?.dragging) return;
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    setOpen(liveOffset.current <= -OPEN_THRESHOLD_PX);
    setDrag(null);
  };

  const offset = drag ?? (open ? -REVEAL_PX : 0);
  return (
    <div className="swipe-delete">
      {/* Only there while being uncovered: a hidden-but-present button would
          still be announced by screen readers (and the item on top is
          slightly see-through). */}
      {offset < 0 && (
        <button
          type="button"
          className="swipe-delete-action"
          aria-label={`Delete ${label}`}
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          Delete
        </button>
      )}
      <div
        className={`swipe-delete-item${drag !== null ? ' swipe-delete-dragging' : ''}`}
        style={{ transform: `translateX(${String(offset)}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // A click that ends a drag shouldn't also land on a button inside.
        onClickCapture={(e) => {
          if (justDragged.current) e.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
}

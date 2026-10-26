import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface SeatAction {
  label: string;
  /** Red, and asks for a second tap before it acts. */
  danger?: boolean;
  onSelect: () => void;
}

/**
 * The owner's per-seat menu: opened by double-tapping a player's seat
 * (holding an empty one), or right-clicking — works the same in full screen, where the
 * table's other controls are hidden. Placed at the pointer, kept inside the
 * screen. A destructive item (remove, delete) needs a second tap to confirm.
 * Closes on a tap outside, Escape, or choosing something.
 */
export function SeatActionMenu({
  x,
  y,
  title,
  actions,
  onClose,
  large = false,
}: {
  x: number;
  y: number;
  title: string;
  actions: SeatAction[];
  onClose: () => void;
  /** Big, finger-sized options — what a tap on an empty seat opens. */
  large?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [confirming, setConfirming] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - r.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - r.height - margin)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // Registered a tick late, so the long-press/right-click that opened it doesn't also close it.
    const id = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={`seat-action-menu${large ? ' seat-action-menu--large' : ''}`} role="menu" aria-label={title} style={{ left: pos.left, top: pos.top }} onContextMenu={(e) => e.preventDefault()}>
      <div className="seat-action-menu-title">{title}</div>
      {actions.map((a) => {
        const armed = confirming === a.label;
        return (
          <button
            key={a.label}
            type="button"
            role="menuitem"
            className={`seat-action-item${a.danger ? ' seat-action-danger' : ''}${armed ? ' seat-action-armed' : ''}`}
            onClick={() => {
              if (a.danger && !armed) {
                setConfirming(a.label);
                return;
              }
              onClose();
              a.onSelect();
            }}
          >
            {armed ? `Tap again to ${a.label.toLowerCase()}` : a.label}
          </button>
        );
      })}
    </div>
  );
}

const HOLD_MS = 1000;
const MOVE_TOLERANCE_PX = 10;

/**
 * Hold-to-open (1 second, finger or mouse) and right-click handlers, bound
 * per seat (or per lobby table — anything with a key) — `onOpen` gets the
 * key and where to put the menu. Holding still
 * is what counts: moving more than a few pixels (a scroll, a swipe) cancels
 * it. A touch long-press's own browser "right click" (Android fires one at
 * about half a second) is ignored, so it's always the full second.
 */
export function useSeatMenuGesture<K = number>(
  onOpen: (key: K, x: number, y: number) => void,
  enabled: boolean,
): (key: K) => {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useRef<string>('mouse');
  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);
  return (key) => ({
    onPointerDown: (e) => {
      lastPointer.current = e.pointerType;
      if (!enabled || e.button !== 0) return;
      cancel();
      start.current = { x: e.clientX, y: e.clientY };
      const { clientX, clientY } = e;
      timer.current = setTimeout(() => {
        timer.current = null;
        start.current = null;
        // Lifting the finger that held still ends in a click on whatever is under it — the seat's own
        // "Sit here", say, when the menu had to open away from the finger. That click belongs to the hold: swallow it.
        const swallow = (ev: MouseEvent): void => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        window.addEventListener('pointerup', () => setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0), { once: true });
        if ('vibrate' in navigator) navigator.vibrate(30);
        onOpen(key, clientX, clientY);
      }, HOLD_MS);
    },
    onPointerMove: (e) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e) => {
      if (!enabled) return;
      e.preventDefault();
      if (lastPointer.current === 'touch') return; // the hold timer opens it
      cancel();
      onOpen(key, e.clientX, e.clientY);
    },
  });
}

const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_PX = 40;

/**
 * Double-tap-to-open (finger or mouse) and right-click handlers — the
 * owner's menu for a seat with a player in it. Two taps within a moment and
 * close together count; a drag in between doesn't. The second tap's own
 * click is swallowed, so it can't land on the menu that just opened under
 * the finger.
 */
export function useSeatDoubleTap<K = number>(
  onOpen: (key: K, x: number, y: number) => void,
  enabled: boolean,
): (key: K) => {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
} {
  const down = useRef<{ x: number; y: number } | null>(null);
  const last = useRef<{ key: K; x: number; y: number; at: number } | null>(null);
  return (key) => ({
    onPointerDown: (e) => {
      down.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    },
    onPointerUp: (e) => {
      const d = down.current;
      down.current = null;
      // A drag (looking around, scrolling) isn't a tap.
      if (!enabled || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > MOVE_TOLERANCE_PX) return;
      const now = performance.now();
      const prev = last.current;
      if (prev && prev.key === key && now - prev.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_PX) {
        last.current = null;
        const swallow = (ev: MouseEvent): void => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
        if ('vibrate' in navigator) navigator.vibrate(20);
        onOpen(key, e.clientX, e.clientY);
        return;
      }
      last.current = { key, x: e.clientX, y: e.clientY, at: now };
    },
    onContextMenu: (e) => {
      if (!enabled) return;
      e.preventDefault();
      onOpen(key, e.clientX, e.clientY);
    },
  });
}

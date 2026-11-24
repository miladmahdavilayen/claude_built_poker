import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canvasObstacles, type ScreenRect } from '../table3d/canvasObstacles.js';

/**
 * Everything on the table that a passing note must not land on: every seat
 * (taken or empty), the board and pot, bets and blind tags, the corner's
 * buttons, the clock, the menu button, the Play Hand panel, your action
 * buttons, the other notices — and, on the 3D table, the players' camera
 * screens (drawn in the canvas; the scene reports them).
 */
const OBSTACLES = [
  '.seat-slot > .seat',
  '.board-area',
  '.board-hud',
  '.pot-hud',
  '.bet-chips-slot',
  '.blind-tag',
  '.table-corner',
  '.action-timer:not(.action-timer-hidden)',
  '.table-menu-button',
  '.table-clock',
  '.start-hand-panel > *',
  '.action-bar',
  '.bet-overlay',
  '.btn-reveal-hand',
  '.fairness-commitment',
  '.fairness-link',
  '.table-notices > *',
  '.table-unseated',
  '.table3d-recenter',
  '.table3d-whole',
  '.table3d-look-hint',
  '.action-ticker',
].join(', ');

const GAP = 8;

function shown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

function obstacles(): ScreenRect[] {
  const out: ScreenRect[] = [...canvasObstacles()];
  for (const el of document.querySelectorAll(OBSTACLES)) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    out.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
  }
  return out;
}

const clear = (x: number, y: number, w: number, h: number, taken: readonly ScreenRect[]): boolean =>
  !taken.some((b) => x < b.x1 + GAP && x + w > b.x0 - GAP && y < b.y1 + GAP && y + h > b.y0 - GAP);

/**
 * The free spot for a box this size nearest the top middle of the screen
 * (where a note is looked for first) — or null if the table is so full
 * there's none.
 */
function findSpot(w: number, h: number, taken: readonly ScreenRect[]): { left: number; top: number } | null {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const homeX = (W - w) / 2;
  const homeY = 62;
  let best: { left: number; top: number } | null = null;
  let bestCost = Infinity;
  for (let y = GAP; y + h <= H - GAP; y += 12) {
    for (let x = GAP; x + w <= W - GAP; x += 16) {
      // Sideways is cheaper than down: a note reads best near the top, wherever along it.
      const cost = Math.abs(y - homeY) * 1.4 + Math.abs(x - homeX) * 0.5;
      if (cost >= bestCost || !clear(x, y, w, h, taken)) continue;
      best = { left: x, top: y };
      bestCost = cost;
    }
  }
  // Centred exactly, when the middle column itself is free at that height.
  if (best && Math.abs(best.left - homeX) < 16 && clear(homeX, best.top, w, h, taken)) best = { left: homeX, top: best.top };
  return best;
}

/**
 * Holds the table's passing notes (a chat line, a mention, a poke, a slow
 * turn's banner) wherever there's room for them right now: over no seat,
 * card, chip, button or camera. It looks for the free spot nearest the top
 * middle when something appears, and stays there — moving only if the table
 * changes under it (a seat's box arriving, the board being dealt).
 */
export function FreeSpot({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  const spotRef = useRef(spot);
  spotRef.current = spot;

  const place = (): void => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w === 0 || h === 0) {
      if (spotRef.current) setSpot(null);
      return;
    }
    const taken = obstacles();
    const now = spotRef.current;
    // Still free where it is: it stays (a note that wandered about would be worse than one that's a little off-centre).
    if (now && now.left + w <= window.innerWidth - GAP && now.top + h <= window.innerHeight - GAP && clear(now.left, now.top, w, h, taken)) return;
    const next = findSpot(w, h, taken) ?? { left: Math.max(GAP, (window.innerWidth - w) / 2), top: 62 };
    if (!now || Math.abs(now.left - next.left) > 0.5 || Math.abs(now.top - next.top) > 0.5) setSpot(next);
  };

  // Placed before it's painted, whenever what it holds changes; then watched while it's up.
  useLayoutEffect(place);
  useEffect(() => {
    const id = setInterval(place, 400);
    window.addEventListener('resize', place);
    return () => {
      clearInterval(id);
      window.removeEventListener('resize', place);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`free-spot ${className}`}
      data-testid="free-spot"
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {children}
    </div>
  );
}

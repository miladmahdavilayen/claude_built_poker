import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

// Everything on the felt a camera tile must never sit on top of. Seats are
// checked separately (every other seat, video or not, is an obstacle too).
const OBSTACLE_SELECTORS = [
  '.board-area',
  '.seat-cards-above-video',
  '.fairness-commitment',
  '.fairness-link',
  '.action-timer:not(.action-timer-hidden)',
  '.bet-chips-slot',
  '.immersive-toggle',
];

// Sub-pixel antialiasing/rounding shouldn't count as a collision.
const TOLERANCE_PX = 1;

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right - TOLERANCE_PX &&
    a.right > b.left + TOLERANCE_PX &&
    a.top < b.bottom - TOLERANCE_PX &&
    a.bottom > b.top + TOLERANCE_PX
  );
}

function isEmpty(r: DOMRect): boolean {
  return r.width === 0 || r.height === 0;
}

function seatIdOf(el: Element): string | null {
  return el.closest<HTMLElement>('.seat-slot')?.dataset.testid?.replace(/^seat-/, '') ?? null;
}

/**
 * Seat ids of every seat currently showing video whose tile (or, for the
 * viewer, whose cards raised above the tile) collides with another seat,
 * the board/pot, a bet, the timer, the fairness banner/link, or the
 * full-screen toggle — or runs off the screen. Seats near the felt's edge
 * sit slightly over its rail by design, so the felt's own bounds aren't the
 * limit. Measured from the real rendered layout, so it holds for any device
 * size, seat count, or font/zoom setting.
 */
function collidingCameraSeatIds(felt: HTMLElement): Set<string> {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const seats = [...felt.querySelectorAll<HTMLElement>('.seat-slot > .seat')];
  const obstacles = [...seats, ...OBSTACLE_SELECTORS.flatMap((sel) => [...felt.querySelectorAll<HTMLElement>(sel)])];
  const subjects = [...seats.filter((s) => s.classList.contains('seat-has-video')), ...felt.querySelectorAll<HTMLElement>('.seat-cards-above-video')];

  const colliding = new Set<string>();
  for (const subject of subjects) {
    const id = seatIdOf(subject);
    if (id === null || colliding.has(id)) continue;
    const r = subject.getBoundingClientRect();
    if (isEmpty(r)) continue;
    if (r.left < 0 || r.top < 0 || r.right > viewportWidth || r.bottom > viewportHeight) {
      colliding.add(id);
      continue;
    }
    for (const obstacle of obstacles) {
      // Skip itself, and its own seat <-> own raised cards.
      if (obstacle === subject || obstacle.contains(subject) || subject.contains(obstacle)) continue;
      const o = obstacle.getBoundingClientRect();
      if (!isEmpty(o) && overlaps(r, o)) {
        colliding.add(id);
        break;
      }
    }
  }
  return colliding;
}

/**
 * Which camera seats must hide their video so that nothing collides. Starts
 * with every camera showing; after each render, if any video tile collides
 * with something, hides the lowest-priority one involved (per
 * `priorityOrder`, most important first — e.g. the viewer, then active
 * speakers) and measures again, until nothing collides. All of this runs in
 * layout effects, so the intermediate states never paint. Starts over with
 * every camera whenever the felt resizes (rotation, window resize), the set
 * of cameras changes, a new hand starts, or `enabled` flips.
 */
export function useCameraFit(
  feltRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  priorityOrder: string[],
  handId: string | null,
): ReadonlySet<string> {
  const [layoutVersion, setLayoutVersion] = useState(0);
  const key = `${String(enabled)}|${[...priorityOrder].sort().join(',')}|${String(layoutVersion)}|${handId ?? ''}`;
  const [fit, setFit] = useState<{ key: string; hidden: ReadonlySet<string> }>({ key, hidden: new Set() });
  const hidden = fit.key === key ? fit.hidden : new Set<string>();

  useEffect(() => {
    const felt = feltRef.current;
    if (!enabled || !felt) return;
    let lastWidth = -1;
    let lastHeight = -1;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      setLayoutVersion((v) => v + 1);
    });
    ro.observe(felt);
    return () => ro.disconnect();
  }, [feltRef, enabled]);

  // Deliberately runs after every render, not just when `key` changes: a
  // newly dealt board, a bet landing, or the viewer's own cards appearing
  // can each introduce a collision without anything in `key` changing.
  useLayoutEffect(() => {
    const felt = feltRef.current;
    if (!enabled || !felt) return;
    const colliding = collidingCameraSeatIds(felt);
    if (colliding.size === 0) return;
    const victim = [...priorityOrder].reverse().find((id) => colliding.has(id) && !hidden.has(id));
    if (victim !== undefined) setFit({ key, hidden: new Set([...hidden, victim]) });
  });

  return hidden;
}

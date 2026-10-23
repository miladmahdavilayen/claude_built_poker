import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Where every seat sits on the felt, and how big — solved from the real,
 * measured sizes of the seats (cards, a camera, the dealer button, labels,
 * an action bubble) and of the board (community cards and pot), so that for
 * ANY seat count (2–9), screen, camera or font size:
 *
 *   - no two seats overlap,
 *   - no seat — and no seat's bet chips — touches the board,
 *   - every seat stays on the table and on screen,
 *
 * at the largest seat size that allows it (never bigger than designed).
 *
 * Seats go round the table's edge, evenly spaced, the viewer at the bottom.
 * The edge's shape is what adapts: from an oval (roomy, wide screens) to a
 * rounded rectangle hugging the felt's corners (a tall, narrow phone, where
 * an oval would park the side seats right next to the board), and the
 * board's height on the felt shifts a little too. Every candidate is solved
 * for its largest safe seat scale and the best one wins. Pure arithmetic on
 * measured boxes (seats scale around their own centers, so one measurement
 * is exact) — and only redone when a size actually changes.
 */

export interface SeatPlacement {
  left: number;
  top: number;
  betLeft: number;
  betTop: number;
}

export interface TableLayout {
  /** Multiplies every seat's (and bet's) designed size. */
  scale: number;
  /** Multiplies the board's size — 1 everywhere but the most cramped screens (see BOARD_SCALES). */
  boardScale: number;
  /** The board's center, as a % of the felt's height. */
  boardTop: number;
  /** Percent positions on the felt, by seat id. */
  seats: Map<number, SeatPlacement>;
  /**
   * Set only when even the smallest readable seats can't fit in the height
   * the screen gives the felt (a phone held sideways, a full table, cameras
   * collapsed into the speaker bar above it): the felt is made this tall
   * instead, and the page scrolls a little — anything but an overlap.
   */
  minFeltHeight: number | null;
  /** The window size this was solved for — a new size starts over. */
  viewport: string;
}

const GAP = 6; // between seats, and seat ↔ board
const BOARD_GAP = 8;
const MIN_SCALE = 0.3;
/** How far a seat may lean out over the felt's rail (a fraction of the rail's width). */
const RAIL_OVERHANG = 0.7;
const SHAPES = [2, 2.6, 3.4, 5, 8]; // superellipse exponents: 2 = oval … 8 ≈ rounded rectangle
const BOARD_TOPS = [0.42, 0.46, 0.5, 0.38];
/**
 * The board stays full size unless seats would otherwise end up smaller
 * than READABLE — only on the most cramped screens (a phone held sideways
 * with a full table on camera) does it step down, and it's never covered
 * either way.
 */
const BOARD_SCALES = [1, 0.85, 0.72];
const READABLE = 0.45;
/** A bet's chip stack, at scale 1, when none is on the table to measure. */
const DEFAULT_BET = { w: 44, h: 34 };

interface Extent {
  l: number;
  r: number;
  t: number;
  b: number;
}

interface Problem {
  width: number;
  height: number;
  rail: number;
  /** Ring order: the viewer's seat first (bottom), then around the table. */
  seats: Extent[];
  board: { w: number; h: number };
  bet: { w: number; h: number };
}

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

const overlap = (a: Box, b: Box, gap: number): boolean => a.l < b.r + gap && a.r > b.l - gap && a.t < b.b + gap && a.b > b.t - gap;

/** Evenly spaced points (by arc length) round a superellipse, the first at the bottom center. Coordinates relative to the felt's center. */
function ringPoints(n: number, a: number, b: number, p: number): { x: number; y: number }[] {
  const SAMPLES = 720;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const th = Math.PI / 2 + (i / SAMPLES) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    pts.push({ x: a * Math.sign(c) * Math.abs(c) ** (2 / p), y: b * Math.sign(s) * Math.abs(s) ** (2 / p) });
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = cum[cum.length - 1]!;
  const out: { x: number; y: number }[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (j < cum.length - 2 && cum[j + 1]! < target) j++;
    const span = cum[j + 1]! - cum[j]! || 1;
    const f = (target - cum[j]!) / span;
    out.push({ x: pts[j]!.x + (pts[j + 1]!.x - pts[j]!.x) * f, y: pts[j]!.y + (pts[j + 1]!.y - pts[j]!.y) * f });
  }
  return out;
}

interface Placed {
  centers: { x: number; y: number }[];
  bets: { x: number; y: number }[];
  board: Box;
}

/** Places every seat (and its bet) for a shape, board height and scale; null if anything collides. */
function place(pr: Problem, shape: number, boardTop: number, scale: number): Placed | null {
  const halfW = Math.max(...pr.seats.map((e) => Math.max(e.l, e.r))) * scale;
  const halfH = Math.max(...pr.seats.map((e) => Math.max(e.t, e.b))) * scale;
  const reach = pr.rail * RAIL_OVERHANG;
  const a = pr.width / 2 + reach - halfW;
  const b = pr.height / 2 + reach - halfH;
  if (a <= 0 || b <= 0) return null;
  const centers = ringPoints(pr.seats.length, a, b, shape);
  const boardCy = pr.height * boardTop - pr.height / 2;
  const board: Box = { l: -pr.board.w / 2, r: pr.board.w / 2, t: boardCy - pr.board.h / 2, b: boardCy + pr.board.h / 2 };
  const limit: Box = { l: -pr.width / 2 - reach, r: pr.width / 2 + reach, t: -pr.height / 2 - reach, b: pr.height / 2 + reach };
  const boxes: Box[] = centers.map((c, i) => {
    const e = pr.seats[i]!;
    return { l: c.x - e.l * scale, r: c.x + e.r * scale, t: c.y - e.t * scale, b: c.y + e.b * scale };
  });
  for (let i = 0; i < boxes.length; i++) {
    const s = boxes[i]!;
    if (s.l < limit.l || s.r > limit.r || s.t < limit.t || s.b > limit.b) return null;
    if (overlap(s, board, BOARD_GAP)) return null;
    for (let j = i + 1; j < boxes.length; j++) if (overlap(s, boxes[j]!, GAP)) return null;
  }
  // Each seat's bet chips sit just in front of it, toward the board — and
  // must keep clear of the board and of every seat.
  const bw = (pr.bet.w * scale) / 2;
  const bh = (pr.bet.h * scale) / 2;
  const bets = centers.map((c, i) => {
    const s = boxes[i]!;
    const dx = 0 - c.x;
    const dy = boardCy - c.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // Distance from the seat's center to its edge along the ray, then a little gap and half a chip stack.
    const toEdgeX = ux === 0 ? Infinity : ux > 0 ? (s.r - c.x) / ux : (s.l - c.x) / ux;
    const toEdgeY = uy === 0 ? Infinity : uy > 0 ? (s.b - c.y) / uy : (s.t - c.y) / uy;
    const d = Math.min(toEdgeX, toEdgeY) + 4 + Math.hypot(bw * ux, bh * uy);
    return { x: c.x + ux * d, y: c.y + uy * d };
  });
  for (let i = 0; i < bets.length; i++) {
    const bet = bets[i]!;
    const box: Box = { l: bet.x - bw, r: bet.x + bw, t: bet.y - bh, b: bet.y + bh };
    if (overlap(box, board, 2)) return null;
    for (let j = 0; j < boxes.length; j++) if (j !== i && overlap(box, boxes[j]!, 0)) return null;
  }
  return { centers, bets, board };
}

type Solution = { scale: number; shape: number; boardTop: number; placed: Placed };

/** The best layout, shrinking the board a step at a time only while seats would otherwise drop below READABLE. */
function solve(pr: Problem): (Solution & { boardScale: number }) | null {
  let best: (Solution & { boardScale: number }) | null = null;
  for (const boardScale of BOARD_SCALES) {
    const s = solveAt({ ...pr, board: { w: pr.board.w * boardScale, h: pr.board.h * boardScale } });
    if (s && (!best || s.scale > best.scale + 0.05)) best = { ...s, boardScale };
    if (best && best.scale >= READABLE) break;
  }
  return best;
}

function solveAt(pr: Problem): Solution | null {
  let best: Solution | null = null;
  for (const shape of SHAPES) {
    for (const boardTop of BOARD_TOPS) {
      const full = place(pr, shape, boardTop, 1);
      if (full) {
        // Ties go to the earlier (rounder, board-higher) candidate — the classic look.
        if (!best || best.scale < 1) best = { scale: 1, shape, boardTop, placed: full };
        continue;
      }
      let lo = MIN_SCALE;
      let hi = 1;
      let found: Placed | null = null;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        const p = place(pr, shape, boardTop, mid);
        if (p) {
          lo = mid;
          found = p;
        } else hi = mid;
      }
      if (found && (!best || lo > best.scale + 0.01)) best = { scale: lo, shape, boardTop, placed: found };
    }
    if (best?.scale === 1) break;
  }
  return best;
}

function measureExtent(slot: HTMLElement, scale: number): Extent | null {
  const seat = slot.querySelector<HTMLElement>(':scope > .seat');
  if (!seat) return null;
  const s = slot.getBoundingClientRect();
  const cx = s.left + s.width / 2;
  const cy = s.top + s.height / 2;
  const rects = [seat, ...seat.querySelectorAll<HTMLElement>('*')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;
  return {
    l: (cx - Math.min(...rects.map((r) => r.left))) / scale,
    r: (Math.max(...rects.map((r) => r.right)) - cx) / scale,
    t: (cy - Math.min(...rects.map((r) => r.top))) / scale,
    b: (Math.max(...rects.map((r) => r.bottom)) - cy) / scale,
  };
}

const round = (v: number): number => Math.round(v * 2) / 2;

function sameLayout(a: TableLayout, b: TableLayout): boolean {
  if (
    Math.abs(a.scale - b.scale) > 0.005 ||
    a.boardScale !== b.boardScale ||
    a.boardTop !== b.boardTop ||
    a.minFeltHeight !== b.minFeltHeight ||
    a.viewport !== b.viewport ||
    a.seats.size !== b.seats.size
  )
    return false;
  for (const [id, p] of b.seats) {
    const q = a.seats.get(id);
    if (!q || Math.abs(q.left - p.left) > 0.15 || Math.abs(q.top - p.top) > 0.15 || Math.abs(q.betLeft - p.betLeft) > 0.15 || Math.abs(q.betTop - p.betTop) > 0.15) return false;
  }
  return true;
}

/**
 * `ringSeatIds` is the visible seats in ring order, the viewer's own (or the
 * lowest, for a spectator) first. Returns null until the first measurement.
 */
export function useTableLayout(feltRef: RefObject<HTMLElement | null>, ringSeatIds: readonly number[]): TableLayout | null {
  const [layout, setLayout] = useState<TableLayout | null>(null);
  const lastKey = useRef('');
  useLayoutEffect(() => {
    const felt = feltRef.current;
    if (!felt || ringSeatIds.length === 0) return;
    const scale = layout?.scale ?? 1;
    const boardScale = layout?.boardScale ?? 1;
    const extents: Extent[] = [];
    for (const id of ringSeatIds) {
      const slot = felt.querySelector<HTMLElement>(`.seat-slot[data-testid="seat-${String(id)}"]`);
      const e = slot ? measureExtent(slot, scale) : null;
      if (!e) return;
      extents.push(e);
    }
    const boardEl = felt.querySelector<HTMLElement>('.board-area');
    const betEl = felt.querySelector<HTMLElement>('.bet-chips-slot');
    const boardRect = boardEl?.getBoundingClientRect();
    const betRect = betEl?.getBoundingClientRect();
    const rail = parseFloat(getComputedStyle(felt).borderLeftWidth) || 0;
    const pr: Problem = {
      width: felt.clientWidth,
      height: felt.clientHeight,
      rail,
      seats: extents,
      // Measured at full size: the board is drawn at `boardScale` right now.
      board: { w: (boardRect?.width ?? 0) / boardScale, h: (boardRect?.height ?? 0) / boardScale },
      bet: betRect && betRect.width > 0 ? { w: Math.max(DEFAULT_BET.w, betRect.width / scale), h: Math.max(DEFAULT_BET.h, betRect.height / scale) } : DEFAULT_BET,
    };
    const key = JSON.stringify([pr.width, pr.height, pr.rail, ringSeatIds, extents.map((e) => [round(e.l), round(e.r), round(e.t), round(e.b)]), round(pr.board.w), round(pr.board.h), round(pr.bet.w), round(pr.bet.h)]);
    if (key === lastKey.current) return;
    lastKey.current = key;
    // A felt we stretched earlier keeps that height until the window itself changes.
    const viewport = `${String(window.innerWidth)}x${String(window.innerHeight)}`;
    const stretched = layout && layout.viewport === viewport ? layout.minFeltHeight : null;
    let best = solve(pr);
    let minFeltHeight = stretched;
    if (!best) {
      // Nothing fits in this height: find the smallest height where something does.
      let height = pr.height;
      for (let extra = 20; extra <= 600 && !best; extra += 20) {
        height = pr.height + extra;
        best = solve({ ...pr, height });
      }
      if (!best) return;
      pr.height = height;
      minFeltHeight = height + 2 * pr.rail; // the felt is border-box: its rails count toward min-height
    }
    const seats = new Map<number, SeatPlacement>();
    ringSeatIds.forEach((id, i) => {
      const c = best.placed.centers[i]!;
      const bet = best.placed.bets[i]!;
      seats.set(id, {
        left: ((c.x + pr.width / 2) / pr.width) * 100,
        top: ((c.y + pr.height / 2) / pr.height) * 100,
        betLeft: ((bet.x + pr.width / 2) / pr.width) * 100,
        betTop: ((bet.y + pr.height / 2) / pr.height) * 100,
      });
    });
    const next: TableLayout = {
      scale: Math.floor(best.scale * 100) / 100,
      boardScale: best.boardScale,
      boardTop: best.boardTop * 100,
      seats,
      minFeltHeight,
      viewport,
    };
    // Re-measuring at the new size can shift a box by a rounding pixel — that alone mustn't trigger another render.
    if (layout && sameLayout(layout, next)) return;
    setLayout(next);
  });
  return layout;
}

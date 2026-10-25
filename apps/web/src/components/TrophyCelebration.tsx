import { useLayoutEffect, useRef, useState } from 'react';
import { runCelebrationParticles } from '../celebrationParticles.js';
import { formatChips } from '../chips.js';
import { WIN_TIER_NAMES, type WinTier } from '../winTiers.js';

/** How long each tier's show runs, straight (1) to royal flush (6). */
export const TROPHY_CELEBRATION_MS: Record<Exclude<WinTier, 0>, number> = { 1: 3200, 2: 3600, 3: 4000, 4: 4600, 5: 5200, 6: 6200 };

/**
 * The viewer's own win with a straight or better (see WinCelebration.tsx):
 * a trophy drops in over the felt with a light sweep across it, then each
 * better hand adds a layer — a gem and a shockwave ring (flush), turning
 * light rays and corner confetti cannons (full house), a second ring, a
 * flash and a second confetti wave (quads), fireworks and a purple glow
 * (straight flush), and rainbow rays, a crown and gold-coin rain (royal
 * flush). The trophy's base carries one star per tier.
 *
 * It frames the community cards rather than covering them, and keeps off
 * the players' seats too (their showdown cards are what the winner wants
 * to see): measured from the felt at mount, the trophy stands in the gap
 * above the board and the hand's name in the gap below it — or, when
 * there's no clear room for that, wherever on the felt is clear and
 * nearest the board (see placeCelebration). The rays, glow, rings and flash are a backdrop
 * layer UNDER the cards.
 *
 * Kept light: everything in the DOM animates only transform and opacity
 * (both run on the compositor, off the main thread), and every particle
 * is drawn on one self-stopping canvas (celebrationParticles.ts). With
 * prefers-reduced-motion the particles are skipped and the rest only
 * fades (see styles.css).
 */
export function TrophyCelebration({ tier, amount }: { tier: Exclude<WinTier, 0>; amount: number }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const banner = bannerRef.current;
    if (!root || !banner) return;
    const placement = placeCelebration(root, banner, tier);
    setPlace(placement);
    // The win lands with the showdown, when revealed cards resize the seats
    // and the table lays itself out again a moment later: look again over
    // the first second, and glide to the new clear spot if anything moved.
    const timers = [150, 450, 900].map((ms) =>
      setTimeout(() => {
        const next = placeCelebration(root, banner, tier);
        setPlace((prev) => (prev && samePlace(prev, next) ? prev : next));
      }, ms),
    );
    const canvas = canvasRef.current;
    const stopParticles =
      canvas && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? runCelebrationParticles(canvas, tier, placement.originX, placement.originY) : null;
    return () => {
      timers.forEach(clearTimeout);
      stopParticles?.();
    };
  }, [tier]);

  const name = WIN_TIER_NAMES[tier];
  const vars = {
    '--celebration-ms': `${String(TROPHY_CELEBRATION_MS[tier])}ms`,
    ...(place
      ? {
          '--trophy-size': `${String(place.size)}px`,
          '--stage-x': `${String(place.stageX)}px`,
          '--stage-y': `${String(place.stageY)}px`,
          '--banner-x': `${String(place.bannerX)}px`,
          '--banner-y': `${String(place.bannerY)}px`,
        }
      : {}),
  } as React.CSSProperties;
  return (
    <>
      <div className={`trophy-celebration trophy-backdrop trophy-tier-${String(tier)}`} style={vars} aria-hidden="true">
        {tier >= 4 && <div className="trophy-flash" />}
        <div className="trophy-stage">
          {tier >= 3 && <div className="trophy-rays" />}
          {tier >= 2 && <div className="trophy-ring" />}
          {tier >= 4 && <div className="trophy-ring trophy-ring--late" />}
          <div className="trophy-glow" />
        </div>
      </div>
      <div
        ref={rootRef}
        className={`trophy-celebration trophy-tier-${String(tier)}${place ? '' : ' trophy-celebration--measuring'}`}
        data-testid="trophy-celebration"
        data-tier={tier}
        style={vars}
      >
        <canvas ref={canvasRef} className="trophy-particles" aria-hidden="true" />
        <div className="trophy-stage">
          <TrophyIcon tier={tier} />
          {[0, 1, 2, 3, 4, 5].slice(0, 2 + tier).map((i) => (
            <span key={i} className={`trophy-twinkle trophy-twinkle-${String(i)}`} />
          ))}
        </div>
        <div ref={bannerRef} className="viewer-win-banner viewer-win-banner--trophy">
          <div className="trophy-hand-name" aria-label={name}>
            {[...name].map((ch, i) => (
              <span key={i} style={{ '--i': i } as React.CSSProperties}>
                {ch === ' ' ? '\u00a0' : ch}
              </span>
            ))}
          </div>
          <div className="viewer-win-text">You Win!</div>
          <div className="viewer-win-amount">+{formatChips(amount)}</div>
        </div>
      </div>
    </>
  );
}

interface Placement {
  /** Trophy width in px; its height is 7/6 of that. */
  size: number;
  /** The trophy's top-left, and the banner's top-center, in px from the felt's top-left. */
  stageX: number;
  stageY: number;
  bannerX: number;
  bannerY: number;
  /** The trophy's middle as fractions of the felt's width and height — where the confetti bursts from. */
  originX: number;
  originY: number;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const samePlace = (a: Placement, b: Placement): boolean =>
  a.size === b.size && Math.abs(a.stageX - b.stageX) < 3 && Math.abs(a.stageY - b.stageY) < 3 && Math.abs(a.bannerX - b.bannerX) < 3 && Math.abs(a.bannerY - b.bannerY) < 3;

const TIER_SCALE: Record<Exclude<WinTier, 0>, number> = { 1: 1, 2: 1.04, 3: 1.1, 4: 1.16, 5: 1.22, 6: 1.3 };
const GAP = 8;
const MIN_SIZE = 44;
const ASPECT = 7 / 6;

/**
 * Where the trophy and its banner go, keeping both clear of the board and
 * every occupied seat and bet. Three arrangements, each at the biggest
 * trophy size that fits somewhere clear:
 * - framing: trophy centered just above the board, banner just below it;
 * - stacked: trophy over banner, anywhere on the felt;
 * - row: trophy beside banner, anywhere on the felt.
 * Framing wins unless the others fit a clearly bigger trophy; among clear
 * spots, the one nearest the board is used. Nothing clear at all: framing
 * at the smallest size, overlapping what it must. One search per win —
 * a few thousand rectangle checks, well under a frame.
 */
function placeCelebration(root: HTMLElement, banner: HTMLElement, tier: Exclude<WinTier, 0>): Placement {
  const box = root.getBoundingClientRect();
  const W = box.width;
  const H = box.height;
  const rel = (r: DOMRect): Box => ({ left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top });
  const felt = root.parentElement;
  const boardEl = felt?.querySelector('.board-area');
  const board = boardEl ? rel(boardEl.getBoundingClientRect()) : { left: W * 0.3, right: W * 0.7, top: H * 0.32, bottom: H * 0.5 };
  const obstacles = [board, ...[...(felt?.querySelectorAll('.seat:not(.seat-empty), .bet-chips-slot > *') ?? [])].map((el) => rel(el.getBoundingClientRect()))].filter(
    (o) => o.right > o.left && o.bottom > o.top,
  );
  const clear = (r: Box): boolean =>
    r.left >= 6 && r.top >= 6 && r.right <= W - 6 && r.bottom <= H - 6 && obstacles.every((o) => r.right + 4 <= o.left || r.left - 4 >= o.right || r.bottom + 4 <= o.top || r.top - 4 >= o.bottom);
  const bw = banner.offsetWidth;
  const bh = banner.offsetHeight;
  const wanted = Math.min(120, Math.max(72, Math.min(window.innerWidth, window.innerHeight) * 0.19)) * TIER_SCALE[tier];
  const bx = (board.left + board.right) / 2;
  const by = (board.top + board.bottom) / 2;

  type Layout = Omit<Placement, 'originX' | 'originY'>;
  const framing = (size: number): Layout => ({ size, stageX: bx - size / 2, stageY: board.top - GAP - size * ASPECT, bannerX: bx, bannerY: board.bottom + GAP });
  /** Trophy over banner, or beside it, with the pair's top-left at (x, y). */
  const stacked = (size: number, x: number, y: number): Layout => {
    const w = Math.max(size, bw);
    return { size, stageX: x + (w - size) / 2, stageY: y, bannerX: x + w / 2, bannerY: y + size * ASPECT + 2 };
  };
  const row = (size: number, x: number, y: number): Layout => {
    const h = Math.max(size * ASPECT, bh);
    return { size, stageX: x, stageY: y + (h - size * ASPECT) / 2, bannerX: x + size + 10 + bw / 2, bannerY: y + (h - bh) / 2 };
  };
  // The trophy's drop-in overshoots to 1.12x around its middle: keep that clear too.
  const fits = (l: Layout): boolean =>
    clear({ left: l.stageX - l.size * 0.06, top: l.stageY - l.size * 0.07, right: l.stageX + l.size * 1.06, bottom: l.stageY + l.size * (ASPECT + 0.07) }) &&
    clear({ left: l.bannerX - bw / 2, top: l.bannerY, right: l.bannerX + bw / 2, bottom: l.bannerY + bh });
  const sizes: number[] = [];
  for (let s = wanted; s >= MIN_SIZE; s -= 6) sizes.push(s);

  let frame: Layout | null = null;
  for (const s of sizes) {
    if (fits(framing(s))) {
      frame = framing(s);
      break;
    }
  }
  let free: Layout | null = null;
  for (const s of sizes) {
    if (frame && s < frame.size / 0.85) break;
    let best: { l: Layout; d: number } | null = null;
    for (const make of [stacked, row]) {
      for (let y = 6; y < H; y += 12) {
        for (let x = 6; x < W; x += 12) {
          const l = make(s, x, y);
          if (!fits(l)) continue;
          const d = Math.hypot(l.stageX + s / 2 - bx, l.stageY + (s * ASPECT) / 2 - by);
          if (!best || d < best.d) best = { l, d };
        }
      }
    }
    if (best) {
      free = best.l;
      break;
    }
  }
  const chosen = free ?? frame ?? framing(MIN_SIZE);
  const size = Math.round(chosen.size);
  return {
    ...chosen,
    size,
    stageY: Math.max(4, chosen.stageY),
    originX: (chosen.stageX + size / 2) / Math.max(1, W),
    originY: (Math.max(4, chosen.stageY) + (size * ASPECT) / 2) / Math.max(1, H),
  };
}

const GEM_COLORS: Record<Exclude<WinTier, 0>, string> = { 1: '#3fd0ff', 2: '#4f8bff', 3: '#ff5d6c', 4: '#3fdc8a', 5: '#a07bff', 6: '#ff4d6d' };

function TrophyIcon({ tier }: { tier: Exclude<WinTier, 0> }): React.JSX.Element {
  const id = `trophy-${String(tier)}`;
  const stars = Math.min(tier, 5);
  return (
    <svg className="trophy-icon" viewBox="0 0 120 140" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-gold`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#a8700f" />
          <stop offset="0.35" stopColor="#ffe08a" />
          <stop offset="0.55" stopColor="#f2bd4d" />
          <stop offset="1" stopColor="#9a650c" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <path d="M28 18h64v20c0 22-12 38-32 42-20-4-32-20-32-42z" />
          <rect x="52" y="78" width="16" height="22" />
          <rect x="34" y="100" width="52" height="12" rx="3" />
          <rect x="26" y="112" width="68" height="16" rx="4" />
        </clipPath>
      </defs>
      {tier === 6 && (
        <path className="trophy-crown" d="M38 14l6-12 9 9 7-11 7 11 9-9 6 12z" fill="#ffd86b" stroke="#a8700f" strokeWidth="1.5" />
      )}
      {/* Handles */}
      <path d="M28 26H14c0 18 8 26 20 28" fill="none" stroke={`url(#${id}-gold)`} strokeWidth="6" strokeLinecap="round" />
      <path d="M92 26h14c0 18-8 26-20 28" fill="none" stroke={`url(#${id}-gold)`} strokeWidth="6" strokeLinecap="round" />
      <g fill={`url(#${id}-gold)`}>
        <path d="M28 18h64v20c0 22-12 38-32 42-20-4-32-20-32-42z" />
        <rect x="52" y="78" width="16" height="22" />
        <rect x="34" y="100" width="52" height="12" rx="3" />
        <rect x="26" y="112" width="68" height="16" rx="4" />
      </g>
      <ellipse cx="60" cy="19" rx="32" ry="4" fill="#7a4e08" opacity="0.55" />
      {tier >= 2 && <circle className="trophy-gem" cx="60" cy="44" r="8" fill={GEM_COLORS[tier]} stroke="#fff3c4" strokeWidth="2" />}
      {Array.from({ length: stars }, (_, i) => (
        <path
          key={i}
          d="M0-4.5l1.3 2.7 3 .4-2.2 2.1.5 3L0 2.3-2.6 3.7l.5-3-2.2-2.1 3-.4z"
          transform={`translate(${String(60 + (i - (stars - 1) / 2) * 12)} 120)`}
          fill="#fff3c4"
        />
      ))}
      <g clipPath={`url(#${id}-clip)`}>
        <rect className="trophy-shine" x="-40" y="0" width="34" height="140" fill={`url(#${id}-shine)`} />
      </g>
    </svg>
  );
}

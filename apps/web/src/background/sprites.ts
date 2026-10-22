/**
 * Everything the background scenes draw, rendered ONCE into small
 * off-screen canvases ("sprites"). Each frame then only stamps these with
 * drawImage — cheap on any device — instead of re-drawing paths and text.
 * Works on the main thread and inside a Web Worker (OffscreenCanvas).
 */

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function makeCanvas(width: number, height: number): { canvas: AnyCanvas; ctx: Ctx } {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d')! };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d')! };
}

/** A small, fast, seeded generator — the scenes only need to look random, and to look the same each visit. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export type Suit = 'spades' | 'hearts' | 'diamonds' | 'clubs';
export const SUITS: readonly Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
const RED = '#c4232f';
const INK = '#16181f';
export const suitColor = (suit: Suit): string => (suit === 'hearts' || suit === 'diamonds' ? RED : INK);

/** Suits as vector paths (no font needed — fonts aren't guaranteed inside a worker), centred on (cx, cy), `s` tall. */
export function suitPath(ctx: Ctx, suit: Suit, cx: number, cy: number, s: number): void {
  ctx.beginPath();
  if (suit === 'diamonds') {
    ctx.moveTo(cx, cy - s / 2);
    ctx.quadraticCurveTo(cx + s * 0.14, cy - s * 0.14, cx + s * 0.4, cy);
    ctx.quadraticCurveTo(cx + s * 0.14, cy + s * 0.14, cx, cy + s / 2);
    ctx.quadraticCurveTo(cx - s * 0.14, cy + s * 0.14, cx - s * 0.4, cy);
    ctx.quadraticCurveTo(cx - s * 0.14, cy - s * 0.14, cx, cy - s / 2);
  } else if (suit === 'hearts') {
    ctx.moveTo(cx, cy + s * 0.46);
    ctx.bezierCurveTo(cx - s * 0.62, cy + s * 0.02, cx - s * 0.48, cy - s * 0.52, cx, cy - s * 0.2);
    ctx.bezierCurveTo(cx + s * 0.48, cy - s * 0.52, cx + s * 0.62, cy + s * 0.02, cx, cy + s * 0.46);
  } else if (suit === 'spades') {
    ctx.moveTo(cx, cy - s * 0.5);
    ctx.bezierCurveTo(cx - s * 0.62, cy - s * 0.04, cx - s * 0.5, cy + s * 0.42, cx - s * 0.02, cy + s * 0.14);
    ctx.lineTo(cx + s * 0.02, cy + s * 0.14);
    ctx.bezierCurveTo(cx + s * 0.5, cy + s * 0.42, cx + s * 0.62, cy - s * 0.04, cx, cy - s * 0.5);
    ctx.moveTo(cx, cy + s * 0.04);
    ctx.lineTo(cx + s * 0.16, cy + s * 0.5);
    ctx.lineTo(cx - s * 0.16, cy + s * 0.5);
  } else {
    const r = s * 0.21;
    ctx.arc(cx, cy - s * 0.2, r, 0, Math.PI * 2);
    ctx.moveTo(cx - s * 0.2 + r, cy + s * 0.08);
    ctx.arc(cx - s * 0.2, cy + s * 0.08, r, 0, Math.PI * 2);
    ctx.moveTo(cx + s * 0.2 + r, cy + s * 0.08);
    ctx.arc(cx + s * 0.2, cy + s * 0.08, r, 0, Math.PI * 2);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + s * 0.15, cy + s * 0.5);
    ctx.lineTo(cx - s * 0.15, cy + s * 0.5);
  }
  ctx.closePath();
}

export const CARD_W = 84;
export const CARD_H = 118;
const CARD_R = 7;

/** A playing card's face at `scale` device pixels per CSS pixel. Ranks A, K, Q, J, 10 (the royal flush) are what the deal uses. */
export function cardFace(rank: string, suit: Suit, scale: number): AnyCanvas {
  const { canvas, ctx } = makeCanvas(CARD_W * scale, CARD_H * scale);
  ctx.scale(scale, scale);
  const paper = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  paper.addColorStop(0, '#fffdf8');
  paper.addColorStop(1, '#e9e3d4');
  roundRectPath(ctx, 0.5, 0.5, CARD_W - 1, CARD_H - 1, CARD_R);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const color = suitColor(suit);
  const corner = (flip: boolean): void => {
    ctx.save();
    if (flip) {
      ctx.translate(CARD_W, CARD_H);
      ctx.rotate(Math.PI);
    }
    ctx.fillStyle = color;
    ctx.font = `700 ${rank === '10' ? 14 : 16}px Georgia, 'Times New Roman', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(rank, 11, 6);
    suitPath(ctx, suit, 11, 30, 10);
    ctx.fill();
    ctx.restore();
  };
  corner(false);
  corner(true);

  ctx.fillStyle = color;
  if (rank === 'A') {
    suitPath(ctx, suit, CARD_W / 2, CARD_H / 2, 40);
    ctx.fill();
  } else if (rank === '10') {
    const xs = [CARD_W * 0.33, CARD_W * 0.67];
    const ys = [0.25, 0.42, 0.58, 0.75];
    for (const x of xs) for (const y of ys) {
      suitPath(ctx, suit, x, CARD_H * y, 13);
      ctx.fill();
    }
    for (const y of [0.335, 0.665]) {
      suitPath(ctx, suit, CARD_W / 2, CARD_H * y, 13);
      ctx.fill();
    }
  } else {
    // Court card: a gold-framed panel with the rank and its suit.
    const fx = 18;
    const fy = 20;
    const fw = CARD_W - fx * 2;
    const fh = CARD_H - fy * 2;
    const tint = ctx.createLinearGradient(fx, fy, fx + fw, fy + fh);
    tint.addColorStop(0, suit === 'hearts' || suit === 'diamonds' ? 'rgba(196,35,47,0.10)' : 'rgba(30,40,80,0.10)');
    tint.addColorStop(1, 'rgba(201,162,39,0.16)');
    roundRectPath(ctx, fx, fy, fw, fh, 4);
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.strokeStyle = '#c9a227';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `700 34px Georgia, 'Times New Roman', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rank, CARD_W / 2, CARD_H / 2 + 2);
    suitPath(ctx, suit, CARD_W / 2, fy + 12, 11);
    ctx.fill();
    suitPath(ctx, suit, CARD_W / 2, fy + fh - 12, 11);
    ctx.fill();
  }
  return canvas;
}

/** The back every card is dealt with: deep red, a fine lattice, a gold-ringed spade medallion. */
export function cardBack(scale: number): AnyCanvas {
  const { canvas, ctx } = makeCanvas(CARD_W * scale, CARD_H * scale);
  ctx.scale(scale, scale);
  const base = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  base.addColorStop(0, '#8e1424');
  base.addColorStop(1, '#5b0b17');
  roundRectPath(ctx, 0.5, 0.5, CARD_W - 1, CARD_H - 1, CARD_R);
  ctx.fillStyle = '#f7f3ea';
  ctx.fill();
  roundRectPath(ctx, 5, 5, CARD_W - 10, CARD_H - 10, 4);
  ctx.fillStyle = base;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,220,180,0.16)';
  ctx.lineWidth = 1;
  for (let d = -CARD_H; d < CARD_W + CARD_H; d += 7) {
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d - CARD_H, CARD_H);
    ctx.moveTo(d - CARD_H, 0);
    ctx.lineTo(d, CARD_H);
    ctx.stroke();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(CARD_W / 2, CARD_H / 2, 17, 0, Math.PI * 2);
  ctx.fillStyle = '#5b0b17';
  ctx.fill();
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#d4af37';
  suitPath(ctx, 'spades', CARD_W / 2, CARD_H / 2, 18);
  ctx.fill();
  return canvas;
}

/** A card's soft shadow, blurred once here (shadowBlur) rather than every frame. */
export function cardShadow(scale: number): { canvas: AnyCanvas; pad: number } {
  const pad = 22;
  const { canvas, ctx } = makeCanvas((CARD_W + pad * 2) * scale, (CARD_H + pad * 2) * scale);
  ctx.scale(scale, scale);
  // Draw the shape far off-canvas and let only its offset shadow land in view.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 14 * scale;
  ctx.shadowOffsetX = 10_000 * scale;
  roundRectPath(ctx, pad - 10_000, pad, CARD_W, CARD_H, CARD_R);
  ctx.fillStyle = '#000';
  ctx.fill();
  return { canvas, pad };
}

/** A soft round glow in one colour (`rgb` as "r,g,b") — gold dust, casino-light bokeh. Drawn additively. */
export function glow(rgb: string, size: number, scale: number): AnyCanvas {
  const px = size * scale;
  const { canvas, ctx } = makeCanvas(px, px);
  const g = ctx.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(0.3, `rgba(${rgb},0.45)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  return canvas;
}

export interface ChipStyle {
  base: string;
  edge: string;
  label: string;
}

/** A casino chip seen face-on: six edge inserts, an inlay ring, a sheen, and its value. */
export function chipFace(chip: ChipStyle, size: number, scale: number): AnyCanvas {
  const px = size * scale;
  const { canvas, ctx } = makeCanvas(px, px);
  ctx.scale(scale, scale);
  const r = size / 2;
  const c = r;
  ctx.beginPath();
  ctx.arc(c, c, r - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = chip.base;
  ctx.fill();
  ctx.fillStyle = chip.edge;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(c, c, r - 0.5, a, a + 0.42);
    ctx.arc(c, c, r * 0.74, a + 0.42, a, true);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(c, c, r * 0.6, 0, Math.PI * 2);
  ctx.strokeStyle = chip.edge;
  ctx.lineWidth = Math.max(1, size * 0.035);
  ctx.setLineDash([size * 0.06, size * 0.045]);
  ctx.stroke();
  ctx.setLineDash([]);
  const sheen = ctx.createRadialGradient(c - r * 0.35, c - r * 0.4, 0, c, c, r);
  sheen.addColorStop(0, 'rgba(255,255,255,0.32)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.beginPath();
  ctx.arc(c, c, r - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.fillStyle = chip.edge;
  ctx.font = `800 ${String(Math.round(size * (chip.label.length > 3 ? 0.17 : 0.22)))}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(chip.label, c, c + 1);
  return canvas;
}

/** A darker shade of a #rrggbb colour — a chip's side. */
export function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number => Math.round(((n >> v) & 255) * factor);
  return `rgb(${String(ch(16))},${String(ch(8))},${String(ch(0))})`;
}

/** A tile of fine grain, laid over the felt so it reads as cloth rather than a flat gradient. */
export function grainTile(rand: () => number): AnyCanvas {
  const { canvas, ctx } = makeCanvas(96, 96);
  for (let i = 0; i < 900; i++) {
    const v = rand() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${String(v)},${String(v)},${String(v)},${String(0.025 + rand() * 0.04)})`;
    ctx.fillRect(Math.floor(rand() * 96), Math.floor(rand() * 96), 1, 1);
  }
  return canvas;
}

/** An art-deco casino-carpet tile: a diamond lattice with small rosettes. */
export function carpetTile(): AnyCanvas {
  const s = 72;
  const { canvas, ctx } = makeCanvas(s, s);
  ctx.strokeStyle = 'rgba(212,175,55,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(s / 2, 0);
  ctx.lineTo(s, s / 2);
  ctx.lineTo(s / 2, s);
  ctx.lineTo(0, s / 2);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s / 2, s * 0.18);
  ctx.lineTo(s * 0.82, s / 2);
  ctx.lineTo(s / 2, s * 0.82);
  ctx.lineTo(s * 0.18, s / 2);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(160,110,220,0.06)';
  ctx.stroke();
  ctx.fillStyle = 'rgba(212,175,55,0.09)';
  for (const [x, y] of [
    [s / 2, s / 2],
    [0, 0],
    [s, 0],
    [0, s],
    [s, s],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

import {
  CARD_H,
  CARD_W,
  SUITS,
  carpetTile,
  cardBack,
  cardFace,
  cardShadow,
  chipFace,
  glow,
  grainTile,
  makeCanvas,
  seeded,
  shade,
  type AnyCanvas,
  type ChipStyle,
  type Ctx,
  type Suit,
} from './sprites.js';

/**
 * The two page backgrounds, drawn on a canvas — in a Web Worker when the
 * browser supports OffscreenCanvas, else on the main thread (see
 * loop.ts / AnimatedBackground.tsx). A scene owns its state; `step`
 * advances it by `dt` seconds and `draw` renders the current frame.
 * Positions are kept as fractions of the viewport, so a resize just
 * re-scales them. `quality` (0–1) thins out the particle counts when the
 * device is struggling.
 */
export interface Scene {
  resize(width: number, height: number, dpr: number): void;
  step(dt: number): void;
  draw(): void;
  setPointer(x: number, y: number): void;
  setQuality(quality: number): void;
}

export type SceneKind = 'landing' | 'lobby';

export interface SceneOptions {
  /** Fewer, simpler things on a phone or a low-power device. */
  lite: boolean;
}

export function createScene(kind: SceneKind, ctx: Ctx, options: SceneOptions): Scene {
  return kind === 'landing' ? new DealScene(ctx, options) : new CasinoFloorScene(ctx, options);
}

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const easeOutQuart = (t: number): number => 1 - (1 - t) ** 4;
const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Shared plumbing: canvas size, the half-resolution backdrop, a cached vignette, pointer parallax. */
abstract class BaseScene implements Scene {
  protected width = 1;
  protected height = 1;
  protected dpr = 1;
  protected time = 0;
  protected quality = 1;
  /** Pointer position, -0.5…0.5 from the centre, eased toward the target. */
  protected px = 0;
  protected py = 0;
  private tx = 0;
  private ty = 0;
  private backdrop: AnyCanvas | null = null;
  private vignette: CanvasGradient | null = null;

  constructor(
    protected readonly ctx: Ctx,
    protected readonly options: SceneOptions,
  ) {}

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    // The backdrop is all soft gradients and texture: half resolution is
    // indistinguishable once scaled up, at a quarter of the memory.
    const { canvas, ctx } = makeCanvas(width / 2, height / 2);
    ctx.scale(0.5, 0.5);
    this.paintBackdrop(ctx, width, height);
    this.backdrop = canvas;
    const v = this.ctx.createRadialGradient(width / 2, height * 0.46, Math.min(width, height) * 0.3, width / 2, height / 2, Math.hypot(width, height) * 0.62);
    v.addColorStop(0, 'rgba(4,6,10,0)');
    v.addColorStop(1, 'rgba(4,6,10,0.82)');
    this.vignette = v;
    this.onResize();
  }

  setPointer(x: number, y: number): void {
    this.tx = x - 0.5;
    this.ty = y - 0.5;
  }

  setQuality(quality: number): void {
    this.quality = quality;
  }

  step(dt: number): void {
    this.time += dt;
    const k = Math.min(1, dt * 2.5);
    this.px += (this.tx - this.px) * k;
    this.py += (this.ty - this.py) * k;
    this.advance(dt);
  }

  draw(): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0, this.width, this.height);
    this.render(ctx);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (this.vignette) {
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  /** How many of `base` items to show at the current quality. */
  protected count(base: number): number {
    return Math.max(1, Math.round(base * this.quality));
  }

  protected abstract paintBackdrop(ctx: Ctx, width: number, height: number): void;
  protected abstract onResize(): void;
  protected abstract advance(dt: number): void;
  protected abstract render(ctx: Ctx): void;
}

// --------------------------------------------------------------------------
// Landing — "the deal"
// --------------------------------------------------------------------------

const ROYAL_RANKS = ['A', 'K', 'Q', 'J', '10'];

interface DealtCard {
  face: AnyCanvas;
  startAt: number;
  flight: number;
  rest: number;
  fromX: number;
  fromY: number;
  ctrlX: number;
  ctrlY: number;
  toX: number;
  toY: number;
  spins: number;
  restAngle: number;
  size: number;
}

interface Dust {
  x: number;
  y: number;
  z: number;
  phase: number;
  speed: number;
}

class DealScene extends BaseScene {
  private readonly rand = seeded(20251022);
  private faces = new Map<string, AnyCanvas>();
  private back: AnyCanvas | null = null;
  private shadow: { canvas: AnyCanvas; pad: number } | null = null;
  private dustSprite: AnyCanvas | null = null;
  private readonly cards: DealtCard[] = [];
  private readonly dust: Dust[] = [];
  private nextDealAt = 0.4;

  protected paintBackdrop(ctx: Ctx, w: number, h: number): void {
    const felt = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.5, Math.hypot(w, h) * 0.6);
    felt.addColorStop(0, '#13704a');
    felt.addColorStop(0.45, '#0c4a31');
    felt.addColorStop(1, '#05150f');
    ctx.fillStyle = felt;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ctx.createPattern(grainTile(seeded(7)), 'repeat')!;
    ctx.fillRect(0, 0, w, h);
    // The betting line printed on the felt — a faint oval, with a second, finer one inside.
    for (const [rx, ry, a] of [
      [0.44, 0.38, 0.07],
      [0.41, 0.35, 0.035],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w * rx, h * ry, 0, 0, TAU);
      ctx.strokeStyle = `rgba(255,236,190,${String(a)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  protected onResize(): void {
    const scale = this.dpr;
    // Sprites depend only on the pixel density — build them once.
    if (!this.back) {
      this.back = cardBack(scale);
      this.shadow = cardShadow(scale);
      this.dustSprite = glow('255,214,140', 24, scale);
      for (const suit of SUITS) for (const rank of ROYAL_RANKS) this.faces.set(rank + suit, cardFace(rank, suit, scale));
    }
    const lite = this.options.lite;
    if (this.cards.length === 0) {
      for (let i = 0; i < (lite ? 6 : 10); i++) this.cards.push(this.dealCard(i * 0.85));
      for (let i = 0; i < (lite ? 22 : 48); i++) {
        this.dust.push({ x: this.rand(), y: this.rand(), z: 0.25 + this.rand() * 0.75, phase: this.rand() * TAU, speed: 0.008 + this.rand() * 0.014 });
      }
    }
  }

  /** A fresh card, dealt from the top of the table to somewhere around its edge. */
  private dealCard(delay: number): DealtCard {
    const r = this.rand;
    const suit: Suit = SUITS[Math.floor(r() * 4)]!;
    const rank = ROYAL_RANKS[Math.floor(r() * ROYAL_RANKS.length)]!;
    const [toX, toY] = this.landingSpot();
    const fromX = 0.5 + (r() - 0.5) * 0.1;
    const fromY = -0.18;
    const startAt = Math.max(this.time + delay, this.nextDealAt);
    this.nextDealAt = startAt + 0.55 + r() * 0.45;
    return {
      face: this.faces.get(rank + suit)!,
      startAt,
      flight: 1.05 + r() * 0.5,
      rest: 4 + r() * 4,
      fromX,
      fromY,
      ctrlX: (fromX + toX) / 2 + (r() - 0.5) * 0.3,
      ctrlY: Math.min(fromY, toY) - 0.05 + r() * 0.2,
      toX,
      toY,
      spins: (r() < 0.5 ? -1 : 1) * (0.75 + r() * 1.25),
      restAngle: (r() - 0.5) * 0.9,
      size: 0.85 + r() * 0.35,
    };
  }

  /**
   * Where the next card lands: somewhere the sign-in panel doesn't cover
   * (beside it on a wide screen; above or below it on a narrow one), and —
   * of a handful of candidates — the one farthest from the cards already
   * on the table, so they spread out instead of piling up.
   */
  private landingSpot(): [number, number] {
    const r = this.rand;
    const narrow = this.width < 700;
    const candidate = (): [number, number] => {
      if (narrow) return [0.1 + r() * 0.8, r() < 0.5 ? 0.03 + r() * 0.1 : 0.88 + r() * 0.09];
      const side = r() < 0.5 ? -1 : 1;
      return [0.5 + side * (0.22 + r() * 0.25), 0.12 + r() * 0.76];
    };
    const aspect = this.width / this.height;
    let best = candidate();
    let bestGap = -1;
    for (let i = 0; i < 8; i++) {
      const spot = candidate();
      let gap = Infinity;
      for (const c of this.cards) gap = Math.min(gap, Math.hypot((c.toX - spot[0]) * aspect, c.toY - spot[1]));
      if (gap > bestGap) {
        best = spot;
        bestGap = gap;
      }
    }
    return best;
  }

  protected advance(dt: number): void {
    const active = this.count(this.cards.length);
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i]!;
      const done = this.time - c.startAt > c.flight + c.rest + 0.9;
      if (done && i < active) this.cards[i] = this.dealCard(0);
    }
    for (const d of this.dust) {
      d.y -= d.speed * (0.4 + d.z) * dt;
      d.x += Math.sin(this.time * 0.35 + d.phase) * 0.004 * dt;
      if (d.y < -0.05) {
        d.y = 1.05;
        d.x = this.rand();
      }
    }
  }

  protected render(ctx: Ctx): void {
    const { width: w, height: h, time: t } = this;
    // Two overhead lights slowly roaming the felt.
    ctx.globalCompositeOperation = 'lighter';
    for (const [phase, rgb] of [
      [0, '255,232,180'],
      [2.4, '170,255,210'],
    ] as const) {
      const x = w * (0.5 + 0.28 * Math.sin(t * 0.06 + phase));
      const y = h * (0.4 + 0.14 * Math.cos(t * 0.045 + phase * 1.3));
      const r = Math.max(w, h) * 0.42;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},0.09)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Resting cards first, then anything still in the air on top.
    const active = this.count(this.cards.length);
    const visible = this.cards.slice(0, active);
    for (const c of visible) if (t - c.startAt >= c.flight) this.drawCard(ctx, c);
    for (const c of visible) if (t >= c.startAt && t - c.startAt < c.flight) this.drawCard(ctx, c);

    // Gold dust in the light, nearer motes larger, brighter, and moving more with the pointer.
    if (this.dustSprite) {
      ctx.globalCompositeOperation = 'lighter';
      const n = this.count(this.dust.length);
      for (let i = 0; i < n; i++) {
        const d = this.dust[i]!;
        const twinkle = 0.6 + 0.4 * Math.sin(t * 1.7 + d.phase * 3);
        const size = (5 + d.z * 13) * twinkle;
        const x = d.x * w - this.px * 40 * d.z;
        const y = d.y * h - this.py * 30 * d.z;
        ctx.globalAlpha = (0.18 + d.z * 0.4) * twinkle;
        ctx.drawImage(this.dustSprite, x - size / 2, y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private drawCard(ctx: Ctx, c: DealtCard): void {
    if (!this.back || !this.shadow) return;
    const u = this.time - c.startAt;
    const { width: w, height: h } = this;
    let x: number;
    let y: number;
    let angle: number;
    let flipCos: number;
    let lift: number;
    let alpha = 1;
    if (u < c.flight) {
      const k = u / c.flight;
      const p = easeOutCubic(k);
      const a = 1 - p;
      x = a * a * c.fromX + 2 * a * p * c.ctrlX + p * p * c.toX;
      y = a * a * c.fromY + 2 * a * p * c.ctrlY + p * p * c.toY;
      angle = c.restAngle - c.spins * TAU * (1 - easeOutQuart(k));
      // Dealt face down; turns face up as it lands.
      flipCos = Math.cos(Math.PI * (1 - smoothstep(0.42, 0.96, k)));
      lift = Math.sin(Math.PI * Math.min(1, k * 1.05));
    } else {
      x = c.toX;
      y = c.toY;
      angle = c.restAngle;
      flipCos = 1;
      lift = 0;
      const fade = u - c.flight - c.rest;
      if (fade > 0) {
        alpha = 1 - clamp01(fade / 0.9);
        y += fade * 0.01;
      }
    }
    const depth = 0.6 + c.size * 0.4;
    const cx = x * w - this.px * 24 * depth;
    const cy = y * h - this.py * 18 * depth;
    const scale = c.size * (1 + lift * 0.18);
    const sx = Math.max(0.03, Math.abs(flipCos));
    const sprite = flipCos < 0 ? this.back : c.face;
    ctx.save();
    // The higher the card, the further and softer its shadow falls.
    ctx.translate(cx + 6 + lift * 22, cy + 10 + lift * 34);
    ctx.rotate(angle);
    ctx.scale(sx * scale * (1 + lift * 0.1), scale * (1 + lift * 0.1));
    const pad = this.shadow.pad;
    ctx.globalAlpha = alpha * (0.5 - lift * 0.22);
    ctx.drawImage(this.shadow.canvas, -CARD_W / 2 - pad, -CARD_H / 2 - pad, CARD_W + pad * 2, CARD_H + pad * 2);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha * 0.66;
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(sx * scale, scale);
    ctx.drawImage(sprite, -CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H);
    ctx.restore();
  }
}

// --------------------------------------------------------------------------
// Lobby — "the casino floor"
// --------------------------------------------------------------------------

// The table's own chip colours (see chips.ts), $1 through $1,000.
const CHIPS: readonly ChipStyle[] = [
  { base: '#f5f5f0', edge: '#1d4ed8', label: '1' },
  { base: '#dc2626', edge: '#f5f5f0', label: '5' },
  { base: '#2563eb', edge: '#f5f5f0', label: '10' },
  { base: '#15803d', edge: '#f5f5f0', label: '25' },
  { base: '#18181b', edge: '#f5f5f0', label: '100' },
  { base: '#7e22ce', edge: '#f5f5f0', label: '500' },
  { base: '#f59e0b', edge: '#1a1a1a', label: '1000' },
];
const CHIP_SPRITE = 72;
const LIGHT_COLORS = ['255,200,90', '190,120,255', '255,90,90', '90,200,255', '255,240,200'];

interface FallingChip {
  x: number;
  y: number;
  z: number;
  style: number;
  tilt: number;
  tiltSpeed: number;
  spin: number;
  spinSpeed: number;
  phase: number;
}

interface Bokeh {
  x: number;
  y: number;
  z: number;
  color: number;
  phase: number;
}

class CasinoFloorScene extends BaseScene {
  private readonly rand = seeded(777);
  private chipSprites: AnyCanvas[] = [];
  private chipSides: string[] = [];
  private lightSprites: AnyCanvas[] = [];
  private readonly chips: FallingChip[] = [];
  private readonly lights: Bokeh[] = [];

  protected paintBackdrop(ctx: Ctx, w: number, h: number): void {
    const floor = ctx.createLinearGradient(0, 0, 0, h);
    floor.addColorStop(0, '#1d1834');
    floor.addColorStop(0.55, '#100f1c');
    floor.addColorStop(1, '#08090f');
    ctx.fillStyle = floor;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ctx.createPattern(carpetTile(), 'repeat')!;
    ctx.fillRect(0, 0, w, h);
    const glowTop = ctx.createRadialGradient(w / 2, -h * 0.1, 0, w / 2, -h * 0.1, h * 0.9);
    glowTop.addColorStop(0, 'rgba(255,190,90,0.16)');
    glowTop.addColorStop(1, 'rgba(255,190,90,0)');
    ctx.fillStyle = glowTop;
    ctx.fillRect(0, 0, w, h);
  }

  protected onResize(): void {
    const scale = this.dpr;
    if (this.chipSprites.length === 0) {
      this.chipSprites = CHIPS.map((c) => chipFace(c, CHIP_SPRITE, scale));
      this.chipSides = CHIPS.map((c) => shade(c.base, 0.55));
      this.lightSprites = LIGHT_COLORS.map((rgb) => glow(rgb, 128, Math.min(scale, 1)));
    }
    const lite = this.options.lite;
    if (this.chips.length === 0) {
      const r = this.rand;
      for (let i = 0; i < (lite ? 12 : 24); i++) {
        this.chips.push({
          x: r(),
          y: r() * 1.2 - 0.1,
          z: 0.2 + r() * 0.8,
          style: Math.floor(r() * CHIPS.length),
          tilt: r() * TAU,
          tiltSpeed: (0.5 + r() * 1.4) * (r() < 0.5 ? -1 : 1),
          spin: r() * TAU,
          spinSpeed: (0.2 + r() * 0.8) * (r() < 0.5 ? -1 : 1),
          phase: r() * TAU,
        });
      }
      // Far chips first, so nearer ones pass in front of them.
      this.chips.sort((a, b) => a.z - b.z);
      for (let i = 0; i < (lite ? 14 : 30); i++) {
        this.lights.push({ x: r(), y: r() * 0.85, z: 0.2 + r() * 0.8, color: Math.floor(r() * LIGHT_COLORS.length), phase: r() * TAU });
      }
    }
  }

  protected advance(dt: number): void {
    for (const c of this.chips) {
      c.y += (0.035 + c.z * 0.075) * dt;
      c.tilt += c.tiltSpeed * dt;
      c.spin += c.spinSpeed * dt;
      c.x += Math.sin(this.time * 0.4 + c.phase) * 0.006 * dt;
      if (c.y > 1.12) {
        c.y = -0.12;
        c.x = this.rand();
      }
    }
    for (const l of this.lights) {
      l.x += (0.002 + l.z * 0.004) * dt;
      if (l.x > 1.1) l.x = -0.1;
    }
  }

  protected render(ctx: Ctx): void {
    const { width: w, height: h, time: t } = this;
    ctx.globalCompositeOperation = 'lighter';

    // Out-of-focus casino lights, twinkling.
    const nLights = this.count(this.lights.length);
    for (let i = 0; i < nLights; i++) {
      const l = this.lights[i]!;
      const twinkle = 0.55 + 0.45 * Math.sin(t * (0.6 + l.z) + l.phase);
      const size = 50 + l.z * 110;
      ctx.globalAlpha = (0.05 + l.z * 0.09) * twinkle;
      ctx.drawImage(this.lightSprites[l.color]!, l.x * w - this.px * 30 * l.z - size / 2, l.y * h - this.py * 20 * l.z - size / 2, size, size);
    }

    // Spotlight beams sweeping down from the ceiling.
    const beams = this.options.lite ? 2 : 3;
    for (let i = 0; i < beams; i++) {
      const ox = w * (0.18 + (0.64 * i) / Math.max(1, beams - 1));
      const angle = Math.sin(t * 0.13 + i * 2.1) * 0.32;
      const len = h * 1.25;
      const spread = 0.16;
      const tipX = ox + Math.sin(angle) * len;
      const tipY = Math.cos(angle) * len;
      const g = ctx.createLinearGradient(ox, 0, tipX, tipY);
      const rgb = LIGHT_COLORS[i % 3]!;
      g.addColorStop(0, `rgba(${rgb},0.13)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ox - 6, -10);
      ctx.lineTo(ox + Math.sin(angle - spread) * len, Math.cos(angle - spread) * len);
      ctx.lineTo(ox + Math.sin(angle + spread) * len, Math.cos(angle + spread) * len);
      ctx.lineTo(ox + 6, -10);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Chips tumbling down, nearer ones larger, brighter and faster.
    const nChips = this.count(this.chips.length);
    for (let i = 0; i < nChips; i++) {
      const c = this.chips[i]!;
      const size = 22 + c.z * 46;
      const x = c.x * w - this.px * 46 * c.z;
      const y = c.y * h - this.py * 30 * c.z;
      const cosT = Math.cos(c.tilt);
      const squash = Math.max(0.1, Math.abs(cosT));
      const thickness = size * 0.13 * Math.abs(Math.sin(c.tilt));
      ctx.save();
      ctx.globalAlpha = 0.32 + c.z * 0.55;
      ctx.translate(x, y);
      ctx.rotate(c.spin);
      // The chip's side: an elliptical band below the face, as deep as the tilt shows.
      if (thickness > 0.5) {
        ctx.fillStyle = this.chipSides[c.style]!;
        ctx.beginPath();
        ctx.ellipse(0, thickness, size / 2, (size / 2) * squash, 0, 0, Math.PI);
        ctx.lineTo(-size / 2, 0);
        ctx.ellipse(0, 0, size / 2, (size / 2) * squash, 0, Math.PI, 0, true);
        ctx.closePath();
        ctx.fill();
      }
      ctx.drawImage(this.chipSprites[c.style]!, -size / 2, -(size / 2) * squash, size, size * squash);
      ctx.restore();
    }
  }
}

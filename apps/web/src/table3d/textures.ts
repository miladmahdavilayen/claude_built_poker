import * as THREE from 'three';

// Every texture the 3D table uses, drawn on a canvas at load — no image
// files to download, nothing over 1024px, and each one shared by every
// mesh that shows it. `size` follows the quality tier (see quality.ts).

/** A fixed-seed xorshift: the felt's grain only has to look random, and the same every load. */
function seeded(seed: number): () => number {
  let s = seed | 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, srgb: boolean, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat !== 1) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  return t;
}

/** A tileable value-noise heightfield, 0–1, for the felt's weave and its normal map. */
function noiseField(size: number, rand: () => number): Float32Array {
  const out = new Float32Array(size * size);
  // A few octaves of tileable lattice noise plus fine per-texel fuzz: reads as woven baize up close.
  const octaves = [
    { cells: 8, amp: 0.35 },
    { cells: 32, amp: 0.25 },
    { cells: 128, amp: 0.25 },
  ];
  for (const { cells, amp } of octaves) {
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const cell = size / cells;
    for (let y = 0; y < size; y++) {
      const gy = y / cell;
      const y0 = Math.floor(gy) % cells;
      const y1 = (y0 + 1) % cells;
      const fy = gy - Math.floor(gy);
      const sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = x / cell;
        const x0 = Math.floor(gx) % cells;
        const x1 = (x0 + 1) % cells;
        const fx = gx - Math.floor(gx);
        const sx = fx * fx * (3 - 2 * fx);
        const a = lattice[y0 * cells + x0]!;
        const b = lattice[y0 * cells + x1]!;
        const c = lattice[y1 * cells + x0]!;
        const d = lattice[y1 * cells + x1]!;
        out[y * size + x]! += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i]! += 0.15 * rand();
  return out;
}

export interface FeltTextures {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

/** The felt: deep casino green with a woven grain, and a matching normal map so the light catches it. */
export function feltTextures(size: number): FeltTextures {
  const rand = seeded(1337);
  const n = Math.min(512, size);
  const h = noiseField(n, rand);
  const [c, ctx] = canvas(n, n);
  const img = ctx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = h[i]!;
    img.data[i * 4] = 10 + v * 16;
    img.data[i * 4 + 1] = 92 + v * 34;
    img.data[i * 4 + 2] = 52 + v * 20;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const [nc, nctx] = canvas(n, n);
  const nimg = nctx.createImageData(n, n);
  const at = (x: number, y: number): number => h[((y + n) % n) * n + ((x + n) % n)]!;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      nimg.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = (1 / len) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);
  return { map: finish(c, true, 6), normalMap: finish(nc, false, 6) };
}

/** Polished wood for the table's edge and apron: long grain lines over a warm base. */
export function woodTexture(size: number): THREE.CanvasTexture {
  const rand = seeded(42);
  const n = Math.min(512, size);
  const [c, ctx] = canvas(n, n);
  const grad = ctx.createLinearGradient(0, 0, 0, n);
  grad.addColorStop(0, '#5a2e14');
  grad.addColorStop(0.5, '#6e3a1a');
  grad.addColorStop(1, '#4e2610');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, n, n);
  for (let i = 0; i < 140; i++) {
    const y = rand() * n;
    ctx.strokeStyle = `rgba(${rand() < 0.5 ? '30,12,4' : '140,80,40'},${String(0.08 + rand() * 0.16)})`;
    ctx.lineWidth = 0.6 + rand() * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= n; x += n / 16) ctx.lineTo(x, y + Math.sin(x / (30 + rand() * 40) + i) * 3);
    ctx.stroke();
  }
  return finish(c, true, 2);
}

/** The rail's padded leather: dark, with a soft pebbled sheen. */
export function leatherTexture(size: number): THREE.CanvasTexture {
  const rand = seeded(7);
  const n = Math.min(256, size);
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = '#1b1210';
  ctx.fillRect(0, 0, n, n);
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = `rgba(255,235,210,${String(rand() * 0.05)})`;
    ctx.beginPath();
    ctx.arc(rand() * n, rand() * n, 0.6 + rand() * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  return finish(c, true, 8);
}

const RANK_LABEL: Record<string, string> = { T: '10' };
const SUIT_RED: Record<string, boolean> = { h: true, d: true };
const RED = '#c4122f';
const BLACK = '#15151a';

/**
 * A suit symbol as a vector path — the same on every device (a font's ♥
 * can come out as an emoji on a phone), centred on (x, y), `size` tall,
 * upside down when `flip`.
 */
function suitPath(ctx: CanvasRenderingContext2D, suit: string, x: number, y: number, size: number, flip = false): void {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.rotate(Math.PI);
  const u = size / 2;
  ctx.beginPath();
  switch (suit) {
    case 'h':
      ctx.moveTo(0, u * 0.95);
      ctx.bezierCurveTo(-u * 0.25, u * 0.62, -u * 1.02, u * 0.18, -u * 0.96, -u * 0.35);
      ctx.bezierCurveTo(-u * 0.9, -u * 0.95, -u * 0.18, -u * 1.02, 0, -u * 0.48);
      ctx.bezierCurveTo(u * 0.18, -u * 1.02, u * 0.9, -u * 0.95, u * 0.96, -u * 0.35);
      ctx.bezierCurveTo(u * 1.02, u * 0.18, u * 0.25, u * 0.62, 0, u * 0.95);
      break;
    case 'd':
      ctx.moveTo(0, -u);
      ctx.quadraticCurveTo(u * 0.32, -u * 0.38, u * 0.78, 0);
      ctx.quadraticCurveTo(u * 0.32, u * 0.38, 0, u);
      ctx.quadraticCurveTo(-u * 0.32, u * 0.38, -u * 0.78, 0);
      ctx.quadraticCurveTo(-u * 0.32, -u * 0.38, 0, -u);
      break;
    case 's':
      ctx.moveTo(0, -u);
      ctx.bezierCurveTo(u * 0.3, -u * 0.6, u * 1.0, -u * 0.25, u * 0.96, u * 0.22);
      ctx.bezierCurveTo(u * 0.92, u * 0.66, u * 0.38, u * 0.72, u * 0.1, u * 0.42);
      ctx.quadraticCurveTo(u * 0.16, u * 0.8, u * 0.42, u * 0.98);
      ctx.lineTo(-u * 0.42, u * 0.98);
      ctx.quadraticCurveTo(-u * 0.16, u * 0.8, -u * 0.1, u * 0.42);
      ctx.bezierCurveTo(-u * 0.38, u * 0.72, -u * 0.92, u * 0.66, -u * 0.96, u * 0.22);
      ctx.bezierCurveTo(-u * 1.0, -u * 0.25, -u * 0.3, -u * 0.6, 0, -u);
      break;
    default: {
      // Clubs: three leaves and a flared stem.
      const r = u * 0.43;
      ctx.arc(0, -u * 0.48, r, 0, Math.PI * 2);
      ctx.moveTo(-u * 0.5 + r, u * 0.06);
      ctx.arc(-u * 0.5, u * 0.06, r, 0, Math.PI * 2);
      ctx.moveTo(u * 0.5 + r, u * 0.06);
      ctx.arc(u * 0.5, u * 0.06, r, 0, Math.PI * 2);
      ctx.moveTo(-u * 0.1, 0);
      ctx.quadraticCurveTo(-u * 0.1, u * 0.75, -u * 0.45, u * 0.98);
      ctx.lineTo(u * 0.45, u * 0.98);
      ctx.quadraticCurveTo(u * 0.1, u * 0.75, u * 0.1, 0);
      ctx.closePath();
    }
  }
  ctx.fill();
  ctx.restore();
}

/** Pip positions (fractions of the card's width and height) for 2–10, the classic layouts. */
const PIPS: Record<string, readonly [number, number][]> = {
  '2': [[0.5, 0.2], [0.5, 0.8]],
  '3': [[0.5, 0.2], [0.5, 0.5], [0.5, 0.8]],
  '4': [[0.3, 0.2], [0.7, 0.2], [0.3, 0.8], [0.7, 0.8]],
  '5': [[0.3, 0.2], [0.7, 0.2], [0.5, 0.5], [0.3, 0.8], [0.7, 0.8]],
  '6': [[0.3, 0.2], [0.7, 0.2], [0.3, 0.5], [0.7, 0.5], [0.3, 0.8], [0.7, 0.8]],
  '7': [[0.3, 0.2], [0.7, 0.2], [0.5, 0.35], [0.3, 0.5], [0.7, 0.5], [0.3, 0.8], [0.7, 0.8]],
  '8': [[0.3, 0.2], [0.7, 0.2], [0.5, 0.35], [0.3, 0.5], [0.7, 0.5], [0.5, 0.65], [0.3, 0.8], [0.7, 0.8]],
  '9': [[0.3, 0.2], [0.7, 0.2], [0.3, 0.4], [0.7, 0.4], [0.5, 0.5], [0.3, 0.6], [0.7, 0.6], [0.3, 0.8], [0.7, 0.8]],
  T: [[0.3, 0.2], [0.7, 0.2], [0.5, 0.3], [0.3, 0.4], [0.7, 0.4], [0.3, 0.6], [0.7, 0.6], [0.5, 0.7], [0.3, 0.8], [0.7, 0.8]],
};

/** The card's white body: rounded corners (outside them is clear — the material cuts them away), a faint paper grain and a hairline edge. */
function cardBlank(ctx: CanvasRenderingContext2D, w: number, h: number, radius: number): void {
  ctx.clearRect(0, 0, w, h);
  roundRect(ctx, 1, 1, w - 2, h - 2, radius);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#fffefb');
  g.addColorStop(1, '#f1eee6');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,30,20,0.28)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** A card's face (e.g. "Ah", "Td"), drawn upright: the bottom edge of the texture is the card's bottom. */
export function cardFaceTexture(card: string): THREE.CanvasTexture {
  const w = 360;
  const h = 502;
  const [c, ctx] = canvas(w, h);
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const label = RANK_LABEL[rank] ?? rank;
  const color = SUIT_RED[suit] ? RED : BLACK;
  cardBlank(ctx, w, h, 26);

  // The two corner indices, top left and (upside down) bottom right, as on any deck.
  const index = (turn: number): void => {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(turn);
    const sideways = Math.abs(Math.sin(turn)) > 0.5;
    const fw = sideways ? h : w;
    const fh = sideways ? w : h;
    ctx.translate(-fw / 2, -fh / 2);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${label.length > 1 ? 74 : 86}px Georgia, "Times New Roman", serif`;
    if (label.length > 1) {
      ctx.save();
      ctx.translate(50, 80);
      ctx.scale(0.74, 1);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(label, 50, 82);
    }
    suitPath(ctx, suit, 50, 114, 40);
    ctx.restore();
  };
  for (const turn of [0, Math.PI]) index(turn);

  ctx.fillStyle = color;
  if (rank === 'A') {
    suitPath(ctx, suit, w / 2, h / 2, suit === 's' ? 170 : 130);
  } else if (PIPS[rank]) {
    // The pips, inside the corner indices; the bottom half's stand upside down, as on a real card.
    const x0 = 122;
    const x1 = w - 122;
    const y0 = 146;
    const y1 = h - 146;
    for (const [fx, fy] of PIPS[rank]) {
      suitPath(ctx, suit, x0 + (x1 - x0) * ((fx - 0.3) / 0.4), y0 + (y1 - y0) * ((fy - 0.2) / 0.6), 54, fy > 0.55);
    }
  } else {
    // Court cards: a framed panel inside the four corner indices, the letter large with a crown and suits, mirrored top and bottom.
    const px = 122;
    const py = 142;
    const pw = w - px * 2;
    const ph = h - py * 2;
    const panel = ctx.createLinearGradient(0, py, 0, py + ph);
    panel.addColorStop(0, SUIT_RED[suit] ? '#fff1ea' : '#eef1fb');
    panel.addColorStop(0.5, '#fffaf0');
    panel.addColorStop(1, SUIT_RED[suit] ? '#fff1ea' : '#eef1fb');
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#c9a14a';
    ctx.stroke();
    roundRect(ctx, px + 9, py + 9, pw - 18, ph - 18, 8);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    for (const flip of [false, true]) {
      ctx.save();
      if (flip) {
        ctx.translate(w, h);
        ctx.rotate(Math.PI);
      }
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '700 88px Georgia, "Times New Roman", serif';
      ctx.fillText(label, w / 2, h / 2 - 12);
      suitPath(ctx, suit, w / 2 - 38, h / 2 - 92, 22);
      suitPath(ctx, suit, w / 2 + 38, h / 2 - 92, 22);
      // A small crown for the king and queen, a feather-like flourish for the jack.
      ctx.strokeStyle = '#c9a14a';
      ctx.lineWidth = 4;
      ctx.beginPath();
      if (rank === 'J') {
        ctx.moveTo(w / 2 - 20, h / 2 - 92);
        ctx.quadraticCurveTo(w / 2, h / 2 - 106, w / 2 + 20, h / 2 - 92);
      } else {
        ctx.moveTo(w / 2 - 16, h / 2 - 86);
        ctx.lineTo(w / 2 - 16, h / 2 - 100);
        ctx.lineTo(w / 2 - 8, h / 2 - 92);
        ctx.lineTo(w / 2, h / 2 - 104);
        ctx.lineTo(w / 2 + 8, h / 2 - 92);
        ctx.lineTo(w / 2 + 16, h / 2 - 100);
        ctx.lineTo(w / 2 + 16, h / 2 - 86);
        ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(201,161,74,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + 12, h / 2);
    ctx.lineTo(w - px - 12, h / 2);
    ctx.stroke();
  }
  const t = finish(c, true);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Every card's back: a deep red diamond lattice inside a white border, a gold frame and an oval emblem. */
export function cardBackTexture(): THREE.CanvasTexture {
  const w = 360;
  const h = 502;
  const [c, ctx] = canvas(w, h);
  cardBlank(ctx, w, h, 26);
  ctx.save();
  roundRect(ctx, 18, 18, w - 36, h - 36, 14);
  ctx.clip();
  const bg = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, h * 0.7);
  bg.addColorStop(0, '#a3172c');
  bg.addColorStop(1, '#5e0b18');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,214,160,0.32)';
  ctx.lineWidth = 2;
  for (let i = -h; i < w + h; i += 18) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
    ctx.moveTo(i + h, 0);
    ctx.lineTo(i, h);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = '#e2bd6a';
  ctx.lineWidth = 5;
  roundRect(ctx, 28, 28, w - 56, h - 56, 10);
  ctx.stroke();
  ctx.lineWidth = 2;
  roundRect(ctx, 38, 38, w - 76, h - 76, 8);
  ctx.stroke();
  // The emblem.
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, 62, 84, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#5e0b18';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#e2bd6a';
  ctx.stroke();
  ctx.fillStyle = '#e2bd6a';
  suitPath(ctx, 's', w / 2, h / 2 - 18, 54);
  suitPath(ctx, 'h', w / 2, h / 2 + 34, 40);
  const t = finish(c, true);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * The room around the table: bars on every side, painted once as a 360°
 * panorama on the inside of a sphere — back-bars with shelves of glowing
 * bottles, bartenders behind the counters, people standing and sitting at
 * the bar with their drinks, pendant lights — then softly blurred, the way
 * a room looks out of focus behind the players while you watch the cards.
 * The blur is a cheap downscale-and-back (no per-frame cost at all).
 */
export function roomTexture(size: number): THREE.CanvasTexture {
  const w = Math.min(2048, size * 2);
  const h = w / 2;
  const [c, ctx] = canvas(w, h);
  const rand = seeded(2024);
  // Walls and ceiling: dark wood, warm at eye level.
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, '#050302');
  wall.addColorStop(0.3, '#120a07');
  wall.addColorStop(0.46, '#2b1810');
  wall.addColorStop(0.6, '#1a0e09');
  wall.addColorStop(1, '#070403');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);
  const horizon = h * 0.5;
  const bars = 6;
  const seg = w / bars;
  for (let b = 0; b < bars; b++) {
    const x0 = b * seg + seg * 0.06;
    const bw = seg * 0.88;
    // The back-bar: a lit cabinet with three shelves of bottles.
    const top = horizon - h * 0.2;
    const shelfBottom = horizon - h * 0.02;
    const glow = ctx.createLinearGradient(0, top, 0, shelfBottom);
    glow.addColorStop(0, '#4a2a14');
    glow.addColorStop(1, '#9a5a24');
    ctx.fillStyle = glow;
    ctx.fillRect(x0, top, bw, shelfBottom - top);
    const palette = ['#d8873a', '#f0c060', '#8fc05a', '#c8402c', '#efe6c8', '#6a90c8', '#a05a28', '#e0a0b0'];
    for (let row = 0; row < 3; row++) {
      const y = top + ((row + 1) * (shelfBottom - top)) / 3.2;
      ctx.fillStyle = '#2a170c';
      ctx.fillRect(x0, y, bw, h * 0.006);
      for (let x = x0 + 4; x < x0 + bw - 6; x += 6 + rand() * 7) {
        const bh = h * (0.025 + rand() * 0.02);
        ctx.fillStyle = palette[Math.floor(rand() * palette.length)]!;
        ctx.fillRect(x, y - bh, 4, bh);
        ctx.fillRect(x + 1.2, y - bh - h * 0.008, 1.6, h * 0.008);
      }
    }
    // Pendant lights over the counter.
    for (let k = 0; k < 4; k++) {
      const lx = x0 + bw * (0.15 + k * 0.23);
      const ly = horizon - h * 0.24;
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, h * 0.07);
      g.addColorStop(0, 'rgba(255,220,160,0.95)');
      g.addColorStop(0.2, 'rgba(255,180,100,0.45)');
      g.addColorStop(1, 'rgba(255,150,80,0)');
      ctx.fillStyle = g;
      ctx.fillRect(lx - h * 0.07, ly - h * 0.07, h * 0.14, h * 0.14);
    }
    // A bartender or two behind the counter.
    for (let k = 0; k < 2; k++) {
      const px = x0 + bw * (0.3 + k * 0.4 + (rand() - 0.5) * 0.1);
      silhouette(ctx, px, horizon + h * 0.02, h * 0.16, '#1a1012', false);
    }
    // The counter.
    ctx.fillStyle = '#3a1f10';
    ctx.fillRect(x0 - 6, horizon + h * 0.01, bw + 12, h * 0.07);
    ctx.fillStyle = '#6a3a1c';
    ctx.fillRect(x0 - 8, horizon + h * 0.005, bw + 16, h * 0.012);
    // People at the bar: standing and on stools, some with a glass raised.
    const n = 5 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const px = x0 + bw * ((k + 0.5) / n) + (rand() - 0.5) * 14;
      const sitting = rand() < 0.5;
      const tone = ['#120b0c', '#160f10', '#1c1214', '#0f0a0b'][k % 4]!;
      silhouette(ctx, px, horizon + h * (sitting ? 0.09 : 0.13), h * (sitting ? 0.15 : 0.2), tone, rand() < 0.6);
    }
  }
  // Floor glow.
  const floor = ctx.createLinearGradient(0, horizon + h * 0.1, 0, h);
  floor.addColorStop(0, 'rgba(60,30,18,0.6)');
  floor.addColorStop(1, 'rgba(5,3,2,1)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, horizon + h * 0.1, w, h);
  // Out of focus: down to a quarter and back up, smoothly.
  const [small, sctx] = canvas(Math.round(w / 4), Math.round(h / 4));
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(c, 0, 0, small.width, small.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(small, 0, 0, w, h);
  return finish(c, true);
}

/** A person seen from afar: head, shoulders, body — and maybe a glass held up, catching the light. */
function silhouette(ctx: CanvasRenderingContext2D, x: number, footY: number, height: number, tone: string, drink: boolean): void {
  const headR = height * 0.09;
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.arc(x, footY - height + headR, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - height * 0.13, footY - height * 0.78);
  ctx.quadraticCurveTo(x, footY - height * 0.86, x + height * 0.13, footY - height * 0.78);
  ctx.lineTo(x + height * 0.1, footY);
  ctx.lineTo(x - height * 0.1, footY);
  ctx.closePath();
  ctx.fill();
  if (drink) {
    ctx.fillStyle = 'rgba(255,200,120,0.85)';
    ctx.fillRect(x + height * 0.12, footY - height * 0.72, height * 0.035, height * 0.06);
  }
}

/**
 * A chip's edge, as a mask: white where the edge's white inserts go, black
 * for the chip's own color (each chip's instance color — see chips3d.ts,
 * whose shader mixes white in by this mask, so one texture serves every
 * denomination).
 */
export function chipEdgeMask(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 16);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 16);
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 6; i++) ctx.fillRect(i * (256 / 6) + 6, 0, 18, 16);
  return finish(c, false);
}

/** A chip's face, as a mask: a dashed ring of inserts and a pale center inlay. */
export function chipFaceMask(): THREE.CanvasTexture {
  const n = 128;
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, n, n);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 9;
  ctx.setLineDash([13, 13]);
  ctx.beginPath();
  ctx.arc(n / 2, n / 2, n / 2 - 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(n / 2, n / 2, n / 2 - 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.arc(n / 2, n / 2, n / 4.2, 0, Math.PI * 2);
  ctx.fill();
  return finish(c, false);
}

/** The dealer button's top: a "D" on a white puck with a gold ring. Drawn upright (texture bottom = toward the viewer). */
export function buttonTexture(): THREE.CanvasTexture {
  const n = 256;
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = '#f7f3e8';
  ctx.fillRect(0, 0, n, n);
  ctx.strokeStyle = '#d4a52c';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(n / 2, n / 2, n / 2 - 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#141414';
  ctx.font = 'bold 150px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('D', n / 2, n / 2 + 8);
  const t = finish(c, true);
  t.anisotropy = 8;
  return t;
}

/** A soft round blob, for cheap contact shadows under things on the Low tier (no shadow map there). */
export function blobTexture(): THREE.CanvasTexture {
  const n = 64;
  const [c, ctx] = canvas(n, n);
  const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, n, n);
  return finish(c, false);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

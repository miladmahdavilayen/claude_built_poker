import * as THREE from 'three';
import { cardBlank, cardFaceCanvas, roundRect, suitPath } from '../cardArt.js';

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

/** A felt's colour: its darkest weave (r, g, b) and how much lighter the raised threads go. */
export interface FeltColor {
  base: readonly [number, number, number];
  lift: readonly [number, number, number];
}

/** Deep casino green. */
export const CLASSIC_FELT: FeltColor = { base: [10, 92, 52], lift: [16, 34, 20] };
/** The VIP table's: rich burgundy. */
export const VIP_FELT: FeltColor = { base: [88, 12, 26], lift: [30, 10, 12] };

/** The felt: a woven grain in its colour, and a matching normal map so the light catches it. */
export function feltTextures(size: number, color: FeltColor = CLASSIC_FELT): FeltTextures {
  const rand = seeded(1337);
  const n = Math.min(512, size);
  const h = noiseField(n, rand);
  const [c, ctx] = canvas(n, n);
  const img = ctx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = h[i]!;
    img.data[i * 4] = color.base[0] + v * color.lift[0];
    img.data[i * 4 + 1] = color.base[1] + v * color.lift[1];
    img.data[i * 4 + 2] = color.base[2] + v * color.lift[2];
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

/** The VIP rail's quilted leather: black, diamond-tufted, a button at every crossing. */
export function quiltedLeatherTexture(size: number): THREE.CanvasTexture {
  const rand = seeded(11);
  const n = Math.min(256, size);
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = '#141011';
  ctx.fillRect(0, 0, n, n);
  // Each diamond's puffed middle catches the light; its seams sink into shadow.
  const cell = n / 2;
  for (let gy = -1; gy <= 2; gy++) {
    for (let gx = -1; gx <= 2; gx++) {
      const cx = gx * cell + (gy % 2 ? cell / 2 : 0);
      const cy = gy * (cell / 2);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.55);
      g.addColorStop(0, 'rgba(255,240,225,0.13)');
      g.addColorStop(1, 'rgba(255,240,225,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - cell, cy - cell, cell * 2, cell * 2);
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 2;
  for (let k = -2; k <= 4; k++) {
    ctx.beginPath();
    ctx.moveTo(k * cell, 0);
    ctx.lineTo(k * cell + n, n);
    ctx.moveTo(k * cell + n, 0);
    ctx.lineTo(k * cell, n);
    ctx.stroke();
  }
  // Brass buttons where the seams cross.
  for (let y = 0; y <= n; y += cell / 2) {
    for (let x = (y / (cell / 2)) % 2 ? cell / 2 : 0; x <= n; x += cell) {
      ctx.fillStyle = '#b08a3e';
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(255,235,210,${String(rand() * 0.04)})`;
    ctx.fillRect(rand() * n, rand() * n, 1, 1);
  }
  return finish(c, true, 3);
}

/** Dark ebony with a fine, glossy grain: the VIP table's racetrack and apron. */
export function ebonyTexture(size: number): THREE.CanvasTexture {
  const rand = seeded(99);
  const n = Math.min(512, size);
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = '#1a0f0b';
  ctx.fillRect(0, 0, n, n);
  for (let i = 0; i < 220; i++) {
    const y = rand() * n;
    ctx.strokeStyle = `rgba(${rand() < 0.6 ? '0,0,0' : '120,70,40'},${String(0.1 + rand() * 0.2)})`;
    ctx.lineWidth = 0.5 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= n; x += n / 16) ctx.lineTo(x, y + Math.sin(x / (40 + rand() * 30) + i) * 2.5);
    ctx.stroke();
  }
  return finish(c, true, 2);
}

/** Dark polished floorboards round the VIP room's rug: long planks, staggered joints, a fine grain. */
export function planksTexture(size: number): THREE.CanvasTexture {
  const rand = seeded(303);
  const n = Math.min(512, size);
  const [c, ctx] = canvas(n, n);
  const rows = 8;
  const ph = n / rows;
  for (let r = 0; r < rows; r++) {
    // Each row's planks, the joints staggered from the row before.
    let x = -rand() * n * 0.5;
    while (x < n) {
      const len = n * (0.35 + rand() * 0.4);
      const tone = 26 + rand() * 18;
      ctx.fillStyle = `rgb(${String(tone + 14)},${String(tone * 0.62)},${String(tone * 0.42)})`;
      ctx.fillRect(x, r * ph, len, ph);
      for (let k = 0; k < 7; k++) {
        const y = r * ph + rand() * ph;
        ctx.strokeStyle = `rgba(0,0,0,${String(0.12 + rand() * 0.15)})`;
        ctx.lineWidth = 0.6 + rand();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + len * 0.3, y + (rand() - 0.5) * 4, x + len * 0.6, y + (rand() - 0.5) * 4, x + len, y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x, r * ph, 1.5, ph);
      x += len;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, r * ph, n, 1.5);
  }
  return finish(c, true, 7);
}

/**
 * The VIP room's rug: a photograph of a real one — a 16th-century Persian
 * carpet (red field, golden medallion, green border; public domain, see
 * public/textures/CREDITS.md) — and its size in table units, long side
 * along X: under the table, the house dealer and the velvet rope.
 */
export const RUG = { width: 15, depth: 10.31, image: '/textures/vip-rug.jpg', smallImage: '/textures/vip-rug-small.jpg' } as const;

/** Slot machine screens, four to a texture (a 2×2 grid): reels of bright symbols under a glowing title bar. */
export function slotScreensTexture(): THREE.CanvasTexture {
  const n = 256;
  const [c, ctx] = canvas(n, n);
  const rand = seeded(777);
  const themes = [
    ['#2a0a4a', '#ff3ea5'],
    ['#06284a', '#3ec8ff'],
    ['#3a1a02', '#ffb52e'],
    ['#0a3a1a', '#5cff8a'],
  ] as const;
  const symbols = ['7', '★', '♦', 'BAR', '♣', '$'];
  themes.forEach(([bg, hi], k) => {
    const x0 = (k % 2) * (n / 2);
    const y0 = Math.floor(k / 2) * (n / 2);
    const w = n / 2;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + w);
    g.addColorStop(0, hi);
    g.addColorStop(0.25, bg);
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, w, w);
    ctx.fillStyle = '#f4ecd8';
    for (let r = 0; r < 3; r++) ctx.fillRect(x0 + 8 + r * 38, y0 + 46, 34, 64);
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < 3; r++) {
      const sym = symbols[Math.floor(rand() * symbols.length)]!;
      ctx.fillStyle = sym === '7' || sym === '♦' ? '#d4142e' : '#16161c';
      ctx.font = sym === 'BAR' ? 'bold 13px sans-serif' : 'bold 26px sans-serif';
      ctx.fillText(sym, x0 + 25 + r * 38, y0 + 78);
    }
    ctx.fillStyle = hi;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(['JACKPOT', 'MEGA WIN', 'GOLD 7s', 'LUCKY'][k]!, x0 + w / 2, y0 + 20);
  });
  return finish(c, true);
}

/** A card's face (e.g. "Ah", "Td"), drawn upright: the bottom edge of the texture is the card's bottom. */
export function cardFaceTexture(card: string): THREE.CanvasTexture {
  const t = finish(cardFaceCanvas(card), true);
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

/**
 * The VIP room's far walls, wrapped round the scene like roomTexture: dark
 * panelling between gold pilasters, glowing banks of slot machines, neon
 * signs over the floor and chandeliers overhead — softly out of focus.
 */
export function vipRoomTexture(size: number): THREE.CanvasTexture {
  const w = Math.min(2048, size * 2);
  const h = w / 2;
  const [c, ctx] = canvas(w, h);
  const rand = seeded(4242);
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, '#07040a');
  wall.addColorStop(0.28, '#170c14');
  wall.addColorStop(0.47, '#2e1820');
  wall.addColorStop(0.62, '#1a0c10');
  wall.addColorStop(1, '#060304');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);
  const horizon = h * 0.5;
  const bays = 8;
  const seg = w / bays;
  const neon = ['#ff3ea5', '#3ec8ff', '#ffb52e', '#5cff8a', '#c77dff'];
  const signs = ['HIGH LIMIT', 'POKER', 'SLOTS', 'VIP LOUNGE', 'BACCARAT', 'JACKPOT', 'ROULETTE', 'CASINO'];
  for (let b = 0; b < bays; b++) {
    const x0 = b * seg;
    // A gold pilaster between bays.
    const pil = ctx.createLinearGradient(x0, 0, x0 + seg * 0.05, 0);
    pil.addColorStop(0, '#5a3c14');
    pil.addColorStop(0.5, '#d8aa50');
    pil.addColorStop(1, '#5a3c14');
    ctx.fillStyle = pil;
    ctx.fillRect(x0, h * 0.2, seg * 0.05, h * 0.42);
    // A chandelier's glow up near the ceiling.
    const cx = x0 + seg * 0.52;
    const cy = h * 0.27;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.09);
    g.addColorStop(0, 'rgba(255,240,205,0.95)');
    g.addColorStop(0.25, 'rgba(255,205,130,0.45)');
    g.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - h * 0.09, cy - h * 0.09, h * 0.18, h * 0.18);
    // A neon sign over the floor.
    const col = neon[b % neon.length]!;
    ctx.save();
    ctx.font = `bold ${String(Math.round(h * 0.035))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = col;
    ctx.shadowBlur = h * 0.02;
    ctx.fillStyle = col;
    ctx.fillText(signs[b]!, cx, horizon - h * 0.12);
    ctx.restore();
    // A bank of slot machines: cabinets with glowing screens and a light on top.
    const machines = 6;
    const mw = (seg * 0.86) / machines;
    for (let m = 0; m < machines; m++) {
      const mx = x0 + seg * 0.09 + m * mw;
      const top = horizon - h * 0.05;
      ctx.fillStyle = '#120a0e';
      ctx.fillRect(mx, top, mw * 0.86, h * 0.13);
      ctx.fillStyle = neon[Math.floor(rand() * neon.length)]!;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(mx + mw * 0.1, top + h * 0.015, mw * 0.66, h * 0.045);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffe6a8';
      ctx.fillRect(mx + mw * 0.3, top - h * 0.012, mw * 0.26, h * 0.012);
    }
    // Players at the machines.
    for (let k = 0; k < 3; k++) {
      const px = x0 + seg * (0.2 + k * 0.3 + (rand() - 0.5) * 0.08);
      silhouette(ctx, px, horizon + h * 0.12, h * 0.15, ['#120b0c', '#160f12', '#0f0a0b'][k]!, rand() < 0.4);
    }
  }
  // The floor: the carpet's red, fading into the dark.
  const floor = ctx.createLinearGradient(0, horizon + h * 0.08, 0, h);
  floor.addColorStop(0, 'rgba(90,20,26,0.65)');
  floor.addColorStop(1, 'rgba(6,3,4,1)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, horizon + h * 0.08, w, h);
  const [small, sctx] = canvas(Math.round(w / 3), Math.round(h / 3));
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


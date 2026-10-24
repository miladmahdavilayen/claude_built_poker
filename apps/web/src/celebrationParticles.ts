import type { WinTier } from './winTiers.js';

// The trophy celebration's confetti, fireworks and coin rain (see
// components/TrophyCelebration.tsx), drawn on ONE canvas with plain
// fillRect/arc calls: no DOM node per particle, no shadowBlur or filters
// (the costly canvas features), a hard particle budget per tier, a lower
// budget on small or low-core devices, and the animation loop stops itself
// the moment the last particle is gone. A royal flush peaks at a few
// hundred particles, which draws in well under a millisecond a frame.
//
// Randomness: decorative only, so a tiny xorshift seeded once from Web
// Crypto — Math.random() is banned repo-wide (see sound.ts's own note).

type Kind = 'confetti' | 'spark' | 'coin';

interface Particle {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived, and seconds to live. */
  age: number;
  life: number;
  size: number;
  color: string;
  rot: number;
  spin: number;
  /** Phase of the 3D "flip" — confetti and coins narrow and widen as they turn. */
  flip: number;
  flipSpeed: number;
  gravity: number;
  drag: number;
}

const GOLD = ['#f2bd4d', '#ffd86b', '#fff1b8', '#e0a730', '#ffffff'];
const TIER_ACCENTS: Record<Exclude<WinTier, 0>, string[]> = {
  1: ['#3fd0ff'],
  2: ['#4f8bff', '#7fc4ff'],
  3: ['#ff5d6c', '#ff9f43'],
  4: ['#3fdc8a', '#ff5d6c', '#4f8bff'],
  5: ['#a07bff', '#d36bff', '#4f8bff'],
  6: ['#ff4d6d', '#ffa53f', '#ffe14d', '#4ddc7a', '#4fb8ff', '#9b6bff'],
};

function rng(): () => number {
  const seed = new Uint32Array(1);
  crypto.getRandomValues(seed);
  let s = seed[0]! | 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

/** Starts the show for `tier` on `canvas`, bursting from (originX, originY) as fractions of its size; returns a stop function. */
export function runCelebrationParticles(canvas: HTMLCanvasElement, tier: Exclude<WinTier, 0>, originX = 0.5, originY = 0.4): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => undefined;
  const rand = rng();
  const between = (a: number, b: number): number => a + rand() * (b - a);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const small = Math.min(w, h) < 500;
  // Retina sharpness costs fill rate quadratically; 1.5x is plenty for confetti.
  const dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const cores = navigator.hardwareConcurrency || 4;
  const budget = (small ? 0.65 : 1) * (cores <= 4 ? 0.7 : 1);
  const scale = Math.min(1.4, Math.max(0.6, Math.min(w, h) / 560));
  const palette = [...GOLD, ...TIER_ACCENTS[tier]];
  const n = (count: number): number => Math.max(4, Math.round(count * budget));

  const particles: Particle[] = [];
  const add = (p: Partial<Particle> & Pick<Particle, 'x' | 'y' | 'vx' | 'vy' | 'kind'>): void => {
    particles.push({
      age: 0,
      life: between(2.2, 3.4),
      size: between(6, 11) * scale,
      color: pick(palette),
      rot: between(0, Math.PI * 2),
      spin: between(-8, 8),
      flip: between(0, Math.PI * 2),
      flipSpeed: between(6, 14),
      gravity: 520 * scale,
      drag: 1.6,
      ...p,
    });
  };

  /** A cone of confetti — `angle` in degrees, 0 = right, -90 = straight up. */
  const cannon = (x: number, y: number, angle: number, spread: number, count: number, speed: number): void => {
    for (let i = 0; i < n(count); i++) {
      const a = ((angle + between(-spread / 2, spread / 2)) * Math.PI) / 180;
      const v = between(0.45, 1) * speed * scale;
      add({ kind: 'confetti', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v });
    }
  };
  /** A round firework: sparks fly out evenly, hang, and fall away. */
  const firework = (x: number, y: number, count: number): void => {
    const color = pick(TIER_ACCENTS[tier]);
    const c = n(count);
    for (let i = 0; i < c; i++) {
      const a = (i / c) * Math.PI * 2 + between(-0.08, 0.08);
      const v = between(0.75, 1) * 260 * scale;
      add({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: between(1.1, 1.6),
        size: between(2, 3.2) * scale,
        color: rand() < 0.3 ? '#fff6d8' : color,
        gravity: 140 * scale,
        drag: 2.4,
      });
    }
  };
  const coin = (): void =>
    add({
      kind: 'coin',
      x: between(0.05, 0.95) * w,
      y: -20,
      vx: between(-30, 30),
      vy: between(80, 200) * scale,
      life: 3.2,
      size: between(9, 13) * scale,
      color: pick(['#f2bd4d', '#ffd86b', '#e0a730']),
      gravity: 380 * scale,
      drag: 0.9,
      flipSpeed: between(5, 9),
    });

  // From the trophy (see TrophyCelebration.tsx's placeAroundBoard).
  const cx = w * originX;
  const cy = h * originY;
  const timeline: { at: number; run: () => void }[] = [];
  const at = (sec: number, run: () => void): void => {
    timeline.push({ at: sec, run });
  };

  const burstCount = [0, 45, 65, 80, 90, 100, 120][tier] ?? 60;
  at(0.18, () => cannon(cx, cy, -90, 150, burstCount, 820));
  if (tier >= 3) {
    at(0.5, () => cannon(0, h * 0.85, -60, 30, 22 + tier * 4, 980));
    at(0.5, () => cannon(w, h * 0.85, -120, 30, 22 + tier * 4, 980));
  }
  if (tier >= 4) at(1.25, () => cannon(cx, cy, -90, 200, 50, 700));
  if (tier >= 5) {
    const shots = tier === 6 ? 6 : 3;
    for (let i = 0; i < shots; i++) {
      at(0.7 + i * 0.45, () => firework(between(0.15, 0.85) * w, between(0.12, 0.45) * h, 36));
    }
  }
  if (tier === 6) {
    for (let i = 0; i < n(70); i++) at(0.4 + (i / n(70)) * 2.6, coin);
  }
  timeline.sort((a, b) => a.at - b.at);

  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  let next = 0;
  const frame = (now: number): void => {
    // Clamp the step so a backgrounded tab doesn't teleport everything on return.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;
    while (next < timeline.length && timeline[next]!.at <= elapsed) timeline[next++]!.run();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      alive++;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.gravity * dt;
      // Confetti flutters side to side as it falls.
      if (p.kind === 'confetti') p.vx += Math.sin(p.flip) * 30 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.flip += p.flipSpeed * dt;
      const fade = Math.min(1, (p.life - p.age) / (p.life * 0.3));
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      if (p.kind === 'spark') {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        // A short streak behind it reads as a trail without drawing one.
        ctx.globalAlpha = fade * 0.45;
        ctx.fillRect(p.x - p.vx * 0.035 - p.size / 2, p.y - p.vy * 0.035 - p.size / 2, p.size, p.size);
        continue;
      }
      const cos = Math.cos(p.rot);
      const sin = Math.sin(p.rot);
      const squash = Math.cos(p.flip);
      ctx.setTransform(cos * dpr, sin * dpr, -sin * squash * dpr, cos * squash * dpr, p.x * dpr, p.y * dpr);
      if (p.kind === 'coin') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(122, 78, 8, 0.55)';
        ctx.fillRect(-p.size * 0.12, -p.size * 0.28, p.size * 0.24, p.size * 0.56);
      } else {
        ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
      }
    }
    ctx.globalAlpha = 1;
    if (alive > 0 || next < timeline.length) raf = requestAnimationFrame(frame);
    else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

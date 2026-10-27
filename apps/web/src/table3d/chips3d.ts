import * as THREE from 'three';
import { CHIP_DENOMINATIONS } from '../chips.js';
import { chipEdgeMask, chipFaceMask } from './textures.js';

// Every chip on the table — bets, the pot, piles on their way to a winner,
// the house dealer's tray — is one instance of ONE InstancedMesh: a single
// draw call (plus one for the tray) whatever the amounts. Each chip's color
// is its instance color; the white edge inserts and face ring come from
// two shared mask textures mixed in by a small shader patch, so one
// material serves every denomination.

export const CHIP_RADIUS = 0.085;
export const CHIP_HEIGHT = 0.026;
const COLUMN_MAX = 10;

/**
 * The house dealer's rack, in its own space (its middle at the felt): a
 * floor, seven channels of chips on edge (smaller than table chips' full
 * size would need, the way a real rack holds them tight), walls and the
 * ridges between channels. scene.ts builds the wood around these numbers.
 */
export const TRAY = {
  chipScale: 0.86,
  channels: 7,
  channelPitch: 0.155,
  /** The channels' length, inside the walls. */
  innerDepth: 0.25,
  /** The floor's top, and how far each chip sits down into its curved channel. */
  floor: 0.022,
  sink: 0.012,
  wallHeight: 0.085,
  ridgeHeight: 0.06,
} as const;

/** One move: to `to` over [start, start + dur] (performance.now() ms), lifted `arc` at the middle. */
interface Leg {
  to: THREE.Vector3;
  start: number;
  dur: number;
  arc: number;
  /** Removed once this leg lands (a pile sent off to its winner melts into their stack). */
  die: boolean;
}

interface Chip {
  color: THREE.Color;
  pos: THREE.Vector3;
  rotY: number;
  /** The leg in progress, and where it started. */
  leg: Leg | null;
  from: THREE.Vector3;
  /** Legs still to come, in order. */
  legs: Leg[];
  alive: boolean;
}

interface Stack {
  x: number;
  z: number;
  amount: number;
  chips: Chip[];
}

/** How a stack of `amount` breaks into chips, highest denomination first — capped, so a huge pot is a big pile, not thousands of chips. */
export function chipPlan(amount: number, maxChips: number): string[] {
  const out: string[] = [];
  let remaining = amount;
  for (const d of CHIP_DENOMINATIONS) {
    if (remaining < d.value) continue;
    const n = Math.floor(remaining / d.value);
    remaining -= n * d.value;
    for (let i = 0; i < n && out.length < maxChips; i++) out.push(d.base);
    if (out.length >= maxChips) break;
  }
  if (out.length === 0 && amount > 0) out.push(CHIP_DENOMINATIONS[CHIP_DENOMINATIONS.length - 1]!.base);
  return out;
}

/** Column offsets around a stack's center: one column per denomination, like a dealer stacks them. */
function columnOffset(i: number): [number, number] {
  if (i === 0) return [0, 0];
  const ring = i <= 6 ? 1 : 2;
  const k = ring === 1 ? i - 1 : i - 7;
  const per = ring === 1 ? 6 : 12;
  const a = (k / per) * Math.PI * 2 + (ring === 2 ? 0.26 : 0);
  const r = CHIP_RADIUS * 2.15 * ring;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** Lays a plan out in columns: same-colored chips together, at most COLUMN_MAX high. */
function layout(plan: readonly string[]): { color: string; dx: number; dz: number; level: number }[] {
  const out: { color: string; dx: number; dz: number; level: number }[] = [];
  let column = -1;
  let level = COLUMN_MAX;
  let prev = '';
  for (const color of plan) {
    if (color !== prev || level >= COLUMN_MAX) {
      column++;
      level = 0;
      prev = color;
    }
    const [dx, dz] = columnOffset(column);
    out.push({ color, dx, dz, level });
    level++;
  }
  return out;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function patchMask(material: THREE.MeshStandardMaterial): void {
  // The map is a mask, not a color: white mixes the chip's color toward white (the inserts).
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', 'float chipMask = texture2D( map, vMapUv ).r;')
      .replace(
        '#include <color_fragment>',
        `#if defined( USE_COLOR )
  diffuseColor.rgb *= vColor;
#endif
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.93 ), chipMask );`,
      );
  };
}

export class Chips3d {
  readonly mesh: THREE.InstancedMesh;
  readonly tray: THREE.InstancedMesh;
  private readonly chips: Chip[] = [];
  private readonly stacks = new Map<string, Stack>();
  private readonly disposables: { dispose: () => void }[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly capacity: number;
  private seed = 0x2545f491;
  reduceMotion = false;

  constructor(capacity: number, castShadows: boolean) {
    this.capacity = capacity;
    const geo = new THREE.CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 32, 1);
    const edge = chipEdgeMask();
    const face = chipFaceMask();
    const sideMat = new THREE.MeshStandardMaterial({ map: edge, roughness: 0.38, metalness: 0.04 });
    const capMat = new THREE.MeshStandardMaterial({ map: face, roughness: 0.32, metalness: 0.04 });
    patchMask(sideMat);
    patchMask(capMat);
    this.disposables.push(geo, edge, face, sideMat, capMat);
    this.mesh = new THREE.InstancedMesh(geo, [sideMat, capMat, capMat], capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = castShadows;
    this.mesh.receiveShadow = castShadows;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    // Sets up the instance-color buffer.
    this.mesh.setColorAt(0, new THREE.Color());
    this.tray = this.buildTray(geo, sideMat, capMat);
  }

  private rand(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 0xffffffff;
  }

  /**
   * The chips in the house dealer's rack (see TRAY): one channel per
   * denomination, chips lying on their edges in a row — each turned its own
   * way so the edge spots never line up, packed a hair unevenly, channels
   * not all equally full, and the last chip of each leaning back against the
   * row. Static — set once.
   */
  private buildTray(geo: THREE.CylinderGeometry, sideMat: THREE.Material, capMat: THREE.Material): THREE.InstancedMesh {
    const colors = ['#18181b', '#15803d', '#2563eb', '#dc2626', '#f5f5f0', '#7e22ce', '#f59e0b'];
    const counts = [9, 10, 8, 10, 9, 10, 8];
    const total = counts.reduce((n, c) => n + c, 0);
    const tray = new THREE.InstancedMesh(geo, [sideMat, capMat, capMat], total);
    const r = CHIP_RADIUS * TRAY.chipScale;
    const pitch = CHIP_HEIGHT * TRAY.chipScale * 1.04;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const spin = new THREE.Quaternion();
    const lean = new THREE.Quaternion();
    const onEdge = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const scale = new THREE.Vector3().setScalar(TRAY.chipScale);
    let i = 0;
    colors.forEach((color, c) => {
      const x = (c - (colors.length - 1) / 2) * TRAY.channelPitch;
      // Each row starts against the channel's back wall (the dealer's side).
      const back = TRAY.innerDepth / 2 - pitch / 2;
      for (let k = 0; k < counts[c]!; k++) {
        const last = k === counts[c]! - 1;
        const z = back - k * pitch - (last ? pitch * 0.6 : 0) + (this.rand() - 0.5) * 0.002;
        // Turned about its own axis; the last one tipped back against the row.
        spin.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rand() * Math.PI * 2);
        lean.setFromAxisAngle(new THREE.Vector3(1, 0, 0), last ? 0.42 : (this.rand() - 0.5) * 0.05);
        q.copy(lean).multiply(onEdge).multiply(spin);
        m.compose(new THREE.Vector3(x + (this.rand() - 0.5) * 0.004, TRAY.floor + r - TRAY.sink - (last ? r * 0.06 : 0), z), q, scale);
        tray.setMatrixAt(i, m);
        tray.setColorAt(i, new THREE.Color(color));
        i++;
      }
    });
    tray.receiveShadow = true;
    return tray;
  }

  /** Shows `amount` as a stack at (x, z) under `key` — new chips drop in, removed ones go. */
  setStack(key: string, x: number, z: number, amount: number, maxChips = 24): void {
    const existing = this.stacks.get(key);
    if (existing && existing.amount === amount && existing.x === x && existing.z === z) return;
    const now = performance.now();
    const plan = layout(chipPlan(amount, maxChips));
    const old = existing?.chips ?? [];
    const reuse = new Map<string, Chip[]>();
    for (const c of old) {
      const k = `#${c.color.getHexString()}`;
      const list = reuse.get(k) ?? [];
      list.push(c);
      reuse.set(k, list);
    }
    const chips: Chip[] = [];
    for (const p of plan) {
      const target = new THREE.Vector3(x + p.dx, CHIP_HEIGHT * (p.level + 0.5), z + p.dz);
      const color = new THREE.Color(p.color);
      const list = reuse.get(`#${color.getHexString()}`);
      const c = list?.shift();
      if (c) {
        this.moveTo(c, target, now, 180, 0, false);
        chips.push(c);
      } else {
        // New chips drop onto the stack from a little above it.
        const born = this.newChip(color, target.clone().add(new THREE.Vector3(0, 0.32, 0)));
        this.moveTo(born, target, now + chips.length * 12, 220, 0, false);
        chips.push(born);
      }
    }
    for (const list of reuse.values()) for (const c of list) c.alive = false;
    if (amount <= 0) {
      this.stacks.delete(key);
    } else {
      this.stacks.set(key, { x, z, amount, chips });
    }
    this.compact();
  }

  hasStack(key: string): boolean {
    return this.stacks.has(key);
  }

  /** Every stack key there is now. */
  stackKeys(): string[] {
    return [...this.stacks.keys()];
  }

  /** Slides a whole stack to (x, z) and lets it melt away there — a bet swept into the pot. */
  sendStack(key: string, x: number, z: number, delayMs = 0, durMs = 380): void {
    const stack = this.stacks.get(key);
    if (!stack) return;
    this.stacks.delete(key);
    this.fly(stack.chips, stack.x, stack.z, x, z, delayMs, durMs, true);
  }

  /**
   * Splits a stack into one pile per award (sized by its share), spreads
   * the piles apart for `pileMs`, then slides each to its spot, `staggerMs`
   * apart. The piles melt into the winners' stacks on landing.
   */
  splitStack(key: string, piles: readonly { amount: number; x: number; z: number }[], pileMs: number, slideMs: number, staggerMs: number): void {
    const stack = this.stacks.get(key);
    const total = piles.reduce((a, p) => a + p.amount, 0);
    if (!stack || total <= 0) {
      this.stacks.delete(key);
      return;
    }
    this.stacks.delete(key);
    for (const c of stack.chips) c.alive = false;
    const now = performance.now();
    const n = piles.length;
    piles.forEach((p, i) => {
      // Equal-looking piles fanned out side by side across the pot's spot, toward each one's winner.
      const dirX = p.x - stack.x;
      const dirZ = p.z - stack.z;
      const len = Math.hypot(dirX, dirZ) || 1;
      const spread = n > 1 ? 0.26 : 0;
      const px = stack.x + (dirX / len) * spread;
      const pz = stack.z + (dirZ / len) * spread;
      const plan = layout(chipPlan(p.amount, n > 1 ? 10 : 24));
      for (const [k, q] of plan.entries()) {
        const y = CHIP_HEIGHT * (q.level + 0.5);
        const chip = this.newChip(new THREE.Color(q.color), new THREE.Vector3(stack.x + q.dx * 0.6, y, stack.z + q.dz * 0.6));
        // First the pot divides into its piles, then each pile slides off to its winner.
        this.moveTo(chip, new THREE.Vector3(px + q.dx, y, pz + q.dz), now, pileMs * 0.8, 0, false);
        this.moveTo(chip, new THREE.Vector3(p.x + q.dx * 0.7, y, p.z + q.dz * 0.7), now + pileMs + i * staggerMs + k * 6, slideMs, 0.18, true);
      }
    });
    this.compact();
  }

  private fly(chips: readonly Chip[], fromX: number, fromZ: number, toX: number, toZ: number, delayMs: number, durMs: number, die: boolean): void {
    const now = performance.now();
    for (const [i, c] of chips.entries()) {
      const end = c.legs.at(-1)?.to ?? c.leg?.to ?? c.pos;
      const dx = end.x - fromX;
      const dz = end.z - fromZ;
      this.moveTo(c, new THREE.Vector3(toX + dx * 0.7, end.y, toZ + dz * 0.7), now + delayMs + i * 6, durMs, 0.18, die);
    }
  }

  private newChip(color: THREE.Color, pos: THREE.Vector3): Chip {
    const chip: Chip = { color, pos, rotY: this.rand() * Math.PI * 2, leg: null, from: pos.clone(), legs: [], alive: true };
    this.chips.push(chip);
    return chip;
  }

  /** Queues a move. With reduced motion, it's instant (still at its time, so the order of events holds). */
  private moveTo(c: Chip, to: THREE.Vector3, start: number, dur: number, arc: number, die: boolean): void {
    c.legs.push({ to, start, dur: this.reduceMotion ? 0 : dur, arc, die });
  }

  /** Whether anything is still moving (the render loop keeps full speed until it settles). */
  get animating(): boolean {
    return this.chips.some((c) => c.alive && (c.leg !== null || c.legs.length > 0));
  }

  /** Drops every chip and stack (a table change). */
  clear(): void {
    this.chips.length = 0;
    this.stacks.clear();
    this.mesh.count = 0;
  }

  update(now: number): void {
    let n = 0;
    let died = false;
    for (const c of this.chips) {
      if (!c.alive) continue;
      if (!c.leg && c.legs.length > 0 && now >= c.legs[0]!.start) {
        c.leg = c.legs.shift()!;
        c.from.copy(c.pos);
      }
      const leg = c.leg;
      if (leg) {
        const t = leg.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - leg.start) / leg.dur));
        c.pos.lerpVectors(c.from, leg.to, easeInOut(t));
        c.pos.y += Math.sin(Math.PI * t) * leg.arc;
        if (t >= 1) {
          c.pos.copy(leg.to);
          c.leg = null;
          if (leg.die) {
            c.alive = false;
            died = true;
          }
        }
      }
      if (!c.alive || n >= this.capacity) continue;
      this.quat.setFromAxisAngle(this.up, c.rotY);
      this.scale.set(1, 1, 1);
      this.matrix.compose(c.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(n, this.matrix);
      this.mesh.setColorAt(n, c.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (died) this.compact();
  }

  private compact(): void {
    for (let i = this.chips.length - 1; i >= 0; i--) if (!this.chips[i]!.alive) this.chips.splice(i, 1);
  }

  dispose(): void {
    this.mesh.dispose();
    this.tray.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

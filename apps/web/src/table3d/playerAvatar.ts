import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BONE_NAMES, type BoneName } from './humanBody.js';

// The players sitting at the 3D table (players3d.ts poses and animates
// them; the house dealer has its own body — humanBody.ts / a character
// model — and is untouched by this).
//
// Each player is somebody: a man or a woman, their own face, skin, eyes and
// hair (a dozen cuts, beards, the odd hat or pair of glasses) and their own
// clothes — a blazer over a shirt and tie, a hoodie, a polo, a leather
// jacket, a puffer vest… — all picked from their seat's seed and coloured
// from their avatar hue, so a player keeps the same look every time.
//
// Built for a table of nine on a phone:
// - The body (torso, arms, legs, clothes) is ONE skinned mesh per material,
//   every part bound to the skeleton players3d.ts poses — a handful of draw
//   calls a player, not dozens, and the joints bend smoothly.
// - The head is a group on the head bone (it turns, it's hidden under a
//   player's camera screen): its own few meshes, merged by material.
// - Colours are vertex colours, so one material serves a whole outfit; the
//   only per-player texture is the face (256×128 — skin tone, stubble,
//   shading); the weave, knit and hair-strand textures are shared.
// - Fewer segments on a lower quality tier.

const BONE_INDEX = new Map<BoneName, number>(BONE_NAMES.map((n, i) => [n, i]));

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0): V3 => new THREE.Vector3(x, y, z);

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (x: number, mu: number, s: number): number => Math.exp(-((x - mu) * (x - mu)) / (2 * s * s));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A deterministic random stream from a seat's seed. */
function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends string>(r: number, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [k, w] of table) {
    x -= w;
    if (x <= 0) return k;
  }
  return table[table.length - 1]![0];
}

// ---------------------------------------------------------------------------
// The look.

export type HairStyle = 'buzz' | 'short' | 'quiff' | 'sidepart' | 'curly' | 'afro' | 'bald' | 'balding' | 'bun' | 'ponytail' | 'long' | 'bob' | 'pixie';
export type Outfit = 'blazer' | 'hoodie' | 'tee' | 'polo' | 'shirt' | 'sweater' | 'turtleneck' | 'leather' | 'puffer' | 'varsity' | 'blouse';
export type Beard = 'none' | 'stubble' | 'full' | 'goatee' | 'moustache';
export type Headwear = 'none' | 'cap' | 'capBack' | 'beanie' | 'fedora' | 'cowboy' | 'visor' | 'headphones';
export type Eyewear = 'none' | 'glasses' | 'sunglasses' | 'aviators';

export interface AvatarLook {
  feminine: boolean;
  /** Width of the build: 0.94 slight … 1.1 broad. */
  build: number;
  skin: string;
  lips: string;
  iris: string;
  hair: string;
  hairStyle: HairStyle;
  beard: Beard;
  outfit: Outfit;
  /** The outfit's main colour (from the avatar hue), the layer under it, and a detail colour. */
  main: string;
  under: string;
  accent: string;
  trousers: string;
  shoes: string;
  tie: boolean;
  headwear: Headwear;
  hat: string;
  eyewear: Eyewear;
  earrings: boolean;
  chain: boolean;
}

const SKINS = ['#f7dcc8', '#f0c8a8', '#e3b08c', '#d29a72', '#bb8158', '#9c6643', '#7d4d32', '#5e3a26', '#46291b'];
const HAIRS = ['#16110e', '#2a1c14', '#3d2818', '#5a3a22', '#7a4e2c', '#8f3f1f', '#b06a35', '#a9854f', '#d2b47a', '#8c8a86', '#c9c6c0'];
const IRISES = ['#3b2414', '#4f3018', '#6b4a24', '#5c6b3a', '#3f6e8c', '#5d7f9e', '#6e7478'];
const NEUTRALS = ['#f4f2ee', '#e9edf2', '#d9dde3', '#1d1f24', '#2c2f36', '#c9b79a', '#9fb6cf'];
const TROUSERS = ['#1d2433', '#2a3a55', '#3b4f73', '#23252b', '#4a4d55', '#a8916a', '#5b4a3a', '#1a1a1d'];

const hsl = (h: number, s: number, l: number): string => `hsl(${String(Math.round(((h % 360) + 360) % 360))}, ${String(Math.round(s))}%, ${String(Math.round(l))}%)`;

/** A player's whole look, from their avatar hue and seat seed — the same every time. */
export function avatarLook(hue: number, seed: number): AvatarLook {
  const r = rng(seed + 977);
  const feminine = r() < 0.42;
  const skin = SKINS[Math.floor(r() * SKINS.length)]!;
  const skinIdx = SKINS.indexOf(skin);
  // Hair: darker for darker skin, mostly; grey now and then.
  let hair = HAIRS[Math.floor(r() * (skinIdx > 4 ? 4 : HAIRS.length))]!;
  if (feminine && r() < 0.06) hair = pickWeighted(r(), [['#c2547a', 1], ['#5a6fb0', 1], ['#e7d3e9', 1]] as const);
  const hairStyle: HairStyle = feminine
    ? pickWeighted(r(), [['long', 30], ['bob', 16], ['ponytail', 16], ['bun', 12], ['curly', 10], ['afro', skinIdx > 4 ? 10 : 2], ['pixie', 6]] as const)
    : pickWeighted(r(), [['buzz', 12], ['short', 20], ['quiff', 14], ['sidepart', 14], ['curly', 9], ['afro', skinIdx > 4 ? 9 : 1], ['bald', 6], ['balding', 6], ['bun', 4], ['ponytail', 3], ['long', 4]] as const);
  const beard: Beard = feminine ? 'none' : pickWeighted(r(), [['none', 40], ['stubble', 26], ['full', 16], ['goatee', 10], ['moustache', 8]] as const);
  const outfit: Outfit = feminine
    ? pickWeighted(r(), [['blazer', 16], ['blouse', 14], ['tee', 12], ['sweater', 10], ['turtleneck', 10], ['leather', 12], ['hoodie', 10], ['puffer', 8], ['varsity', 6]] as const)
    : pickWeighted(r(), [['blazer', 16], ['hoodie', 14], ['tee', 12], ['polo', 10], ['shirt', 12], ['sweater', 9], ['turtleneck', 5], ['leather', 9], ['puffer', 7], ['varsity', 6]] as const);
  // The main colour is the avatar hue — muted for tailoring, brighter for casual wear.
  const tailored = outfit === 'blazer' || outfit === 'shirt' || outfit === 'turtleneck';
  const main = outfit === 'leather' ? (r() < 0.7 ? '#18171a' : hsl(hue, 30, 22)) : tailored ? hsl(hue, 26 + r() * 14, 20 + r() * 14) : hsl(hue, 42 + r() * 22, 30 + r() * 18);
  const under = NEUTRALS[Math.floor(r() * NEUTRALS.length)]!;
  const accent = hsl(hue + 150 + r() * 60, 55, 42);
  const bigHair = hairStyle === 'afro' || hairStyle === 'bun' || (hairStyle === 'curly' && feminine);
  const headwear: Headwear =
    bigHair || r() > 0.3
      ? 'none'
      : feminine
        ? pickWeighted(r(), [['beanie', 30], ['cap', 22], ['fedora', 26], ['headphones', 22]] as const)
        : pickWeighted(r(), [['cap', 28], ['capBack', 14], ['beanie', 18], ['fedora', 12], ['cowboy', 12], ['visor', 9], ['headphones', 7]] as const);
  const eyewear: Eyewear = r() < 0.36 ? pickWeighted(r(), [['glasses', 44], ['sunglasses', 40], ['aviators', 16]] as const) : 'none';
  return {
    feminine,
    build: feminine ? 0.95 + r() * 0.06 : 0.97 + r() * 0.13,
    skin,
    lips: feminine && r() < 0.6 ? pickWeighted(r(), [['#b0384a', 2], ['#c4566a', 2], ['#8e3a3f', 1], ['#c97c74', 2]] as const) : '',
    iris: IRISES[Math.floor(r() * IRISES.length)]!,
    hair,
    hairStyle,
    beard,
    outfit,
    main,
    under,
    accent,
    trousers: TROUSERS[Math.floor(r() * TROUSERS.length)]!,
    shoes: r() < 0.6 ? '#15110f' : r() < 0.5 ? '#efeeea' : '#5a3a24',
    tie: outfit === 'blazer' && !feminine && r() < 0.5,
    headwear,
    hat: r() < 0.5 ? hsl(hue + 180, 30, 22) : NEUTRALS[Math.floor(r() * NEUTRALS.length)]!,
    eyewear,
    earrings: feminine && r() < 0.7,
    chain: !feminine && (outfit === 'tee' || outfit === 'shirt' || outfit === 'leather') && r() < 0.35,
  };
}

// ---------------------------------------------------------------------------
// Shared textures (made once, for every player).

let sharedTex: { weave: THREE.CanvasTexture; knit: THREE.CanvasTexture; strands: THREE.CanvasTexture } | null = null;
function textures(): NonNullable<typeof sharedTex> {
  if (sharedTex) return sharedTex;
  const make = (n: number, draw: (ctx: CanvasRenderingContext2D, n: number) => void, repeat: [number, number], srgb: boolean): THREE.CanvasTexture => {
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    draw(c.getContext('2d')!, n);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const r = rng(4242);
  sharedTex = {
    // A fine cotton weave, as a normal map.
    weave: make(
      64,
      (ctx, n) => {
        ctx.fillStyle = 'rgb(128,128,255)';
        ctx.fillRect(0, 0, n, n);
        for (let y = 0; y < n; y += 4) {
          for (let x = 0; x < n; x += 4) {
            ctx.fillStyle = ((x + y) / 4) % 2 === 0 ? 'rgb(150,128,240)' : 'rgb(128,150,240)';
            ctx.fillRect(x, y, 3, 3);
          }
        }
      },
      [8, 8],
      false,
    ),
    // A knit: rows of little V stitches, as a normal map.
    knit: make(
      64,
      (ctx, n) => {
        ctx.fillStyle = 'rgb(128,128,255)';
        ctx.fillRect(0, 0, n, n);
        for (let x = 0; x < n; x += 8) {
          for (let y = 0; y < n; y += 6) {
            ctx.fillStyle = 'rgb(170,128,230)';
            ctx.fillRect(x, y, 3, 5);
            ctx.fillStyle = 'rgb(86,128,230)';
            ctx.fillRect(x + 4, y, 3, 5);
          }
        }
      },
      [10, 14],
      false,
    ),
    // Hair: long strands, light and dark, multiplied over the hair colour.
    strands: make(
      128,
      (ctx, n) => {
        ctx.fillStyle = '#b8b8b8';
        ctx.fillRect(0, 0, n, n);
        for (let i = 0; i < 520; i++) {
          const x = r() * n;
          const shade = Math.floor(120 + r() * 135);
          ctx.strokeStyle = `rgba(${String(shade)},${String(shade)},${String(shade)},0.5)`;
          ctx.lineWidth = 0.5 + r() * 1.1;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.bezierCurveTo(x + (r() - 0.5) * 8, n * 0.33, x + (r() - 0.5) * 8, n * 0.66, x + (r() - 0.5) * 5, n);
          ctx.stroke();
        }
      },
      [4, 2],
      true,
    ),
  };
  return sharedTex;
}

// ---------------------------------------------------------------------------
// Geometry helpers. Everything is indexed geometry with position, normal,
// uv and color, so a whole material's worth merges into one mesh.

/** A grid surface: (cols+1)×(rows+1) points from `at(u, v)`; closed in u if asked (the seam's normals are matched). */
function surface(cols: number, rows: number, at: (u: number, v: number) => V3, opts: { closedU?: boolean; color?: (u: number, v: number) => THREE.Color; flip?: boolean } = {}): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const v = j / rows;
      const p = at(opts.closedU && i === cols ? 0 : u, v);
      pos.push(p.x, p.y, p.z);
      uv.push(u, 1 - v);
      if (opts.color) {
        const c = opts.color(u, v);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      if (opts.flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (opts.color) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (opts.closedU) {
    // The first and last columns are the same points: give them the same normal.
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let j = 0; j <= rows; j++) {
      const a = j * (cols + 1);
      const b = a + cols;
      const x = n.getX(a) + n.getX(b);
      const y = n.getY(a) + n.getY(b);
      const z = n.getZ(a) + n.getZ(b);
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / l, y / l, z / l);
      n.setXYZ(b, x / l, y / l, z / l);
    }
  }
  return g;
}

/**
 * A tube along a path, its radius varying along it — elliptical if asked
 * ([across, up] in the frame `up` gives). Ends closed with a cap when
 * `caps` (a limb hidden inside other parts needs none).
 */
function tube(
  path: THREE.Curve<V3>,
  segs: number,
  radial: number,
  radiusIn: number | [number, number] | ((t: number) => number | [number, number]), opts: { up?: V3; closed?: boolean } = {}): THREE.BufferGeometry {
  const up = opts.up ?? v3(0, 1, 0);
  const T = v3();
  const N = v3();
  const B = v3();
  return surface(
    radial,
    segs,
    (u, v) => {
      const t = opts.closed ? v % 1 : v;
      const p = path.getPointAt(Math.min(1, t));
      path.getTangentAt(Math.min(1, Math.max(0, t)), T).normalize();
      B.crossVectors(T, up);
      if (B.lengthSq() < 1e-6) B.crossVectors(T, v3(0, 0, 1));
      B.normalize();
      N.crossVectors(B, T).normalize();
      const r = typeof radiusIn === 'function' ? radiusIn(t) : radiusIn;
      const [ra, rb] = typeof r === 'number' ? [r, r] : r;
      const a = u * Math.PI * 2;
      return p.clone().addScaledVector(B, Math.cos(a) * ra).addScaledVector(N, Math.sin(a) * rb);
    },
    { closedU: true, flip: true },
  );
}

const line = (a: V3, b: V3): THREE.Curve<V3> => new THREE.LineCurve3(a, b);
const curve = (pts: V3[], closed = false): THREE.Curve<V3> => new THREE.CatmullRomCurve3(pts, closed, 'centripetal');

/** A squashed sphere (an ellipsoid), lat-long. */
function ellipsoid(rx: number, ry: number, rz: number, w: number, h: number, thetaMax = Math.PI): THREE.BufferGeometry {
  return surface(w, h, (u, v) => {
    const phi = u * Math.PI * 2;
    const th = v * thetaMax;
    return v3(Math.sin(th) * Math.sin(phi) * rx, Math.cos(th) * ry, Math.sin(th) * Math.cos(phi) * rz);
  }, { closedU: true });
}

/** A rounded slab: a flattened ellipsoid with flat-ish faces (a superellipsoid), for brims, pockets, shoes, lenses. */
function slab(rx: number, ry: number, rz: number, w: number, h: number, power = 0.35): THREE.BufferGeometry {
  const sp = (x: number): number => Math.sign(x) * Math.pow(Math.abs(x), power);
  return surface(w, h, (u, v) => {
    const phi = u * Math.PI * 2;
    const th = v * Math.PI;
    return v3(sp(Math.sin(th)) * sp(Math.sin(phi)) * rx, sp(Math.cos(th)) * ry, sp(Math.sin(th)) * sp(Math.cos(phi)) * rz);
  }, { closedU: true });
}

function transformed(g: THREE.BufferGeometry, pos: V3 | [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(Array.isArray(pos) ? v3(...pos) : pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), v3(...scale));
  return g.applyMatrix4(m);
}

// ---------------------------------------------------------------------------
// The builder: parts collected by material, body parts bound to bones.

type MatKey = 'skin' | 'cloth' | 'shiny' | 'metal' | 'face' | 'hair' | 'glossy' | 'hatCloth';

interface BodyPart {
  geo: THREE.BufferGeometry;
  /** Root-space positions → bone weights (up to two bones). */
  bind: BoneName | ((p: V3) => [BoneName, BoneName, number]);
}

/** The face texture's plain-skin spot (low at the back of the head, never seen), for skin parts that share the face material. */
const PLAIN_SKIN_UV: [number, number] = [0.02, 0.06];

class Builder {
  readonly body = new Map<MatKey, BodyPart[]>();
  readonly head = new Map<MatKey, THREE.BufferGeometry[]>();
  /** Each bone's rest transform, root space. */
  readonly boneWorld = new Map<BoneName, THREE.Matrix4>();

  constructor(bones: Map<BoneName, THREE.Bone>) {
    for (const [name, b] of bones) this.boneWorld.set(name, b.matrixWorld.clone());
  }

  /**
   * Makes a part's faces point out — away from `ref` (its own middle by default; 'none' leaves it as built, for
   * the thin two-sided pieces that add their own back): the renderer only draws a face from the front.
   */
  private static orient(g: THREE.BufferGeometry, ref: V3 | 'self' | 'none'): void {
    if (ref === 'none') return;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const c = v3();
    if (ref === 'self') {
      for (let i = 0; i < pos.count; i++) c.add(v3().fromBufferAttribute(pos, i));
      c.divideScalar(Math.max(1, pos.count));
    } else c.copy(ref);
    let sum = 0;
    const p = v3();
    const n = v3();
    for (let i = 0; i < pos.count; i++) sum += n.fromBufferAttribute(nor, i).dot(p.fromBufferAttribute(pos, i).sub(c));
    if (sum >= 0) return;
    const idx = g.index!;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    for (let i = 0; i < nor.count; i++) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i));
  }

  private static prep(g: THREE.BufferGeometry, color: THREE.Color | null, uvPin: [number, number] | null, ref: V3 | 'self' | 'none' = 'self'): THREE.BufferGeometry {
    if (!g.index) {
      const n = g.getAttribute('position').count;
      g.setIndex([...Array(n).keys()]);
    }
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
    const n = g.getAttribute('position').count;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv') || uvPin) {
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        uv[i * 2] = uvPin?.[0] ?? 0;
        uv[i * 2 + 1] = uvPin?.[1] ?? 0;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (!g.getAttribute('color')) {
      const c = color ?? new THREE.Color(1, 1, 1);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    Builder.orient(g, ref);
    return g;
  }

  /** A part on the body, in `bone`'s own (rest) space — or root space with a blend of bones. */
  addBody(
    mat: MatKey,
    g: THREE.BufferGeometry,
    color: THREE.Color | string | null,
    bind: BodyPart['bind'],
    opts: { rootSpace?: boolean; uvPin?: [number, number]; ref?: V3 | 'self' | 'none' } = {},
  ): void {
    Builder.prep(g, color === null ? null : new THREE.Color(color), opts.uvPin ?? null, opts.ref);
    if (!opts.rootSpace && typeof bind === 'string') g.applyMatrix4(this.boneWorld.get(bind)!);
    const list = this.body.get(mat) ?? [];
    list.push({ geo: g, bind });
    this.body.set(mat, list);
  }

  /** A part on the head, in the head bone's space. */
  addHead(mat: MatKey, g: THREE.BufferGeometry, color: THREE.Color | string | null, uvPin: [number, number] | null = null, ref: V3 | 'self' | 'none' = 'self'): void {
    Builder.prep(g, color === null ? null : new THREE.Color(color), uvPin, ref);
    const list = this.head.get(mat) ?? [];
    list.push(g);
    this.head.set(mat, list);
  }
}

// ---------------------------------------------------------------------------
// The head: a sculpted ellipsoid with a jaw, cheekbones, brow and sockets.

interface HeadShape {
  c: V3;
  rx: number;
  ry: number;
  rz: number;
  fem: boolean;
}

const dirOf = (phi: number, theta: number): V3 => v3(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi));

/** The face's left/right eye directions (unit, from the head's middle). */
const EYE_DIR = (sx: number): V3 => v3(sx * 0.36, 0.13, 0.924).normalize();

/** A point on the head's surface in direction `d` (unit), pushed out by `out` along it. */
function headPoint(h: HeadShape, d: V3, out = 0): V3 {
  const front = Math.max(0, d.z);
  let sx = 1;
  let sy = 1;
  let sz = 1;
  // The jaw narrows toward the chin; a woman's more.
  const low = smoothstep(-0.05, -0.9, d.y);
  sx -= (h.fem ? 0.3 : 0.22) * low * (0.35 + 0.65 * front);
  // The chin forward, the cranium full at the back, the brow ridge.
  sz += (h.fem ? 0.03 : 0.06) * gauss(d.y, -0.74, 0.14) * Math.pow(front, 6);
  if (d.z < 0) sz += 0.07 * -d.z * smoothstep(-0.5, 0.3, d.y);
  sz += (h.fem ? 0.02 : 0.045) * gauss(d.y, 0.3, 0.07) * Math.pow(front, 8);
  // Cheekbones, and the sockets the eyes sit in.
  for (const s of [-1, 1]) {
    sx += 0.035 * Math.exp(-v3(s * 0.62, -0.06, 0.76).distanceToSquared(d) / 0.03);
    sz -= 0.05 * Math.exp(-EYE_DIR(s).distanceToSquared(d) / 0.012);
  }
  // A flatter face front, temples in a touch.
  sz -= 0.04 * Math.pow(front, 10);
  sx -= 0.035 * gauss(d.y, 0.35, 0.18) * (1 - front);
  sy -= 0.03 * low;
  const k = 1 + out / Math.max(0.12, Math.hypot(d.x * h.rx, d.y * h.ry, d.z * h.rz));
  return v3(h.c.x + d.x * h.rx * sx * k, h.c.y + d.y * h.ry * sy * k, h.c.z + d.z * h.rz * sz * k);
}

/** Paints the face texture: skin with a little life in it, shading where a face has it, stubble. 256×128, lat-long. */
function paintFace(look: AvatarLook, r: () => number): HTMLCanvasElement {
  const W = 256;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const base = new THREE.Color(look.skin);
  // Work in sRGB (what's written to the canvas).
  const [br, bg, bb] = [base.r, base.g, base.b].map((x) => Math.pow(x, 1 / 2.2) * 255) as [number, number, number];
  const stubble = look.beard === 'stubble' || look.beard === 'full' || look.beard === 'goatee' ? 0.55 : look.feminine ? 0 : 0.12;
  const hair = new THREE.Color(look.hair);
  const [hr, hg, hb] = [hair.r, hair.g, hair.b].map((x) => Math.pow(x, 1 / 2.2) * 255) as [number, number, number];
  const cheek = v3(0.45, -0.18, 0.87);
  const noseSpot = v3(0, -0.15, 1);
  const sockets = [-1, 1].map((s) => EYE_DIR(s).setY(0.06));
  const chinGap = v3(0, -0.47, 0.88);
  const upperLip = v3(0, -0.36, 0.93);
  const lidSpots = [-1, 1].map((s) => v3(s * 0.36, 0.23, 0.9));
  const d = v3();
  const mirrored = v3();
  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      d.set(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi));
      let shade = 1 + (r() - 0.5) * 0.05;
      // Warm cheeks, a touch of colour on the nose; shadow round the eyes and under the jaw.
      let warm = 0.05 * Math.exp(-cheek.distanceToSquared(mirrored.set(Math.abs(d.x), d.y, d.z)) / 0.03) + 0.04 * Math.exp(-noseSpot.distanceToSquared(d) / 0.01);
      if (look.feminine) warm *= 1.8;
      for (const socket of sockets) shade -= 0.12 * Math.exp(-socket.distanceToSquared(d) / 0.006);
      shade -= 0.1 * smoothstep(-0.6, -0.95, d.y);
      let rr = br * shade * (1 + warm * 0.9);
      let gg = bg * shade * (1 - warm * 0.4);
      let b2 = bb * shade * (1 - warm * 0.5);
      // Stubble: the beard's shadow over the jaw, chin and upper lip.
      const beardZone = smoothstep(-0.12, -0.35, d.y) * smoothstep(-0.25, 0.2, d.z) * (1 - Math.exp(-chinGap.distanceToSquared(d) / 0.004));
      const lipZone = Math.exp(-upperLip.distanceToSquared(d) / 0.006);
      const s = stubble * Math.min(1, beardZone + lipZone * 0.8) * (0.6 + r() * 0.5);
      if (s > 0) {
        rr = lerp(rr, hr * 0.8, s * 0.55);
        gg = lerp(gg, hg * 0.8, s * 0.55);
        b2 = lerp(b2, hb * 0.85 + 6, s * 0.55);
      }
      // A woman's eye make-up: a soft shadow on the lids.
      if (look.feminine) {
        for (const spot of lidSpots) {
          const lid = Math.exp(-spot.distanceToSquared(d) / 0.004);
          rr = lerp(rr, rr * 0.75, lid);
          gg = lerp(gg, gg * 0.7, lid);
          b2 = lerp(b2, b2 * 0.78, lid);
        }
      }
      const i = (y * W + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, rr));
      img.data[i + 1] = Math.max(0, Math.min(255, gg));
      img.data[i + 2] = Math.max(0, Math.min(255, b2));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------

export interface PlayerAvatar {
  bones: Map<BoneName, THREE.Bone>;
  disposables: { dispose: () => void }[];
  /** The upper eyelids, pivoting on the eyes' axis: 0 open … 1 shut (see setBlink). */
  lids: THREE.Object3D;
}

/** Shuts the eyes by `amount` (0 open, 1 closed). */
export function setBlink(avatar: PlayerAvatar, amount: number): void {
  avatar.lids.rotation.x = LID_OPEN + (LID_SHUT - LID_OPEN) * amount;
}
const LID_OPEN = -0.55;
const LID_SHUT = 0.95;

/**
 * Builds a seated player under `root`: their bones (rest pose — players3d
 * poses them; same skeleton as humanBody.ts) and everything to dispose.
 */
export function buildPlayerAvatar(root: THREE.Object3D, look: AvatarLook, opts: { castShadows: boolean; detail: 'high' | 'low' }): PlayerAvatar {
  const hi = opts.detail === 'high';
  const q = (n: number): number => Math.max(6, Math.round(hi ? n : n * 0.6));
  const fem = look.feminine;
  const W = look.build;
  const r = rng(look.skin.length * 131 + look.hair.charCodeAt(2) * 17 + look.main.length * 7 + (fem ? 3 : 5));
  const col = (c: string): THREE.Color => new THREE.Color(c);

  // --- The skeleton: the same bones and lengths as humanBody.ts (players3d.ts and its arm reach rely on them). ---
  const bones = new Map<BoneName, THREE.Bone>();
  const bone = (name: BoneName, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones.set(name, b);
    return b;
  };
  const hips = bone('hips', root, 0, 0, 0);
  const spine = bone('spine', hips, 0, 0.12, 0);
  const chest = bone('chest', spine, 0, 0.3, 0);
  const neck = bone('neck', chest, 0, 0.62, 0);
  bone('head', neck, 0, 0.14, 0);
  const SHOULDER_X = (fem ? 0.285 : 0.33) * W;
  for (const side of ['R', 'L'] as const) {
    const sx = side === 'R' ? -1 : 1;
    const shoulder = bone(`shoulder${side}`, chest, sx * SHOULDER_X, 0.5, 0);
    const upper = bone(`upperArm${side}`, shoulder, 0, 0, 0);
    const fore = bone(`foreArm${side}`, upper, 0, -0.58, 0);
    bone(`hand${side}`, fore, 0, -0.52, 0);
  }
  root.updateMatrixWorld(true);
  const b = new Builder(bones);

  const skinC = col(look.skin);
  const main = col(look.main);
  const under = col(look.under);
  const accent = col(look.accent);
  const trousersC = col(look.trousers);
  const shoeC = col(look.shoes);
  const hairC = col(look.hair);
  const gold = col(r() < 0.6 ? '#d4a84a' : '#c9ccd2');

  // --- Torso: a sculpted shell from the waist to the neck, its yoke sloping to the shoulders. ---
  // Root space (hips at the origin). Half-widths / front and back depths by height.
  const Y0 = 0.0;
  const Y1 = 0.88; // armpits: where the yoke starts
  const NECK_Y = 1.11;
  const NECK_R = fem ? 0.084 : 0.1;
  const prof = (y: number): { w: number; df: number; db: number } => {
    const t = (y - Y0) / (Y1 - Y0);
    const w = fem
      ? lerp(0.27, 0.24, smoothstep(0, 0.45, t)) + lerp(0, 0.06, smoothstep(0.45, 0.85, t))
      : lerp(0.28, 0.29, smoothstep(0, 0.35, t)) + lerp(0, 0.065, smoothstep(0.35, 0.9, t));
    const df = fem ? 0.165 + 0.055 * gauss(t, 0.74, 0.11) : 0.17 + 0.03 * smoothstep(0.4, 0.85, t);
    const db = fem ? 0.16 : 0.17 + 0.012 * smoothstep(0.5, 1, t);
    return { w: w * W, df, db };
  };
  const SE = 2.6; // a superellipse: boxier than an ellipse, like a chest
  const se = (x: number): number => Math.sign(x) * Math.pow(Math.abs(x), 2 / SE);
  /** A point on the torso at angle `th` (0 = front, +x at π/2) and height parameter `v` (0 waist … 1 neck), pushed out by `inflate`. */
  const torsoAt = (th: number, v: number, inflate = 0, yStart = Y0): V3 => {
    const vBody = 0.72;
    if (v <= vBody) {
      const y = lerp(yStart, Y1, v / vBody);
      const p = prof(y);
      const c = Math.cos(th);
      return v3(se(Math.sin(th)) * (p.w + inflate), y, se(c) * ((c > 0 ? p.df : p.db) + inflate));
    }
    const s = (v - vBody) / (1 - vBody);
    const p = prof(Y1);
    const c = Math.cos(th);
    const ox = se(Math.sin(th)) * (p.w + inflate);
    const oz = se(c) * ((c > 0 ? p.df : p.db) + inflate);
    const nx = Math.sin(th) * (NECK_R + inflate * 0.6);
    const nz = c * (NECK_R + inflate * 0.6) * 0.92;
    // The trapezius: up fast from the shoulder's edge, then gently to the neck.
    const rise = Math.pow(s, 0.3);
    return v3(lerp(ox, nx, smoothstep(0, 1, s)), Y1 + (NECK_Y - Y1 + inflate * 0.4) * rise, lerp(oz, nz, smoothstep(0, 1, s)));
  };
  /** Torso parts follow the spine low down and the chest up top, blended between. */
  const torsoBind = (p: V3): [BoneName, BoneName, number] => ['spine', 'chest', smoothstep(0.42, 0.78, p.y)];
  const torsoSurface = (inflate: number, open: (v: number) => number, color: (th: number, v: number) => THREE.Color, yStart = Y0): THREE.BufferGeometry => {
    // Around from the opening's one edge to its other (0 = closed all round).
    return surface(
      q(48),
      q(30),
      (u, v) => {
        const o = open(v);
        return torsoAt(o + u * (Math.PI * 2 - 2 * o), v, inflate, yStart);
      },
      { closedU: open(0) === 0 && open(1) === 0, color: (u, v) => color(open(v) + u * (Math.PI * 2 - 2 * open(v)), v) },
    );
  };

  // What's worn, layer by layer.
  const o = look.outfit;
  const hasJacket = o === 'blazer' || o === 'leather' || o === 'puffer' || o === 'varsity';
  const baseColor = ((): THREE.Color => {
    if (o === 'blazer') return fem ? under : col(look.under === '#1d1f24' ? '#f4f2ee' : look.under);
    if (o === 'leather' || o === 'puffer') return under;
    if (o === 'varsity') return under;
    return main;
  })();
  const vNeckSkin = o === 'blouse' || (fem && o === 'tee' && r() < 0.5);
  b.addBody(
    'cloth',
    torsoSurface(0, () => 0, (th, v) => {
      // A V of skin at a V-neck or an open collar.
      const wrapped = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
      if (vNeckSkin && v > 0.72 && wrapped < 0.55 * smoothstep(0.72, 1, v) + 0.06) return skinC;
      if (o === 'shirt' && v > 0.86 && wrapped < 0.3 * smoothstep(0.86, 1, v) + 0.04) return skinC;
      return baseColor;
    }),
    null,
    torsoBind,
    { rootSpace: true },
  );

  // The outer layer.
  if (o === 'blazer') {
    // Open in a V to the button, then a little apart below it.
    const open = (v: number): number => (v < 0.3 ? lerp(0.22, 0.04, v / 0.3) : v < 0.45 ? 0.04 : lerp(0.04, 0.62, smoothstep(0.45, 1, v)));
    b.addBody('cloth', torsoSurface(0.022, open, () => main, Y0 - 0.02), null, torsoBind, { rootSpace: true });
    // Lapels: strips turned back along the V, from the collar to the button.
    for (const sx of [-1, 1]) {
      const g = surface(4, q(16), (u, v) => {
        const vv = lerp(0.42, 1, v);
        const th = open(vv) + u * 0.32 * smoothstep(0.42, 0.62, vv) * (1 - 0.35 * smoothstep(0.85, 1, vv));
        const p = torsoAt(sx * th, vv, 0.034);
        return p;
      });
      b.addBody('cloth', g, main.clone().multiplyScalar(0.82), torsoBind, { rootSpace: true, ref: v3(0, 0.75, 0) });
    }
    // The button, and a pocket square.
    b.addBody('shiny', transformed(ellipsoid(0.014, 0.014, 0.006, 10, 6), torsoAt(0, 0.38, 0.03)), '#141214', torsoBind, { rootSpace: true });
    b.addBody('cloth', transformed(slab(0.035, 0.018, 0.01, 8, 6), torsoAt(0.55, 0.62, 0.026), [0, 0.5, 0.1], [1, 1, 0.6]), accent, torsoBind, { rootSpace: true });
  } else if (o === 'leather') {
    const open = (v: number): number => lerp(0.2, 0.42, smoothstep(0.6, 1, v));
    b.addBody('shiny', torsoSurface(0.026, open, () => main, Y0 - 0.02), null, torsoBind, { rootSpace: true });
    // A zip down each open edge, and a collar.
    for (const sx of [-1, 1]) {
      const pts = [0, 0.2, 0.4, 0.6, 0.75, 0.88, 0.97].map((v) => torsoAt(sx * (open(v) + 0.02), v, 0.034));
      b.addBody('metal', tube(curve(pts), q(20), 5, 0.007), gold, torsoBind, { rootSpace: true });
    }
  } else if (o === 'puffer') {
    // Sleeveless, quilted: a zip up the front, rings of padding round it.
    b.addBody('shiny', torsoSurface(0.04, () => 0, () => main, Y0 - 0.02), null, torsoBind, { rootSpace: true });
    for (const v of [0.12, 0.26, 0.4, 0.54, 0.68]) {
      const pts = Array.from({ length: 24 }, (_, i) => torsoAt((i / 24) * Math.PI * 2, v, 0.048));
      b.addBody('shiny', tube(curve(pts, true), q(40), 6, 0.022, { closed: true }), main.clone().multiplyScalar(1.08), torsoBind, { rootSpace: true });
    }
    const zip = [0, 0.2, 0.4, 0.6, 0.8, 0.95].map((v) => torsoAt(0, v, 0.072));
    b.addBody('metal', tube(curve(zip), q(16), 5, 0.006), gold, torsoBind, { rootSpace: true });
  } else if (o === 'varsity') {
    const open = (v: number): number => lerp(0.1, 0.3, smoothstep(0.6, 1, v));
    b.addBody('cloth', torsoSurface(0.025, open, () => main, Y0 - 0.02), null, torsoBind, { rootSpace: true });
    // Ribbed trim, striped in the accent colour, up each front edge.
    for (const sx of [-1, 1]) {
      const pts = [0, 0.25, 0.5, 0.7, 0.85, 0.98].map((v) => torsoAt(sx * (open(v) + 0.01), v, 0.03));
      b.addBody('cloth', tube(curve(pts), q(18), 5, [0.012, 0.012]), accent, torsoBind, { rootSpace: true });
    }
    // Two snaps.
    for (const v of [0.3, 0.5]) b.addBody('metal', transformed(ellipsoid(0.012, 0.012, 0.006, 8, 6), torsoAt(0.14, v, 0.04)), gold, torsoBind, { rootSpace: true });
  }

  // Necklines and collars.
  const collarAt = (inflate: number, v: number): V3[] => Array.from({ length: 20 }, (_, i) => torsoAt((i / 20) * Math.PI * 2, v, inflate));
  if (o === 'tee' && !vNeckSkin) {
    b.addBody('cloth', tube(curve(collarAt(0.008, 0.965), true), q(30), 6, 0.014, { closed: true }), baseColor.clone().multiplyScalar(0.85), torsoBind, { rootSpace: true });
  }
  if (o === 'hoodie') {
    // The hood lying on the shoulders behind the neck, drawstrings, a pouch pocket.
    const hood = Array.from({ length: 9 }, (_, i) => {
      const th = lerp(Math.PI * 0.32, Math.PI * 1.68, i / 8);
      return torsoAt(th, 0.9, 0.035).add(v3(0, 0.02 + 0.03 * Math.sin((i / 8) * Math.PI), 0));
    });
    b.addBody('cloth', tube(curve(hood), q(26), 10, (t) => [0.035 + 0.025 * Math.sin(t * Math.PI), 0.03 + 0.012 * Math.sin(t * Math.PI)]), main.clone().multiplyScalar(0.92), 'chest', { rootSpace: true });
    for (const sx of [-1, 1]) {
      const top = torsoAt(sx * 0.2, 0.93, 0.02);
      b.addBody('cloth', tube(line(top, top.clone().add(v3(sx * 0.008, -0.17, 0.035))), 6, 5, 0.007), under, 'chest', { rootSpace: true });
      b.addBody('metal', transformed(ellipsoid(0.009, 0.014, 0.009, 6, 5), top.clone().add(v3(sx * 0.008, -0.18, 0.036))), '#c9ccd2', 'chest', { rootSpace: true });
    }
    b.addBody('cloth', transformed(slab(0.17, 0.08, 0.02, q(16), 8, 0.4), torsoAt(0, 0.3, 0.012)), main.clone().multiplyScalar(0.94), torsoBind, { rootSpace: true });
  }
  if (o === 'polo' || o === 'shirt' || o === 'blouse' || (o === 'blazer' && !fem)) {
    // A collar: two points either side of the throat, the band behind.
    const cc = o === 'blazer' ? baseColor : main.clone().multiplyScalar(o === 'shirt' ? 1 : 0.95);
    const band = Array.from({ length: 13 }, (_, i) => torsoAt(lerp(Math.PI * 0.22, Math.PI * 1.78, i / 12), 0.99, 0.012).add(v3(0, 0.025, 0)));
    b.addBody('cloth', tube(curve(band), q(22), 6, [0.012, 0.03]), cc, 'chest', { rootSpace: true });
    for (const sx of [-1, 1]) {
      const a = torsoAt(sx * 0.6, 0.995, 0.015).add(v3(0, 0.02, 0));
      const tip = torsoAt(sx * 0.18, 0.9, 0.022);
      b.addBody('cloth', tube(line(a, tip), 4, 6, (t) => [0.03 * (1 - t * 0.6), 0.007]), cc, 'chest', { rootSpace: true });
    }
    if (o === 'polo' || o === 'shirt') {
      for (const v of o === 'polo' ? [0.86, 0.79] : [0.86, 0.73, 0.6, 0.47, 0.34]) b.addBody('shiny', transformed(ellipsoid(0.008, 0.008, 0.004, 8, 5), torsoAt(0, v, 0.006)), '#e9e6df', torsoBind, { rootSpace: true });
    }
  }
  if (look.tie) {
    // Knot and blade, down the shirt front to the jacket's button.
    const knot = torsoAt(0, 0.95, 0.018);
    b.addBody('cloth', transformed(ellipsoid(0.022, 0.02, 0.014, 10, 6), knot), accent, 'chest', { rootSpace: true });
    const blade = [0.93, 0.8, 0.65, 0.5, 0.4].map((v) => torsoAt(0, v, 0.012));
    b.addBody('cloth', tube(curve(blade), q(12), 4, (t) => [0.016 + 0.02 * t, 0.006]), accent, torsoBind, { rootSpace: true });
  }
  if (o === 'turtleneck' || o === 'sweater') {
    if (o === 'turtleneck') {
      b.addBody('cloth', tube(line(v3(0, 0.98, 0.005), v3(0, 1.22, 0.012)), 6, q(20), (t) => NECK_R + 0.022 - t * 0.008), main.clone().multiplyScalar(0.95), (p) => ['chest', 'neck', smoothstep(1.02, 1.12, p.y)], { rootSpace: true });
    } else {
      b.addBody('cloth', tube(curve(collarAt(0.01, 0.95), true), q(30), 6, 0.018, { closed: true }), main.clone().multiplyScalar(0.9), torsoBind, { rootSpace: true });
    }
    // Ribbing at the hem.
    b.addBody('cloth', tube(curve(collarAt(0.012, 0.02), true), q(30), 6, 0.02, { closed: true }), main.clone().multiplyScalar(0.9), torsoBind, { rootSpace: true });
  }
  if (o === 'leather' || o === 'varsity' || o === 'puffer') {
    // A stand collar round the back of the neck.
    const band = Array.from({ length: 11 }, (_, i) => torsoAt(lerp(Math.PI * 0.4, Math.PI * 1.6, i / 10), 0.97, 0.05).add(v3(0, 0.03, 0)));
    b.addBody(o === 'varsity' ? 'cloth' : 'shiny', tube(curve(band), q(20), 6, (t) => [0.016, 0.04 * (0.35 + 0.65 * Math.sin(Math.PI * t))]), o === 'varsity' ? accent : main.clone().multiplyScalar(0.9), 'chest', { rootSpace: true });
  }
  if (look.chain) {
    const pts = Array.from({ length: 9 }, (_, i) => torsoAt(lerp(-1.2, 1.2, i / 8), 0.86 + 0.1 * Math.abs(lerp(-1, 1, i / 8)), 0.012));
    b.addBody('metal', tube(curve(pts), q(24), 5, 0.0055), '#d9b45a', 'chest', { rootSpace: true });
  }
  if (fem && (o === 'blouse' || o === 'tee' || o === 'turtleneck')) {
    // A pendant on a fine chain.
    const pts = Array.from({ length: 9 }, (_, i) => torsoAt(lerp(-1.1, 1.1, i / 8), 0.9 + 0.08 * Math.abs(lerp(-1, 1, i / 8)), 0.006));
    if (o !== 'turtleneck' && r() < 0.6) {
      b.addBody('metal', tube(curve(pts), q(24), 4, 0.0035), gold, 'chest', { rootSpace: true });
      b.addBody('metal', transformed(ellipsoid(0.014, 0.018, 0.006, 8, 6), torsoAt(0, 0.88, 0.012)), gold, 'chest', { rootSpace: true });
    }
  }

  // --- Neck. ---
  b.addBody(
    'skin',
    tube(line(v3(0, 0.96, 0.0), v3(0, 1.3, 0.02)), q(8), q(18), (t) => NECK_R - 0.006 * t + (fem ? 0 : 0.006 * gauss(t, 0.45, 0.12))),
    skinC,
    (p) => ['chest', 'neck', smoothstep(1.0, 1.1, p.y)],
    { rootSpace: true },
  );

  // --- Arms: one sleeve from the shoulder to the wrist, bending smoothly at the elbow; the hand. ---
  const sleeve = hasJacket && o !== 'puffer' ? main : baseColor;
  const sleeveMat: MatKey = o === 'leather' ? 'shiny' : 'cloth';
  /** Where the sleeve ends: a tee's at the biceps, a rolled shirt's below the elbow, else the wrist. */
  const sleeveEnd = o === 'tee' || o === 'polo' ? 0.36 : o === 'blouse' && r() < 0.5 ? 0.7 : o === 'shirt' && r() < 0.5 ? 0.7 : 1.02;
  const armR = (y: number): number => {
    const t = -y / 1.1;
    const upper = (fem ? 0.078 : 0.094) * W * (1 - 0.15 * smoothstep(0.1, 0.5, t));
    const fore = (fem ? 0.066 : 0.08) * (1 - 0.3 * smoothstep(0.62, 1, t));
    return t < 0.5 ? upper : lerp(upper, fore, smoothstep(0.5, 0.62, t));
  };
  for (const side of ['R', 'L'] as const) {
    const sx = side === 'R' ? -1 : 1;
    const upperName: BoneName = `upperArm${side}`;
    const foreName: BoneName = `foreArm${side}`;
    const shoulderW = b.boneWorld.get(upperName)!;
    const at = (y: number): V3 => v3(0, y, 0).applyMatrix4(shoulderW);
    const bindArm = (p: V3): [BoneName, BoneName, number] => {
      const local = p.clone().sub(at(0));
      return [upperName, foreName, smoothstep(0.5, 0.66, -local.y)];
    };
    const segment = (y0: number, y1: number, mat: MatKey, c: THREE.Color, extra = 0): void => {
      b.addBody(mat, tube(line(at(y0), at(y1)), q(14), q(16), (t) => armR(lerp(y0, y1, t)) + extra), c, bindArm, { rootSpace: true });
    };
    const endY = -1.1 * sleeveEnd;
    segment(0.02, Math.max(endY, -1.1), sleeveMat, sleeve, hasJacket ? 0.012 : 0.004);
    if (endY > -1.08) {
      segment(endY + 0.02, -1.1, 'skin', skinC);
      // The hem (or the roll of a rolled sleeve).
      b.addBody(sleeveMat, tube(curve(Array.from({ length: 12 }, (_, i) => at(endY).add(v3(Math.cos((i / 12) * Math.PI * 2) * (armR(endY) + 0.012), 0, Math.sin((i / 12) * Math.PI * 2) * (armR(endY) + 0.012)))), true), q(20), 5, sleeveEnd > 0.5 ? 0.016 : 0.01, { closed: true }), sleeve.clone().multiplyScalar(0.9), bindArm, { rootSpace: true });
    } else {
      // Cuff: a shirt's under a jacket, or ribbing.
      const cuffC = o === 'blazer' ? baseColor : sleeve.clone().multiplyScalar(0.88);
      b.addBody('cloth', tube(line(at(-1.02), at(-1.1)), 2, q(16), armR(-1.06) + 0.012), cuffC, bindArm, { rootSpace: true });
    }
    // The shoulder's round: the sleeve's own width, a sphere centred on the joint (the same however the arm turns).
    const capR = armR(0.02) + (hasJacket ? 0.012 : 0.004);
    b.addBody(sleeveMat, ellipsoid(capR, capR, capR, q(18), q(12)), sleeve, upperName);
    // The elbow, likewise, on the forearm.
    const elbowY = -0.58;
    const elbowMat: MatKey = endY > -0.58 ? 'skin' : sleeveMat;
    b.addBody(elbowMat, transformed(ellipsoid(1, 1, 1, q(14), q(10)), [0, 0, 0], [0, 0, 0], [armR(elbowY) + (endY > -0.58 ? 0 : hasJacket ? 0.012 : 0.004), armR(elbowY), armR(elbowY)]), endY > -0.58 ? skinC : sleeve, foreName);
    // The hand: palm, four fingers a little curled, a thumb.
    const handName: BoneName = `hand${side}`;
    const hs = fem ? 0.88 : 1;
    b.addBody('skin', slab(0.05 * hs, 0.065 * hs, 0.022 * hs, q(12), q(8), 0.6), skinC, handName);
    b.body.get('skin')!.at(-1)!.geo.applyMatrix4(new THREE.Matrix4().makeTranslation(...v3(0, -0.07, 0).applyMatrix4(b.boneWorld.get(handName)!).sub(v3().applyMatrix4(b.boneWorld.get(handName)!)).toArray()));
    for (let f = 0; f < 4; f++) {
      const fx = (f - 1.5) * 0.024 * hs;
      const len = (f === 0 || f === 3 ? 0.06 : 0.072) * hs;
      const base = v3(fx, -0.125 * hs, 0.004);
      const tip = base.clone().add(v3(0, -len, 0.025));
      b.addBody('skin', tube(curve([base, base.clone().lerp(tip, 0.5).add(v3(0, 0, 0.004)), tip]), 5, 7, (t) => 0.0115 * hs * (1 - 0.2 * t)), skinC, handName);
    }
    const tb = v3(sx * -0.045 * hs, -0.06 * hs, 0.012);
    b.addBody('skin', tube(curve([tb, tb.clone().add(v3(sx * -0.02, -0.035, 0.02)), tb.clone().add(v3(sx * -0.026, -0.07, 0.032))]), 5, 7, 0.013 * hs), skinC, handName);
    // A watch on the left wrist, now and then.
    // (In the forearm's own space the wrist is 0.52 down.)
    if (side === 'L' && r() < 0.5) b.addBody('metal', transformed(ellipsoid(armR(-1.06) + 0.01, 0.018, armR(-1.06) + 0.01, q(14), 4), [0, -0.46, 0]), gold, foreName);
  }

  // --- Hips and legs (sitting): mostly under the table. ---
  b.addBody('cloth', ellipsoid((fem ? 0.32 : 0.3) * W, 0.2, 0.24, q(24), q(12)), trousersC, 'hips');
  b.addBody('shiny', tube(curve(Array.from({ length: 16 }, (_, i) => torsoAt((i / 16) * Math.PI * 2, 0, 0.012)), true), q(28), 5, 0.02, { closed: true }), '#1a1512', 'hips', { rootSpace: true });
  for (const sx of [-1, 1]) {
    const hip = v3(sx * 0.15 * W, -0.02, 0.06);
    const knee = v3(sx * 0.16 * W, 0.0, 0.64);
    const ankle = v3(sx * 0.16 * W, -0.86, 0.68);
    b.addBody('cloth', tube(line(hip, knee), q(8), q(14), (t) => lerp(0.165, 0.11, t) * (fem ? 0.95 : 1)), trousersC, 'hips', { rootSpace: true });
    b.addBody('cloth', transformed(ellipsoid(0.118, 0.118, 0.118, q(16), q(12)), knee), trousersC, 'hips', { rootSpace: true });
    b.addBody('cloth', tube(line(knee, ankle), q(8), q(14), (t) => lerp(0.105, 0.078, t)), trousersC, 'hips', { rootSpace: true });
    b.addBody('shiny', transformed(slab(0.06, 0.04, 0.13, q(12), q(8), 0.5), [sx * 0.16 * W, -0.92, 0.74]), shoeC, 'hips', { rootSpace: true });
  }

  // --- The head (on the head bone: everything here is in its space). ---
  const H: HeadShape = { c: v3(0, 0.17, 0.005), rx: fem ? 0.152 : 0.162, ry: fem ? 0.196 : 0.2, rz: fem ? 0.178 : 0.186, fem };
  const P = (d: V3, out = 0): V3 => headPoint(H, d, out);
  const faceTex = new THREE.CanvasTexture(paintFace(look, r));
  faceTex.colorSpace = THREE.SRGBColorSpace;
  b.addHead(
    'face',
    surface(q(44), q(34), (u, v) => P(dirOf((u - 0.5) * Math.PI * 2, v * Math.PI)), { closedU: true }),
    null,
  );
  // Ears.
  for (const sx of [-1, 1]) {
    const at = P(v3(sx, 0.02, -0.08).normalize(), -0.012);
    const ear = transformed(ellipsoid(0.018, 0.05, 0.034, q(12), q(8)), at, [0, sx * 0.35, sx * 0.08]);
    b.addHead('face', ear, null, PLAIN_SKIN_UV);
    b.addHead('face', transformed(tube(curve([v3(0, 0.04, -0.01), v3(0, 0.05, 0.02), v3(0, 0.015, 0.03), v3(0, -0.035, 0.012)]), 8, 6, 0.008), at.clone().add(v3(sx * 0.012, 0, 0)), [0, sx * 0.35, 0]), null, PLAIN_SKIN_UV);
  }
  // Nose: a bridge from between the eyes, a rounded tip, the wings of the nostrils.
  const noseTop = P(v3(0, 0.06, 1).normalize(), -0.006);
  const noseTip = P(v3(0, -0.15, 1).normalize(), fem ? 0.026 : 0.032);
  b.addHead('face', tube(line(noseTop, noseTip), 6, 10, (t) => [0.009 + 0.006 * t, 0.011 + 0.005 * t], { up: v3(0, 0, 1) }), null, PLAIN_SKIN_UV);
  b.addHead('face', transformed(ellipsoid(0.015, 0.014, 0.014, q(12), q(8)), noseTip), null, PLAIN_SKIN_UV);
  for (const sx of [-1, 1]) {
    b.addHead('face', transformed(ellipsoid(0.011, 0.01, 0.011, q(10), q(6)), noseTip.clone().add(v3(sx * 0.016, -0.008, -0.013))), null, PLAIN_SKIN_UV);
    b.addHead('glossy', transformed(ellipsoid(0.005, 0.003, 0.005, 6, 4), noseTip.clone().add(v3(sx * 0.008, -0.015, -0.006))), '#2a1612');
  }
  // Lips: the upper with a dip in the middle, the fuller lower.
  const lipC = look.lips || new THREE.Color(look.skin).lerp(new THREE.Color('#9a4a44'), 0.42).getStyle();
  const mouthY = fem ? -0.43 : -0.45;
  const mw = fem ? 0.34 : 0.36;
  const upperLip = [-1, -0.5, 0, 0.5, 1].map((s) => P(v3(s * mw * 0.5, mouthY + 0.035 - (s === 0 ? 0.004 : 0) - 0.02 * Math.abs(s) * Math.abs(s), 1).normalize(), 0.004));
  const lowerLip = [-1, -0.5, 0, 0.5, 1].map((s) => P(v3(s * mw * 0.46, mouthY - 0.02 + 0.018 * s * s, 1).normalize(), 0.004));
  b.addHead('glossy', tube(curve(upperLip), q(14), 8, (t) => [0.004 + 0.0075 * Math.sin(t * Math.PI), 0.003 + 0.007 * Math.sin(t * Math.PI)]), lipC);
  b.addHead('glossy', tube(curve(lowerLip), q(14), 8, (t) => [0.004 + 0.0095 * Math.sin(t * Math.PI), 0.004 + 0.0095 * Math.sin(t * Math.PI)]), lipC);
  // Eyes: the white, a coloured iris, the pupil, a glint of light.
  const eyeR = fem ? 0.028 : 0.027;
  const lidsPivot = new THREE.Group();
  const eyeCentre = (sx: number): V3 => P(EYE_DIR(sx), -eyeR * 0.75);
  lidsPivot.position.copy(eyeCentre(1).setX(0));
  const lidGeos: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const ec = eyeCentre(sx);
    // Each eye looks straight ahead, a touch inward.
    const look3 = v3(-sx * 0.05, -0.02, 1).normalize();
    const q3 = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), look3);
    const onEye = (g: THREE.BufferGeometry, z: number): THREE.BufferGeometry => g.applyMatrix4(new THREE.Matrix4().compose(ec.clone().add(look3.clone().multiplyScalar(z)), q3, v3(1, 1, 1)));
    b.addHead('glossy', transformed(ellipsoid(eyeR, eyeR, eyeR, q(16), q(12)), ec), '#f1ede6');
    b.addHead('glossy', onEye(ellipsoid(eyeR * 0.5, eyeR * 0.5, eyeR * 0.12, q(14), q(8)), eyeR * 0.93), look.iris);
    b.addHead('glossy', onEye(ellipsoid(eyeR * 0.22, eyeR * 0.22, eyeR * 0.08, 10, 6), eyeR * 1.0), '#0a0a0c');
    b.addHead('glossy', onEye(ellipsoid(eyeR * 0.08, eyeR * 0.08, eyeR * 0.05, 6, 4).translate(eyeR * 0.15, eyeR * 0.17, 0), eyeR * 1.04), '#ffffff');
    // The upper lid, in the pivot's space: a shell over the eye's top that the blink swings down.
    const lid = new THREE.SphereGeometry(eyeR * 1.12, q(16), q(8), 0, Math.PI * 2, 0, Math.PI * 0.5);
    lid.translate(ec.x, ec.y - lidsPivot.position.y, ec.z - lidsPivot.position.z);
    lidGeos.push(lid);
    // The lower lid, and lashes along the upper.
    b.addHead('face', transformed(new THREE.SphereGeometry(eyeR * 1.1, q(14), q(6), 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.38), ec, [-0.25, 0, 0]), null, PLAIN_SKIN_UV);
    // Brows: a tapered arch, thicker for him.
    const brow = [0, 0.35, 0.7, 1].map((t) => P(v3(sx * lerp(0.1, 0.46, t), 0.28 + 0.035 * Math.sin(t * Math.PI * 0.9) - 0.03 * t, 0.9).normalize(), 0.006));
    b.addHead('hair', tube(curve(brow), q(10), 6, (t) => [(fem ? 0.0055 : 0.008) * (1 - 0.55 * t), (fem ? 0.0035 : 0.005) * (1 - 0.4 * t)], { up: v3(0, 1, 0) }), look.hair === '#c9c6c0' ? '#8c8a86' : look.hair);
    if (look.earrings) {
      const lobe = P(v3(sx, -0.22, -0.02).normalize(), 0.004);
      if (r() < 0.5) b.addHead('glossy', transformed(new THREE.TorusGeometry(0.018, 0.0035, 6, q(16)), lobe.clone().add(v3(0, -0.02, 0)), [0, Math.PI / 2, 0]), '#d9b45a');
      else b.addHead('glossy', transformed(ellipsoid(0.008, 0.008, 0.008, 8, 6), lobe.clone().add(v3(0, -0.008, 0))), '#e9e4d8');
    }
  }
  const lidGeo = mergeGeometries(lidGeos, false);
  for (const g of lidGeos) g.dispose();

  // Facial hair.
  const beardC = hairC.clone().multiplyScalar(0.92);
  if (look.beard === 'full' || look.beard === 'goatee') {
    const span = look.beard === 'full' ? 1.45 : 0.42;
    b.addHead(
      'hair',
      surface(q(26), q(10), (u, v) => {
        const phi = lerp(-span, span, u);
        const sideness = Math.min(1, Math.abs(phi) / 0.9);
        const top = lerp(Math.acos(-0.56), Math.acos(-0.05), smoothstep(0.25, 0.9, sideness));
        const th = lerp(top, 2.55, v);
        const thick = 0.012 + 0.02 * Math.sin(Math.PI * Math.min(1, v * 1.2)) * (look.beard === 'full' ? 1 : 0.8) * (1 - 0.6 * smoothstep(1.1, 1.45, Math.abs(phi)));
        return P(dirOf(phi, th), thick);
      }),
      beardC,
    );
  }
  if (look.beard === 'full' || look.beard === 'goatee' || look.beard === 'moustache') {
    const m = [-1, -0.5, 0, 0.5, 1].map((s) => P(v3(s * 0.2, mouthY + 0.085 - 0.03 * s * s, 1).normalize(), 0.012));
    b.addHead('hair', tube(curve(m), q(12), 6, (t) => [0.006 + 0.008 * Math.sin(t * Math.PI), 0.004 + 0.007 * Math.sin(t * Math.PI)]), beardC);
  }

  // --- Hair. ---
  const hs = look.hairStyle;
  const hat = look.headwear;
  const capped = hat === 'cap' || hat === 'capBack' || hat === 'beanie' || hat === 'fedora' || hat === 'cowboy';
  /** The hairline: how far down from the crown (polar angle) the hair reaches at azimuth `phi` (0 = the face). */
  const hairline = (phi: number, recede = 0): number => {
    const a = Math.abs(Math.atan2(Math.sin(phi), Math.cos(phi)));
    const front = Math.acos(0.58 - recede) + 0.06 * Math.cos(phi * 6) * (recede > 0 ? 1 : 0);
    const side = Math.acos(0.06);
    const back = Math.acos(-0.5);
    return a < Math.PI / 2 ? lerp(front, side, smoothstep(0.25, 1.35, a)) : lerp(side, back, smoothstep(Math.PI / 2, Math.PI * 0.9, a));
  };
  const hairVar = (u: number, v: number): THREE.Color => hairC.clone().multiplyScalar(0.92 + 0.16 * Math.sin(u * 97 + v * 13) * Math.sin(u * 31));
  /** A cap of hair over the scalp: thickness `thick(phi, theta, edge)` (edge 0 at the crown … 1 at the hairline). */
  const hairCap = (thick: (phi: number, th: number, edge: number) => number, recede = 0, minTh = 0): void => {
    b.addHead(
      'hair',
      surface(
        q(40),
        q(18),
        (u, v) => {
          const phi = (u - 0.5) * Math.PI * 2;
          const end = hairline(phi, recede);
          // Under a hat only what shows below its band is built.
          const from = Math.min(capped ? Math.max(minTh, 1.02) : minTh, end - 0.04);
          const th = lerp(from, end, v);
          // Thin to nothing at the hairline, so it meets the skin cleanly.
          return P(dirOf(phi, th), thick(phi, th, v) * (1 - smoothstep(0.9, 1, v) * 0.75) + 0.004);
        },
        { closedU: true, color: hairVar },
      ),
      null,
    );
  };
  if (hs === 'buzz') hairCap(() => 0.006);
  else if (hs === 'short' || hs === 'pixie') hairCap((phi, th) => 0.024 + 0.012 * Math.cos(th * 1.3) + 0.006 * Math.sin(phi * 9 + th * 7));
  else if (hs === 'quiff') hairCap((phi, th) => 0.016 + 0.07 * gauss(th, 0.55, 0.28) * Math.pow(Math.max(0, Math.cos(phi)), 2) + 0.008 * Math.cos(th));
  else if (hs === 'sidepart') hairCap((phi, th) => 0.024 + 0.022 * gauss(th, 0.5, 0.35) * (0.6 + 0.4 * Math.sin(phi + 0.6)) + 0.004 * Math.sin(phi * 12));
  else if (hs === 'curly' || hs === 'afro') {
    const big = hs === 'afro' ? 0.075 : 0.035;
    hairCap((phi, th) => big * (0.75 + 0.25 * Math.cos(th * 0.8)) + 0.012 * Math.sin(phi * 11) * Math.sin(th * 9), 0);
    // Curls over the top.
    const n = hi ? (hs === 'afro' ? 110 : 80) : 40;
    for (let i = 0; i < n; i++) {
      const phi = (r() - 0.5) * Math.PI * 2;
      const th = capped ? lerp(1.05, hairline(phi) * 0.95, r()) : r() * hairline(phi) * 0.92;
      const at = P(dirOf(phi, th), big * (0.75 + 0.25 * Math.cos(th * 0.8)) + 0.01);
      const rr = (hs === 'afro' ? 0.026 : 0.017) * (0.75 + r() * 0.5);
      b.addHead('hair', transformed(ellipsoid(rr, rr, rr, 6, 4), at), hairC.clone().multiplyScalar(0.85 + r() * 0.3));
    }
  } else if (hs === 'balding') {
    // A horseshoe round the sides and back; the crown bare.
    b.addHead(
      'hair',
      surface(q(30), q(8), (u, v) => {
        const phi = lerp(Math.PI * 0.32, Math.PI * 1.68, u);
        const th = lerp(Math.acos(0.42), hairline(phi), v);
        return P(dirOf(phi, th), 0.012 * (1 - smoothstep(0.8, 1, v) * 0.8) + 0.003);
      }, { color: hairVar }),
      null,
    );
  } else if (hs !== 'bald') {
    // Long styles start from a smooth cap…
    hairCap((phi, th) => 0.022 + 0.012 * Math.cos(th) + (fem ? 0.008 * gauss(Math.abs(phi), 0.5, 0.3) : 0));
    if (hs === 'long' || hs === 'bob') {
      // …and fall: behind and down the sides, clear of the face, to the jaw (a bob) or past the shoulders. A volume,
      // not a sheet: round the outside, back along the inside, thinning to nothing at its two front edges.
      const len = hs === 'bob' ? 0.2 : 0.5;
      b.addHead(
        'hair',
        surface(
          q(48),
          q(14),
          (u, v) => {
            const outer = u < 0.5;
            const k = outer ? u * 2 : 2 - u * 2;
            const phi = lerp(Math.PI * 0.27, Math.PI * 1.73, k);
            const start = P(dirOf(phi, Math.acos(0.32)), 0.026);
            const dir = v3(Math.sin(phi), 0, Math.cos(phi));
            const flare = hs === 'bob' ? 0.035 * v : 0.05 * Math.sin(v * Math.PI * 0.75);
            const base = Math.max(Math.hypot(start.x, start.z - H.c.z), 0.175) + flare + 0.01 * Math.sin(k * 41) * v;
            const rad = outer ? base : base - (hs === 'bob' ? 0.03 : 0.04) * Math.sin(Math.PI * k) - 0.004;
            // The ends: a bob turns under, long hair thins out.
            const p = v3(dir.x * rad, start.y - v * len * (1 - 0.06 * Math.cos(k * Math.PI * 2)), H.c.z + dir.z * rad);
            return p.lerp(start, Math.pow(1 - v, 6));
          },
          { closedU: true, color: hairVar },
        ),
        null,
        null,
        v3(0, H.c.y - len / 2, H.c.z),
      );
    } else if (hs === 'ponytail') {
      const root2 = P(dirOf(Math.PI, 1.0), 0.02);
      const pts = [root2, root2.clone().add(v3(0, -0.06, -0.07)), root2.clone().add(v3(0, -0.2, -0.1)), root2.clone().add(v3(0, -0.36, -0.08))];
      b.addHead('hair', tube(curve(pts), q(14), 9, (t) => 0.034 * (1 - 0.55 * t) * (t < 0.08 ? 0.7 + t * 3.75 : 1)), hairC);
      b.addHead('glossy', transformed(new THREE.TorusGeometry(0.026, 0.008, 6, 12), root2.clone().add(v3(0, -0.02, -0.03)), [Math.PI / 2 - 0.6, 0, 0]), look.accent);
    } else if (hs === 'bun') {
      b.addHead('hair', transformed(ellipsoid(fem ? 0.07 : 0.05, fem ? 0.06 : 0.045, fem ? 0.07 : 0.05, q(14), q(10)), P(dirOf(Math.PI, fem ? 0.55 : 0.4), fem ? 0.06 : 0.045)), hairC.clone().multiplyScalar(1.05));
    }
  }

  // --- Headwear. ---
  const hatC = col(look.hat);
  if (hat === 'cap' || hat === 'capBack' || hat === 'visor') {
    const back = hat === 'capBack';
    if (hat !== 'visor') {
      b.addHead('hatCloth', surface(q(36), q(12), (u, v) => P(dirOf((u - 0.5) * Math.PI * 2, v * 1.25), 0.042 - 0.008 * v), { closedU: true }), hatC);
      b.addHead('hatCloth', transformed(ellipsoid(0.014, 0.008, 0.014, 8, 5), P(v3(0, 1, 0), 0.046)), hatC.clone().multiplyScalar(0.8));
    } else {
      b.addHead('hatCloth', tube(curve(Array.from({ length: 16 }, (_, i) => P(dirOf((i / 16) * Math.PI * 2, 1.12), 0.026)), true), q(28), 5, [0.008, 0.022], { closed: true }), '#1b1f1c');
    }
    // The brim: forward (or back, worn backwards), curved.
    const phi0 = back ? Math.PI : 0;
    const brim = surface(q(14), 6, (u, v) => {
      // From the cap's edge round the forehead, out to a rounded front, curving down at the sides.
      const a = lerp(-1.0, 1.0, u);
      const inner = P(dirOf(phi0 + a * 0.95, 1.16), 0.036);
      const reach = (hat === 'visor' ? 0.13 : 0.12) * Math.sqrt(Math.max(0, 1 - a * a * 0.92)) * v;
      const dir = v3(Math.sin(phi0 + a * 0.5), 0, Math.cos(phi0 + a * 0.5));
      return inner.add(dir.multiplyScalar(reach)).add(v3(0, -0.012 * v - 0.02 * a * a * v, 0));
    });
    b.addHead('hatCloth', brim, hat === 'visor' ? col('#1f6b4a') : hatC, null, H.c);
    const brimBack = brim.clone();
    const bi = brimBack.index!;
    for (let i = 0; i < bi.count; i += 3) {
      const a = bi.getX(i + 1);
      bi.setX(i + 1, bi.getX(i + 2));
      bi.setX(i + 2, a);
    }
    const bn = brimBack.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < bn.count; i++) bn.setXYZ(i, -bn.getX(i), -bn.getY(i), -bn.getZ(i));
    b.addHead('hatCloth', brimBack.translate(0, -0.004, 0), hat === 'visor' ? col('#1f6b4a') : hatC.clone().multiplyScalar(0.7), null, 'none');
  } else if (hat === 'beanie') {
    b.addHead('hatCloth', surface(q(36), q(12), (u, v) => P(dirOf((u - 0.5) * Math.PI * 2, v * 1.3), 0.05 + 0.03 * Math.cos(v * 1.2) * (1 - v)), { closedU: true }), hatC);
    b.addHead('hatCloth', tube(curve(Array.from({ length: 16 }, (_, i) => P(dirOf((i / 16) * Math.PI * 2, 1.24), 0.052)), true), q(30), 6, [0.026, 0.02], { closed: true }), hatC.clone().multiplyScalar(0.88));
  } else if (hat === 'fedora' || hat === 'cowboy') {
    const cow = hat === 'cowboy';
    const crownY = H.c.y + 0.12;
    // The crown: a pinched lathe; the band; a wide brim (a cowboy's curls up at the sides).
    const crown = new THREE.LatheGeometry([v3(0.0, 0.17), v3(0.1, 0.165), v3(0.165, 0.13), v3(0.178, 0.0)].map((p) => new THREE.Vector2(p.x, p.y)), q(32));
    b.addHead('hatCloth', transformed(crown, [0, crownY, H.c.z - 0.01], [-0.12, 0, 0], [1.02, cow ? 0.95 : 0.85, 1.12]), hatC);
    b.addHead('hatCloth', transformed(new THREE.CylinderGeometry(0.182, 0.184, 0.035, q(32), 1, true), [0, crownY + 0.016, H.c.z - 0.01], [-0.12, 0, 0], [1.02, 1, 1.12]), cow ? col('#3a2416') : col('#141214'));
    const brim = surface(q(36), 4, (u, v) => {
      const a = u * Math.PI * 2;
      const rr = lerp(0.17, cow ? 0.34 : 0.29, v);
      const x = Math.sin(a) * rr;
      const z = Math.cos(a) * rr * 1.1;
      const curl = cow ? 0.09 * Math.pow(Math.abs(Math.sin(a)), 2) * v * v : 0.025 * v * (Math.cos(a) < 0 ? 1 : -0.3);
      return v3(x, crownY + curl - 0.004, H.c.z - 0.01 + z).applyAxisAngle(v3(1, 0, 0), -0.12);
    }, { closedU: true });
    b.addHead('hatCloth', brim, hatC.clone().multiplyScalar(0.92), null, H.c);
    const under = brim.clone();
    const ui = under.index!;
    for (let i = 0; i < ui.count; i += 3) {
      const a = ui.getX(i + 1);
      ui.setX(i + 1, ui.getX(i + 2));
      ui.setX(i + 2, a);
    }
    const un = under.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < un.count; i++) un.setXYZ(i, -un.getX(i), -un.getY(i), -un.getZ(i));
    b.addHead('hatCloth', under.translate(0, -0.006, 0), hatC.clone().multiplyScalar(0.6), null, 'none');
  } else if (hat === 'headphones') {
    // The band over the crown, ear to ear (a touch behind the middle).
    const band = Array.from({ length: 11 }, (_, i) => {
      const t = lerp(-1.45, 1.45, i / 10);
      return P(v3(Math.sin(t), Math.cos(t), -0.05).normalize(), 0.045 + 0.01 * Math.cos(t));
    });
    b.addHead('glossy', tube(curve(band), q(20), 6, [0.012, 0.006]), '#1c1d22');
    for (const sx of [-1, 1]) {
      b.addHead('glossy', transformed(new THREE.CylinderGeometry(0.055, 0.055, 0.04, q(18)), P(v3(sx, 0.0, -0.05).normalize(), 0.024), [0, 0, Math.PI / 2]), '#1c1d22');
      b.addHead('glossy', transformed(new THREE.CylinderGeometry(0.035, 0.035, 0.042, q(14)), P(v3(sx, 0.0, -0.05).normalize(), 0.034), [0, 0, Math.PI / 2]), look.accent);
    }
  }

  // --- Eyewear. ---
  if (look.eyewear !== 'none') {
    const ew = look.eyewear;
    const frameC = ew === 'aviators' ? '#c9a24a' : ew === 'sunglasses' ? '#121214' : r() < 0.5 ? '#151416' : '#5a3a24';
    const lensC = ew === 'glasses' ? null : ew === 'aviators' ? '#2a2420' : '#0d0e10';
    for (const sx of [-1, 1]) {
      const c = P(EYE_DIR(sx), 0.03);
      const w = ew === 'aviators' ? 0.042 : 0.046;
      const h = ew === 'aviators' ? 0.036 : ew === 'sunglasses' ? 0.03 : 0.028;
      const rim = Array.from({ length: 18 }, (_, i) => {
        const a = (i / 18) * Math.PI * 2;
        const drop = ew === 'aviators' ? 0.01 * Math.max(0, -Math.sin(a)) * (1 + sx * Math.cos(a)) : 0;
        return c.clone().add(v3(Math.cos(a) * w, Math.sin(a) * h - drop, -0.006 * Math.cos(a) * sx));
      });
      b.addHead('glossy', tube(curve(rim, true), q(28), 5, ew === 'aviators' ? 0.0028 : 0.0042, { closed: true, up: v3(0, 0, 1) }), frameC);
      if (lensC) b.addHead('glossy', transformed(ellipsoid(w * 0.98, h * (ew === 'aviators' ? 1.15 : 0.98), 0.006, q(16), 6), c.clone().add(v3(0, ew === 'aviators' ? -0.004 : 0, 0))), lensC);
      // The arm back to the ear.
      const hinge = c.clone().add(v3(sx * w, 0.006, -0.01));
      const ear = P(v3(sx, 0.06, -0.15).normalize(), 0.012);
      b.addHead('glossy', tube(line(hinge, ear), 6, 4, 0.004), frameC);
    }
    const bridgeA = P(EYE_DIR(-1), 0.03).add(v3(0.046, 0.008, 0));
    const bridgeB = P(EYE_DIR(1), 0.03).add(v3(-0.046, 0.008, 0));
    b.addHead('glossy', tube(curve([bridgeA, v3(0, bridgeA.y + 0.01, bridgeA.z + 0.006), bridgeB]), 6, 4, 0.004), frameC);
  }

  // --- Materials, and the meshes. ---
  const disposables: { dispose: () => void }[] = [faceTex];
  const tex = textures();
  const matOf = new Map<MatKey, THREE.Material>();
  const make = (key: MatKey, m: THREE.MeshStandardMaterial): void => {
    matOf.set(key, m);
    disposables.push(m);
  };
  make('skin', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
  make('cloth', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, normalMap: o === 'sweater' || o === 'turtleneck' ? tex.knit : tex.weave, normalScale: new THREE.Vector2(0.45, 0.45) }));
  make('hatCloth', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, normalMap: hat === 'beanie' ? tex.knit : tex.weave, normalScale: new THREE.Vector2(0.4, 0.4) }));
  make('shiny', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: o === 'puffer' ? 0.42 : 0.36, metalness: 0.05 }));
  make('metal', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.75 }));
  make('face', new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.55 }));
  make('hair', new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.strands, roughness: 0.62 }));
  make('glossy', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.2 }));

  // The body: one skinned mesh per material.
  const boneList = BONE_NAMES.map((n) => bones.get(n)!);
  const skeleton = new THREE.Skeleton(boneList);
  for (const [key, parts] of b.body) {
    const geos = parts.map((p) => {
      const g = p.geo;
      const n = g.getAttribute('position').count;
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const tmp = v3();
      for (let i = 0; i < n; i++) {
        if (typeof p.bind === 'string') {
          si[i * 4] = BONE_INDEX.get(p.bind)!;
          sw[i * 4] = 1;
        } else {
          const [a, c, t] = p.bind(tmp.fromBufferAttribute(pos, i));
          si[i * 4] = BONE_INDEX.get(a)!;
          si[i * 4 + 1] = BONE_INDEX.get(c)!;
          sw[i * 4] = 1 - t;
          sw[i * 4 + 1] = t;
        }
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      return g;
    });
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    disposables.push(merged);
    const mesh = new THREE.SkinnedMesh(merged, matOf.get(key));
    mesh.castShadow = opts.castShadows;
    mesh.bind(skeleton, new THREE.Matrix4());
    // Posed, a seated player stays well inside this (hips at the middle of the chair).
    mesh.boundingSphere = new THREE.Sphere(v3(0, 0.45, 0.25), 1.55);
    mesh.frustumCulled = true;
    root.add(mesh);
  }
  disposables.push({ dispose: () => skeleton.dispose() });

  // The head: rigid on its bone.
  const headBone = bones.get('head')!;
  for (const [key, geos] of b.head) {
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    disposables.push(merged);
    const mesh = new THREE.Mesh(merged, matOf.get(key));
    mesh.castShadow = opts.castShadows;
    headBone.add(mesh);
  }
  const lids = lidsPivot;
  const lidMesh = new THREE.Mesh(lidGeo, matOf.get('face'));
  // The lids sample the face's plain skin.
  const luv = lidGeo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < luv.count; i++) luv.setXY(i, PLAIN_SKIN_UV[0], PLAIN_SKIN_UV[1]);
  disposables.push(lidGeo);
  lids.add(lidMesh);
  headBone.add(lids);
  lids.rotation.x = LID_OPEN;
  for (const [key, m] of matOf) if (!b.body.has(key) && !b.head.has(key) && key !== 'face') m.dispose();
  return { bones, disposables, lids };
}

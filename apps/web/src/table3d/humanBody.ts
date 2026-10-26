import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// A person, built in code: the house dealer (standing, rigged and animated
// — houseDealer.ts) and the players sitting at the table (players3d.ts).
// Smooth, rounded shapes on a skeleton: capsules for limbs, a lathed torso,
// hands with fingers, a face with eyes, brows, nose and mouth. Every body
// part hangs off a bone; at the end the parts on each bone that share a
// material are merged into one mesh, so a whole person is a dozen-odd draw
// calls, not a hundred. Sizes are table units (about half a metre).

export const BONE_NAMES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderR',
  'upperArmR',
  'foreArmR',
  'handR',
  'shoulderL',
  'upperArmL',
  'foreArmL',
  'handL',
] as const;
export type BoneName = (typeof BONE_NAMES)[number];

export interface BodyStyle {
  skin: string;
  shirt: string;
  /** A waistcoat over the shirt (the house dealer's), or none. */
  vest: string | null;
  trim: string;
  trousers: string;
  hair: string;
  hairStyle: 'short' | 'long' | 'cropped';
  bowTie: boolean;
  /** Sitting (legs bent under the table) or standing. */
  seated: boolean;
  /** A trimmed moustache. */
  moustache?: boolean;
  /** The dealer's black elastic sleeve garters. */
  garters?: boolean;
  /** A woman's figure and face: a narrower waist and shoulders, a skirt, lashes, colour on the lips. */
  feminine?: boolean;
  /** Lip colour (feminine). */
  lipColor?: string;
}

// Small textures made once and shared by every person at the table: the
// weave of a shirt, the strands of hair, the faint variation of skin. Each
// is 128px — a few dozen KB of GPU memory for the lot.
let shared: { weave: THREE.CanvasTexture; strands: THREE.CanvasTexture; skin: THREE.CanvasTexture } | null = null;
function sharedTextures(): NonNullable<typeof shared> {
  if (shared) return shared;
  const make = (draw: (ctx: CanvasRenderingContext2D, n: number) => void, repeat: number, srgb: boolean): THREE.CanvasTexture => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    draw(c.getContext('2d')!, 128);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  let seed = 12345;
  const rand = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  shared = {
    // A fine cotton weave, as a normal map: alternating warp and weft ridges.
    weave: make((ctx, n) => {
      ctx.fillStyle = 'rgb(128,128,255)';
      ctx.fillRect(0, 0, n, n);
      for (let y = 0; y < n; y += 4) {
        for (let x = 0; x < n; x += 4) {
          const across = ((x + y) / 4) % 2 === 0;
          ctx.fillStyle = across ? 'rgb(150,128,240)' : 'rgb(128,150,240)';
          ctx.fillRect(x, y, 3, 3);
        }
      }
    }, 10, false),
    // Hair: long strands, light and dark, as a colour multiplier.
    strands: make((ctx, n) => {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(0, 0, n, n);
      for (let i = 0; i < 420; i++) {
        const x = rand() * n;
        const shade = Math.floor(100 + rand() * 155);
        ctx.strokeStyle = `rgba(${String(shade)},${String(shade)},${String(shade)},0.55)`;
        ctx.lineWidth = 0.6 + rand();
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + (rand() - 0.5) * 10, n * 0.33, x + (rand() - 0.5) * 10, n * 0.66, x + (rand() - 0.5) * 6, n);
        ctx.stroke();
      }
    }, 3, true),
    // Skin: soft mottling and pores, barely there.
    skin: make((ctx, n) => {
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(0, 0, n, n);
      for (let i = 0; i < 900; i++) {
        const v = Math.floor(228 + rand() * 27);
        ctx.fillStyle = `rgba(${String(v)},${String(v - 4)},${String(v - 6)},0.14)`;
        ctx.beginPath();
        ctx.arc(rand() * n, rand() * n, 0.6 + rand() * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }, 2, true),
  };
  return shared;
}

interface Part {
  bone: BoneName;
  mat: THREE.Material;
  geo: THREE.BufferGeometry;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

/**
 * Builds a person under `root`: returns its bones by name (in their rest
 * pose — callers pose them) and everything to dispose.
 */
export function buildHumanBody(
  root: THREE.Object3D,
  style: BodyStyle,
  castShadows: boolean,
): { bones: Map<BoneName, THREE.Bone>; disposables: { dispose: () => void }[]; winkLid: THREE.Mesh | null } {
  const disposables: { dispose: () => void }[] = [];
  const mat = (color: string, roughness: number, metalness = 0): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    disposables.push(m);
    return m;
  };
  const tex = sharedTextures();
  const skin = mat(style.skin, 0.52);
  skin.map = tex.skin;
  const shirt = mat(style.shirt, 0.8);
  shirt.normalMap = tex.weave;
  shirt.normalScale.set(0.35, 0.35);
  // A waistcoat's satin back sheen.
  const vest = style.vest ? mat(style.vest, 0.34, 0.12) : null;
  if (vest) {
    vest.normalMap = tex.weave;
    vest.normalScale.set(0.15, 0.15);
  }
  const trim = mat(style.trim, 0.45);
  const trousers = mat(style.trousers, 0.8);
  trousers.normalMap = tex.weave;
  trousers.normalScale.set(0.25, 0.25);
  const hair = mat(style.hair, 0.7);
  hair.map = tex.strands;
  const dark = mat('#141012', 0.4);
  const eyeWhite = mat('#f4f1ec', 0.3);
  const lips = mat(style.lipColor ?? '#a8574d', style.feminine ? 0.32 : 0.5);
  const fem = !!style.feminine;
  const gold = mat('#d4a52c', 0.3, 0.85);

  const bones = new Map<BoneName, THREE.Bone>();
  const bone = (name: BoneName, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones.set(name, b);
    return b;
  };
  const parts: Part[] = [];
  /** A shape on a bone: placed (and turned, and stretched) in the bone's own space. */
  const part = (
    boneName: BoneName,
    geo: THREE.BufferGeometry,
    m: THREE.Material,
    pos: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    scale: [number, number, number] = [1, 1, 1],
  ): void => {
    tmpE.set(rot[0], rot[1], rot[2]);
    tmpQ.setFromEuler(tmpE);
    tmpM.compose(new THREE.Vector3(...pos), tmpQ, new THREE.Vector3(...scale));
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(tmpM);
    geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    parts.push({ bone: boneName, mat: m, geo: g });
  };
  const capsule = (r: number, len: number): THREE.BufferGeometry => new THREE.CapsuleGeometry(r, len, 8, 20);
  const sphere = (r: number, w = 28, h = 20): THREE.BufferGeometry => new THREE.SphereGeometry(r, w, h);

  // --- The skeleton (same proportions sitting or standing; a seated body's hips sit on the chair). ---
  const hips = bone('hips', root, 0, style.seated ? 0 : 0.32, 0);
  const spine = bone('spine', hips, 0, 0.12, 0);
  const chest = bone('chest', spine, 0, 0.3, 0);
  const neck = bone('neck', chest, 0, 0.62, 0);
  bone('head', neck, 0, 0.14, 0);
  for (const side of ['R', 'L'] as const) {
    const sx = side === 'R' ? -1 : 1;
    const shoulder = bone(`shoulder${side}`, chest, sx * (style.feminine ? 0.285 : 0.33), 0.5, 0);
    const upper = bone(`upperArm${side}`, shoulder, 0, 0, 0);
    const fore = bone(`foreArm${side}`, upper, 0, -0.58, 0);
    bone(`hand${side}`, fore, 0, -0.52, 0);
  }

  // --- Lower body. ---
  part('hips', sphere(0.3, 28, 16), trousers, [0, 0.02, 0], [0, 0, 0], [1, 0.62, 0.72]);
  for (const sx of [-1, 1]) {
    if (style.seated) {
      // Thighs forward along the seat, shins down to the floor.
      part('hips', capsule(0.11, 0.55), trousers, [sx * 0.15, -0.02, 0.36], [Math.PI / 2, 0, 0]);
      part('hips', capsule(0.09, 0.72), trousers, [sx * 0.15, -0.5, 0.66]);
      part('hips', new RoundedBoxGeometry(0.16, 0.08, 0.3, 2, 0.03), dark, [sx * 0.15, -0.94, 0.74]);
    } else if (fem) {
      // Legs below the skirt, and heels.
      part('hips', capsule(0.075, 0.82), skin, [sx * 0.12, -1.2, 0]);
      part('hips', new RoundedBoxGeometry(0.11, 0.07, 0.26, 2, 0.03), dark, [sx * 0.12, -1.83, 0.05]);
    } else {
      part('hips', capsule(0.12, 0.72), trousers, [sx * 0.15, -0.55, 0]);
      part('hips', capsule(0.095, 0.72), trousers, [sx * 0.15, -1.32, 0]);
      part('hips', new RoundedBoxGeometry(0.16, 0.08, 0.32, 2, 0.03), dark, [sx * 0.15, -1.85, 0.06]);
    }
  }
  // A fitted pencil skirt to just below the knee.
  if (fem && !style.seated) part('hips', new THREE.CylinderGeometry(0.29, 0.23, 0.95, 28), trousers, [0, -0.42, 0], [0, 0, 0], [1, 1, 0.78]);

  // --- Torso: a lathe from waist to shoulders, flattened front to back. ---
  const torsoProfile = fem
    ? [
        new THREE.Vector2(0.0, -0.02),
        new THREE.Vector2(0.29, 0),
        new THREE.Vector2(0.24, 0.24),
        new THREE.Vector2(0.27, 0.48),
        new THREE.Vector2(0.31, 0.66),
        new THREE.Vector2(0.3, 0.8),
        new THREE.Vector2(0.24, 0.93),
        new THREE.Vector2(0.11, 0.99),
        new THREE.Vector2(0.0, 1.0),
      ]
    : [
        new THREE.Vector2(0.0, -0.02),
        new THREE.Vector2(0.27, 0),
        new THREE.Vector2(0.285, 0.18),
        new THREE.Vector2(0.32, 0.45),
        new THREE.Vector2(0.355, 0.7),
        new THREE.Vector2(0.35, 0.82),
        new THREE.Vector2(0.28, 0.93),
        new THREE.Vector2(0.13, 0.99),
        new THREE.Vector2(0.0, 1.0),
      ];
  part('spine', new THREE.LatheGeometry(torsoProfile, 40), shirt, [0, -0.08, 0], [0, 0, 0], [1, 1, 0.64]);
  if (vest) {
    // The waistcoat, open in a V at the front.
    const vp = torsoProfile.slice(0, 7).map((p) => new THREE.Vector2(p.x * 1.035 + 0.004, p.y * 0.86));
    part('spine', new THREE.LatheGeometry(vp, 40, 0.32, Math.PI * 2 - 0.64), vest, [0, -0.09, 0], [0, 0, 0], [1, 1, 0.67]);
    for (const y of [0.18, 0.3, 0.42]) part('spine', sphere(0.016, 12, 8), gold, [0, y, 0.215]);
    // Lapels: the waistcoat's edges turned back either side of the V.
    for (const sx of [-1, 1]) part('spine', new RoundedBoxGeometry(0.05, 0.3, 0.012, 2, 0.005), vest, [sx * 0.07, 0.62, 0.222], [0.1, 0, sx * 0.3]);
    part('spine', new RoundedBoxGeometry(0.12, 0.04, 0.014, 2, 0.006), gold, [0.19, 0.6, 0.2], [0, 0.45, 0]);
  }
  // Collar.
  part('neck', new THREE.CylinderGeometry(0.11, 0.125, 0.07, 28, 1, true), shirt, [0, -0.02, 0]);
  for (const sx of [-1, 1]) part('neck', new THREE.ConeGeometry(0.04, 0.09, 3), shirt, [sx * 0.05, -0.04, 0.09], [Math.PI / 2 - 0.4, 0, sx * 0.6]);
  if (style.bowTie) {
    // Red for her, black otherwise.
    const tie = fem ? lips : dark;
    for (const sx of [-1, 1]) part('neck', new THREE.ConeGeometry(0.038, 0.075, 12), tie, [sx * 0.037, -0.035, 0.115], [0, 0, (sx * -Math.PI) / 2]);
    part('neck', sphere(0.018, 12, 8), tie, [0, -0.035, 0.118]);
  }
  part('neck', capsule(0.07, 0.08), skin, [0, 0.05, 0]);

  // --- Head and face. ---
  part('head', sphere(0.19, 40, 32), skin, [0, 0.17, 0.005], [0, 0, 0], [0.9, 1.08, 1]);
  part('head', sphere(0.14, 28, 20), skin, [0, 0.07, 0.05], [0, 0, 0], [1, 0.8, 0.95]); // jaw
  part('head', sphere(0.05, 16, 12), skin, [0, 0.03, 0.135], [0, 0, 0], [1.1, 0.8, 0.8]); // chin
  part('head', new RoundedBoxGeometry(0.2, 0.03, 0.05, 2, 0.014), skin, [0, 0.232, 0.15], [0.2, 0, 0]); // brow ridge
  for (const sx of [-1, 1]) {
    part('head', sphere(0.04, 16, 12), skin, [sx * 0.172, 0.165, -0.005], [0, 0, 0], [0.5, 1, 0.8]); // ear
    part('head', sphere(0.034, 16, 12), skin, [sx * 0.085, 0.14, 0.138], [0, 0, 0], [1.2, 0.8, 0.8]); // cheekbone
    part('head', sphere(0.025, 16, 12), eyeWhite, [sx * 0.064, 0.2, 0.152]);
    part('head', sphere(0.012, 12, 10), dark, [sx * 0.064, 0.2, 0.174]);
    // Eyelids: a half shell over the top of each eye, so it reads as a look rather than a stare.
    part('head', new THREE.SphereGeometry(0.028, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), skin, [sx * 0.064, 0.2, 0.152], [0.5, 0, 0]);
    part('head', new RoundedBoxGeometry(0.072, 0.016, 0.022, 2, 0.007), hair, [sx * 0.066, 0.243, 0.162], [0.15, 0, sx * -0.14]); // brow
    part('head', sphere(0.011, 10, 8), dark, [sx * 0.013, 0.118, 0.198]); // nostril
  }
  part('head', capsule(0.019, 0.07), skin, [0, 0.16, 0.178], [0.42, 0, 0]); // nose bridge
  part('head', sphere(0.026, 16, 12), skin, [0, 0.128, 0.19]); // nose tip
  part('head', capsule(0.011, 0.045), lips, [0, 0.092, 0.168], [0, 0, Math.PI / 2]); // upper lip
  part('head', capsule(0.013, 0.04), lips, [0, 0.074, 0.165], [0, 0, Math.PI / 2]); // lower lip
  if (style.moustache) part('head', capsule(0.012, 0.07), hair, [0, 0.106, 0.176], [0, 0, Math.PI / 2], [1, 1, 0.8]);
  let winkLid: THREE.Mesh | null = null;
  if (fem) {
    const lash = mat('#121014', 0.5);
    const blush = mat('#e79a92', 0.6);
    for (const sx of [-1, 1]) {
      // Lashes along each upper lid, a soft blush on the cheek.
      part('head', new RoundedBoxGeometry(0.06, 0.008, 0.012, 1, 0.003), lash, [sx * 0.066, 0.214, 0.172], [0.4, 0, sx * -0.18]);
      part('head', sphere(0.03, 12, 10), blush, [sx * 0.092, 0.135, 0.15], [0, 0, 0], [1.2, 0.7, 0.4]);
    }
    // The wink: a closed lid over her right eye (her own right, our left), shown now and then.
    const lidGeo = new THREE.SphereGeometry(0.029, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62);
    disposables.push(lidGeo);
    winkLid = new THREE.Mesh(lidGeo, skin);
    winkLid.position.set(-0.064, 0.2, 0.152);
    winkLid.rotation.x = 1.1;
    winkLid.visible = false;
  }
  // Hair.
  const cap = new THREE.SphereGeometry(0.2, 40, 20, 0, Math.PI * 2, 0, style.hairStyle === 'cropped' ? Math.PI * 0.42 : Math.PI * 0.5);
  part('head', cap, hair, [0, 0.19, -0.012], [-0.28, 0, 0], [0.95, 1.08, 1.04]);
  if (style.hairStyle === 'long') {
    // The back half only (a sphere's -Z side is phi π–2π): it falls behind, never over the face.
    part('head', new THREE.SphereGeometry(0.2, 32, 16, Math.PI * 1.1, Math.PI * 0.8, Math.PI * 0.3, Math.PI * 0.55), hair, [0, 0.13, -0.02], [0, 0, 0], [1.02, 1.3, 1.05]);
  }
  if (fem) {
    // Long, full waves past the shoulders: a mane behind, locks framing the face, a side-swept fringe.
    part('head', new THREE.SphereGeometry(0.21, 32, 20, Math.PI * 1.05, Math.PI * 0.9, Math.PI * 0.25, Math.PI * 0.65), hair, [0, 0.05, -0.03], [0, 0, 0], [1.12, 1.9, 1.1]);
    // Locks falling past the ears to the shoulders, clear of the face.
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        part('head', capsule(0.042 - k * 0.006, 0.24), hair, [sx * (0.2 + k * 0.01), 0.04 - k * 0.075, -0.02 - k * 0.045], [0.1, 0, sx * (0.06 + k * 0.07)]);
      }
    }
  }

  // --- Arms and hands. ---
  for (const side of ['R', 'L'] as const) {
    const sx = side === 'R' ? -1 : 1;
    part(`shoulder${side}`, sphere(fem ? 0.092 : 0.112, 24, 16), shirt, [0, 0, 0]);
    part(`upperArm${side}`, capsule(fem ? 0.068 : 0.085, 0.42), shirt, [0, -0.29, 0]);
    // The dealer's sleeve garter: a black band round the upper arm.
    if (style.garters) part(`upperArm${side}`, new THREE.TorusGeometry(fem ? 0.07 : 0.087, 0.012, 8, 24), dark, [0, -0.3, 0], [Math.PI / 2, 0, 0]);
    part(`foreArm${side}`, sphere(0.082, 20, 14), shirt, [0, 0, 0]);
    part(`foreArm${side}`, capsule(fem ? 0.058 : 0.072, 0.36), shirt, [0, -0.24, 0]);
    part(`foreArm${side}`, new THREE.TorusGeometry(0.066, 0.014, 8, 24), trim, [0, -0.46, 0], [Math.PI / 2, 0, 0]);
    // The hand: a rounded palm, four fingers a little curled, a thumb.
    part(`hand${side}`, new RoundedBoxGeometry(0.11, 0.13, 0.045, 3, 0.02), skin, [0, -0.07, 0]);
    for (let f = 0; f < 4; f++) {
      const fx = (f - 1.5) * 0.026;
      const len = f === 0 || f === 3 ? 0.045 : 0.055;
      part(`hand${side}`, capsule(0.0125, len), skin, [fx, -0.165, 0.008], [0.28, 0, 0]);
    }
    part(`hand${side}`, capsule(0.014, 0.05), skin, [sx * -0.06, -0.08, 0.02], [0.3, 0, sx * 0.7]);
  }

  // Merge each bone's parts by material.
  const groups = new Map<string, Part[]>();
  for (const p of parts) {
    const key = `${p.bone}|${p.mat.uuid}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const merged = mergeGeometries(list.map((p) => p.geo), false);
    for (const p of list) p.geo.dispose();
    if (!merged) continue;
    disposables.push(merged);
    const mesh = new THREE.Mesh(merged, list[0]!.mat);
    mesh.castShadow = castShadows;
    bones.get(list[0]!.bone)!.add(mesh);
  }
  if (winkLid) bones.get('head')!.add(winkLid);
  return { bones, disposables, winkLid };
}

/** Skin, hair and clothes for a seated player, picked from their avatar's hue so each looks like someone. */
export function playerStyle(hue: number, seed: number): BodyStyle {
  const skins = ['#f1c8a5', '#e0ac85', '#c98e65', '#a96f4c', '#7c4f35', '#5a3a28'];
  const hairs = ['#1f1612', '#3a2618', '#6b4428', '#a07a4a', '#cfc6b8', '#121014'];
  const pick = <T,>(list: readonly T[], n: number): T => list[Math.abs(n) % list.length]!;
  return {
    skin: pick(skins, seed),
    shirt: `hsl(${String(hue)}, 38%, 34%)`,
    vest: null,
    trim: `hsl(${String(hue)}, 30%, 24%)`,
    trousers: '#1d1d24',
    hair: pick(hairs, seed >> 3),
    hairStyle: (['short', 'long', 'cropped'] as const)[Math.abs(seed >> 5) % 3]!,
    bowTie: false,
    seated: true,
  };
}

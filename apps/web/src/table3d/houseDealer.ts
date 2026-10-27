import * as THREE from 'three';
import { TIMINGS } from '../animationTimings.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BONE_NAMES, buildHumanBody, type BoneName } from './humanBody.js';
import { cardBackTexture } from './textures.js';

// The HOUSE DEALER: the character standing at the center of the near long
// edge. Fixed in place — it never moves seats, never plays and never
// rotates with the dealer button (that's dealerButton.ts, a separate
// system; the two only meet at hand-start and street events).
//
// A low-poly character built here in code — no model file to download —
// on a real skeleton: every body part hangs off a THREE.Bone, and every
// motion is a keyframed AnimationClip on those bones, played by an
// AnimationMixer with crossfades. A small state machine queues clips (so a
// deal goes seat by seat in deal order) and falls back to the idle loop
// whenever the queue runs dry. Any rigged GLB with the same bone names
// could be swapped in for the body without touching the controller.
//
// Loaded lazily (dynamic import from scene.ts) so the rest of the table
// never waits on it.

type Euler3 = readonly [number, number, number];
type Pose = Partial<Record<BoneName, Euler3>>;



export type DealerClip = 'idle' | 'shuffle' | 'riffle' | 'bridge' | 'cut' | 'burn' | 'deal' | 'flop' | 'turn' | 'river' | 'collect' | 'flourish';

// The resting pose: leaning in slightly over the table, forearms forward,
// hands hovering just above the felt by the rail — degrees, XYZ. For the
// arms (which hang along -Y), a negative X raises them forward; for the
// spine (which points up), a positive X leans forward. The dealer faces
// its own +Z; its right hand is on its -X side.
const REST: Record<BoneName, Euler3> = {
  hips: [0, 0, 0],
  spine: [6, 0, 0],
  chest: [6, 0, 0],
  neck: [4, 0, 0],
  head: [8, 0, 0],
  shoulderR: [0, 0, 0],
  upperArmR: [-22, 0, -6],
  foreArmR: [-62, 0, 4],
  handR: [-8, 0, 0],
  shoulderL: [0, 0, 0],
  upperArmL: [-22, 0, 6],
  foreArmL: [-62, 0, -4],
  handL: [-8, 0, 0],
};

const DEG = Math.PI / 180;
const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();

function quat(e: Euler3): THREE.Quaternion {
  tmpEuler.set(e[0] * DEG, e[1] * DEG, e[2] * DEG, 'XYZ');
  return tmpQuat.setFromEuler(tmpEuler).clone();
}

/** A clip from key poses: each key's bones override the rest pose, so every key is a complete, blendable pose. */
function buildClip(name: string, duration: number, keys: readonly { t: number; pose: Pose }[]): THREE.AnimationClip {
  const used = new Set<BoneName>();
  for (const k of keys) for (const b of Object.keys(k.pose) as BoneName[]) used.add(b);
  const times = keys.map((k) => k.t * duration);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const bone of used) {
    const values: number[] = [];
    for (const k of keys) {
      const q = quat(k.pose[bone] ?? REST[bone]);
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

/** Adds to a rest pose — most clips only nudge a few joints off it. */
function off(bone: BoneName, dx: number, dy = 0, dz = 0): Euler3 {
  const r = REST[bone];
  return [r[0] + dx, r[1] + dy, r[2] + dz];
}

function clipLibrary(): Record<Exclude<DealerClip, 'deal'>, THREE.AnimationClip> {
  const T = TIMINGS;
  return {
    // Idle: breathing, a slow sway of the hips, a tilt of the head this way and that.
    idle: buildClip('idle', 4.2, [
      { t: 0, pose: {} },
      { t: 0.3, pose: { spine: off('spine', 0, 0, 2.5), chest: off('chest', 1.6, 0, -1.5), head: off('head', 0, 6, 7), shoulderR: [0, 0, -1.5], shoulderL: [0, 0, 1.5] } },
      { t: 0.65, pose: { spine: off('spine', 0, 0, -2), chest: off('chest', 0.4, 0, 1.2), head: off('head', 2, -5, -5) } },
      { t: 1, pose: {} },
    ]),
    // A flourish between hands: a hand sweeps up, palm out, with a tilt of the head and a little shimmy.
    flourish: buildClip('flourish', 1.3, [
      { t: 0, pose: {} },
      { t: 0.3, pose: { spine: off('spine', 0, 0, -3), upperArmR: off('upperArmR', -60, 0, -30), foreArmR: off('foreArmR', 40), handR: off('handR', -30, 40, 0), head: off('head', -4, -12, 10) } },
      { t: 0.55, pose: { spine: off('spine', 0, 0, 3), upperArmR: off('upperArmR', -66, 0, -38), foreArmR: off('foreArmR', 46), handR: off('handR', -30, -20, 0), head: off('head', -2, -8, -8) } },
      { t: 0.8, pose: { spine: off('spine', 0, 0, -2), upperArmR: off('upperArmR', -40, 0, -20), foreArmR: off('foreArmR', 20), head: off('head', 0, -4, 6) } },
      { t: 1, pose: {} },
    ]),
    // Overhand shuffle: the left hand holds the deck in the middle, the right lifts and drops packets onto it.
    shuffle: buildClip('shuffle', T.dealerShuffleS, [
      { t: 0, pose: {} },
      ...[0.18, 0.5, 0.82].flatMap((t) => [
        { t, pose: { upperArmR: off('upperArmR', -14, 0, 14), foreArmR: off('foreArmR', -18), upperArmL: off('upperArmL', -6, 0, -12), head: off('head', 6) } },
        { t: t + 0.14, pose: { upperArmR: off('upperArmR', -4, 0, 14), foreArmR: off('foreArmR', -2), upperArmL: off('upperArmL', -6, 0, -12), head: off('head', 6) } },
      ]),
      { t: 1, pose: {} },
    ]),
    // Riffle: hands part with half a deck each, thumbs tip in, and the halves fall together.
    riffle: buildClip('riffle', T.dealerRiffleS, [
      { t: 0, pose: {} },
      { t: 0.3, pose: { upperArmR: off('upperArmR', -6, 0, -10), upperArmL: off('upperArmL', -6, 0, 10), handR: off('handR', -18, 0, 12), handL: off('handL', -18, 0, -12) } },
      { t: 0.7, pose: { upperArmR: off('upperArmR', -4, 0, 6), upperArmL: off('upperArmL', -4, 0, -6), handR: off('handR', 10, 0, -8), handL: off('handL', 10, 0, 8) } },
      { t: 1, pose: {} },
    ]),
    // Bridge: the riffled deck bowed up between both hands and let flow back down.
    bridge: buildClip('bridge', T.dealerBridgeS, [
      { t: 0, pose: {} },
      { t: 0.45, pose: { upperArmR: off('upperArmR', -14, 0, 8), upperArmL: off('upperArmL', -14, 0, -8), foreArmR: off('foreArmR', -10), foreArmL: off('foreArmL', -10), handR: off('handR', 22), handL: off('handL', 22) } },
      { t: 1, pose: {} },
    ]),
    // Cut: the right hand lifts the top half off to the side, then drops the bottom half on it.
    cut: buildClip('cut', T.dealerCutS, [
      { t: 0, pose: {} },
      { t: 0.4, pose: { upperArmR: off('upperArmR', -8, 0, -16), foreArmR: off('foreArmR', 4) } },
      { t: 0.7, pose: { upperArmR: off('upperArmR', -4, 0, -10), upperArmL: off('upperArmL', -8, 0, -12) } },
      { t: 1, pose: {} },
    ]),
    // Burn: one card off the top, face down onto the muck by the right hand.
    burn: buildClip('burn', T.dealerBurnS, [
      { t: 0, pose: {} },
      { t: 0.5, pose: { chest: off('chest', 4, -10), upperArmR: off('upperArmR', -18, 0, -18), foreArmR: off('foreArmR', 6) } },
      { t: 1, pose: {} },
    ]),
    // Flop: three cards pulled out and spread across the board, from his left to his right.
    flop: buildClip('flop', T.dealerFlopS, [
      { t: 0, pose: {} },
      { t: 0.3, pose: { chest: off('chest', 10, 8), upperArmR: off('upperArmR', -44, 0, 22), foreArmR: off('foreArmR', 34), head: off('head', 10) } },
      { t: 0.65, pose: { chest: off('chest', 10, -8), upperArmR: off('upperArmR', -44, 0, -6), foreArmR: off('foreArmR', 34), head: off('head', 10) } },
      { t: 1, pose: {} },
    ]),
    turn: buildClip('turn', T.dealerStreetS, [
      { t: 0, pose: {} },
      // The turn and river land on his right, past the flop.
      { t: 0.5, pose: { chest: off('chest', 10, -4), upperArmR: off('upperArmR', -46, 0, 2), foreArmR: off('foreArmR', 36), head: off('head', 10) } },
      { t: 1, pose: {} },
    ]),
    river: buildClip('river', T.dealerStreetS, [
      { t: 0, pose: {} },
      { t: 0.5, pose: { chest: off('chest', 10, -10), upperArmR: off('upperArmR', -46, 0, -6), foreArmR: off('foreArmR', 36), head: off('head', 10) } },
      { t: 1, pose: {} },
    ]),
    // Collect: both arms reach out over the felt and sweep the cards and chips in.
    collect: buildClip('collect', T.dealerCollectS, [
      { t: 0, pose: {} },
      { t: 0.35, pose: { chest: off('chest', 14), upperArmR: off('upperArmR', -50, 0, -26), upperArmL: off('upperArmL', -50, 0, 26), foreArmR: off('foreArmR', 40), foreArmL: off('foreArmL', 40) } },
      { t: 0.75, pose: { chest: off('chest', 8), upperArmR: off('upperArmR', -30, 0, 8), upperArmL: off('upperArmL', -30, 0, -8), foreArmR: off('foreArmR', 10), foreArmL: off('foreArmL', 10) } },
      { t: 1, pose: {} },
    ]),
  };
}

/** A deal toward `yaw` (degrees, the dealer's own frame: 0 straight ahead, positive to its left): turn, pitch the card with a flick of the wrist, settle. */
function dealClip(yaw: number): THREE.AnimationClip {
  const turn = Math.max(-55, Math.min(55, yaw));
  // The far seats need a longer throw than the two right beside the dealer.
  const reach = 1 - Math.min(1, Math.abs(yaw) / 90);
  return buildClip(`deal_${String(Math.round(yaw))}`, TIMINGS.dealerDealS, [
    { t: 0, pose: {} },
    {
      t: 0.45,
      pose: {
        chest: off('chest', 2, turn * 0.45),
        neck: off('neck', 0, turn * 0.25),
        upperArmR: off('upperArmR', -22 - 18 * reach, turn * 0.3, turn * 0.25),
        foreArmR: off('foreArmR', 22 * reach + 6),
        handR: off('handR', 18),
      },
    },
    { t: 0.62, pose: { chest: off('chest', 2, turn * 0.45), neck: off('neck', 0, turn * 0.25), upperArmR: off('upperArmR', -26 - 22 * reach, turn * 0.3, turn * 0.25), foreArmR: off('foreArmR', 32 * reach + 10), handR: off('handR', -20) } },
    { t: 1, pose: {} },
  ]);
}

interface QueueEntry {
  /** null: a pause (the idle loop keeps playing). */
  clip: THREE.AnimationClip | null;
  duration: number;
  /** Fractions of the way through the clip at which a card leaves the hand (the flop has three). */
  releases: readonly number[];
  onRelease: ((index: number) => void) | null;
}

/** What the scene needs from a house dealer — the character itself, or a stand-in that keeps the same timing while it loads. */
export interface DealerLike {
  readonly busy: boolean;
  play(clip: DealerClip, opts?: { yaw?: number; onRelease?: (index: number) => void; releases?: readonly number[] }): void;
  wait(seconds: number): void;
  flush(): void;
  rightHandWorld(out: THREE.Vector3): THREE.Vector3;
  update(dt: number): void;
  dispose(): void;
}

const DEFAULT_RELEASES: Partial<Record<DealerClip, readonly number[]>> = {
  deal: [0.6],
  burn: [0.5],
  flop: [0.3, 0.48, 0.66],
  turn: [0.5],
  river: [0.5],
};

const CLIP_SECONDS: Record<DealerClip, number> = {
  idle: 3.2,
  shuffle: TIMINGS.dealerShuffleS,
  riffle: TIMINGS.dealerRiffleS,
  bridge: TIMINGS.dealerBridgeS,
  cut: TIMINGS.dealerCutS,
  burn: TIMINGS.dealerBurnS,
  deal: TIMINGS.dealerDealS,
  flop: TIMINGS.dealerFlopS,
  turn: TIMINGS.dealerStreetS,
  river: TIMINGS.dealerStreetS,
  collect: TIMINGS.dealerCollectS,
  flourish: 1.3,
};

/**
 * The same queue and timing with no body — used until the character has
 * loaded, so cards still leave "the hand" on cue from the dealer's spot.
 */
export class GhostDealer implements DealerLike {
  private readonly queue: QueueEntry[] = [];
  private current: { entry: QueueEntry; elapsed: number; fired: number } | null = null;
  private readonly hand: THREE.Vector3;
  private speed = 1;

  constructor(hand: THREE.Vector3) {
    this.hand = hand.clone();
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  play(clip: DealerClip, opts: { yaw?: number; onRelease?: (index: number) => void; releases?: readonly number[] } = {}): void {
    this.queue.push({ clip: null, duration: CLIP_SECONDS[clip], releases: opts.releases ?? DEFAULT_RELEASES[clip] ?? [], onRelease: opts.onRelease ?? null });
    if (!this.current) this.next();
  }

  wait(seconds: number): void {
    this.queue.push({ clip: null, duration: seconds, releases: [], onRelease: null });
    if (!this.current) this.next();
  }

  flush(): void {
    flushQueue(this.current, this.queue);
    this.speed = 4;
  }

  rightHandWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.hand);
  }

  update(dt: number): void {
    const cur = this.current;
    if (!cur) return;
    cur.elapsed += dt * this.speed;
    fireReleases(cur);
    if (cur.elapsed >= cur.entry.duration) this.next();
  }

  private next(): void {
    const entry = this.queue.shift();
    this.current = entry ? { entry, elapsed: 0, fired: 0 } : null;
    this.speed = 1;
  }

  dispose(): void {
    this.queue.length = 0;
    this.current = null;
  }
}

function fireReleases(cur: { entry: QueueEntry; elapsed: number; fired: number }): void {
  const { releases, duration, onRelease } = cur.entry;
  while (cur.fired < releases.length && cur.elapsed >= duration * releases[cur.fired]!) {
    onRelease?.(cur.fired);
    cur.fired++;
  }
}

/** Fires every release still owed (so no card is left in the deck) and empties the queue. */
function flushQueue(current: { entry: QueueEntry; fired: number } | null, queue: QueueEntry[]): void {
  const pending = queue.splice(0);
  if (current) {
    while (current.fired < current.entry.releases.length) current.entry.onRelease?.(current.fired++);
  }
  for (const e of pending) e.releases.forEach((_, i) => e.onRelease?.(i));
}

/**
 * Which of the bones the dealer's moves drive a character's bone is, by
 * name — whatever the rig's naming style: Mixamo (mixamorig:RightArm),
 * Blender/Rigify (upper_arm.R), Unreal (upperarm_r), VRM/VRoid
 * (J_Bip_R_UpperArm) and the like.
 */
export function boneRole(raw: string): string | null {
  const n = raw
    .replace(/^mixamorig\d*:?/i, '')
    .replace(/^(j_bip_|def-|bip0?1_?|armature_?)/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const centre: Record<string, string> = { spine: 'Spine', spine01: 'Spine', spine1: 'Spine', spine2: 'Spine2', spine02: 'Spine2', spine03: 'Spine2', chest: 'Spine2', upperchest: 'Spine2', neck: 'Neck', neck01: 'Neck', head: 'Head' };
  const limb: Record<string, string> = { arm: 'Arm', upperarm: 'Arm', forearm: 'ForeArm', lowerarm: 'ForeArm', hand: 'Hand' };
  if (centre[n]) return centre[n];
  // The side can be a prefix (RightArm, L_Hand) or a suffix (upperarm_r, forearm.L): try each reading.
  for (const [re, at] of [
    [/^(right|left|r|l)(.+)$/, 'prefix'],
    [/^(.+?)(right|left|r|l)$/, 'suffix'],
  ] as const) {
    const m = re.exec(n);
    if (!m) continue;
    const sideWord = at === 'prefix' ? m[1]! : m[2]!;
    const core = at === 'prefix' ? m[2]! : m[1]!;
    const part = limb[core];
    if (part) return `${sideWord.startsWith('r') ? 'Right' : 'Left'}${part}`;
  }
  return null;
}

/** The deck's spot in the left hand (the hand bone's own space): in the palm, along the fingers. */
const DECK_IN_HAND = new THREE.Vector3(0.02, -0.16, 0.06);

/** How the built-in dealer holds it: tilted up in the hand. */
const DECK_TILT = new THREE.Euler(Math.PI / 2 - 0.3, 0, 0);
/** A character palms it: a real deck's size (the model deck is drawn larger), its centre this far below her palm. */
const DECK_HELD_SCALE = 0.62;
const DECK_UNDER_PALM = 0.035;
/** Half the held deck's thickness (the model deck's 0.06, at its held scale). */
const DECK_HELD_HALF_THICKNESS = 0.03 * DECK_HELD_SCALE;

/**
 * How a character sits on the dealer's stool: how far her hips sit below
 * standing, the slope of her thighs and shins (radians from straight down —
 * thighs forward, shins back to the footrest), where the stool's seat is
 * below her hip joints, and its footrest above the floor.
 */
const PERCH = { drop: 0.1, thigh: 0.55, shin: 0.95, seatBelowHips: 0.16, footrest: 0.62 } as const;

/** How strongly a character's own texture glows as a fill light (see loadModel). */
const DEALER_FILL = 0.3;

/** Frees a loaded character's geometry, materials and textures. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

/**
 * A character's left hand, measured once in its bind pose (a T-pose, palms
 * down): which way its fingers point and its palm faces in the hand bone's
 * own space, and each finger's chain of bones with their resting turns.
 */
interface Grip {
  hand: THREE.Bone;
  /** Wrist to the middle knuckle, hand-local, and how long that is (world). */
  along: THREE.Vector3;
  palmLength: number;
  /** Out of the palm, hand-local. */
  palm: THREE.Vector3;
  fingers: { bones: THREE.Bone[]; rest: THREE.Quaternion[]; bends: readonly number[]; thumb: boolean }[];
  /**
   * An auto-rig's reduced hand (stub fingers, its hand skinned to the
   * forearm): turning the hand bone wouldn't move her hand, so she holds the
   * deck from above, her palm over it, where her hand really is.
   */
  stub: boolean;
}

/** Each finger's bend at its three joints, degrees: curled round the deck's far edge; the thumb lies along its side. */
const FINGER_BENDS: Record<string, readonly number[]> = {
  index: [38, 48, 30],
  middle: [46, 52, 32],
  ring: [52, 54, 32],
  pinky: [58, 56, 30],
  thumb: [14, 18, 12],
};

/**
 * Where her left hand holds the deck, in the dealer's own space (she faces
 * +Z, her left is +X): in front of her, fingers pointing across her body
 * and a little forward, palm up and tipped toward the table — so the deck's
 * back faces the players, not the ceiling.
 */
const GRIP_ALONG = new THREE.Vector3(-0.72, 0.05, 0.69).normalize();
const GRIP_PALM = new THREE.Vector3(-0.12, 0.8, 0.58);
/** The deck turned on her palm (radians about the palm's normal): diagonal, the way it sits in a real grip. */
const DECK_ON_PALM_TURN = -0.32;
/** A palm's length, wrist to knuckles (world units — the dealer stands about 3.4 tall). */
const MIN_PALM = 0.16;

function gripFor(hand: THREE.Bone, root: THREE.Object3D): Grip | null {
  root.updateMatrixWorld(true);
  const kids = hand.children.filter((c): c is THREE.Bone => (c as THREE.Bone).isBone);
  const middle = kids.find((b) => /middle/i.test(b.name)) ?? kids.find((b) => /index/i.test(b.name));
  if (!middle) return null;
  const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
  const inv = handQ.clone().invert();
  const w = hand.getWorldPosition(new THREE.Vector3());
  const m = middle.getWorldPosition(new THREE.Vector3());
  const palmLength = m.distanceTo(w);
  if (!(palmLength >= 0)) return null;
  // Knuckles almost at the wrist (an auto-rig's stub fingers): the hand carries on along the forearm instead.
  const forearm = hand.parent?.getWorldPosition(new THREE.Vector3());
  const stub = m.distanceTo(w) < MIN_PALM * 0.4 && !!forearm;
  const alongWorld = stub ? w.clone().sub(forearm).normalize() : m.sub(w).normalize();
  const along = alongWorld.clone().applyQuaternion(inv);
  // Out of the palm: for a left hand, fingers × the thumb's side (whatever pose the file was rigged in).
  // Without a thumb, the bind pose's palms facing the floor.
  const thumb = kids.find((b) => /thumb/i.test(b.name));
  const palm = thumb
    ? new THREE.Vector3().crossVectors(alongWorld, thumb.getWorldPosition(new THREE.Vector3()).sub(w)).applyQuaternion(inv)
    : new THREE.Vector3(0, -1, 0).applyQuaternion(inv);
  palm.sub(along.clone().multiplyScalar(palm.dot(along))).normalize();
  const fingers: Grip['fingers'] = [];
  for (const k of kids) {
    const kind = Object.keys(FINGER_BENDS).find((f) => k.name.toLowerCase().includes(f));
    if (!kind) continue;
    const bones: THREE.Bone[] = [];
    let b: THREE.Bone | undefined = k;
    while (b && bones.length < 3) {
      bones.push(b);
      b = b.children.find((c): c is THREE.Bone => (c as THREE.Bone).isBone);
    }
    fingers.push({ bones, rest: bones.map((x) => x.quaternion.clone()), bends: FINGER_BENDS[kind]!, thumb: kind === 'thumb' });
  }
  // A rig with stub fingers (an auto-rig's reduced hand) has its knuckle bones almost at the wrist: a real palm's length instead.
  return { hand, along, palmLength: Math.max(palmLength, MIN_PALM), palm, fingers, stub };
}

const gq = new THREE.Quaternion();
const gq2 = new THREE.Quaternion();
const gv = new THREE.Vector3();
const gv2 = new THREE.Vector3();
const gv3 = new THREE.Vector3();
const gm = new THREE.Matrix4();
const gm2 = new THREE.Matrix4();

/** A rotation taking the basis (a, b, a×b) onto (c, d, c×d) — a and b, c and d each orthonormal. */
function basisTurn(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  gm.makeBasis(a, b, gv3.crossVectors(a, b));
  gm2.makeBasis(c, d, new THREE.Vector3().crossVectors(c, d));
  return out.setFromRotationMatrix(gm2.multiply(gm.transpose()));
}

/** Sets a bone's world rotation (its parent's world matrix up to date). */
function setWorldQuaternion(b: THREE.Object3D, q: THREE.Quaternion): void {
  const parent = b.parent ? b.parent.getWorldQuaternion(gq2).invert() : gq2.identity();
  b.quaternion.copy(parent.multiply(q));
  b.updateMatrixWorld(true);
}

/** Puts her hand and fingers in the grip; returns where the deck goes (world) and how it's turned. */
function applyGrip(g: Grip, root: THREE.Object3D): { center: THREE.Vector3; rotation: THREE.Quaternion } {
  const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
  if (g.stub) {
    // Her hand carries on along her forearm; the deck lies under its palm, its back tipped toward the table.
    const wrist = g.hand.getWorldPosition(new THREE.Vector3());
    const along = gv.copy(g.along).applyQuaternion(g.hand.getWorldQuaternion(gq)).setY(0).normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ), 0.35).normalize();
    const deckAlong = along.clone().addScaledVector(up, -along.dot(up)).normalize();
    const center = wrist.addScaledVector(deckAlong, g.palmLength * 0.4).addScaledVector(up, -(DECK_HELD_HALF_THICKNESS + 0.035));
    return { center, rotation: basisTurn(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), up, deckAlong, new THREE.Quaternion()) };
  }
  const along = GRIP_ALONG.clone().applyQuaternion(rootQ);
  const palm = GRIP_PALM.clone().applyQuaternion(rootQ);
  palm.sub(gv.copy(along).multiplyScalar(palm.dot(along))).normalize();
  // The hand: its own fingers-and-palm axes onto the grip's.
  setWorldQuaternion(g.hand, basisTurn(g.along, g.palm, along, palm, new THREE.Quaternion()));
  // Each finger from its rest pose, bent joint by joint toward the palm.
  for (const f of g.fingers) {
    f.bones.forEach((b, i) => b.quaternion.copy(f.rest[i]!));
    for (let i = 0; i < f.bones.length; i++) {
      const b = f.bones[i]!;
      b.updateMatrixWorld(true);
      const wq = b.getWorldQuaternion(new THREE.Quaternion());
      const dir = gv2.set(0, 1, 0).applyQuaternion(wq);
      const axis = gv.crossVectors(dir, palm);
      if (axis.lengthSq() < 1e-6) continue;
      axis.normalize();
      setWorldQuaternion(b, gq.setFromAxisAngle(axis, (f.bends[i] ?? 0) * DEG).multiply(wq));
    }
  }
  // The deck on her palm: its middle a little past the palm's middle, resting on it.
  const wrist = g.hand.getWorldPosition(new THREE.Vector3());
  const center = wrist
    .addScaledVector(along, g.palmLength * 0.62)
    .addScaledVector(palm, DECK_HELD_HALF_THICKNESS + 0.012);
  const deckAlong = along.clone().applyAxisAngle(palm, DECK_ON_PALM_TURN);
  // The deck box: its thickness on local Y, its length on local Z.
  const rotation = basisTurn(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), palm, deckAlong, new THREE.Quaternion());
  return { center, rotation };
}

/** Back to her own resting fingers (the deck's been put down). */
function releaseGrip(g: Grip): void {
  for (const f of g.fingers) f.bones.forEach((b, i) => b.quaternion.copy(f.rest[i]!));
}

export class HouseDealer implements DealerLike {
  readonly root = new THREE.Group();
  private readonly bones = new Map<BoneName, THREE.Bone>();
  private readonly mixer: THREE.AnimationMixer;
  private readonly clips: Record<Exclude<DealerClip, 'deal'>, THREE.AnimationClip>;
  private readonly dealClips = new Map<number, THREE.AnimationClip>();
  private readonly idleAction: THREE.AnimationAction;
  private current: { entry: QueueEntry; action: THREE.AnimationAction | null; elapsed: number; fired: number } | null = null;
  private readonly queue: QueueEntry[] = [];
  private readonly disposables: { dispose: () => void }[] = [];
  private readonly deck: THREE.Mesh;
  private speed = 1;
  private winkLid: THREE.Mesh | null = null;
  private clock = 0;

  constructor(castShadows: boolean) {
    this.castShadows = castShadows;
    this.buildBody(castShadows);
    this.deck = this.buildDeck();
    this.mixer = new THREE.AnimationMixer(this.root);
    this.clips = clipLibrary();
    this.idleAction = this.mixer.clipAction(this.clips.idle);
    this.idleAction.play();
  }

  // --- The look: a real character model, driven by this skeleton. ---
  //
  // A table's chosen character (public/models/dealers — Mixamo
  // characters, see DECISIONS.md) is a full model on its own skeleton,
  // which follows the one built here: every frame, each of her spine,
  // neck, head and arm bones is turned to point the way the matching bone
  // here points, so all the dealer's clips (shuffle, deal, collect…) play on
  // her unchanged and stay in step with the cards. The code-built body stays
  // hidden behind her — and comes back if the model can't load.

  /** Her bones by our names, in parent-before-child order, and which way each of ours points along its length. */
  private model: {
    root: THREE.Object3D;
    pairs: { mine: THREE.Bone; theirs: THREE.Bone; down: boolean }[];
    /** Her wrists: the deck sits in her left hand, cards leave from her right. */
    handL: THREE.Bone | null;
    handR: THREE.Bone | null;
    /** How her left hand holds the deck (null: a rig without finger bones — she palms it). */
    grip: Grip | null;
  } | null = null;

  private readonly castShadows: boolean;
  /** The character file showing (or loading) now; null for the built-in body. */
  private modelUrl: string | null = null;

  /**
   * Shows a character — a Mixamo download (.fbx) or a .glb, from
   * public/models/dealers — or, with null, the built-in body. A newer call
   * wins over one still loading; a file that won't load leaves the
   * built-in body showing.
   */
  setModel(url: string | null): void {
    if (url === this.modelUrl) return;
    this.modelUrl = url;
    this.dropModel();
    if (url) void this.loadModel(url);
  }

  private dropModel(): void {
    if (this.stool) {
      this.root.remove(this.stool);
      disposeTree(this.stool);
      this.stool = null;
    }
    if (this.model) {
      this.root.remove(this.model.root);
      disposeTree(this.model.root);
      this.model = null;
    }
    this.showBuiltIn(true);
  }

  private stool: THREE.Group | null = null;

  /**
   * A character sits, perched on a tall bar stool the way a dealer does —
   * high enough to see and reach the whole table: hips a little lower than
   * standing, thighs sloping down so the knees tuck under the table's edge,
   * shins back to the stool's footrest. Her own leg bones (the dealing moves
   * only drive her spine and arms), set once; a rig without legs stands.
   */
  private perch(model: THREE.Object3D): void {
    const find = (re: RegExp): THREE.Bone | null => {
      let hit: THREE.Bone | null = null;
      model.traverse((o) => {
        if (!hit && (o as THREE.Bone).isBone && re.test(o.name)) hit = o as THREE.Bone;
      });
      return hit;
    };
    const hips = find(/hips$/i);
    const legs = (['Left', 'Right'] as const).map((side) => ({
      side,
      up: find(new RegExp(`${side}UpLeg$`, 'i')),
      knee: find(new RegExp(`${side}Leg$`, 'i')),
      foot: find(new RegExp(`${side}Foot$`, 'i')),
      toe: find(new RegExp(`${side}ToeBase$`, 'i')),
    }));
    if (!hips || legs.some((l) => !l.up || !l.knee || !l.foot)) return;
    model.position.y -= PERCH.drop;
    this.root.updateMatrixWorld(true);
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const world = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).normalize().applyQuaternion(rootQ);
    // Turns a bone so its child lies along `dir` (world).
    const aimAt = (b: THREE.Bone, child: THREE.Bone, dir: THREE.Vector3): void => {
      const from = child.getWorldPosition(new THREE.Vector3()).sub(b.getWorldPosition(new THREE.Vector3())).normalize();
      const wq = new THREE.Quaternion().setFromUnitVectors(from, dir).multiply(b.getWorldQuaternion(new THREE.Quaternion()));
      const parent = b.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
      b.quaternion.copy(parent.multiply(wq));
      b.updateMatrixWorld(true);
    };
    for (const { side, up, knee, foot, toe } of legs) {
      // Her left is her own +X (she faces +Z).
      const sx = side === 'Left' ? 1 : -1;
      aimAt(up!, knee!, world(sx * 0.1, -Math.cos(PERCH.thigh), Math.sin(PERCH.thigh)));
      aimAt(knee!, foot!, world(sx * 0.04, -Math.cos(PERCH.shin), -Math.sin(PERCH.shin)));
      if (toe) aimAt(foot!, toe, world(0, -0.35, 1));
    }
    // The stool, under her: its seat just below her hips, set back a little.
    const hip = this.root.worldToLocal(hips.getWorldPosition(new THREE.Vector3()));
    const seatTop = hip.y - PERCH.seatBelowHips;
    const floor = -1.56;
    const g = new THREE.Group();
    const chrome = new THREE.MeshStandardMaterial({ color: '#c3c6cc', roughness: 0.22, metalness: 0.95 });
    const leather = new THREE.MeshStandardMaterial({ color: '#1c1416', roughness: 0.5 });
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number): void => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, y, hip.z - 0.12);
      m.castShadow = this.castShadows;
      g.add(m);
    };
    part(new THREE.CylinderGeometry(0.34, 0.31, 0.12, 28), leather, seatTop - 0.06);
    part(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 28), chrome, seatTop - 0.135);
    part(new THREE.CylinderGeometry(0.05, 0.05, seatTop - 0.15 - floor, 12), chrome, (seatTop - 0.15 + floor) / 2);
    const ring = new THREE.TorusGeometry(0.3, 0.025, 8, 32);
    ring.rotateX(Math.PI / 2);
    part(ring, chrome, floor + PERCH.footrest);
    part(new THREE.CylinderGeometry(0.36, 0.4, 0.05, 28), chrome, floor + 0.025);
    this.stool = g;
    this.root.add(g);
  }

  /** The built-in body's meshes (the deck in hand stays either way). */
  private showBuiltIn(on: boolean): void {
    for (const b of this.bones.values()) {
      for (const child of b.children) if ((child as THREE.Mesh).isMesh && child !== this.deck) child.visible = on;
    }
  }

  private async loadModel(url: string): Promise<void> {
    let model: THREE.Object3D;
    try {
      model = url.toLowerCase().endsWith('.fbx') ? await new FBXLoader().loadAsync(url) : (await new GLTFLoader().loadAsync(url)).scene;
    } catch {
      return; // The built-in dealer carries on.
    }
    if (this.disposedFlag || url !== this.modelUrl) {
      disposeTree(model);
      return;
    }
    // An exported file can carry the lights and cameras of the scene it came from (one at 1000 cd floods
    // the whole table white): the room lights her, so they go.
    const strays: THREE.Object3D[] = [];
    model.traverse((o) => {
      if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) strays.push(o);
    });
    for (const o of strays) o.removeFromParent();
    // A real person's height in table units (about 1.7 m), feet on the floor.
    const box = new THREE.Box3().setFromObject(model);
    const height = box.max.y - box.min.y;
    if (!(height > 0)) return;
    model.scale.setScalar(3.4 / height);
    model.position.y = -1.56 - box.min.y * (3.4 / height);
    // A file can hold the same skeleton more than once (a copy per body or clothing piece): every copy is posed.
    const named = new Map<string, THREE.Bone[]>();
    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isMesh) {
        mesh.castShadow = this.castShadows;
        mesh.frustumCulled = false;
        // She stands at the table's edge, outside the lamp's pool: her own colours, full strength, with a soft
        // glow of them on top as a fill light — or a dark texture (an auto-rigged download) reads as a silhouette.
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const lit = m as THREE.MeshPhongMaterial;
          if (!lit.map || !('emissive' in lit)) continue;
          lit.color.set('#ffffff');
          lit.emissive.set('#ffffff');
          lit.emissiveMap = lit.map;
          lit.emissiveIntensity = DEALER_FILL;
          lit.needsUpdate = true;
        }
      }
      if ((o as THREE.Bone).isBone) {
        const key = boneRole(o.name);
        if (key) named.set(key, [...(named.get(key) ?? []), o as THREE.Bone]);
      }
    });
    const map: [BoneName, string, boolean][] = [
      ['spine', 'Spine', false],
      ['chest', 'Spine2', false],
      ['neck', 'Neck', false],
      ['head', 'Head', false],
      ['upperArmR', 'RightArm', true],
      ['foreArmR', 'RightForeArm', true],
      ['handR', 'RightHand', true],
      ['upperArmL', 'LeftArm', true],
      ['foreArmL', 'LeftForeArm', true],
      ['handL', 'LeftHand', true],
    ];
    const pairs = map.flatMap(([mine, theirs, down]) => (named.get(theirs) ?? []).map((t) => ({ mine: this.bones.get(mine)!, theirs: t, down })));
    if (new Set(pairs.map((p) => p.mine)).size < 8) {
      disposeTree(model);
      return;
    }
    this.root.add(model);
    this.perch(model);
    // The built-in body steps aside (its skeleton keeps animating, invisibly, and drives hers).
    this.showBuiltIn(false);
    const handL = named.get('LeftHand')?.[0] ?? null;
    this.model = { root: model, pairs, handL, handR: named.get('RightHand')?.[0] ?? null, grip: handL ? gripFor(handL, this.root) : null };
  }

  /**
   * Whether a ray hits the dealer — a double tap on her opens the owner's
   * dealer picker. Generous on purpose: a tap anywhere on her figure, or
   * just beside it, counts (an invisible column round her, head to waist
   * and a little wider than her shoulders) — a thumb isn't a mouse.
   */
  hit(raycaster: THREE.Raycaster): boolean {
    return raycaster.intersectObject(this.tapZone, false).length > 0;
  }

  private readonly tapZone = (() => {
    const geo = new THREE.CylinderGeometry(0.62, 0.62, 2.6, 12);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.6;
    this.disposables.push(geo, mat);
    this.root.add(m);
    return m;
  })();

  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private disposedFlag = false;

  /** Turns each of her bones to point along ours (parents first, so each child starts from its parent's new pose). */
  private retarget(): void {
    if (!this.model) return;
    this.root.updateMatrixWorld(true);
    for (const { mine, theirs, down } of this.model.pairs) {
      // Where our bone points, in the world.
      const want = this.tmpV.copy(this.up).applyQuaternion(mine.getWorldQuaternion(this.tmpQ));
      if (down) want.negate();
      // Turn hers from where it points now onto that, the shortest way.
      const world = theirs.getWorldQuaternion(this.tmpQ2);
      const now = this.tmpV2.copy(this.up).applyQuaternion(world);
      const turn = new THREE.Quaternion().setFromUnitVectors(now, want.normalize());
      const target = turn.multiply(world);
      const parentWorld = theirs.parent ? theirs.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
      theirs.quaternion.copy(parentWorld.invert().multiply(target));
      theirs.updateMatrixWorld(true);
    }
  }

  /** Whether clips are still queued or playing (anything but idle). */
  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** Queue a clip. For 'deal', `yaw` aims it (see dealClip); `onRelease` fires as each card leaves the hand. */
  play(clip: DealerClip, opts: { yaw?: number; onRelease?: (index: number) => void; releases?: readonly number[] } = {}): void {
    let c: THREE.AnimationClip;
    if (clip === 'deal') {
      const key = Math.round((opts.yaw ?? 0) / 3) * 3;
      let dc = this.dealClips.get(key);
      if (!dc) {
        dc = dealClip(key);
        this.dealClips.set(key, dc);
      }
      c = dc;
    } else {
      c = this.clips[clip];
    }
    this.queue.push({ clip: c, duration: c.duration, releases: opts.releases ?? DEFAULT_RELEASES[clip] ?? [], onRelease: opts.onRelease ?? null });
    if (!this.current) this.next();
  }

  /** A pause in the queue, idling (waiting for the dealer button to finish its slide). */
  wait(seconds: number): void {
    this.queue.push({ clip: null, duration: seconds, releases: [], onRelease: null });
    if (!this.current) this.next();
  }

  /** Drop everything queued (firing their releases at once, so no card is left undealt) — the game moved on. */
  flush(): void {
    flushQueue(this.current, this.queue);
    this.speed = 4;
  }

  /** Where the right hand is in world space — where a dealt card starts its flight (hers, when a character deals). */
  rightHandWorld(out: THREE.Vector3): THREE.Vector3 {
    const hand = this.model?.handR ?? this.bones.get('handR')!;
    return hand.getWorldPosition(out).add(new THREE.Vector3(0, -0.05, 0));
  }

  /**
   * The deck in her left hand. It hangs off the built-in skeleton's hand,
   * but a character's own, differently built arm doesn't end where that one
   * does. With a character showing, she holds it the way a dealer does — the
   * mechanic's grip: palm up in front of her, the deck lying on it at a
   * slight angle, fingers curled round its far edge, thumb along its near
   * side — its back tilted toward the table so every seat can see it in her
   * hand. (A rig without finger bones palms it: flat under her hand.)
   */
  private holdDeck(): void {
    const wrist = this.model?.handL;
    const ours = this.bones.get('handL')!;
    if (!wrist) {
      this.deck.position.copy(DECK_IN_HAND);
      this.deck.quaternion.setFromEuler(DECK_TILT);
      this.deck.scale.setScalar(1);
      return;
    }
    const grip = this.model!.grip;
    ours.updateMatrixWorld(true);
    if (grip && this.deck.visible) {
      const { center, rotation } = applyGrip(grip, this.root);
      this.deck.position.copy(ours.worldToLocal(center));
      this.deck.quaternion.copy(ours.getWorldQuaternion(this.tmpQ).invert().multiply(rotation));
      this.deck.scale.setScalar(DECK_HELD_SCALE);
      return;
    }
    if (grip) releaseGrip(grip);
    const knuckles = wrist.children.filter((c): c is THREE.Bone => (c as THREE.Bone).isBone);
    const palm = wrist.getWorldPosition(this.tmpV);
    const along = this.tmpV2.set(0, 0, 1);
    if (knuckles.length > 0) {
      const k = this.deckTmp.set(0, 0, 0);
      const p = new THREE.Vector3();
      for (const b of knuckles) k.add(b.getWorldPosition(p));
      k.divideScalar(knuckles.length);
      along.copy(k).sub(palm);
      palm.lerp(k, 0.5);
    }
    // Under the palm, touching it.
    palm.y -= DECK_UNDER_PALM;
    this.deck.position.copy(ours.worldToLocal(palm));
    // Flat, its long side (local Z) along the hand.
    const yaw = Math.atan2(along.x, along.z);
    const want = this.deckQ.setFromAxisAngle(this.up, yaw);
    this.deck.quaternion.copy(ours.getWorldQuaternion(this.tmpQ).invert().multiply(want));
    this.deck.scale.setScalar(DECK_HELD_SCALE);
  }

  private readonly deckQ = new THREE.Quaternion();
  private readonly deckTmp = new THREE.Vector3();

  update(dt: number): void {
    this.mixer.update(dt * this.speed);
    this.retarget();
    this.holdDeck();
    // Every ten seconds or so, a quick wink at the table.
    this.clock += dt;
    if (this.winkLid) this.winkLid.visible = this.clock % 10.5 > 10.2;
    const cur = this.current;
    if (!cur) return;
    cur.elapsed += dt * this.speed;
    fireReleases(cur);
    if (cur.elapsed >= cur.entry.duration) this.next();
  }

  private next(): void {
    const entry = this.queue.shift();
    // A flush speeds up only what it found playing; whatever's queued after it plays at normal speed.
    this.speed = 1;
    const fade = TIMINGS.dealerCrossfadeS;
    const from = this.current?.action ?? this.idleAction;
    if (!entry || !entry.clip) {
      // Back to idle — the queue ran dry, or it's a pause.
      if (from !== this.idleAction) {
        this.idleAction.reset().play();
        from.crossFadeTo(this.idleAction, fade, false);
      }
      this.current = entry ? { entry, action: null, elapsed: 0, fired: 0 } : null;
      return;
    }
    const action = this.mixer.clipAction(entry.clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    // The same clip twice in a row (a heads-up deal can aim at one seat twice) just restarts.
    if (from !== action) from.crossFadeTo(action, fade, false);
    this.current = { entry, action, elapsed: 0, fired: 0 };
  }

  dispose(): void {
    this.disposedFlag = true;
    if (this.model) disposeTree(this.model.root);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    for (const d of this.disposables) d.dispose();
  }

  // --- The body: every part hangs off a bone. Sizes in table units (≈ 0.5 m). ---

  private buildBody(castShadows: boolean): void {
    const { bones, disposables, winkLid } = buildHumanBody(
      this.root,
      {
        // An original character: a glamorous blonde dealer in a fitted black satin
        // waistcoat over a white blouse, a red bow tie, sleeve garters, a pencil skirt.
        skin: '#f1c9a8',
        shirt: '#fbf8f2',
        vest: '#111015',
        trim: '#141012',
        trousers: '#111015',
        hair: '#e2c486',
        hairStyle: 'short',
        bowTie: true,
        seated: false,
        garters: true,
        feminine: true,
        lipColor: '#c23347',
      },
      castShadows,
    );
    this.disposables.push(...disposables);
    this.winkLid = winkLid;
    for (const [name, b] of bones) this.bones.set(name, b);
    for (const name of BONE_NAMES) this.bones.get(name)!.quaternion.copy(quat(REST[name]));
  }

  /** The deck, held in the left hand. */
  private buildDeck(): THREE.Mesh {
    const back = cardBackTexture();
    this.disposables.push(back);
    const edge = this.mat(new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.8 }));
    const top = this.mat(new THREE.MeshStandardMaterial({ map: back, roughness: 0.6 }));
    const geo = new THREE.BoxGeometry(0.2, 0.06, 0.28);
    this.disposables.push(geo);
    const deck = new THREE.Mesh(geo, [edge, edge, top, edge, edge, edge]);
    deck.position.copy(DECK_IN_HAND);
    deck.quaternion.setFromEuler(DECK_TILT);
    this.bones.get('handL')!.add(deck);
    return deck;
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.disposables.push(m);
    return m;
  }

  /** Hides or shows the deck (the collect sweep puts it down). */
  set holdingDeck(on: boolean) {
    this.deck.visible = on;
  }
}

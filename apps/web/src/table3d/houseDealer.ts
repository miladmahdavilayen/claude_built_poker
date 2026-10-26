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
    // Flop: three cards pulled out and spread across the board, right to left.
    flop: buildClip('flop', T.dealerFlopS, [
      { t: 0, pose: {} },
      { t: 0.3, pose: { chest: off('chest', 10, -8), upperArmR: off('upperArmR', -44, 0, -6), foreArmR: off('foreArmR', 34), head: off('head', 10) } },
      { t: 0.65, pose: { chest: off('chest', 10, 8), upperArmR: off('upperArmR', -44, 0, 22), foreArmR: off('foreArmR', 34), head: off('head', 10) } },
      { t: 1, pose: {} },
    ]),
    turn: buildClip('turn', T.dealerStreetS, [
      { t: 0, pose: {} },
      { t: 0.5, pose: { chest: off('chest', 10, 4), upperArmR: off('upperArmR', -46, 0, 10), foreArmR: off('foreArmR', 36), head: off('head', 10) } },
      { t: 1, pose: {} },
    ]),
    river: buildClip('river', T.dealerStreetS, [
      { t: 0, pose: {} },
      { t: 0.5, pose: { chest: off('chest', 10, 10), upperArmR: off('upperArmR', -46, 0, 18), foreArmR: off('foreArmR', 36), head: off('head', 10) } },
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
    if (this.model) {
      this.root.remove(this.model.root);
      disposeTree(this.model.root);
      this.model = null;
    }
    this.showBuiltIn(true);
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
    // The built-in body steps aside (its skeleton keeps animating, invisibly, and drives hers).
    this.showBuiltIn(false);
    this.model = { root: model, pairs, handL: named.get('LeftHand')?.[0] ?? null, handR: named.get('RightHand')?.[0] ?? null };
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
   * does — so with a character showing, it's held the way a dealer palms a
   * deck: flat under her palm, the backs against it, long side along her
   * hand, real deck size, so her hand covers it (halfway from her wrist to
   * her knuckles — the hand bone's finger bones — just below them).
   */
  private holdDeck(): void {
    const wrist = this.model?.handL;
    if (!wrist) {
      this.deck.position.copy(DECK_IN_HAND);
      this.deck.quaternion.setFromEuler(DECK_TILT);
      this.deck.scale.setScalar(1);
      return;
    }
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
    const ours = this.bones.get('handL')!;
    ours.updateMatrixWorld(true);
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

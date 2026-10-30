import * as THREE from 'three';
import type { BoneName } from './humanBody.js';
import { avatarLook, buildPlayerAvatar, setBlink, type PlayerAvatar } from './playerAvatar.js';
import type { SeatPlacement3d } from './seatLayout3d.js';

// The other players, sitting at the table: a body in each occupied chair
// (everyone's but your own — you're the one looking), leaning in with
// their forearms on the rail, breathing, glancing about. Their name and
// stack (the DOM layer over the scene) float above their head. Each is
// somebody of their own — face, hair, clothes (playerAvatar.ts) — from their
// avatar colour and seed, so each one stays recognisable.
//
// A player on camera wears it as their face: a screen in the scene itself,
// on their head and turned the way they face (see FaceScreen). So it is
// seen as it would be from your chair — big and square-on across the
// table, narrow from the side, hidden behind the house dealer or another
// player, and from behind not at all: there you see the back of their head.

const FLOOR_Y = -1.56;
const DEG = Math.PI / 180;

/** The seated pose, degrees XYZ per bone (see houseDealer.ts for the axes). */
const SEATED: Partial<Record<BoneName, [number, number, number]>> = {
  spine: [14, 0, 0],
  chest: [8, 0, 0],
  neck: [-6, 0, 0],
  // Looking over the table at the others (not down at their own cards): their faces are what you see.
  head: [-9, 0, 0],
  upperArmR: [-66, 0, -14],
  foreArmR: [-32, 0, 22],
  handR: [10, 0, 0],
  upperArmL: [-66, 0, 14],
  foreArmL: [-32, 0, -22],
  handL: [10, 0, 0],
};

interface Body {
  root: THREE.Group;
  bones: Map<BoneName, THREE.Bone>;
  disposables: { dispose: () => void }[];
  phase: number;
  key: string;
  face: FaceScreen | null;
  /** The viewer's own body: in their own chair, under their eyes. */
  own: boolean;
  avatar: PlayerAvatar;
  /** When the next blink starts (seconds, scene time). */
  nextBlink: number;
}

/** A blink: lids down and up again in this long (seconds). */
const BLINK_S = 0.16;

/** The screen's size, table units (about half a metre): a head and shoulders, 3:4 like the seat boxes' video. */
export const FACE_SCREEN = { width: 0.62, height: 0.82 } as const;
/** Where it sits on the neck bone: the head's middle a little above its own, just in front of the face. */
const FACE_AT = { y: 0.14 + 0.1, z: 0.14 };
const FRAME = 0.024;
/** cos 78°: turned further from you than that, a face is a profile — the head shows instead. */
const FACE_SIDE_ON = 0.2;

/** A rounded-corner mask, shared: white inside, clear at the corners. */
let roundMask: THREE.CanvasTexture | null = null;
function roundedMask(): THREE.CanvasTexture {
  if (roundMask) return roundMask;
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(96, 0, 96, 128, r);
  ctx.arcTo(96, 128, 0, 128, r);
  ctx.arcTo(0, 128, 0, 0, r);
  ctx.arcTo(0, 0, 96, 0, r);
  ctx.fill();
  roundMask = new THREE.CanvasTexture(c);
  return roundMask;
}

/** Off-page <video> elements the screens draw from — kept in the document so phones keep decoding them. */
function videoShelf(): HTMLElement {
  let shelf = document.getElementById('face-screen-videos');
  if (!shelf) {
    shelf = document.createElement('div');
    shelf.id = 'face-screen-videos';
    shelf.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(shelf);
  }
  return shelf;
}

/**
 * A player's camera as a screen in the scene: the video (cropped to fill,
 * like the seat boxes' video), in a thin dark frame, only drawn from the
 * front. Sound isn't here: the seat's own media element plays it.
 */
class FaceScreen {
  readonly group = new THREE.Group();
  readonly stream: MediaStream;
  private readonly video: HTMLVideoElement;
  private readonly texture: THREE.VideoTexture;
  private readonly parts: { dispose: () => void }[] = [];

  constructor(stream: MediaStream) {
    this.stream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    videoShelf().appendChild(video);
    void video.play().catch(() => undefined);
    this.video = video;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.texture = texture;
    video.addEventListener('resize', this.fit);
    video.addEventListener('loadedmetadata', this.fit);

    const { width, height } = FACE_SCREEN;
    const screenGeo = new THREE.PlaneGeometry(width, height);
    const screenMat = new THREE.MeshBasicMaterial({ map: texture, alphaMap: roundedMask(), alphaTest: 0.5, toneMapped: false });
    const frameGeo = new THREE.PlaneGeometry(width + FRAME * 2, height + FRAME * 2);
    const frameMat = new THREE.MeshBasicMaterial({ color: 0x10151c, alphaMap: roundedMask(), alphaTest: 0.5 });
    const screen = new THREE.Mesh(screenGeo, screenMat);
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.z = -0.004;
    screen.name = 'face-screen';
    frame.name = 'face-screen';
    this.group.add(frame, screen);
    this.group.position.set(0, FACE_AT.y, FACE_AT.z);
    this.parts.push(texture, screenGeo, screenMat, frameGeo, frameMat);
  }

  /** Fills the screen with the picture, cropping the overflow — never stretched. */
  private readonly fit = (): void => {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const want = FACE_SCREEN.width / FACE_SCREEN.height;
    const have = vw / vh;
    const t = this.texture;
    if (have > want) {
      t.repeat.set(want / have, 1);
      t.offset.set((1 - want / have) / 2, 0);
    } else {
      t.repeat.set(1, have / want);
      t.offset.set(0, (1 - have / want) / 2);
    }
  };

  dispose(): void {
    this.group.removeFromParent();
    this.video.removeEventListener('resize', this.fit);
    this.video.removeEventListener('loadedmetadata', this.fit);
    this.video.pause();
    this.video.srcObject = null;
    this.video.remove();
    for (const p of this.parts) p.dispose();
  }
}

// --- Arms resting on the table. ---

const UPPER_ARM = 0.58;
const FORE_ARM = 0.52;
const av2 = new THREE.Vector3();
const aq = new THREE.Quaternion();
const aq2 = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);
/** Where each hand rests, in the hips' own space: palm down on the thigh, halfway to the knee. */
const LAP = { out: 0.16, up: 0.13, forward: 0.4 } as const;

/** Turns a bone (which runs along its own -Y) to point along `dir` in the world, the shortest way. */
function aim(bone: THREE.Bone, dir: THREE.Vector3): void {
  const world = bone.getWorldQuaternion(aq);
  const now = av2.copy(DOWN).applyQuaternion(world);
  const target = aq2.setFromUnitVectors(now, dir).multiply(world);
  const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.copy(parent.multiply(target));
  bone.updateMatrixWorld(true);
}

/**
 * A seated player's arms: hands resting palm down on their lap, under the
 * table's edge — nothing of them ever crosses onto the table. A two-bone
 * reach for each hand, the elbow bent back and a little out beside the body.
 */
function restArms(body: Body, place: SeatPlacement3d): void {
  body.root.updateMatrixWorld(true);
  const out = new THREE.Vector3(place.chair.nx, 0, place.chair.nz);
  const hips = body.bones.get('hips')!;
  const centre = hips.getWorldPosition(new THREE.Vector3());
  for (const side of ['R', 'L'] as const) {
    const sx = side === 'R' ? -1 : 1;
    const upper = body.bones.get(`upperArm${side}`)!;
    const fore = body.bones.get(`foreArm${side}`)!;
    const hand = body.bones.get(`hand${side}`)!;
    const shoulder = upper.getWorldPosition(new THREE.Vector3());
    const target = hips.localToWorld(new THREE.Vector3(sx * LAP.out, LAP.up, LAP.forward));
    const toHand = target.clone().sub(shoulder);
    const reach = Math.min(toHand.length(), UPPER_ARM + FORE_ARM - 0.02);
    const dir = toHand.normalize();
    const along = (UPPER_ARM * UPPER_ARM - FORE_ARM * FORE_ARM + reach * reach) / (2 * reach);
    const h = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - along * along));
    // The elbow: back toward the chair and out to the player's side.
    const sideways = shoulder.clone().sub(centre).setY(0).normalize();
    const pole = out.clone().add(sideways.multiplyScalar(0.6));
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const elbow = shoulder.clone().addScaledVector(dir, along).addScaledVector(pole, h);
    const wrist = shoulder.clone().addScaledVector(dir, reach);
    aim(upper, elbow.clone().sub(shoulder).normalize());
    aim(fore, wrist.clone().sub(elbow).normalize());
    // Palm down on the thigh: the hand carries on toward the knee, tipped down a little.
    const forward = target.clone().sub(centre).setY(0).normalize();
    aim(hand, forward.addScaledVector(DOWN, 0.35).normalize());
  }
}

export interface SeatedPlayer {
  seatId: number;
  hue: number;
  seed: number;
  /** Out of the hand: sitting back a little. */
  folded: boolean;
}

export class SeatedPlayers {
  readonly group = new THREE.Group();
  private readonly bodies = new Map<number, Body>();
  private readonly castShadows: boolean;
  private readonly detail: 'high' | 'low';
  /** Who is on camera (seat → their stream), whether or not their body is built yet. */
  private videos = new Map<number, MediaStream>();
  private readonly toCamera = new THREE.Vector3();
  private readonly facePos = new THREE.Vector3();
  private readonly faceNormal = new THREE.Vector3();
  private readonly faceQuat = new THREE.Quaternion();
  private readonly upright = new THREE.Quaternion();
  private readonly yaw = new THREE.Euler();

  constructor(castShadows: boolean, detail: 'high' | 'low' = 'high') {
    this.castShadows = castShadows;
    this.detail = detail;
  }

  /**
   * One body per player at the table — the viewer's own too, in their own
   * chair: seated, the camera is its eyes, so it has no head (you look down
   * at your own chest and arms); standing, you see yourself from behind it.
   */
  sync(placements: ReadonlyMap<number, SeatPlacement3d>, players: readonly SeatedPlayer[], viewerSeatId: number | null): void {
    const wanted = new Set<number>();
    for (const p of players) {
      const place = placements.get(p.seatId);
      if (!place) continue;
      wanted.add(p.seatId);
      const key = `${String(p.hue)}|${String(p.seed)}`;
      let body = this.bodies.get(p.seatId);
      if (body && body.key !== key) {
        this.remove(p.seatId);
        body = undefined;
      }
      if (!body) {
        const root = new THREE.Group();
        const avatar = buildPlayerAvatar(root, avatarLook(p.hue, p.seed), { castShadows: this.castShadows, detail: this.detail });
        body = { root, bones: avatar.bones, disposables: avatar.disposables, phase: (p.seed % 628) / 100, key, face: null, own: false, avatar, nextBlink: (p.seed % 400) / 100 };
        this.bodies.set(p.seatId, body);
        this.group.add(root);
      }
      body.own = p.seatId === viewerSeatId;
      // In the chair, pulled up to the table, facing its middle.
      const inward = 0.12;
      body.root.position.set(place.chair.x - place.chair.nx * inward, FLOOR_Y + 1.0, place.chair.z - place.chair.nz * inward);
      body.root.rotation.y = place.facing;
      const lean = p.folded ? -6 : 0;
      for (const [name, e] of Object.entries(SEATED) as [BoneName, [number, number, number]][]) {
        const b = body.bones.get(name)!;
        b.rotation.set((e[0] + (name === 'spine' ? lean : 0)) * DEG, e[1] * DEG, e[2] * DEG);
      }
      restArms(body, place);
    }
    for (const id of [...this.bodies.keys()]) if (!wanted.has(id)) this.remove(id);
    this.attachFaces();
  }

  /** The players on camera, by seat (the viewer's own is never here: they have no body). */
  /** Seated, the viewer's own body has no head: the camera is where it would be. */
  setOwnHeadless(on: boolean): void {
    this.ownHeadless = on;
  }

  private ownHeadless = true;

  setVideos(videos: ReadonlyMap<number, MediaStream>): void {
    this.videos = new Map(videos);
    this.attachFaces();
  }

  /** Each body gets the screen for its stream — a new one when the stream changes, none when it's gone. */
  private attachFaces(): void {
    for (const [seatId, b] of this.bodies) {
      const stream = this.videos.get(seatId) ?? null;
      if (b.face && b.face.stream === stream) continue;
      b.face?.dispose();
      b.face = null;
      b.bones.get('head')!.visible = true;
      if (!stream) continue;
      b.face = new FaceScreen(stream);
      b.bones.get('neck')!.add(b.face.group);
    }
  }

  /** Whether this seat's player is wearing their camera as a screen. */
  hasFace(seatId: number): boolean {
    return !!this.bodies.get(seatId)?.face;
  }

  /**
   * Breathing, blinking, and an occasional look around — small, so it never distracts.
   * A screen turns with its player's head, and shows only from the front:
   * from behind (`eye` is the camera) the head itself is what you see.
   */
  update(time: number, eye: THREE.Vector3): void {
    const t = time / 1000;
    for (const b of this.bodies.values()) {
      const chest = b.bones.get('chest')!;
      chest.rotation.x = (SEATED.chest![0] + Math.sin(t * 1.3 + b.phase) * 1.2) * DEG;
      const head = b.bones.get('head')!;
      if (b.own) {
        // Your own head turns where you drag, not on its own.
        head.visible = !this.ownHeadless;
        head.rotation.y = 0;
        continue;
      }
      head.rotation.y = Math.sin(t * 0.23 + b.phase * 3) * 14 * DEG * Math.max(0, Math.sin(t * 0.11 + b.phase));
      // A blink every few seconds, now and then a double one.
      if (t > b.nextBlink + BLINK_S) b.nextBlink = t + 2.2 + ((b.phase * 7.3 + t * 0.37) % 1) * 3.6 - (((b.phase + t) % 1) < 0.15 ? 2.1 : 0);
      const k = (t - b.nextBlink) / BLINK_S;
      setBlink(b.avatar, k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0);
      if (!b.face) continue;
      // Upright like a face, however far they lean in, and turned the way they sit. Not with the
      // modelled head's idle glances: where the real person looks is in their video.
      const g = b.face.group;
      g.parent!.getWorldQuaternion(this.faceQuat).invert();
      this.upright.setFromEuler(this.yaw.set(0, b.root.rotation.y, 0));
      g.quaternion.copy(this.faceQuat).multiply(this.upright);
      const front = this.faceFront(b, eye);
      g.visible = front;
      head.visible = !front;
    }
  }

  /**
   * Whether `eye` sees the player's face: in front of their screen, and not
   * so far round to the side that it would be their profile (past about 78°
   * — the two players either side of the house dealer, say, both facing down
   * the table: to each other they're side-on).
   */
  private faceFront(b: Body, eye: THREE.Vector3): boolean {
    const g = b.face!.group;
    g.updateWorldMatrix(true, false);
    g.getWorldPosition(this.facePos);
    g.getWorldQuaternion(this.faceQuat);
    this.faceNormal.set(0, 0, 1).applyQuaternion(this.faceQuat);
    return this.toCamera.subVectors(eye, this.facePos).normalize().dot(this.faceNormal) > FACE_SIDE_ON;
  }

  /** For tests: each screen's middle and its left and right edges (world), and whether it shows its face to `eye`. */
  faces(eye: THREE.Vector3): { seatId: number; at: THREE.Vector3; edges: [THREE.Vector3, THREE.Vector3]; front: boolean; object: THREE.Object3D }[] {
    const out: { seatId: number; at: THREE.Vector3; edges: [THREE.Vector3, THREE.Vector3]; front: boolean; object: THREE.Object3D }[] = [];
    for (const [seatId, b] of this.bodies) {
      if (!b.face || b.own) continue;
      const front = this.faceFront(b, eye);
      const g = b.face.group;
      const half = FACE_SCREEN.width / 2;
      out.push({ seatId, at: this.facePos.clone(), edges: [g.localToWorld(new THREE.Vector3(-half, 0, 0)), g.localToWorld(new THREE.Vector3(half, 0, 0))], front, object: g });
    }
    return out;
  }

  /** Where a player's head is (world), or null with nobody there. */
  headWorld(seatId: number, out: THREE.Vector3): THREE.Vector3 | null {
    const b = this.bodies.get(seatId);
    if (!b || b.own) return null;
    // The head bone sits at the base of the skull; its middle is a little above.
    return b.bones.get('head')!.localToWorld(out.set(0, 0.17, 0.02));
  }

  get count(): number {
    return this.bodies.size;
  }

  private remove(seatId: number): void {
    const b = this.bodies.get(seatId);
    if (!b) return;
    b.face?.dispose();
    this.group.remove(b.root);
    for (const d of b.disposables) d.dispose();
    this.bodies.delete(seatId);
  }

  dispose(): void {
    for (const id of [...this.bodies.keys()]) this.remove(id);
  }
}

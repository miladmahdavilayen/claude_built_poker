import * as THREE from 'three';
import type { BoneName } from './humanBody.js';
import { avatarLook, buildPlayerAvatar, setBlink, type PlayerAvatar } from './playerAvatar.js';
import { PlayerCharacter } from './playerCharacter.js';
import type { SeatPlacement3d } from './seatLayout3d.js';
import { playerLook } from './playerLooks.js';

// The other players, sitting at the table: a body in each occupied chair
// (everyone's but your own — you're the one looking), leaning in with
// their forearms on the rail, breathing, glancing about. Their name and
// stack (the DOM layer over the scene) float above their head. Each is
// somebody of their own — face, hair, clothes (playerAvatar.ts) — from their
// avatar colour and seed, so each one stays recognisable.
//
// A player on camera wears it as their face: a screen in the scene itself,
// at their head (see FaceScreen). It is one size, in one place over their
// seat, for as long as the table stays as it is — worked out once from
// where they sit as seen from your chair and how many are playing
// (scene.ts's faceFits), never refitted as cards and chips come and go —
// and it is turned the way its player faces: toward the table's middle, and
// round with them as they look about in their own view (playerLooks.ts). So
// across the table it is square-on, beside you it is angled away, and when
// they turn to you it turns to you. It is never turned so far that you
// can't make it out (FACE_MAX_TURN).

const FLOOR_Y = -1.56;
const DEG = Math.PI / 180;

/** The seated pose, degrees XYZ per bone (see houseDealer.ts for the axes). */
const SEATED: Partial<Record<BoneName, [number, number, number]>> = {
  // Sitting up straight, near 90° — not bent over the table: from beside them you see past them to everyone else
  // (their head and camera screen stay over their own seat).
  spine: [3, 0, 0],
  chest: [2, 0, 0],
  neck: [-1, 0, 0],
  // Looking straight across the table at the others (not down at their own cards): their faces are what you see.
  head: [-2, 0, 0],
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
  /** The built-in figure's meshes: hidden under a character, or for a player on camera. */
  figure: THREE.Object3D[];
  /** The character they picked; on camera, it's taken out of memory until they're off it. */
  characterId: string | null;
  /** Whichever is showing or on its way — a newer choice wins over one still loading. */
  characterWanted: string | null;
  character: PlayerCharacter | null;
  /** Counts each load asked for: only the latest may land (A, B, A again mustn't leave two of A). */
  characterLoad: number;
  /** When the next blink starts (seconds, scene time). */
  nextBlink: number;
  /** Whose seat it is (their user id; null for a computer player): where they look comes by it. */
  playerId: string | null;
  /** How big their camera screen is, times its own size, and how far its middle is above their head (world) — fixed by the scene (see setFaceFit). */
  faceScale: number;
  faceUp: number;
  /** False while the house dealer stands between you and them: their head shows instead of a screen drawn over the dealer. */
  faceShown: boolean;
  /** Where they're looking, eased toward what they last reported. */
  lookYaw: number;
  lookPitch: number;
}

/** A blink: lids down and up again in this long (seconds). */
const BLINK_S = 0.16;

/** The screen's size, table units (about half a metre): a head and shoulders, 3:4 like the seat boxes' video. */
export const FACE_SCREEN = { width: 0.62, height: 0.82 } as const;
/** Where it sits on the neck bone: the head's middle a little above its own, just in front of the face. */
const FACE_AT = { y: 0.14 + 0.1, z: 0.14 };
const FRAME = 0.024;
/**
 * cos 110°: seen from further round behind them than that, their back is to you — the head shows instead. Side-on (the
 * player right beside you, both of you facing into the table) still shows their screen: it faces you whatever way
 * they sit.
 */
const FACE_BEHIND = -0.34;
/** However its player is turned, a screen is never more than this far (radians, 45°) from facing you: turned, and still easy to make out. */
const FACE_MAX_TURN = (45 * Math.PI) / 180;
/** A figure's head turns with its player's look, this far at most. */
const HEAD_MAX_TURN = (70 * Math.PI) / 180;

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

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
    // Drawn over the table, not into it: the scene keeps each screen clear of where cards and chips go
    // (scene.ts's faceFits), and a screen reaching down past its player's rail mustn't be cut off by it.
    // Transparent, to be drawn last: three.js draws everything opaque before anything transparent, whatever the
    // renderOrder — the felt's printed line (transparent) would otherwise paint over an opaque screen.
    for (const m of [screenMat, frameMat]) {
      m.depthTest = false;
      m.depthWrite = false;
      m.transparent = true;
    }
    const screen = new THREE.Mesh(screenGeo, screenMat);
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.renderOrder = 10;
    screen.renderOrder = 11;
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
  /** The character they picked, or null: the built-in figure. */
  character: string | null;
  /** Their user id (null for a computer player) — see playerLooks.ts. */
  playerId?: string | null;
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
  private readonly yaw = new THREE.Euler(0, 0, 0, 'YXZ');

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
        const figure: THREE.Object3D[] = [];
        root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) figure.push(o);
        });
        body = { figure, characterId: p.character, characterWanted: null, character: null, characterLoad: 0, root, bones: avatar.bones, disposables: avatar.disposables, phase: (p.seed % 628) / 100, key, face: null, own: false, avatar, nextBlink: (p.seed % 400) / 100, playerId: p.playerId ?? null, faceScale: 1, faceUp: 0, faceShown: true, lookYaw: 0, lookPitch: 0 };
        this.bodies.set(p.seatId, body);
        this.group.add(root);
      }
      body.own = p.seatId === viewerSeatId;
      body.playerId = p.playerId ?? null;
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
      body.characterId = p.character;
      body.character?.pose(body.root, body.bones);
    }
    for (const id of [...this.bodies.keys()]) if (!wanted.has(id)) this.remove(id);
    this.attachFaces();
    this.syncCharacters();
  }

  /**
   * Who shows in each chair. A player on camera: nobody, just the seat behind their screen — their character out of
   * memory until they're off it. Otherwise the character they picked, once it's arrived, the built-in figure until
   * then (and for good, if it can't be loaded).
   */
  private syncCharacters(): void {
    for (const [seatId, b] of this.bodies) {
      const onCamera = this.videos.has(seatId);
      const want = onCamera ? null : b.characterId;
      if (b.characterWanted !== want) {
        b.characterWanted = want;
        b.character?.dispose();
        b.character = null;
        b.characterLoad++;
        if (want) this.loadCharacter(seatId, b, want, b.characterLoad);
      }
      const showFigure = !onCamera && !b.character;
      for (const m of b.figure) m.visible = showFigure;
    }
  }

  private loadCharacter(seatId: number, b: Body, id: string, load: number): void {
    void PlayerCharacter.load(id, b.root, b.bones, this.castShadows)
      .then((c) => {
        // Gone, or they've chosen otherwise (or turned their camera on) while it loaded.
        if (this.bodies.get(seatId) !== b || b.characterLoad !== load) {
          c.dispose();
          return;
        }
        b.character = c;
        c.pose(b.root, b.bones);
        for (const m of b.figure) m.visible = false;
      })
      .catch((err: unknown) => {
        console.warn('A player character could not load; the built-in figure stays.', err);
      });
  }

  /** The players on camera, by seat (the viewer's own is never here: they have no body). */
  /** Seated, the viewer's own body has no head: the camera is where it would be. */
  setOwnHeadless(on: boolean): void {
    this.ownHeadless = on;
  }

  private ownHeadless = true;
  private ownHidden = false;

  /** The viewer's own body out of sight altogether: the seated view pulled back behind their chair looks straight through where they sit. */
  setOwnHidden(on: boolean): void {
    this.ownHidden = on;
  }

  setVideos(videos: ReadonlyMap<number, MediaStream>): void {
    this.videos = new Map(videos);
    this.attachFaces();
    this.syncCharacters();
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
    const b = this.bodies.get(seatId);
    return !!b?.face && !b.own;
  }

  /**
   * How big a player's screen is (times its own size) and how far its middle sits above their head (world units).
   * The scene sets them from where they sit and how many are playing — and from nothing that changes as a hand is
   * played, so the screen stays one size in one place. `shown` false takes it away for now (the house dealer is
   * standing between you): their head shows instead.
   */
  setFaceFit(seatId: number, scale: number, up: number, shown = true): void {
    const b = this.bodies.get(seatId);
    if (!b) return;
    b.faceScale = scale;
    b.faceUp = up;
    b.faceShown = shown;
  }

  /** A screen's four corners with its frame (world), as it stands right now — or null with no screen there. */
  faceCorners(seatId: number): THREE.Vector3[] | null {
    const b = this.bodies.get(seatId);
    if (!b?.face || b.own || !b.faceShown) return null;
    const g = b.face.group;
    g.updateWorldMatrix(true, false);
    const hw = FACE_SCREEN.width / 2 + FRAME;
    const hh = FACE_SCREEN.height / 2 + FRAME;
    return [-1, 1].flatMap((sx) => [-1, 1].map((sy) => g.localToWorld(new THREE.Vector3(sx * hw, sy * hh, 0))));
  }

  /**
   * Breathing, blinking, and an occasional look around — small, so it never distracts. A player whose own view
   * says where they're looking (playerLooks.ts) looks there instead: their figure's head turns, and so does their
   * camera screen (`eye` is the camera: a screen is never turned further from it than FACE_MAX_TURN).
   */
  update(time: number, eye: THREE.Vector3): void {
    const t = time / 1000;
    for (const b of this.bodies.values()) {
      const chest = b.bones.get('chest')!;
      const breath = Math.sin(t * 1.3 + b.phase) * 1.2;
      chest.rotation.x = (SEATED.chest![0] + breath) * DEG;
      const head = b.bones.get('head')!;
      b.root.visible = !(b.own && this.ownHidden);
      if (b.own) {
        // Your own head turns where you drag, not on its own.
        head.visible = !this.ownHeadless;
        head.rotation.y = 0;
        b.character?.setHeadless(this.ownHeadless);
        b.character?.idle(breath, 0);
        continue;
      }
      const look = playerLook(b.playerId);
      b.lookYaw += ((look?.yaw ?? 0) - b.lookYaw) * 0.18;
      b.lookPitch += ((look?.pitch ?? 0) - b.lookPitch) * 0.18;
      const looking = look !== null && (Math.abs(b.lookYaw) > 0.03 || Math.abs(look.yaw) > 0.03);
      head.rotation.y = looking
        ? Math.max(-HEAD_MAX_TURN, Math.min(HEAD_MAX_TURN, b.lookYaw))
        : Math.sin(t * 0.23 + b.phase * 3) * 14 * DEG * Math.max(0, Math.sin(t * 0.11 + b.phase));
      b.character?.idle(breath, head.rotation.y);
      // A blink every few seconds, now and then a double one.
      if (t > b.nextBlink + BLINK_S) b.nextBlink = t + 2.2 + ((b.phase * 7.3 + t * 0.37) % 1) * 3.6 - (((b.phase + t) % 1) < 0.15 ? 2.1 : 0);
      const k = (t - b.nextBlink) / BLINK_S;
      setBlink(b.avatar, k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0);
      if (!b.face) continue;
      const g = b.face.group;
      // One size, in one place by their head: both set once by the scene (setFaceFit).
      g.scale.setScalar(b.faceScale);
      g.parent!.updateWorldMatrix(true, false);
      head.updateWorldMatrix(true, false);
      head.localToWorld(this.facePos.set(0, 0.17, 0.02)).y += b.faceUp;
      g.position.copy(g.parent!.worldToLocal(this.facePos));
      // Turned the way its player faces and looks — as far as FACE_MAX_TURN from facing you, no further — and tipped
      // a little with their look up or down. Not with the modelled head's idle glances: where the real person
      // looks is what they've told us, and what's in their video.
      g.getWorldPosition(this.facePos);
      const toEye = Math.atan2(eye.x - this.facePos.x, eye.z - this.facePos.z);
      const off = wrapPi(b.root.rotation.y + b.lookYaw - toEye);
      const yaw = toEye + Math.max(-FACE_MAX_TURN, Math.min(FACE_MAX_TURN, off));
      const tip = Math.max(-0.3, Math.min(0.3, -b.lookPitch * 0.6));
      g.parent!.getWorldQuaternion(this.faceQuat).invert();
      this.upright.setFromEuler(this.yaw.set(tip, yaw, 0, 'YXZ'));
      g.quaternion.copy(this.faceQuat).multiply(this.upright);
      g.visible = b.faceShown;
      // Their screen is their face: no modelled head behind it.
      head.visible = !g.visible;
    }
  }

  /**
   * Whether `eye` gets their screen: anywhere but behind them (past about
   * 110° from the way they face). Side-on counts — the player right beside
   * you, turned to. (Whether the house dealer stands in between is the
   * scene's to say: see scene.ts's fitFaces.)
   */
  private faceFront(b: Body, eye: THREE.Vector3): boolean {
    const neck = b.bones.get('neck')!;
    neck.updateWorldMatrix(true, false);
    neck.localToWorld(this.facePos.set(0, FACE_AT.y, FACE_AT.z));
    const yaw = b.root.rotation.y;
    this.faceNormal.set(Math.sin(yaw), 0, Math.cos(yaw));
    return this.toCamera.subVectors(eye, this.facePos).normalize().dot(this.faceNormal) > FACE_BEHIND;
  }


  /** For tests: each screen's middle and its left and right edges (world), and whether it shows its face to `eye`. */
  faces(eye: THREE.Vector3): { seatId: number; at: THREE.Vector3; edges: [THREE.Vector3, THREE.Vector3]; front: boolean; object: THREE.Object3D }[] {
    const out: { seatId: number; at: THREE.Vector3; edges: [THREE.Vector3, THREE.Vector3]; front: boolean; object: THREE.Object3D }[] = [];
    for (const [seatId, b] of this.bodies) {
      if (!b.face || b.own) continue;
      const front = this.faceFront(b, eye) && b.faceShown;
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
    b.characterWanted = null;
    b.characterLoad++;
    b.character?.dispose();
    b.character = null;
    this.group.remove(b.root);
    for (const d of b.disposables) d.dispose();
    this.bodies.delete(seatId);
  }

  dispose(): void {
    for (const id of [...this.bodies.keys()]) this.remove(id);
  }
}

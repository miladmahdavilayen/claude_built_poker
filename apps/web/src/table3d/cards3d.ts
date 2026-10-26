import * as THREE from 'three';
import { TIMINGS } from '../animationTimings.js';
import { HOUSE } from './seatLayout3d.js';
import { cardBackTexture, cardFaceTexture } from './textures.js';

// Every card on the 3D table. Face-down cards — the bulk of them: everyone
// else's hole cards, cards in flight from the house dealer, the burn and
// muck pile — are instances of ONE InstancedMesh. A card whose face is
// known (the board, the viewer's own hand, a hand shown down) is its own
// small two-sided mesh, sharing geometry and the back material, with its
// face texture made once per card and cached.
//
// The board lies the way a house dealer turns it: in a row parallel to
// their edge of the table, face up toward the players across from them,
// the same for everyone wherever they sit. Your own two cards lie face up
// in front of you, the right way up for you. A hand shown down at another
// seat turns to face you, so you can read it.

export const CARD_W = 0.28;
export const CARD_H = 0.39;
const CARD_T = 0.004;
export const BOARD_SCALE = 1.42;
const OWN_SCALE = 1.15;
/** Your own cards sit a little further in than the spot where everyone's face-down cards land. */
export const OWN_IN = 0.22;

export interface SeatCardSpot {
  x: number;
  z: number;
  /** Yaw facing the table's center from the seat. */
  facing: number;
}

/** Where a card belongs: a seat's hole-card spot, a board slot, or the muck. */
export type CardSlot = { kind: 'hole'; seatId: number; index: number } | { kind: 'board'; index: number } | { kind: 'muck'; n: number };

interface Flight {
  from: THREE.Vector3;
  start: number;
  dur: number;
  spin: number;
}

interface Card {
  key: string;
  slot: CardSlot;
  face: string | null;
  /** 1 face up, 0 face down — animated between by `flip`. */
  up: number;
  flip: { start: number; from: number; to: number } | null;
  flight: Flight | null;
  /** Hidden until its flight is launched (it's still in the deck). */
  waiting: boolean;
  /** Removed once its flight lands (a card swept into the dealer's hands). */
  dieOnLand: boolean;
  /** Where a swept-up card flies instead of its slot. */
  dest: THREE.Vector3 | null;
  /** A little randomness in where it settles, so it doesn't look printed. */
  jitter: { x: number; z: number; yaw: number };
  pos: THREE.Vector3;
  yaw: number;
  mesh: THREE.Group | null;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

export class Cards3d {
  readonly group = new THREE.Group();
  private readonly backs: THREE.InstancedMesh;
  private readonly cards = new Map<string, Card>();
  private readonly faceMats = new Map<string, THREE.MeshBasicMaterial>();
  private readonly faceGeo: THREE.PlaneGeometry;
  private readonly backMat: THREE.MeshBasicMaterial;
  private readonly backTex: THREE.CanvasTexture;
  private readonly edgeMat: THREE.MeshStandardMaterial;
  private readonly boxGeo: THREE.BoxGeometry;
  private readonly seatSpots = new Map<number, SeatCardSpot>();
  private readonly matrix = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private viewYaw = 0;
  private highlight: ReadonlySet<string> = new Set();
  private viewerSeatId: number | null = null;
  private muckCount = 0;
  private seed = 0x1b873593;
  private readonly capacity = 64;
  reduceMotion = false;

  private readonly anisotropy: number;

  constructor(castShadows: boolean, anisotropy = 8) {
    this.anisotropy = anisotropy;
    this.backTex = cardBackTexture();
    this.backTex.anisotropy = anisotropy;
    // The card's rounded corners are cut out of its texture (alpha test), not modelled.
    this.backMat = new THREE.MeshBasicMaterial({ map: this.backTex, alphaTest: 0.5, toneMapped: false, color: '#e8e4dc' });
    this.edgeMat = new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.8 });
    this.boxGeo = new THREE.BoxGeometry(CARD_W, CARD_T, CARD_H);
    this.faceGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    // Lying flat with the texture's top edge pointing away (-Z) — yaw turns it from there.
    this.faceGeo.rotateX(-Math.PI / 2);
    this.backs = new THREE.InstancedMesh(this.boxGeo, [this.edgeMat, this.edgeMat, this.backMat, this.backMat, this.edgeMat, this.edgeMat], this.capacity);
    this.backs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.backs.castShadow = castShadows;
    this.backs.frustumCulled = false;
    this.backs.count = 0;
    this.group.add(this.backs);
  }

  private rand(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 0xffffffff;
  }

  setSeatSpots(spots: ReadonlyMap<number, SeatCardSpot>, viewerSeatId: number | null): void {
    this.seatSpots.clear();
    for (const [k, v] of spots) this.seatSpots.set(k, v);
    this.viewerSeatId = viewerSeatId;
  }

  /** The camera's yaw around the table (0 = looking from the house dealer's side): face-up cards and the board line up to it. */
  setViewYaw(yaw: number): void {
    this.viewYaw = yaw;
  }

  /** Raises these faces a little off the felt (a split pot's winning cards). */
  setHighlight(faces: ReadonlySet<string>): void {
    this.highlight = faces;
  }

  /** How many board cards are down and face up — what the screen's board strip shows (never ahead of the table). */
  boardShown(): number {
    let n = 0;
    for (const c of this.cards.values()) {
      if (c.slot.kind === 'board' && !c.waiting && !c.flight && !c.flip && c.up > 0.5) n++;
    }
    return n;
  }

  /** Whether the viewer's own two cards are down in front of them (dealt, landed, turned up). */
  ownLanded(seatId: number): boolean {
    for (const i of [0, 1]) {
      const c = this.cards.get(`hole:${String(seatId)}:${String(i)}`);
      if (!c || c.waiting || c.flight || c.flip) return false;
    }
    return true;
  }

  has(key: string): boolean {
    return this.cards.has(key);
  }

  isWaiting(key: string): boolean {
    return this.cards.get(key)?.waiting ?? false;
  }

  keys(): string[] {
    return [...this.cards.keys()];
  }

  /** Puts a card in its slot. `waiting` keeps it hidden in the deck until `launch` sends it. */
  place(key: string, slot: CardSlot, face: string | null, waiting: boolean): void {
    const existing = this.cards.get(key);
    if (existing) {
      this.setFace(existing, face);
      return;
    }
    const card: Card = {
      key,
      slot,
      face: null,
      up: 0,
      flip: null,
      flight: null,
      waiting,
      dieOnLand: false,
      dest: null,
      jitter: { x: (this.rand() - 0.5) * 0.03, z: (this.rand() - 0.5) * 0.03, yaw: (this.rand() - 0.5) * 0.09 },
      pos: new THREE.Vector3(),
      yaw: 0,
      mesh: null,
    };
    this.cards.set(key, card);
    this.setFace(card, face, true);
    // Still in the deck: it turns face up as it lands (see launch); otherwise it's simply there.
    card.up = face && !waiting ? 1 : 0;
    this.target(card, card.pos);
    card.yaw = this.targetYaw(card);
  }

  /** Sends a waiting card from `from` (the house dealer's hand) to its slot; a board card turns face up as it lands. */
  launch(key: string, from: THREE.Vector3): void {
    const card = this.cards.get(key);
    if (!card) return;
    card.waiting = false;
    if (this.reduceMotion) {
      if (card.face) card.up = 1;
      return;
    }
    card.pos.copy(from);
    card.flight = { from: from.clone(), start: performance.now(), dur: TIMINGS.cardFlightMs, spin: (this.rand() - 0.5) * 2.4 };
    // It travels face down and turns over once it's in place.
    if (card.face) {
      card.up = 0;
      card.flip = { start: performance.now() + TIMINGS.cardFlightMs, from: 0, to: 1 };
    }
  }

  /** Shows every waiting card in its slot at once — the game moved on before its deal animation did. */
  revealWaiting(): void {
    for (const c of this.cards.values()) {
      if (!c.waiting) continue;
      c.waiting = false;
      if (c.face) c.up = 1;
    }
  }

  /** Sweeps a card face down onto the muck pile (a fold), or — given `hands` — into the house dealer's hands and away (the end of the hand). */
  muck(key: string, hands: THREE.Vector3 | null = null): void {
    const stay = hands === null;
    const card = this.cards.get(key);
    if (!card) return;
    this.cards.delete(key);
    if (card.waiting) {
      this.dropMesh(card);
      return;
    }
    const n = this.muckCount++;
    const muck: Card = {
      ...card,
      key: `muck:${String(n)}`,
      slot: { kind: 'muck', n },
      flip: card.up > 0 ? { start: performance.now(), from: card.up, to: 0 } : null,
      flight: this.reduceMotion ? null : { from: card.pos.clone(), start: performance.now(), dur: TIMINGS.cardFlightMs * 0.9, spin: (this.rand() - 0.5) * 2 },
      dieOnLand: !stay,
      dest: hands ? hands.clone() : null,
      jitter: { x: (this.rand() - 0.5) * 0.06, z: (this.rand() - 0.5) * 0.06, yaw: (this.rand() - 0.5) * 0.6 },
    };
    if (this.reduceMotion) {
      muck.up = 0;
      if (!stay) {
        this.dropMesh(muck);
        return;
      }
    }
    this.cards.set(muck.key, muck);
  }

  /** Everything off the table (a reset, or the view going away). */
  clear(): void {
    for (const c of this.cards.values()) this.dropMesh(c);
    this.cards.clear();
    this.muckCount = 0;
  }

  /** Clears the muck pile — the house dealer gathered it up. */
  clearMuck(): void {
    for (const [k, c] of this.cards) {
      if (c.slot.kind !== 'muck') continue;
      this.dropMesh(c);
      this.cards.delete(k);
    }
    this.muckCount = 0;
  }

  get animating(): boolean {
    const now = performance.now();
    for (const c of this.cards.values()) {
      if (c.flight && now < c.flight.start + c.flight.dur) return true;
      if (c.flip && now < c.flip.start + TIMINGS.cardFlipMs) return true;
    }
    return false;
  }

  private setFace(card: Card, face: string | null, isNew = false): void {
    if (card.face === face) return;
    const wasKnown = card.face !== null;
    card.face = face;
    if (face) {
      if (!card.mesh) {
        card.mesh = new THREE.Group();
        const front = new THREE.Mesh(this.faceGeo, this.faceMaterial(face));
        front.position.y = CARD_T / 2 + 0.0005;
        const back = new THREE.Mesh(this.faceGeo, this.backMat);
        back.rotation.z = Math.PI;
        back.position.y = -CARD_T / 2 - 0.0005;
        front.castShadow = true;
        card.mesh.add(front, back);
        this.group.add(card.mesh);
      } else {
        (card.mesh.children[0] as THREE.Mesh).material = this.faceMaterial(face);
      }
      // A face that just became known on a card already on the table (a hand shown down) turns over.
      if (!wasKnown && !isNew && !card.waiting && !card.flight) {
        if (this.reduceMotion) card.up = 1;
        else card.flip = { start: performance.now(), from: card.up, to: 1 };
      }
    } else {
      this.dropMesh(card);
      card.up = 0;
    }
  }

  /**
   * A card's face: the classic deck's artwork (public/cards — Adrian
   * Kennard's CC0 designs, see DECISIONS.md), loaded the first time that
   * card shows. A face drawn here stands in for the moment it takes to arrive.
   */
  private faceMaterial(face: string): THREE.MeshBasicMaterial {
    let m = this.faceMats.get(face);
    if (!m) {
      const drawn = cardFaceTexture(face);
      drawn.anisotropy = this.anisotropy;
      // A face is shown exactly as printed, bright and full-contrast, whatever the
      // room's light or tone mapping: what matters on a card is reading it.
      const mat = new THREE.MeshBasicMaterial({ map: drawn, alphaTest: 0.5, toneMapped: false, color: '#f6f4ee' });
      m = mat;
      this.faceMats.set(face, mat);
      this.loader.load(
        `/cards/${face}.webp`,
        (tex) => {
          if (this.faceMats.get(face) !== mat) {
            tex.dispose();
            return;
          }
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.anisotropy;
          mat.map?.dispose();
          mat.map = tex;
          mat.needsUpdate = true;
        },
        undefined,
        () => {
          // Offline, or the file's missing: the drawn face stays.
        },
      );
    }
    return m;
  }

  private readonly loader = new THREE.TextureLoader();

  /** Lets go of the face textures no card on the table is showing (a new hand: the old ones won't be back soon). */
  pruneFaces(): void {
    const used = new Set<string>();
    for (const c of this.cards.values()) if (c.face) used.add(c.face);
    for (const [face, m] of this.faceMats) {
      if (used.has(face)) continue;
      m.map?.dispose();
      m.dispose();
      this.faceMats.delete(face);
    }
  }

  private dropMesh(card: Card): void {
    if (card.mesh) {
      this.group.remove(card.mesh);
      card.mesh = null;
    }
  }

  private target(card: Card, out: THREE.Vector3): THREE.Vector3 {
    if (card.dest) return out.copy(card.dest);
    const s = card.slot;
    if (s.kind === 'board') {
      // Left to right as the players across from the house dealer see it (their left is +X).
      return out.set((2 - s.index) * HOUSE.boardSpacing + card.jitter.x * 0.5, CARD_T * 0.5, HOUSE.boardZ + card.jitter.z * 0.5);
    }
    if (s.kind === 'muck') {
      return out.set(HOUSE.muckX + card.jitter.x, CARD_T * (0.5 + (s.n % 12)), HOUSE.muckZ + card.jitter.z);
    }
    const spot = this.seatSpots.get(s.seatId);
    if (!spot) return out.set(0, -5, 0);
    // The two cards side by side across the seat's line of sight: everyone
    // else's a little overlapped; your own apart, bigger, a little further in.
    const own = s.seatId === this.viewerSeatId;
    const tx = Math.cos(spot.facing);
    const tz = -Math.sin(spot.facing);
    const inX = Math.sin(spot.facing) * (own ? OWN_IN : 0);
    const inZ = Math.cos(spot.facing) * (own ? OWN_IN : 0);
    // Your own: the first card on your left (the seat's right-hand side seen from the table is -t).
    const off = own ? (0.5 - s.index) * (CARD_W * OWN_SCALE + 0.04) : (s.index - 0.5) * CARD_W * 0.62;
    return out.set(spot.x + inX + tx * off + card.jitter.x * 0.4, CARD_T * (0.5 + s.index), spot.z + inZ + tz * off + card.jitter.z * 0.4);
  }

  private targetYaw(card: Card): number {
    const s = card.slot;
    if (s.kind === 'muck') return card.jitter.yaw;
    // The board: tops toward the house dealer, readable from across the table.
    if (s.kind === 'board') return Math.PI + card.jitter.yaw * 0.25;
    const spot = this.seatSpots.get(s.seatId);
    const facing = spot?.facing ?? 0;
    // Your own: tops toward the middle of the table — the right way up for you — each turned in a touch.
    if (s.seatId === this.viewerSeatId) return facing + Math.PI + (0.5 - s.index) * 0.07;
    // A hand shown down turns to face you, so you can read it.
    if (card.up > 0.5) return this.viewYaw + card.jitter.yaw * 0.4;
    const fan = (s.index - 0.5) * 0.22;
    return facing + Math.PI + fan + card.jitter.yaw;
  }

  private scaleOf(card: Card): number {
    if (card.slot.kind === 'board') return BOARD_SCALE;
    if (card.slot.kind === 'hole' && card.slot.seatId === this.viewerSeatId) return OWN_SCALE;
    return 1;
  }

  update(now: number): void {
    const tmp = new THREE.Vector3();
    let n = 0;
    for (const [key, c] of this.cards) {
      const visible = !c.waiting;
      const tgt = this.target(c, tmp);
      let lift = 0;
      if (c.flight) {
        const t = Math.min(1, Math.max(0, (now - c.flight.start) / c.flight.dur));
        const e = easeOut(t);
        // A curved path: out of the hand, up over the felt, and down into place.
        c.pos.lerpVectors(c.flight.from, tgt, e);
        c.pos.y += Math.sin(Math.PI * t) * 0.32 * (1 - e * 0.3);
        c.yaw = this.targetYaw(c) + c.flight.spin * (1 - e);
        if (t >= 1) {
          c.flight = null;
          if (c.dieOnLand) {
            this.dropMesh(c);
            this.cards.delete(key);
            continue;
          }
        }
      } else {
        c.pos.copy(tgt);
        // Settled cards turn smoothly when the view changes (a player switching seats).
        const want = this.targetYaw(c);
        let d = want - c.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        c.yaw += d * 0.25;
      }
      if (c.flip) {
        const t = Math.min(1, Math.max(0, (now - c.flip.start) / TIMINGS.cardFlipMs));
        if (now >= c.flip.start) {
          c.up = c.flip.from + (c.flip.to - c.flip.from) * easeOut(t);
          lift = Math.sin(Math.PI * t) * CARD_W * 0.55;
        }
        if (t >= 1) {
          c.up = c.flip.to;
          c.flip = null;
        }
      }
      const raised = c.face !== null && c.up > 0.5 && this.highlight.has(c.face);
      const scale = this.scaleOf(c) * (raised ? 1.1 : 1);
      if (c.mesh) {
        c.mesh.visible = visible;
        c.mesh.position.set(c.pos.x, c.pos.y + lift + (raised ? 0.07 : 0), c.pos.z);
        // Face up is no roll; face down is a half turn about the card's long axis.
        c.mesh.rotation.set(0, 0, 0);
        c.mesh.rotateY(c.yaw);
        c.mesh.rotateZ(Math.PI * (1 - c.up));
        c.mesh.scale.setScalar(scale);
      } else if (visible && n < this.capacity) {
        this.e.set(0, c.yaw, 0, 'YXZ');
        this.q.setFromEuler(this.e);
        this.matrix.compose(c.pos, this.q, this.one.set(scale, 1, scale));
        this.backs.setMatrixAt(n++, this.matrix);
      }
    }
    this.backs.count = n;
    this.backs.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.clear();
    this.backs.dispose();
    this.boxGeo.dispose();
    this.faceGeo.dispose();
    this.backMat.dispose();
    this.backTex.dispose();
    this.edgeMat.dispose();
    for (const m of this.faceMats.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.faceMats.clear();
  }
}

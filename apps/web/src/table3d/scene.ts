import type { ProjectedGameEvent } from '@pokerclause/shared';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TIMINGS } from '../animationTimings.js';
import { playCardFlickSound, playChipSound, playShuffleSound } from '../sound.js';
import { CameraRig, orbitFov, orbitView, type CameraPose, type CameraView, type FitPoint } from './cameraRig.js';
import { BOARD_SCALE, Cards3d, CARD_H, CARD_W, OWN_IN, type SeatCardSpot } from './cards3d.js';
import { Chips3d } from './chips3d.js';
import { DealerButton3d } from './dealerButton.js';
import { GhostDealer, type DealerLike } from './houseDealer.js';
import { LookControls } from './lookControls.js';
import { SeatedPlayers } from './players3d.js';
import { CasinoRoom } from './room3d.js';
import { TIERS, type QualityTier, type View3dMode } from './quality.js';
import { HOUSE, SEAT_SPOTS, TABLE, dealOrder, edgePoint, seatPlacements, type SeatPlacement3d } from './seatLayout3d.js';
import { blobTexture, feltTextures, leatherTexture, roomTexture, woodTexture } from './textures.js';

// The 3D table — a presentation layer over the game state, nothing more.
// It reads the same ProjectedTableState and event batches the 2D table
// does and never decides anything about the game: who has the button,
// whose turn it is, who won and how much all come from the server. See
// TableScene3D.tsx for the React side, which hands it state and events and
// the DOM boxes (video, name, stack) it keeps anchored to each seat.

/** One seat as the scene needs it. */
export interface SceneSeat {
  seatId: number;
  occupied: boolean;
  /** Holding cards in the current (or just-finished) hand. */
  inHand: boolean;
  /** Its two cards' faces where the viewer may see them (their own, or shown down); null for face down. */
  faces: readonly (string | null)[];
  /** Its current-street bet. */
  bet: number;
  /** The player's looks (avatar hue and a stable number from who they are) — see players3d.ts. */
  hue: number;
  seed: number;
}

export interface SceneSnapshot {
  seats: readonly SceneSeat[];
  viewerSeatId: number | null;
  board: readonly string[];
  /** Everything in the middle and in front of the players (potTotal.ts's livePotTotal). */
  potTotal: number;
  /** null before the table's first deal. */
  buttonSeat: number | null;
}

/** Where things are on screen, px from the container's top-left — for the DOM layers over the table (win badges, banners). */
export interface ScreenLayout {
  width: number;
  height: number;
  seats: Map<number, { x: number; y: number }>;
  pot: { x: number; y: number };
  board: { x: number; y: number };
  /** The board's top edge on screen. */
  boardTop: number;
}

export interface SceneCallbacks {
  onChairClick?: (seatId: number) => void;
  /** The average frame time, ms, over a stretch of continuous rendering — for Auto quality. */
  onPerf?: (avgFrameMs: number) => void;
  /** Settled positions of the seats, pot and board on screen. */
  onLayout?: (layout: ScreenLayout) => void;
  /** The amount shown in the middle (0 once it's been pushed to the winners). */
  onPotShown?: (amount: number) => void;
  /** The seated viewer has turned to look somewhere other than the table (or back). */
  onLookAway?: (away: boolean) => void;
  /** Whether the viewer's own cards have reached them this hand (their action buttons wait for it). */
  onOwnCards?: (landed: boolean) => void;
  /** How many board cards are down and face up on the table — the screen's board strip follows it. */
  onBoardShown?: (count: number) => void;
  /** The owner double-tapped the house dealer (only passed for someone who may change her). */
  onDealerDoubleTap?: () => void;
  /** A pinch or scroll asked for the other view: out to standing (the whole table), in to sitting. */
  onRequestMode?: (mode: View3dMode) => void;
}

/**
 * A seated player's eyes: just behind their own stretch of rail (their
 * chest at the cushion), about 53 cm above the felt, in table units of half
 * a metre — a seated adult's eye height (about 43 cm) plus 4 inches,
 * sitting up straight, so the felt reads a little better from every seat.
 * (To really read the board you lean in over it: BOARD_LEAN.)
 */
const EYE = { out: 0.3, y: 1.063 } as const;

/**
 * Bending forward over the rail: the eyes come in this far over the felt
 * and drop this much. From seats 1 and 9 — either side of the house dealer
 * — that's how you see past the dealer to the player on the other side,
 * the way you'd lean in at a real table.
 */
const LEAN = { forward: 0.7, down: 0.14 } as const;

/**
 * Leaning in over the community cards (drag the table toward you — see
 * lookControls' vertical): the eyes come this far in toward the board, rise
 * this much (head up over the felt, like standing half up out of the
 * chair), and never closer than `nearest` to the board's middle. At full
 * lean the view looks straight at the board.
 */
const BOARD_LEAN = { forward: 1.25, up: 0.3, nearest: 1.15 } as const;

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

const FLOOR_Y = -1.56;
/** The page's controls on the felt that seat boxes keep clear of (see Table.tsx). */
const OBSTACLES = '.start-hand-panel > *, .immersive-toggle, .fairness-commitment, .board-hud, .action-ticker';

function roundedRect(hw: number, hd: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.absarc(hw - r, -hd + r, r, -Math.PI / 2, 0, false);
  s.lineTo(hw, hd - r);
  s.absarc(hw - r, hd - r, r, 0, Math.PI / 2, false);
  s.lineTo(-hw + r, hd);
  s.absarc(-hw + r, hd - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-hw, -hd + r);
  s.absarc(-hw + r, -hd + r, r, Math.PI, (3 * Math.PI) / 2, false);
  return s;
}

function insetRect(inset: number): THREE.Shape {
  return roundedRect(TABLE.halfWidth - inset, TABLE.halfDepth - inset, Math.max(0.05, TABLE.cornerRadius - inset));
}

function holePath(inset: number): THREE.Path {
  const s = insetRect(inset);
  const p = new THREE.Path();
  p.setFromPoints(s.getPoints(48).reverse());
  return p;
}

interface Overlay {
  el: HTMLElement;
  w: number;
  h: number;
}

export class TableScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig = new CameraRig();
  private readonly tier: QualityTier;
  private readonly cb: SceneCallbacks;
  private readonly disposables: { dispose: () => void }[] = [];
  private readonly chips: Chips3d;
  private readonly cards: Cards3d;
  private readonly button: DealerButton3d;
  private dealer: DealerLike;
  private readonly chairParts: THREE.InstancedMesh[] = [];
  private chairSeatIds: number[] = [];
  private placements: SeatPlacement3d[] = [];
  private readonly placementBySeat = new Map<number, SeatPlacement3d>();
  private viewerSeatId: number | null = null;
  private occupied = new Set<number>();
  private hoverSeat: number | null = null;
  private width = 1;
  private height = 1;
  private raf = 0;
  private lastFrame = 0;
  private lastRender = 0;
  private readonly frameTimes: number[] = [];
  private warmUntil = 0;
  private readonly overlays = new Map<string, Overlay>();
  private readonly resizeObs: ResizeObserver;
  private layoutDirty = true;
  private lastLayoutKey = '';
  private reduceMotion = false;
  private seatKey = '';
  private boardCount = 0;
  private potShown = 0;
  /** The pot as the game has it: everything in, less this street's bets still in front of the players. */
  private potWanted = 0;
  /** How much of it has already been pushed to winners this hand. */
  private potPaid = 0;
  /** Between a hand's end and the next one's start: its bets are in the pot, whatever the last state still says each player put in. */
  private handOver = false;
  private potHoldUntil = 0;
  /** The pot's been pushed to its winners; nothing in the middle until the next hand. */
  private potGone = false;
  /** A split pot: SplitPotAnnouncement pushes the pot out itself, pot by pot (see distributePot). */
  private externalPot = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private lastSnapshot: SceneSnapshot | null = null;
  private disposed = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly canvas: HTMLCanvasElement;
  private readonly look: LookControls;
  /** How far the seated viewer is leaning in (0 sitting back, 1 bent forward), and whether they asked to. */
  private lean = 0;
  private leanManual = false;
  private readonly players: SeatedPlayers;
  private room!: CasinoRoom;
  private mode: View3dMode = 'seated';
  private lookAway = false;
  private realDealer: import('./houseDealer.js').HouseDealer | null = null;
  private dealerModelUrl: string | null = null;
  private boardShownCount = -1;
  private ownLandedNow: boolean | null = null;

  constructor(canvas: HTMLCanvasElement, tier: QualityTier, cb: SceneCallbacks) {
    this.canvas = canvas;
    this.tier = tier;
    this.cb = cb;
    const t = TIERS[tier];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: t.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.maxDpr));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = t.shadowMapSize > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const shadows = t.shadowMapSize > 0;

    this.buildRoom(tier);
    this.buildLights(t.shadowMapSize);
    this.buildTable(t.textureSize, shadows);
    this.chips = new Chips3d(420, shadows);
    this.scene.add(this.chips.mesh);
    this.chips.tray.position.set(0, 0.012, TABLE.halfDepth - TABLE.railWidth - HOUSE.trayDepth / 2 - 0.02);
    this.scene.add(this.chips.tray);
    this.cards = new Cards3d(shadows, this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.cards.group);
    this.button = new DealerButton3d(shadows);
    this.scene.add(this.button.group);
    this.players = new SeatedPlayers(shadows);
    this.scene.add(this.players.group);
    // Until the character loads, a stand-in keeps the same timing from the dealer's spot.
    this.dealer = new GhostDealer(new THREE.Vector3(0.3, 0.45, HOUSE.dealerZ - 0.55));
    if (t.houseDealer) void this.loadDealer(shadows);

    this.resizeObs = new ResizeObserver((entries) => {
      for (const e of entries) {
        for (const o of this.overlays.values()) {
          if (o.el === e.target) {
            o.w = (e.target as HTMLElement).offsetWidth;
            o.h = (e.target as HTMLElement).offsetHeight;
          }
        }
      }
      this.layoutDirty = true;
    });
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    // Dragging turns the seated viewer's head; a tap is a tap (an empty chair).
    this.look = new LookControls(canvas, {
      radiansPerPx: () => {
        const vfov = (this.rig.camera.fov * Math.PI) / 180;
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.rig.camera.aspect);
        return hfov / Math.max(1, this.width);
      },
      onTap: (ev) => {
        const seat = this.chairAt(ev);
        if (seat !== null) this.cb.onChairClick?.(seat);
      },
      onZoomBeyond: (dir) => this.cb.onRequestMode?.(dir === 'out' ? 'standing' : 'seated'),
      onDoubleTap: (ev) => {
        // The owner double-tapping the house dealer: her picker.
        if (!this.cb.onDealerDoubleTap || !this.dealerHit(ev)) return false;
        this.cb.onDealerDoubleTap();
        return true;
      },
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.warmUntil = performance.now() + 2500;
    this.raf = requestAnimationFrame(this.loop);
  }

  private async loadDealer(shadows: boolean): Promise<void> {
    const { HouseDealer } = await import('./houseDealer.js');
    if (this.disposed) return;
    const d = new HouseDealer(shadows);
    d.root.position.set(0, 0, HOUSE.dealerZ);
    d.root.rotation.y = Math.PI; // faces the table
    this.scene.add(d.root);
    // Anything the stand-in was in the middle of is finished at once; the real one takes over from here.
    this.dealer.flush();
    this.dealer.update(10);
    this.dealer.dispose();
    this.dealer = d;
    this.realDealer = d;
    d.setModel(this.dealerModelUrl);
  }

  // --- Building the room. ---

  /**
   * The casino around the table: a dim, warm room on a big sphere (what's
   * behind the far players), a lamp hanging over the felt, and — on the
   * higher tiers — a soft studio environment for the reflections on chips,
   * cards and chrome.
   */
  private buildRoom(tier: QualityTier): void {
    const tex = this.track(roomTexture(tier === 'high' ? 1024 : 512));
    // Close enough round the room that the bars read as a few metres away.
    const sphereGeo = this.track(new THREE.SphereGeometry(16, 48, 24));
    const room = new THREE.Mesh(sphereGeo, this.track(new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false })));
    room.rotation.y = Math.PI / 2;
    this.scene.add(room);
    this.scene.background = new THREE.Color('#0d0806');
    // The room around: other tables, the bar, people — softened by a warm haze into a background.
    this.room = new CasinoRoom(tier === 'high');
    this.scene.add(this.room.group);
    this.scene.fog = new THREE.FogExp2('#1a0f0a', 0.042);
    if (tier !== 'low') {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = new RoomEnvironment();
      const rt = pmrem.fromScene(env, 0.04);
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = 0.32;
      this.disposables.push(rt, pmrem);
      env.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    // The lamp over the table: a dark shade with its glowing underside.
    const shadeGeo = this.track(new THREE.CylinderGeometry(0.9, 2.4, 0.9, 40, 1, true));
    const shade = new THREE.Mesh(shadeGeo, this.track(new THREE.MeshStandardMaterial({ color: '#1a120c', roughness: 0.55, metalness: 0.3, side: THREE.DoubleSide })));
    shade.position.set(0, 5.6, 0);
    const glowGeo = this.track(new THREE.CircleGeometry(2.3, 40));
    glowGeo.rotateX(Math.PI / 2);
    const glow = new THREE.Mesh(glowGeo, this.track(new THREE.MeshBasicMaterial({ color: '#ffe2b0' })));
    glow.position.set(0, 5.16, 0);
    const cordGeo = this.track(new THREE.CylinderGeometry(0.02, 0.02, 4, 6));
    const cord = new THREE.Mesh(cordGeo, this.track(new THREE.MeshBasicMaterial({ color: '#0a0a0a' })));
    cord.position.set(0, 8, 0);
    this.scene.add(shade, glow, cord);
  }

  private track<T extends { dispose: () => void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private buildLights(shadowSize: number): void {
    this.scene.add(new THREE.HemisphereLight('#ffe7c4', '#24160e', 0.85));
    // Warm overhead casino light, the one that casts shadows.
    const spot = new THREE.SpotLight('#ffd7a3', 62, 0, 1.0, 0.6, 2);
    spot.position.set(0, 5.1, 0.2);
    spot.target.position.set(0, 0, 0);
    spot.castShadow = shadowSize > 0;
    if (shadowSize > 0) {
      spot.shadow.mapSize.set(shadowSize, shadowSize);
      spot.shadow.bias = -0.0003;
      spot.shadow.normalBias = 0.02;
      spot.shadow.camera.near = 1.5;
      spot.shadow.camera.far = 10;
    }
    this.scene.add(spot, spot.target);
    const fill = new THREE.DirectionalLight('#c7d6ff', 0.35);
    fill.position.set(-5, 4, -4);
    this.scene.add(fill);
  }

  private buildTable(texSize: number, shadows: boolean): void {
    const felt = feltTextures(texSize);
    const wood = woodTexture(texSize);
    const leather = leatherTexture(texSize);
    this.track(felt.map);
    this.track(felt.normalMap);
    this.track(wood);
    this.track(leather);

    // The felt, with a baked falloff toward the rail (its ambient-occlusion map, on a second UV set).
    const feltInset = TABLE.railWidth + 0.08;
    const feltGeo = this.track(new THREE.ShapeGeometry(insetRect(feltInset), 32));
    feltGeo.rotateX(-Math.PI / 2);
    const pos = feltGeo.getAttribute('position') as THREE.BufferAttribute;
    const uv1 = new Float32Array(pos.count * 2);
    const uv0 = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv1[i * 2] = pos.getX(i) / (2 * TABLE.halfWidth) + 0.5;
      uv1[i * 2 + 1] = pos.getZ(i) / (2 * TABLE.halfDepth) + 0.5;
      uv0[i * 2] = pos.getX(i) / 2;
      uv0[i * 2 + 1] = pos.getZ(i) / 2;
    }
    feltGeo.setAttribute('uv', new THREE.BufferAttribute(uv0, 2));
    feltGeo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    const ao = this.track(this.feltOcclusion());
    ao.channel = 1;
    felt.map.repeat.set(1, 1);
    felt.normalMap.repeat.set(1, 1);
    const feltMat = this.track(
      new THREE.MeshStandardMaterial({ map: felt.map, normalMap: felt.normalMap, normalScale: new THREE.Vector2(0.55, 0.55), aoMap: ao, aoMapIntensity: 1, roughness: 0.95 }),
    );
    const feltMesh = new THREE.Mesh(feltGeo, feltMat);
    feltMesh.receiveShadow = shadows;
    this.scene.add(feltMesh);

    // A faint printed betting line.
    const lineShape = insetRect(TABLE.railWidth + 0.62);
    lineShape.holes.push(holePath(TABLE.railWidth + 0.645));
    const lineGeo = this.track(new THREE.ShapeGeometry(lineShape, 32));
    lineGeo.rotateX(-Math.PI / 2);
    const lineMat = this.track(new THREE.MeshBasicMaterial({ color: '#e9cf8a', transparent: true, opacity: 0.28, depthWrite: false }));
    const line = new THREE.Mesh(lineGeo, lineMat);
    line.position.y = 0.002;
    this.scene.add(line);

    // The wooden racetrack between the felt and the rail.
    const trackShape = insetRect(TABLE.railWidth - 0.03);
    trackShape.holes.push(holePath(feltInset));
    const trackGeo = this.track(new THREE.ExtrudeGeometry(trackShape, { depth: 0.02, bevelEnabled: false, curveSegments: 32 }));
    trackGeo.rotateX(-Math.PI / 2);
    const woodMat = this.track(new THREE.MeshStandardMaterial({ map: wood, roughness: 0.35, metalness: 0.05 }));
    const trackMesh = new THREE.Mesh(trackGeo, woodMat);
    trackMesh.receiveShadow = shadows;
    this.scene.add(trackMesh);

    // The padded leather rail: a bevelled extrusion reads as a stuffed cushion.
    const bevel = 0.07;
    const railShape = insetRect(bevel);
    railShape.holes.push(holePath(TABLE.railWidth - bevel));
    const railGeo = this.track(
      new THREE.ExtrudeGeometry(railShape, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.07, bevelSize: bevel, bevelSegments: 6, curveSegments: 40 }),
    );
    railGeo.rotateX(-Math.PI / 2);
    const leatherMat = this.track(new THREE.MeshStandardMaterial({ map: leather, roughness: 0.48, metalness: 0.02, color: '#ffffff' }));
    const rail = new THREE.Mesh(railGeo, leatherMat);
    rail.position.y = 0.07;
    rail.castShadow = shadows;
    rail.receiveShadow = shadows;
    this.scene.add(rail);

    // The house dealer's chip tray, set into the felt in front of them.
    const trayGeo = this.track(new THREE.BoxGeometry(HOUSE.trayWidth, 0.03, HOUSE.trayDepth));
    const tray = new THREE.Mesh(trayGeo, this.track(new THREE.MeshStandardMaterial({ color: '#2a160b', roughness: 0.5 })));
    tray.position.set(0, 0.006, TABLE.halfDepth - TABLE.railWidth - HOUSE.trayDepth / 2 - 0.02);
    tray.receiveShadow = shadows;
    this.scene.add(tray);

    // The apron under the rail, and the table's legs.
    const apronGeo = this.track(new THREE.ExtrudeGeometry(insetRect(0.04), { depth: 0.3, bevelEnabled: false, curveSegments: 32 }));
    apronGeo.rotateX(Math.PI / 2);
    const apron = new THREE.Mesh(apronGeo, woodMat);
    // Its top sits just under the felt — level with it, the two would fight over every pixel.
    apron.position.y = -0.015;
    apron.castShadow = shadows;
    this.scene.add(apron);
    const legMat = this.track(new THREE.MeshStandardMaterial({ color: '#1b120c', roughness: 0.6 }));
    const legGeo = this.track(new THREE.CylinderGeometry(0.28, 0.4, -FLOOR_Y - 0.3, 16));
    for (const x of [-1.6, 1.6]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(x, (FLOOR_Y - 0.3) / 2, 0);
      this.scene.add(leg);
    }

    // The floor: dark carpet, catching the table's shadow (or a soft blob of one on the Low tier).
    const floorGeo = this.track(new THREE.CircleGeometry(14, 48));
    floorGeo.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, this.track(new THREE.MeshStandardMaterial({ color: '#2a1517', roughness: 1 })));
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = shadows;
    this.scene.add(floor);
    if (!shadows) {
      const blob = this.track(blobTexture());
      const blobGeo = this.track(new THREE.PlaneGeometry(TABLE.halfWidth * 2.6, TABLE.halfDepth * 2.8));
      blobGeo.rotateX(-Math.PI / 2);
      const b = new THREE.Mesh(blobGeo, this.track(new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false })));
      b.position.y = FLOOR_Y + 0.01;
      this.scene.add(b);
    }
  }

  /** A soft darkening toward the rail — the felt's "baked" ambient light. */
  private feltOcclusion(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(128, 64, 10, 128, 64, 150);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.55, '#e6e6e6');
    g.addColorStop(1, '#7a7a7a');
    ctx.fillStyle = g;
    ctx.save();
    ctx.scale(1, 0.55);
    ctx.fillRect(0, 0, 256, 256);
    ctx.restore();
    return new THREE.CanvasTexture(c);
  }

  /** Low-poly padded casino chairs, one instance per seat for each part: cushion, back, column, base. */
  private buildChairs(count: number): void {
    for (const m of this.chairParts) {
      this.scene.remove(m);
      m.dispose();
    }
    this.chairParts.length = 0;
    if (count === 0) return;
    const shadows = TIERS[this.tier].shadowMapSize > 0;
    const leather = this.chairLeather ?? this.track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.42 }));
    this.chairLeather = leather;
    const chrome = this.chairChrome ?? this.track(new THREE.MeshStandardMaterial({ color: '#b9bcc2', roughness: 0.25, metalness: 0.9 }));
    this.chairChrome = chrome;
    const geos = this.chairGeos ?? {
      cushion: this.track(new RoundedBoxGeometry(0.66, 0.16, 0.6, 3, 0.07)),
      back: this.track(new RoundedBoxGeometry(0.66, 0.74, 0.13, 3, 0.06)),
      column: this.track(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10)),
      base: this.track(new THREE.CylinderGeometry(0.3, 0.32, 0.04, 20)),
    };
    this.chairGeos = geos;
    const parts: [THREE.BufferGeometry, THREE.Material, boolean][] = [
      [geos.cushion, leather, true],
      [geos.back, leather, true],
      [geos.column, chrome, false],
      [geos.base, chrome, false],
    ];
    for (const [geo, mat, tinted] of parts) {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.castShadow = shadows;
      m.receiveShadow = shadows;
      if (tinted) m.setColorAt(0, new THREE.Color());
      this.chairParts.push(m);
      this.scene.add(m);
    }
  }

  private chairLeather: THREE.MeshStandardMaterial | null = null;
  private chairChrome: THREE.MeshStandardMaterial | null = null;
  private chairGeos: { cushion: THREE.BufferGeometry; back: THREE.BufferGeometry; column: THREE.BufferGeometry; base: THREE.BufferGeometry } | null = null;

  private placeChairs(): void {
    if (this.chairParts.length === 0) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const seatY = FLOOR_Y + 0.95;
    this.placements.forEach((p, i) => {
      const own = p.seatId === this.viewerSeatId;
      const base = new THREE.Matrix4().compose(new THREE.Vector3(p.chair.x, 0, p.chair.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.facing), one);
      const local = [
        new THREE.Matrix4().makeTranslation(0, seatY, 0),
        new THREE.Matrix4().makeRotationX(-0.12).premultiply(new THREE.Matrix4().makeTranslation(0, seatY + 0.42, -0.3)),
        new THREE.Matrix4().makeTranslation(0, seatY - 0.5, 0),
        new THREE.Matrix4().makeTranslation(0, FLOOR_Y + 0.02, 0),
      ];
      this.chairParts.forEach((part, k) => {
        // The viewer's own chair is right under the camera — it would only get in the way.
        part.setMatrixAt(i, own ? hidden : m.multiplyMatrices(base, local[k]!));
      });
    });
    for (const part of this.chairParts) part.instanceMatrix.needsUpdate = true;
    this.tintChairs();
  }

  private tintChairs(): void {
    const occupied = new THREE.Color('#4a1018');
    const empty = new THREE.Color('#7a1c2c');
    const hover = new THREE.Color('#c4485c');
    this.placements.forEach((p, i) => {
      const c = p.seatId === this.hoverSeat && !this.occupied.has(p.seatId) ? hover : this.occupied.has(p.seatId) ? occupied : empty;
      for (const part of this.chairParts.slice(0, 2)) part.setColorAt(i, c);
    });
    for (const part of this.chairParts.slice(0, 2)) if (part.instanceColor) part.instanceColor.needsUpdate = true;
  }

  // --- The camera. ---

  /** The height (px) your own box takes at the bottom of the screen, plus a little air. */
  private ownBand(): number {
    if (this.viewerSeatId === null) return 0;
    const o = this.overlays.get(`seat:${String(this.viewerSeatId)}`);
    return (o?.h ?? 80) * Math.max(0.92, this.viewportScale()) + 18;
  }

  /** What has to be on screen from a camera at `yaw`. */
  private fitPoints(yaw: number): FitPoint[] {
    const pts: FitPoint[] = [];
    {
      // Your own cards: on screen, and above your own box at the bottom.
      const me = this.viewerSeatId !== null ? this.placementBySeat.get(this.viewerSeatId) : undefined;
      if (me) {
        const c = edgePoint(me.s, TABLE.railWidth + SEAT_SPOTS.cardsIn + OWN_IN - CARD_H * 0.6);
        pts.push({ p: new THREE.Vector3(c.x, 0, c.z), mx: 0.05, my: 0.05, myBottom: Math.min(0.6, (2 * this.ownBand()) / Math.max(1, this.height)) });
      }
    }
    // The rail right in front of the viewer may run off the screen's edges,
    // as it would sitting there — the rest of the table gets that room.
    const own = this.viewerSeatId !== null ? this.placementBySeat.get(this.viewerSeatId) : undefined;
    const tall = this.width / Math.max(1, this.height) < 0.9;
    const isNear = (s: number): boolean => {
      if (!own) return false;
      const d = Math.abs(s - own.s);
      return Math.min(d, 1 - d) < 0.14;
    };
    // A seated player on a tall phone screen sees the table's middle band —
    // the board, the pot, the house dealer and the seats across from them —
    // with its ends running off the sides (the seats out there keep their
    // boxes on screen). Fitting the whole width would shrink it all to a strip.
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const outOfBand = (x: number, z: number): boolean => tall && !!own && Math.abs(x * rx + z * rz) > 2.75;
    for (let i = 0; i < 48; i++) {
      const s = i / 48;
      const e = edgePoint(s, 0);
      if (isNear(s) || outOfBand(e.x, e.z)) continue;
      pts.push({ p: new THREE.Vector3(e.x, TABLE.railHeight, e.z), mx: 0.02, my: 0.03 });
    }
    // Every other seat's box (video, name, stack) needs room around its anchor.
    const hw = this.width / 2;
    const hh = this.height / 2;
    const vp = this.viewportScale();
    // On a tall screen the width is what's scarce: boxes at the sides get
    // nudged in over the table's edge (positionOverlays keeps them on
    // screen) rather than the whole table shrinking to make room for them.
    const sideRoom = tall ? 0.18 : 0.42;
    for (const p of this.placements) {
      if (p.seatId === this.viewerSeatId || outOfBand(p.chair.x, p.chair.z)) continue;
      const o = this.overlays.get(`seat:${String(p.seatId)}`);
      const w = (o?.w ?? 120) * sideRoom * vp;
      const h = (o?.h ?? 90) * 0.45 * vp;
      pts.push({ p: new THREE.Vector3(p.chair.x, SEAT_SPOTS.overlayHeight, p.chair.z), mx: Math.min(0.45, w / hw), my: Math.min(0.45, h / hh) });
    }
    pts.push({ p: new THREE.Vector3(0, 1.9, HOUSE.dealerZ), mx: 0.02, my: 0.02 });
    return pts;
  }

  /** Seat boxes shrink on a small screen — a phone's table is a third the size of a laptop's. */
  private viewportScale(): number {
    return Math.max(0.6, Math.min(1, Math.min(this.width, this.height * 1.35) / 820));
  }

  private targetPose(): CameraPose {
    const aspect = this.width / Math.max(1, this.height);
    const own = this.viewerSeatId !== null ? this.placementBySeat.get(this.viewerSeatId) : undefined;
    if (!own) {
      // A spectator: higher, from the far side, facing the house dealer — or,
      // on a tall phone screen, from the table's end, so its length runs up the screen.
      const base = aspect < 0.9 ? { yaw: -Math.PI / 2, elev: 1.05, tx: 0, tz: 0 } : { yaw: Math.PI, elev: 0.95, tx: 0, tz: 0.1 };
      return { ...base, dist: this.rig.solveDistance(base, orbitFov(aspect), this.fitPoints(base.yaw), 4) };
    }
    const len = Math.hypot(own.chair.x, own.chair.z) || 1;
    const dx = own.chair.x / len;
    const dz = own.chair.z / len;
    const yaw = Math.atan2(dx, dz);
    // High enough to look over the house dealer from the two seats beside
    // them; on a tall phone screen higher still, so the table's depth
    // fills the height the screen has to spare.
    const elev = aspect < 0.75 ? 1.05 : aspect < 1.1 ? 0.98 : 0.86;
    // Looking a little beyond the center, so the viewer's own spot gets the bottom of the screen.
    const tx = -dx * 0.3;
    const tz = -dz * 0.3;
    // Never in front of the viewer's own chair (on a steep phone view, just above it).
    const behind = (Math.hypot(own.chair.x - tx, own.chair.z - tz) + 0.25) * (aspect < 0.75 ? 0.7 : 1);
    const base = { yaw, elev, tx, tz };
    return { ...base, dist: this.rig.solveDistance(base, orbitFov(aspect), this.fitPoints(yaw), behind / Math.cos(elev)) };
  }

  /** Whether the camera is the viewer's own eyes right now (seated view, and they have a seat). */
  private get eyes(): boolean {
    return this.mode === 'seated' && this.viewerSeatId !== null && this.placementBySeat.has(this.viewerSeatId);
  }

  /** The seated view's field of view: about what two eyes take in across a landscape screen; a phone held upright shows a taller slice. */
  private seatedFov(): number {
    const aspect = this.width / Math.max(1, this.height);
    // Upright phone: tall enough that its narrow width still takes in the board.
    if (aspect < 1) return Math.min(92, 70 + (1 - aspect) * 40);
    const v = (2 * Math.atan(Math.tan((44 * Math.PI) / 180) / aspect) * 180) / Math.PI;
    return Math.max(48, Math.min(70, v));
  }

  /** Where the seated viewer's eyes are, and the heading that looks at the middle of the table from there. */
  private eyeBase(): { eye: THREE.Vector3; heading: number } | null {
    const own = this.viewerSeatId !== null ? this.placementBySeat.get(this.viewerSeatId) : undefined;
    if (!own) return null;
    const sitting = edgePoint(own.s, -EYE.out);
    // Straight ahead is always measured from where you sit, leaning or not.
    const heading = Math.atan2(0 - sitting.x, HOUSE.boardZ - sitting.z);
    const p = edgePoint(own.s, -EYE.out + LEAN.forward * this.lean);
    const eye = new THREE.Vector3(p.x, EYE.y - LEAN.down * this.lean, p.z);
    // Leaning in over the board: straight toward its middle, and up a little.
    const b = this.boardLean;
    if (b > 0) {
      const toX = 0 - eye.x;
      const toZ = HOUSE.boardZ - eye.z;
      const dist = Math.hypot(toX, toZ);
      const go = Math.max(0, Math.min(BOARD_LEAN.forward, dist - BOARD_LEAN.nearest)) * b;
      eye.x += (toX / dist) * go;
      eye.z += (toZ / dist) * go;
      eye.y += BOARD_LEAN.up * b;
    }
    return { eye, heading };
  }

  /**
   * How far the seated viewer wants to lean: all the way when they've
   * asked to (the Lean in button); otherwise, at the two seats beside the
   * house dealer, more the more they turn toward the dealer — looking past
   * them to the player on the other side is exactly when you'd bend forward.
   */
  private leanGoal(): number {
    if (this.leanManual) return 1;
    // Leaning in over the board takes over from leaning past the dealer.
    if (this.boardLean > 0.02) return 0;
    const own = this.viewerSeatId !== null ? this.placementBySeat.get(this.viewerSeatId) : undefined;
    if (!own || (own.s > 0.16 && own.s < 0.84)) return 0;
    const sitting = edgePoint(own.s, -EYE.out);
    const base = Math.atan2(0 - sitting.x, HOUSE.boardZ - sitting.z);
    const toDealer = Math.atan2(0 - sitting.x, HOUSE.dealerZ - sitting.z);
    const heading = base + this.look.current.yaw;
    const off = Math.abs(Math.atan2(Math.sin(heading - toDealer), Math.cos(heading - toDealer)));
    // Full lean within ~10° of the dealer, easing off to none by ~55°.
    const t = Math.max(0, Math.min(1, 1 - (off - 0.17) / 0.8));
    return t * t * (3 - 2 * t);
  }

  /**
   * How far down a seat looks by default — worked out for that seat, so
   * wherever you sit your own two cards are just inside the bottom of the
   * screen and the far players are still in view at the top (your cards
   * win if a very wide screen can't fit both).
   */
  private seatPitch(): number {
    const own = this.viewerSeatId !== null ? this.placementBySeat.get(this.viewerSeatId) : undefined;
    if (!own) return -0.3;
    const sitting = edgePoint(own.s, -EYE.out);
    const cards = edgePoint(own.s, TABLE.railWidth + SEAT_SPOTS.cardsIn + OWN_IN);
    const dOwn = Math.hypot(cards.x - sitting.x, cards.z - sitting.z);
    // Down to the near edge of your cards, and a little margin.
    // …above the band your own box takes at the bottom of the screen.
    const band = (this.ownBand() / Math.max(1, this.height)) * ((this.seatedFov() * Math.PI) / 180);
    const toCards = Math.atan2(EYE.y, Math.max(0.2, dOwn - (CARD_H * 1.15) / 2)) + (3 * Math.PI) / 180 + band;
    const dBoard = Math.hypot(sitting.x, sitting.z - HOUSE.boardZ);
    const toBoard = Math.atan2(EYE.y, dBoard);
    const half = ((this.seatedFov() / 2) * Math.PI) / 180;
    const hi = half - toCards;
    const lo = (6 * Math.PI) / 180 - half;
    return lo > hi ? hi : Math.min(hi, Math.max(lo, -toBoard));
  }

  /** How far the seated viewer is leaning in over the board (eased), from their drag. */
  private get boardLean(): number {
    return this.eyes ? smooth(this.look.current.lean) : 0;
  }

  /** Eases the lean toward its goal; true while it's still moving. */
  private updateLean(dt: number): boolean {
    const goal = this.eyes ? this.leanGoal() : 0;
    const d = goal - this.lean;
    if (Math.abs(d) < 0.002) {
      this.lean = goal;
      return false;
    }
    this.lean += this.reduceMotion ? d : d * (1 - Math.exp(-5 * dt));
    return true;
  }

  /** The Lean in button: bend forward over the rail (or sit back). */
  setLean(on: boolean): void {
    this.leanManual = on;
  }

  /**
   * The seated view: the eyes fixed at the seat, the head turned by the
   * look controls. Straight ahead is the middle of the table, looking down
   * enough to see your own cards in front of you and still the far
   * players' faces.
   */
  private eyeView(): CameraView {
    const base = this.eyeBase()!;
    const L = this.look.current;
    let heading = base.heading + L.yaw;
    let pitch = this.look.basePitch + L.pitch;
    // Leaning in, the eyes go to the board: by full lean, looking right at its middle.
    const b = this.boardLean;
    if (b > 0) {
      const toX = 0 - base.eye.x;
      const toZ = HOUSE.boardZ - base.eye.z;
      const atBoard = Math.atan2(toX, toZ);
      const down = -Math.atan2(base.eye.y, Math.hypot(toX, toZ));
      heading += Math.atan2(Math.sin(atBoard - heading), Math.cos(atBoard - heading)) * b;
      pitch += (down - pitch) * b;
    }
    const dir = new THREE.Vector3(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), Math.cos(heading) * Math.cos(pitch));
    return { pos: base.eye.clone(), target: base.eye.clone().add(dir), fov: this.seatedFov() * L.zoom };
  }

  private retarget(animate: boolean): void {
    const aspect = this.width / Math.max(1, this.height);
    this.rig.setAspect(aspect);
    this.look.enabled = this.eyes;
    this.look.zoomOnly = this.mode === 'standing' && this.viewerSeatId !== null;
    this.look.basePitch = this.seatPitch();
    // Your fingers drive the view (look, pinch) — not the page under it.
    this.canvas.style.touchAction = this.eyes || this.look.zoomOnly ? 'none' : '';
    const view = this.eyes ? this.eyeView() : orbitView(this.targetPose(), orbitFov(aspect));
    this.rig.goTo(view, animate && !this.reduceMotion);
    this.layoutDirty = true;
  }

  /** Seated (the viewer's own eyes) or standing (the whole table from their seat, on their feet). */
  setMode(mode: View3dMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.look.recenter();
    this.look.snap();
    this.retarget(true);
  }

  /** Which character deals (a model file under public/models/dealers), or null for the built-in one. */
  /** The other players' cameras (seat → stream): each worn as a screen on their head (see players3d.ts). */
  setSeatVideos(videos: ReadonlyMap<number, MediaStream>): void {
    this.players.setVideos(videos);
    this.layoutDirty = true;
  }

  setDealerModel(url: string | null): void {
    this.dealerModelUrl = url;
    this.realDealer?.setModel(url);
  }

  private dealerHit(ev: PointerEvent): boolean {
    if (!this.realDealer) return false;
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.rig.camera);
    return this.realDealer.hit(this.raycaster);
  }

  /** Eyes back on the table (the Center view button). */
  recenterLook(): void {
    this.look.recenter();
  }

  // --- Public API. ---

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.retarget(false);
  }

  setReduceMotion(on: boolean): void {
    this.reduceMotion = on;
    this.chips.reduceMotion = on;
    this.cards.reduceMotion = on;
    this.button.reduceMotion = on;
  }

  /** Anchors a DOM element to `seat:<id>`, `bet:<id>`, `pot` or `board` (null detaches). The scene positions it every frame the view moves. */
  setOverlay(key: string, el: HTMLElement | null): void {
    const prev = this.overlays.get(key);
    if (prev?.el === el) return;
    if (prev) this.resizeObs.unobserve(prev.el);
    if (!el) {
      this.overlays.delete(key);
      return;
    }
    this.overlays.set(key, { el, w: el.offsetWidth, h: el.offsetHeight });
    this.resizeObs.observe(el);
    this.layoutDirty = true;
  }

  setHoverSeat(seatId: number | null): void {
    if (this.hoverSeat === seatId) return;
    this.hoverSeat = seatId;
    this.tintChairs();
  }

  /** The seat ids on the table and whose view this is; re-aims the camera (gliding there when the viewer sits or moves). */
  setSeats(seatIds: readonly number[], viewerSeatId: number | null): void {
    const key = `${seatIds.join(',')}|${String(viewerSeatId)}`;
    if (key === this.seatKey) return;
    const first = this.seatKey === '';
    const seatsChanged = this.seatKey.split('|')[0] !== seatIds.join(',');
    this.seatKey = key;
    this.viewerSeatId = viewerSeatId;
    this.placements = seatPlacements(seatIds);
    this.placementBySeat.clear();
    for (const p of this.placements) this.placementBySeat.set(p.seatId, p);
    if (seatsChanged) {
      this.buildChairs(this.placements.length);
      this.chairSeatIds = this.placements.map((p) => p.seatId);
    }
    this.placeChairs();
    const spots = new Map<number, SeatCardSpot>();
    for (const p of this.placements) spots.set(p.seatId, { x: p.cards.x, z: p.cards.z, facing: p.facing });
    this.cards.setSeatSpots(spots, viewerSeatId);
    this.button.setViewerSeat(viewerSeatId !== null ? (this.placementBySeat.get(viewerSeatId) ?? null) : null);
    // A new seat: eyes front.
    this.look.recenter();
    this.look.snap();
    this.retarget(!first);
  }

  /** Brings the table up to date: first the events (they start the animations), then the state itself (what should be where). */
  apply(snapshot: SceneSnapshot, events: readonly ProjectedGameEvent[] | null): void {
    this.occupied = new Set(snapshot.seats.filter((s) => s.occupied).map((s) => s.seatId));
    this.tintChairs();
    this.players.sync(
      this.placementBySeat,
      snapshot.seats.filter((s) => s.occupied).map((s) => ({ seatId: s.seatId, hue: s.hue, seed: s.seed, folded: !s.inHand })),
      this.viewerSeatId,
    );
    if (events) this.handleEvents(events, snapshot);
    this.sync(snapshot);
    this.lastSnapshot = snapshot;
  }

  /**
   * Pushes part of the pot out to its winners: it divides into one pile per
   * award, the piles spread apart, then slide to each winner's spot in turn.
   * The split-pot announcement calls this once per pot, in award order.
   */
  distributePot(awards: readonly { seatId: number; amount: number }[], opts: { pileMs: number; slideMs: number; staggerMs: number }): void {
    const piles = awards
      .map((a) => {
        const p = this.placementBySeat.get(a.seatId);
        return p ? { amount: a.amount, x: p.bet.x, z: p.bet.z } : null;
      })
      .filter((p): p is { amount: number; x: number; z: number } => p !== null);
    const total = awards.reduce((s, a) => s + a.amount, 0);
    // The last bets may still be sliding in: the whole pot is there now.
    this.potHoldUntil = 0;
    this.potShown = Math.max(this.potShown, this.potWanted - this.potPaid, total);
    this.chips.setStack('pot', 0, HOUSE.potZ, this.potShown, 36);
    this.chips.splitStack('pot', piles, opts.pileMs, opts.slideMs, opts.staggerMs);
    // Each pile landing in front of its winner.
    piles.forEach((_, i) => playChipSound((opts.pileMs + i * opts.staggerMs + opts.slideMs * 0.9) / 1000));
    this.potPaid += total;
    this.potShown = Math.max(0, this.potShown - total);
    if (this.potShown > 0) this.chips.setStack('pot', 0, HOUSE.potZ, this.potShown, 36);
    else this.potGone = true;
    this.cb.onPotShown?.(this.potShown);
  }

  /** Raises the given cards (a split pot's winning hands) while it's announced. */
  highlightCards(cards: ReadonlySet<string>): void {
    this.cards.setHighlight(cards);
  }

  /** Every remaining split-pot step done at once (the viewer skipped it, or the next hand began). */
  finishPot(): void {
    // Nothing to finish unless a split is actually being pushed out pot by pot.
    if (!this.externalPot) return;
    this.potGone = true;
    this.externalPot = false;
    this.showPot();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
  }

  private handPos(): THREE.Vector3 {
    return this.dealer.rightHandWorld(new THREE.Vector3());
  }

  /** The dealer's turn toward a seat, degrees in its own frame (0 straight ahead, positive to its left). */
  private yawToSeat(seatId: number): number {
    const p = this.placementBySeat.get(seatId);
    if (!p) return 0;
    // The house dealer faces -Z from +Z; its left is -X... seen from above, a seat to the dealer's left is at -X.
    const dx = p.cards.x;
    const dz = HOUSE.dealerZ - p.cards.z;
    return (Math.atan2(-dx, dz) * 180) / Math.PI;
  }

  /** A card leaving the house dealer's hand — with its flick. */
  private deal(key: string): void {
    this.cards.launch(key, this.handPos());
    // Cards that all land at once (the game ran ahead of the deal) make one flick, not a burst.
    const now = performance.now();
    if (now - this.lastFlick > 35) playCardFlickSound();
    this.lastFlick = now;
  }

  private lastFlick = 0;

  private handleEvents(events: readonly ProjectedGameEvent[], snap: SceneSnapshot): void {
    let chipClinks = 0;
    const awards: { potIndex: number; winners: readonly { seatId: number; amount: number }[] }[] = [];
    let buttonSeat = snap.buttonSeat;
    for (const e of events) {
      switch (e.type) {
        case 'hand-started': {
          // The house dealer sweeps up the last hand, the button slides on, then the shuffle.
          const hadCards = this.cards.keys().length > 0;
          for (const key of this.cards.keys()) this.cards.muck(key, this.handPos());
          this.later(TIMINGS.cardFlightMs + 50, () => {
            this.cards.clearMuck();
            this.cards.pruneFaces();
          });
          this.boardCount = 0;
          this.potGone = false;
          this.externalPot = false;
          this.potShown = 0;
          this.potPaid = 0;
          this.handOver = false;
          for (const key of this.chips.stackKeys()) this.chips.setStack(key, 0, 0, 0);
          buttonSeat = e.buttonSeat;
          this.button.placeAt(this.placementBySeat.get(e.buttonSeat) ?? null, true);
          // The deck was shuffled during the break (see 'hand-complete'): now just the
          // sweep (or the button's slide) and a cut, so the cards reach the players fast.
          if (this.dealer.busy) this.dealer.flush();
          if (hadCards) this.dealer.play('collect');
          else this.dealer.wait(TIMINGS.buttonSlideMs / 1000);
          // The sounds go with the house dealer's hands: the shuffle, the riffle.
          this.dealer.play('cut');
          break;
        }
        case 'cards-dealt': {
          const order = dealOrder(e.seats, buttonSeat ?? -1);
          for (let round = 0; round < 2; round++) {
            for (const seatId of order) {
              const key = `hole:${String(seatId)}:${String(round)}`;
              this.cards.place(key, { kind: 'hole', seatId, index: round }, null, true);
              this.dealer.play('deal', { yaw: this.yawToSeat(seatId), onRelease: () => this.deal(key) });
            }
          }
          break;
        }
        case 'street-dealt': {
          const start = this.boardCount;
          const fresh = e.board.slice(start);
          this.boardCount = e.board.length;
          if (fresh.length === 0) break;
          // The game's ahead of the deal animation: everyone's cards are just there now.
          if (this.dealer.busy) {
            this.dealer.flush();
            this.cards.revealWaiting();
          }
          const burnKey = `burn:${String(start)}`;
          this.cards.place(burnKey, { kind: 'muck', n: 20 + start }, null, true);
          this.dealer.play('burn', { onRelease: () => this.deal(burnKey) });
          fresh.forEach((card, i) => this.cards.place(`board:${String(start + i)}`, { kind: 'board', index: start + i }, card, true));
          const clip = fresh.length >= 3 ? 'flop' : e.street === 'river' ? 'river' : 'turn';
          this.dealer.play(clip, {
            ...(fresh.length >= 3 ? {} : { releases: [0.5] }),
            onRelease: (i) => this.deal(`board:${String(start + i)}`),
          });
          break;
        }
        case 'blinds-posted':
        case 'ante-posted':
          playChipSound(chipClinks++ * 0.06);
          break;
        case 'action-taken':
          // Chips going in: a bet, a raise, a call.
          if (e.action.type === 'bet' || e.action.type === 'raise' || e.action.type === 'call') playChipSound(chipClinks++ * 0.06);
          break;
        case 'betting-round-closed':
          this.sweepBets();
          break;
        case 'hand-complete':
          // A hand won by everyone else folding has no closing round: its last bets go in now.
          this.handOver = true;
          this.sweepBets();
          // Between hands the house dealer shuffles the next deck: the
          // shuffle, the riffle, the bridge — while the pot goes out and the
          // break counts down, so the next hand starts with a cut and a deal.
          this.later(2200, () => {
            this.dealer.play('flourish');
            this.dealer.play('shuffle', { releases: [0.05], onRelease: () => playShuffleSound() });
            this.dealer.play('riffle', { releases: [0.1], onRelease: () => playShuffleSound() });
            this.dealer.play('bridge');
          });
          break;
        case 'pot-awarded':
          awards.push({ potIndex: e.potIndex, winners: e.winners });
          break;
        default:
          break;
      }
    }
    if (awards.length > 0) {
      if (awards.some((a) => a.winners.length > 1)) {
        this.externalPot = true;
      } else {
        // One winner per pot: the pot simply goes to them once the last bets are in.
        const bySeat = new Map<number, number>();
        for (const a of awards) for (const w of a.winners) bySeat.set(w.seatId, (bySeat.get(w.seatId) ?? 0) + w.amount);
        this.later(500, () => {
          if (this.potGone || this.externalPot) return;
          this.distributePot([...bySeat].map(([seatId, amount]) => ({ seatId, amount })), { pileMs: 0, slideMs: 600, staggerMs: 150 });
          this.dealer.play('collect');
        });
      }
    }
  }

  private sync(snap: SceneSnapshot): void {
    this.cards.setViewYaw(this.rig.yaw);
    // Hole cards: whoever's holding cards has two in front of them.
    const wanted = new Set<string>();
    for (const s of snap.seats) {
      if (!s.inHand || !this.placementBySeat.has(s.seatId)) continue;
      for (let i = 0; i < 2; i++) {
        const key = `hole:${String(s.seatId)}:${String(i)}`;
        wanted.add(key);
        this.cards.place(key, { kind: 'hole', seatId: s.seatId, index: i }, s.faces[i] ?? null, false);
      }
    }
    snap.board.forEach((card, i) => {
      const key = `board:${String(i)}`;
      wanted.add(key);
      this.cards.place(key, { kind: 'board', index: i }, card, false);
    });
    for (const key of this.cards.keys()) {
      if (key.startsWith('muck:') || key.startsWith('burn:') || wanted.has(key)) continue;
      // A fold: the cards go face down onto the muck.
      this.cards.muck(key);
    }
    if (snap.board.length < this.boardCount) this.boardCount = snap.board.length;
    // Leaning in over the board: only once there's a flop to lean over.
    this.look.leanAllowed = snap.board.length >= 3;
    this.boardCount = Math.max(this.boardCount, snap.board.length);

    // Bets, in front of each player.
    let bets = 0;
    for (const s of snap.seats) {
      const p = this.placementBySeat.get(s.seatId);
      const bet = this.handOver ? 0 : s.bet;
      bets += bet;
      if (!p) continue;
      const key = `bet:${String(s.seatId)}`;
      if (bet > 0 || this.chips.hasStack(key)) this.chips.setStack(key, p.bet.x, p.bet.z, bet, 20);
    }
    // The pot in the middle.
    this.potWanted = Math.max(0, snap.potTotal - bets);
    if (performance.now() >= this.potHoldUntil) this.showPot();

    // The dealer button: put where the game state says, no correction (the hand-start slide is in handleEvents).
    const btn = snap.buttonSeat !== null ? (this.placementBySeat.get(snap.buttonSeat) ?? null) : null;
    this.button.placeAt(btn, false);
  }

  /** Everyone's bets swept into the middle; the pot grows as they arrive. */
  private sweepBets(): void {
    const keys = this.chips.stackKeys().filter((k) => k.startsWith('bet:'));
    if (keys.length === 0) return;
    playChipSound(0.12);
    playChipSound(0.26);
    for (const key of keys) this.chips.sendStack(key, 0, HOUSE.potZ, 0, 380);
    this.potHoldUntil = performance.now() + 420;
  }

  private showPot(): void {
    const want = this.potGone ? 0 : Math.max(0, this.potWanted - this.potPaid);
    if (want === this.potShown) return;
    this.potShown = want;
    this.chips.setStack('pot', 0, HOUSE.potZ, this.potShown, 36);
    this.cb.onPotShown?.(this.potShown);
  }

  // --- Pointer: hovering and clicking an empty chair. ---

  private chairAt(ev: PointerEvent | MouseEvent): number | null {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.rig.camera);
    const hits = this.raycaster.intersectObjects(this.chairParts.slice(0, 2), false);
    const id = hits[0]?.instanceId;
    if (id === undefined) return null;
    const seatId = this.chairSeatIds[id];
    return seatId !== undefined && !this.occupied.has(seatId) ? seatId : null;
  }

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (this.look.dragging) return;
    const seat = this.chairAt(ev);
    this.canvas.style.cursor = seat !== null && this.cb.onChairClick ? 'pointer' : '';
    this.setHoverSeat(seat);
  };

  private readonly onPointerLeave = (): void => {
    this.canvas.style.cursor = '';
    this.setHoverSeat(null);
  };


  private readonly onVisibility = (): void => {
    // Coming back to the tab: no giant time step, and no frame-time sample spanning the hidden time.
    this.lastFrame = 0;
    this.frameTimes.length = 0;
  };

  // --- The loop. ---

  private readonly loop = (time: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const now = performance.now();
    const stepDt = Math.min(0.1, (now - (this.lastRender || now)) / 1000);
    const turning = this.eyes && this.look.update(stepDt, this.reduceMotion);
    const leaning = this.updateLean(stepDt);
    const looking = turning || leaning;
    const active = looking || this.rig.moving || this.chips.animating || this.cards.animating || this.button.animating || this.dealer.busy || this.layoutDirty || now < this.warmUntil;
    const minInterval = active ? 0 : 1000 / TIERS[this.tier].idleFps;
    if (now - this.lastRender < minInterval - 2) {
      this.lastFrame = 0;
      return;
    }
    // Frame-time sampling only over back-to-back frames.
    if (this.lastFrame > 0 && active) {
      this.frameTimes.push(time - this.lastFrame);
      if (this.frameTimes.length >= 90) {
        const sorted = [...this.frameTimes].sort((a, b) => a - b);
        // The median: one hiccup (a tab switch, a GC) isn't "this device is slow".
        this.cb.onPerf?.(sorted[Math.floor(sorted.length / 2)]!);
        this.frameTimes.length = 0;
      }
    }
    this.lastFrame = time;
    const dt = this.lastRender > 0 ? Math.min(0.1, (now - this.lastRender) / 1000) : 1 / 60;
    this.lastRender = now;

    if (this.eyes) this.rig.follow(this.eyeView());
    const away = this.eyes && this.look.offCenter;
    if (away !== this.lookAway) {
      this.lookAway = away;
      this.cb.onLookAway?.(away);
    }
    const moving = this.rig.update(now) || looking;
    this.cards.setViewYaw(this.rig.yaw);
    this.dealer.update(dt);
    if (now >= this.potHoldUntil && this.potHoldUntil > 0) {
      this.potHoldUntil = 0;
      this.showPot();
    }
    this.chips.update(now);
    this.cards.update(now);
    const mine = this.viewerSeatId !== null && this.cards.ownLanded(this.viewerSeatId);
    if (mine !== this.ownLandedNow) {
      this.ownLandedNow = mine;
      this.cb.onOwnCards?.(mine);
    }
    const shown = this.cards.boardShown();
    if (shown !== this.boardShownCount) {
      this.boardShownCount = shown;
      this.cb.onBoardShown?.(shown);
    }
    this.button.update(now, this.rig.yaw);
    this.players.update(now, this.rig.camera.position);
    this.room.update(now);
    this.renderer.render(this.scene, this.rig.camera);
    // The page's own controls on the felt (the Play Hand panel, the full-screen
    // button) come and go with the game: twice a second, see whether they moved.
    if (now - this.lastObstacleCheck > 500) {
      this.lastObstacleCheck = now;
      const key = this.obstacleRects()
        .map((r) => `${r.x0.toFixed(0)},${r.y0.toFixed(0)},${r.x1.toFixed(0)},${r.y1.toFixed(0)}`)
        .join('|');
      if (key !== this.obstacleKey) {
        this.obstacleKey = key;
        this.layoutDirty = true;
      }
    }
    if (moving || this.layoutDirty) this.positionOverlays(!moving);
  };

  private lastObstacleCheck = 0;
  private obstacleKey = '';

  /** DOM controls laid over the felt that the seat boxes keep clear of, in this view's px. */
  private obstacleRects(): { x0: number; y0: number; x1: number; y1: number }[] {
    const wrap = this.canvas.parentElement;
    const felt = wrap?.parentElement;
    if (!wrap || !felt) return [];
    const origin = wrap.getBoundingClientRect();
    const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const el of felt.querySelectorAll<HTMLElement>(OBSTACLES)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({ x0: r.left - origin.left, y0: r.top - origin.top, x1: r.right - origin.left, y1: r.bottom - origin.top });
    }
    return out;
  }

  private readonly v = new THREE.Vector3();

  private project(x: number, y: number, z: number): { x: number; y: number; depth: number; behind: boolean } {
    this.v.set(x, y, z).project(this.rig.camera);
    const depth = this.rig.camera.position.distanceTo(new THREE.Vector3(x, y, z));
    return { x: ((this.v.x + 1) / 2) * this.width, y: ((1 - this.v.y) / 2) * this.height, depth, behind: this.v.z > 1 };
  }

  /** Whether a projected point is somewhere the viewer can see (with some slack past the edges). */
  private onScreen(p: { x: number; y: number; behind: boolean }, slack: number): boolean {
    return !p.behind && p.x > -slack && p.x < this.width + slack && p.y > -slack && p.y < this.height + slack;
  }

  private place(el: HTMLElement, transform: string | null): void {
    if (transform === null) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = '';
    el.style.transform = transform;
  }

  /**
   * Places every DOM box at its 3D anchor, scaled for distance, nudged
   * apart where they'd overlap. Standing (or spectating): every seat is
   * kept on screen and clear of the board. Seated: true perspective — the
   * other players' boxes sit at their heads and are only there when you're
   * looking their way; your own box is a small one in the corner, since
   * you're the one looking.
   */
  private positionOverlays(settled: boolean): void {
    const ref = this.rig.camera.position.length();
    const vp = this.viewportScale();
    const eyes = this.eyes;
    const seats: { id: number; x: number; y: number; w: number; h: number; s: number; el: HTMLElement; fixed: boolean }[] = [];
    const hidden: HTMLElement[] = [];
    /** Players out of view right now (seated): where they are, for their markers at the screen's edge. */
    const away: { id: number; at: THREE.Vector3 }[] = [];
    const head = new THREE.Vector3();
    for (const p of this.placements) {
      const o = this.overlays.get(`seat:${String(p.seatId)}`);
      if (!o) continue;
      if (p.seatId === this.viewerSeatId) {
        // Your own box (your camera, your stack — in big type) sits at the bottom middle of the screen,
        // clear of your cards (the view keeps them above it — see ownBand) and of the corners' controls.
        o.el.dataset.hud = 'true';
        const s = Math.max(0.92, vp);
        seats.push({ id: p.seatId, x: this.width / 2, y: this.height - (o.h * s) / 2 - 8, w: o.w * s, h: o.h * s, s, el: o.el, fixed: true });
        continue;
      }
      delete o.el.dataset.hud;
      const body = this.players.headWorld(p.seatId, head);
      if (!body) {
        // Nobody sitting there (an empty seat's "Sit here"), or your own seat seen standing: over the chair.
        const pr = this.project(p.chair.x, SEAT_SPOTS.overlayHeight, p.chair.z);
        if (eyes && !this.onScreen(pr, 60)) {
          hidden.push(o.el);
          continue;
        }
        // An empty seat's "Sit here" stays big enough to tap, however far away.
        const s = (eyes ? Math.max(0.85, Math.min(1.05, 2.6 / pr.depth)) : Math.max(0.66, Math.min(1.1, (ref / pr.depth) * 0.86))) * vp;
        seats.push({ id: p.seatId, x: pr.x, y: pr.y, w: o.w * s, h: o.h * s, s, el: o.el, fixed: false });
        continue;
      }
      // Their face — modelled, or their camera as a screen in the scene (see players3d.ts's
      // FaceScreen) — with a nameplate (name, stack, cards) just above it.
      const pr = this.project(head.x, head.y + (this.players.hasFace(p.seatId) ? 0.42 : 0.3), head.z);
      if (eyes && !this.onScreen(pr, 60)) {
        hidden.push(o.el);
        away.push({ id: p.seatId, at: head.clone() });
        continue;
      }
      // Never so small that their stack can't be read at a glance.
      const s = Math.max(0.8, (eyes ? Math.min(1.05, 2.6 / pr.depth) : Math.min(1, (ref / pr.depth) * 0.8)) * vp);
      // Anchored by its bottom edge: the box's centre goes half its height higher.
      seats.push({ id: p.seatId, x: pr.x, y: pr.y - (o.h * s) / 2, w: o.w * s, h: o.h * s, s, el: o.el, fixed: false });
    }
    // The board's footprint on screen (it lies still on the felt, parallel to the house dealer's edge).
    const bx = 2 * HOUSE.boardSpacing + (CARD_W * BOARD_SCALE) / 2 + 0.04;
    const bz = (CARD_H * BOARD_SCALE) / 2 + 0.04;
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => this.project(sx * bx, 0, HOUSE.boardZ + sz * bz)));
    const boardVisible = corners.every((c) => !c.behind);
    const board = {
      x0: Math.min(...corners.map((c) => c.x)),
      x1: Math.max(...corners.map((c) => c.x)),
      y0: Math.min(...corners.map((c) => c.y)),
      y1: Math.max(...corners.map((c) => c.y)),
    };
    const fixed = eyes ? this.obstacleRects() : [board, ...this.obstacleRects()];
    const margin = 4;
    for (let iter = 0; iter < 40; iter++) {
      let moved = false;
      for (let i = 0; i < seats.length; i++) {
        const a = seats[i]!;
        if (a.fixed) continue;
        for (let j = 0; j < seats.length; j++) {
          const b = seats[j]!;
          if (j <= i && !b.fixed) continue;
          if (j === i) continue;
          const ox = (a.w + b.w) / 2 + 6 - Math.abs(a.x - b.x);
          const oy = (a.h + b.h) / 2 + 6 - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          // A fixed box (your own, in the corner) doesn't budge: the other one moves the whole way.
          const share = b.fixed ? 1 : 0.5;
          if (ox < oy) {
            const d = ox * share * Math.sign(a.x - b.x || 1);
            a.x += d;
            if (!b.fixed) b.x -= d;
          } else {
            const d = oy * share * Math.sign(a.y - b.y || 1);
            a.y += d;
            if (!b.fixed) b.y -= d;
          }
        }
        // Off the board, and off the page's own controls on the felt.
        for (const f of fixed) {
          const ox = Math.min(a.x + a.w / 2, f.x1 + 4) - Math.max(a.x - a.w / 2, f.x0 - 4);
          const oy = Math.min(a.y + a.h / 2, f.y1 + 4) - Math.max(a.y - a.h / 2, f.y0 - 4);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          const up = a.y < (f.y0 + f.y1) / 2;
          // Up off the screen's top is no way out: go sideways instead.
          const roomUp = a.y - oy - a.h / 2 >= margin;
          if (oy < ox && (!up || roomUp)) a.y += up ? -oy : oy;
          else a.x += a.x < (f.x0 + f.x1) / 2 ? -ox : ox;
        }
        // On screen — fully when standing; seated, a player off to the side is
        // off to the side, but a nameplate above someone's head never leaves the top.
        if (eyes) a.y = Math.max(a.h / 2 + margin, a.y);
        else {
          a.x = Math.min(this.width - a.w / 2 - margin, Math.max(a.w / 2 + margin, a.x));
          a.y = Math.min(this.height - a.h / 2 - margin, Math.max(a.h / 2 + margin, a.y));
        }
      }
      if (!moved) break;
    }
    const layout: ScreenLayout = { width: this.width, height: this.height, seats: new Map(), pot: { x: 0, y: 0 }, board: { x: 0, y: 0 }, boardTop: board.y0 };
    for (const a of seats) {
      this.place(a.el, `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px) translate(-50%, -50%) scale(${a.s.toFixed(3)})`);
      layout.seats.set(a.id, { x: a.x, y: a.y });
    }
    for (const el of hidden) this.place(el, null);
    this.placeEdgeMarkers(away);
    // Each bet's amount just in front of its chips, toward the viewer; the pot's below the pot.
    const toward = { x: Math.sin(this.rig.yaw), z: Math.cos(this.rig.yaw) };
    for (const p of this.placements) {
      const o = this.overlays.get(`bet:${String(p.seatId)}`);
      if (!o) continue;
      const pr = this.project(p.bet.x + toward.x * 0.17, 0.02, p.bet.z + toward.z * 0.17);
      this.place(o.el, this.onScreen(pr, 0) ? `translate(${pr.x.toFixed(1)}px, ${pr.y.toFixed(1)}px) translate(-50%, -20%)` : null);
    }
    // The SB/BB tags: on the felt in front of their seat, just past where its bet goes (clear of its cards).
    for (const p of this.placements) {
      const o = this.overlays.get(`blind:${String(p.seatId)}`);
      if (!o) continue;
      // The same spot the dealer button takes for that seat (never both at once with 3+ players):
      // in front of their cards — or, yours, just below your own.
      const mine = p.seatId === this.viewerSeatId;
      const c = edgePoint(p.s, TABLE.railWidth + (mine ? SEAT_SPOTS.ownMarkIn : SEAT_SPOTS.buttonIn));
      const side = mine ? SEAT_SPOTS.ownMarkSide : SEAT_SPOTS.buttonSide;
      const pr = this.project(c.x + c.nz * side, 0.02, c.z - c.nx * side);
      o.el.classList.toggle('blind-tag--mine', p.seatId === this.viewerSeatId);
      this.place(o.el, this.onScreen(pr, 0) ? `translate(${pr.x.toFixed(1)}px, ${pr.y.toFixed(1)}px) translate(-50%, -50%)` : null);
    }
    // The pot's amount just above its chips — never over the board.
    const potAt = this.project(0, 0.3, HOUSE.potZ);
    const pot = this.overlays.get('pot');
    if (pot) this.place(pot.el, this.onScreen(potAt, 0) ? `translate(${potAt.x.toFixed(1)}px, ${potAt.y.toFixed(1)}px) translate(-50%, -100%)` : null);
    layout.pot = { x: potAt.x, y: potAt.y };
    const b = this.project(0, 0, HOUSE.boardZ);
    layout.board = { x: b.x, y: b.y };
    // An invisible box over the board, for the DOM layers that keep clear of it (the trophy show).
    const boardBox = this.overlays.get('board');
    if (boardBox) {
      boardBox.el.style.width = `${(boardVisible ? board.x1 - board.x0 : 0).toFixed(0)}px`;
      boardBox.el.style.height = `${(boardVisible ? board.y1 - board.y0 : 0).toFixed(0)}px`;
      boardBox.el.style.transform = `translate(${board.x0.toFixed(1)}px, ${board.y0.toFixed(1)}px)`;
    }
    if (settled) {
      this.layoutDirty = false;
      const key = [...layout.seats].map(([id, p]) => `${String(id)}:${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('|') + `|${String(this.width)}x${String(this.height)}`;
      if (key !== this.lastLayoutKey) {
        this.lastLayoutKey = key;
        this.cb.onLayout?.(layout);
      }
    }
  }

  /**
   * Seated, the players you aren't looking at still matter: each one out
   * of view gets a small marker (name, stack, bet, last action — the React
   * side fills it) at the left or right edge of the screen, whichever side
   * they're on, nearest-first from the top. Turn that way and their own box
   * takes over.
   */
  private placeEdgeMarkers(away: readonly { id: number; at: THREE.Vector3 }[]): void {
    const awayIds = new Set(away.map((a) => a.id));
    for (const [key, o] of this.overlays) {
      if (!key.startsWith('edge:')) continue;
      if (!awayIds.has(Number(key.slice(5)))) this.place(o.el, null);
    }
    if (away.length === 0) return;
    const view = this.rig.camera.matrixWorldInverse;
    const sides: Record<'left' | 'right', { id: number; angle: number; o: Overlay }[]> = { left: [], right: [] };
    for (const a of away) {
      const o = this.overlays.get(`edge:${String(a.id)}`);
      if (!o) continue;
      const v = a.at.clone().applyMatrix4(view);
      // How far round from straight ahead (camera space looks down -Z).
      const angle = Math.atan2(v.x, -v.z);
      sides[angle < 0 ? 'left' : 'right'].push({ id: a.id, angle: Math.abs(angle), o });
    }
    const phone = this.width <= 600;
    for (const side of ['left', 'right'] as const) {
      const list = sides[side].sort((a, b) => a.angle - b.angle);
      // Below the action ticker (left) and the view buttons (right).
      let y = side === 'left' ? (phone ? 190 : 150) : phone ? 340 : 180;
      for (const m of list) {
        const h = m.o.h || 40;
        if (y + h > this.height - 70) y = Math.max(8, this.height - 70 - h);
        const x = side === 'left' ? 8 : this.width - 8 - (m.o.w || 120);
        m.o.el.dataset.side = side;
        this.place(m.o.el, `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`);
        y += h + 6;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.resizeObs.disconnect();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.look.dispose();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.dealer.dispose();
    this.chips.dispose();
    this.cards.dispose();
    this.button.dispose();
    this.players.dispose();
    this.room.dispose();
    for (const m of this.chairParts) m.dispose();
    for (const d of this.disposables) d.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.renderer.renderLists.dispose();
    // No forceContextLoss(): Chrome blocks WebGL for a site that loses
    // contexts again and again (a viewer switching views). Disposing and
    // dropping the canvas frees it all the same.
    this.renderer.dispose();
    this.overlays.clear();
  }

  /**
   * Each camera screen as you see it right now: facing you or not, blocked
   * by something solid in between (the house dealer, another player), in the
   * view at all, and how wide it looks on screen, px.
   */
  private faceViews(): { seatId: number; front: boolean; blocked: boolean; inView: boolean; px: number }[] {
    const eye = this.rig.camera.position;
    this.scene.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    const dir = new THREE.Vector3();
    return this.players.faces(eye).map((f) => {
      const dist = dir.subVectors(f.at, eye).length();
      ray.set(eye, dir.normalize());
      ray.far = dist - 0.05;
      const inFace = (o: THREE.Object3D): boolean => {
        for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === f.object) return true;
        return false;
      };
      const visibleChain = (o: THREE.Object3D): boolean => {
        for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
        return true;
      };
      // Only what's drawn: not the house dealer's invisible tap zone, say.
      const drawn = (m: THREE.Mesh): boolean => [m.material].flat().some((mat) => mat.visible);
      const blocked = ray.intersectObjects(this.scene.children, true).some((h) => {
        const m = h.object as THREE.Mesh;
        return m.isMesh && drawn(m) && !inFace(m) && visibleChain(m);
      });
      const pr = this.project(f.at.x, f.at.y, f.at.z);
      // As wide as it looks from here: narrower the more it's turned away.
      const a = this.project(f.edges[0].x, f.edges[0].y, f.edges[0].z);
      const b = this.project(f.edges[1].x, f.edges[1].y, f.edges[1].z);
      return { seatId: f.seatId, front: f.front, blocked, inView: this.onScreen(pr, 0), px: Math.round(Math.hypot(a.x - b.x, a.y - b.y)) };
    });
  }

  /** For tests and the dev console: what the scene currently holds. */
  debugState(): {
    cards: string[];
    stacks: string[];
    cameraYaw: number;
    lean: number;
    boardLean: number;
    viewerSeatId: number | null;
    button: boolean;
    geometries: number;
    textures: number;
    objects: number;
    faces: { seatId: number; front: boolean; blocked: boolean; inView: boolean; px: number }[];
  } {
    let objects = 0;
    this.scene.traverse(() => objects++);
    return {
      faces: this.faceViews(),
      cards: this.cards.keys(),
      stacks: this.chips.stackKeys(),
      cameraYaw: this.rig.yaw,
      lean: this.lean,
      boardLean: this.boardLean,
      viewerSeatId: this.viewerSeatId,
      button: this.button.group.visible,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      objects,
    };
  }

  /** The last snapshot applied (dev console). */
  get snapshot(): SceneSnapshot | null {
    return this.lastSnapshot;
  }
}

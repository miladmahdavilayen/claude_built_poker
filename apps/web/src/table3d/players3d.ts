import * as THREE from 'three';
import { buildHumanBody, playerStyle, type BoneName } from './humanBody.js';
import type { SeatPlacement3d } from './seatLayout3d.js';

// The other players, sitting at the table: a body in each occupied chair
// (everyone's but your own — you're the one looking), leaning in with
// their forearms on the rail, breathing, glancing about. Their seat's box
// (camera, name, stack — the DOM layer over the scene) floats at their
// head, so a player on camera is that body with their own face. Clothes
// and looks come from their avatar colour, so each one stays recognisable.

const FLOOR_Y = -1.56;
const DEG = Math.PI / 180;

/** The seated pose, degrees XYZ per bone (see houseDealer.ts for the axes). */
const SEATED: Partial<Record<BoneName, [number, number, number]>> = {
  spine: [14, 0, 0],
  chest: [8, 0, 0],
  neck: [-6, 0, 0],
  head: [6, 0, 0],
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

  constructor(castShadows: boolean) {
    this.castShadows = castShadows;
  }

  /** One body per player at the table but the viewer. */
  sync(placements: ReadonlyMap<number, SeatPlacement3d>, players: readonly SeatedPlayer[], viewerSeatId: number | null): void {
    const wanted = new Set<number>();
    for (const p of players) {
      const place = placements.get(p.seatId);
      if (!place || p.seatId === viewerSeatId) continue;
      wanted.add(p.seatId);
      const key = `${String(p.hue)}|${String(p.seed)}`;
      let body = this.bodies.get(p.seatId);
      if (body && body.key !== key) {
        this.remove(p.seatId);
        body = undefined;
      }
      if (!body) {
        const root = new THREE.Group();
        const built = buildHumanBody(root, playerStyle(p.hue, p.seed), this.castShadows);
        body = { root, bones: built.bones, disposables: built.disposables, phase: (p.seed % 628) / 100, key };
        this.bodies.set(p.seatId, body);
        this.group.add(root);
      }
      // In the chair, pulled up to the table, facing its middle.
      const inward = 0.12;
      body.root.position.set(place.chair.x - place.chair.nx * inward, FLOOR_Y + 1.0, place.chair.z - place.chair.nz * inward);
      body.root.rotation.y = place.facing;
      const lean = p.folded ? -6 : 0;
      for (const [name, e] of Object.entries(SEATED) as [BoneName, [number, number, number]][]) {
        const b = body.bones.get(name)!;
        b.rotation.set((e[0] + (name === 'spine' ? lean : 0)) * DEG, e[1] * DEG, e[2] * DEG);
      }
    }
    for (const id of [...this.bodies.keys()]) if (!wanted.has(id)) this.remove(id);
  }

  /** Breathing, and an occasional look around — small, so it never distracts. */
  update(time: number): void {
    const t = time / 1000;
    for (const b of this.bodies.values()) {
      const chest = b.bones.get('chest')!;
      chest.rotation.x = (SEATED.chest![0] + Math.sin(t * 1.3 + b.phase) * 1.2) * DEG;
      const head = b.bones.get('head')!;
      head.rotation.y = Math.sin(t * 0.23 + b.phase * 3) * 14 * DEG * Math.max(0, Math.sin(t * 0.11 + b.phase));
    }
  }

  /** Where a player's head is (world), or null with nobody there. */
  headWorld(seatId: number, out: THREE.Vector3): THREE.Vector3 | null {
    const b = this.bodies.get(seatId);
    if (!b) return null;
    // The head bone sits at the base of the skull; its middle is a little above.
    return b.bones.get('head')!.localToWorld(out.set(0, 0.17, 0.02));
  }

  /** A player on camera: their video is their face, so the modelled head steps aside. */
  setHeadVisible(seatId: number, visible: boolean): void {
    const head = this.bodies.get(seatId)?.bones.get('head');
    if (head && head.visible !== visible) head.visible = visible;
  }

  get count(): number {
    return this.bodies.size;
  }

  private remove(seatId: number): void {
    const b = this.bodies.get(seatId);
    if (!b) return;
    this.group.remove(b.root);
    for (const d of b.disposables) d.dispose();
    this.bodies.delete(seatId);
  }

  dispose(): void {
    for (const id of [...this.bodies.keys()]) this.remove(id);
  }
}

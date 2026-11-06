import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BoneName } from './humanBody.js';
import { boneRole } from './houseDealer.js';

// A character a human player picked (public/models/players, cut to a fixed budget by
// scripts/build-player-characters.mjs), sitting where their built-in figure would. That figure's skeleton stays, unseen,
// and keeps doing everything it always did — where the arms rest, where a camera screen and a nameplate go — and this
// follows it. So a character that fails to load, or hasn't yet, simply leaves the built-in figure showing.

const DEG = Math.PI / 180;
/** A soft glow of a character's own colours, so a far player doesn't read as a silhouette in the dim room. */
const FILL = 0.28;

// One at a time: eight arriving together, each unpacked in the same moment, is the spike a phone can't take.
let queue: Promise<unknown> = Promise.resolve();
const breather = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function loadInTurn(url: string): Promise<THREE.Group> {
  const run = queue.then(async () => {
    const gltf = await new GLTFLoader().loadAsync(url);
    await breather();
    return gltf.scene;
  });
  queue = run.catch(() => undefined);
  return run;
}

type Role = 'hips' | 'spine' | 'spine1' | 'spine2' | 'neck' | 'head' | 'armR' | 'foreR' | 'handR' | 'armL' | 'foreL' | 'handL' | 'upLegR' | 'legR' | 'footR' | 'upLegL' | 'legL' | 'footL';

const ROLES: Record<string, Role> = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'spine1',
  Spine2: 'spine2',
  Neck: 'neck',
  Head: 'head',
  RightArm: 'armR',
  RightForeArm: 'foreR',
  RightHand: 'handR',
  LeftArm: 'armL',
  LeftForeArm: 'foreL',
  LeftHand: 'handL',
  RightUpLeg: 'upLegR',
  RightLeg: 'legR',
  RightFoot: 'footR',
  LeftUpLeg: 'upLegL',
  LeftLeg: 'legL',
  LeftFoot: 'footL',
};

/** Mixamo's own bone names: `mixamorig9:Spine1`, as a glTF exporter leaves them `mixamorig9Spine1`. */
function roleOf(name: string): Role | null {
  const plain = name.replace(/^mixamorig\d*:?/i, '');
  return ROLES[plain] ?? ROLES[boneRole(name) ?? ''] ?? null;
}

/**
 * Most of these files carry a copy of the skeleton per piece of clothing (Hips_1, Spine2_5…). Each copy goes on its
 * original, so one skeleton posed moves them all, at no cost per frame. Returns the originals, by name.
 */
export function mergeSkeletonCopies(model: THREE.Object3D): Map<string, THREE.Object3D> {
  const all: THREE.Object3D[] = [];
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) all.push(o);
  });
  const originals = new Map<string, THREE.Object3D>();
  for (const bone of all) {
    const base = bone.name.replace(/_\d+$/, '');
    const original = originals.get(base);
    if (!original) {
      originals.set(base, bone);
      continue;
    }
    original.add(bone);
    bone.position.set(0, 0, 0);
    bone.quaternion.identity();
    bone.scale.setScalar(1);
  }
  return originals;
}

const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** Turns `bone` so `child` lies along `dir` (world). */
function aimAt(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3): void {
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(false, false);
  const from = child.getWorldPosition(v1).sub(bone.getWorldPosition(v2));
  if (from.lengthSq() < 1e-10) return;
  const world = bone.getWorldQuaternion(q1);
  q2.setFromUnitVectors(from.normalize(), dir).multiply(world);
  bone.quaternion.copy(bone.parent!.getWorldQuaternion(q1).invert().multiply(q2));
  bone.updateMatrixWorld(true);
}

const worldDir = (from: THREE.Object3D, to: THREE.Object3D): THREE.Vector3 => to.getWorldPosition(new THREE.Vector3()).sub(from.getWorldPosition(v3)).normalize();

export class PlayerCharacter {
  readonly id: string;
  private readonly model: THREE.Group;
  private readonly bones = new Map<Role, THREE.Object3D>();
  private readonly rootInBody: THREE.Group;
  /** The head's and chest's own rotations in the seated pose: the idle movements are small turns from these. */
  private readonly restHead = new THREE.Quaternion();
  private readonly restChest = new THREE.Quaternion();
  /** The head's world turn relative to the body, in the model's T-pose: it keeps looking straight ahead however the neck lies. */
  private readonly headRelative = new THREE.Quaternion();

  private constructor(id: string, model: THREE.Group, rootInBody: THREE.Group) {
    this.id = id;
    this.model = model;
    this.rootInBody = rootInBody;
  }

  /** Loads a character into `root` (a player's body), fitted over its built-in `figure`. Rejects if the file won't do. */
  static async load(id: string, root: THREE.Group, figure: ReadonlyMap<BoneName, THREE.Bone>, castShadows: boolean): Promise<PlayerCharacter> {
    const model = await loadInTurn(`/models/players/${id}.glb`);
    const holder = new THREE.Group();
    const character = new PlayerCharacter(id, model, holder);
    try {
      for (const [base, bone] of mergeSkeletonCopies(model)) {
        const role = roleOf(base);
        if (role && !character.bones.has(role)) character.bones.set(role, bone);
      }
      model.traverse((o) => {
        const mesh = o as THREE.SkinnedMesh;
        if (mesh.isMesh) {
          mesh.castShadow = castShadows;
          mesh.frustumCulled = false;
          const m = mesh.material as THREE.MeshStandardMaterial;
          if (m.map) {
            m.emissive.set('#ffffff');
            m.emissiveMap = m.map;
            m.emissiveIntensity = FILL;
          }
        }
      });
      const need: Role[] = ['hips', 'spine', 'spine2', 'neck', 'head', 'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL'];
      if (need.some((r) => !character.bones.has(r))) throw new Error(`character ${id}: missing bones`);
      holder.add(model);
      root.add(holder);
      character.fit(root, figure);
      return character;
    } catch (err) {
      character.dispose();
      throw err;
    }
  }

  /** Same torso as the figure (hips to skull), hips on its hips — so the head is where a nameplate or camera screen expects it. */
  private fit(root: THREE.Group, figure: ReadonlyMap<BoneName, THREE.Bone>): void {
    root.updateMatrixWorld(true);
    const hips = this.bones.get('hips')!;
    const head = this.bones.get('head')!;
    const figureHips = root.worldToLocal(figure.get('hips')!.getWorldPosition(new THREE.Vector3()));
    const figureHead = root.worldToLocal(figure.get('head')!.getWorldPosition(new THREE.Vector3()));
    const a = this.rootInBody.worldToLocal(hips.getWorldPosition(new THREE.Vector3()));
    const b = this.rootInBody.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
    const scale = figureHead.distanceTo(figureHips) / a.distanceTo(b);
    this.rootInBody.scale.setScalar(scale);
    this.rootInBody.position.copy(figureHips).addScaledVector(a, -scale);
    root.updateMatrixWorld(true);
    // Its head's turn relative to the body, as designed.
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.headRelative.copy(rootQ.multiply(head.getWorldQuaternion(new THREE.Quaternion())));
  }

  /**
   * In the chair, following the built-in figure's pose: its spine, and its arms resting on its lap. The figure has no
   * legs to follow, so its own are set: thighs along the seat, shins down, feet on the floor.
   */
  pose(root: THREE.Group, figure: ReadonlyMap<BoneName, THREE.Bone>): void {
    const b = this.bones;
    const f = (n: BoneName): THREE.Bone => figure.get(n)!;
    root.updateMatrixWorld(true);
    const spineDir = worldDir(f('spine'), f('chest'));
    const chestDir = worldDir(f('chest'), f('neck'));
    const neckDir = worldDir(f('neck'), f('head'));
    const spine1 = b.get('spine1');
    aimAt(b.get('spine')!, spine1 ?? b.get('spine2')!, spineDir);
    if (spine1) aimAt(spine1, b.get('spine2')!, spineDir);
    aimAt(b.get('spine2')!, b.get('neck')!, chestDir);
    aimAt(b.get('neck')!, b.get('head')!, neckDir);
    // Straight ahead, whatever the neck did.
    const head = b.get('head')!;
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    head.quaternion.copy(head.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rootQ).multiply(this.headRelative));
    head.updateMatrixWorld(true);
    this.restHead.copy(head.quaternion);
    this.restChest.copy(b.get('spine2')!.quaternion);

    for (const [up, fore, hand, fUp, fFore, fHand] of [
      ['armR', 'foreR', 'handR', 'upperArmR', 'foreArmR', 'handR'],
      ['armL', 'foreL', 'handL', 'upperArmL', 'foreArmL', 'handL'],
    ] as const) {
      aimAt(b.get(up)!, b.get(fore)!, worldDir(f(fUp), f(fFore)));
      aimAt(b.get(fore)!, b.get(hand)!, worldDir(f(fFore), f(fHand)));
    }
    // Legs: its own +Z is forward, as the figure's is.
    for (const [up, leg, foot, side] of [
      ['upLegR', 'legR', 'footR', -1],
      ['upLegL', 'legL', 'footL', 1],
    ] as const) {
      const u = b.get(up);
      const l = b.get(leg);
      const ft = b.get(foot);
      if (!u || !l || !ft) continue;
      aimAt(u, l, new THREE.Vector3(side * 0.12, -0.06, 1).normalize().applyQuaternion(rootQ));
      aimAt(l, ft, new THREE.Vector3(side * 0.02, -1, -0.08).normalize().applyQuaternion(rootQ));
    }
    this.rootInBody.updateMatrixWorld(true);
  }

  /** Breathing and an occasional look around: small turns from the seated pose (radians). */
  idle(chestX: number, headY: number): void {
    this.bones.get('spine2')!.quaternion.copy(this.restChest).multiply(q1.setFromAxisAngle(X, chestX * DEG));
    this.bones.get('head')!.quaternion.copy(this.restHead).multiply(q1.setFromAxisAngle(Y, headY));
  }

  /** Seated, your own character has no head: the camera is where it would be. */
  setHeadless(on: boolean): void {
    const s = on ? 0.0001 : 1;
    this.bones.get('head')!.scale.setScalar(s);
  }

  dispose(): void {
    this.rootInBody.removeFromParent();
    this.model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) mesh.skeleton.dispose();
      if (!(mesh as THREE.Mesh).isMesh) return;
      mesh.geometry.dispose();
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (m.map) {
        const bitmap = m.map.source.data as { close?: () => void } | null;
        m.map.dispose();
        bitmap?.close?.();
      }
      m.dispose();
    });
  }
}

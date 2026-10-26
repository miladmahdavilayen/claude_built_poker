import * as THREE from 'three';
import { TIMINGS } from '../animationTimings.js';

// Each viewer's own camera. Two kinds of view feed it (see scene.ts):
//  - SEATED: the viewer's own eyes, at a seated player's eye height in
//    their chair, looking where they turn their head (drag to look);
//  - STANDING / spectator: an orbit around the table — from the viewer's
//    seat, higher up, its distance solved so the whole table fits.
// Only the camera moves between viewers: the scene is never mirrored and
// seat numbers never change.
//
// Moving between views (sitting down, changing seats, switching the view)
// eases the camera's position around the table's center — angle, radius
// and height separately, so it swings round the rail instead of cutting
// across the felt — and its aim point and field of view along with it.

export interface CameraView {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  /** Vertical field of view, degrees. */
  fov: number;
}

export interface CameraPose {
  /** Around the table: 0 looks from the house dealer's side (+Z), increasing counter-clockwise from above. */
  yaw: number;
  elev: number;
  dist: number;
  tx: number;
  tz: number;
}

export interface FitPoint {
  p: THREE.Vector3;
  /** How far inside the screen's edge it must stay, as a fraction of half the width/height. */
  mx: number;
  my: number;
  /** A larger margin at the bottom only (a band kept free for something on top of the view). */
  myBottom?: number;
}

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** An orbit pose as a view. */
export function orbitView(p: CameraPose, fov: number): CameraView {
  const h = Math.cos(p.elev) * p.dist;
  return {
    pos: new THREE.Vector3(p.tx + Math.sin(p.yaw) * h, Math.sin(p.elev) * p.dist, p.tz + Math.cos(p.yaw) * h),
    target: new THREE.Vector3(p.tx, 0, p.tz),
    fov,
  };
}

/** The standing/orbit field of view for a screen shape: a tall phone screen gets a little more, so the table needn't shrink as much. */
export function orbitFov(aspect: number): number {
  return aspect < 0.8 ? 50 : aspect < 1.2 ? 45 : 40;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private current: CameraView = orbitView({ yaw: Math.PI, elev: 0.95, dist: 10, tx: 0, tz: 0 }, 40);
  private goal: CameraView = this.current;
  private from: CameraView | null = null;
  private start = 0;
  private readonly tmp = new THREE.Vector3();

  constructor() {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 80);
    this.apply(this.current);
  }

  /** The viewer's direction around the table, from its center (0 = from the house dealer's side) — face-up cards turn to it. */
  get yaw(): number {
    return Math.atan2(this.current.pos.x, this.current.pos.z);
  }

  get moving(): boolean {
    return this.from !== null;
  }

  get position(): THREE.Vector3 {
    return this.camera.position;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * The smallest orbit distance at this pose's yaw/elevation/aim that keeps
   * every fit point on screen; never closer than `minDist`.
   */
  solveDistance(base: Omit<CameraPose, 'dist'>, fov: number, points: readonly FitPoint[], minDist: number): number {
    let lo = minDist;
    let hi = 40;
    if (this.fits({ ...base, dist: lo }, fov, points)) return lo;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (this.fits({ ...base, dist: mid }, fov, points)) hi = mid;
      else lo = mid;
    }
    this.apply(this.current);
    return hi;
  }

  private fits(pose: CameraPose, fov: number, points: readonly FitPoint[]): boolean {
    this.apply(orbitView(pose, fov));
    this.camera.updateMatrixWorld(true);
    let ok = true;
    for (const f of points) {
      this.tmp.copy(f.p).project(this.camera);
      const my = this.tmp.y < 0 ? (f.myBottom ?? f.my) : f.my;
      if (this.tmp.z > 1 || Math.abs(this.tmp.x) > 1 - f.mx || Math.abs(this.tmp.y) > 1 - my) {
        ok = false;
        break;
      }
    }
    this.apply(this.current);
    return ok;
  }

  /** Heads for a new view — over TIMINGS.cameraMoveMs, or at once. */
  goTo(view: CameraView, animate: boolean): void {
    this.from = animate ? this.snapshot() : null;
    this.start = performance.now();
    this.goal = view;
    if (!animate) {
      this.current = view;
      this.apply(view);
    }
  }

  /** Updates where the camera is heading without restarting the move — the seated viewer turning their head. */
  follow(view: CameraView): void {
    this.goal = view;
  }

  private snapshot(): CameraView {
    return { pos: this.current.pos.clone(), target: this.current.target.clone(), fov: this.current.fov };
  }

  /** Advances the move; true while it's still moving between views. */
  update(now: number): boolean {
    if (this.from) {
      const t = Math.min(1, (now - this.start) / TIMINGS.cameraMoveMs);
      const e = ease(t);
      const a = this.from;
      const b = this.goal;
      // Around the table's center: angle, radius and height eased on their own.
      const aAng = Math.atan2(a.pos.x, a.pos.z);
      const bAng = Math.atan2(b.pos.x, b.pos.z);
      const dAng = Math.atan2(Math.sin(bAng - aAng), Math.cos(bAng - aAng));
      const ang = aAng + dAng * e;
      const r = Math.hypot(a.pos.x, a.pos.z) + (Math.hypot(b.pos.x, b.pos.z) - Math.hypot(a.pos.x, a.pos.z)) * e;
      this.current = {
        pos: new THREE.Vector3(Math.sin(ang) * r, a.pos.y + (b.pos.y - a.pos.y) * e, Math.cos(ang) * r),
        target: a.target.clone().lerp(b.target, e),
        fov: a.fov + (b.fov - a.fov) * e,
      };
      if (t >= 1) {
        this.from = null;
        this.current = this.goal;
      }
    } else {
      this.current = this.goal;
    }
    this.apply(this.current);
    return this.from !== null;
  }

  private apply(v: CameraView): void {
    this.camera.position.copy(v.pos);
    this.camera.lookAt(v.target);
    if (this.camera.fov !== v.fov) {
      this.camera.fov = v.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

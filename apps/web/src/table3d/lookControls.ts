// Turning your head at the table (the 3D seated view): press and drag to
// look around — you drag the scene itself, the way a phone's 360° photos
// work: drag left and the view turns right, drag down and it looks up —
// with the motion smoothed and carried on a little after letting go, like
// a head turning rather than a camera snapping. Pinch (or the mouse wheel)
// narrows or widens your field of view, as leaning in or sitting back
// would. A double tap or double click looks back at the table. A press
// that doesn't move is still a tap, for whatever's under it (an empty
// chair).
//
// Pinching (or scrolling) out past the widest view stands you up for the
// whole table (the 3D standing view); pinching back in from there sits you
// down again — `onZoomBeyond`.
//
// It only produces angles; scene.ts turns them into where the eyes look.

/** How far the head turns either way (radians): past your shoulder, not behind you. */
const MAX_YAW = (115 * Math.PI) / 180;
/** Down to your lap, up over the far players' heads. */
const MIN_PITCH = (-62 * Math.PI) / 180;
const MAX_PITCH = (24 * Math.PI) / 180;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.35;
/** A press that moves less than this (px) is a tap, not a drag. */
const TAP_SLOP = 7;
/** A fingertip wobbles more than a mouse: how far a touch may move and still be a tap. */
const TOUCH_TAP_SLOP = 14;
/** How quickly the view catches up with the finger (per second). Higher is snappier. */
const FOLLOW = 16;
/** How quickly a flick's carry-on dies away (per second). */
const FRICTION = 5.5;

export interface LookState {
  yaw: number;
  pitch: number;
  zoom: number;
}

/** How far past a zoom limit the gesture has to carry on before it changes the view. */
const BEYOND = 0.35;

export class LookControls {
  enabled = false;
  /** Standing at your seat: only the pinch/scroll back in (to sit down) does anything. */
  zoomOnly = false;
  private overshoot = 0;
  /** Where the view is now (smoothed) and where it's heading. */
  readonly current: LookState = { yaw: 0, pitch: 0, zoom: 1 };
  private readonly goal: LookState = { yaw: 0, pitch: 0, zoom: 1 };
  private velocity = { yaw: 0, pitch: 0 };
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: { id: number; startX: number; startY: number; lastX: number; lastY: number; lastT: number; moved: boolean } | null = null;
  private pinchDist = 0;
  private lastTap = 0;
  private lastTapAt = { x: 0, y: 0 };
  private readonly el: HTMLElement;
  private readonly radiansPerPx: () => number;
  private readonly onTap: (ev: PointerEvent) => void;
  /** The base pitch the angles are added to, so the limits are absolute. */
  basePitch = 0;

  private readonly onZoomBeyond: (dir: 'in' | 'out') => void;
  private readonly onDoubleTap: (ev: PointerEvent) => boolean;

  constructor(
    el: HTMLElement,
    opts: {
      radiansPerPx: () => number;
      onTap: (ev: PointerEvent) => void;
      onZoomBeyond: (dir: 'in' | 'out') => void;
      /** A double tap on something that wants it (the house dealer); true if it took it — otherwise it looks back at the table. */
      onDoubleTap: (ev: PointerEvent) => boolean;
    },
  ) {
    this.el = el;
    this.radiansPerPx = opts.radiansPerPx;
    this.onTap = opts.onTap;
    this.onZoomBeyond = opts.onZoomBeyond;
    this.onDoubleTap = opts.onDoubleTap;
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('wheel', this.wheel, { passive: false });
    // A finger held still is still a look-around: no press-and-hold menu, no text selection.
    el.addEventListener('contextmenu', this.noDefault);
    el.addEventListener('selectstart', this.noDefault);
  }

  private readonly noDefault = (ev: Event): void => {
    ev.preventDefault();
  };

  /** Looking somewhere other than straight at the table. */
  get offCenter(): boolean {
    return Math.abs(this.goal.yaw) > 0.04 || Math.abs(this.goal.pitch) > 0.04 || Math.abs(this.goal.zoom - 1) > 0.03;
  }

  get dragging(): boolean {
    return this.drag?.moved ?? false;
  }

  /** Eyes back on the table. */
  recenter(): void {
    this.goal.yaw = 0;
    this.goal.pitch = 0;
    this.goal.zoom = 1;
    this.velocity = { yaw: 0, pitch: 0 };
  }

  /** Straight to the goal, no easing (reduced motion, or a new seat). */
  snap(): void {
    Object.assign(this.current, this.goal);
  }

  private clampGoal(): void {
    this.goal.yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, this.goal.yaw));
    this.goal.pitch = Math.max(MIN_PITCH - this.basePitch, Math.min(MAX_PITCH - this.basePitch, this.goal.pitch));
    this.goal.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.goal.zoom));
  }

  /** Advances the smoothing and any flick; true while the view is still moving. */
  update(dt: number, instant: boolean): boolean {
    if (!this.drag && (this.velocity.yaw !== 0 || this.velocity.pitch !== 0)) {
      this.goal.yaw += this.velocity.yaw * dt;
      this.goal.pitch += this.velocity.pitch * dt;
      this.clampGoal();
      const decay = Math.exp(-FRICTION * dt);
      this.velocity.yaw *= decay;
      this.velocity.pitch *= decay;
      if (Math.abs(this.velocity.yaw) < 0.01 && Math.abs(this.velocity.pitch) < 0.01) this.velocity = { yaw: 0, pitch: 0 };
    }
    const k = instant ? 1 : 1 - Math.exp(-FOLLOW * dt);
    let moving = false;
    for (const key of ['yaw', 'pitch', 'zoom'] as const) {
      const d = this.goal[key] - this.current[key];
      if (Math.abs(d) < 1e-4) {
        this.current[key] = this.goal[key];
      } else {
        this.current[key] += d * k;
        moving = true;
      }
    }
    return moving || this.velocity.yaw !== 0 || this.velocity.pitch !== 0 || this.drag !== null;
  }

  private readonly down = (ev: PointerEvent): void => {
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 2) {
      // A second finger: a pinch, not a drag.
      this.drag = null;
      this.pinchDist = this.spread();
      return;
    }
    if (this.pointers.size > 2) return;
    this.el.setPointerCapture?.(ev.pointerId);
    this.drag = { id: ev.pointerId, startX: ev.clientX, startY: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, lastT: performance.now(), moved: false };
    this.velocity = { yaw: 0, pitch: 0 };
  };

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private readonly move = (ev: PointerEvent): void => {
    if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 2 && (this.enabled || this.zoomOnly)) {
      const d = this.spread();
      // Fingers apart: a narrower, closer view; together: a wider one.
      if (this.pinchDist > 0 && d > 0) this.zoomBy(this.pinchDist / d);
      this.pinchDist = d;
      return;
    }
    const drag = this.drag;
    if (!drag || drag.id !== ev.pointerId) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < (ev.pointerType === 'touch' ? TOUCH_TAP_SLOP : TAP_SLOP)) return;
    if (!this.enabled) return;
    if (!drag.moved) {
      drag.moved = true;
      this.el.style.cursor = 'grabbing';
    }
    const now = performance.now();
    const dx = ev.clientX - drag.lastX;
    const dy = ev.clientY - drag.lastY;
    const k = this.radiansPerPx() * this.current.zoom;
    // Dragging the scene: left turns the head right (a decreasing heading), down looks up.
    const dYaw = dx * k;
    const dPitch = dy * k;
    this.goal.yaw += dYaw;
    this.goal.pitch += dPitch;
    this.clampGoal();
    const dt = Math.max(1, now - drag.lastT) / 1000;
    // A running average of the finger's speed, for the carry-on after letting go.
    this.velocity.yaw = this.velocity.yaw * 0.6 + (dYaw / dt) * 0.4;
    this.velocity.pitch = this.velocity.pitch * 0.6 + (dPitch / dt) * 0.4;
    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
    drag.lastT = now;
  };

  private readonly up = (ev: PointerEvent): void => {
    this.pointers.delete(ev.pointerId);
    const drag = this.drag;
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (!drag || drag.id !== ev.pointerId) return;
    this.drag = null;
    this.el.style.cursor = '';
    if (drag.moved) {
      // Finger held still before lifting: no flick.
      if (performance.now() - drag.lastT > 80) this.velocity = { yaw: 0, pitch: 0 };
      return;
    }
    this.velocity = { yaw: 0, pitch: 0 };
    const now = performance.now();
    // Two taps within a moment and near each other — how real thumbs double-tap.
    if (now - this.lastTap < 450 && Math.hypot(ev.clientX - this.lastTapAt.x, ev.clientY - this.lastTapAt.y) < 60) {
      this.lastTap = 0;
      if (!this.onDoubleTap(ev) && this.enabled) this.recenter();
      return;
    }
    this.lastTap = now;
    this.lastTapAt = { x: ev.clientX, y: ev.clientY };
    this.onTap(ev);
  };

  private readonly cancel = (ev: PointerEvent): void => {
    this.pointers.delete(ev.pointerId);
    if (this.drag?.id === ev.pointerId) this.drag = null;
    this.el.style.cursor = '';
  };

  private readonly wheel = (ev: WheelEvent): void => {
    if (!this.enabled && !this.zoomOnly) return;
    ev.preventDefault();
    this.zoomBy(Math.exp(ev.deltaY * 0.0012));
  };

  /** Multiplies the field of view (>1 wider); carrying on past either end changes the view. */
  private zoomBy(f: number): void {
    if (this.zoomOnly) {
      // Standing: only a gesture in (narrower) counts, toward sitting back down.
      this.overshoot = f < 1 ? this.overshoot - Math.log(f) : 0;
      if (this.overshoot > BEYOND) {
        this.overshoot = 0;
        this.onZoomBeyond('in');
      }
      return;
    }
    const before = this.goal.zoom;
    this.goal.zoom *= f;
    this.clampGoal();
    if (f > 1 && before >= MAX_ZOOM - 1e-3) {
      this.overshoot += Math.log(f);
      if (this.overshoot > BEYOND) {
        this.overshoot = 0;
        this.onZoomBeyond('out');
      }
    } else {
      this.overshoot = 0;
    }
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.cancel);
    this.el.removeEventListener('wheel', this.wheel);
    this.el.removeEventListener('contextmenu', this.noDefault);
    this.el.removeEventListener('selectstart', this.noDefault);
  }
}

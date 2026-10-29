import * as THREE from 'three';
import { TIMINGS } from '../animationTimings.js';
import { edgePoint, SEAT_SPOTS, TABLE, type SeatPlacement3d } from './seatLayout3d.js';
import { buttonTexture } from './textures.js';

// The DEALER BUTTON — the "D" puck that marks the button seat. The game
// state is its only source of truth: this never works out where the button
// goes, it only shows `state.buttonSeat` (see TableScene3D). It sits on the
// felt in front of the button seat's player, and at the start of a hand
// slides along the felt — clockwise, the way the button moves — from the
// last seat to the new one. Its "D" always turns to read upright for
// whoever is looking.

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export class DealerButton3d {
  readonly group = new THREE.Group();
  private readonly top: THREE.Mesh;
  private readonly side: THREE.Mesh;
  private readonly disposables: { dispose: () => void }[] = [];
  private s: number | null = null;
  /** Where the viewer sits (edge fraction), or null: their own button isn't drawn for them (see update). */
  private viewerS: number | null = null;
  private readonly glow: THREE.Mesh;
  private slide: { from: number; to: number; start: number; dur: number } | null = null;
  reduceMotion = false;

  constructor(castShadows: boolean) {
    const radius = 0.15;
    const height = 0.04;
    const sideGeo = new THREE.CylinderGeometry(radius, radius * 1.02, height, 32);
    const faceGeo = new THREE.CircleGeometry(radius * 0.985, 32);
    faceGeo.rotateX(-Math.PI / 2);
    const tex = buttonTexture();
    const sideMat = new THREE.MeshStandardMaterial({ color: '#efe8d6', roughness: 0.35, metalness: 0.1 });
    const topMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3 });
    this.disposables.push(sideGeo, faceGeo, tex, sideMat, topMat);
    const side = new THREE.Mesh(sideGeo, sideMat);
    side.position.y = height / 2;
    side.castShadow = castShadows;
    this.side = side;
    this.top = new THREE.Mesh(faceGeo, topMat);
    this.top.position.y = height + 0.0008;
    // A soft gold ring under the puck — only for your own button, so you can't miss it.
    const glowGeo = new THREE.RingGeometry(radius * 1.05, radius * 1.6, 40);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMat = new THREE.MeshBasicMaterial({ color: '#ffc94d', transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
    this.disposables.push(glowGeo, glowMat);
    this.glow = new THREE.Mesh(glowGeo, glowMat);
    this.glow.position.y = 0.003;
    this.group.add(side, this.top, this.glow);
    this.group.visible = false;
  }

  /** Puts the puck at `seat` (null hides it). `animate` slides it there clockwise from where it was. */
  placeAt(seat: SeatPlacement3d | null, animate: boolean): void {
    if (!seat) {
      this.group.visible = false;
      this.s = null;
      this.slide = null;
      return;
    }
    const to = seat.s;
    if (this.s !== null && animate && !this.reduceMotion && Math.abs(this.s - to) > 1e-6) {
      const from = this.slide ? this.current(performance.now()) : this.s;
      // Always onward (clockwise): wrapping past seat 9 back to seat 1 crosses the dealer's edge.
      const target = to <= from ? to + 1 : to;
      this.slide = { from, to: target, start: performance.now(), dur: TIMINGS.buttonSlideMs };
    } else {
      this.slide = null;
    }
    this.s = to;
    this.group.visible = true;
  }

  setViewerSeat(seat: SeatPlacement3d | null): void {
    this.viewerS = seat ? seat.s : null;
  }

  get animating(): boolean {
    return this.slide !== null;
  }

  private current(now: number): number {
    if (!this.slide) return this.s ?? 0;
    const t = Math.min(1, (now - this.slide.start) / this.slide.dur);
    return this.slide.from + (this.slide.to - this.slide.from) * easeInOut(t);
  }

  update(now: number, viewYaw: number): void {
    if (this.s === null) return;
    const s = this.current(now);
    if (this.slide && now >= this.slide.start + this.slide.dur) this.slide = null;
    // Anyone's: beside their bet, to their right (see seatLayout3d's button spot). Yours: right by your
    // cards, half again as big, ringed in gold — easing between the two as it slides in or out.
    const mine = this.viewerS === null ? 0 : Math.max(0, 1 - Math.abs(s - this.viewerS) / 0.06);
    const depth = SEAT_SPOTS.buttonIn + (SEAT_SPOTS.ownMarkIn - SEAT_SPOTS.buttonIn) * mine;
    const sideways = SEAT_SPOTS.buttonSide + (SEAT_SPOTS.ownMarkSide - SEAT_SPOTS.buttonSide) * mine;
    const p = edgePoint(s, TABLE.railWidth + depth);
    this.group.position.set(p.x + p.nz * sideways, 0, p.z - p.nx * sideways);
    this.group.scale.setScalar(1 + 0.35 * mine);
    // At your own seat, the puck is for everyone else: you have the D on your own box, so for you it steps
    // out of sight once it's there (and slides in and out of it as anyone else's would). (The group stays
    // "visible" — the button is still on the table, just not drawn for its own holder.)
    const yours = mine > 0.5;
    this.side.visible = !yours;
    this.top.visible = !yours;
    this.glow.visible = false;
    this.top.rotation.y = viewYaw;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

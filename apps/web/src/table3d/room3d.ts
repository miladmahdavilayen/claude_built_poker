import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The poker room around our table: other tables under their own lamps,
// with people sitting at them; a backlit bar with shelves of bottles, a
// bartender, a few patrons with drinks; people strolling between. All of
// it real 3D (it moves with true parallax when you turn your head), but
// built to be cheap: flat-shaded low-poly shapes, emissive glows instead
// of lights, static parts merged into a handful of meshes, and the scene's
// haze (fog) softening it into an out-of-focus background — the way a room
// looks past the far players while you watch the cards.

const FLOOR_Y = -1.56;

interface Mover {
  obj: THREE.Object3D;
  update: (t: number) => void;
}

/** A simple person: body, shoulders, head — a silhouette in the haze. */
function person(mat: THREE.Material, seated: boolean, scale = 1): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, seated ? 0.55 : 1.15, 3, 8), mat);
  body.position.y = seated ? -0.55 : FLOOR_Y + 1.1;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), mat);
  head.position.y = body.position.y + (seated ? 0.62 : 0.95);
  g.add(body, head);
  g.scale.setScalar(scale);
  return g;
}

export class CasinoRoom {
  readonly group = new THREE.Group();
  private readonly movers: Mover[] = [];
  private readonly disposables: { dispose: () => void }[] = [];

  constructor(rich: boolean) {
    const track = <T extends { dispose: () => void }>(x: T): T => {
      this.disposables.push(x);
      return x;
    };
    const felt = track(new THREE.MeshLambertMaterial({ color: '#0f5a36' }));
    const wood = track(new THREE.MeshLambertMaterial({ color: '#3a1f12' }));
    const darkWood = track(new THREE.MeshLambertMaterial({ color: '#1e110a' }));
    const glow = track(new THREE.MeshBasicMaterial({ color: '#ffd9a0' }));
    const people = [
      track(new THREE.MeshLambertMaterial({ color: '#2a2230' })),
      track(new THREE.MeshLambertMaterial({ color: '#3b2a24' })),
      track(new THREE.MeshLambertMaterial({ color: '#1f2a33' })),
      track(new THREE.MeshLambertMaterial({ color: '#4a3a2c' })),
    ];

    // --- Other tables, each under its lamp, a few players at each. ---
    const tableSpots: [number, number, number][] = [
      [-11, -6, 0.3],
      [11, -5, -0.4],
      [-12, 6, 0.2],
      [10.5, 7.5, -0.2],
      [0, -13, 0],
    ];
    const staticGeos = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (mat: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4): void => {
      const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m);
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      const list = staticGeos.get(mat) ?? [];
      list.push(g);
      staticGeos.set(mat, list);
    };
    const T = (x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));
    const topGeo = new THREE.CylinderGeometry(1, 1, 0.12, 24);
    const railGeo = new THREE.TorusGeometry(1, 0.12, 6, 24);
    railGeo.rotateX(Math.PI / 2);
    const baseGeo = new THREE.CylinderGeometry(0.35, 0.5, 1.5, 10);
    const shadeGeo = new THREE.CylinderGeometry(0.6, 1.4, 0.5, 16, 1, true);
    const bulbGeo = new THREE.CircleGeometry(1.35, 16);
    bulbGeo.rotateX(Math.PI / 2);
    for (const [i, [x, z, ry]] of tableSpots.entries()) {
      add(felt, topGeo, T(x, 0, z, ry, 2.6, 1, 1.5));
      add(darkWood, railGeo, T(x, 0.06, z, ry, 2.6, 1, 1.5));
      add(wood, baseGeo, T(x, -0.8, z, ry));
      add(darkWood, shadeGeo, T(x, 4.2, z, ry));
      add(glow, bulbGeo, T(x, 3.96, z, ry));
      // Players round it, some leaning in, gently moving.
      if (rich || i < 3) {
        const n = 4 + (i % 3);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + ry;
          const p = person(people[(i + k) % people.length]!, true, 1);
          p.position.set(x + Math.cos(a) * 3.0, 0, z + Math.sin(a) * 1.9);
          p.rotation.y = Math.atan2(x - p.position.x, z - p.position.z);
          this.group.add(p);
          const phase = i * 1.7 + k;
          const baseY = p.position.y;
          this.movers.push({ obj: p, update: (t) => (p.position.y = baseY + Math.sin(t * 0.8 + phase) * 0.03) });
        }
      }
    }

    // --- The bar, behind the house dealer: counter, back bar and bottles, stools. ---
    const barZ = 12.5;
    add(wood, new THREE.BoxGeometry(9, 1.9, 1), T(0, FLOOR_Y + 0.95, barZ - 1.8));
    add(darkWood, new THREE.BoxGeometry(9.4, 0.12, 1.3), T(0, FLOOR_Y + 1.95, barZ - 1.8));
    add(darkWood, new THREE.BoxGeometry(10, 5, 0.4), T(0, FLOOR_Y + 2.5, barZ + 0.6));
    for (let k = 0; k < 6; k++) {
      add(darkWood, new THREE.CylinderGeometry(0.28, 0.28, 0.1, 10), T(-3.5 + k * 1.4, FLOOR_Y + 1.2, barZ - 3));
      add(wood, new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6), T(-3.5 + k * 1.4, FLOOR_Y + 0.6, barZ - 3));
    }
    this.group.add(this.bottleShelf(barZ, track));

    for (const [mat, list] of staticGeos) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      track(merged);
      this.group.add(new THREE.Mesh(merged, mat));
    }
    for (const g of [topGeo, railGeo, baseGeo, shadeGeo, bulbGeo]) g.dispose();

    // The bartender, working along the bar.
    const bartender = person(people[2]!, false, 1);
    bartender.position.set(0, 0, barZ - 0.6);
    bartender.rotation.y = Math.PI;
    this.group.add(bartender);
    this.movers.push({ obj: bartender, update: (t) => (bartender.position.x = Math.sin(t * 0.18) * 3.2) });
    // Patrons at the bar with their drinks.
    for (const [k, x] of [-2.8, -0.6, 2.4].entries()) {
      const p = person(people[k % people.length]!, false, 1);
      p.position.set(x, 0, barZ - 3.1);
      this.group.add(p);
      const drink = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.06, 0.22, 8)), glow);
      drink.position.set(x + 0.25, FLOOR_Y + 2.1, barZ - 2.9);
      this.group.add(drink);
      this.movers.push({ obj: p, update: (t) => (p.rotation.y = Math.PI + Math.sin(t * 0.3 + k * 2) * 0.5) });
      // Now and then, a sip: the glass rises and settles.
      this.movers.push({ obj: drink, update: (t) => (drink.position.y = FLOOR_Y + 2.1 + Math.max(0, Math.sin(t * 0.25 + k * 1.9)) ** 8 * 0.9) });
    }
    // People strolling round the room, slowly.
    if (rich) {
      for (let k = 0; k < 4; k++) {
        const p = person(people[(k + 1) % people.length]!, false, 1);
        this.group.add(p);
        const r = 8.4 + (k % 2) * 1.6;
        const speed = (0.035 + k * 0.008) * (k % 2 ? 1 : -1);
        const start = k * 1.6;
        this.movers.push({
          obj: p,
          update: (t) => {
            const a = start + t * speed;
            p.position.set(Math.cos(a) * r, Math.abs(Math.sin(t * 3 + k)) * 0.03, Math.sin(a) * r * 0.9);
            p.rotation.y = -a + (speed > 0 ? 0 : Math.PI);
          },
        });
      }
    }
  }

  /** The back bar: rows of bottles glowing in their backlight, painted once on a canvas. */
  private bottleShelf(barZ: number, track: <T extends { dispose: () => void }>(x: T) => T): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    const bg = ctx.createLinearGradient(0, 0, 0, 256);
    bg.addColorStop(0, '#3b2414');
    bg.addColorStop(1, '#6b3d1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 256);
    const colors = ['#c8752b', '#e2b04a', '#7aa34a', '#b33a2b', '#d8d0b0', '#5a7fb0', '#8a4a20'];
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let row = 0; row < 3; row++) {
      const y = 70 + row * 78;
      ctx.fillStyle = '#2a170c';
      ctx.fillRect(0, y, 512, 8);
      for (let x = 8; x < 500; x += 16 + rand() * 10) {
        const h = 36 + rand() * 26;
        ctx.fillStyle = colors[Math.floor(rand() * colors.length)]!;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, y - h, 10, h);
        ctx.fillRect(x + 3, y - h - 12, 4, 12);
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#fff3d0';
        ctx.fillRect(x + 2, y - h + 4, 2, h - 8);
        ctx.globalAlpha = 1;
      }
    }
    const tex = track(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(9, 4.5)), track(new THREE.MeshBasicMaterial({ map: tex })));
    mesh.position.set(0, FLOOR_Y + 3.1, barZ + 0.38);
    mesh.rotation.y = Math.PI;
    return mesh;
  }

  update(time: number): void {
    const t = time / 1000;
    for (const m of this.movers) m.update(t);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
  }
}

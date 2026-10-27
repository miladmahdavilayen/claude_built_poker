import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { slotScreensTexture } from './textures.js';

// The poker room around our table: other tables under their own lamps,
// with people sitting at them; a backlit bar with shelves of bottles, a
// bartender, a few patrons with drinks; people strolling between. All of
// it real 3D (it moves with true parallax when you turn your head), but
// built to be cheap: flat-shaded low-poly shapes, emissive glows instead
// of lights, static parts merged into a handful of meshes, and the scene's
// haze (fog) softening it into an out-of-focus background — the way a room
// looks past the far players while you watch the cards.
//
// The VIP room (a VIP house dealer's table) is a high-limit casino floor
// instead: the same tables and bar, plus banks of glowing slot machines,
// marble columns with gold capitals, crystal chandeliers, a roulette wheel
// and a velvet rope round our table.

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

  constructor(rich: boolean, vip = false) {
    const track = <T extends { dispose: () => void }>(x: T): T => {
      this.disposables.push(x);
      return x;
    };
    const felt = track(new THREE.MeshLambertMaterial({ color: vip ? '#5a0f1c' : '#0f5a36' }));
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
      // A lamp over each — on the VIP floor, a chandelier instead (see buildVip).
      if (!vip) {
        add(darkWood, shadeGeo, T(x, 4.2, z, ry));
        add(glow, bulbGeo, T(x, 3.96, z, ry));
      }
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
    if (vip) this.buildVip(add, T, track);

    for (const [mat, list] of staticGeos) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      track(merged);
      this.group.add(new THREE.Mesh(merged, mat));
    }
    for (const g of [topGeo, railGeo, baseGeo, shadeGeo, bulbGeo]) g.dispose();
    for (const f of this.afterMerge) f();

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

  /**
   * The high-limit floor's extras. Static parts go into the merged meshes
   * (`add`); the crystals are one instanced mesh; the slot screens' lights
   * blink a little.
   */
  private buildVip(
    add: (mat: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4) => void,
    T: (x: number, y: number, z: number, ry?: number, sx?: number, sy?: number, sz?: number) => THREE.Matrix4,
    track: <T extends { dispose: () => void }>(x: T) => T,
  ): void {
    const gold = track(new THREE.MeshStandardMaterial({ color: '#c9973a', metalness: 0.85, roughness: 0.32, emissive: '#3a2406' }));
    const marble = track(new THREE.MeshLambertMaterial({ color: '#d9d0c4' }));
    const cabinet = track(new THREE.MeshLambertMaterial({ color: '#1a1016' }));
    const velvet = track(new THREE.MeshLambertMaterial({ color: '#7a0f1e' }));
    const screens = track(slotScreensTexture());
    const screenMat = track(new THREE.MeshBasicMaterial({ map: screens }));
    const topLight = track(new THREE.MeshBasicMaterial({ color: '#ffd98a' }));
    const geos: THREE.BufferGeometry[] = [];
    const g = <G extends THREE.BufferGeometry>(x: G): G => {
      geos.push(x);
      return x;
    };

    // Slot machine banks round the floor, each machine's screen one of four.
    const quads = [0, 1, 2, 3].map((k) => {
      const q = g(new THREE.PlaneGeometry(0.62, 0.62));
      const uv = q.getAttribute('uv') as THREE.BufferAttribute;
      const u0 = (k % 2) * 0.5;
      const v0 = 0.5 - Math.floor(k / 2) * 0.5;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5);
      return q;
    });
    const cab = g(new THREE.BoxGeometry(0.82, 2.3, 0.75));
    const lamp = g(new THREE.CylinderGeometry(0.12, 0.12, 0.22, 10));
    const stool = g(new THREE.CylinderGeometry(0.24, 0.24, 0.1, 12));
    const stoolLeg = g(new THREE.CylinderGeometry(0.04, 0.04, 0.75, 6));
    const banks: [number, number][] = [
      [-6.5, -11],
      [6.5, -11.5],
      [-14.2, 0.5],
      [14.2, 1.5],
      [-7.5, 11.5],
      [7.5, 11.5],
    ];
    let k = 0;
    for (const [bx, bz] of banks) {
      // Facing the middle of the room.
      const face = Math.atan2(-bx, -bz);
      const ax = Math.cos(face);
      const az = -Math.sin(face);
      for (let m = -2; m <= 2; m++) {
        const x = bx + ax * m * 0.86;
        const z = bz + az * m * 0.86;
        const fx = Math.sin(face);
        const fz = Math.cos(face);
        add(cabinet, cab, T(x, FLOOR_Y + 1.15, z, face));
        add(screenMat, quads[k++ % 4]!, T(x + fx * 0.38, FLOOR_Y + 1.55, z + fz * 0.38, face));
        add(topLight, lamp, T(x, FLOOR_Y + 2.41, z, face));
        add(cabinet, stool, T(x + fx * 0.9, FLOOR_Y + 0.8, z + fz * 0.9));
        add(gold, stoolLeg, T(x + fx * 0.9, FLOOR_Y + 0.38, z + fz * 0.9));
      }
    }

    // Marble columns with gold capitals and bases.
    const shaft = g(new THREE.CylinderGeometry(0.42, 0.42, 7, 16));
    const cap = g(new THREE.CylinderGeometry(0.62, 0.45, 0.4, 16));
    const foot = g(new THREE.CylinderGeometry(0.55, 0.62, 0.35, 16));
    for (const [x, z] of [
      [-8.2, -7.8],
      [8.2, -7.8],
      [-9.4, 3.2],
      [9.4, 3.2],
      [-4.8, 9.6],
      [4.8, 9.6],
    ] as const) {
      add(marble, shaft, T(x, FLOOR_Y + 3.5, z));
      add(gold, cap, T(x, FLOOR_Y + 6.8, z));
      add(gold, foot, T(x, FLOOR_Y + 0.18, z));
    }

    // The velvet rope round our table: gold posts, red rope sagging between them.
    const post = g(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 8));
    const knob = g(new THREE.SphereGeometry(0.09, 10, 8));
    const postBase = g(new THREE.CylinderGeometry(0.2, 0.22, 0.05, 14));
    const rx = 6.4;
    const rz = 5.2;
    const posts = 18;
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * Math.PI * 2;
      const b = ((i + 1) / posts) * Math.PI * 2;
      const [x0, z0] = [Math.cos(a) * rx, Math.sin(a) * rz];
      const [x1, z1] = [Math.cos(b) * rx, Math.sin(b) * rz];
      add(gold, post, T(x0, FLOOR_Y + 0.5, z0));
      add(gold, knob, T(x0, FLOOR_Y + 1.03, z0));
      add(gold, postBase, T(x0, FLOOR_Y + 0.03, z0));
      // Leave the opening behind the house dealer, where the staff come and go.
      if (i === Math.round(posts / 4)) continue;
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(x0, FLOOR_Y + 0.95, z0),
        new THREE.Vector3((x0 + x1) / 2, FLOOR_Y + 0.62, (z0 + z1) / 2),
        new THREE.Vector3(x1, FLOOR_Y + 0.95, z1),
      );
      add(velvet, g(new THREE.TubeGeometry(curve, 10, 0.035, 6, false)), new THREE.Matrix4());
    }

    // A roulette table in the far corner: wheel, felt, and a gold turret.
    add(gold, g(new THREE.CylinderGeometry(0.75, 0.6, 0.25, 24)), T(-3.5, 0.1, -12.5));
    add(cabinet, g(new THREE.CylinderGeometry(0.6, 0.6, 0.26, 24)), T(-3.5, 0.12, -12.5));
    add(gold, g(new THREE.ConeGeometry(0.12, 0.35, 12)), T(-3.5, 0.4, -12.5));

    // Crystal chandeliers: a gold ring with tiers of crystals hanging under it.
    const spots: [number, number, number, number][] = [
      // x, z, height, size
      [-11, -6, 5.6, 0.8],
      [11, -5, 5.6, 0.8],
      [-12, 6, 5.6, 0.8],
      [10.5, 7.5, 5.6, 0.8],
      [0, -13, 5.8, 0.9],
      [0, 0, 7.6, 1.1],
    ];
    const ring = g(new THREE.TorusGeometry(1, 0.05, 6, 32));
    ring.rotateX(Math.PI / 2);
    const crystal = track(new THREE.OctahedronGeometry(0.07, 0));
    const tiers: [number, number, number][] = [
      // radius, drop, count
      [1, 0.25, 22],
      [0.68, 0.55, 15],
      [0.38, 0.85, 9],
      [0, 1.15, 1],
    ];
    const per = tiers.reduce((n, t) => n + t[2], 0);
    const crystals = new THREE.InstancedMesh(crystal, track(new THREE.MeshBasicMaterial({ color: '#fff3d8' })), per * spots.length);
    const m4 = new THREE.Matrix4();
    let ci = 0;
    for (const [x, z, y, size] of spots) {
      add(gold, ring, T(x, y, z, 0, size, size, size));
      add(gold, ring, T(x, y - 0.5 * size, z, 0, size * 0.66, size, size * 0.66));
      for (const [r, drop, count] of tiers) {
        for (let j = 0; j < count; j++) {
          const a = (j / count) * Math.PI * 2;
          m4.compose(
            new THREE.Vector3(x + Math.cos(a) * r * size, y - drop * size, z + Math.sin(a) * r * size),
            new THREE.Quaternion(),
            new THREE.Vector3(size, size * 1.6, size),
          );
          crystals.setMatrixAt(ci++, m4);
        }
      }
    }
    crystals.instanceMatrix.needsUpdate = true;
    this.group.add(crystals);
    // Each geometry was copied into the merged meshes: the originals can go.
    this.afterMerge.push(() => {
      for (const x of geos) x.dispose();
    });
  }

  private readonly afterMerge: (() => void)[] = [];

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

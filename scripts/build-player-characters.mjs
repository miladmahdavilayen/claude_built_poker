#!/usr/bin/env node
// Turns the raw character downloads in players_anime/ (not in git: 213 MB of FBX with 4K textures) into what the
// game loads: apps/web/public/models/players/<id>.glb and <id>.webp (its icon). See DECISIONS.md.
//
// A table can hold eight of these on a phone, so each is cut to a fixed budget: about 14k triangles, 512px textures
// (colour only: no normal or specular maps), cutouts instead of blended transparency. Runs in a real browser, with
// the same FBXLoader the game has. Needs the web dev server: `pnpm --filter @pokerclause/web dev`, then
//   node scripts/build-player-characters.mjs [http://localhost:5173] [only-this-id]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, globSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');
const RAW = join(ROOT, 'players_anime');
const OUT = join(ROOT, 'apps/web/public/models/players');
const CHARACTERS = {
  aj: 'Aj.fbx',
  ch17: 'Ch17_nonPBR.fbx',
  ch31: 'Ch31_nonPBR.fbx',
  ch46: 'Ch46_nonPBR.fbx',
  eve: 'Eve By J.Gonzales.fbx',
  kachujin: 'Kachujin G Rosales.fbx',
  marker: 'passive_marker_man.fbx',
  remy: 'Remy.fbx',
  michelle: 'michelle.fbx',
  // The owner's own (characters.ts): the house dealer of the same name, cut to the same budget.
  'the-boss': 'apps/web/public/models/dealers/the-boss.fbx',
};
const sourceOf = (file) => (file.includes('/') ? join(ROOT, file) : join(RAW, file));
const BUDGET = { triangles: 14000, texture: 512 };
const SIMPLIFIER = globSync('node_modules/.pnpm/meshoptimizer@*/node_modules/meshoptimizer/meshopt_simplifier.module.js', { cwd: ROOT })[0];
if (!SIMPLIFIER) throw new Error('meshoptimizer not found under node_modules/.pnpm');

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
page.on('pageerror', (e) => console.log('page error:', e.message.slice(0, 300)));
await page.route('**/__raw/**', (r) => r.fulfill({ body: readFileSync(sourceOf(CHARACTERS[decodeURIComponent(r.request().url().split('/__raw/')[1])])), contentType: 'application/octet-stream' }));
await page.route('**/__simplifier.js', (r) => r.fulfill({ body: readFileSync(join(ROOT, SIMPLIFIER)), contentType: 'text/javascript' }));
await page.goto(process.argv[2] ?? 'http://localhost:5173/');
const fsBase = `/@fs${join(ROOT, 'apps/web/node_modules/three')}`;

for (const [id] of Object.entries(CHARACTERS).filter(([key]) => !process.argv[3] || key === process.argv[3])) {
  const result = await page.evaluate(
    async ({ id, fsBase, BUDGET }) => {
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const { FBXLoader } = await import(`${fsBase}/examples/jsm/loaders/FBXLoader.js`);
      const { GLTFExporter } = await import(`${fsBase}/examples/jsm/exporters/GLTFExporter.js`);
      const { mergeVertices } = await import(`${fsBase}/examples/jsm/utils/BufferGeometryUtils.js`);
      const { MeshoptSimplifier } = await import('/__simplifier.js');
      await MeshoptSimplifier.ready;

      // --- Load, with every embedded texture actually decoded.
      const manager = new THREE.LoadingManager();
      const model = await new FBXLoader(manager).loadAsync(`/__raw/${encodeURIComponent(id)}`);
      await new Promise((r) => { const t = setInterval(() => { let ok = true; model.traverse((o) => { for (const m of o.isMesh ? [].concat(o.material) : []) for (const k of ['map', 'alphaMap']) if (m[k] && !m[k].image) ok = false; }); if (ok) { clearInterval(t); r(); } }, 50); setTimeout(() => { clearInterval(t); r(); }, 8000); });
      await new Promise((r) => setTimeout(r, 300));
      const strays = [];
      model.traverse((o) => { if (o.isLight || o.isCamera) strays.push(o); });
      for (const o of strays) o.removeFromParent();

      // --- A mesh per material.
      const originals = [];
      model.traverse((o) => { if (o.isSkinnedMesh) originals.push(o); });
      for (const mesh of originals) {
        const mats = [].concat(mesh.material);
        if (mats.length < 2 || mesh.geometry.groups.length < 2) { mesh.material = mats[0]; continue; }
        const g = mesh.geometry;
        // All of a material's ranges together: a file can scatter one across dozens of groups, each its own draw call.
        const byMaterial = new Map();
        for (const group of g.groups) byMaterial.set(group.materialIndex ?? 0, [...(byMaterial.get(group.materialIndex ?? 0) ?? []), group]);
        for (const [index, groups] of byMaterial) {
          const part = new THREE.BufferGeometry();
          const count = groups.reduce((sum, r) => sum + r.count, 0);
          for (const [name, a] of Object.entries(g.attributes)) {
            const arr = new a.array.constructor(count * a.itemSize);
            let at = 0;
            for (const r of groups) {
              arr.set(a.array.subarray(r.start * a.itemSize, (r.start + r.count) * a.itemSize), at);
              at += r.count * a.itemSize;
            }
            part.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
          }
          const m = new THREE.SkinnedMesh(part, mats[index]);
          m.name = `${mesh.name}_${String(index)}`;
          m.bind(mesh.skeleton, mesh.bindMatrix);
          m.position.copy(mesh.position); m.quaternion.copy(mesh.quaternion); m.scale.copy(mesh.scale);
          mesh.parent.add(m);
        }
        mesh.removeFromParent();
      }
      const meshes = [];
      model.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
      for (const mesh of [...meshes]) {
        // Empty parts (a material no triangle uses) go.
        if (!mesh.geometry.attributes.position.count) { mesh.removeFromParent(); meshes.splice(meshes.indexOf(mesh), 1); }
      }

      // --- Geometry: shared vertices, then simplified to the budget, each part in proportion.
      const welded = meshes.map((mesh) => {
        const g = mesh.geometry;
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(name)) g.deleteAttribute(name);
        g.clearGroups();
        return mergeVertices(g, 1e-3);
      });
      const triCount = (g) => g.index.count / 3;
      const before = welded.reduce((s, g) => s + triCount(g), 0);
      const ratio = Math.min(1, BUDGET.triangles / before);
      for (const [i, mesh] of meshes.entries()) {
        let g = welded[i];
        if (ratio < 1 && triCount(g) > 300) {
          const target = Math.max(300, Math.floor(g.index.count * ratio / 3)) * 3;
          const [indices] = MeshoptSimplifier.simplify(new Uint32Array(g.index.array), g.attributes.position.array, 3, target, 0.06, []);
          // Only the vertices still in use.
          const remap = new Map();
          const out = new Uint32Array(indices.length);
          indices.forEach((v, k) => { if (!remap.has(v)) remap.set(v, remap.size); out[k] = remap.get(v); });
          const fresh = new THREE.BufferGeometry();
          for (const [name, a] of Object.entries(g.attributes)) {
            const arr = new a.array.constructor(remap.size * a.itemSize);
            for (const [from, to] of remap) for (let c = 0; c < a.itemSize; c++) arr[to * a.itemSize + c] = a.array[from * a.itemSize + c];
            fresh.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
          }
          fresh.setIndex(new THREE.BufferAttribute(out, 1));
          g = fresh;
        }
        g.computeBoundingSphere();
        g.computeBoundingBox();
        mesh.geometry = g;
      }
      const after = meshes.reduce((s, m) => s + triCount(m.geometry), 0);

      // --- Textures: colour only, 512px at most; a cutout's alpha goes into the colour's.
      const shrink = (map, alphaMap) => {
        const img = map?.image;
        if (!img?.width) return null;
        const scale = Math.min(1, BUDGET.texture / Math.max(img.width, img.height));
        const w = Math.max(4, Math.round(img.width * scale));
        const h = Math.max(4, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        if (alphaMap?.image?.width) {
          const a = document.createElement('canvas');
          a.width = w; a.height = h;
          const ac = a.getContext('2d');
          ac.drawImage(alphaMap.image, 0, 0, w, h);
          const px = ctx.getImageData(0, 0, w, h);
          const ax = ac.getImageData(0, 0, w, h).data;
          for (let i = 0; i < px.data.length; i += 4) px.data[i + 3] = ax[i]; // luminance as alpha
          ctx.putImageData(px, 0, 0);
        }
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.flipY = map.flipY;
        t.wrapS = map.wrapS; t.wrapT = map.wrapT;
        t.userData.mimeType = alphaMap ? 'image/png' : 'image/jpeg';
        return t;
      };
      const fresh = new Map();
      const textures = [];
      for (const mesh of meshes) {
        const old = mesh.material;
        if (!fresh.has(old)) {
          const cutout = old.transparent || !!old.alphaMap;
          const map = shrink(old.map, cutout ? old.alphaMap ?? null : null);
          if (map) textures.push(`${String(map.image.width)}x${String(map.image.height)}`);
          fresh.set(old, new THREE.MeshStandardMaterial({ name: old.name, map, color: map ? 0xffffff : old.color, roughness: 0.85, metalness: 0, alphaTest: cutout && map ? 0.5 : 0, side: cutout ? THREE.DoubleSide : THREE.FrontSide }));
        }
        mesh.material = fresh.get(old);
      }

      // --- The icon: head and shoulders, on a transparent ground.
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setSize(160, 160);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight('#ffffff', '#b8b0a8', 3));
      const front = new THREE.DirectionalLight('#ffffff', 1.2);
      front.position.set(0.3, 0.4, 1);
      scene.add(front);
      scene.add(model);
      model.updateMatrixWorld(true);
      let headBone = null;
      let hipsBone = null;
      model.traverse((o) => { if (o.isBone && /Head$/.test(o.name)) headBone = o; if (o.isBone && /Hips$/.test(o.name)) hipsBone = o; });
      for (const m of meshes) m.frustumCulled = false;
      const box = new THREE.Box3().setFromObject(model);
      const height = box.max.y - box.min.y;
      const head = headBone.getWorldPosition(new THREE.Vector3());
      // The head's top may be well above the bone (a big cartoon head, hair): frame from the bone to the top of the figure.
      const hipsY = hipsBone.getWorldPosition(new THREE.Vector3()).y;
      const top = box.max.y;
      const span = Math.max((top - head.y) * 2.1, (head.y - hipsY) * 0.62);
      const midY = top - span * 0.46;
      const cam = new THREE.PerspectiveCamera(24, 1, height / 100, height * 20);
      const dist = (span / 2) / Math.tan((24 * Math.PI) / 360);
      cam.position.set(head.x, midY, head.z + dist);
      cam.lookAt(head.x, midY, head.z);
      renderer.render(scene, cam);
      const icon = renderer.domElement.toDataURL('image/webp', 0.85);
      renderer.dispose();
      scene.remove(model);

      // --- The file.
      const glb = await new GLTFExporter().parseAsync(model, { binary: true, animations: [], maxTextureSize: BUDGET.texture });
      const bytes = new Uint8Array(glb);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { glb: btoa(bin), icon, stats: { id, before: Math.round(before), after: Math.round(after), parts: meshes.length, textures, height: +height.toFixed(1) } };
    },
    { id, fsBase, BUDGET },
  );
  writeFileSync(join(OUT, `${id}.glb`), Buffer.from(result.glb, 'base64'));
  writeFileSync(join(OUT, `${id}.webp`), Buffer.from(result.icon.split(',')[1], 'base64'));
  console.log(JSON.stringify({ ...result.stats, kb: Math.round(Buffer.from(result.glb, 'base64').length / 1024) }));
  await page.reload();
}
await browser.close();

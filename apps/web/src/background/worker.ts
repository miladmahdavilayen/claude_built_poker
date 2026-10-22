import { createLoop, type Loop } from './loop.js';
import { createScene, type Scene, type SceneKind } from './scenes.js';

/**
 * The background's own thread: AnimatedBackground hands it the canvas
 * (OffscreenCanvas via transferControlToOffscreen) and forwards resizes,
 * pointer moves and page visibility. Nothing here ever blocks the page.
 */
export type WorkerMessage =
  | { type: 'init'; canvas: OffscreenCanvas; kind: SceneKind; width: number; height: number; dpr: number; fpsCap: number; reduced: boolean; lite: boolean }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'pointer'; x: number; y: number }
  | { type: 'visible'; visible: boolean };

let canvas: OffscreenCanvas | null = null;
let scene: Scene | null = null;
let loop: Loop | null = null;

function resize(width: number, height: number, dpr: number): void {
  if (!canvas || !scene || !loop) return;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  scene.resize(width, height, dpr);
  loop.redraw();
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    canvas = msg.canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    scene = createScene(msg.kind, ctx, { lite: msg.lite });
    loop = createLoop(scene, msg.fpsCap, msg.reduced);
    resize(msg.width, msg.height, msg.dpr);
    loop.start();
  } else if (msg.type === 'resize') {
    resize(msg.width, msg.height, msg.dpr);
  } else if (msg.type === 'pointer') {
    scene?.setPointer(msg.x, msg.y);
  } else if (msg.visible) {
    loop?.start();
  } else {
    loop?.pause();
  }
};

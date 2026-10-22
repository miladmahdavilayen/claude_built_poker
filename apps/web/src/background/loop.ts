import type { Scene } from './scenes.js';

/**
 * Drives a scene: steps and draws it on each animation frame, capped at
 * `fpsCap` (30 on phones and low-power devices — half the work, and a
 * soft background doesn't need more). It also watches its own cost: if
 * frames get expensive it thins the scene out (Scene.setQuality), and
 * fills it back in once there's headroom again. Paused, it does nothing at
 * all. With `reduced` motion it settles the scene and draws one still frame.
 * Runs unchanged in a worker or on the main thread.
 */
export interface Loop {
  start(): void;
  pause(): void;
  /** Draw now — after a resize, so a paused or still scene isn't left blank. */
  redraw(): void;
}

export function createLoop(scene: Scene, fpsCap: number, reduced: boolean): Loop {
  const raf: (cb: (now: number) => void) => number =
    typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(() => cb(performance.now()), 1000 / fpsCap) as unknown as number;
  const cancel = (id: number): void => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));
  const minGap = 1000 / fpsCap - 1.5;
  const budget = (1000 / fpsCap) * 0.3;
  let running = false;
  let handle = 0;
  let last = 0;
  let cost = budget / 2;
  let quality = 1;
  let lastAdjust = 0;
  let settled = false;

  function tick(now: number): void {
    if (!running) return;
    handle = raf(tick);
    if (now - last < minGap) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t0 = performance.now();
    scene.step(dt);
    scene.draw();
    cost = cost * 0.94 + (performance.now() - t0) * 0.06;
    if (cost > budget && quality > 0.35 && now - lastAdjust > 1500) {
      quality = Math.max(0.35, quality * 0.8);
      scene.setQuality(quality);
      lastAdjust = now;
    } else if (cost < budget * 0.4 && quality < 1 && now - lastAdjust > 5000) {
      quality = Math.min(1, quality * 1.12);
      scene.setQuality(quality);
      lastAdjust = now;
    }
  }

  return {
    start(): void {
      if (reduced) {
        if (!settled) {
          // Let the scene play out a few seconds so the still frame has things in it.
          for (let i = 0; i < 140; i++) scene.step(0.05);
          settled = true;
        }
        scene.draw();
        return;
      }
      if (running) return;
      running = true;
      last = performance.now();
      handle = raf(tick);
    },
    pause(): void {
      running = false;
      cancel(handle);
    },
    redraw(): void {
      scene.draw();
    },
  };
}

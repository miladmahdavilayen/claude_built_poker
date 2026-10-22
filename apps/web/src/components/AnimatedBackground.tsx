import { useEffect, useRef } from 'react';
import { createLoop } from '../background/loop.js';
import { createScene, type SceneKind } from '../background/scenes.js';
import type { WorkerMessage } from '../background/worker.js';

/**
 * The page's animated backdrop — "the deal" on the landing page, "the
 * casino floor" in the lobby (see background/scenes.ts). Drawn on a canvas
 * in a Web Worker (OffscreenCanvas) wherever the browser allows, so it
 * never competes with the page for the main thread; otherwise on the main
 * thread, same code.
 *
 * Kept light on purpose: the canvas renders at no more than 1.25× pixel
 * density (1× on phones and low-memory devices), runs at 30fps there, thins
 * itself out if frames get expensive, stops entirely while the tab is
 * hidden, and shows one still frame to anyone who prefers reduced motion.
 * Fixed behind everything, never clickable, hidden from screen readers.
 */
export function AnimatedBackground({ variant }: { variant: SceneKind }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Created here rather than rendered by React: a canvas can only be
    // handed to a worker once, and StrictMode runs this effect twice.
    const canvas = document.createElement('canvas');
    canvas.className = 'bg-canvas';
    host.appendChild(canvas);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const lite = coarse || (nav.deviceMemory ?? 8) <= 4 || nav.hardwareConcurrency <= 4 || nav.connection?.saveData === true;
    const dpr = Math.min(window.devicePixelRatio || 1, lite ? 1 : 1.25);
    const fpsCap = lite ? 30 : 60;
    const size = (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight });

    let send: (msg: Exclude<WorkerMessage, { type: 'init' }>) => void;
    let dispose: () => void;
    if (typeof canvas.transferControlToOffscreen === 'function' && typeof Worker !== 'undefined') {
      const offscreen = canvas.transferControlToOffscreen();
      const worker = new Worker(new URL('../background/worker.ts', import.meta.url), { type: 'module' });
      const init: WorkerMessage = { type: 'init', canvas: offscreen, kind: variant, ...size(), dpr, fpsCap, reduced, lite };
      worker.postMessage(init, [offscreen]);
      send = (msg) => worker.postMessage(msg);
      dispose = () => worker.terminate();
    } else {
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      const scene = createScene(variant, ctx, { lite });
      const loop = createLoop(scene, fpsCap, reduced);
      const resize = (width: number, height: number): void => {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        scene.resize(width, height, dpr);
        loop.redraw();
      };
      const s = size();
      resize(s.width, s.height);
      loop.start();
      send = (msg) => {
        if (msg.type === 'resize') resize(msg.width, msg.height);
        else if (msg.type === 'pointer') scene.setPointer(msg.x, msg.y);
        else if (msg.visible) loop.start();
        else loop.pause();
      };
      dispose = () => loop.pause();
    }

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      clearTimeout(resizeTimer);
      // Mobile address bars resize the viewport while scrolling — settle first.
      resizeTimer = setTimeout(() => send({ type: 'resize', ...size(), dpr }), 150);
    };
    let pointerQueued = false;
    let pointer = { x: 0.5, y: 0.5 };
    const onPointer = (e: PointerEvent): void => {
      pointer = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
      if (pointerQueued) return;
      pointerQueued = true;
      requestAnimationFrame(() => {
        pointerQueued = false;
        send({ type: 'pointer', ...pointer });
      });
    };
    const onVisibility = (): void => send({ type: 'visible', visible: !document.hidden });

    window.addEventListener('resize', onResize);
    if (!coarse && !reduced) window.addEventListener('pointermove', onPointer, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
      dispose();
      canvas.remove();
    };
  }, [variant]);

  return <div ref={hostRef} className={`bg-anim bg-anim-${variant}`} aria-hidden="true" />;
}

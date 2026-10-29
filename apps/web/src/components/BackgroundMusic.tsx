import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

// Soft background music before the game: a calm jazz piano on the login
// page, a gentle swing in the lobby — none at a table, where the table's
// own sounds and the dealer take over. Public-domain tracks (CC0, by Alex
// McCulloch — see public/audio/CREDITS.md), made quiet and soft at the top
// end so they sit in the background. On by default; a small button turns it
// off, and that's remembered.

const TRACKS: Record<string, string> = {
  '/login': '/audio/login-piano.mp3',
  '/lobby': '/audio/lobby-swing.mp3',
};
/** How loud, where a browser lets a page set it (an iPhone plays at the file's own, already quiet, level). */
const VOLUME = 0.55;
const FADE_MS = 1200;
const KEY = 'pokerclause.music';

function loadOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Ramps an element's volume to `to`, then calls `done`. Returns a cancel. */
function fade(el: HTMLAudioElement, to: number, done?: () => void): () => void {
  const from = el.volume;
  const start = performance.now();
  let raf = 0;
  const tick = (now: number): void => {
    const t = Math.min(1, (now - start) / FADE_MS);
    try {
      el.volume = from + (to - from) * t;
    } catch {
      // Out of range on a rounding edge — the next frame corrects it.
    }
    if (t < 1) raf = requestAnimationFrame(tick);
    else done?.();
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

export function BackgroundMusic(): React.JSX.Element | null {
  const { pathname } = useLocation();
  const track = TRACKS[pathname] ?? null;
  const [on, setOn] = useState(loadOn);
  const current = useRef<{ src: string; el: HTMLAudioElement; cancel: () => void } | null>(null);

  useEffect(() => {
    const wanted = on ? track : null;
    const old = current.current;
    if (old && old.src === wanted) return;
    // The track playing now (if any) fades out and stops.
    if (old) {
      old.cancel();
      const el = old.el;
      fade(el, 0, () => {
        el.pause();
        el.removeAttribute('src');
        el.load();
      });
      current.current = null;
    }
    if (!wanted) return;
    const el = new Audio(wanted);
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    const entry: { src: string; el: HTMLAudioElement; cancel: () => void } = { src: wanted, el, cancel: () => undefined };
    current.current = entry;
    const start = (): void => {
      if (current.current !== entry || !el.paused) return;
      el.play().then(
        () => {
          entry.cancel = fade(el, VOLUME);
        },
        () => undefined, // Not allowed yet: the next tap starts it.
      );
    };
    start();
    // A browser won't start music before the page has been touched: the first tap, click or key does.
    const events = ['touchend', 'click', 'keydown'] as const;
    const onGesture = (): void => {
      start();
      if (!el.paused) for (const e of events) window.removeEventListener(e, onGesture, true);
    };
    for (const e of events) window.addEventListener(e, onGesture, true);
    return () => {
      for (const e of events) window.removeEventListener(e, onGesture, true);
    };
  }, [track, on]);

  // Leaving the app's pages altogether (unmounting): silence.
  useEffect(
    () => () => {
      const c = current.current;
      if (c) {
        c.cancel();
        c.el.pause();
      }
    },
    [],
  );

  if (!track) return null;
  return (
    <button
      type="button"
      className={`music-toggle${on ? '' : ' music-toggle--off'}`}
      aria-label={on ? 'Turn music off' : 'Turn music on'}
      aria-pressed={!on}
      title={on ? 'Music on — tap to turn it off' : 'Music off — tap to turn it on'}
      onClick={() => {
        const next = !on;
        setOn(next);
        try {
          window.localStorage.setItem(KEY, next ? 'on' : 'off');
        } catch {
          // Storage blocked — it holds for this visit.
        }
      }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {/* Two eighth notes, beamed. */}
        <path d="M8 17.5V6.5l9-2v11" />
        <path d="M8 9.5l9-2" />
        <ellipse cx="6" cy="17.5" rx="2.2" ry="1.7" fill="currentColor" />
        <ellipse cx="15" cy="15.5" rx="2.2" ry="1.7" fill="currentColor" />
        {!on && <path d="M3 3l18 18" stroke="#ff8a80" strokeWidth="2" />}
      </svg>
    </button>
  );
}

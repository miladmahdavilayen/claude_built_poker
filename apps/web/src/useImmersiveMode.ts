import { useCallback, useEffect, useState } from 'react';

interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}
interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

/**
 * "Hide the chrome while playing, bring it back whenever" — two
 * genuinely different mechanisms bundled behind one toggle, because
 * neither alone covers every browser this app runs in:
 *
 * 1. The real Fullscreen API (`requestFullscreen`/`exitFullscreen`,
 *    with the `webkit`-prefixed fallback older Safari needs) — works on
 *    desktop browsers, Android Chrome, and iPadOS Safari. It does NOT
 *    work on iPhone Safari at all for an arbitrary element (only a
 *    `<video>` gets native fullscreen there) — feature-detected below,
 *    never assumed.
 * 2. A CSS class (`.table-page.immersive`, see styles.css) that hides
 *    this app's OWN secondary chrome — header, voice/waitlist panels,
 *    chat/log tabs — leaving just the felt and action bar. This is what
 *    actually helps on an iPhone, where the real Fullscreen API can't
 *    touch Safari's own address bar/tab UI at all; the only way to
 *    truly get rid of THAT is the visitor adding the site to their home
 *    screen first (see the `apple-mobile-web-app-capable` meta tag in
 *    index.html) — a one-time action outside this hook's control.
 *
 * Both are driven by the same `active` boolean, kept in sync with the
 * BROWSER's own fullscreen state too (e.g. the visitor pressing Esc, or
 * a swipe-down gesture, exits native fullscreen without ever touching
 * this hook's own toggle button) via the fullscreenchange listener
 * below — otherwise the CSS-hidden chrome could get stuck hidden with
 * no visible way back.
 */
export function useImmersiveMode(): { active: boolean; toggle: () => void; nativeFullscreenSupported: boolean } {
  const [active, setActive] = useState(false);

  const nativeFullscreenSupported =
    typeof document !== 'undefined' && !!(document.documentElement.requestFullscreen ?? (document.documentElement as FullscreenElement).webkitRequestFullscreen);

  useEffect(() => {
    const onChange = (): void => {
      const doc = document as FullscreenDocument;
      const isNativeFullscreen = !!(document.fullscreenElement ?? doc.webkitFullscreenElement);
      if (!isNativeFullscreen) setActive(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const toggle = useCallback(() => {
    const next = !active;
    setActive(next);
    const el = document.documentElement as FullscreenElement;
    const doc = document as FullscreenDocument;
    // Best-effort — a device with no native Fullscreen API (iPhone Safari)
    // still gets the CSS-only chrome-hiding half of this via `active`
    // above; there's simply nothing more this call can do there.
    if (next) {
      void (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.())?.catch(() => undefined);
    } else {
      void (document.exitFullscreen ? document.exitFullscreen() : doc.webkitExitFullscreen?.())?.catch(() => undefined);
    }
  }, [active]);

  return { active, toggle, nativeFullscreenSupported };
}

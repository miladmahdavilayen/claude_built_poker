import { useEffect, useRef, useState } from 'react';
import { googleSignInAvailable } from '../api.js';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

/**
 * Renders Google's own "Sign In With Google" button via the Google
 * Identity Services script (loaded in index.html) and hands the resulting
 * ID token up to `onCredential` — the caller POSTs it to the server for
 * verification (see AuthContext's loginWithGoogle/upgradeWithGoogle).
 *
 * Renders nothing if either the client-side (`VITE_GOOGLE_CLIENT_ID`) or
 * server-side (`GOOGLE_CLIENT_ID`) half of the configuration is missing —
 * Google sign-in is an addition, not a replacement, so the rest of the
 * app (guest play, email/password) must keep working with zero setup.
 */
export function GoogleSignInButton({ onCredential }: { onCredential: (idToken: string) => void }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [serverReady, setServerReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!CLIENT_ID) return;
    googleSignInAvailable().then(setServerReady).catch(() => setServerReady(false));
  }, []);

  useEffect(() => {
    if (!CLIENT_ID || !serverReady || !ref.current) return;
    let cancelled = false;
    const el = ref.current;

    const tryInit = (): void => {
      if (cancelled || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: (response) => onCredential(response.credential),
      });
      window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', width: 280 });
    };

    if (window.google) {
      tryInit();
      return;
    }
    // The GIS <script async defer> may not have finished loading yet.
    const id = setInterval(() => {
      if (window.google) {
        tryInit();
        clearInterval(id);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [serverReady, onCredential]);

  if (!CLIENT_ID || !serverReady) return null;
  return <div ref={ref} />;
}

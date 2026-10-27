import { WAIVER_INTRO, WAIVER_TERMS, WAIVER_TITLE, WAIVER_VERSION } from '@pokerclause/shared/waiver';
import { useRef, useState } from 'react';
import type { WaiverDevice } from '../api.js';
import { useAuth } from '../AuthContext.js';
import { AnimatedBackground } from '../components/AnimatedBackground.js';
import { SignaturePad, type SignaturePadHandle } from '../components/SignaturePad.js';
import { ErrorBanner } from '../components/ErrorBanner.js';

/** What the browser can tell about this device — kept on the signed copy, labelled as reported by the browser. */
function deviceInfo(): WaiverDevice {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return {
    platform: (nav.userAgentData?.platform ?? navigator.platform).slice(0, 100) || undefined,
    language: navigator.language.slice(0, 40) || undefined,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone.slice(0, 80) || undefined,
    screen: `${String(window.screen.width)}x${String(window.screen.height)}`,
    touch: navigator.maxTouchPoints > 0,
  };
}

/**
 * The friendly-game waiver every Google player signs — initials and a
 * drawn signature — before they can do anything else (App.tsx routes them
 * here until they have). The text comes from @pokerclause/shared/waiver,
 * the same source the signed PDF is built from, so what's read is exactly
 * what's kept. Signing files a permanent signed copy with the owner (see
 * the server's POST /users/me/waiver). The owner and invited guests are
 * never shown it.
 */
export function WaiverPage(): React.JSX.Element {
  const { user, acceptWaiver, logout } = useAuth();
  const pad = useRef<SignaturePadHandle>(null);
  const [initials, setInitials] = useState('');
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const initialsOk = /^[A-Za-z]{1,5}$/.test(initials.trim());

  const agree = (): void => {
    const signature = pad.current?.toDataUrl() ?? null;
    if (!initialsOk || !signature) {
      setError(!initialsOk ? 'Type your initials — letters only.' : 'Please sign in the box.');
      return;
    }
    setError(null);
    setBusy(true);
    acceptWaiver({ initials: initials.trim(), signature, version: WAIVER_VERSION, device: deviceInfo() }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    });
  };

  return (
    <div className="page-centered waiver-page">
      <AnimatedBackground variant="landing" />
      <div className="auth-card waiver-card">
        <h1>pokerclause</h1>
        <h2>{WAIVER_TITLE}</h2>
        {WAIVER_INTRO.map((p) => (
          <p key={p} className="waiver-lead">
            {p}
          </p>
        ))}
        <ol className="waiver-terms">
          {WAIVER_TERMS.map((term) => (
            <li key={term.lead}>
              <strong>{term.lead}</strong> {term.text}
            </li>
          ))}
        </ol>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            agree();
          }}
        >
          <label>
            Your initials{user ? ` (${user.displayName})` : ''}
            <input
              className="waiver-initials"
              value={initials}
              onChange={(e) => setInitials(e.target.value.toUpperCase())}
              maxLength={5}
              autoComplete="off"
              placeholder="e.g. JD"
            />
          </label>
          <SignaturePad ref={pad} label="Your signature" onChange={setSigned} />
          {error && <ErrorBanner message={error} onClose={() => setError(null)} />}
          <button type="submit" className="btn-primary" disabled={!initialsOk || !signed || busy}>
            {busy ? 'Saving your signed copy…' : 'I agree and sign'}
          </button>
        </form>
        <button type="button" className="landing-link" onClick={() => void logout()}>
          I don&rsquo;t agree &mdash; log out
        </button>
      </div>
    </div>
  );
}

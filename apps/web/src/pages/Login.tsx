import { useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext.js';
import { GoogleSignInButton, useGoogleSignInAvailable } from '../components/GoogleSignInButton.js';

// An owner-generated seat invite (`/table/:id?assign=:token`) sends an
// unauthenticated visitor here via RedirectToLogin in App.tsx, which stashes
// the original destination in location.state.from.
const INVITE_FROM_PATTERN = /^\/table\/[^/]+\?.*\bassign=/;

/** Local development only — see api.devGoogleSignIn. Vite drops the whole branch from a real build. */
const DEV_GOOGLE_STUB = import.meta.env.DEV && import.meta.env.VITE_DEV_GOOGLE_STUB === 'true';

/**
 * The front door is one button: Sign in with Google. That's how every
 * player registers and signs in. The two exceptions keep working as
 * before: a visitor who arrived through an owner-generated invite link
 * gets the guest form ("Display name" → "Play now"), and the owner's
 * email/password form is reached only through the small gear in the
 * bottom-right corner. See DECISIONS.md.
 */
export function LoginPage(): React.JSX.Element {
  const { signupGuest, login, loginWithGoogle, loginWithDevGoogle } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const isInvitedPlayer = typeof from === 'string' && INVITE_FROM_PATTERN.test(from);
  const googleAvailable = useGoogleSignInAvailable();
  // No navigation happens here on a successful sign-in — once `user`
  // becomes truthy, App.tsx's own /login route (LoginRoute) re-evaluates
  // and redirects itself, honoring wherever this visitor was originally
  // headed (e.g. an owner-generated invite link). Navigating from here too
  // used to race that route-level redirect — see LoginRoute's doc comment
  // in App.tsx for why that's a real bug, not just redundant code.
  const [mode, setMode] = useState<'visitor' | 'admin-login'>('visitor');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleCredential = useCallback(
    (idToken: string) => {
      setError(null);
      loginWithGoogle(idToken).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Google sign-in failed.'));
    },
    [loginWithGoogle],
  );

  if (mode === 'admin-login' || isInvitedPlayer) {
    return (
      <div className="page-centered">
        <div className="auth-card">
          <h1>pokerclause</h1>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => (mode === 'admin-login' ? login(email, password) : signupGuest(displayName || 'Guest')));
            }}
          >
            {mode === 'admin-login' ? (
              <>
                <label>
                  Email
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
                <label>
                  Password
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
                </label>
              </>
            ) : (
              <label>
                Display name
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={24} />
              </label>
            )}
            {error && <div className="error-banner">{error}</div>}
            <button type="submit" disabled={busy}>
              {mode === 'admin-login' ? 'Log in' : 'Play now'}
            </button>
            {mode === 'admin-login' && (
              <button type="button" className="btn-ghost" onClick={() => setMode('visitor')}>
                &larr; Back
              </button>
            )}
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="page-centered">
      <div className="auth-card welcome-card">
        <h1>pokerclause</h1>
        <p className="welcome-tagline">No-limit Texas Hold&rsquo;em against computer players. New players start with $1,000 in play money.</p>
        <div className="google-signin-row">
          <GoogleSignInButton onCredential={handleGoogleCredential} />
        </div>
        {googleAvailable === false && !DEV_GOOGLE_STUB && <p className="welcome-unavailable">Sign-in isn&rsquo;t available right now. Please try again later.</p>}
        {DEV_GOOGLE_STUB && <DevGoogleStub busy={busy} onSignIn={(devEmail, name) => void run(() => loginWithDevGoogle(devEmail, name))} />}
        {error && <div className="error-banner">{error}</div>}
      </div>

      <button type="button" className="admin-login-trigger" aria-label="Admin login" title="Admin login" onClick={() => setMode('admin-login')}>
        &#9881;
      </button>
    </div>
  );
}

/** Stands in for Google's button in local development, signing in as a verified Google account with the typed email. */
function DevGoogleStub({ busy, onSignIn }: { busy: boolean; onSignIn: (email: string, displayName: string) => void }): React.JSX.Element {
  const [devEmail, setDevEmail] = useState('player@gmail.com');
  const [name, setName] = useState('Test Player');
  return (
    <form
      className="dev-google-stub"
      onSubmit={(e) => {
        e.preventDefault();
        onSignIn(devEmail, name);
      }}
    >
      <p className="dev-google-stub-note">Local dev only — stands in for Google sign-in</p>
      <input type="email" aria-label="Dev Google email" value={devEmail} onChange={(e) => setDevEmail(e.target.value)} required />
      <input aria-label="Dev Google name" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required />
      <button type="submit" disabled={busy}>
        Continue as this Google account
      </button>
    </form>
  );
}

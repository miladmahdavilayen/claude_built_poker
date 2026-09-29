import { useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext.js';
import { GoogleSignInButton } from '../components/GoogleSignInButton.js';

// An owner-generated seat invite (`/table/:id?assign=:token`) sends an
// unauthenticated visitor here via RedirectToLogin in App.tsx, which stashes
// the original destination in location.state.from. Invited human players
// should only ever see "Play as guest" — not Google or the admin login — so
// they can't wander off into an unrelated account instead of taking the seat
// they were invited to.
const INVITE_FROM_PATTERN = /^\/table\/[^/]+\?.*\bassign=/;

/**
 * A human player has exactly two ways in: Google, or a guest session — no
 * public self-registration exists anymore (see DECISIONS.md). The
 * email/password form still works, but ONLY for the admin/owner account,
 * and is deliberately never shown as a real option: a small, easy-to-miss
 * trigger tucked in the bottom-right corner is the only way to reach it,
 * so a regular visitor never even notices it's there.
 */
export function LoginPage(): React.JSX.Element {
  const { signupGuest, login, loginWithGoogle } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const isInvitedPlayer = typeof from === 'string' && INVITE_FROM_PATTERN.test(from);
  // No navigation happens here on success — once `user` becomes truthy,
  // App.tsx's own /login route (LoginRoute) re-evaluates and redirects
  // itself, honoring wherever this visitor was originally headed (e.g.
  // an owner-generated invite link). Navigating from here too used to
  // race that route-level redirect — see LoginRoute's doc comment in
  // App.tsx for why that's a real bug, not just redundant code.
  const [mode, setMode] = useState<'guest' | 'admin-login'>('guest');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'guest') await signupGuest(displayName || 'Guest');
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleCredential = useCallback(
    (idToken: string) => {
      setError(null);
      setBusy(true);
      loginWithGoogle(idToken)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Google sign-in failed.'))
        .finally(() => setBusy(false));
    },
    [loginWithGoogle],
  );

  return (
    <div className="page-centered">
      <div className="auth-card">
        <h1>pokerclause</h1>

        {!isInvitedPlayer && mode === 'guest' && (
          <div className="google-signin-row">
            <GoogleSignInButton onCredential={handleGoogleCredential} />
          </div>
        )}

        <form onSubmit={(e) => void submit(e)}>
          {mode === 'guest' ? (
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={24} />
            </label>
          ) : (
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
          )}
          {error && <div className="error-banner">{error}</div>}
          <button type="submit" disabled={busy}>
            {mode === 'guest' ? 'Play now' : 'Log in'}
          </button>
          {mode === 'admin-login' && (
            <button type="button" className="btn-ghost" onClick={() => setMode('guest')}>
              &larr; Back
            </button>
          )}
        </form>
      </div>

      {!isInvitedPlayer && mode === 'guest' && (
        <button
          type="button"
          className="admin-login-trigger"
          aria-label="Admin login"
          title="Admin login"
          onClick={() => setMode('admin-login')}
        >
          &#9881;
        </button>
      )}
    </div>
  );
}

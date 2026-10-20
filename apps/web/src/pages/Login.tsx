import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.js';

// An owner-generated seat invite (`/table/:id?assign=:token`) sends an
// unauthenticated visitor here via RedirectToLogin in App.tsx, which stashes
// the original destination in location.state.from.
const INVITE_FROM_PATTERN = /^\/table\/[^/]+\?.*\bassign=/;

/**
 * Turns whatever an invited player pasted (the full link, with or without
 * the domain, from this or an older address) into the in-app path to open,
 * or null if it isn't an invite link at all.
 */
function invitePathFrom(input: string): string | null {
  try {
    const url = new URL(input.trim(), window.location.origin);
    const path = `${url.pathname}${url.search}`;
    return INVITE_FROM_PATTERN.test(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * The site is invite-only. Only a visitor who arrived through an
 * owner-generated invite link gets the guest form ("Display name" → "Play
 * now"); anyone else is asked for their invitation link and can't create
 * a guest session from here. The owner's email/password form is reached
 * only through the small, deliberately unadvertised gear in the
 * bottom-right corner. See DECISIONS.md.
 */
export function LoginPage(): React.JSX.Element {
  const { signupGuest, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as { from?: string } | null)?.from;
  const isInvitedPlayer = typeof from === 'string' && INVITE_FROM_PATTERN.test(from);
  // No navigation happens here on a successful sign-in — once `user`
  // becomes truthy, App.tsx's own /login route (LoginRoute) re-evaluates
  // and redirects itself, honoring wherever this visitor was originally
  // headed (e.g. an owner-generated invite link). Navigating from here too
  // used to race that route-level redirect — see LoginRoute's doc comment
  // in App.tsx for why that's a real bug, not just redundant code.
  const [mode, setMode] = useState<'visitor' | 'admin-login'>('visitor');
  const [displayName, setDisplayName] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (mode === 'visitor' && !isInvitedPlayer) {
      const path = invitePathFrom(inviteLink);
      if (!path) {
        setError("That doesn't look like an invitation link. Ask the table owner to send you one.");
        return;
      }
      // Opening the invite while signed out lands right back here, this
      // time with the invite as location.state.from — see RedirectToLogin.
      void navigate(path);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'visitor') await signupGuest(displayName || 'Guest');
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-centered">
      <div className="auth-card">
        <h1>pokerclause</h1>

        <form onSubmit={(e) => void submit(e)}>
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
          ) : isInvitedPlayer ? (
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={24} />
            </label>
          ) : (
            <>
              <p className="invite-only-note">PokerClause is invite-only. Paste the invitation link the table owner sent you.</p>
              <label>
                Invitation link
                <input
                  value={inviteLink}
                  onChange={(e) => setInviteLink(e.target.value)}
                  placeholder="https://www.pokerclause.com/table/…"
                  autoComplete="off"
                  required
                />
              </label>
            </>
          )}
          {error && <div className="error-banner">{error}</div>}
          <button type="submit" disabled={busy}>
            {mode === 'admin-login' ? 'Log in' : isInvitedPlayer ? 'Play now' : 'Continue'}
          </button>
          {mode === 'admin-login' && (
            <button type="button" className="btn-ghost" onClick={() => setMode('visitor')}>
              &larr; Back
            </button>
          )}
        </form>
      </div>

      {!isInvitedPlayer && mode === 'visitor' && (
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

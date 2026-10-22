import { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as api from '../api.js';
import { isKnownMember, useAuth } from '../AuthContext.js';
import { GoogleSignInButton, useGoogleSignInAvailable } from '../components/GoogleSignInButton.js';

// An owner-generated seat invite (`/table/:id?assign=:token`) sends an
// unauthenticated visitor here via RedirectToLogin in App.tsx, which stashes
// the original destination in location.state.from.
const INVITE_FROM_PATTERN = /^\/table\/[^/]+\?.*\bassign=/;
// The `assign` token on its own — what the owner can hand out as an "invitation code".
const INVITE_CODE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Local development only — see api.devGoogleSignIn. Vite drops the whole branch from a real build. */
const DEV_GOOGLE_STUB = import.meta.env.DEV && import.meta.env.VITE_DEV_GOOGLE_STUB === 'true';

/**
 * The full invite link (with or without the domain, from this or an older
 * address) → the in-app path to open, or null if it isn't one.
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

type Step = 'choose' | 'google-signup' | 'google-signin';

/**
 * The landing page offers two ways in:
 *
 * - An invitation (the owner's invite link, or just its code) → straight
 *   to that table as a guest: opening it while signed out lands back here
 *   with the invite as `from`, which shows the guest form.
 * - An access key the owner generated for this one new player (admin
 *   dashboard) → Sign up with Google. The key goes along with the Google
 *   sign-in and registering uses it up; it's only needed to register,
 *   never to sign back in.
 *
 * A returning player's session cookie signs them straight in; if they've
 * logged out, this browser remembers they have an account (isKnownMember)
 * and opens on "Sign in with Google" — as does "Already have an account?"
 * anywhere else. The owner's email/password form stays behind the gear in
 * the bottom-right corner. See DECISIONS.md.
 */
export function LoginPage(): React.JSX.Element {
  const { signupGuest, login, loginWithGoogle, loginWithDevGoogle } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as { from?: string } | null)?.from;
  const isInvitedPlayer = typeof from === 'string' && INVITE_FROM_PATTERN.test(from);
  const inviteToken = isInvitedPlayer ? (new URLSearchParams(from.split('?')[1]).get('assign') ?? '') : '';
  const googleAvailable = useGoogleSignInAvailable();
  // No navigation happens here on a successful sign-in — once `user`
  // becomes truthy, App.tsx's own /login route (LoginRoute) re-evaluates
  // and redirects itself, honoring wherever this visitor was originally
  // headed (e.g. an owner-generated invite link). Navigating from here too
  // used to race that route-level redirect — see LoginRoute's doc comment
  // in App.tsx for why that's a real bug, not just redundant code.
  const [mode, setMode] = useState<'visitor' | 'admin-login'>('visitor');
  const [step, setStep] = useState<Step>(() => (isKnownMember() ? 'google-signin' : 'choose'));
  const [invite, setInvite] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [signupKey, setSignupKey] = useState<string | undefined>(undefined);
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

  const goTo = (next: Step): void => {
    setError(null);
    setStep(next);
  };

  const handleGoogleCredential = useCallback(
    (idToken: string) => {
      setError(null);
      loginWithGoogle(idToken, signupKey).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Google sign-in failed.'));
    },
    [loginWithGoogle, signupKey],
  );

  const openInvite = (): Promise<void> =>
    run(async () => {
      const path = invitePathFrom(invite);
      if (path) {
        // Opening the invite while signed out lands right back here, this
        // time with the invite as location.state.from — see RedirectToLogin.
        void navigate(path);
        return;
      }
      const code = invite.trim();
      if (!INVITE_CODE_PATTERN.test(code)) throw new Error("That doesn't look like an invitation. Paste the link or code the table owner sent you.");
      const { tableId } = await api.lookupInvite(code);
      void navigate(`/table/${tableId}?assign=${code}`);
    });

  const submitAccessKey = (): Promise<void> =>
    run(async () => {
      const key = accessKey.trim();
      await api.checkSignupKey(key);
      setSignupKey(key);
      setStep('google-signup');
    });

  if (mode === 'admin-login' || isInvitedPlayer) {
    return (
      <div className="page-centered">
        <div className="auth-card">
          <h1>pokerclause</h1>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => (mode === 'admin-login' ? login(email, password) : signupGuest(displayName || 'Guest', inviteToken)));
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

        {step === 'choose' && (
          <>
            <p className="welcome-tagline">No-limit Texas Hold&rsquo;em with play money.</p>
            <form
              className="landing-option"
              onSubmit={(e) => {
                e.preventDefault();
                void openInvite();
              }}
            >
              <h2>Invited to a table?</h2>
              <label>
                Invitation link or code
                <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Paste it here" autoComplete="off" required />
              </label>
              <button type="submit" className="btn-primary" disabled={busy}>
                Join table
              </button>
            </form>
            <div className="landing-divider">
              <span>or</span>
            </div>
            <form
              className="landing-option"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAccessKey();
              }}
            >
              <h2>Have an access key?</h2>
              <label>
                Access key
                <input
                  className="access-key-input"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={64}
                  required
                />
              </label>
              <button type="submit" className="btn-secondary" disabled={busy}>
                Continue to sign up
              </button>
            </form>
            {error && <div className="error-banner">{error}</div>}
            <button type="button" className="landing-link" onClick={() => goTo('google-signin')}>
              Already have an account? Sign in
            </button>
          </>
        )}

        {step !== 'choose' && (
          <>
            <p className="welcome-tagline">
              {step === 'google-signup'
                ? 'Create your account with Google. New players start with $1,000 in play money.'
                : 'Welcome back. Sign in with the Google account you registered with.'}
            </p>
            <div className="google-signin-row">
              <GoogleSignInButton onCredential={handleGoogleCredential} />
            </div>
            {googleAvailable === false && !DEV_GOOGLE_STUB && <p className="welcome-unavailable">Sign-in isn&rsquo;t available right now. Please try again later.</p>}
            {DEV_GOOGLE_STUB && (
              <DevGoogleStub
                busy={busy}
                onSignIn={(devEmail, name) => void run(() => loginWithDevGoogle(devEmail, name, step === 'google-signup' ? signupKey : undefined))}
              />
            )}
            {error && <div className="error-banner">{error}</div>}
            <button type="button" className="landing-link" onClick={() => goTo('choose')}>
              {step === 'google-signup' ? '← Back' : 'New here, or invited to a table?'}
            </button>
          </>
        )}
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

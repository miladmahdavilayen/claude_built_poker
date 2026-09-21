import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.js';
import { GoogleSignInButton } from '../components/GoogleSignInButton.js';

export function LoginPage(): React.JSX.Element {
  const { signupGuest, login, register, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'guest' | 'login' | 'register'>('guest');
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
      else if (mode === 'login') await login(email, password);
      else await register(email, password, displayName);
      void navigate('/lobby');
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
        .then(() => navigate('/lobby'))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Google sign-in failed.'))
        .finally(() => setBusy(false));
    },
    [loginWithGoogle, navigate],
  );

  return (
    <div className="page-centered">
      <div className="auth-card">
        <h1>pokerclause</h1>

        <div className="google-signin-row">
          <GoogleSignInButton onCredential={handleGoogleCredential} />
        </div>

        <div className="auth-tabs">
          <button type="button" className={mode === 'guest' ? 'active' : ''} onClick={() => setMode('guest')}>
            Play as guest
          </button>
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Log in
          </button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Register
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          {mode !== 'login' && (
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={24} />
            </label>
          )}
          {mode !== 'guest' && (
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
            {mode === 'guest' ? 'Play now' : mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useAuth } from '../AuthContext.js';
import { AnimatedBackground } from '../components/AnimatedBackground.js';

/**
 * The friendly-game waiver every Google player agrees to, by typing their
 * initials, before they can do anything else (App.tsx routes them here
 * until they have). Short on purpose: a quick read, then agree. Rewording
 * it means bumping WAIVER_VERSION (packages/shared), which asks everyone
 * to agree again. The owner and invited guests are never shown it.
 */
export function WaiverPage(): React.JSX.Element {
  const { user, acceptWaiver, logout } = useAuth();
  const [initials, setInitials] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z]{1,5}$/.test(initials.trim());

  const agree = (): void => {
    if (!valid) {
      setError('Type your initials — letters only.');
      return;
    }
    setError(null);
    setBusy(true);
    acceptWaiver(initials.trim()).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    });
  };

  return (
    <div className="page-centered">
      <AnimatedBackground variant="landing" />
      <div className="auth-card waiver-card">
        <h1>pokerclause</h1>
        <h2>Friendly game agreement</h2>
        <p className="waiver-lead">
          PokerClause is a private app for a small circle of friends &mdash; a friendly home game, played only for fun.
        </p>
        <p className="waiver-lead">By typing your initials, you understand and agree that:</p>
        <ol className="waiver-terms">
          <li>
            <strong>It&rsquo;s play money only.</strong> Chips have no cash value and can&rsquo;t be bought, sold or cashed out. No one &mdash; including the
            app&rsquo;s owner &mdash; makes any money or gains any benefit from it.
          </li>
          <li>
            <strong>It&rsquo;s provided as is.</strong> There&rsquo;s no promise it works, stays online, or keeps your account or balance.
          </li>
          <li>
            <strong>You play at your own risk</strong> and give up any right to sue or bring any claim against the app or its owner over anything to do with
            it, to the fullest extent the law allows.
          </li>
          <li>
            <strong>The owner may change, pause or remove</strong> the app or your account at any time.
          </li>
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
              autoFocus
              placeholder="e.g. JD"
            />
          </label>
          {error && <div className="error-banner">{error}</div>}
          <button type="submit" className="btn-primary" disabled={!valid || busy}>
            {busy ? 'Saving…' : 'I agree'}
          </button>
        </form>
        <button type="button" className="landing-link" onClick={() => void logout()}>
          I don&rsquo;t agree &mdash; log out
        </button>
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.js';
import { LeftTablePage } from './pages/Left.js';
import { LobbyPage } from './pages/Lobby.js';
import { LoginPage } from './pages/Login.js';
import { TablePage } from './pages/Table.js';
import { unlockAudio } from './sound.js';

export function App(): React.JSX.Element {
  const { user, loading } = useAuth();

  // Browsers block audio until a real user gesture happens on the page —
  // unlock it on the very first one, anywhere, so the shuffle/deal sound
  // effects are ready by the time a hand actually starts (which may be
  // triggered by another player's click, not this viewer's own).
  useEffect(() => {
    const onFirstInteraction = (): void => {
      unlockAudio();
      window.removeEventListener('pointerdown', onFirstInteraction);
      window.removeEventListener('keydown', onFirstInteraction);
    };
    window.addEventListener('pointerdown', onFirstInteraction);
    window.addEventListener('keydown', onFirstInteraction);
    return () => {
      window.removeEventListener('pointerdown', onFirstInteraction);
      window.removeEventListener('keydown', onFirstInteraction);
    };
  }, []);

  if (loading) return <div className="page-centered">Loading...</div>;

  return (
    <Routes>
      <Route path="/" element={<Navigate to={user ? '/lobby' : '/login'} replace />} />
      <Route path="/login" element={<LoginRoute user={user} />} />
      <Route path="/lobby" element={user ? <LobbyPage /> : <RedirectToLogin />} />
      <Route path="/table/:tableId" element={user ? <TablePage /> : <RedirectToLogin />} />
      {/* Not gated on `user` — an invited guest's session is already
          logged out by the time they land here (see Table.tsx's
          leave-table confirm and Left.tsx's own doc comment), and this
          page must still render for them regardless. */}
      <Route path="/left" element={<LeftTablePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Redirects to /login while remembering exactly where the visitor was
 * trying to go (path + query string) — an owner-generated invite link
 * (`/table/:id?assign=:token`) opened by someone not yet signed in used
 * to lose that destination entirely: `<Navigate to="/login" />` alone
 * carries no memory of it, so after signing up they landed on the
 * generic lobby instead of the table they were actually invited to
 * (their now-orphaned assign token still sitting, unused, in a URL
 * nobody was on anymore). See DECISIONS.md.
 */
function RedirectToLogin(): React.JSX.Element {
  const location = useLocation();
  return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
}

/**
 * The /login route itself, not just LoginPage — deliberately, so it's
 * the SOLE place that decides where an authenticated visitor goes.
 * `LoginPage` used to also call `navigate(from)` itself once sign-in
 * succeeded, racing this exact route's own `user ? <Navigate to
 * "/lobby"/> : ...` re-evaluation (which fires the instant `user`
 * becomes truthy, since `/login` is still the current route at that
 * point) — whichever one's `history.replaceState` landed second won,
 * and the hardcoded `/lobby` here wasn't guaranteed to lose that race.
 * With only one navigation decision left (this one), there's nothing
 * left to race.
 */
function LoginRoute({ user }: { user: unknown }): React.JSX.Element {
  const location = useLocation();
  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/lobby';
    return <Navigate to={from} replace />;
  }
  return <LoginPage />;
}

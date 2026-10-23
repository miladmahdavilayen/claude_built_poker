import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from './api.js';
import type { PublicUser } from './api.js';

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  loading: boolean;
  /** Starts a guest session for redeeming this invite (the `assign` token). */
  signupGuest: (displayName: string, inviteToken: string, termsVersion: number) => Promise<void>;
  /** Email/password login — only ever reachable by the admin/owner account. See Login.tsx. */
  login: (email: string, password: string) => Promise<void>;
  /** `signupKey` (the owner's access key) is needed only to register a new account. */
  loginWithGoogle: (idToken: string, signupKey?: string) => Promise<void>;
  /** Local development only — see api.devGoogleSignIn. */
  loginWithDevGoogle: (email: string, displayName: string, signupKey?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Permanently deletes the signed-in (non-guest, non-admin) user's own account. Clears local session state on success — the caller still owns navigating away. */
  deleteAccount: () => Promise<void>;
  reloadUser: () => Promise<void>;
  /** Signs the friendly-game waiver — see pages/Waiver.tsx. */
  acceptWaiver: (input: Parameters<typeof api.acceptWaiver>[0]) => Promise<void>;
  /** Optimistically reflects a display-name change already sent to (and applied by) the server — e.g. the owner renaming themselves right before sitting down via 'take-seat'. No round trip of its own; the server is the actual source of truth. */
  setDisplayName: (displayName: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Set in this browser once someone has signed in with Google here, and
 * cleared only when they delete their account — so after logging out (or
 * their 30-day session lapsing) the landing page greets them with
 * "Sign in with Google" instead of asking for an access key again.
 */
const MEMBER_KEY = 'pokerclause.googleMember';

export function isKnownMember(): boolean {
  try {
    return localStorage.getItem(MEMBER_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberMember(known: boolean): void {
  try {
    if (known) localStorage.setItem(MEMBER_KEY, '1');
    else localStorage.removeItem(MEMBER_KEY);
  } catch {
    // Storage blocked (private mode etc.) — the landing page just won't remember.
  }
}

// The refresh token is single-use and rotates on every call. React's
// StrictMode deliberately double-invokes effects in development, which
// would otherwise fire two concurrent /auth/refresh requests on mount —
// whichever loses the race to consume the token gets a 401, and if its
// promise settles after the winner's, it can clobber good session state
// right back to "logged out". Deduping to one shared in-flight promise
// means both effect invocations resolve from the same single request.
let inFlightRefresh: ReturnType<typeof api.refresh> | null = null;
function refreshOnce(): ReturnType<typeof api.refresh> {
  inFlightRefresh ??= api.refresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;
    refreshOnce()
      .then((res) => {
        if (ignore) return;
        setUser(res.user);
        setAccessToken(res.accessToken);
        if (res.user.hasGoogle) rememberMember(true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const signupGuest = useCallback(async (displayName: string, inviteToken: string, termsVersion: number) => {
    const res = await api.signupGuest(displayName, inviteToken, termsVersion);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  const loginWithGoogle = useCallback(async (idToken: string, signupKey?: string) => {
    const res = await api.googleSignIn(idToken, signupKey);
    rememberMember(true);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  const loginWithDevGoogle = useCallback(async (email: string, displayName: string, signupKey?: string) => {
    const res = await api.devGoogleSignIn(email, displayName, signupKey);
    rememberMember(true);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  /** Re-reads the signed-in user (balance included) from the server — e.g. back in the lobby after a practice table returned its chips. */
  const reloadUser = useCallback(async () => {
    if (!accessToken) return;
    const res = await api.getMe(accessToken);
    setUser(res.user);
  }, [accessToken]);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setAccessToken(null);
  }, []);

  const deleteAccount = useCallback(async () => {
    if (!accessToken) throw new Error('Not signed in.');
    await api.deleteMyAccount(accessToken);
    rememberMember(false);
    setUser(null);
    setAccessToken(null);
  }, [accessToken]);

  const acceptWaiver = useCallback(
    async (input: Parameters<typeof api.acceptWaiver>[0]) => {
      if (!accessToken) throw new Error('Not signed in.');
      const res = await api.acceptWaiver(input, accessToken);
      setUser(res.user);
    },
    [accessToken],
  );

  const setDisplayName = useCallback((displayName: string) => {
    setUser((current) => (current ? { ...current, displayName } : current));
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, accessToken, loading, signupGuest, login, loginWithGoogle, loginWithDevGoogle, reloadUser, acceptWaiver, logout, deleteAccount, setDisplayName }),
    [user, accessToken, loading, signupGuest, login, loginWithGoogle, loginWithDevGoogle, reloadUser, acceptWaiver, logout, deleteAccount, setDisplayName],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from './api.js';
import type { PublicUser } from './api.js';

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  loading: boolean;
  signupGuest: (displayName: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  upgrade: (email: string, password: string) => Promise<void>;
  upgradeWithGoogle: (idToken: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

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
      })
      .catch(() => undefined)
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const signupGuest = useCallback(async (displayName: string) => {
    const res = await api.signupGuest(displayName);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const res = await api.register(email, password, displayName);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  const loginWithGoogle = useCallback(async (idToken: string) => {
    const res = await api.googleSignIn(idToken);
    setUser(res.user);
    setAccessToken(res.accessToken);
  }, []);

  const upgrade = useCallback(
    async (email: string, password: string) => {
      if (!accessToken) throw new Error('Not signed in.');
      const res = await api.upgrade(email, password, accessToken);
      setUser(res.user);
      setAccessToken(res.accessToken);
    },
    [accessToken],
  );

  const upgradeWithGoogle = useCallback(
    async (idToken: string) => {
      if (!accessToken) throw new Error('Not signed in.');
      const res = await api.upgradeWithGoogle(idToken, accessToken);
      setUser(res.user);
      setAccessToken(res.accessToken);
    },
    [accessToken],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setAccessToken(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, accessToken, loading, signupGuest, register, login, loginWithGoogle, upgrade, upgradeWithGoogle, logout }),
    [user, accessToken, loading, signupGuest, register, login, loginWithGoogle, upgrade, upgradeWithGoogle, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

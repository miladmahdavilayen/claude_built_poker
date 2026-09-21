import { GoogleSignInSchema, GuestSignupSchema, LoginSchema, RegisterSchema } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import { AuthError, login, loginOrRegisterWithGoogle, register, signUpGuest, upgradeGuest, upgradeGuestWithGoogle } from '../../auth/authService.js';
import { isGoogleSignInConfigured, verifyGoogleIdToken } from '../../auth/googleAuth.js';
import { REFRESH_COOKIE_MAX_AGE_SECONDS, REFRESH_COOKIE_NAME, revokeRefreshToken, rotateRefreshToken } from '../../auth/session.js';
import type { Store } from '../../db/store.js';
import { requireAuth } from '../middleware.js';

function publicUser(user: { id: string; email: string | null; displayName: string; isGuest: boolean; role: string; chips: number; avatarSeed: string }) {
  return { id: user.id, email: user.email, displayName: user.displayName, isGuest: user.isGuest, role: user.role, chips: user.chips, avatarSeed: user.avatarSeed };
}

export function registerAuthRoutes(app: FastifyInstance, store: Store): void {
  const isProd = process.env.NODE_ENV === 'production';

  function setRefreshCookie(reply: { setCookie: (name: string, value: string, opts: Record<string, unknown>) => void }, token: string): void {
    reply.setCookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
      maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS,
    });
  }

  app.post('/auth/guest', async (req, reply) => {
    const body = GuestSignupSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid guest signup payload.' });
    const result = await signUpGuest(store, body.data.displayName);
    setRefreshCookie(reply, result.refreshToken);
    return { user: publicUser(result.user), accessToken: result.accessToken };
  });

  app.post('/auth/register', async (req, reply) => {
    const body = RegisterSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid registration payload.' });
    try {
      const result = await register(store, body.data.email, body.data.password, body.data.displayName);
      setRefreshCookie(reply, result.refreshToken);
      return { user: publicUser(result.user), accessToken: result.accessToken };
    } catch (err) {
      if (err instanceof AuthError) return reply.code(409).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/auth/login', async (req, reply) => {
    const body = LoginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid login payload.' });
    try {
      const result = await login(store, body.data.email, body.data.password);
      setRefreshCookie(reply, result.refreshToken);
      return { user: publicUser(result.user), accessToken: result.accessToken };
    } catch (err) {
      if (err instanceof AuthError) return reply.code(401).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.get('/auth/google/available', () => ({ available: isGoogleSignInConfigured() }));

  app.post('/auth/google', async (req, reply) => {
    if (!isGoogleSignInConfigured()) {
      return reply.code(501).send({ code: 'GOOGLE_NOT_CONFIGURED', message: 'Google sign-in is not configured on this server.' });
    }
    const body = GoogleSignInSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid Google sign-in payload.' });
    const profile = await verifyGoogleIdToken(body.data.idToken);
    if (!profile) return reply.code(401).send({ code: 'INVALID_GOOGLE_TOKEN', message: 'Could not verify Google sign-in.' });
    try {
      const result = await loginOrRegisterWithGoogle(store, profile);
      setRefreshCookie(reply, result.refreshToken);
      return { user: publicUser(result.user), accessToken: result.accessToken };
    } catch (err) {
      if (err instanceof AuthError) return reply.code(409).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/auth/upgrade/google', { preHandler: requireAuth }, async (req, reply) => {
    if (!isGoogleSignInConfigured()) {
      return reply.code(501).send({ code: 'GOOGLE_NOT_CONFIGURED', message: 'Google sign-in is not configured on this server.' });
    }
    const body = GoogleSignInSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid Google sign-in payload.' });
    const profile = await verifyGoogleIdToken(body.data.idToken);
    if (!profile) return reply.code(401).send({ code: 'INVALID_GOOGLE_TOKEN', message: 'Could not verify Google sign-in.' });
    try {
      const result = await upgradeGuestWithGoogle(store, req.userId!, profile);
      setRefreshCookie(reply, result.refreshToken);
      return { user: publicUser(result.user), accessToken: result.accessToken };
    } catch (err) {
      if (err instanceof AuthError) return reply.code(409).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/auth/upgrade', { preHandler: requireAuth }, async (req, reply) => {
    const body = RegisterSchema.omit({ displayName: true }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid upgrade payload.' });
    try {
      const result = await upgradeGuest(store, req.userId!, body.data.email, body.data.password);
      setRefreshCookie(reply, result.refreshToken);
      return { user: publicUser(result.user), accessToken: result.accessToken };
    } catch (err) {
      if (err instanceof AuthError) return reply.code(409).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/auth/refresh', async (req, reply) => {
    const token: unknown = req.cookies[REFRESH_COOKIE_NAME];
    if (typeof token !== 'string') return reply.code(401).send({ code: 'NO_REFRESH_TOKEN', message: 'No refresh token.' });
    const rotated = await rotateRefreshToken(store, token);
    if (!rotated) return reply.code(401).send({ code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid or expired.' });
    const user = await store.findUserById(rotated.userId);
    if (!user) return reply.code(401).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    setRefreshCookie(reply, rotated.token);
    const { issueAccessToken } = await import('../../auth/session.js');
    return { user: publicUser(user), accessToken: issueAccessToken(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token: unknown = req.cookies[REFRESH_COOKIE_NAME];
    if (typeof token === 'string') await revokeRefreshToken(store, token);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    return { user: publicUser(user) };
  });
}

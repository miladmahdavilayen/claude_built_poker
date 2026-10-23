import { GoogleSignInSchema, GUEST_TERMS_VERSION, GuestSignupSchema, LoginSchema, SignupKeySchema } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import { AuthError, login, loginOrRegisterWithGoogle, signUpGuest } from '../../auth/authService.js';
import { isGoogleSignInConfigured, verifyGoogleIdToken } from '../../auth/googleAuth.js';
import { hashSignupKey, normalizeSignupKey } from '../../auth/signupKeys.js';
import { inviteLockout, lockedOutReply, signupKeyLockout } from '../../security/lockouts.js';
import { needsWaiver } from '../../auth/waiver.js';
import { REFRESH_COOKIE_MAX_AGE_SECONDS, REFRESH_COOKIE_NAME, revokeRefreshToken, rotateRefreshToken } from '../../auth/session.js';
import type { Store, UserRecord } from '../../db/store.js';
import type { GuestInvite } from '../../game/tableRegistry.js';
import { requireAuth } from '../middleware.js';

export function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isGuest: user.isGuest,
    role: user.role,
    chips: user.chips,
    avatarSeed: user.avatarSeed,
    avatarUrl: user.avatarUrl,
    hasGoogle: user.googleId !== null,
    createdAt: user.createdAt.toISOString(),
    needsWaiver: needsWaiver(user),
  };
}

/**
 * Per-IP limits far tighter than the global one, on the routes an attacker
 * would actually hammer: password guessing on /auth/login (the owner's
 * account is the only password account, so a real owner never needs more
 * than a handful of tries), and mass account creation on the sign-up
 * routes. Env-overridable only so the E2E suite (one shared server, many
 * sign-ups from localhost) can lift them — see playwright.config.ts.
 */
const LOGIN_RATE_LIMIT = { max: Number(process.env.AUTH_LOGIN_LIMIT ?? 5), timeWindow: '15 minutes' };
const SIGNUP_RATE_LIMIT = { max: Number(process.env.AUTH_SIGNUP_LIMIT ?? 20), timeWindow: '1 hour' };
/** Guessing the access key: a real visitor types it once or twice. */
const SIGNUP_KEY_RATE_LIMIT = { max: Number(process.env.AUTH_SIGNUP_KEY_LIMIT ?? 10), timeWindow: '15 minutes' };

/**
 * `describeInvite` says what an invite token is — a live table's one-time
 * seat invite (with the name the owner gave it), or an open-invite table's
 * shareable code — or null (see TableRegistry.describeInvite): a guest
 * session only exists to redeem one, so none is created without it.
 */
export function registerAuthRoutes(app: FastifyInstance, store: Store, describeInvite: (token: string) => GuestInvite | null): void {
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

  // A guest session only ever exists to redeem an owner's invite, so it
  // takes one: anyone (or anything) without a live invite can't mint
  // sessions at all. The invite itself is redeemed later, at the table.
  // The guest must also tick "I agree" to the guest terms; their record —
  // name, the invite they came by, and that agreement (when, IP, device) —
  // is kept for good, under them in the admin dashboard.
  app.post('/auth/guest', { config: { rateLimit: SIGNUP_RATE_LIMIT } }, async (req, reply) => {
    const wait = inviteLockout.retryAfterMs(req.ip);
    if (wait > 0) return reply.code(429).send(lockedOutReply(wait));
    const body = GuestSignupSchema.safeParse(req.body);
    if (!body.success) {
      const unagreed = (req.body as { acceptTerms?: unknown } | null)?.acceptTerms !== true;
      return reply
        .code(400)
        .send(unagreed ? { code: 'TERMS_REQUIRED', message: 'Please agree to the guest terms to play.' } : { code: 'INVALID_PAYLOAD', message: 'Invalid guest signup payload.' });
    }
    if (body.data.termsVersion !== GUEST_TERMS_VERSION) {
      return reply.code(409).send({ code: 'TERMS_CHANGED', message: 'The guest terms have just been updated — reload the page to read them.' });
    }
    const invite = describeInvite(body.data.inviteToken);
    if (!invite) {
      inviteLockout.recordFailure(req.ip);
      return reply.code(403).send({ code: 'INVALID_ASSIGNMENT', message: 'This invitation is invalid or has already been used.' });
    }
    const result = await signUpGuest(store, body.data.displayName);
    const now = new Date();
    await store.recordGuestPlayer({
      id: result.user.id,
      displayName: result.user.displayName,
      adminNickname: invite.adminNickname,
      inviteKind: invite.kind,
      tableId: invite.tableId,
      tableName: invite.tableName,
      joinedAt: now,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
      termsVersion: GUEST_TERMS_VERSION,
      termsAcceptedAt: now,
    });
    setRefreshCookie(reply, result.refreshToken);
    return { user: publicUser(result.user), accessToken: result.accessToken };
  });

  // No public self-registration route — a human player signs in with
  // Google (below), or plays as a guest through an owner's invite link. `/auth/login` (email/password)
  // stays wired up, but is only ever reachable by the admin/owner
  // account, via a small, deliberately unadvertised trigger on the login
  // page — see Login.tsx. See DECISIONS.md.
  app.post('/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
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

  // Checks an access key before the landing page shows Google's button —
  // without using it up (registration does that). Wrong guesses count
  // toward a per-IP lockout on top of the request limit.
  app.post('/auth/signup-key', { config: { rateLimit: SIGNUP_KEY_RATE_LIMIT } }, async (req, reply) => {
    const wait = signupKeyLockout.retryAfterMs(req.ip);
    if (wait > 0) return reply.code(429).send(lockedOutReply(wait));
    const body = SignupKeySchema.safeParse(req.body);
    const normalized = body.success ? normalizeSignupKey(body.data.key) : null;
    const key = normalized ? await store.findUsableSignupKey(hashSignupKey(normalized)) : null;
    if (!key) {
      signupKeyLockout.recordFailure(req.ip);
      return reply.code(403).send({ code: 'INVALID_SIGNUP_KEY', message: 'That access key isn’t valid, or it has expired or already been used.' });
    }
    return { ok: true };
  });

  app.post('/auth/google', { config: { rateLimit: SIGNUP_RATE_LIMIT } }, async (req, reply) => {
    if (!isGoogleSignInConfigured()) {
      return reply.code(501).send({ code: 'GOOGLE_NOT_CONFIGURED', message: 'Google sign-in is not configured on this server.' });
    }
    const body = GoogleSignInSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid Google sign-in payload.' });
    if (body.data.signupKey) {
      const wait = signupKeyLockout.retryAfterMs(req.ip);
      if (wait > 0) return reply.code(429).send(lockedOutReply(wait));
    }
    const profile = await verifyGoogleIdToken(body.data.idToken);
    if (!profile) return reply.code(401).send({ code: 'INVALID_GOOGLE_TOKEN', message: 'Could not verify Google sign-in.' });
    try {
      const result = await loginOrRegisterWithGoogle(store, profile, { signupKey: body.data.signupKey });
      setRefreshCookie(reply, result.refreshToken);
      return { user: publicUser(result.user), accessToken: result.accessToken };
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === 'INVALID_SIGNUP_KEY') signupKeyLockout.recordFailure(req.ip);
        return reply.code(err.code === 'EMAIL_TAKEN' ? 409 : 403).send({ code: err.code, message: err.message });
      }
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

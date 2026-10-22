import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { loginOrRegisterWithGoogle } from '../../auth/authService.js';
import { REFRESH_COOKIE_MAX_AGE_SECONDS, REFRESH_COOKIE_NAME } from '../../auth/session.js';
import type { Store } from '../../db/store.js';
import { publicUser } from './auth.js';

const SeedAccountSchema = z.object({ displayName: z.string().min(1).max(24) }).strict();
const FakeGoogleLoginSchema = z.object({ email: z.string().email(), displayName: z.string().min(1).max(24) }).strict();

/**
 * A real (Google-style) account, for the e2e suite ONLY — this sandbox
 * can't drive an actual Google OAuth click-through (see DECISIONS.md), so
 * there is otherwise no way for a Playwright test to get a second real,
 * persisted, admin-dashboard-visible account onto the page without this.
 * Only ever registered when `ALLOW_TEST_SEEDING=true` (set solely by
 * playwright.config.ts's webServer env — see RATE_LIMIT_MAX/
 * SEED_DEFAULT_TABLES right next to it for the same env-override-for-
 * tests pattern already used elsewhere); a real deployment never sets
 * that variable, so this route doesn't exist there at all.
 */
export function registerTestSeedRoutes(app: FastifyInstance, store: Store): void {
  if (process.env.ALLOW_TEST_SEEDING !== 'true') return;

  app.post('/test-only/seed-account', async (req, reply) => {
    const body = SeedAccountSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid payload.' });
    const googleId = `test-seed-${randomUUID()}`;
    const result = await loginOrRegisterWithGoogle(store, {
      googleId,
      email: `${googleId}@example.com`,
      emailVerified: true,
      displayName: body.data.displayName,
      avatarUrl: null,
    });
    return { id: result.user.id, displayName: result.user.displayName };
  });

  /**
   * Signs in exactly as a verified Google account with this email would —
   * same registration, same welcome-bonus rule, same session cookie — for
   * the e2e suite and for trying the player flow locally without a Google
   * OAuth client. The Google id is derived from the email, so signing in
   * again with it is the same account (or, once deleted, the same person
   * re-registering).
   */
  app.post('/test-only/google-login', async (req, reply) => {
    const body = FakeGoogleLoginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid payload.' });
    const result = await loginOrRegisterWithGoogle(store, {
      googleId: `test-google-${body.data.email.toLowerCase()}`,
      email: body.data.email,
      emailVerified: true,
      displayName: body.data.displayName,
      avatarUrl: null,
    });
    reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS });
    return { user: publicUser(result.user), accessToken: result.accessToken };
  });
}

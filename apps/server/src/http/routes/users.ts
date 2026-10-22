import { AcceptWaiverSchema, WAIVER_VERSION } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import { REFRESH_COOKIE_NAME } from '../../auth/session.js';
import type { Store } from '../../db/store.js';
import { requireAuth } from '../middleware.js';
import { normalizeEmailKey } from '../../auth/authService.js';
import { publicUser } from './auth.js';

/**
 * Self-service routes for a signed-in human's OWN account — what they
 * registered with, and deleting the account outright. Distinct from
 * admin.ts, which does the same kind of thing but for ANY user, gated to
 * the admin role instead of "this is your own session."
 */
export function registerUserRoutes(app: FastifyInstance, store: Store, closePracticeTableOf: (userId: string) => Promise<void>): void {
  app.get('/users/me/profile', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    return {
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      signInMethod: user.googleId ? 'google' : user.isGuest ? 'guest' : 'password',
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  });

  // The friendly-game waiver (see apps/web's Waiver page), agreed to by
  // typing initials. Stored with the version agreed to, so a reworded
  // waiver (a WAIVER_VERSION bump) asks everyone again.
  app.post('/users/me/waiver', { preHandler: requireAuth }, async (req, reply) => {
    const body = AcceptWaiverSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_INITIALS', message: 'Type your initials — letters only.' });
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.isGuest) return reply.code(400).send({ code: 'GUEST_ACCOUNT', message: 'Guests aren’t asked to agree to the waiver.' });
    const updated = await store.acceptWaiver(user.id, WAIVER_VERSION, body.data.initials.toUpperCase());
    return { user: publicUser(updated) };
  });

  // Guests already lose everything the moment they leave/reset/close a
  // table — there's nothing durable for them to delete here, and this
  // account IS the admin's own for exactly one user on the whole
  // deployment, whose loss would be far more disruptive than a normal
  // player's — so this is scoped to a signed-in, non-guest, non-admin
  // account only. Their practice table (if open) closes first, so its
  // stack is back in their balance — which is then kept (see schema.ts's
  // welcomeBonusClaims) and handed back if they register again: deleting
  // an account loses nothing but what was already lost at the tables, and
  // never earns a second welcome bonus. See DECISIONS.md.
  app.delete('/users/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.isGuest) return reply.code(400).send({ code: 'GUEST_ACCOUNT', message: 'Guest sessions have nothing to delete — just leave the table.' });
    if (user.role === 'admin') return reply.code(400).send({ code: 'CANNOT_DELETE_ADMIN', message: 'The admin account cannot be deleted this way.' });
    await closePracticeTableOf(user.id);
    if (user.googleId && user.email) {
      const refunded = await store.findUserById(user.id);
      await store.keepBalanceForReturn(normalizeEmailKey(user.email), user.googleId, refunded?.chips ?? user.chips);
    }
    await store.deleteUser(user.id);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}

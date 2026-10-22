import type { FastifyInstance } from 'fastify';
import { REFRESH_COOKIE_NAME } from '../../auth/session.js';
import type { Store } from '../../db/store.js';
import { requireAuth } from '../middleware.js';

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

  // Guests already lose everything the moment they leave/reset/close a
  // table — there's nothing durable for them to delete here, and this
  // account IS the admin's own for exactly one user on the whole
  // deployment, whose loss would be far more disruptive than a normal
  // player's — so this is scoped to a signed-in, non-guest, non-admin
  // account only. Their practice table (if open) closes first, so its
  // stack lands back in the balance being deleted rather than nowhere.
  // The welcome-bonus claim is NOT deleted — see schema.ts's
  // welcomeBonusClaims. See DECISIONS.md.
  app.delete('/users/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.isGuest) return reply.code(400).send({ code: 'GUEST_ACCOUNT', message: 'Guest sessions have nothing to delete — just leave the table.' });
    if (user.role === 'admin') return reply.code(400).send({ code: 'CANNOT_DELETE_ADMIN', message: 'The admin account cannot be deleted this way.' });
    await closePracticeTableOf(user.id);
    await store.deleteUser(user.id);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}

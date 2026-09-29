import type { FastifyInstance } from 'fastify';
import { REFRESH_COOKIE_NAME } from '../../auth/session.js';
import type { Store } from '../../db/store.js';
import { requireAuth } from '../middleware.js';

/**
 * Self-service routes for a signed-in human's OWN account — balance,
 * play history, and deleting the account outright. Distinct from
 * admin.ts, which does the same kind of thing but for ANY user, gated to
 * the admin role instead of "this is your own session."
 */
export function registerUserRoutes(app: FastifyInstance, store: Store): void {
  app.get('/users/me/summary', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    const [netPlayResult, recentEntries] = await Promise.all([
      store.ledgerPlayNetForUser(user.id),
      store.ledgerEntriesForUser(user.id, 50),
    ]);
    return {
      balance: user.chips,
      netPlayResult,
      recentEntries: recentEntries.map((e) => ({
        id: e.id,
        amount: e.amount,
        reason: e.reason,
        tableId: e.tableId,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  // Guests already lose everything the moment they leave/reset/close a
  // table — there's nothing durable for them to delete here, and this
  // account IS the admin's own for exactly one user on the whole
  // deployment, whose loss would be far more disruptive than a normal
  // player's — so this is scoped to a signed-in, non-guest, non-admin
  // account only. See DECISIONS.md.
  app.delete('/users/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.isGuest) return reply.code(400).send({ code: 'GUEST_ACCOUNT', message: 'Guest sessions have nothing to delete — just leave the table.' });
    if (user.role === 'admin') return reply.code(400).send({ code: 'CANNOT_DELETE_ADMIN', message: 'The admin account cannot be deleted this way.' });
    await store.deleteUser(user.id);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}

import { AdminAdjustChipsSchema, AdminUpdateUserSchema } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../../db/store.js';
import type { TableRegistry } from '../../game/tableRegistry.js';
import { requireAdmin } from '../middleware.js';

export function registerAdminRoutes(app: FastifyInstance, store: Store, registry: TableRegistry): void {
  app.get('/admin/tables', { preHandler: requireAdmin }, () => {
    return { tables: registry.list() };
  });

  app.get('/admin/users', { preHandler: requireAdmin }, async () => {
    const users = await store.listUsers();
    return {
      users: users.map((u) => ({
        id: u.id,
        displayName: u.displayName,
        email: u.email,
        isGuest: u.isGuest,
        role: u.role,
        chips: u.chips,
        hasGoogle: u.googleId !== null,
        createdAt: u.createdAt.toISOString(),
      })),
    };
  });

  /** Full detail for one user — everything the list above has, plus their net play result and recent ledger history, for the dashboard's per-user view. */
  app.get('/admin/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const user = await store.findUserById(userId);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    const [netPlayResult, recentEntries] = await Promise.all([
      store.ledgerPlayNetForUser(user.id),
      store.ledgerEntriesForUser(user.id, 50),
    ]);
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      isGuest: user.isGuest,
      role: user.role,
      chips: user.chips,
      hasGoogle: user.googleId !== null,
      createdAt: user.createdAt.toISOString(),
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

  /** Currently just the display name — chip changes go through /admin/chips instead (a delta + reason, always ledgered, never a raw overwrite). */
  app.patch('/admin/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = AdminUpdateUserSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid payload.' });
    try {
      const updated = await store.updateDisplayName(userId, body.data.displayName);
      return { id: updated.id, displayName: updated.displayName };
    } catch {
      return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    }
  });

  /** Admin deleting another user's account — never the admin's own (use a different admin account for that, or the /users/me self-service route doesn't apply to admins either). */
  app.delete('/admin/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const user = await store.findUserById(userId);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.role === 'admin') return reply.code(400).send({ code: 'CANNOT_DELETE_ADMIN', message: 'The admin account cannot be deleted.' });
    await store.deleteUser(userId);
    return { ok: true };
  });

  app.post('/admin/chips', { preHandler: requireAdmin }, async (req, reply) => {
    const body = AdminAdjustChipsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid payload.' });
    const { userId, amount, reason } = body.data;
    await store.adjustUserChips(userId, amount);
    await store.recordLedgerEntries([
      { userId, isHouse: false, amount, reason: 'admin_adjust' },
      { userId: null, isHouse: true, amount: -amount, reason: 'admin_adjust' },
    ]);
    return { ok: true, reason };
  });

  app.post('/admin/tables/:tableId/close', { preHandler: requireAdmin }, async (req) => {
    const { tableId } = req.params as { tableId: string };
    await registry.close(tableId);
    return { ok: true };
  });

  app.get('/admin/ledger/conservation', { preHandler: requireAdmin }, async () => {
    return store.ledgerConservationCheck();
  });
}

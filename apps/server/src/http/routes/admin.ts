import { AdminAdjustChipsSchema } from '@pokerclause/shared';
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
    return { users: users.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, isGuest: u.isGuest, role: u.role, chips: u.chips })) };
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

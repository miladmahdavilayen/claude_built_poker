import { randomBytes } from 'node:crypto';
import { CreatePracticeTableSchema, CreateTableSchema, type TableSettings } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../../db/store.js';
import { openPracticeTable } from '../../game/practiceTables.js';
import type { TableRegistry } from '../../game/tableRegistry.js';
import { attachAuthIfPresent, requireAdmin, requireAuth } from '../middleware.js';

/** A signed-in player who isn't the admin plays only at their own practice table — see practiceTables.ts. */
export function isPracticeOnly(user: { isGuest: boolean; role: 'player' | 'admin' }): boolean {
  return !user.isGuest && user.role !== 'admin';
}

/** `watchPracticeTable` closes a new practice table if its player never connects to it — see socketServer.ts. */
export function registerTableRoutes(app: FastifyInstance, store: Store, registry: TableRegistry, watchPracticeTable: (tableId: string) => void = () => undefined): void {
  // A practice-only player sees no public tables at all — only their own
  // practice table, if they have one open, to get back to.
  app.get('/tables', async (req) => {
    attachAuthIfPresent(req);
    const viewer = req.userId ? await store.findUserById(req.userId) : null;
    if (viewer && isPracticeOnly(viewer)) {
      const mine = registry.practiceTableOf(viewer.id);
      return { tables: [], practiceTableId: mine?.tableId ?? null };
    }
    return { tables: registry.list().filter((t) => !t.isPrivate), practiceTableId: null };
  });

  app.get('/tables/:tableId', async (req, reply) => {
    attachAuthIfPresent(req);
    const { tableId } = req.params as { tableId: string };
    const table = registry.get(tableId);
    const visible = table && (!table.isPractice || req.userRole === 'admin' || req.userId === table.ownerId);
    if (!visible) return reply.code(404).send({ code: 'TABLE_NOT_FOUND', message: 'Table not found.' });
    return { tableId: table.tableId, name: table.name, settings: table.settings };
  });

  app.post('/tables/practice', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    const body = CreatePracticeTableSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Pick 1 to 4 opponents, the stakes, and a buy-in.' });
    const result = await openPracticeTable(store, registry, user, body.data);
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message, tableId: result.tableId });
    watchPracticeTable(result.table.tableId);
    reply.code(201);
    return { tableId: result.table.tableId };
  });

  // Owner-only: real tables (public or private, any stakes) are the
  // admin's. Every other signed-in player opens a practice table instead
  // (above). See DECISIONS.md.
  app.post('/tables', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateTableSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid table config.' });
    const input = body.data;
    if (input.smallBlind > input.bigBlind) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'The small blind cannot be bigger than the big blind.' });
    if ((input.minBuyIn ?? input.minBuyInBB * input.bigBlind) > (input.maxBuyIn ?? input.maxBuyInBB * input.bigBlind)) {
      return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'The minimum buy-in cannot be above the maximum.' });
    }
    const settings: TableSettings = {
      smallBlind: input.smallBlind,
      bigBlind: input.bigBlind,
      ante: input.ante,
      maxSeats: input.maxSeats,
      straddleEnabled: input.straddleEnabled,
      minBuyIn: input.minBuyIn ?? input.minBuyInBB * input.bigBlind,
      maxBuyIn: input.maxBuyIn ?? input.maxBuyInBB * input.bigBlind,
      actionSeconds: input.actionSeconds,
      timeBankSeconds: input.timeBankSeconds,
      runItTwiceEnabled: input.runItTwiceEnabled,
      rakePercent: input.rakePercent,
      rakeCap: input.rakeCap,
      noFlopNoDrop: input.noFlopNoDrop,
      isPrivate: input.isPrivate,
      disableChatInHand: input.disableChatInHand,
    };
    const inviteCode = input.isPrivate ? randomBytes(4).toString('hex') : null;
    const table = await registry.createTable(input.name, settings, req.userId ?? null, inviteCode);
    reply.code(201);
    return { tableId: table.tableId, name: table.name, settings: table.settings, inviteCode };
  });
}

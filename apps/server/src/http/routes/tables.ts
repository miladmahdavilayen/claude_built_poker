import { randomBytes } from 'node:crypto';
import { CreateTableSchema, type TableSettings } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../../db/store.js';
import type { TableRegistry } from '../../game/tableRegistry.js';
import { attachAuthIfPresent, requireAuth } from '../middleware.js';

export function registerTableRoutes(app: FastifyInstance, store: Store, registry: TableRegistry): void {
  app.get('/tables', (req) => {
    attachAuthIfPresent(req);
    return { tables: registry.list().filter((t) => !t.isPrivate) };
  });

  app.get('/tables/:tableId', async (req, reply) => {
    attachAuthIfPresent(req);
    const { tableId } = req.params as { tableId: string };
    const table = registry.get(tableId);
    if (!table) return reply.code(404).send({ code: 'TABLE_NOT_FOUND', message: 'Table not found.' });
    return { tableId: table.tableId, name: table.name, settings: table.settings };
  });

  app.post('/tables', { preHandler: requireAuth }, async (req, reply) => {
    const body = CreateTableSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid table config.' });
    const input = body.data;
    const settings: TableSettings = {
      smallBlind: input.smallBlind,
      bigBlind: input.bigBlind,
      ante: input.ante,
      maxSeats: input.maxSeats,
      straddleEnabled: input.straddleEnabled,
      minBuyIn: input.minBuyInBB * input.bigBlind,
      maxBuyIn: input.maxBuyInBB * input.bigBlind,
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

import { randomBytes } from 'node:crypto';
import { CreatePracticeTableSchema, CreateTableSchema, type TableSettings } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../../db/store.js';
import { openPracticeTable } from '../../game/practiceTables.js';
import { inviteLockout, lockedOutReply } from '../../security/lockouts.js';
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

  // The landing page's "invitation code" box: an owner's invite link is
  // /table/:id?assign=<token>, and the token alone is enough to find the
  // table. Tokens are random UUIDs (122 bits), so guessing one is hopeless
  // anyway; misses still count toward a per-IP lockout, on top of the rate limit.
  app.get('/invites/:token', { config: { rateLimit: { max: Number(process.env.INVITE_LOOKUP_LIMIT ?? 20), timeWindow: '1 minute' } } }, (req, reply) => {
    const wait = inviteLockout.retryAfterMs(req.ip);
    if (wait > 0) return reply.code(429).send(lockedOutReply(wait));
    const { token } = req.params as { token: string };
    const seatInvite = token.length <= 64 ? registry.tableForInvite(token) : null;
    // An open-invite table's shareable code works here too, and opens the table with it.
    const openTable = !seatInvite && token.length <= 64 ? registry.tableForOpenCode(token) : null;
    if (!seatInvite && !openTable) {
      inviteLockout.recordFailure(req.ip);
      return reply.code(404).send({ code: 'INVALID_ASSIGNMENT', message: 'This invitation is invalid or has already been used.' });
    }
    return seatInvite ? { tableId: seatInvite.tableId } : { tableId: openTable!.tableId, code: token };
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
      // An open-invite table is always private: only its link gets anyone in.
      isPrivate: input.isPrivate || input.openSeating,
      disableChatInHand: input.disableChatInHand,
      ...(input.openSeating ? { openSeating: true } : {}),
    };
    // A shareable link goes to group chats: its code is 96 random bits, not 32.
    const inviteCode = input.openSeating ? randomBytes(12).toString('base64url') : input.isPrivate ? randomBytes(4).toString('hex') : null;
    const table = await registry.createTable(input.name, settings, req.userId ?? null, inviteCode);
    reply.code(201);
    return { tableId: table.tableId, name: table.name, settings: table.settings, inviteCode };
  });
}

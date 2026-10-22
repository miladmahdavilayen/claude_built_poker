import cookie from '@fastify/cookie';
import type { TableSettings } from '@pokerclause/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken } from '../src/auth/session.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import { TableRegistry } from '../src/game/tableRegistry.js';
import { registerAdminRoutes } from '../src/http/routes/admin.js';
import { registerTableRoutes } from '../src/http/routes/tables.js';
import { registerUserRoutes } from '../src/http/routes/users.js';

process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

const SETTINGS_FOR_LIST: TableSettings = {
  smallBlind: 100,
  bigBlind: 200,
  ante: 0,
  maxSeats: 6,
  straddleEnabled: false,
  minBuyIn: 4_000,
  maxBuyIn: 20_000,
  actionSeconds: 25,
  timeBankSeconds: 60,
  runItTwiceEnabled: false,
  rakePercent: 0,
  rakeCap: 0,
  noFlopNoDrop: true,
  isPrivate: false,
  disableChatInHand: false,
};

/**
 * Lightweight `app.inject()` tests for the new authorization-sensitive
 * HTTP routes (create-table's guest gate, self-service delete-account,
 * and the admin user-management endpoints) — no real HTTP server or
 * browser needed for these, unlike the socket layer (socketServer.test.ts)
 * or the full app (only ever exercised via the e2e suite).
 */
describe('HTTP routes: authorization-sensitive endpoints added for the human-account overhaul', () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let registry: TableRegistry;

  beforeEach(async () => {
    store = new MemoryStore();
    registry = new TableRegistry(store, () => undefined);
    app = Fastify();
    await app.register(cookie);
    registerTableRoutes(app, store, registry);
    // The real one (socketServer.ts) also refunds the player's stack — covered in socketServer.test.ts.
    const closePracticeTableOf = async (userId: string): Promise<void> => {
      const table = registry.practiceTableOf(userId);
      if (table) await registry.close(table.tableId);
    };
    registerUserRoutes(app, store, closePracticeTableOf);
    registerAdminRoutes(app, store, registry, closePracticeTableOf);
  });

  afterEach(async () => {
    await app.close();
  });

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  describe('POST /tables', () => {
    it('rejects a guest', async () => {
      const guest = await store.createGuestUser('Gina');
      const res = await app.inject({
        method: 'POST',
        url: '/tables',
        headers: auth(issueAccessToken(guest)),
        payload: { name: 'Guest Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('ADMIN_REQUIRED');
    });

    it('rejects a signed-in Google player — they open practice tables instead', async () => {
      const user = await store.createGoogleAccount({ googleId: 'g-1', email: 'a@gmail.com', displayName: 'Ann', avatarUrl: null });
      const res = await app.inject({
        method: 'POST',
        url: '/tables',
        headers: auth(issueAccessToken(user)),
        payload: { name: 'Ann’s Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('ADMIN_REQUIRED');
    });

    it('allows the admin, recording them as the table’s creator', async () => {
      const admin = await store.createAccount('owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const res = await app.inject({
        method: 'POST',
        url: '/tables',
        headers: auth(issueAccessToken({ ...admin, role: 'admin' })),
        payload: { name: 'Owner Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false },
      });
      expect(res.statusCode).toBe(201);
      const table = registry.get(res.json<{ tableId: string }>().tableId);
      expect(table?.ownerId).toBe(admin.id);
      expect(table?.isPractice).toBe(false);
    });
  });

  describe('practice tables', () => {
    let players = 0;
    async function googlePlayer(chips: number): Promise<{ id: string; token: string }> {
      players += 1;
      const created = await store.createGoogleAccount({ googleId: `g-player-${String(players)}`, email: `player${String(players)}@gmail.com`, displayName: 'Pat', avatarUrl: null });
      const user = await store.adjustUserChips(created.id, chips);
      return { id: user.id, token: issueAccessToken(user) };
    }

    it('seats the player plus the bots they picked, at most 5 seats, and debits the buy-in from their balance', async () => {
      const player = await googlePlayer(100_000);
      const res = await app.inject({
        method: 'POST',
        url: '/tables/practice',
        headers: auth(player.token),
        payload: { bots: 4, stakes: 'medium', buyIn: 15_000 },
      });
      expect(res.statusCode).toBe(201);
      const table = registry.get(res.json<{ tableId: string }>().tableId)!;
      expect(table.isPractice).toBe(true);
      expect(table.ownerId).toBe(player.id);
      expect(table.settings.isPrivate).toBe(true);
      expect(table.visibleSeatCount).toBe(5);
      expect(table.seatOfUser(player.id)).toBe(0);
      expect(table.seats.filter((s) => s.botPolicyName !== null)).toHaveLength(4);
      expect(new Set(table.seats.map((s) => s.botPolicyName).filter(Boolean)).size).toBe(4);
      expect(table.state.seats.every((s) => s.stack === 15_000)).toBe(true);
      expect((await store.findUserById(player.id))!.chips).toBe(85_000);
      expect(await store.ledgerBalanceForUser(player.id)).toBe(-15_000);
    });

    it('refuses more than 4 bots, a buy-in outside the stakes, or more than the balance', async () => {
      const player = await googlePlayer(10_000);
      const open = (payload: object) => app.inject({ method: 'POST', url: '/tables/practice', headers: auth(player.token), payload });
      expect((await open({ bots: 5, stakes: 'low', buyIn: 5_000 })).statusCode).toBe(400);
      expect((await open({ bots: 0, stakes: 'low', buyIn: 5_000 })).statusCode).toBe(400);
      expect((await open({ bots: 1, stakes: 'low', buyIn: 50_000 })).json<{ code: string }>().code).toBe('BUY_IN_OUT_OF_RANGE');
      expect((await open({ bots: 1, stakes: 'medium', buyIn: 15_000 })).json<{ code: string }>().code).toBe('INSUFFICIENT_CHIPS');
      expect(registry.list()).toHaveLength(0);
    });

    it('allows one practice table at a time, pointing back to the open one', async () => {
      const player = await googlePlayer(100_000);
      const open = () => app.inject({ method: 'POST', url: '/tables/practice', headers: auth(player.token), payload: { bots: 1, stakes: 'low', buyIn: 5_000 } });
      const first = await open();
      const second = await open();
      expect(second.statusCode).toBe(409);
      expect(second.json<{ tableId: string }>().tableId).toBe(first.json<{ tableId: string }>().tableId);
    });

    it('refuses a guest', async () => {
      const guest = await store.createGuestUser('Gina');
      await store.adjustUserChips(guest.id, 100_000);
      const res = await app.inject({ method: 'POST', url: '/tables/practice', headers: auth(issueAccessToken(guest)), payload: { bots: 1, stakes: 'low', buyIn: 5_000 } });
      expect(res.statusCode).toBe(403);
    });

    it('GET /tables shows a Google player no public tables — only their own practice table to return to', async () => {
      await registry.createTable('Public', { ...SETTINGS_FOR_LIST }, null, null);
      const player = await googlePlayer(100_000);
      const empty = await app.inject({ method: 'GET', url: '/tables', headers: auth(player.token) });
      expect(empty.json()).toEqual({ tables: [], practiceTableId: null });
      const created = await app.inject({ method: 'POST', url: '/tables/practice', headers: auth(player.token), payload: { bots: 2, stakes: 'low', buyIn: 5_000 } });
      const mine = await app.inject({ method: 'GET', url: '/tables', headers: auth(player.token) });
      expect(mine.json()).toEqual({ tables: [], practiceTableId: created.json<{ tableId: string }>().tableId });
      // Nobody else ever sees it listed, or can look it up.
      const anonymous = await app.inject({ method: 'GET', url: '/tables' });
      expect(anonymous.json<{ tables: { name: string }[] }>().tables.map((t) => t.name)).toEqual(['Public']);
      const peek = await app.inject({ method: 'GET', url: `/tables/${created.json<{ tableId: string }>().tableId}` });
      expect(peek.statusCode).toBe(404);
    });

    it('deleting the account closes the practice table and deletes every record of it', async () => {
      const player = await googlePlayer(100_000);
      const created = await app.inject({ method: 'POST', url: '/tables/practice', headers: auth(player.token), payload: { bots: 1, stakes: 'low', buyIn: 5_000 } });
      const tableId = created.json<{ tableId: string }>().tableId;
      const res = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(player.token) });
      expect(res.statusCode).toBe(200);
      expect(registry.get(tableId)).toBeNull();
      expect(await store.getTable(tableId)).toBeNull();
    });
  });

  describe('DELETE /users/me', () => {
    it('refuses a guest (nothing durable to delete)', async () => {
      const guest = await store.createGuestUser('Gina');
      const res = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(issueAccessToken(guest)) });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('GUEST_ACCOUNT');
    });

    it('refuses the admin account', async () => {
      const admin = await store.createAccount('admin@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const res = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(issueAccessToken({ ...admin, role: 'admin' })) });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('CANNOT_DELETE_ADMIN');
    });

    it('permanently deletes a signed-in non-guest, non-admin account', async () => {
      const user = await store.createGoogleAccount({ googleId: 'g-2', email: 'b@gmail.com', displayName: 'Bob', avatarUrl: null });
      const res = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(issueAccessToken(user)) });
      expect(res.statusCode).toBe(200);
      expect(await store.findUserById(user.id)).toBeNull();
    });
  });

  describe('GET /users/me/profile', () => {
    it('shows only what the player registered with', async () => {
      const user = await store.createGoogleAccount({ googleId: 'g-3', email: 'c@gmail.com', displayName: 'Cara', avatarUrl: 'https://example.com/c.png' });
      const res = await app.inject({ method: 'GET', url: '/users/me/profile', headers: auth(issueAccessToken(user)) });
      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(['avatarUrl', 'createdAt', 'displayName', 'email', 'lastLoginAt', 'signInMethod']);
      expect(body).toMatchObject({ displayName: 'Cara', email: 'c@gmail.com', avatarUrl: 'https://example.com/c.png', signInMethod: 'google' });
    });
  });

  describe('admin user-management routes', () => {
    it('GET /admin/users lists everyone; requires the admin role', async () => {
      const admin = await store.createAccount('admin2@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const adminToken = issueAccessToken({ ...admin, role: 'admin' });
      const regular = await store.createGoogleAccount({ googleId: 'g-4', email: 'd@gmail.com', displayName: 'Dee', avatarUrl: null });

      const denied = await app.inject({ method: 'GET', url: '/admin/users', headers: auth(issueAccessToken(regular)) });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({ method: 'GET', url: '/admin/users', headers: auth(adminToken) });
      expect(allowed.statusCode).toBe(200);
      const ids = allowed.json<{ users: { id: string }[] }>().users.map((u) => u.id);
      expect(ids).toEqual(expect.arrayContaining([admin.id, regular.id]));
    });

    it('PATCH /admin/users/:id updates a display name', async () => {
      const admin = await store.createAccount('admin3@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const regular = await store.createGoogleAccount({ googleId: 'g-5', email: 'e@gmail.com', displayName: 'Eli', avatarUrl: null });

      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/users/${regular.id}`,
        headers: auth(issueAccessToken({ ...admin, role: 'admin' })),
        payload: { displayName: 'Elias' },
      });
      expect(res.statusCode).toBe(200);
      expect((await store.findUserById(regular.id))?.displayName).toBe('Elias');
    });

    it('DELETE /admin/users/:id removes a regular user but refuses to remove an admin', async () => {
      const admin = await store.createAccount('admin4@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const adminToken = issueAccessToken({ ...admin, role: 'admin' });
      const regular = await store.createGoogleAccount({ googleId: 'g-6', email: 'f@gmail.com', displayName: 'Fay', avatarUrl: null });

      const deletedRegular = await app.inject({ method: 'DELETE', url: `/admin/users/${regular.id}`, headers: auth(adminToken) });
      expect(deletedRegular.statusCode).toBe(200);
      expect(await store.findUserById(regular.id)).toBeNull();

      const deletedAdmin = await app.inject({ method: 'DELETE', url: `/admin/users/${admin.id}`, headers: auth(adminToken) });
      expect(deletedAdmin.statusCode).toBe(400);
      expect(deletedAdmin.json<{ code: string }>().code).toBe('CANNOT_DELETE_ADMIN');
      expect(await store.findUserById(admin.id)).not.toBeNull();
    });

    it('POST /admin/users/bulk-delete removes every selected regular user, silently skipping the admin id if it’s included', async () => {
      const admin = await store.createAccount('admin5@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const adminToken = issueAccessToken({ ...admin, role: 'admin' });
      const userA = await store.createGoogleAccount({ googleId: 'g-a', email: 'a2@gmail.com', displayName: 'A', avatarUrl: null });
      const userB = await store.createGoogleAccount({ googleId: 'g-b', email: 'b2@gmail.com', displayName: 'B', avatarUrl: null });

      const res = await app.inject({
        method: 'POST',
        url: '/admin/users/bulk-delete',
        headers: auth(adminToken),
        payload: { userIds: [userA.id, userB.id, admin.id] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ deleted: string[]; skipped: string[] }>();
      expect(body.deleted.sort()).toEqual([userA.id, userB.id].sort());
      expect(body.skipped).toEqual([admin.id]);
      expect(await store.findUserById(userA.id)).toBeNull();
      expect(await store.findUserById(userB.id)).toBeNull();
      expect(await store.findUserById(admin.id)).not.toBeNull();
    });
  });
  describe('admin balance changes', () => {
    async function owner(chips = 500_000): Promise<{ id: string; token: string }> {
      const admin = await store.createAccount('owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      await store.adjustUserChips(admin.id, chips);
      return { id: admin.id, token: issueAccessToken({ ...admin, role: 'admin' }) };
    }

    it('sets a balance to an exact amount, up or down, ledgered as the difference', async () => {
      const me = await owner(500_000);
      const up = await app.inject({ method: 'POST', url: '/admin/chips/set', headers: auth(me.token), payload: { userId: me.id, balance: 1_234_567, reason: 'Owner set balance' } });
      expect(up.statusCode).toBe(200);
      expect(up.json<{ chips: number }>().chips).toBe(1_234_567);
      expect((await store.findUserById(me.id))?.chips).toBe(1_234_567);

      const down = await app.inject({ method: 'POST', url: '/admin/chips/set', headers: auth(me.token), payload: { userId: me.id, balance: 0, reason: 'Owner set balance' } });
      expect(down.json<{ chips: number }>().chips).toBe(0);
      // Only the moves are ledgered (+734,567 then -1,234,567), and the books still balance against the house.
      expect(await store.ledgerBalanceForUser(me.id)).toBe(-500_000);
      expect((await store.ledgerConservationCheck()).balanced).toBe(true);
    });

    it('adds to a balance and returns the new total', async () => {
      const me = await owner(1_000);
      const res = await app.inject({ method: 'POST', url: '/admin/chips', headers: auth(me.token), payload: { userId: me.id, amount: 250_000, reason: 'Owner top-up' } });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ chips: number }>().chips).toBe(251_000);
    });

    it('refuses anything past $20,000,000 or below $0, leaving the balance untouched', async () => {
      const me = await owner(1_000);
      const tooBig = await app.inject({ method: 'POST', url: '/admin/chips/set', headers: auth(me.token), payload: { userId: me.id, balance: 2_000_000_001, reason: 'x' } });
      expect(tooBig.statusCode).toBe(400);
      const overflowAdd = await app.inject({ method: 'POST', url: '/admin/chips', headers: auth(me.token), payload: { userId: me.id, amount: 2_000_000_000, reason: 'x' } });
      expect(overflowAdd.json<{ code: string }>().code).toBe('BALANCE_OUT_OF_RANGE');
      const negative = await app.inject({ method: 'POST', url: '/admin/chips', headers: auth(me.token), payload: { userId: me.id, amount: -1_001, reason: 'x' } });
      expect(negative.json<{ code: string }>().code).toBe('BALANCE_OUT_OF_RANGE');
      expect((await store.findUserById(me.id))?.chips).toBe(1_000);
    });

    it('is owner-only', async () => {
      const user = await store.createGoogleAccount({ googleId: 'g-9', email: 'p@gmail.com', displayName: 'Pat', avatarUrl: null });
      const res = await app.inject({ method: 'POST', url: '/admin/chips/set', headers: auth(issueAccessToken(user)), payload: { userId: user.id, balance: 9_999_999, reason: 'x' } });
      expect(res.statusCode).toBe(403);
      expect((await store.findUserById(user.id))?.chips).toBe(0);
    });
  });
});

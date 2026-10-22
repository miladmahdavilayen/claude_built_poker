import cookie from '@fastify/cookie';
import { WAIVER_VERSION, type TableSettings } from '@pokerclause/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken } from '../src/auth/session.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import { TableRegistry } from '../src/game/tableRegistry.js';
import { registerAdminRoutes } from '../src/http/routes/admin.js';
import { registerAuthRoutes } from '../src/http/routes/auth.js';
import { loginOrRegisterWithGoogle, WELCOME_BONUS } from '../src/auth/authService.js';
import type { GoogleProfile } from '../src/auth/googleAuth.js';
import { inviteLockout, signupKeyLockout } from '../src/security/lockouts.js';
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
    registerAuthRoutes(app, store, (token) => registry.tableForInvite(token) !== null);
    signupKeyLockout.reset();
    inviteLockout.reset();
    // The real one (socketServer.ts) also refunds and notifies everyone at the table.
    const terminateTable = async (tableId: string): Promise<boolean> => {
      if (!registry.get(tableId)) return false;
      await registry.close(tableId);
      return true;
    };
    registerAdminRoutes(app, store, registry, closePracticeTableOf, terminateTable);
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
      await store.acceptWaiver(created.id, WAIVER_VERSION, 'PP');
      const user = await store.adjustUserChips(created.id, chips);
      return { id: user.id, token: issueAccessToken(user) };
    }

    it('a Google player can’t open a table until they agree to the waiver with their initials', async () => {
      const created = await store.createGoogleAccount({ googleId: 'g-w', email: 'w@gmail.com', displayName: 'Wade Wilson', avatarUrl: null });
      await store.adjustUserChips(created.id, 100_000);
      const token = issueAccessToken(created);
      const open = () => app.inject({ method: 'POST', url: '/tables/practice', headers: auth(token), payload: { bots: 1, stakes: 'low', buyIn: 5_000 } });
      const me = async () => (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })).json<{ user: { needsWaiver: boolean } }>().user;

      expect((await me()).needsWaiver).toBe(true);
      expect((await open()).json<{ code: string }>().code).toBe('WAIVER_REQUIRED');

      for (const initials of ['', 'J.D', '12', 'TOOLONG']) {
        const bad = await app.inject({ method: 'POST', url: '/users/me/waiver', headers: auth(token), payload: { initials } });
        expect(bad.statusCode).toBe(400);
      }
      const ok = await app.inject({ method: 'POST', url: '/users/me/waiver', headers: auth(token), payload: { initials: ' ww ' } });
      expect(ok.json<{ user: { needsWaiver: boolean } }>().user.needsWaiver).toBe(false);
      expect((await store.findUserById(created.id))!.waiver).toMatchObject({ version: WAIVER_VERSION, initials: 'WW' });
      expect((await me()).needsWaiver).toBe(false);
      expect((await open()).statusCode).toBe(201);
    });

    it('the owner and guests are never asked for the waiver', async () => {
      const admin = await store.createAccount('boss@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const guest = await store.createGuestUser('Gina');
      for (const u of [{ ...admin, role: 'admin' as const }, guest]) {
        const res = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(issueAccessToken(u)) });
        expect(res.json<{ user: { needsWaiver: boolean } }>().user.needsWaiver).toBe(false);
      }
    });

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

  describe('landing page: access keys and invitations', () => {
    async function adminToken(): Promise<string> {
      const admin = await store.createAccount(`owner${String(Date.now())}@x.com`, 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      return issueAccessToken({ ...admin, role: 'admin' });
    }

    it('the owner generates a one-time key (shown once, stored only as a hash), lists it, and can revoke it', async () => {
      const token = await adminToken();
      const created = await app.inject({ method: 'POST', url: '/admin/signup-keys', headers: auth(token), payload: { label: 'Dave', email: 'Dave@Gmail.com', expiresInDays: 3 } });
      expect(created.statusCode).toBe(201);
      const { key, id } = created.json<{ key: string; id: string }>();
      expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);

      const listed = (await app.inject({ method: 'GET', url: '/admin/signup-keys', headers: auth(token) })).json<{ keys: Record<string, unknown>[] }>().keys;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id, label: 'Dave', email: 'dave@gmail.com', status: 'active', hint: key.slice(-4) });
      expect(JSON.stringify(listed)).not.toContain(key.replaceAll('-', ''));

      const check = (k: string) => app.inject({ method: 'POST', url: '/auth/signup-key', payload: { key: k } });
      expect((await check(key)).statusCode).toBe(200);
      expect((await check(key)).statusCode).toBe(200); // checking doesn't use it up

      expect((await app.inject({ method: 'DELETE', url: `/admin/signup-keys/${id}`, headers: auth(token) })).statusCode).toBe(200);
      expect((await check(key)).json<{ code: string }>().code).toBe('INVALID_SIGNUP_KEY');
      const after = (await app.inject({ method: 'GET', url: '/admin/signup-keys', headers: auth(token) })).json<{ keys: { status: string }[] }>().keys;
      expect(after[0]!.status).toBe('revoked');
    });

    it('only the owner can generate or list keys', async () => {
      const player = await store.createGoogleAccount({ googleId: 'g-np', email: 'np@gmail.com', displayName: 'Nope', avatarUrl: null });
      expect((await app.inject({ method: 'POST', url: '/admin/signup-keys', headers: auth(issueAccessToken(player)), payload: { label: 'x' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/admin/signup-keys' })).statusCode).toBe(403);
    });

    it('five wrong keys from one address lock it out — even the right key — for a while', async () => {
      const token = await adminToken();
      const { key } = (await app.inject({ method: 'POST', url: '/admin/signup-keys', headers: auth(token), payload: { label: 'Eve' } })).json<{ key: string }>();
      const check = (k: string) => app.inject({ method: 'POST', url: '/auth/signup-key', payload: { key: k } });
      for (let i = 0; i < 5; i++) expect((await check('AAAAA-AAAAA-AAAAA-AAAAA')).statusCode).toBe(403);
      const locked = await check(key);
      expect(locked.statusCode).toBe(429);
      expect(locked.json<{ code: string }>().code).toBe('TOO_MANY_ATTEMPTS');
      expect((await check('x'.repeat(65))).statusCode).toBe(429);
    });

    it('a guest session needs a live invite — no invite, no session', async () => {
      const table = await registry.createTable('Real', { ...SETTINGS_FOR_LIST }, null, null);
      const created = table.createSeatAssignment(1, 10_000);
      if (!created.ok) throw new Error('unreachable');
      const guest = (inviteToken: string) => app.inject({ method: 'POST', url: '/auth/guest', payload: { displayName: 'Gus', inviteToken } });
      expect((await app.inject({ method: 'POST', url: '/auth/guest', payload: { displayName: 'Gus' } })).statusCode).toBe(400);
      expect((await guest('00000000-0000-4000-8000-000000000000')).json<{ code: string }>().code).toBe('INVALID_ASSIGNMENT');
      const ok = await guest(created.token);
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ user: { isGuest: boolean } }>().user.isGuest).toBe(true);
    });

    it('GET /invites/:token finds the table an unused invite belongs to, and nothing once it is used', async () => {
      const table = await registry.createTable('Real', { ...SETTINGS_FOR_LIST }, null, null);
      const created = table.createSeatAssignment(1, 10_000);
      if (!created.ok) throw new Error('unreachable');
      const found = await app.inject({ method: 'GET', url: `/invites/${created.token}` });
      expect(found.json()).toEqual({ tableId: table.tableId });
      table.redeemSeatAssignment(created.token);
      expect((await app.inject({ method: 'GET', url: `/invites/${created.token}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/invites/not-a-token' })).statusCode).toBe(404);
    });

    it('ten invite codes that match nothing lock the address out', async () => {
      for (let i = 0; i < 10; i++) expect((await app.inject({ method: 'GET', url: `/invites/miss-${String(i)}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/invites/miss-again' })).statusCode).toBe(429);
    });
  });

  describe('deleting an account keeps its balance for when the player comes back', () => {
    const profile = (n: string): GoogleProfile => ({ googleId: `g-del-${n}`, email: `del.${n}@gmail.com`, emailVerified: true, displayName: 'Del', avatarUrl: null });
    const register = async (n: string): Promise<{ id: string; token: string; chips: number }> => {
      const r = await loginOrRegisterWithGoogle(store, profile(n), 'open');
      return { id: r.user.id, token: r.accessToken, chips: r.user.chips };
    };
    const deleteMe = (token: string) => app.inject({ method: 'DELETE', url: '/users/me', headers: auth(token) });

    it('never played: deleting and registering again gives back the full $1,000 — not a second bonus', async () => {
      const first = await register('a');
      expect(first.chips).toBe(WELCOME_BONUS);
      expect((await deleteMe(first.token)).statusCode).toBe(200);
      const again = await register('a');
      expect(again.id).not.toBe(first.id);
      expect(again.chips).toBe(WELCOME_BONUS);
      const [entry] = await store.ledgerEntriesForUser(again.id, 10);
      expect(entry).toMatchObject({ reason: 'balance_restored', amount: WELCOME_BONUS });
      // Kept once, handed back once: delete with $0, come back with $0.
      await store.adjustUserChips(again.id, -WELCOME_BONUS);
      await deleteMe(again.token);
      expect((await register('a')).chips).toBe(0);
    });

    it('lost $400 at the tables: comes back with $600 — what they actually had', async () => {
      const first = await register('b');
      await store.adjustUserChips(first.id, -40_000);
      await deleteMe(first.token);
      expect((await register('b')).chips).toBe(60_000);
    });

    it('chips sitting on an open practice table come back too', async () => {
      const first = await register('c');
      await store.acceptWaiver(first.id, WAIVER_VERSION, 'DC');
      const opened = await app.inject({ method: 'POST', url: '/tables/practice', headers: auth(first.token), payload: { bots: 1, stakes: 'low', buyIn: 10_000 } });
      expect(opened.statusCode).toBe(201);
      // The real closePracticeTableOf refunds the stack first; this test harness's stand-in doesn't, so refund it by hand.
      await store.adjustUserChips(first.id, 10_000);
      await deleteMe(first.token);
      expect((await register('c')).chips).toBe(WELCOME_BONUS);
    });
  });

  describe('tables: deleting from the lobby, and surviving a restart', () => {
    it('the owner deletes a table (DELETE /admin/tables/:id): gone from the lobby and closed for good; nobody else can', async () => {
      const table = await registry.createTable('Doomed', { ...SETTINGS_FOR_LIST }, null, null);
      const player = await store.createGoogleAccount({ googleId: 'g-tbl', email: 'tbl@gmail.com', displayName: 'P', avatarUrl: null });
      expect((await app.inject({ method: 'DELETE', url: `/admin/tables/${table.tableId}`, headers: auth(issueAccessToken(player)) })).statusCode).toBe(403);
      expect(registry.get(table.tableId)).not.toBeNull();

      const admin = await store.createAccount('tbl-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const token = issueAccessToken({ ...admin, role: 'admin' });
      expect((await app.inject({ method: 'DELETE', url: `/admin/tables/${table.tableId}`, headers: auth(token) })).statusCode).toBe(200);
      expect(registry.get(table.tableId)).toBeNull();
      expect((await store.getTable(table.tableId))?.status).toBe('closed');
      expect((await store.listTables()).map((t) => t.id)).not.toContain(table.tableId);
      expect((await app.inject({ method: 'GET', url: '/tables' })).json<{ tables: { tableId: string }[] }>().tables.map((t) => t.tableId)).not.toContain(table.tableId);
      expect((await app.inject({ method: 'DELETE', url: `/admin/tables/${table.tableId}`, headers: auth(token) })).statusCode).toBe(404);
    });

    it('a shutdown keeps a table open on record, and the next boot restores it as it was', async () => {
      const table = await registry.createTable('Keeper', { ...SETTINGS_FOR_LIST, maxSeats: 4 }, 'owner-id', 'code123');
      await registry.close(table.tableId, true);
      expect(registry.get(table.tableId)).toBeNull();
      const [record] = await store.listTables();
      expect(record?.id).toBe(table.tableId);

      const restored = registry.restore(record!);
      expect(restored.tableId).toBe(table.tableId);
      expect(restored.name).toBe('Keeper');
      expect(restored.settings.maxSeats).toBe(4);
      expect(restored.inviteCode).toBe('code123');
      expect(restored.ownerId).toBe('owner-id');
      expect(restored.seats.every((s) => s.userId === null)).toBe(true);
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

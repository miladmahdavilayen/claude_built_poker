import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken } from '../src/auth/session.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import { TableRegistry } from '../src/game/tableRegistry.js';
import { registerAdminRoutes } from '../src/http/routes/admin.js';
import { registerTableRoutes } from '../src/http/routes/tables.js';
import { registerUserRoutes } from '../src/http/routes/users.js';

process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

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
    registerUserRoutes(app, store);
    registerAdminRoutes(app, store, registry);
  });

  afterEach(async () => {
    await app.close();
  });

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  describe('POST /tables', () => {
    it('rejects a guest — they would have nothing they could actually do with it', async () => {
      const guest = await store.createGuestUser('Gina');
      const res = await app.inject({
        method: 'POST',
        url: '/tables',
        headers: auth(issueAccessToken(guest)),
        payload: { name: 'Guest Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('GUEST_CANNOT_CREATE_TABLE');
    });

    it('allows a signed-in non-guest human, recording them as the table’s creator', async () => {
      const user = await store.createGoogleAccount('g-1', 'a@gmail.com', 'Ann');
      const res = await app.inject({
        method: 'POST',
        url: '/tables',
        headers: auth(issueAccessToken(user)),
        payload: { name: 'Ann’s Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false },
      });
      expect(res.statusCode).toBe(201);
      const table = registry.get(res.json<{ tableId: string }>().tableId);
      expect(table?.ownerId).toBe(user.id);
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
      const user = await store.createGoogleAccount('g-2', 'b@gmail.com', 'Bob');
      const res = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(issueAccessToken(user)) });
      expect(res.statusCode).toBe(200);
      expect(await store.findUserById(user.id)).toBeNull();
    });
  });

  describe('GET /users/me/summary', () => {
    it("reports balance and net play result separately from raw ledger noise like admin grants", async () => {
      const user = await store.createGoogleAccount('g-3', 'c@gmail.com', 'Cara');
      await store.adjustUserChips(user.id, 500);
      await store.recordLedgerEntries([
        { userId: user.id, isHouse: false, amount: 500, reason: 'admin_adjust' },
        { userId: null, isHouse: true, amount: -500, reason: 'admin_adjust' },
      ]);
      await store.recordLedgerEntries([
        { userId: user.id, isHouse: false, amount: 120, reason: 'pot_win' },
        { userId: null, isHouse: true, amount: -120, reason: 'pot_win' },
      ]);
      await store.adjustUserChips(user.id, 120);

      const res = await app.inject({ method: 'GET', url: '/users/me/summary', headers: auth(issueAccessToken(user)) });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ balance: number; netPlayResult: number; recentEntries: unknown[] }>();
      expect(body.balance).toBe(620);
      expect(body.netPlayResult).toBe(120);
      expect(body.recentEntries).toHaveLength(2);
    });
  });

  describe('admin user-management routes', () => {
    it('GET /admin/users lists everyone; requires the admin role', async () => {
      const admin = await store.createAccount('admin2@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const adminToken = issueAccessToken({ ...admin, role: 'admin' });
      const regular = await store.createGoogleAccount('g-4', 'd@gmail.com', 'Dee');

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
      const regular = await store.createGoogleAccount('g-5', 'e@gmail.com', 'Eli');

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
      const regular = await store.createGoogleAccount('g-6', 'f@gmail.com', 'Fay');

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
      const userA = await store.createGoogleAccount('g-a', 'a2@gmail.com', 'A');
      const userB = await store.createGoogleAccount('g-b', 'b2@gmail.com', 'B');

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
});

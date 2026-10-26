import { createHash } from 'node:crypto';
import cookie from '@fastify/cookie';
import { GUEST_TERMS_VERSION, WAIVER_VERSION, type TableSettings, type UpdateTableSettingsIntent } from '@pokerclause/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken } from '../src/auth/session.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import type { LiveTable } from '../src/game/liveTable.js';
import { TableRegistry } from '../src/game/tableRegistry.js';
import { registerAdminRoutes } from '../src/http/routes/admin.js';
import { registerAuthRoutes } from '../src/http/routes/auth.js';
import { loginOrRegisterWithGoogle, WELCOME_BONUS } from '../src/auth/authService.js';
import type { GoogleProfile } from '../src/auth/googleAuth.js';
import { inviteLockout, signupKeyLockout } from '../src/security/lockouts.js';
import { signaturePngDataUrl } from './pngFixture.js';
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
    registerAuthRoutes(app, store, (token) => registry.describeInvite(token));
    signupKeyLockout.reset();
    inviteLockout.reset();
    // The real one (socketServer.ts) also refunds and notifies everyone at the table.
    const terminateTable = async (tableId: string): Promise<boolean> => {
      if (!registry.get(tableId)) return false;
      await registry.close(tableId);
      return true;
    };
    // The real one (socketServer.ts) also broadcasts to everyone at the table.
    const updateTableSettings = (tableId: string, patch: UpdateTableSettingsIntent): ReturnType<LiveTable['updateSettings']> | null => {
      const table = registry.get(tableId);
      if (!table || table.isPractice) return null;
      const result = table.updateSettings(patch);
      if (result.ok) void store.updateTable(table.tableId, { name: table.name, config: table.targetSettings as unknown as Record<string, unknown>, inviteCode: table.inviteCode });
      return result;
    };
    registerAdminRoutes(app, store, registry, closePracticeTableOf, terminateTable, updateTableSettings);
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

    it('a Google player can’t open a table until they sign the waiver: initials, a real signature, the current version', async () => {
      const created = await store.createGoogleAccount({ googleId: 'g-w', email: 'w@gmail.com', displayName: 'Wade Wilson', avatarUrl: null });
      await store.adjustUserChips(created.id, 100_000);
      const token = issueAccessToken(created);
      const open = () => app.inject({ method: 'POST', url: '/tables/practice', headers: auth(token), payload: { bots: 1, stakes: 'low', buyIn: 5_000 } });
      const me = async () => (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })).json<{ user: { needsWaiver: boolean } }>().user;
      const sign = (payload: object) => app.inject({ method: 'POST', url: '/users/me/waiver', headers: auth(token), payload });
      const good = { initials: ' ww ', signature: signaturePngDataUrl(), version: WAIVER_VERSION, device: { platform: 'MacIntel', screen: '1440x900', touch: false } };

      expect((await me()).needsWaiver).toBe(true);
      expect((await open()).json<{ code: string }>().code).toBe('WAIVER_REQUIRED');

      for (const initials of ['', 'J.D', '12', 'TOOLONG']) expect((await sign({ ...good, initials })).statusCode).toBe(400);
      expect((await sign({ initials: 'WW', version: WAIVER_VERSION, device: {} })).statusCode).toBe(400);
      expect((await sign({ ...good, signature: 'data:image/png;base64,AAAA' })).json<{ code: string }>().code).toBe('INVALID_SIGNATURE');
      expect((await sign({ ...good, version: WAIVER_VERSION - 1 })).json<{ code: string }>().code).toBe('WAIVER_OUTDATED');
      expect(await store.listSignedWaivers()).toHaveLength(0);

      const ok = await sign(good);
      expect(ok.json<{ user: { needsWaiver: boolean } }>().user.needsWaiver).toBe(false);
      expect((await store.findUserById(created.id))!.waiver).toMatchObject({ version: WAIVER_VERSION, initials: 'WW' });
      expect((await me()).needsWaiver).toBe(false);
      expect((await open()).statusCode).toBe(201);

      // The signed copy: a real PDF whose fingerprint the record holds.
      const [summary] = await store.listSignedWaivers();
      const filed = (await store.getSignedWaiver(summary!.id))!;
      const pdf = Buffer.from(filed.pdf, 'base64');
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(createHash('sha256').update(pdf).digest('hex')).toBe(filed.pdfSha256);
      expect(filed.record).toMatchObject({ initials: 'WW', pdfSha256: filed.pdfSha256, signer: { email: 'w@gmail.com' }, deviceReportedByBrowser: { platform: 'MacIntel' } });
      expect(filed.ipAddress).toBe('127.0.0.1');
      expect(filed.version).toBe(WAIVER_VERSION);
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

    it('a used key moves under the player it registered — its name kept on their account — and stays there after they delete it', async () => {
      const token = await adminToken();
      const { key, id } = (await app.inject({ method: 'POST', url: '/admin/signup-keys', headers: auth(token), payload: { label: 'Dave from work' } })).json<{ key: string; id: string }>();
      const r = await loginOrRegisterWithGoogle(store, { googleId: 'g-dave', email: 'dave.w@gmail.com', emailVerified: true, displayName: 'David Walker', avatarUrl: null }, { signupKey: key });
      expect((await store.findUserById(r.user.id))?.accessKeyLabel).toBe('Dave from work');

      const keys = (await app.inject({ method: 'GET', url: '/admin/signup-keys', headers: auth(token) })).json<{ keys: { id: string }[] }>().keys;
      expect(keys.map((k) => k.id)).not.toContain(id);
      const users = (await app.inject({ method: 'GET', url: '/admin/users', headers: auth(token) })).json<{ users: { id: string; accessKeyLabel: string | null }[] }>().users;
      expect(users.find((u) => u.id === r.user.id)?.accessKeyLabel).toBe('Dave from work');
      const detail = (await app.inject({ method: 'GET', url: `/admin/users/${r.user.id}`, headers: auth(token) })).json<{ accessKey: Record<string, unknown> }>();
      expect(detail.accessKey).toMatchObject({ id, label: 'Dave from work', hint: key.slice(-4) });

      expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(r.accessToken) })).statusCode).toBe(200);
      const gone = (await app.inject({ method: 'GET', url: `/admin/deleted-users/${r.user.id}`, headers: auth(token) })).json<Record<string, unknown>>();
      expect(gone).toMatchObject({ displayName: 'David Walker', email: 'dave.w@gmail.com', accessKeyLabel: 'Dave from work', accessKey: { id, label: 'Dave from work' }, deletedBy: 'self' });
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
      const guest = (inviteToken: string) =>
        app.inject({ method: 'POST', url: '/auth/guest', payload: { displayName: 'Gus', inviteToken, acceptTerms: true, termsVersion: GUEST_TERMS_VERSION } });
      expect((await app.inject({ method: 'POST', url: '/auth/guest', payload: { displayName: 'Gus', acceptTerms: true, termsVersion: GUEST_TERMS_VERSION } })).statusCode).toBe(400);
      expect((await guest('00000000-0000-4000-8000-000000000000')).json<{ code: string }>().code).toBe('INVALID_ASSIGNMENT');
      const ok = await guest(created.token);
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ user: { isGuest: boolean } }>().user.isGuest).toBe(true);
    });

    it('a guest must tick "I agree" to the guest terms — and the agreement is kept on their record, with the name the owner gave the invite', async () => {
      const table = await registry.createTable('Friday Game', { ...SETTINGS_FOR_LIST }, null, null);
      const created = table.createSeatAssignment(1, 10_000, 'Cousin Vinny');
      if (!created.ok) throw new Error('unreachable');
      const signUp = (extra: Record<string, unknown>) =>
        app.inject({ method: 'POST', url: '/auth/guest', headers: { 'user-agent': 'Mozilla/5.0 (Android) GuestBrowser' }, payload: { displayName: 'Vin', inviteToken: created.token, ...extra } });
      const unticked = await signUp({ acceptTerms: false, termsVersion: GUEST_TERMS_VERSION });
      expect(unticked.statusCode).toBe(400);
      expect(unticked.json<{ code: string }>().code).toBe('TERMS_REQUIRED');
      expect((await signUp({ termsVersion: GUEST_TERMS_VERSION })).json<{ code: string }>().code).toBe('TERMS_REQUIRED');
      expect((await signUp({ acceptTerms: true, termsVersion: GUEST_TERMS_VERSION + 1 })).json<{ code: string }>().code).toBe('TERMS_CHANGED');
      expect(await store.listGuestPlayers()).toEqual([]);

      const ok = await signUp({ acceptTerms: true, termsVersion: GUEST_TERMS_VERSION });
      expect(ok.statusCode).toBe(200);
      const guestId = ok.json<{ user: { id: string } }>().user.id;

      const admin = await store.createAccount('guest-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const ownerAuth = auth(issueAccessToken({ ...admin, role: 'admin' }));
      expect((await app.inject({ method: 'GET', url: '/admin/guests', headers: auth(ok.json<{ accessToken: string }>().accessToken) })).statusCode).toBe(403);
      const listed = (await app.inject({ method: 'GET', url: '/admin/guests', headers: ownerAuth })).json<{ guests: Record<string, unknown>[] }>().guests;
      expect(listed).toEqual([
        expect.objectContaining({
          id: guestId,
          displayName: 'Vin',
          adminNickname: 'Cousin Vinny',
          inviteKind: 'seat-invite',
          tableId: table.tableId,
          tableName: 'Friday Game',
          userAgent: 'Mozilla/5.0 (Android) GuestBrowser',
          termsVersion: GUEST_TERMS_VERSION,
        }),
      ]);
      expect(listed[0]!.ipAddress).toBeTruthy();
      expect(Date.parse(listed[0]!.termsAcceptedAt as string)).toBeGreaterThan(Date.now() - 60_000);
      const detail = await app.inject({ method: 'GET', url: `/admin/guests/${guestId}`, headers: ownerAuth });
      expect(detail.json()).toMatchObject({ id: guestId, adminNickname: 'Cousin Vinny', games: [] });
      expect((await app.inject({ method: 'GET', url: '/admin/guests/00000000-0000-4000-8000-000000000000', headers: ownerAuth })).statusCode).toBe(404);
    });

    it('GET /invites/:token finds the table an invite belongs to — used or not — for as long as the table is open', async () => {
      const table = await registry.createTable('Real', { ...SETTINGS_FOR_LIST }, null, null);
      const created = table.createSeatAssignment(1, 10_000);
      if (!created.ok) throw new Error('unreachable');
      const found = await app.inject({ method: 'GET', url: `/invites/${created.token}` });
      expect(found.json()).toEqual({ tableId: table.tableId });
      table.redeemSeatAssignment(created.token, 'guest-1');
      expect((await app.inject({ method: 'GET', url: `/invites/${created.token}` })).json()).toEqual({ tableId: table.tableId });
      expect((await app.inject({ method: 'GET', url: '/invites/not-a-token' })).statusCode).toBe(404);
      await registry.close(table.tableId);
      expect((await app.inject({ method: 'GET', url: `/invites/${created.token}` })).statusCode).toBe(404);
    });

    it('a seat invite belongs to the guest who used it: the same link brings them back — the same guest, even after their session is gone — and no one else', async () => {
      const table = await registry.createTable('Comeback', { ...SETTINGS_FOR_LIST }, null, null);
      const created = table.createSeatAssignment(1, 10_000, 'Cousin Vinny');
      if (!created.ok) throw new Error('unreachable');
      const signIn = (name: string) =>
        app.inject({ method: 'POST', url: '/auth/guest', payload: { displayName: name, inviteToken: created.token, acceptTerms: true, termsVersion: GUEST_TERMS_VERSION } });

      const first = (await signIn('Vin')).json<{ user: { id: string } }>().user;
      expect(table.redeemSeatAssignment(created.token, first.id)).toMatchObject({ ok: true, seatId: 1, returning: false });
      // Someone else (any other account) can't use it now.
      expect(table.redeemSeatAssignment(created.token, 'someone-else')).toMatchObject({ ok: false, code: 'INVITE_TAKEN' });
      // Back by the same link: the same guest, seated again.
      const again = (await signIn('Vin again')).json<{ user: { id: string; displayName: string } }>().user;
      expect(again).toMatchObject({ id: first.id, displayName: 'Vin' });
      expect(table.redeemSeatAssignment(created.token, first.id)).toMatchObject({ ok: true, seatId: 1, returning: true });
      // Their session gone (a restart clears guests from memory): the link re-creates them under the same id.
      await store.deleteUser(first.id);
      const recreated = (await signIn('Vin')).json<{ user: { id: string } }>().user;
      expect(recreated.id).toBe(first.id);
      // One guest record throughout.
      expect((await store.listGuestPlayers()).filter((g) => g.id === first.id)).toHaveLength(1);
    });

    it('an open-invite guest comes back by the link as the same guest — by the key their browser keeps — even once their session is gone', async () => {
      const table = await registry.createTable('Open Return', { ...SETTINGS_FOR_LIST, isPrivate: true, openSeating: true, openSeatStack: 50_000 }, null, 'open-return-code1');
      const signIn = (name: string, guestKey?: string) =>
        app.inject({
          method: 'POST',
          url: '/auth/guest',
          payload: { displayName: name, inviteToken: 'open-return-code1', acceptTerms: true, termsVersion: GUEST_TERMS_VERSION, ...(guestKey ? { guestKey } : {}) },
        });
      const key = 'k'.repeat(32);
      const first = (await signIn('Gary', key)).json<{ user: { id: string } }>().user;
      expect((await signIn('Gary again', key)).json<{ user: { id: string } }>().user.id).toBe(first.id);
      // A restart clears guests from memory: same key, same guest — and name.
      await store.deleteUser(first.id);
      const back = (await signIn('Someone', key)).json<{ user: { id: string; displayName: string } }>().user;
      expect(back).toMatchObject({ id: first.id, displayName: 'Gary' });
      // Another browser (another key, or none) is another guest.
      expect((await signIn('Gina', 'z'.repeat(32))).json<{ user: { id: string } }>().user.id).not.toBe(first.id);
      expect((await signIn('Nokey')).json<{ user: { id: string } }>().user.id).not.toBe(first.id);
      // The key's hash never reaches the dashboard.
      const admin = await store.createAccount('keyhash-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const listed = await app.inject({ method: 'GET', url: '/admin/guests', headers: auth(issueAccessToken({ ...admin, role: 'admin' })) });
      expect(listed.body).not.toContain('guestKeyHash');
      expect(table.settings.openSeatStack).toBe(50_000);
    });

    it('a used invite outlives a restart and a seat change; an unused one is voided by a reset', async () => {
      const table = await registry.createTable('Survivor', { ...SETTINGS_FOR_LIST }, null, null);
      const used = table.createSeatAssignment(1, 10_000);
      const unused = table.createSeatAssignment(2, 10_000);
      if (!used.ok || !unused.ok) throw new Error('unreachable');
      table.redeemSeatAssignment(used.token, 'guest-s');
      await new Promise((r) => setTimeout(r, 10)); // persisted in the background

      // A restart: the table comes back with its invites.
      await registry.close(table.tableId, true);
      const [record] = (await store.listTables()).filter((t) => t.id === table.tableId);
      const restored = registry.restore(record!);
      restored.loadSeatInvites(await store.listSeatInvites(record!.id));
      expect(restored.seatAssignmentGuest(used.token)).toBe('guest-s');
      expect(restored.hasSeatAssignment(unused.token)).toBe(true);

      // Their seat taken meanwhile: the link seats them somewhere free instead.
      restored.takeSeat(1, 'someone', { displayName: 'S', isGuest: false, avatarSeed: 'a', clientSeed: 'b' }, 10_000);
      const back = restored.redeemSeatAssignment(used.token, 'guest-s');
      expect(back.ok && back.seatId !== 1).toBe(true);

      // A reset voids unused invites — for good — but not a guest's own.
      restored.resetTable();
      await new Promise((r) => setTimeout(r, 10));
      expect(restored.hasSeatAssignment(unused.token)).toBe(false);
      expect(restored.hasSeatAssignment(used.token)).toBe(true);
      expect((await store.listSeatInvites(record!.id)).map((i) => i.guestUserId)).toEqual(['guest-s']);
    });

    it('an open-invite table: private, a long shareable code that finds the table, and lets a guest in', async () => {
      const admin = await store.createAccount('open-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const created = await app.inject({
        method: 'POST',
        url: '/tables',
        headers: auth(issueAccessToken({ ...admin, role: 'admin' })),
        payload: { name: 'Friday Night', smallBlind: 100, bigBlind: 200, maxSeats: 9, isPrivate: false, openSeating: true },
      });
      expect(created.statusCode).toBe(201);
      const { tableId, inviteCode } = created.json<{ tableId: string; inviteCode: string }>();
      expect(inviteCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
      const table = registry.get(tableId)!;
      expect(table.openSeating).toBe(true);
      expect(table.settings.isPrivate).toBe(true);
      expect((await app.inject({ method: 'GET', url: '/tables' })).json<{ tables: unknown[] }>().tables).toHaveLength(0);

      expect((await app.inject({ method: 'GET', url: `/invites/${inviteCode}` })).json()).toEqual({ tableId, code: inviteCode });
      const guest = await app.inject({ method: 'POST', url: '/auth/guest', payload: { displayName: 'Group Chat Gary', inviteToken: inviteCode, acceptTerms: true, termsVersion: GUEST_TERMS_VERSION } });
      expect(guest.statusCode).toBe(200);
      expect(await store.listGuestPlayers()).toEqual([expect.objectContaining({ displayName: 'Group Chat Gary', inviteKind: 'open-link', adminNickname: null, tableId })]);
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

    it('a deleted account is kept, whole, for the owner — and never stops the same person registering again', async () => {
      const first = await register('k');
      await store.acceptWaiver(first.id, WAIVER_VERSION, 'DK');
      await store.adjustUserChips(first.id, -25_000);
      await store.recordLedgerEntries([
        { userId: first.id, isHouse: false, amount: -25_000, reason: 'admin_adjust' },
        { userId: null, isHouse: true, amount: 25_000, reason: 'admin_adjust' },
      ]);
      expect((await deleteMe(first.token)).statusCode).toBe(200);

      const admin = await store.createAccount('del-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const ownerAuth = auth(issueAccessToken({ ...admin, role: 'admin' }));
      const listed = (await app.inject({ method: 'GET', url: '/admin/deleted-users', headers: ownerAuth })).json<{ users: Record<string, unknown>[] }>().users;
      expect(listed).toEqual([expect.objectContaining({ id: first.id, email: 'del.k@gmail.com', balance: WELCOME_BONUS - 25_000, deletedBy: 'self' })]);
      const detail = (await app.inject({ method: 'GET', url: `/admin/deleted-users/${first.id}`, headers: ownerAuth })).json<{ waiver: unknown; ledger: { reason: string; amount: number }[] }>();
      expect(detail.waiver).toMatchObject({ version: WAIVER_VERSION, initials: 'DK' });
      expect(detail.ledger.map((e) => [e.reason, e.amount])).toEqual(expect.arrayContaining([['welcome_bonus', WELCOME_BONUS], ['admin_adjust', -25_000]]));

      // Same person, back again: a normal new account, with what they left with — not a second bonus.
      const again = await register('k');
      expect(again.id).not.toBe(first.id);
      expect(again.chips).toBe(WELCOME_BONUS - 25_000);
      const users = (await app.inject({ method: 'GET', url: '/admin/users', headers: ownerAuth })).json<{ users: { id: string }[] }>().users;
      expect(users.map((u) => u.id)).toContain(again.id);
      expect(users.map((u) => u.id)).not.toContain(first.id);
      expect((await app.inject({ method: 'GET', url: '/admin/deleted-users', headers: auth(again.token) })).statusCode).toBe(403);

      // Deleted again — by the owner this time: both deletions are kept.
      expect((await app.inject({ method: 'DELETE', url: `/admin/users/${again.id}`, headers: ownerAuth })).statusCode).toBe(200);
      const both = (await app.inject({ method: 'GET', url: '/admin/deleted-users', headers: ownerAuth })).json<{ users: { id: string; deletedBy: string }[] }>().users;
      expect(both.map((u) => [u.id, u.deletedBy])).toEqual(
        expect.arrayContaining([
          [again.id, 'admin'],
          [first.id, 'self'],
        ]),
      );
      expect(both).toHaveLength(2);
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
    it('the owner’s lobby lists private and open-invite tables too (marked) — nobody else’s does', async () => {
      await registry.createTable('Public Game', { ...SETTINGS_FOR_LIST }, null, null);
      await registry.createTable('Homegame', { ...SETTINGS_FOR_LIST, isPrivate: true }, null, 'private-code-1');
      await registry.createTable('Group Chat', { ...SETTINGS_FOR_LIST, isPrivate: true, openSeating: true }, null, 'open-code-12345');
      const admin = await store.createAccount('lobby-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const list = async (headers: Record<string, string>) =>
        (await app.inject({ method: 'GET', url: '/tables', headers })).json<{ tables: { name: string; isPrivate: boolean; openSeating: boolean }[] }>().tables;

      const owners = await list(auth(issueAccessToken({ ...admin, role: 'admin' })));
      expect(owners.map((t) => [t.name, t.isPrivate, t.openSeating]).sort()).toEqual([
        ['Group Chat', true, true],
        ['Homegame', true, false],
        ['Public Game', false, false],
      ]);
      expect((await list({})).map((t) => t.name)).toEqual(['Public Game']);
      const guest = await store.createGuestUser('G');
      expect((await list(auth(issueAccessToken(guest)))).map((t) => t.name)).toEqual(['Public Game']);
    });

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

    it('the owner edits any table’s settings from the lobby (GET/PATCH /admin/tables/:id/settings), private ones too; nobody else can', async () => {
      const pub = await registry.createTable('Public', { ...SETTINGS_FOR_LIST }, null, null);
      const priv = await registry.createTable('Hidden', { ...SETTINGS_FOR_LIST, isPrivate: true }, null, 'code1234');
      const player = await store.createGoogleAccount({ googleId: 'g-set', email: 'set@gmail.com', displayName: 'P', avatarUrl: null });
      const playerAuth = auth(issueAccessToken(player));
      expect((await app.inject({ method: 'GET', url: `/admin/tables/${pub.tableId}/settings`, headers: playerAuth })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: `/admin/tables/${pub.tableId}/settings`, headers: playerAuth, payload: { name: 'Mine' } })).statusCode).toBe(403);

      const admin = await store.createAccount('set-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const headers = auth(issueAccessToken({ ...admin, role: 'admin' }));
      const got = await app.inject({ method: 'GET', url: `/admin/tables/${priv.tableId}/settings`, headers });
      expect(got.statusCode).toBe(200);
      expect(got.json<{ name: string; settings: { isPrivate: boolean }; inHand: boolean }>()).toMatchObject({ name: 'Hidden', settings: { isPrivate: true }, inHand: false });
      // A private table's invite code comes with it (for the link to share); a public one has none.
      expect(got.json<{ inviteCode: string | null }>().inviteCode).toBe('code1234');
      expect((await app.inject({ method: 'GET', url: `/admin/tables/${pub.tableId}/settings`, headers })).json<{ inviteCode: string | null }>().inviteCode).toBeNull();

      const saved = await app.inject({
        method: 'PATCH',
        url: `/admin/tables/${priv.tableId}/settings`,
        headers,
        payload: { name: 'Renamed', smallBlind: 5, bigBlind: 10, minBuyIn: 400, maxBuyIn: 2000, actionSeconds: 45, isPrivate: false },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json<{ deferred: boolean; inviteCode: string | null }>()).toMatchObject({ deferred: false, inviteCode: null });
      expect(priv.name).toBe('Renamed');
      expect(priv.settings).toMatchObject({ smallBlind: 5, bigBlind: 10, minBuyIn: 400, maxBuyIn: 2000, actionSeconds: 45, isPrivate: false });
      // Saved for a restart, and the lobby lists it under its new name.
      const record = (await store.listTables()).find((t) => t.id === priv.tableId);
      expect(record?.name).toBe('Renamed');
      expect(record?.config).toMatchObject({ bigBlind: 10, isPrivate: false });

      // The same rules as the owner menu at the table.
      const bad = await app.inject({ method: 'PATCH', url: `/admin/tables/${pub.tableId}/settings`, headers, payload: { smallBlind: 50, bigBlind: 10 } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ code: string }>().code).toBe('INVALID_SETTINGS');
      expect((await app.inject({ method: 'PATCH', url: `/admin/tables/${pub.tableId}/settings`, headers, payload: { maxSeats: 9 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: '/admin/tables/nope/settings', headers, payload: { name: 'X' } })).statusCode).toBe(404);
    });

    it('the house dealer is a table setting: the owner picks a character, it’s saved, and only a plain id is accepted', async () => {
      const t = await registry.createTable('Dealer', { ...SETTINGS_FOR_LIST }, null, null);
      const admin = await store.createAccount('dealer-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const headers = auth(issueAccessToken({ ...admin, role: 'admin' }));
      expect((await app.inject({ method: 'PATCH', url: `/admin/tables/${t.tableId}/settings`, headers, payload: { houseDealer: 'ava' } })).statusCode).toBe(200);
      expect(t.settings.houseDealer).toBe('ava');
      expect((await store.listTables()).find((r) => r.id === t.tableId)?.config).toMatchObject({ houseDealer: 'ava' });
      expect((await app.inject({ method: 'PATCH', url: `/admin/tables/${t.tableId}/settings`, headers, payload: { houseDealer: '../x' } })).statusCode).toBe(400);
    });

    it('an open-invite table’s starting chips can be changed from the lobby, but it can’t be made public', async () => {
      const open = await registry.createTable('Open', { ...SETTINGS_FOR_LIST, isPrivate: true, openSeating: true, openSeatStack: 500 }, null, 'opencode');
      const pub = await registry.createTable('Public', { ...SETTINGS_FOR_LIST }, null, null);
      const admin = await store.createAccount('open-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const headers = auth(issueAccessToken({ ...admin, role: 'admin' }));
      expect((await app.inject({ method: 'PATCH', url: `/admin/tables/${open.tableId}/settings`, headers, payload: { openSeatStack: 1500 } })).statusCode).toBe(200);
      expect(open.settings.openSeatStack).toBe(1500);
      expect((await app.inject({ method: 'GET', url: `/admin/tables/${open.tableId}/settings`, headers })).json<{ inviteCode: string }>().inviteCode).toBe('opencode');
      expect((await app.inject({ method: 'PATCH', url: `/admin/tables/${open.tableId}/settings`, headers, payload: { isPrivate: false } })).statusCode).toBe(400);
      expect(open.settings.isPrivate).toBe(true);
      // Starting chips mean nothing on an ordinary table.
      expect((await app.inject({ method: 'PATCH', url: `/admin/tables/${pub.tableId}/settings`, headers, payload: { openSeatStack: 1500 } })).statusCode).toBe(400);
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

  describe('signed waivers: the owner can view and download every one, forever', () => {
    it('lists, serves the PDF and the authorization record — to the owner only — and keeps them after the account is deleted', async () => {
      const r = await loginOrRegisterWithGoogle(store, { googleId: 'g-sw', email: 'sig@gmail.com', emailVerified: true, displayName: 'Sigrid', avatarUrl: null }, 'open');
      const signed = await app.inject({
        method: 'POST',
        url: '/users/me/waiver',
        headers: { ...auth(r.accessToken), 'user-agent': 'Mozilla/5.0 (iPhone) TestBrowser' },
        payload: { initials: 'SG', signature: signaturePngDataUrl(), version: WAIVER_VERSION, device: { platform: 'iPhone', touch: true } },
      });
      expect(signed.statusCode).toBe(200);

      const admin = await store.createAccount('sw-owner@x.com', 'hash', 'Owner');
      await store.setUserRole(admin.id, 'admin');
      const ownerAuth = auth(issueAccessToken({ ...admin, role: 'admin' }));
      expect((await app.inject({ method: 'GET', url: `/admin/users/${r.user.id}`, headers: auth(r.accessToken) })).statusCode).toBe(403);

      // Listed under the player who signed it.
      const list = (await app.inject({ method: 'GET', url: `/admin/users/${r.user.id}`, headers: ownerAuth })).json<{ signedWaivers: { id: string; displayName: string; userAgent: string }[] }>().signedWaivers;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ displayName: 'Sigrid', userAgent: 'Mozilla/5.0 (iPhone) TestBrowser' });
      const id = list[0]!.id;

      // Deleting the account keeps the signed waiver — under the deleted account now.
      expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(r.accessToken) })).statusCode).toBe(200);
      const after = (await app.inject({ method: 'GET', url: `/admin/deleted-users/${r.user.id}`, headers: ownerAuth })).json<{ signedWaivers: { id: string }[] }>().signedWaivers;
      expect(after.map((w) => w.id)).toEqual([id]);

      const view = await app.inject({ method: 'GET', url: `/admin/waivers/${id}/pdf`, headers: ownerAuth });
      expect(view.headers['content-type']).toBe('application/pdf');
      expect(view.headers['content-disposition']).toMatch(/^inline; filename="waiver-Sigrid-/);
      expect(view.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      const download = await app.inject({ method: 'GET', url: `/admin/waivers/${id}/pdf?download=1`, headers: ownerAuth });
      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
      const record = await app.inject({ method: 'GET', url: `/admin/waivers/${id}/record`, headers: ownerAuth });
      expect(record.headers['content-disposition']).toMatch(/^attachment; filename=".*-record\.json"/);
      expect(JSON.parse(record.body)).toMatchObject({ documentId: id, initials: 'SG', userAgent: 'Mozilla/5.0 (iPhone) TestBrowser' });
      expect((await app.inject({ method: 'GET', url: '/admin/waivers/00000000-0000-0000-0000-000000000000/pdf', headers: ownerAuth })).statusCode).toBe(404);
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

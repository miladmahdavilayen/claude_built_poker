import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TableSettings } from '@pokerclause/shared';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken } from '../src/auth/session.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import type { TableRegistry } from '../src/game/tableRegistry.js';
import { attachSocketServer } from '../src/socket/socketServer.js';

process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

const SETTINGS: TableSettings = {
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  maxSeats: 4,
  straddleEnabled: false,
  minBuyIn: 40,
  maxBuyIn: 200,
  actionSeconds: 25,
  timeBankSeconds: 60,
  runItTwiceEnabled: false,
  rakePercent: 0,
  rakeCap: 0,
  noFlopNoDrop: true,
  isPrivate: false,
  disableChatInHand: false,
};

describe('socketServer: live signaling and access control', () => {
  let store: MemoryStore;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let registry: TableRegistry;
  let baseUrl: string;
  // Held by reference (not destructured) so a test can set `deps.adminUserId`
  // AFTER attachSocketServer is already running — the real app resolves this
  // once at boot (see index.ts's ensureAdminAccount), but here the admin
  // account doesn't exist yet until a test calls makeAdminUser(), which is
  // necessarily after this shared beforeEach already wired the server up.
  let deps: { store: MemoryStore; corsOrigin: string; adminUserId: string };

  beforeEach(async () => {
    store = new MemoryStore();
    httpServer = createServer();
    deps = { store, corsOrigin: 'http://localhost:5173', adminUserId: '' };
    ({ io, registry } = attachSocketServer(httpServer, deps));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${String(port)}`;
  });

  afterEach(async () => {
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function makeUser(name: string, chips = 1000): Promise<{ userId: string; token: string }> {
    const created = await store.createGuestUser(name);
    const user = chips > 0 ? await store.adjustUserChips(created.id, chips) : created;
    return { userId: user.id, token: issueAccessToken(user) };
  }

  async function makeAdminUser(name: string, chips = 1000): Promise<{ userId: string; token: string }> {
    const created = await store.createGuestUser(name);
    if (chips > 0) await store.adjustUserChips(created.id, chips);
    await store.setUserRole(created.id, 'admin');
    const user = await store.findUserById(created.id);
    if (!user) throw new Error('unreachable: just created');
    deps.adminUserId = user.id; // see deps's own comment above — mirrors index.ts resolving this once at boot
    return { userId: user.id, token: issueAccessToken(user) };
  }

  function connect(token: string): ClientSocket {
    return ioClient(baseUrl, { auth: { token }, transports: ['websocket'] });
  }

  function waitFor<T>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
  }

  /** Emits an event and waits for its ack callback — the same "did the server actually finish" signal the real client uses before navigating away. */
  function emitWithAck(socket: ClientSocket, event: string): Promise<void> {
    return new Promise((resolve) => socket.emit(event, () => resolve()));
  }

  /** A single action can legitimately produce more than one distinct 'state' broadcast (e.g. a seat fills, then a hand deals) — wait for the one a predicate actually cares about. */
  function waitForState<T>(socket: ClientSocket, predicate: (payload: T) => boolean): Promise<T> {
    return new Promise((resolve) => {
      const handler = (payload: T): void => {
        if (predicate(payload)) {
          socket.off('state', handler);
          resolve(payload);
        }
      };
      socket.on('state', handler);
    });
  }

  /**
   * The real, non-admin path a regular human takes to get seated now
   * that self-serve buy-ins are gone (see DECISIONS.md): an admin
   * generates a seat assignment, and the target redeems it.
   */
  async function assignAndSeat(adminSocket: ClientSocket, targetSocket: ClientSocket, seatId: number, buyIn: number): Promise<void> {
    const token = await new Promise<string>((resolve, reject) => {
      adminSocket.emit(
        'assign-seat',
        { seatId, buyIn },
        (result: { ok: true; token: string } | { ok: false; code: string; message: string }) => {
          if (result.ok) resolve(result.token);
          else reject(new Error(result.message));
        },
      );
    });
    const seatedPromise = waitFor(targetSocket, 'state');
    targetSocket.emit('redeem-seat-assignment', { token });
    await seatedPromise;
  }

  it('rejects joining a private table without the correct invite code, and sends no table state', async () => {
    const alice = await makeUser('Alice');
    const eve = await makeUser('Eve');
    const table = await registry.createTable('Private Table', { ...SETTINGS, isPrivate: true }, alice.userId, 'right-code');

    const eveSocket = connect(eve.token);
    await waitFor(eveSocket, 'connect');

    let sawState = false;
    eveSocket.on('state', () => (sawState = true));
    const errorPromise = waitFor<{ code: string }>(eveSocket, 'error');
    eveSocket.emit('join-table', { tableId: table.tableId, inviteCode: 'wrong-code' });
    expect((await errorPromise).code).toBe('INVALID_INVITE_CODE');
    expect(sawState).toBe(false);

    eveSocket.close();
  });

  it('admits a private table join with the correct invite code', async () => {
    const alice = await makeUser('Alice');
    const table = await registry.createTable('Private Table', { ...SETTINGS, isPrivate: true }, alice.userId, 'right-code');

    const aliceSocket = connect(alice.token);
    await waitFor(aliceSocket, 'connect');
    const statePromise = waitFor<{ state: { tableId: string } }>(aliceSocket, 'state');
    aliceSocket.emit('join-table', { tableId: table.tableId, inviteCode: 'right-code' });
    expect((await statePromise).state.tableId).toBe(table.tableId);

    aliceSocket.close();
  });

  it('registers every human as a receive-ready voice participant automatically on join-table, and relays signals only within the same table', async () => {
    const alice = await makeUser('Alice');
    const bob = await makeUser('Bob');
    const mallory = await makeUser('Mallory');
    const table = await registry.createTable('Voice Table', SETTINGS, null, null);
    const other = await registry.createTable('Other Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    const bobSocket = connect(bob.token);
    const mallorySocket = connect(mallory.token);
    await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect'), waitFor(mallorySocket, 'connect')]);

    // No separate "join voice" step anymore — every human is registered
    // the moment join-table itself runs (see registerVoiceParticipant in
    // socketServer.ts), so anyone else at the table can already reach
    // them with a real offer whether or not they've opened their own
    // mic/camera. See DECISIONS.md and useVoiceChat.ts's own doc comment.
    //
    // Both 'rtc-peers' and 'state' fire synchronously within the same
    // join-table call, essentially back to back — every listener has to
    // be registered BEFORE the emit, not just before its own await, or a
    // `.once()` set up only after awaiting the first can miss the second
    // (it already fired with nothing listening) and hang forever.
    const alicePeersPromise = waitFor<{ socketId: string }[]>(aliceSocket, 'rtc-peers');
    const aliceStatePromise = waitFor(aliceSocket, 'state');
    aliceSocket.emit('join-table', { tableId: table.tableId });
    const alicePeers = await alicePeersPromise;
    expect(alicePeers).toEqual([]); // first one at the table, no one else there yet
    await aliceStatePromise;

    const bobPeersPromise = waitFor<{ socketId: string }[]>(bobSocket, 'rtc-peers');
    const bobStatePromise = waitFor(bobSocket, 'state');
    const bobJoinedPromise = waitFor<{ socketId: string }>(aliceSocket, 'rtc-peer-joined');
    bobSocket.emit('join-table', { tableId: table.tableId });
    const bobPeers = await bobPeersPromise;
    expect(bobPeers).toHaveLength(1); // sees Alice as already-present
    const bobAnnouncedToAlice = await bobJoinedPromise;
    expect(bobAnnouncedToAlice.socketId).toBe(bobSocket.id);
    await bobStatePromise;

    const malloryStatePromise = waitFor(mallorySocket, 'state');
    mallorySocket.emit('join-table', { tableId: other.tableId }); // a different table entirely
    await malloryStatePromise;

    // Bob signals an offer to Alice — both are registered voice participants of the same table.
    const signalReceived = waitFor<{ from: string; data: unknown }>(aliceSocket, 'rtc-signal');
    bobSocket.emit('rtc-signal', { to: aliceSocket.id, data: { type: 'offer', sdp: 'fake-sdp' } });
    const received = await signalReceived;
    expect(received.from).toBe(bobSocket.id);
    expect(received.data).toEqual({ type: 'offer', sdp: 'fake-sdp' });

    // Mallory is at a different table entirely — a signal aimed at her must be silently dropped, not delivered.
    let mallorySawSignal = false;
    mallorySocket.on('rtc-signal', () => (mallorySawSignal = true));
    aliceSocket.emit('rtc-signal', { to: mallorySocket.id, data: { type: 'offer', sdp: 'x' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(mallorySawSignal).toBe(false);

    aliceSocket.close();
    bobSocket.close();
    mallorySocket.close();
  });

  it('notifies remaining voice participants when a peer disconnects', async () => {
    const alice = await makeUser('Alice');
    const bob = await makeUser('Bob');
    const table = await registry.createTable('Voice Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    const bobSocket = connect(bob.token);
    await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect')]);

    // See the previous test's comment — both listeners must be registered before the emit, not just before their own await.
    const alicePeersPromise = waitFor(aliceSocket, 'rtc-peers');
    const aliceStatePromise = waitFor(aliceSocket, 'state');
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await alicePeersPromise;
    await aliceStatePromise;

    const bobPeersPromise = waitFor(bobSocket, 'rtc-peers');
    const bobStatePromise = waitFor(bobSocket, 'state');
    bobSocket.emit('join-table', { tableId: table.tableId });
    await bobPeersPromise;
    await bobStatePromise;

    const bobSocketId = bobSocket.id;
    const peerLeftPromise = waitFor<{ socketId: string }>(aliceSocket, 'rtc-peer-left');
    bobSocket.close();
    const peerLeft = await peerLeftPromise;
    expect(peerLeft.socketId).toBe(bobSocketId);

    aliceSocket.close();
  });

  it('adding a bot seats it and broadcasts it as isBot, but does NOT deal a hand automatically — only an explicit start-hand does', async () => {
    // The owner/admin: both adding a bot and taking a seat directly are owner-only actions now (see DECISIONS.md) — irrelevant to what this test actually checks (start-hand gating), so Alice is the admin here purely for setup convenience.
    const alice = await makeAdminUser('Alice');
    const table = await registry.createTable('Bot Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    await waitFor(aliceSocket, 'connect');
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await waitFor(aliceSocket, 'state');

    const seatedPromise = waitFor<{ state: { seats: { seatId: number; playerId: string | null }[] } }>(aliceSocket, 'state');
    aliceSocket.emit('take-seat', { tableId: table.tableId, seatId: 0, buyIn: 100 });
    await seatedPromise;

    const botAddedPromise = waitFor<{ state: { phase: string; canStartHand: boolean; seats: { seatId: number; isBot: boolean }[] } }>(
      aliceSocket,
      'state',
    );
    aliceSocket.emit('add-bot', { seatId: 1, persona: 'nit', buyIn: 100 });
    const afterBot = await botAddedPromise;
    expect(afterBot.state.seats.find((s) => s.seatId === 1)?.isBot).toBe(true);
    // Two dealt-in seats (one human, one bot) means a hand COULD start now, but nothing deals until asked.
    expect(afterBot.state.phase).toBe('waiting');
    expect(afterBot.state.canStartHand).toBe(true);

    // A short pause confirms it really is staying put, not just "not dealt yet this tick".
    await new Promise((r) => setTimeout(r, 100));

    const handStartedPromise = waitForState<{ state: { phase: string } }>(aliceSocket, (payload) => payload.state.phase === 'in-hand');
    aliceSocket.emit('start-hand');
    const afterStart = await handStartedPromise;
    expect(afterStart.state.phase).toBe('in-hand');

    aliceSocket.close();
  });

  it('start-hand is refused when not seated, and when not enough players are dealt-in yet', async () => {
    const alice = await makeAdminUser('Alice'); // owner-only take-seat — see the "adding a bot..." test above for why
    const eve = await makeUser('Eve');
    const table = await registry.createTable('Bot Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    const eveSocket = connect(eve.token);
    await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(eveSocket, 'connect')]);
    aliceSocket.emit('join-table', { tableId: table.tableId });
    eveSocket.emit('join-table', { tableId: table.tableId }); // Eve stays a spectator, never seated
    await Promise.all([waitFor(aliceSocket, 'state'), waitFor(eveSocket, 'state')]);

    const notSeatedError = waitFor<{ code: string }>(eveSocket, 'error');
    eveSocket.emit('start-hand');
    expect((await notSeatedError).code).toBe('NOT_SEATED');

    const seatedPromise = waitFor(aliceSocket, 'state');
    aliceSocket.emit('take-seat', { tableId: table.tableId, seatId: 0, buyIn: 100 });
    await seatedPromise;

    // Alice alone: seated, but only one dealt-in player — not enough to start.
    const cannotStartError = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('start-hand');
    expect((await cannotStartError).code).toBe('CANNOT_START_HAND');

    aliceSocket.close();
    eveSocket.close();
  });

  it('rejects an unknown bot persona and an out-of-range buy-in', async () => {
    const alice = await makeAdminUser('Alice'); // add-bot is owner-only now — see DECISIONS.md
    const table = await registry.createTable('Bot Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    await waitFor(aliceSocket, 'connect');
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await waitFor(aliceSocket, 'state');

    const badPersonaError = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('add-bot', { seatId: 0, persona: 'not-a-real-persona', buyIn: 100 });
    expect((await badPersonaError).code).toBe('UNKNOWN_BOT_PERSONA');

    const badBuyInError = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('add-bot', { seatId: 0, persona: 'nit', buyIn: 999999 });
    expect((await badBuyInError).code).toBe('BUY_IN_OUT_OF_RANGE');

    aliceSocket.close();
  });

  it('removing a bot frees the seat, broadcast to everyone at the table', async () => {
    const alice = await makeAdminUser('Alice'); // add-bot is owner-only now — see DECISIONS.md
    const bob = await makeUser('Bob');
    const table = await registry.createTable('Bot Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    const bobSocket = connect(bob.token);
    await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect')]);
    aliceSocket.emit('join-table', { tableId: table.tableId });
    bobSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(aliceSocket, 'state'), waitFor(bobSocket, 'state')]);

    const bobSeesBotPromise = waitFor<{ state: { seats: { seatId: number; isBot: boolean }[] } }>(bobSocket, 'state');
    aliceSocket.emit('add-bot', { seatId: 0, persona: 'nit', buyIn: 100 });
    const bobSeesBot = await bobSeesBotPromise;
    expect(bobSeesBot.state.seats.find((s) => s.seatId === 0)?.isBot).toBe(true);

    const bobSeesRemovalPromise = waitFor<{ state: { seats: { seatId: number; isBot: boolean; status: string }[] } }>(bobSocket, 'state');
    bobSocket.emit('remove-bot', { seatId: 0 });
    const bobSeesRemoval = await bobSeesRemovalPromise;
    expect(bobSeesRemoval.state.seats.find((s) => s.seatId === 0)?.status).toBe('empty');

    aliceSocket.close();
    bobSocket.close();
  });

  it('leave-table only resolves its ack after the seat is actually cleared server-side', async () => {
    const alice = await makeAdminUser('Alice'); // owner-only take-seat — irrelevant to what this test checks
    const table = await registry.createTable('Leave Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    await waitFor(aliceSocket, 'connect');
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await waitFor(aliceSocket, 'state');

    const seatedPromise = waitFor(aliceSocket, 'state');
    aliceSocket.emit('take-seat', { tableId: table.tableId, seatId: 0, buyIn: 100 });
    await seatedPromise;
    expect(table.seatOfUser(alice.userId)).toBe(0);

    // Regression: this used to race the socket's own disconnect (the real
    // client closes its connection right after navigating away) — the
    // ack is exactly what lets a caller wait for the seat to genuinely
    // clear before doing that. See DECISIONS.md.
    await emitWithAck(aliceSocket, 'leave-table');
    expect(table.seatOfUser(alice.userId)).toBeNull();

    aliceSocket.close();
  });

  it('closes the table automatically once the last human leaves, notifying any remaining spectator', async () => {
    const alice = await makeAdminUser('Alice'); // owner-only take-seat — irrelevant to what this test checks
    const eve = await makeUser('Eve'); // never takes a seat — stays a spectator
    const table = await registry.createTable('Auto Close Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    const eveSocket = connect(eve.token);
    await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(eveSocket, 'connect')]);
    aliceSocket.emit('join-table', { tableId: table.tableId });
    eveSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(aliceSocket, 'state'), waitFor(eveSocket, 'state')]);

    const seatedPromise = waitFor(aliceSocket, 'state');
    aliceSocket.emit('take-seat', { tableId: table.tableId, seatId: 0, buyIn: 100 });
    await seatedPromise;

    const eveSeesClose = waitFor<{ reason: string }>(eveSocket, 'table-closed');
    await emitWithAck(aliceSocket, 'leave-table');
    const closeNotice = await eveSeesClose;
    expect(closeNotice.reason).toMatch(/all players left/i);
    expect(registry.get(table.tableId)).toBeNull();

    aliceSocket.close();
    eveSocket.close();
  });

  it('terminate-table requires the admin role, and closes the table for everyone once an admin uses it', async () => {
    const admin = await makeAdminUser('Owner');
    const alice = await makeUser('Alice');
    const table = await registry.createTable('Terminate Table', SETTINGS, null, null);

    const adminSocket = connect(admin.token);
    const aliceSocket = connect(alice.token);
    await Promise.all([waitFor(adminSocket, 'connect'), waitFor(aliceSocket, 'connect')]);
    adminSocket.emit('join-table', { tableId: table.tableId });
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(adminSocket, 'state'), waitFor(aliceSocket, 'state')]);

    // Alice must stay a genuine non-admin for this test — seat her the
    // real way a regular human gets seated now (see DECISIONS.md), not
    // via the owner-only take-seat path.
    await assignAndSeat(adminSocket, aliceSocket, 0, 100);

    const deniedError = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('terminate-table');
    expect((await deniedError).code).toBe('ADMIN_REQUIRED');
    expect(registry.get(table.tableId)).not.toBeNull();

    const aliceSeesClose = waitFor<{ reason: string }>(aliceSocket, 'table-closed');
    await emitWithAck(adminSocket, 'terminate-table');
    const notice = await aliceSeesClose;
    expect(notice.reason).toMatch(/terminated by the owner/i);
    expect(registry.get(table.tableId)).toBeNull();

    adminSocket.close();
    aliceSocket.close();
  });

  it('reset-table requires the admin role, empties every seat, refunds seated humans, and keeps the table itself alive', async () => {
    const admin = await makeAdminUser('Owner');
    const alice = await makeUser('Alice', 1000);
    const table = await registry.createTable('Reset Table', SETTINGS, null, null);

    const adminSocket = connect(admin.token);
    const aliceSocket = connect(alice.token);
    await Promise.all([waitFor(adminSocket, 'connect'), waitFor(aliceSocket, 'connect')]);
    adminSocket.emit('join-table', { tableId: table.tableId });
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(adminSocket, 'state'), waitFor(aliceSocket, 'state')]);

    // Alice must stay a genuine non-admin for this test — seat her the
    // real way a regular human gets seated now (see DECISIONS.md).
    await assignAndSeat(adminSocket, aliceSocket, 0, 100);

    const deniedError = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('reset-table');
    expect((await deniedError).code).toBe('ADMIN_REQUIRED');

    const aliceChipsBeforeReset = (await store.findUserById(alice.userId))!.chips; // 900 after the 100 buy-in

    const aliceSeesEmpty = waitFor<{ state: { seats: { seatId: number; status: string }[] } }>(aliceSocket, 'state');
    await emitWithAck(adminSocket, 'reset-table');
    const afterReset = await aliceSeesEmpty;
    expect(afterReset.state.seats.every((s) => s.status === 'empty')).toBe(true);

    const aliceChipsAfterReset = (await store.findUserById(alice.userId))!.chips;
    expect(aliceChipsAfterReset).toBe(aliceChipsBeforeReset + 100);

    // The table itself is still alive — a fresh seat + deal both work afterward.
    expect(registry.get(table.tableId)).not.toBeNull();
    expect(table.canStartHand()).toBe(false); // empty again, needs 2+ dealt-in players

    adminSocket.close();
    aliceSocket.close();
  });

  it('a regular player cannot seat themselves or add a bot directly — only the owner-generated invite link seats a human', async () => {
    const alice = await makeUser('Alice');
    const table = await registry.createTable('Locked Down Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    await waitFor(aliceSocket, 'connect');
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await waitFor(aliceSocket, 'state');

    const takeSeatDenied = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('take-seat', { tableId: table.tableId, seatId: 0, buyIn: 100 });
    expect((await takeSeatDenied).code).toBe('SELF_SERVE_DISABLED');
    expect(table.seatOfUser(alice.userId)).toBeNull();

    const addBotDenied = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('add-bot', { seatId: 1, persona: 'nit', buyIn: 100 });
    expect((await addBotDenied).code).toBe('ADMIN_REQUIRED');

    aliceSocket.close();
  });

  it('assign-seat + redeem-seat-assignment: a one-time, seat-and-amount-specific invite link, ignoring anything the redeemer tries to supply themselves, consumed on use', async () => {
    const admin = await makeAdminUser('Owner');
    const alice = await makeUser('Alice');
    const table = await registry.createTable('Invite Link Table', SETTINGS, null, null);

    const adminSocket = connect(admin.token);
    const aliceSocket = connect(alice.token);
    await Promise.all([waitFor(adminSocket, 'connect'), waitFor(aliceSocket, 'connect')]);
    adminSocket.emit('join-table', { tableId: table.tableId });
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(adminSocket, 'state'), waitFor(aliceSocket, 'state')]);

    // A non-admin can't generate a link.
    const assignDenied = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      aliceSocket.emit('assign-seat', { seatId: 0, buyIn: 100 }, resolve);
    });
    expect(assignDenied).toEqual({ ok: false, code: 'ADMIN_REQUIRED', message: expect.any(String) as string });

    const token = await new Promise<string>((resolve) => {
      adminSocket.emit('assign-seat', { seatId: 2, buyIn: 75 }, (result: { ok: true; token: string } | { ok: false }) => {
        if (result.ok) resolve(result.token);
      });
    });

    const seatedPromise = waitFor<{ state: { seats: { seatId: number; stack: number; playerId: string | null }[] } }>(aliceSocket, 'state');
    aliceSocket.emit('redeem-seat-assignment', { token });
    const seated = await seatedPromise;
    // The token's own buy-in (75) is what's used — seatId 2, not whatever seatId/amount was originally requested elsewhere.
    const seat2 = seated.state.seats.find((s) => s.seatId === 2);
    expect(seat2?.playerId).toBe(alice.userId);
    expect(seat2?.stack).toBe(75);

    // Single-use: redeeming the SAME token again fails.
    const bob = await makeUser('Bob');
    const bobSocket = connect(bob.token);
    await waitFor(bobSocket, 'connect');
    bobSocket.emit('join-table', { tableId: table.tableId });
    await waitFor(bobSocket, 'state');
    const reuseError = waitFor<{ code: string }>(bobSocket, 'error');
    bobSocket.emit('redeem-seat-assignment', { token });
    expect((await reuseError).code).toBe('INVALID_ASSIGNMENT');

    adminSocket.close();
    aliceSocket.close();
    bobSocket.close();
  });

  it("assign-seat's nickname is visible only to the admin, never to the redeemer or a spectator", async () => {
    const admin = await makeAdminUser('Owner');
    const alice = await makeUser('Alice');
    const table = await registry.createTable('Nickname Table', SETTINGS, null, null);

    const adminSocket = connect(admin.token);
    const aliceSocket = connect(alice.token);
    const spectator = await makeUser('Spectator');
    const spectatorSocket = connect(spectator.token);
    await Promise.all([waitFor(adminSocket, 'connect'), waitFor(aliceSocket, 'connect'), waitFor(spectatorSocket, 'connect')]);
    adminSocket.emit('join-table', { tableId: table.tableId });
    aliceSocket.emit('join-table', { tableId: table.tableId });
    spectatorSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(adminSocket, 'state'), waitFor(aliceSocket, 'state'), waitFor(spectatorSocket, 'state')]);

    const token = await new Promise<string>((resolve) => {
      adminSocket.emit('assign-seat', { seatId: 1, buyIn: 100, nickname: 'Dave from work' }, (result: { ok: true; token: string } | { ok: false }) => {
        if (result.ok) resolve(result.token);
      });
    });

    type SeatsPayload = { state: { seats: { seatId: number; ownerNickname: string | null }[] } };
    // The admin socket is excluded from the regular spectator-room emit
    // (`.except(adminRoom(...))`) specifically so it gets exactly ONE
    // 'state' event per update, always the enriched one — see
    // broadcastAdminView's doc comment for why a SECOND one here was a
    // real bug, not just harmless. Alice and the plain spectator each
    // get their own single, redacted one.
    const adminStatePromise = waitFor<SeatsPayload>(adminSocket, 'state');
    const aliceStatePromise = waitFor<SeatsPayload>(aliceSocket, 'state');
    const spectatorStatePromise = waitFor<SeatsPayload>(spectatorSocket, 'state');
    aliceSocket.emit('redeem-seat-assignment', { token });
    const [adminState, aliceState, spectatorState] = await Promise.all([adminStatePromise, aliceStatePromise, spectatorStatePromise]);

    expect(aliceState.state.seats.find((s) => s.seatId === 1)?.ownerNickname).toBeNull();
    expect(spectatorState.state.seats.find((s) => s.seatId === 1)?.ownerNickname).toBeNull();
    expect(adminState.state.seats.find((s) => s.seatId === 1)?.ownerNickname).toBe('Dave from work');

    adminSocket.close();
    aliceSocket.close();
    spectatorSocket.close();
  });

  it('admin-rebuy tops up a specific seat, requires the admin role, and is capped at the table max buy-in', async () => {
    const admin = await makeAdminUser('Owner');
    const alice = await makeUser('Alice', 1000);
    const table = await registry.createTable('Rebuy Table', SETTINGS, null, null);

    const adminSocket = connect(admin.token);
    const aliceSocket = connect(alice.token);
    await Promise.all([waitFor(adminSocket, 'connect'), waitFor(aliceSocket, 'connect')]);
    adminSocket.emit('join-table', { tableId: table.tableId });
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(adminSocket, 'state'), waitFor(aliceSocket, 'state')]);
    await assignAndSeat(adminSocket, aliceSocket, 0, 150); // maxBuyIn is 200 — leaves room for a 50-chip rebuy before hitting the cap

    const deniedError = waitFor<{ code: string }>(aliceSocket, 'error');
    aliceSocket.emit('admin-rebuy', { seatId: 0, amount: 50 });
    expect((await deniedError).code).toBe('ADMIN_REQUIRED');
    expect(table.state.seats[0]?.stack).toBe(150);

    const reboughtPromise = waitFor<{ state: { seats: { seatId: number; stack: number }[] } }>(aliceSocket, 'state');
    adminSocket.emit('admin-rebuy', { seatId: 0, amount: 50 });
    const afterRebuy = await reboughtPromise;
    expect(afterRebuy.state.seats.find((s) => s.seatId === 0)?.stack).toBe(200);

    // Already at the max buy-in (200/200) — a further rebuy has no room
    // left and is refused outright, with the error going back to the
    // CALLER (the admin), not the seat's occupant.
    const noRoomError = waitFor<{ code: string }>(adminSocket, 'error');
    adminSocket.emit('admin-rebuy', { seatId: 0, amount: 1000 });
    expect((await noRoomError).code).toBe('CANNOT_REBUY');

    adminSocket.close();
    aliceSocket.close();
  });
});

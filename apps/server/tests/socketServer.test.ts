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

  beforeEach(async () => {
    store = new MemoryStore();
    httpServer = createServer();
    ({ io, registry } = attachSocketServer(httpServer, { store, corsOrigin: 'http://localhost:5173' }));
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

  function connect(token: string): ClientSocket {
    return ioClient(baseUrl, { auth: { token }, transports: ['websocket'] });
  }

  function waitFor<T>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
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

  it('relays a WebRTC signal only between two sockets that both joined voice at the same table, and drops it otherwise', async () => {
    const alice = await makeUser('Alice');
    const bob = await makeUser('Bob');
    const mallory = await makeUser('Mallory');
    const table = await registry.createTable('Voice Table', SETTINGS, null, null);
    const other = await registry.createTable('Other Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    const bobSocket = connect(bob.token);
    const mallorySocket = connect(mallory.token);
    await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect'), waitFor(mallorySocket, 'connect')]);

    aliceSocket.emit('join-table', { tableId: table.tableId });
    bobSocket.emit('join-table', { tableId: table.tableId });
    mallorySocket.emit('join-table', { tableId: other.tableId }); // a different table entirely
    await Promise.all([waitFor(aliceSocket, 'state'), waitFor(bobSocket, 'state'), waitFor(mallorySocket, 'state')]);

    aliceSocket.emit('rtc-join');
    const alicePeers = await waitFor<{ socketId: string }[]>(aliceSocket, 'rtc-peers');
    expect(alicePeers).toEqual([]); // first to join voice, no one else there yet

    const bobJoinedPromise = waitFor<{ socketId: string }>(aliceSocket, 'rtc-peer-joined');
    bobSocket.emit('rtc-join');
    const bobPeers = await waitFor<{ socketId: string }[]>(bobSocket, 'rtc-peers');
    expect(bobPeers).toHaveLength(1); // sees Alice as already-present
    const bobAnnouncedToAlice = await bobJoinedPromise;
    expect(bobAnnouncedToAlice.socketId).toBe(bobSocket.id);

    // Bob signals an offer to Alice — both are voice participants of the same table.
    const signalReceived = waitFor<{ from: string; data: unknown }>(aliceSocket, 'rtc-signal');
    bobSocket.emit('rtc-signal', { to: aliceSocket.id, data: { type: 'offer', sdp: 'fake-sdp' } });
    const received = await signalReceived;
    expect(received.from).toBe(bobSocket.id);
    expect(received.data).toEqual({ type: 'offer', sdp: 'fake-sdp' });

    // Mallory never called rtc-join (and is at a different table entirely) — a signal aimed at her must be silently dropped, not delivered.
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
    aliceSocket.emit('join-table', { tableId: table.tableId });
    bobSocket.emit('join-table', { tableId: table.tableId });
    await Promise.all([waitFor(aliceSocket, 'state'), waitFor(bobSocket, 'state')]);

    aliceSocket.emit('rtc-join');
    await waitFor(aliceSocket, 'rtc-peers');
    bobSocket.emit('rtc-join');
    await waitFor(bobSocket, 'rtc-peers');

    const bobSocketId = bobSocket.id;
    const peerLeftPromise = waitFor<{ socketId: string }>(aliceSocket, 'rtc-peer-left');
    bobSocket.close();
    const peerLeft = await peerLeftPromise;
    expect(peerLeft.socketId).toBe(bobSocketId);

    aliceSocket.close();
  });

  it('adding a bot seats it, broadcasts it as isBot, and — once a human is also seated — deals a hand automatically', async () => {
    const alice = await makeUser('Alice');
    const table = await registry.createTable('Bot Table', SETTINGS, null, null);

    const aliceSocket = connect(alice.token);
    await waitFor(aliceSocket, 'connect');
    aliceSocket.emit('join-table', { tableId: table.tableId });
    await waitFor(aliceSocket, 'state');

    const seatedPromise = waitFor<{ state: { seats: { seatId: number; playerId: string | null }[] } }>(aliceSocket, 'state');
    aliceSocket.emit('take-seat', { tableId: table.tableId, seatId: 0, buyIn: 100 });
    await seatedPromise;

    // Seating the bot itself broadcasts one state (phase still 'waiting'),
    // then starting the hand broadcasts a second, distinct one — wait for
    // the one that actually reflects the hand having started.
    const handStartedPromise = waitForState<{ state: { phase: string; seats: { seatId: number; isBot: boolean }[] } }>(
      aliceSocket,
      (payload) => payload.state.phase === 'in-hand',
    );
    aliceSocket.emit('add-bot', { seatId: 1, persona: 'nit', buyIn: 100 });
    const afterBot = await handStartedPromise;
    expect(afterBot.state.seats.find((s) => s.seatId === 1)?.isBot).toBe(true);
    // Two dealt-in seats (one human, one bot) — a hand deals automatically, same as two humans would.
    expect(afterBot.state.phase).toBe('in-hand');

    aliceSocket.close();
  });

  it('rejects an unknown bot persona and an out-of-range buy-in', async () => {
    const alice = await makeUser('Alice');
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
    const alice = await makeUser('Alice');
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
});

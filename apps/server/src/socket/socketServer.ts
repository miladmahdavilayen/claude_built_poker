import type { Server as HttpServer } from 'node:http';
import {
  AddBotSchema,
  ChatMessageSchema,
  JoinTableSchema,
  PlayerActionIntentSchema,
  RebuySchema,
  RemoveBotSchema,
  RtcSignalSchema,
  TakeSeatSchema,
} from '@pokerclause/shared';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/session.js';
import type { Store } from '../db/store.js';
import { TableRegistry } from '../game/tableRegistry.js';
import { filterProfanity } from './profanityFilter.js';
import { RateLimiter } from './rateLimiter.js';

interface SocketData {
  userId: string | null;
  role: 'player' | 'admin' | null;
  displayName: string | null;
  isGuest: boolean;
  avatarSeed: string | null;
  clientSeed: string | null;
}

function seatRoom(tableId: string, seatId: number): string {
  return `table:${tableId}:seat:${String(seatId)}`;
}
function spectatorRoom(tableId: string): string {
  return `table:${tableId}:spectators`;
}

const actionLimiter = new RateLimiter(10, 5); // 10 burst, 5/sec refill
const chatLimiter = new RateLimiter(5, 1); // 5 burst, 1/sec refill

export function attachSocketServer(httpServer: HttpServer, deps: { store: Store; corsOrigin: string }): { io: Server; registry: TableRegistry } {
  const io = new Server(httpServer, {
    cors: { origin: deps.corsOrigin, credentials: true },
  });

  const registry = new TableRegistry(deps.store, (tableId, perSeat) => {
    for (const [seatId, payload] of perSeat) {
      const room = seatId === null ? spectatorRoom(tableId) : seatRoom(tableId, seatId);
      io.to(room).emit('state', { state: payload.state, events: payload.events });
    }
    const table = registry.get(tableId);
    if (table && table.state.phase === 'hand-complete') registry.scheduleNextHandIfReady(tableId);
  });

  // Voice/video signaling (WebRTC): the server only ever relays opaque SDP
  // offers/answers and ICE candidates between two sockets already at the
  // same table — it never touches media itself, so no audio/video data
  // passes through this process. See apps/web's useVoiceChat.ts for the
  // browser side of this handshake.
  interface VoiceParticipant {
    socketId: string;
    userId: string;
    displayName: string;
  }
  const voiceParticipants = new Map<string, Map<string, VoiceParticipant>>();

  function removeVoiceParticipant(tableId: string, socketId: string): void {
    const participants = voiceParticipants.get(tableId);
    if (!participants?.has(socketId)) return;
    participants.delete(socketId);
    for (const p of participants.values()) io.to(p.socketId).emit('rtc-peer-left', { socketId });
    if (participants.size === 0) voiceParticipants.delete(tableId);
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth.token as unknown;
    const data: SocketData = { userId: null, role: null, displayName: null, isGuest: true, avatarSeed: null, clientSeed: null };
    if (typeof token === 'string' && token.length > 0) {
      const payload = verifyAccessToken(token);
      if (payload) {
        data.userId = payload.sub;
        data.role = payload.role;
        data.isGuest = payload.isGuest;
      }
    }
    (socket.data as SocketData) = data;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    let joinedTableId: string | null = null;

    void (async () => {
      if (data.userId) {
        const user = await deps.store.findUserById(data.userId);
        if (user) {
          data.displayName = user.displayName;
          data.avatarSeed = user.avatarSeed;
          data.clientSeed = user.clientSeed;
        }
      }
    })();

    function currentTable() {
      return joinedTableId ? registry.get(joinedTableId) : null;
    }

    function broadcastTable(table: NonNullable<ReturnType<typeof currentTable>>): void {
      for (const viewer of [...table.seats.filter((s) => s.userId !== null).map((s) => s.seatId), null]) {
        const room = viewer === null ? spectatorRoom(table.tableId) : seatRoom(table.tableId, viewer);
        io.to(room).emit('state', { state: table.projectionFor(viewer), events: [] });
      }
    }

    // Named so `return emitError(...)` is a clean, consistently-void early return
    // (socket.emit itself returns boolean, which return-socket.emit(...) would leak).
    function emitError(code: string, message: string): void {
      socket.emit('error', { code, message });
    }

    socket.on('join-table', (raw: unknown): void => {
      const parsed = JoinTableSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed join-table payload.');
      const table = registry.get(parsed.data.tableId);
      if (!table) return emitError('TABLE_NOT_FOUND', 'Table not found.');

      const seatId = data.userId ? table.seatOfUser(data.userId) : null;
      if (table.settings.isPrivate && seatId === null && parsed.data.inviteCode !== table.inviteCode) {
        return emitError('INVALID_INVITE_CODE', 'This table is private. Provide the correct invite code to join.');
      }

      joinedTableId = table.tableId;
      void socket.join(seatId !== null ? seatRoom(table.tableId, seatId) : spectatorRoom(table.tableId));
      if (data.userId) table.setConnected(data.userId, true);

      // An authenticated join flips this seat/viewer's connection status,
      // which everyone else at the table should see — broadcastTable
      // covers that, AND reaches this same socket too (it's now in its
      // room), so a separate direct emit would just duplicate the same
      // state event. An anonymous join changes nothing visible to anyone
      // else, so it only ever needs its own single direct emit.
      if (data.userId) {
        broadcastTable(table);
      } else {
        socket.emit('state', { state: table.projectionFor(seatId), events: [] });
      }
      void deps.store.listRecentChat(table.tableId, 50).then((messages) => socket.emit('chat-history', messages));
    });

    socket.on('take-seat', (raw: unknown): void => {
      if (!data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to take a seat.');
      const parsed = TakeSeatSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed take-seat payload.');
      const table = registry.get(parsed.data.tableId);
      if (!table) return emitError('TABLE_NOT_FOUND', 'Table not found.');

      // Per-table one-session rule: the same account cannot occupy two seats at one table.
      if (table.seatOfUser(data.userId) !== null) {
        return emitError('ALREADY_SEATED', 'You already have a seat at this table.');
      }
      const { buyIn, seatId } = parsed.data;
      if (buyIn < table.settings.minBuyIn || buyIn > table.settings.maxBuyIn) {
        return emitError('BUY_IN_OUT_OF_RANGE', `Buy-in must be between ${String(table.settings.minBuyIn)} and ${String(table.settings.maxBuyIn)}.`);
      }
      const userId = data.userId;
      void (async () => {
        const user = await deps.store.findUserById(userId);
        if (!user) return;
        if (user.chips < buyIn) return emitError('INSUFFICIENT_CHIPS', 'Not enough chips for that buy-in.');
        try {
          table.takeSeat(seatId, user.id, { displayName: user.displayName, isGuest: user.isGuest, avatarSeed: user.avatarSeed, clientSeed: user.clientSeed }, buyIn);
        } catch (err) {
          return emitError('SEAT_TAKEN', err instanceof Error ? err.message : 'Seat unavailable.');
        }
        await deps.store.adjustUserChips(user.id, -buyIn);
        await deps.store.recordLedgerEntries([
          { userId: user.id, isHouse: false, amount: -buyIn, reason: 'buy_in', tableId: table.tableId },
          { userId: null, isHouse: true, amount: buyIn, reason: 'buy_in', tableId: table.tableId },
        ]);
        void socket.join(seatRoom(table.tableId, seatId));
        void socket.leave(spectatorRoom(table.tableId));
        broadcastTable(table);
        if (table.canStartHand()) table.startNextHand();
      })();
    });

    socket.on('add-bot', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to add a computer player.');
      const parsed = AddBotSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed add-bot payload.');
      const { seatId, persona, buyIn } = parsed.data;
      if (buyIn < table.settings.minBuyIn || buyIn > table.settings.maxBuyIn) {
        return emitError('BUY_IN_OUT_OF_RANGE', `Buy-in must be between ${String(table.settings.minBuyIn)} and ${String(table.settings.maxBuyIn)}.`);
      }
      const result = table.addBot(seatId, persona, buyIn);
      if (!result.ok) return emitError(result.code, result.message);
      broadcastTable(table);
      if (table.canStartHand()) table.startNextHand();
    });

    socket.on('remove-bot', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return;
      const parsed = RemoveBotSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed remove-bot payload.');
      const result = table.removeBot(parsed.data.seatId);
      if (!result.ok) return emitError(result.code, result.message);
      broadcastTable(table);
    });

    socket.on('leave-table', () => {
      const table = currentTable();
      if (!table || !data.userId) return;
      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) return;
      try {
        const result = table.leaveSeat(seatId);
        if (result) {
          void deps.store.adjustUserChips(result.userId, result.stack).then(() =>
            deps.store.recordLedgerEntries([
              { userId: result.userId, isHouse: false, amount: result.stack, reason: 'cash_out', tableId: table.tableId },
              { userId: null, isHouse: true, amount: -result.stack, reason: 'cash_out', tableId: table.tableId },
            ]),
          );
        }
        broadcastTable(table);
      } catch (err) {
        socket.emit('error', { code: 'CANNOT_LEAVE', message: err instanceof Error ? err.message : 'Cannot leave right now.' });
      }
    });

    socket.on('sit-out', () => {
      const table = currentTable();
      if (!table || !data.userId) return;
      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) return;
      table.sitOut(seatId);
      broadcastTable(table);
    });

    socket.on('sit-in', () => {
      const table = currentTable();
      if (!table || !data.userId) return;
      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) return;
      table.sitIn(seatId);
      broadcastTable(table);
      if (table.canStartHand()) table.startNextHand();
    });

    socket.on('join-waitlist', (): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to join the waitlist.');
      const result = table.joinWaitlist(data.userId, data.displayName ?? 'Player');
      if (!result.ok) return emitError(result.code, result.message);
      broadcastTable(table);
    });

    socket.on('leave-waitlist', (): void => {
      const table = currentTable();
      if (!table || !data.userId) return;
      table.leaveWaitlist(data.userId);
      broadcastTable(table);
    });

    socket.on('rebuy', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return;
      const parsed = RebuySchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed rebuy payload.');
      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) return;
      const engineSeat = table.state.seats[seatId];
      if (!engineSeat) return;
      const cap = table.settings.maxBuyIn - engineSeat.stack;
      const amount = Math.min(parsed.data.amount, Math.max(cap, 0));
      if (amount <= 0) return;
      const userId = data.userId;
      void (async () => {
        const user = await deps.store.findUserById(userId);
        if (!user || user.chips < amount) return emitError('INSUFFICIENT_CHIPS', 'Not enough chips.');
        try {
          table.rebuy(seatId, amount);
        } catch (err) {
          return emitError('CANNOT_REBUY', err instanceof Error ? err.message : 'Cannot rebuy right now.');
        }
        await deps.store.adjustUserChips(user.id, -amount);
        await deps.store.recordLedgerEntries([
          { userId: user.id, isHouse: false, amount: -amount, reason: 'buy_in', tableId: table.tableId },
          { userId: null, isHouse: true, amount, reason: 'buy_in', tableId: table.tableId },
        ]);
        broadcastTable(table);
      })();
    });

    socket.on('action', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'Not authenticated.');
      if (!actionLimiter.consume(socket.id)) return emitError('RATE_LIMITED', 'Slow down.');
      const parsed = PlayerActionIntentSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed action payload.');

      // Server assigns the acting seat from the authenticated session — never trusts a seat id in the payload.
      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) return emitError('NOT_SEATED', 'You are not seated at this table.');

      const result = table.submitAction(seatId, parsed.data);
      if (!result.ok) socket.emit('error', { code: result.code, message: result.message });
      // The successful path's broadcast already happened via LiveTable's onBroadcast -> registry callback above.
    });

    socket.on('chat', (raw: unknown): void => {
      const table = currentTable();
      if (!table) return;
      if (!chatLimiter.consume(socket.id)) return emitError('RATE_LIMITED', 'Slow down.');
      const parsed = ChatMessageSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed chat payload.');

      if (data.userId && table.settings.disableChatInHand) {
        const seatId = table.seatOfUser(data.userId);
        const engineSeat = seatId !== null ? table.state.seats[seatId] : null;
        if (engineSeat && (engineSeat.status === 'active' || engineSeat.status === 'all-in') && table.state.phase === 'in-hand') {
          return emitError('CHAT_DISABLED_IN_HAND', 'Chat is disabled for players still in the hand.');
        }
      }

      const filtered = filterProfanity(parsed.data.message, true);
      void deps.store.recordChatMessage(table.tableId, data.userId, filtered).then((record) => {
        io.to(spectatorRoom(table.tableId)).emit('chat', record);
        for (const seat of table.seats) {
          if (seat.userId) io.to(seatRoom(table.tableId, seat.seatId)).emit('chat', record);
        }
      });
    });

    socket.on('rtc-join', (): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'Sign in to use voice/video.');
      let participants = voiceParticipants.get(table.tableId);
      if (!participants) {
        participants = new Map();
        voiceParticipants.set(table.tableId, participants);
      }
      const me: VoiceParticipant = { socketId: socket.id, userId: data.userId, displayName: data.displayName ?? 'Player' };
      const existing = [...participants.values()];
      participants.set(socket.id, me);
      // Only the newcomer initiates offers, to existing peers — this is
      // the one asymmetry that avoids both sides racing to create an
      // offer for the same pair ("glare").
      socket.emit('rtc-peers', existing);
      for (const p of existing) io.to(p.socketId).emit('rtc-peer-joined', me);
    });

    socket.on('rtc-leave', (): void => {
      const table = currentTable();
      if (!table) return;
      removeVoiceParticipant(table.tableId, socket.id);
    });

    socket.on('rtc-signal', (raw: unknown): void => {
      const table = currentTable();
      if (!table) return;
      const parsed = RtcSignalSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed rtc-signal payload.');
      const participants = voiceParticipants.get(table.tableId);
      // Both ends must be registered voice participants of THIS table —
      // otherwise this relay could be used to message an arbitrary socket.
      if (!participants?.has(socket.id) || !participants.has(parsed.data.to)) return;
      io.to(parsed.data.to).emit('rtc-signal', { from: socket.id, data: parsed.data.data });
    });

    socket.on('disconnect', () => {
      if (data.userId) {
        const table = currentTable();
        if (table) {
          table.setConnected(data.userId, false);
          broadcastTable(table);
        }
      }
      if (joinedTableId) removeVoiceParticipant(joinedTableId, socket.id);
    });
  });

  return { io, registry };
}

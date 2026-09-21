import type { Server as HttpServer } from 'node:http';
import type { GameEvent } from '@pokerclause/engine';
import {
  AddBotSchema,
  AdminRebuySchema,
  AssignSeatSchema,
  ChatMessageSchema,
  JoinTableSchema,
  PlayerActionIntentSchema,
  projectEvent,
  RedeemAssignmentSchema,
  RemoveBotSchema,
  RtcSignalSchema,
  TakeSeatSchema,
} from '@pokerclause/shared';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/session.js';
import type { Store } from '../db/store.js';
import type { LiveTable } from '../game/liveTable.js';
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
/**
 * Every admin socket joins this too (in ADDITION to its normal seat/
 * spectator room — see join-table below, kept for everything ELSE room
 * membership drives: voice signaling, eviction on reset, etc.) and gets
 * its 'state' updates from here instead — a projection with
 * `viewerIsAdmin: true` (owner-only `ownerNickname` fields included —
 * see projection.ts). Every broadcast excludes this room from the
 * regular seat/spectator emit via `.except(adminRoom(...))`
 * specifically so the admin socket gets exactly ONE 'state' event per
 * update, never two — see broadcastAdminView's own doc comment for why
 * that mattered in practice, not just in theory.
 */
function adminRoom(tableId: string): string {
  return `table:${tableId}:admin`;
}

/**
 * Moves every socket currently in a seat's room into the shared
 * spectator room, and out of the seat room — for when a player is
 * evicted from a seat by something OTHER than their own leave-table
 * click (an admin reset, or the table filling back up after they left
 * naturally). Without this, that socket's room membership goes stale:
 * `broadcastTable` only ever targets rooms for CURRENTLY-seated userIds
 * plus the spectator room, so a socket left behind in a now-empty seat's
 * room would silently stop receiving any further 'state' updates at
 * all — indistinguishable, from that player's side, from the app just
 * being broken.
 */
function evictSeatToSpectator(io: Server, tableId: string, seatId: number): void {
  const room = seatRoom(tableId, seatId);
  io.in(room).socketsJoin(spectatorRoom(tableId));
  io.in(room).socketsLeave(room);
}

const actionLimiter = new RateLimiter(10, 5); // 10 burst, 5/sec refill
const chatLimiter = new RateLimiter(5, 1); // 5 burst, 1/sec refill

export function attachSocketServer(
  httpServer: HttpServer,
  deps: { store: Store; corsOrigin: string; adminUserId: string },
): { io: Server; registry: TableRegistry } {
  const io = new Server(httpServer, {
    cors: { origin: deps.corsOrigin, credentials: true },
  });

  const registry = new TableRegistry(deps.store, (tableId, perSeat, rawEvents) => {
    for (const [seatId, payload] of perSeat) {
      const room = seatId === null ? spectatorRoom(tableId) : seatRoom(tableId, seatId);
      // .except(adminRoom) — see broadcastAdminView's doc comment for why
      // the admin socket must never receive BOTH this emit and that one
      // for the same update.
      io.to(room).except(adminRoom(tableId)).emit('state', { state: payload.state, events: payload.events });
    }
    // Deliberately no auto-continuation into the next hand once phase
    // becomes 'hand-complete' — every hand, including the next one, waits
    // for an explicit 'start-hand' from a seated player. See DECISIONS.md.
    const table = registry.get(tableId);
    if (table) broadcastAdminView(table, rawEvents);
  });

  /**
   * The admin socket's ONLY 'state' event for a given update — never a
   * second one alongside the regular seat/spectator broadcast (both
   * `broadcastTable` and the callback above exclude `adminRoom` from
   * their own `io.to(...)` via `.except()`, specifically so this is the
   * only place admin ever gets one). Two emissions per update for the
   * same socket looked harmless (a persistent `.on('state', ...)`
   * listener just re-renders twice, second one winning) but was a real
   * bug for anything using a ONE-SHOT listener assuming exactly one
   * event per action — a leftover second event from the PREVIOUS action
   * could get consumed by a `.once()` registered for the NEXT one. Found
   * via real flakiness in socketServer.test.ts, not by inspection — see
   * DECISIONS.md.
   *
   * `rawEvents` (only ever non-empty from the hand-driven callback above
   * — take-seat/add-bot/etc. never carry real game events, same as
   * their own regular broadcast) gets redacted for the admin's own
   * seat the exact same way `perSeat`'s entries already are for every
   * other viewer — via `projectEvent`. Skipping this and hardcoding
   * `events: []` here was a real bug: it's what the client's deal/chip/
   * win animations are driven by, so the admin socket went from
   * "receives them via the regular broadcast it used to also get" to
   * "never receives them at all" the moment `.except(adminRoom)` above
   * stopped that regular broadcast from reaching it too.
   */
  function broadcastAdminView(table: LiveTable, rawEvents: readonly GameEvent[] = []): void {
    const adminSeatId = table.seatOfUser(deps.adminUserId);
    const events = rawEvents.flatMap((e) => projectEvent(e, adminSeatId));
    io.to(adminRoom(table.tableId)).emit('state', { state: table.projectionFor(adminSeatId, true), events });
  }

  /**
   * Terminates a table for good — notifies everyone still connected to
   * it (every occupied seat's room, plus spectators) with a
   * 'table-closed' event before actually removing it from the registry,
   * refunds every seated human's current stack back to their chip
   * balance (same as leaving individually would; bots have no real
   * ledger to refund — see DECISIONS.md), then disposes it. Used both by
   * the owner's explicit "Terminate table" action and by the automatic
   * rule that a table with no human players left has no reason to keep
   * existing.
   */
  async function closeTableWithNotice(tableId: string, reason: string): Promise<void> {
    const table = registry.get(tableId);
    if (!table) return;
    const humanSeats = table.seats.filter((s) => s.userId !== null);
    for (const seat of humanSeats) {
      const engineSeat = table.state.seats[seat.seatId];
      if (!engineSeat) continue;
      await deps.store.adjustUserChips(seat.userId!, engineSeat.stack);
      await deps.store.recordLedgerEntries([
        { userId: seat.userId, isHouse: false, amount: engineSeat.stack, reason: 'cash_out', tableId },
        { userId: null, isHouse: true, amount: -engineSeat.stack, reason: 'cash_out', tableId },
      ]);
    }
    const rooms = [spectatorRoom(tableId), ...humanSeats.map((s) => seatRoom(tableId, s.seatId))];
    for (const room of rooms) io.to(room).emit('table-closed', { reason });
    await registry.close(tableId);
  }

  function broadcastTable(table: LiveTable): void {
    for (const viewer of [...table.seats.filter((s) => s.userId !== null).map((s) => s.seatId), null]) {
      const room = viewer === null ? spectatorRoom(table.tableId) : seatRoom(table.tableId, viewer);
      io.to(room).except(adminRoom(table.tableId)).emit('state', { state: table.projectionFor(viewer), events: [] });
    }
    broadcastAdminView(table);
  }

  /**
   * The actual chip-debit + seat-fill + room-join + broadcast, shared by
   * 'take-seat' (the owner seating themselves directly) and
   * 'redeem-seat-assignment' (a human redeeming an owner-generated
   * invite link) — identical either way once seatId/buyIn are known, the
   * only difference is where those two numbers came from.
   */
  async function performTakeSeat(
    table: LiveTable,
    socket: Socket,
    userId: string,
    seatId: number,
    buyIn: number,
    ownerNickname: string | null = null,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const user = await deps.store.findUserById(userId);
    if (!user) return { ok: false, code: 'USER_NOT_FOUND', message: 'User not found.' };
    if (user.chips < buyIn) return { ok: false, code: 'INSUFFICIENT_CHIPS', message: 'Not enough chips for that buy-in.' };
    try {
      table.takeSeat(
        seatId,
        user.id,
        { displayName: user.displayName, isGuest: user.isGuest, avatarSeed: user.avatarSeed, clientSeed: user.clientSeed },
        buyIn,
        ownerNickname,
      );
    } catch (err) {
      return { ok: false, code: 'SEAT_TAKEN', message: err instanceof Error ? err.message : 'Seat unavailable.' };
    }
    await deps.store.adjustUserChips(user.id, -buyIn);
    await deps.store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: -buyIn, reason: 'buy_in', tableId: table.tableId },
      { userId: null, isHouse: true, amount: buyIn, reason: 'buy_in', tableId: table.tableId },
    ]);
    void socket.join(seatRoom(table.tableId, seatId));
    void socket.leave(spectatorRoom(table.tableId));
    broadcastTable(table);
    return { ok: true };
  }

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

    function currentTable(): LiveTable | null {
      return joinedTableId ? registry.get(joinedTableId) : null;
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
      // Stays joined for the lifetime of this connection regardless of
      // later seat changes — see adminRoom's own doc comment.
      if (data.role === 'admin') void socket.join(adminRoom(table.tableId));
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

    // Owner-only chip economy (see DECISIONS.md): the ONLY way a regular
    // player ends up seated is by redeeming an owner-generated invite
    // link ('redeem-seat-assignment', below) — this direct path is left
    // open ONLY to the admin/owner account itself, so the owner can seat
    // themselves without needing to invite themselves first.
    socket.on('take-seat', (raw: unknown): void => {
      if (!data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to take a seat.');
      if (data.role !== 'admin') {
        return emitError('SELF_SERVE_DISABLED', 'Only the table owner can seat a player directly — ask them for an invite link.');
      }
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
      const { displayName } = parsed.data;
      void (displayName ? deps.store.updateDisplayName(userId, displayName) : Promise.resolve())
        .then(() => {
          if (displayName) data.displayName = displayName;
          return performTakeSeat(table, socket, userId, seatId, buyIn);
        })
        .then((result) => {
          if (!result.ok) emitError(result.code, result.message);
          // Deliberately does NOT auto-deal, even once enough players are
          // seated — a seated player must explicitly trigger 'start-hand'
          // (the "Play Hand" button). See DECISIONS.md.
        });
    });

    socket.on('redeem-seat-assignment', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to join with an invite link.');
      const parsed = RedeemAssignmentSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed redeem payload.');
      if (table.seatOfUser(data.userId) !== null) return emitError('ALREADY_SEATED', 'You already have a seat at this table.');
      const redeemed = table.redeemSeatAssignment(parsed.data.token);
      if (!redeemed.ok) return emitError(redeemed.code, redeemed.message);
      const userId = data.userId;
      void performTakeSeat(table, socket, userId, redeemed.seatId, redeemed.buyIn, redeemed.ownerNickname).then((result) => {
        if (!result.ok) emitError(result.code, result.message);
      });
    });

    socket.on('assign-seat', (raw: unknown, callback?: (result: { ok: true; token: string } | { ok: false; code: string; message: string }) => void): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') {
        callback?.({ ok: false, code: 'ADMIN_REQUIRED', message: 'Only the table owner can assign a seat.' });
        return;
      }
      const parsed = AssignSeatSchema.safeParse(raw);
      if (!parsed.success) {
        callback?.({ ok: false, code: 'INVALID_PAYLOAD', message: 'Malformed assign-seat payload.' });
        return;
      }
      const result = table.createSeatAssignment(parsed.data.seatId, parsed.data.buyIn, parsed.data.nickname?.trim() || null);
      callback?.(result);
    });

    socket.on('add-bot', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to add a computer player.');
      if (data.role !== 'admin') return emitError('ADMIN_REQUIRED', 'Only the table owner can add a computer player.');
      const parsed = AddBotSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed add-bot payload.');
      const { seatId, persona, buyIn } = parsed.data;
      if (buyIn < table.settings.minBuyIn || buyIn > table.settings.maxBuyIn) {
        return emitError('BUY_IN_OUT_OF_RANGE', `Buy-in must be between ${String(table.settings.minBuyIn)} and ${String(table.settings.maxBuyIn)}.`);
      }
      const result = table.addBot(seatId, persona, buyIn);
      if (!result.ok) return emitError(result.code, result.message);
      broadcastTable(table);
      // No auto-deal here either — see 'start-hand' below.
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

    // Takes an optional ack callback so the client can wait for the
    // server to actually finish processing before navigating away and
    // tearing down this very socket connection — navigating first would
    // risk the 'leave-table' packet racing the disconnect and never
    // arriving at all, silently leaving the seat (and its chips) stuck.
    // See DECISIONS.md.
    socket.on('leave-table', (callback?: () => void): void => {
      const table = currentTable();
      if (!table || !data.userId) {
        callback?.();
        return;
      }
      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) {
        callback?.();
        return;
      }
      void (async () => {
        try {
          const result = table.leaveSeat(seatId);
          // Without this, this socket's room membership goes stale — see
          // evictSeatToSpectator's doc comment for why that matters.
          void socket.leave(seatRoom(table.tableId, seatId));
          void socket.join(spectatorRoom(table.tableId));
          if (result) {
            await deps.store.adjustUserChips(result.userId, result.stack);
            await deps.store.recordLedgerEntries([
              { userId: result.userId, isHouse: false, amount: result.stack, reason: 'cash_out', tableId: table.tableId },
              { userId: null, isHouse: true, amount: -result.stack, reason: 'cash_out', tableId: table.tableId },
            ]);
          }
          const hasHuman = table.seats.some((s) => s.userId !== null);
          if (!hasHuman) {
            await closeTableWithNotice(table.tableId, 'All players left.');
          } else {
            broadcastTable(table);
          }
          callback?.();
        } catch (err) {
          socket.emit('error', { code: 'CANNOT_LEAVE', message: err instanceof Error ? err.message : 'Cannot leave right now.' });
        }
      })();
    });

    socket.on('terminate-table', (callback?: () => void): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') return emitError('ADMIN_REQUIRED', 'Only the table owner can terminate a table.');
      void closeTableWithNotice(table.tableId, 'Table terminated by the owner.').then(() => callback?.());
    });

    socket.on('reset-table', (callback?: () => void): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') return emitError('ADMIN_REQUIRED', 'Only the table owner can reset a table.');
      const previousSeatIds = table.seats.filter((s) => s.userId !== null).map((s) => s.seatId);
      void (async () => {
        const refunds = table.resetTable();
        for (const r of refunds) {
          await deps.store.adjustUserChips(r.userId, r.stack);
          await deps.store.recordLedgerEntries([
            { userId: r.userId, isHouse: false, amount: r.stack, reason: 'cash_out', tableId: table.tableId },
            { userId: null, isHouse: true, amount: -r.stack, reason: 'cash_out', tableId: table.tableId },
          ]);
        }
        // Every previously-seated player's socket is still in its old
        // (now-empty) seat room unless it explicitly left — move it to
        // the spectator room so it keeps receiving updates, then push
        // the fresh state directly to everyone who was affected.
        for (const seatId of previousSeatIds) evictSeatToSpectator(io, table.tableId, seatId);
        const freshState = table.projectionFor(null);
        io.to(spectatorRoom(table.tableId)).emit('state', { state: freshState, events: [] });
        callback?.();
      })();
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
      // No auto-deal here either — see 'start-hand' below.
    });

    socket.on('start-hand', (): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to start a hand.');
      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) return emitError('NOT_SEATED', 'You must be seated to start a hand.');
      if (!table.canStartHand()) {
        return emitError('CANNOT_START_HAND', 'Need at least two seated players, including one real human, and no hand already in progress.');
      }
      // prepareNextOrbit is a harmless no-op before a table's very first
      // hand (fresh seats have nothing to refill/apply) and is required
      // before every hand after the first (time-bank refill, queued
      // sit-outs, auto-sit-out of busted seats) — always safe to call
      // right before dealing, first hand or not.
      table.prepareNextOrbit();
      table.startNextHand(); // broadcasts internally; no separate broadcastTable call needed here.
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

    // Owner-only (see DECISIONS.md) — a seated player can no longer rebuy
    // themselves; the owner rebuys a specific seat's occupant instead.
    // Still debits that PLAYER's own chip balance (identical ledger
    // mechanics to before), just triggered by the owner, not the player.
    socket.on('admin-rebuy', (raw: unknown): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') return emitError('ADMIN_REQUIRED', 'Only the table owner can rebuy a player.');
      const parsed = AdminRebuySchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed admin-rebuy payload.');
      const { seatId, amount } = parsed.data;
      const engineSeat = table.state.seats[seatId];
      const liveSeat = table.seats[seatId];
      if (!engineSeat || !liveSeat?.userId) return emitError('SEAT_EMPTY', 'That seat has no player to rebuy.');
      const cap = table.settings.maxBuyIn - engineSeat.stack;
      const cappedAmount = Math.min(amount, Math.max(cap, 0));
      if (cappedAmount <= 0) return emitError('CANNOT_REBUY', 'That seat is already at the maximum buy-in.');
      const targetUserId = liveSeat.userId;
      void (async () => {
        const user = await deps.store.findUserById(targetUserId);
        if (!user || user.chips < cappedAmount) return emitError('INSUFFICIENT_CHIPS', 'That player does not have enough chips for this rebuy.');
        try {
          table.rebuy(seatId, cappedAmount);
        } catch (err) {
          return emitError('CANNOT_REBUY', err instanceof Error ? err.message : 'Cannot rebuy right now.');
        }
        await deps.store.adjustUserChips(user.id, -cappedAmount);
        await deps.store.recordLedgerEntries([
          { userId: user.id, isHouse: false, amount: -cappedAmount, reason: 'buy_in', tableId: table.tableId },
          { userId: null, isHouse: true, amount: cappedAmount, reason: 'buy_in', tableId: table.tableId },
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

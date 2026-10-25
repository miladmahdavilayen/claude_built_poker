import type { Server as HttpServer } from 'node:http';
import type { GameEvent } from '@pokerclause/engine';
import {
  AddBotSchema,
  AdminRebuySchema,
  AssignSeatSchema,
  ChatMessageSchema,
  JoinTableSchema,
  MAX_PRACTICE_BOTS,
  PlayerActionIntentSchema,
  projectEvent,
  RedeemAssignmentSchema,
  RemoveBotSchema,
  RevealHandSchema,
  RtcSignalSchema,
  SeatTargetSchema,
  TakeSeatSchema,
  UpdateTableSettingsSchema,
  type UpdateTableSettingsIntent,
} from '@pokerclause/shared';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/session.js';
import type { Store } from '../db/store.js';
import type { LiveTable, VacatedSeat } from '../game/liveTable.js';
import { TableRegistry } from '../game/tableRegistry.js';
import { inviteLockout } from '../security/lockouts.js';
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

/**
 * The visitor's address. Behind the production proxy (TRUST_PROXY set —
 * see index.ts) the socket's own peer is the proxy, so the real client is
 * the last X-Forwarded-For entry: the one our own proxy wrote, which a
 * client can't forge (anything it sends itself lands further left).
 */
function clientIp(socket: Socket): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (process.env.TRUST_PROXY && typeof forwarded === 'string' && forwarded.length > 0) {
    const hops = forwarded.split(',');
    return (hops[hops.length - 1] ?? '').trim() || socket.handshake.address;
  }
  return socket.handshake.address;
}

/**
 * How long a practice table waits for its player to come back after their
 * last connection to it drops (a reload, a flaky network, a closed tab)
 * before it closes — refunding their stack and deleting the table, exactly
 * like leaving. Env-overridable for tests.
 */
function practiceAbandonMs(): number {
  return Number(process.env.PRACTICE_ABANDON_MS ?? 120_000);
}

/** A signed-in player who isn't the admin: they play only at their own practice table (see game/practiceTables.ts). */
function isPracticeOnly(data: SocketData): boolean {
  return data.userId !== null && !data.isGuest && data.role !== 'admin';
}

export function attachSocketServer(
  httpServer: HttpServer,
  deps: { store: Store; corsOrigin: string; adminUserId: string },
): {
  io: Server;
  registry: TableRegistry;
  closeAllTables: () => Promise<void>;
  /** The owner ending a table for good (terminate, or delete from the lobby): everyone's refunded and notified, and it's gone from the lobby. */
  terminateTable: (tableId: string) => Promise<boolean>;
  /** The admin's settings change from the lobby — see routes/admin.ts. Null for an unknown or practice table. */
  updateTableSettings: (tableId: string, patch: UpdateTableSettingsIntent) => ReturnType<LiveTable['updateSettings']> | null;
  closePracticeTableOf: (userId: string) => Promise<void>;
  watchPracticeTable: (tableId: string) => void;
} {
  const io = new Server(httpServer, {
    cors: { origin: deps.corsOrigin, credentials: true },
    // Nothing a client sends (actions, chat, WebRTC SDP/ICE) comes close
    // to this; the 1 MB default just hands a flood more room to work with.
    maxHttpBufferSize: 100_000,
  });

  // Caps how many sockets one address can hold open at once, so a single
  // bot can't exhaust the server by opening connections in a loop. The
  // per-socket action/chat limiters above can't see this: each new socket
  // gets a fresh bucket.
  const maxSocketsPerIp = Number(process.env.SOCKET_CONNECTIONS_PER_IP ?? 30);
  const socketsPerIp = new Map<string, number>();
  io.use((socket, next) => {
    const ip = clientIp(socket);
    const open = socketsPerIp.get(ip) ?? 0;
    if (open >= maxSocketsPerIp) {
      next(new Error('TOO_MANY_CONNECTIONS'));
      return;
    }
    socketsPerIp.set(ip, open + 1);
    socket.once('disconnect', () => {
      const left = (socketsPerIp.get(ip) ?? 1) - 1;
      if (left <= 0) socketsPerIp.delete(ip);
      else socketsPerIp.set(ip, left);
    });
    next();
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
    // A hand ending can free seats (deferred removals) — the waitlist may now be owed one.
    if (table && syncSeatOffer(table)) broadcastTable(table);
  }, (tableId, vacated) => {
    // A deferred owner removal finishing at hand end (see
    // LiveTable.removeSeatOccupant). The table's own end-of-hand broadcast
    // follows right after this returns, so this only moves sockets and
    // settles chips — no broadcast of its own.
    const table = registry.get(tableId);
    if (table) void settleVacatedSeats(table, vacated);
  });

  /**
   * Refunds each vacated human's chips (stack + any pending rebuy) to
   * their balance with the same paired cash_out ledger rows as leaving on
   * their own, and moves their socket to spectating so it keeps getting
   * updates (see evictSeatToSpectator). Room moves happen synchronously,
   * before the first await, so they're in place before any broadcast that
   * follows. A practice table closes if that removed its player; a real
   * table stays open, empty or not (see 'leave-table').
   */
  async function settleVacatedSeats(table: LiveTable, vacated: readonly VacatedSeat[]): Promise<void> {
    for (const v of vacated) evictSeatToSpectator(io, table.tableId, v.seatId);
    for (const v of vacated) {
      if (v.userId) await cashOut(table, v.userId, v.refund);
    }
    if (table.isPractice && vacated.some((v) => v.userId) && !table.seats.some((s) => s.userId !== null)) {
      await closeTableWithNotice(table.tableId, 'All players left.');
    }
  }

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
  async function closeTableWithNotice(tableId: string, reason: string, bookReason?: string, keepOpen = false): Promise<void> {
    const table = registry.get(tableId);
    if (!table) return;
    // Book everyone's cash-out and write this game's final report before
    // the table (and its in-memory book) goes away.
    await table.closeBook(bookReason ?? (reason === 'All players left.' ? 'everyone left the table' : 'table terminated by the owner'));
    const humanSeats = table.seats.filter((s) => s.userId !== null);
    for (const seat of humanSeats) await cashOut(table, seat.userId!, table.voidedHandRefund(seat.seatId));
    const rooms = [spectatorRoom(tableId), ...humanSeats.map((s) => seatRoom(tableId, s.seatId))];
    for (const room of rooms) io.to(room).emit('table-closed', { reason });
    await registry.close(tableId, keepOpen);
    clearPracticeAbandonTimer(tableId);
    const offerTimer = seatOfferTimers.get(tableId);
    if (offerTimer) clearTimeout(offerTimer);
    seatOfferTimers.delete(tableId);
    practiceOwnerSockets.delete(tableId);
  }

  // --- Practice tables: the owner's open connections to their own table,
  // and the timer that closes it once the last one has been gone a while
  // (see practiceAbandonMs). ---
  const practiceOwnerSockets = new Map<string, Set<string>>();
  const practiceAbandonTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearPracticeAbandonTimer(tableId: string): void {
    const timer = practiceAbandonTimers.get(tableId);
    if (timer) clearTimeout(timer);
    practiceAbandonTimers.delete(tableId);
  }

  function practiceOwnerConnected(tableId: string, socketId: string): void {
    clearPracticeAbandonTimer(tableId);
    const sockets = practiceOwnerSockets.get(tableId) ?? new Set<string>();
    sockets.add(socketId);
    practiceOwnerSockets.set(tableId, sockets);
  }

  function practiceOwnerDisconnected(tableId: string, socketId: string): void {
    practiceOwnerSockets.get(tableId)?.delete(socketId);
    watchPracticeTable(tableId);
  }

  /**
   * Starts the abandon countdown unless the owner is connected to the
   * table right now. Also called the moment a practice table opens (see
   * POST /tables/practice), so one whose player never arrives — the tab
   * closed before the page connected — doesn't sit there forever holding
   * their buy-in.
   */
  function watchPracticeTable(tableId: string): void {
    if ((practiceOwnerSockets.get(tableId)?.size ?? 0) > 0) return;
    clearPracticeAbandonTimer(tableId);
    const timer = setTimeout(() => {
      practiceAbandonTimers.delete(tableId);
      if ((practiceOwnerSockets.get(tableId)?.size ?? 0) > 0) return;
      void closeTableWithNotice(tableId, 'Your table closed because you were away. Your chips are back in your balance.', 'the player left the table');
    }, practiceAbandonMs());
    timer.unref();
    practiceAbandonTimers.set(tableId, timer);
  }

  /** Closes a player's practice table, if they have one — refunding their stack and deleting it. Used before their account is deleted. */
  async function closePracticeTableOf(userId: string): Promise<void> {
    const table = registry.practiceTableOf(userId);
    if (table) await closeTableWithNotice(table.tableId, 'This account was deleted.', 'the player deleted their account');
  }

  // --- Open-invite waitlist: the held seat's countdown (see LiveTable.syncSeatOffer). ---
  const seatOfferTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Re-evaluates the table's held seat and (re)arms its expiry; returns whether it changed. */
  function syncSeatOffer(table: LiveTable): boolean {
    const changed = table.syncSeatOffer();
    const offer = table.currentSeatOffer;
    const existing = seatOfferTimers.get(table.tableId);
    if (changed || !offer) {
      if (existing) clearTimeout(existing);
      seatOfferTimers.delete(table.tableId);
    }
    if (offer && !seatOfferTimers.has(table.tableId)) {
      const timer = setTimeout(
        () => {
          seatOfferTimers.delete(table.tableId);
          if (registry.get(table.tableId)) broadcastTable(table);
        },
        Math.max(0, offer.expiresAt - Date.now()) + 50,
      );
      timer.unref();
      seatOfferTimers.set(table.tableId, timer);
    }
    return changed;
  }

  /** Saves an owner's change to a table's name, settings or privacy — see LiveTable.updateSettings. */
  function persistTable(table: LiveTable): void {
    void deps.store.updateTable(table.tableId, {
      name: table.name,
      config: table.targetSettings as unknown as Record<string, unknown>,
      inviteCode: table.inviteCode,
    });
  }

  /**
   * The admin's settings change from outside the table (the lobby — see
   * routes/admin.ts): the same rules as the in-table owner menu, then saved
   * and pushed to everyone at the table. Null when there's no such table
   * (practice tables included — those aren't the lobby's to edit).
   */
  function updateTableSettings(tableId: string, patch: UpdateTableSettingsIntent): ReturnType<LiveTable['updateSettings']> | null {
    const table = registry.get(tableId);
    if (!table || table.isPractice) return null;
    const result = table.updateSettings(patch);
    if (result.ok) {
      persistTable(table);
      broadcastTable(table);
    }
    return result;
  }

  function broadcastTable(table: LiveTable): void {
    syncSeatOffer(table);
    for (const viewer of [...table.seats.filter((s) => s.userId !== null).map((s) => s.seatId), null]) {
      const room = viewer === null ? spectatorRoom(table.tableId) : seatRoom(table.tableId, viewer);
      io.to(room).except(adminRoom(table.tableId)).emit('state', { state: table.projectionFor(viewer), events: [] });
    }
    broadcastAdminView(table);
  }

  /**
   * The admin can self-serve seat/add-bot on ANY table; a table's own
   * creator gets that same self-serve ability, but ONLY on the one table
   * they created, and only while genuinely signed in as a non-guest right
   * now (re-checked from the live socket session, not just baked into
   * `ownerId` at creation time — a guest can't create a table at all per
   * the /tables route, but this stays defense-in-depth regardless). This
   * is the one deliberate carve-out from "owner-only chip economy" (see
   * DECISIONS.md): a logged-in human can set up and play a practice table
   * against bots entirely on their own, but still can never invite
   * another real human to any table — 'assign-seat' stays admin-only.
   */
  function canManageTable(table: LiveTable, data: SocketData): boolean {
    if (data.role === 'admin') return true;
    return data.userId !== null && !data.isGuest && table.ownerId !== null && table.ownerId === data.userId;
  }

  /**
   * Table layout and settings (seats, blinds, privacy, invite code). A
   * practice table's owner can add and remove computer players, nothing
   * more — its seat count is what they picked (at most 5), and it has no
   * settings worth changing and no one to invite. The admin keeps every
   * power everywhere.
   */
  function canManageLayout(table: LiveTable, data: SocketData): boolean {
    if (data.role === 'admin') return true;
    return canManageTable(table, data) && !table.isPractice;
  }

  /**
   * The owner allocating chips to a player who doesn't have them — a
   * brand-new Google account starts at $0 by design (see DECISIONS.md),
   * so the owner's invite link or rebuy IS their money. Recorded as an
   * 'admin_adjust' from the house, the same way the starting grant is.
   */
  /**
   * Pays a seat's chips back into its player's balance (ledgered) — and, for
   * a guest, remembers them as what they left this table with: coming back
   * by the same link, they sit down with exactly that (see sitAmountForGuest).
   */
  async function cashOut(table: LiveTable, userId: string, amount: number): Promise<void> {
    if (amount > 0) {
      await deps.store.adjustUserChips(userId, amount);
      await deps.store.recordLedgerEntries([
        { userId, isHouse: false, amount, reason: 'cash_out', tableId: table.tableId },
        { userId: null, isHouse: true, amount: -amount, reason: 'cash_out', tableId: table.tableId },
      ]);
    }
    if (table.isPractice) return;
    const user = await deps.store.findUserById(userId);
    if (user?.isGuest) await deps.store.setGuestStack(userId, table.tableId, amount);
  }

  /**
   * What a guest sits down with: what they left this table with, if they've
   * been here before — otherwise `fresh` (an open-invite table's starting
   * chips, or a seat invite's amount). Null when they left with nothing.
   */
  async function sitAmountForGuest(table: LiveTable, userId: string, fresh: number): Promise<number | null> {
    const kept = await deps.store.getGuestStack(userId, table.tableId);
    if (kept === null) return fresh;
    return kept > 0 ? kept : null;
  }
  const OUT_OF_CHIPS = { ok: false as const, code: 'OUT_OF_CHIPS', message: 'You left this table with no chips — ask the table owner to seat you with more.' };

  async function grantFromOwner(userId: string, amount: number, tableId: string): Promise<void> {
    await deps.store.adjustUserChips(userId, amount);
    await deps.store.recordLedgerEntries([
      { userId, isHouse: false, amount, reason: 'admin_adjust', tableId },
      { userId: null, isHouse: true, amount: -amount, reason: 'admin_adjust', tableId },
    ]);
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
    ownerFunded = false,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const user = await deps.store.findUserById(userId);
    if (!user) return { ok: false, code: 'USER_NOT_FOUND', message: 'User not found.' };
    const shortfall = ownerFunded ? Math.max(0, buyIn - user.chips) : 0;
    if (!ownerFunded && user.chips < buyIn) return { ok: false, code: 'INSUFFICIENT_CHIPS', message: 'Not enough chips for that buy-in.' };
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
    if (shortfall > 0) await grantFromOwner(user.id, shortfall, table.tableId);
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
  //
  // Every authenticated human is registered here the moment they join a
  // table (below, in 'join-table') — NOT only once they opt into sending
  // their own mic/camera. Being a "voice participant" now means "can
  // receive a peer connection," a strictly bigger set than "is currently
  // sending anything" — so anyone at the table automatically gets a
  // remote stream the instant another human starts sending, with no
  // separate opt-in of their own required. See DECISIONS.md.
  interface VoiceParticipant {
    socketId: string;
    userId: string;
    displayName: string;
  }
  const voiceParticipants = new Map<string, Map<string, VoiceParticipant>>();

  /** Idempotent — a reconnect or a duplicate join-table for the same live socket is a harmless no-op, not a re-announcement. */
  function registerVoiceParticipant(tableId: string, socket: Socket, userId: string, displayName: string): void {
    let participants = voiceParticipants.get(tableId);
    if (!participants) {
      participants = new Map();
      voiceParticipants.set(tableId, participants);
    }
    if (participants.has(socket.id)) return;
    const me: VoiceParticipant = { socketId: socket.id, userId, displayName };
    const existing = [...participants.values()];
    participants.set(socket.id, me);
    // Only the newcomer initiates offers, to existing peers — this is the
    // one asymmetry that avoids both sides racing to create an offer for
    // the same pair ("glare"). Sent even to a peer with nothing to send
    // yet: an empty-track connection is cheap, and it means whichever
    // side sends media FIRST doesn't need to wait on the other side to
    // also "join a call" — the connection already exists to carry it.
    socket.emit('rtc-peers', existing);
    for (const p of existing) io.to(p.socketId).emit('rtc-peer-joined', me);
  }

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
    /** Open-invite tables this connection joined with the right link — it may pick its own seat and join the waitlist there. */
    const openAccess = new Set<string>();

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

      // A practice table is visible to its owner and the admin, no one
      // else. A practice-only player sees no other table at all.
      const isPracticeOwner = table.isPractice && data.userId !== null && data.userId === table.ownerId;
      if (table.isPractice && !isPracticeOwner && data.role !== 'admin') return emitError('TABLE_NOT_FOUND', 'Table not found.');
      const seatId = data.userId ? table.seatOfUser(data.userId) : null;
      const hasCode = parsed.data.inviteCode !== undefined && parsed.data.inviteCode === table.inviteCode;
      // An open-invite table's link is an invitation for anyone, a signed-in
      // player included (their practice-only rule is about public tables).
      const openInvited = table.openSeating && (hasCode || seatId !== null);
      if (!table.isPractice && isPracticeOnly(data) && !openInvited) {
        return emitError('PRACTICE_ONLY', 'Your account plays at your own table against computer players — start one from the lobby.');
      }
      if (!table.isPractice && table.settings.isPrivate && seatId === null && !hasCode && data.role !== 'admin') {
        // A shareable link is worth guessing at: wrong codes count toward the per-IP lockout.
        const ip = clientIp(socket);
        if (inviteLockout.retryAfterMs(ip) > 0) return emitError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.');
        inviteLockout.recordFailure(ip);
        return emitError('INVALID_INVITE_CODE', 'This table is private. Provide the correct invite code to join.');
      }
      if (table.openSeating && (openInvited || data.role === 'admin')) openAccess.add(table.tableId);
      if (isPracticeOwner) practiceOwnerConnected(table.tableId, socket.id);

      joinedTableId = table.tableId;
      void socket.join(seatId !== null ? seatRoom(table.tableId, seatId) : spectatorRoom(table.tableId));
      // Stays joined for the lifetime of this connection regardless of
      // later seat changes — see adminRoom's own doc comment.
      if (data.role === 'admin') void socket.join(adminRoom(table.tableId));
      if (data.userId) table.setConnected(data.userId, true);
      // One-shot, not part of the shared per-room 'state' broadcast:
      // whether THIS viewer can self-serve seat themselves / add bots on
      // THIS table never changes over the connection's lifetime (role,
      // guest status, and the table's fixed ownerId are all static), and a
      // spectating table creator has no seat/room of their own to target a
      // "canManage" field on a shared projection to in the first place.
      // See canManageTable's own doc comment.
      socket.emit('table-permissions', {
        canManageTable: canManageTable(table, data),
        canManageLayout: canManageLayout(table, data),
        isPractice: table.isPractice,
        // Open-invite tables: anyone who came with the link picks their own seat.
        canTakeSeat: data.userId !== null && openAccess.has(table.tableId),
      });
      // See registerVoiceParticipant's own doc comment — every human is
      // receive-ready from the moment they're at the table, not only once
      // they opt into sending their own mic/camera.
      if (data.userId) registerVoiceParticipant(table.tableId, socket, data.userId, data.displayName ?? 'Player');

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
    // player ends up seated at someone ELSE's table is by redeeming an
    // owner-generated invite link ('redeem-seat-assignment', below) — this
    // direct path is otherwise open only to the admin/owner account, OR to
    // a signed-in non-guest human seating themselves at a table they
    // created (see canManageTable's own doc comment).
    socket.on('take-seat', (raw: unknown): void => {
      if (!data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to take a seat.');
      const parsed = TakeSeatSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed take-seat payload.');
      const table = registry.get(parsed.data.tableId);
      if (!table) return emitError('TABLE_NOT_FOUND', 'Table not found.');
      if (!actionLimiter.consume(socket.id)) return emitError('RATE_LIMITED', 'Slow down.');
      // Anyone who came with an open-invite table's link seats themselves.
      const openSeat = !canManageTable(table, data) && openAccess.has(table.tableId);
      if (!canManageTable(table, data) && !openSeat) {
        return emitError('SELF_SERVE_DISABLED', 'Only the table owner can seat a player directly — ask them for an invite link.');
      }
      if (table.openSeating && data.role !== 'admin' && !table.canTakeOpenSeat(data.userId)) {
        return emitError('SEAT_HELD', 'That seat is being held for the next person on the waitlist — join the waitlist to get the next one.');
      }
      // Only the player who owns a practice table ever sits at it.
      if (table.isPractice && data.userId !== table.ownerId) {
        return emitError('PRACTICE_TABLE', 'Only computer players can join this table.');
      }

      // Per-table one-session rule: the same account cannot occupy two seats at one table.
      if (table.seatOfUser(data.userId) !== null) {
        return emitError('ALREADY_SEATED', 'You already have a seat at this table.');
      }
      const { seatId } = parsed.data;
      // A guest by an open-invite link doesn't choose a buy-in: they sit
      // with the table's starting chips the first time, and with whatever
      // they left with after that (see sitAmountForGuest).
      const openGuest = openSeat && data.isGuest && table.settings.openSeatStack !== undefined;
      if (!openGuest) {
        const range = table.checkBuyInRange(parsed.data.buyIn);
        if (!range.ok) return emitError(range.code, range.message);
      }
      const userId = data.userId;
      const { displayName } = parsed.data;
      void (displayName ? deps.store.updateDisplayName(userId, displayName) : Promise.resolve())
        .then(async () => {
          if (displayName) data.displayName = displayName;
          const buyIn = openGuest ? await sitAmountForGuest(table, userId, table.settings.openSeatStack!) : parsed.data.buyIn;
          if (buyIn === null) return OUT_OF_CHIPS;
          // A guest's buy-in is play money that vanishes with the session, so
          // the owner covers whatever they're short; a signed-in player pays
          // from their own balance (covering them would let them cash the
          // owner's chips out into it).
          return performTakeSeat(table, socket, userId, seatId, buyIn, null, openSeat && data.isGuest);
        })
        .then((result) => {
          if (!result.ok) emitError(result.code, result.message);
          // Deliberately does NOT auto-deal, even once enough players are
          // seated — a seated player must explicitly trigger 'start-hand'
          // (the "Play Hand" button). See DECISIONS.md.
        });
    });

    socket.on('redeem-seat-assignment', (raw: unknown): void => {
      // Checked first: a practice-only player's join-table was already
      // refused, and that's the message they should keep seeing.
      if (isPracticeOnly(data)) {
        return emitError('PRACTICE_ONLY', 'Your account plays at your own table against computer players — start one from the lobby.');
      }
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'You must be signed in to join with an invite link.');
      const parsed = RedeemAssignmentSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed redeem payload.');
      if (table.isPractice) return emitError('PRACTICE_TABLE', 'Only computer players can join this table.');
      if (table.seatOfUser(data.userId) !== null) return emitError('ALREADY_SEATED', 'You already have a seat at this table.');
      const redeemed = table.redeemSeatAssignment(parsed.data.token, data.userId);
      if (!redeemed.ok) return emitError(redeemed.code, redeemed.message);
      const userId = data.userId;
      // The owner chose this seat AND this amount — anything the invitee
      // can't cover from their own balance is covered by the owner, so an
      // invite always seats them. Coming back by it, they sit with what they
      // left with instead (see sitAmountForGuest).
      void (async () => {
        const buyIn = redeemed.returning ? await sitAmountForGuest(table, userId, redeemed.buyIn) : redeemed.buyIn;
        const result = buyIn === null ? OUT_OF_CHIPS : await performTakeSeat(table, socket, userId, redeemed.seatId, buyIn, redeemed.ownerNickname, true);
        if (!result.ok) emitError(result.code, result.message);
      })();
    });

    socket.on('assign-seat', (raw: unknown, callback?: (result: { ok: true; token: string } | { ok: false; code: string; message: string }) => void): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') {
        callback?.({ ok: false, code: 'ADMIN_REQUIRED', message: 'Only the table owner can assign a seat.' });
        return;
      }
      if (table.isPractice) {
        callback?.({ ok: false, code: 'PRACTICE_TABLE', message: 'Only computer players can join a practice table.' });
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
      if (!canManageTable(table, data)) return emitError('ADMIN_REQUIRED', 'Only the table owner can add a computer player.');
      const parsed = AddBotSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed add-bot payload.');
      const { seatId, persona, buyIn } = parsed.data;
      const range = table.checkBuyInRange(buyIn);
      if (!range.ok) return emitError(range.code, range.message);
      const result = table.addBot(seatId, persona, buyIn);
      if (!result.ok) return emitError(result.code, result.message);
      broadcastTable(table);
      // No auto-deal here either — see 'start-hand' below.
    });

    socket.on('remove-bot', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return;
      if (!canManageTable(table, data)) return emitError('ADMIN_REQUIRED', 'Only the table owner can remove a computer player.');
      const parsed = RemoveBotSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed remove-bot payload.');
      const result = table.removeBot(parsed.data.seatId);
      if (!result.ok) return emitError(result.code, result.message);
      broadcastTable(table);
    });

    // --- Owner table controls: everything below works mid-hand. ---

    /**
     * Who may change a given seat: removing/deleting a seat that holds a
     * real human is part of the chip economy (it cashes them out), so it's
     * admin-only — same line as assign-seat and admin-rebuy. A bot or an
     * empty seat is table layout, open to anyone who can manage the table.
     */
    function canChangeSeat(table: LiveTable, seatId: number): boolean {
      if (data.role === 'admin') return true;
      return canManageLayout(table, data) && !table.seats[seatId]?.userId;
    }

    type Ack = (result: { ok: true; deferred?: boolean; seatId?: number } | { ok: false; code: string; message: string }) => void;

    socket.on('update-table-settings', (raw: unknown, callback?: Ack): void => {
      const table = currentTable();
      if (!table || !canManageLayout(table, data)) {
        callback?.({ ok: false, code: 'ADMIN_REQUIRED', message: 'Only the table owner can change table settings.' });
        return;
      }
      const parsed = UpdateTableSettingsSchema.safeParse(raw);
      if (!parsed.success) {
        callback?.({ ok: false, code: 'INVALID_PAYLOAD', message: 'Invalid table settings.' });
        return;
      }
      const result = table.updateSettings(parsed.data);
      if (!result.ok) {
        callback?.(result);
        return;
      }
      persistTable(table);
      broadcastTable(table);
      callback?.({ ok: true, deferred: result.deferred });
    });

    socket.on('get-invite-code', (callback?: (result: { inviteCode: string | null }) => void): void => {
      const table = currentTable();
      if (!table || !canManageLayout(table, data)) {
        callback?.({ inviteCode: null });
        return;
      }
      callback?.({ inviteCode: table.settings.isPrivate ? table.inviteCode : null });
    });

    socket.on('add-seat', (callback?: Ack): void => {
      const table = currentTable();
      if (!table || !canManageLayout(table, data)) {
        callback?.({ ok: false, code: 'ADMIN_REQUIRED', message: 'Only the table owner can add a seat.' });
        return;
      }
      if (table.isPractice && table.visibleSeatCount >= MAX_PRACTICE_BOTS + 1) {
        callback?.({ ok: false, code: 'TOO_MANY_SEATS', message: `A practice table has at most ${String(MAX_PRACTICE_BOTS + 1)} seats.` });
        return;
      }
      const result = table.addSeat();
      if (result.ok) {
        persistTable(table);
        broadcastTable(table);
      }
      callback?.(result);
    });

    for (const [event, deleteSeat] of [
      ['remove-player', false],
      ['delete-seat', true],
    ] as const) {
      socket.on(event, (raw: unknown, callback?: Ack): void => {
        const table = currentTable();
        const parsed = SeatTargetSchema.safeParse(raw);
        if (!table || !parsed.success) {
          callback?.({ ok: false, code: 'INVALID_PAYLOAD', message: 'Malformed seat payload.' });
          return;
        }
        const { seatId } = parsed.data;
        if (!canChangeSeat(table, seatId)) {
          callback?.({ ok: false, code: 'ADMIN_REQUIRED', message: 'Only the table owner can do that.' });
          return;
        }
        const result = deleteSeat ? table.deleteSeat(seatId) : table.removeSeatOccupant(seatId, false);
        if (!result.ok) {
          callback?.(result);
          return;
        }
        if (deleteSeat) persistTable(table);
        if (result.vacated) {
          void settleVacatedSeats(table, [result.vacated]).then(() => {
            if (registry.get(table.tableId)) broadcastTable(table);
          });
        } else {
          broadcastTable(table);
        }
        callback?.({ ok: true });
      });
    }

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
          if (result) await cashOut(table, result.userId, result.stack);
          // Only a practice table ends when its player leaves (and is
          // deleted). Every real table — the default ones above all — stays
          // in the lobby, empty or not, until the owner terminates it. With
          // no human seated, no hand can start, so leftover bots just wait.
          if (table.isPractice && !table.seats.some((s) => s.userId !== null)) {
            await closeTableWithNotice(table.tableId, 'All players left.');
          } else {
            broadcastTable(table);
          }
          callback?.();
        } catch (err) {
          const midHand = err instanceof Error && err.message === 'CANNOT_LEAVE_MID_HAND';
          socket.emit('error', {
            code: 'CANNOT_LEAVE',
            message: midHand ? 'You can leave once you fold or this hand ends.' : err instanceof Error ? err.message : 'Cannot leave right now.',
          });
        }
      })();
    });

    socket.on('terminate-table', (callback?: () => void): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') return emitError('ADMIN_REQUIRED', 'Only the table owner can terminate a table.');
      void terminateTable(table.tableId).then(() => callback?.());
    });

    socket.on('reset-table', (callback?: () => void): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') return emitError('ADMIN_REQUIRED', 'Only the table owner can reset a table.');
      const previousSeatIds = table.seats.filter((s) => s.userId !== null).map((s) => s.seatId);
      void (async () => {
        const refunds = table.resetTable();
        for (const r of refunds) await cashOut(table, r.userId, r.stack);
        // Every previously-seated player's socket is still in its old
        // (now-empty) seat room unless it explicitly left — move it to
        // the spectator room so it keeps receiving updates, then push
        // the fresh state directly to everyone who was affected.
        for (const seatId of previousSeatIds) evictSeatToSpectator(io, table.tableId, seatId);
        syncSeatOffer(table);
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
      if (table.isPractice) return emitError('PRACTICE_TABLE', 'Only computer players can join this table.');
      if (!actionLimiter.consume(socket.id)) return emitError('RATE_LIMITED', 'Slow down.');
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
    // Works any time, mid-hand included: a seat still in the hand gets
    // the chips the moment that hand ends (see LiveTable.addChips). The
    // player is debited right away either way, so a pending rebuy is
    // always part of what they're refunded if they leave first.
    socket.on('admin-rebuy', (raw: unknown): void => {
      const table = currentTable();
      if (!table) return;
      if (data.role !== 'admin') return emitError('ADMIN_REQUIRED', 'Only the table owner can rebuy a player.');
      const parsed = AdminRebuySchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed admin-rebuy payload.');
      const { seatId, amount } = parsed.data;
      const engineSeat = table.state.seats[seatId];
      const liveSeat = table.seats[seatId];
      if (!engineSeat || !liveSeat || engineSeat.status === 'empty') return emitError('SEAT_EMPTY', 'That seat has no player to rebuy.');
      if (liveSeat.pendingRemoval) return emitError('CANNOT_REBUY', 'That player is leaving after this hand.');
      const cappedAmount = Math.min(amount, table.rebuyHeadroom(seatId));
      if (cappedAmount <= 0) return emitError('CANNOT_REBUY', 'That seat already holds the most chips a player can have.');
      // A computer player's chips aren't anyone's balance — nothing to debit.
      if (!liveSeat.userId) {
        table.addChips(seatId, cappedAmount);
        broadcastTable(table);
        return;
      }
      const targetUserId = liveSeat.userId;
      void (async () => {
        const user = await deps.store.findUserById(targetUserId);
        if (!user) return emitError('USER_NOT_FOUND', 'That player no longer exists.');
        // Same as an invite: the owner covers whatever the player can't.
        const shortfall = Math.max(0, cappedAmount - user.chips);
        // Re-checked after the await: the player may have left meanwhile.
        // The chips go onto the table synchronously, right here — never
        // after the writes below, or a player leaving during them would be
        // debited for chips that never reached their seat (and so never
        // came back in their refund).
        if (table.seats[seatId]?.userId !== targetUserId) return emitError('SEAT_EMPTY', 'That player is no longer seated.');
        table.addChips(seatId, cappedAmount);
        broadcastTable(table);
        if (shortfall > 0) await grantFromOwner(user.id, shortfall, table.tableId);
        await deps.store.adjustUserChips(user.id, -cappedAmount);
        await deps.store.recordLedgerEntries([
          { userId: user.id, isHouse: false, amount: -cappedAmount, reason: 'buy_in', tableId: table.tableId },
          { userId: null, isHouse: true, amount: cappedAmount, reason: 'buy_in', tableId: table.tableId },
        ]);
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

    socket.on('reveal-hand', (raw: unknown): void => {
      const table = currentTable();
      if (!table || !data.userId) return emitError('AUTH_REQUIRED', 'Not authenticated.');
      const parsed = RevealHandSchema.safeParse(raw);
      if (!parsed.success) return emitError('INVALID_PAYLOAD', 'Malformed reveal-hand payload.');

      const seatId = table.seatOfUser(data.userId);
      if (seatId === null) return emitError('NOT_SEATED', 'You are not seated at this table.');

      const result = table.revealHand(seatId, parsed.data.handId);
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

    // No 'rtc-join'/'rtc-leave' events anymore — registerVoiceParticipant
    // (called from 'join-table' above) covers what 'rtc-join' used to do,
    // automatically; "leaving a call" is now purely local to the browser
    // (stop sending tracks — see useVoiceChat.ts), not a server concept,
    // since it must NOT stop this socket from still being able to
    // RECEIVE others. Deregistration still happens, just from
    // 'disconnect'/'leave-table' (below) instead. See DECISIONS.md.
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
          if (table.isPractice && table.ownerId === data.userId) practiceOwnerDisconnected(table.tableId, socket.id);
        }
      }
      if (joinedTableId) removeVoiceParticipant(joinedTableId, socket.id);
    });
  });

  /**
   * Live tables only exist in this process's memory, so a shutdown (every
   * deploy restarts the server) ends them all. Closing each one exactly
   * like the owner terminating it returns every seated player's chips to
   * their balance and writes the game's final report — instead of
   * stranding the chips and leaving the report "live" forever.
   */
  async function closeAllTables(): Promise<void> {
    for (const { tableId } of registry.list()) {
      // keepOpen: the table itself comes back on the next boot (see index.ts) — only the game in progress ends.
      await closeTableWithNotice(tableId, 'The server is restarting for an update. Your chips are back in your balance.', 'server restarted for an update', true);
    }
  }

  async function terminateTable(tableId: string): Promise<boolean> {
    if (!registry.get(tableId)) return false;
    await closeTableWithNotice(tableId, 'Table terminated by the owner.');
    return true;
  }

  return { io, registry, closeAllTables, terminateTable, updateTableSettings, closePracticeTableOf, watchPracticeTable };
}

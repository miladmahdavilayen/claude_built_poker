import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  applyAction,
  createTableState,
  fullDeck,
  getLegalActions,
  rankIndex,
  startHand,
  suitOf,
  SUITS,
  type Card,
  type GameEvent,
  type PlayerAction,
  type TableConfig,
  type TableState,
} from '@pokerclause/engine';
import { cryptoSource, shuffle, type RandomSource } from '@pokerclause/rng';
import {
  formatMoney,
  MAX_BALANCE_CENTS,
  projectEvent,
  projectStateForSeat,
  type PendingTableSettings,
  type ProjectedGameEvent,
  type ProjectedTableState,
  type SeatMeta,
  type TableSettings,
  type UpdateTableSettingsIntent,
  type SeatOffer,
  type WaitlistEntry,
} from '@pokerclause/shared';
import { ALL_BOT_POLICIES, projectSeatView, type BotPolicy } from '@pokerclause/sim';
import type { SeatInviteRecord, Store } from '../db/store.js';
import { commitmentFor, deriveDeckForHand, generateServerSeed } from '../rng/commitReveal.js';
import { GameBook, type PlayerKind } from './gameBook.js';

/**
 * Computer players, for practice/solo play — see `addBot`/`removeBot`
 * below. `adversarial` is excluded: it's a QA tool deliberately built to
 * probe engine edge cases (pinned-to-the-boundary raises, chained short
 * all-ins), not a fun or legible opponent for a casual game.
 */
/** How long a free seat is held for the waitlist's first person on an open-invite table. Env-overridable for tests. */
export function seatOfferMs(): number {
  return Number(process.env.SEAT_OFFER_MS ?? 60_000);
}

export const SELECTABLE_BOT_POLICIES: readonly BotPolicy[] = ALL_BOT_POLICIES.filter((p) => p.name !== 'adversarial');

// Deliberately single-word — this is what actually renders on a seat
// (tight on space, especially at a 9-max table or on a phone), not the
// fuller descriptive label a player picks from in the "Add bot" modal
// (see BOT_PERSONAS in apps/web/src/botPersonas.ts, which keeps its own
// longer wording — there's more room in that dropdown, and clarity
// matters more there than brevity).
export const BOT_PERSONA_LABELS: Readonly<Record<string, string>> = {
  'random-legal': 'Wildcard',
  'calling-station': 'Caller',
  nit: 'Nit',
  maniac: 'Maniac',
  'shove-monkey': 'Shover',
  'check-fold': 'Pushover',
  'short-stacker': 'Stacker',
  'allan-keating': 'Keating',
};

// A bot "thinks" for a random 1–6 seconds before acting, so it doesn't
// feel instant/robotic and gives a human opponent time to actually watch
// the hand unfold rather than seeing a wall of actions resolve at once.
const BOT_MOVE_MIN_MS = 1000;
const BOT_MOVE_JITTER_MS = 5001; // nextInt is exclusive of its upper bound, so +1 to include a full 5000ms of jitter

export interface LiveSeat {
  seatId: number;
  userId: string | null;
  displayName: string | null;
  isGuest: boolean;
  avatarSeed: string | null;
  clientSeed: string | null;
  isConnected: boolean;
  timeBankMsRemaining: number;
  lastAction: { type: string; amountTo?: number } | null;
  preAction: 'check-fold' | 'call-any' | 'check' | null;
  consecutiveTimeouts: number;
  sittingOutRequested: boolean;
  /** Non-null for a computer player — see `addBot`. Never has a real `userId`. */
  botPolicyName: string | null;
  /** Owner-private label given to this seat's invite link at creation time — see createSeatAssignment. Never shown to anyone but the owner (see projection.ts's viewerIsAdmin gate). */
  ownerNickname: string | null;
  /**
   * Chips the owner added while this seat was still in a hand — already
   * debited from the player's balance, held here and credited to the
   * stack the moment that hand ends (a stack can't change under a hand in
   * progress: all-in and side-pot math depend on it). Always included in
   * any refund. See addChips.
   */
  pendingChips: number;
  /** Owner removed this seat's occupant mid-hand ('player') or deleted the seat ('seat'): auto-folded on their turn, vacated and refunded when the hand ends. See removeSeatOccupant. */
  pendingRemoval: 'player' | 'seat' | null;
  /** Seated mid-hand (status 'sitting-out' meanwhile, so the engine leaves them out of the hand in progress) — switched to 'active' when that hand ends. See takeSeat. */
  joinsNextHand: boolean;
}

/** A seat the table emptied on its own (a deferred owner removal finishing at hand end) — the caller refunds `refund` to `userId` and moves their socket to spectating. */
export interface VacatedSeat {
  seatId: number;
  userId: string | null;
  refund: number;
}

type Result = { ok: true } | { ok: false; code: string; message: string };

/** Drops keys whose value is `undefined` — a parsed optional field that wasn't sent must not overwrite a real setting with `undefined`. */
function definedOnly<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

interface PendingActionLogEntry {
  seq: number;
  street: string;
  seat: number;
  action: string;
  amount: number | null;
  potAfter: number;
  msToAct: number | null;
}

export interface BroadcastPayload {
  toSeatId: number | null; // null = spectators / broadcast-all base (still per-seat projected before send)
  state: ProjectedTableState;
  events: ProjectedGameEvent[];
}

export interface LiveTableCallbacks {
  /** `rawEvents` — the un-redacted events for this one broadcast — is passed alongside `perSeat` so a caller can compute its OWN projection for a viewer not already covered by `perSeat` (see socketServer.ts's broadcastAdminView). `perSeat`'s own `events` are already correctly redacted per viewer; this is purely an escape hatch for that one extra case. */
  onBroadcast: (tableId: string, perSeat: Map<number | null, BroadcastPayload>, rawEvents: readonly GameEvent[]) => void;
  onChipsSettled: (userId: string, delta: number) => Promise<void>;
  now: () => number;
  /** Seats vacated at hand end by a deferred owner removal — see VacatedSeat. Called before that hand's final broadcast. */
  onSeatsVacated?: (tableId: string, vacated: readonly VacatedSeat[]) => void;
}

// A removed player whose turn comes up is folded after this short pause,
// so the fold reads as an action in everyone's log/animation rather than
// vanishing instantly.
const FORCED_FOLD_DELAY_MS = 400;

const DEFAULT_TIME_BANK_REFILL_MS = 15000;
// Real dealer time to riffle-shuffle and set up the next hand — a new hand
// can't be started until this elapses after the previous one completes.
// Overridable so e2e tests don't genuinely burn 5s per hand (see
// RATE_LIMIT_MAX in index.ts for the same env-override-for-tests pattern).
const HAND_BREAK_MS = Number(process.env.HAND_BREAK_MS ?? 5000);
// Extra riffle time tacked onto the current break whenever a player
// voluntarily reveals their hand after winning uncalled — see revealHand().
const REVEAL_HAND_BREAK_EXTENSION_MS = 1500;

/** Invite tokens are stored and looked up by their SHA-256 — never the token itself. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class LiveTable {
  readonly tableId: string;
  name: string;
  settings: TableSettings;
  state: TableState;
  seats: LiveSeat[];
  private revealedSeatIds = new Set<number>();
  /**
   * The seat that just won a hand purely because everyone else folded (no
   * `showdown-reveal` happened at all this hand — see computeFoldWinSeatId)
   * — `null` for any hand that reached a real showdown or an all-in
   * runout. Reset at the start of every hand; only meaningful once the
   * hand is actually `hand-complete`. Drives `revealEligibleSeatId`, which
   * additionally excludes this seat once it's used its one voluntary
   * reveal (tracked the same way a real showdown reveal is, in
   * `revealedSeatIds`).
   */
  private foldWinSeatId: number | null = null;
  private actionLog: PendingActionLogEntry[] = [];
  private currentHandId: string | null = null;
  private currentHandInitialState: TableState | null = null;
  private currentHandDeck: readonly Card[] = [];
  private currentHandRng: { commitment: string; serverSeed: string; clientSeeds: string[]; nonce: number } | null = null;
  private handStartedAt: Date | null = null;
  private lastActionAt = 0;
  actionDeadline: number | null = null;
  /** Epoch ms — a new hand can't start before this. Set on hand-complete, cleared once the next hand actually deals. See HAND_BREAK_MS. */
  nextHandAt: number | null = null;
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private nextHandTimer: ReturnType<typeof setTimeout> | null = null;
  private waitlist: WaitlistEntry[] = [];
  /** Open-invite tables only: the free seat held for the waitlist's first person — see syncSeatOffer. */
  private seatOffer: SeatOffer | null = null;
  /**
   * The owner's seat invites, by the SHA-256 of their token — unused, or
   * used and now belonging to a guest (`guestUserId`), who can come back by
   * the same link for as long as the table is open. Persisted (see
   * SeatInviteRecord), so they survive a restart along with the table.
   * See createSeatAssignment/redeemSeatAssignment.
   */
  private readonly seatAssignments = new Map<string, SeatInviteRecord>();
  private botMoveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly botRng: RandomSource = cryptoSource();
  private readonly botPolicies = new Map<string, BotPolicy>(SELECTABLE_BOT_POLICIES.map((p) => [p.name, p]));
  /** Seat slots the owner deleted — see ProjectedTableState.removedSeatIds for why they're hidden rather than renumbered. */
  private readonly removedSeatIds = new Set<number>();
  /** Engine-config changes made mid-hand, applied when that hand ends — see updateSettings/addSeat. */
  private pendingConfig: Partial<TableConfig> = {};
  /** This game's books — every buy-in, rebuy, cash-out and hand result. See gameBook.ts. A reset ends the game and starts a new book. */
  book: GameBook;
  private gameCount = 1;
  /** Serializes report writes so an older snapshot can never land after a newer one. */
  private reportWrite: Promise<void> = Promise.resolve();
  /** Chips added mid-hand straight onto a seat's stack (a folded or sitting-out seat — see addChips): not part of that hand's result. Per seat, reset every deal. */
  private handChipAdds = new Map<number, number>();
  /** Folded players who left mid-hand: their key and the stack they left with, so the hand's result can still be booked for them. */
  private handLeavers = new Map<number, { key: string; stack: number }>();

  constructor(
    tableId: string,
    name: string,
    settings: TableSettings,
    private readonly store: Store,
    private readonly callbacks: LiveTableCallbacks,
    public inviteCode: string | null = null,
    /** The user who created this table (never a guest — see the /tables route), or null for the built-in seeded public tables. Lets that one user self-serve seat themselves and add bots on THIS table only, same as the admin can on any table — see socketServer.ts's canManageTable. */
    readonly ownerId: string | null = null,
    /** A signed-in player's practice table (see practiceTables.ts): only its owner and computer players ever sit here, and every record of it is deleted when it closes. */
    readonly isPractice = false,
  ) {
    this.tableId = tableId;
    this.name = name;
    this.settings = settings;
    this.state = this.freshState();
    this.seats = Array.from({ length: settings.maxSeats }, (_, seatId) => this.emptyLiveSeat(seatId));
    this.book = new GameBook(tableId, name, this.gameCount, new Date(callbacks.now()));
  }

  private nowDate(): Date {
    return new Date(this.callbacks.now());
  }

  /** Who a seat's occupant is, for the books: the engine's playerId is the stable key (a user id, or `bot:…` for a computer player). */
  private bookIdentity(seatId: number): { key: string; name: string; kind: PlayerKind } | null {
    const engineSeat = this.state.seats[seatId];
    const liveSeat = this.seats[seatId];
    if (!engineSeat || !liveSeat || engineSeat.status === 'empty' || !engineSeat.playerId) return null;
    const kind: PlayerKind = liveSeat.botPolicyName ? 'bot' : liveSeat.isGuest ? 'guest' : 'registered';
    return { key: engineSeat.playerId, name: liveSeat.displayName ?? 'Player', kind };
  }

  private bookCashOut(seatId: number, amount: number, note: string): void {
    const who = this.bookIdentity(seatId);
    // A computer player leaving with nothing isn't a money movement worth a line; a person leaving with nothing still is.
    if (who && !(who.kind === 'bot' && amount === 0)) this.book.cashOut(who.key, amount, this.nowDate(), note);
  }

  /**
   * Writes the current book to the store — after every hand and every
   * money movement, so a downloaded report is never more than one event
   * behind. A game that hasn't completed a hand yet isn't saved (nothing
   * has been played); its buy-ins are still booked and saved with the
   * first hand.
   */
  private saveReport(book: GameBook = this.book): Promise<void> {
    if (book.handsPlayed === 0) return this.reportWrite;
    const record = {
      id: book.id,
      tableId: this.tableId,
      tableName: book.tableName,
      status: book.isFinal ? ('final' as const) : ('live' as const),
      handsPlayed: book.handsPlayed,
      lastHandNumber: book.lastHand?.number ?? null,
      startedAt: book.startedAt,
      updatedAt: book.updatedAt,
      endedAt: book.endedAt,
      summary: book.summary(),
      reportYaml: book.toYaml(this.nowDate()),
    };
    this.reportWrite = this.reportWrite.then(() => this.store.saveGameReport(record)).catch((err: unknown) => {
      process.stderr.write(`Failed to save game report for table ${this.tableId}: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return this.reportWrite;
  }

  /**
   * Ends this game's books — everyone still seated is cashed out in the
   * book with exactly what they're refunded (`voidedHandRefund`, so a hand
   * cut short is voided, not lost) — and saves the final report. Called
   * when the table is terminated/emptied, and by a reset (which then
   * starts a fresh book). Resolves once the final report is written.
   */
  closeBook(reason: string): Promise<void> {
    const at = this.nowDate();
    if (this.inHand) this.book.voidHand(this.state.handNumber, at, `${reason} during the hand — every chip bet in it was returned`);
    for (let seatId = 0; seatId < this.seats.length; seatId++) {
      if (this.state.seats[seatId]?.status === 'empty') continue;
      this.bookCashOut(seatId, this.voidedHandRefund(seatId), reason);
    }
    this.book.finalize(at, reason);
    return this.saveReport();
  }

  /** A clean-slate engine state for this table's settings, with every seat empty — shared by the constructor and resetTable(). */
  private freshState(): TableState {
    const config: TableConfig = {
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      ante: this.settings.ante,
      maxSeats: this.settings.maxSeats,
      straddleEnabled: this.settings.straddleEnabled,
    };
    return createTableState(config, []);
  }

  private emptyLiveSeat(seatId: number): LiveSeat {
    return {
      seatId,
      userId: null,
      displayName: null,
      isGuest: false,
      avatarSeed: null,
      clientSeed: null,
      isConnected: false,
      timeBankMsRemaining: this.settings.timeBankSeconds * 1000,
      lastAction: null,
      preAction: null,
      consecutiveTimeouts: 0,
      sittingOutRequested: false,
      botPolicyName: null,
      ownerNickname: null,
      pendingChips: 0,
      pendingRemoval: null,
      joinsNextHand: false,
    };
  }

  /** A hand is being played right now — blind/ante/straddle changes wait for it to end. */
  get handInProgress(): boolean {
    return this.inHand;
  }

  private get inHand(): boolean {
    return this.state.phase === 'in-hand';
  }

  /** Whether this seat is part of the hand currently being played (dealt in — folded still counts: its chips are in the pot). */
  private isInCurrentHand(seatId: number): boolean {
    const status = this.state.seats[seatId]?.status;
    return this.inHand && (status === 'active' || status === 'all-in' || status === 'folded');
  }

  /** Engine status for a seat being filled right now: dealt in from the next hand if one is in progress — see takeSeat. */
  private newlySeatedStatus(): 'active' | 'sitting-out' {
    return this.inHand ? 'sitting-out' : 'active';
  }

  private checkSeatUsable(seatId: number): Result {
    const engineSeat = this.state.seats[seatId];
    if (!engineSeat || this.removedSeatIds.has(seatId)) return { ok: false, code: 'NO_SUCH_SEAT', message: 'That seat does not exist.' };
    if (engineSeat.status !== 'empty') return { ok: false, code: 'SEAT_TAKEN', message: 'That seat is not empty.' };
    return { ok: true };
  }

  /** Seats a player can see/sit in — every slot minus deleted ones. */
  get visibleSeatCount(): number {
    return this.state.seats.length - this.removedSeatIds.size;
  }

  /** Everything a seat's occupant gets back on leaving: their stack plus any chips still pending from a mid-hand rebuy. */
  cashOutAmount(seatId: number): number {
    return (this.state.seats[seatId]?.stack ?? 0) + (this.seats[seatId]?.pendingChips ?? 0);
  }

  /**
   * What a seat's occupant is owed when the table is reset or terminated:
   * a hand in progress at that moment is void, so everything they put
   * into it comes back too — not just what's left in front of them. Bets
   * and blinds stay in `committedThisHand` until pots are built at hand
   * end; the (BB) ante is tracked separately in `anteTotal`, paid by this
   * hand's big blind (`lastBigBlindSeat` — see packages/engine/src/hand.ts).
   */
  voidedHandRefund(seatId: number): number {
    const seat = this.state.seats[seatId];
    if (!seat) return 0;
    const contributed = this.inHand ? seat.committedThisHand + (seatId === this.state.lastBigBlindSeat ? this.state.anteTotal : 0) : 0;
    return this.cashOutAmount(seatId) + contributed;
  }

  seatOfUser(userId: string): number | null {
    return this.seats.find((s) => s.userId === userId)?.seatId ?? null;
  }

  /** Seat a player (must be an empty seat) with a buy-in, deducted from their chip balance by the caller before this is invoked. `ownerNickname` carries over from the invite link that seated them, if any (see redeemSeatAssignment) — never set for the owner seating themselves directly. */
  takeSeat(
    seatId: number,
    userId: string,
    meta: { displayName: string; isGuest: boolean; avatarSeed: string; clientSeed: string },
    buyIn: number,
    ownerNickname: string | null = null,
  ): void {
    const usable = this.checkSeatUsable(seatId);
    if (!usable.ok) throw new Error(usable.code);
    // Mid-hand, a new player must NOT be 'active': the engine treats every
    // 'active' seat as live in the current betting round (see
    // packages/engine/src/betting.ts), so they'd be asked to act in a hand
    // they were never dealt into. 'sitting-out' keeps them out of it; they
    // switch to 'active' the moment this hand ends (applyHandEndChanges).
    const status = this.newlySeatedStatus();
    const newEngineSeats = this.state.seats.map((s, i) =>
      i === seatId
        ? { ...s, playerId: userId, stack: buyIn, status }
        : s,
    );
    this.state = { ...this.state, seats: newEngineSeats };
    this.seats[seatId] = {
      ...this.emptyLiveSeat(seatId),
      userId,
      displayName: meta.displayName,
      isGuest: meta.isGuest,
      avatarSeed: meta.avatarSeed,
      clientSeed: meta.clientSeed,
      isConnected: true,
      ownerNickname,
      joinsNextHand: status === 'sitting-out',
    };
    this.removeFromWaitlist(userId);
    const who = this.bookIdentity(seatId);
    if (who) this.book.buyIn(who.key, who.name, who.kind, buyIn, 'buy-in', this.nowDate(), status === 'sitting-out' ? 'seated mid-hand, dealt in from the next hand' : null);
    void this.saveReport();
  }

  /**
   * Owner-only chip economy (see DECISIONS.md): the owner picks an empty
   * seat and a buy-in, generating an invite link instead of seating anyone
   * directly — the human it's sent to redeems it themselves via
   * redeemSeatAssignment, which is what actually calls takeSeat. The link
   * then belongs to them: it brings them back to this table whenever they
   * use it again, for as long as the table is open.
   */
  createSeatAssignment(
    seatId: number,
    buyIn: number,
    ownerNickname: string | null = null,
  ): { ok: true; token: string } | { ok: false; code: string; message: string } {
    const usable = this.checkSeatUsable(seatId);
    if (!usable.ok) return usable;
    const range = this.checkBuyInRange(buyIn);
    if (!range.ok) return range;
    const token = randomUUID();
    const invite: SeatInviteRecord = { tokenHash: hashInviteToken(token), tableId: this.tableId, seatId, buyIn, ownerNickname, guestUserId: null, createdAt: this.nowDate(), redeemedAt: null };
    this.seatAssignments.set(invite.tokenHash, invite);
    this.persistInvite(invite);
    return { ok: true, token };
  }

  private persistInvite(invite: SeatInviteRecord): void {
    if (this.isPractice) return;
    void this.store.saveSeatInvite(invite).catch(() => undefined);
  }

  private voidInvite(tokenHash: string): void {
    this.seatAssignments.delete(tokenHash);
    if (!this.isPractice) void this.store.deleteSeatInvite(tokenHash).catch(() => undefined);
  }

  /** A restored table's invites (see TableRegistry.restore) — used ones keep working for their guests. */
  loadSeatInvites(invites: readonly SeatInviteRecord[]): void {
    for (const invite of invites) this.seatAssignments.set(invite.tokenHash, { ...invite });
  }

  /** Whether this table has an invite with this token, used or not — for looking up which table a pasted invite code belongs to. */
  hasSeatAssignment(token: string): boolean {
    return this.seatAssignments.has(hashInviteToken(token));
  }

  /** The name the owner gave an invite (null if none) — kept on the guest's record (see GuestPlayerRecord). */
  seatAssignmentNickname(token: string): string | null {
    return this.seatAssignments.get(hashInviteToken(token))?.ownerNickname ?? null;
  }

  /** The guest an invite belongs to once used — null while unused. */
  seatAssignmentGuest(token: string): string | null {
    return this.seatAssignments.get(hashInviteToken(token))?.guestUserId ?? null;
  }

  /**
   * Seats `userId` by an invite: the first time, it becomes theirs; after
   * that it seats them again whenever they come back by it. Their own seat
   * if it's free, otherwise any free seat. Someone else can't use an
   * invite that's already someone's. The caller (socketServer.ts) still
   * does the actual takeSeat + chip-ledger work, exactly like a normal
   * take-seat, sourcing seatId/buyIn/ownerNickname from here instead of
   * the client's own say-so.
   */
  redeemSeatAssignment(
    token: string,
    userId: string,
  ): { ok: true; seatId: number; buyIn: number; ownerNickname: string | null; returning: boolean } | { ok: false; code: string; message: string } {
    const assignment = this.seatAssignments.get(hashInviteToken(token));
    if (!assignment) return { ok: false, code: 'INVALID_ASSIGNMENT', message: 'This invite link isn’t valid for this table any more.' };
    if (assignment.guestUserId !== null && assignment.guestUserId !== userId) {
      return { ok: false, code: 'INVITE_TAKEN', message: 'This invite link belongs to another player.' };
    }
    const seatId = this.checkSeatUsable(assignment.seatId).ok
      ? assignment.seatId
      : this.state.seats.map((s) => s.seatId).find((id) => this.checkSeatUsable(id).ok);
    if (seatId === undefined) return { ok: false, code: 'NO_FREE_SEAT', message: 'Every seat is taken right now — you can watch until one opens.' };
    const returning = assignment.guestUserId !== null;
    if (!returning) {
      assignment.guestUserId = userId;
      assignment.redeemedAt = this.nowDate();
      this.persistInvite(assignment);
    }
    return { ok: true, seatId, buyIn: assignment.buyIn, ownerNickname: assignment.ownerNickname, returning };
  }

  /**
   * Seats a computer player — for practice/solo play, entirely separate
   * from the real chip economy: no real `userId`, no ledger entries ever
   * (settleHand already only records entries for seats with a real
   * userId, so a bot's stack is just play chips that appear and vanish
   * with the seat; see DECISIONS.md).
   */
  addBot(seatId: number, persona: string, buyIn: number): { ok: true } | { ok: false; code: string; message: string } {
    const policy = this.botPolicies.get(persona);
    if (!policy) return { ok: false, code: 'UNKNOWN_BOT_PERSONA', message: `Unknown bot persona: ${persona}` };
    const usable = this.checkSeatUsable(seatId);
    if (!usable.ok) return usable;
    const status = this.newlySeatedStatus(); // see takeSeat
    const newEngineSeats = this.state.seats.map((s, i) =>
      i === seatId ? { ...s, playerId: `bot:${policy.name}:${String(seatId)}`, stack: buyIn, status } : s,
    );
    this.state = { ...this.state, seats: newEngineSeats };
    this.seats[seatId] = {
      ...this.emptyLiveSeat(seatId),
      displayName: BOT_PERSONA_LABELS[policy.name] ?? policy.name,
      avatarSeed: `bot-${policy.name}`,
      isConnected: true,
      botPolicyName: policy.name,
      joinsNextHand: status === 'sitting-out',
    };
    const who = this.bookIdentity(seatId);
    if (who) this.book.buyIn(who.key, who.name, who.kind, buyIn, 'buy-in', this.nowDate(), null);
    void this.saveReport();
    return { ok: true };
  }

  /** The buy-in range check shared by every way a seat gets filled. */
  checkBuyInRange(buyIn: number): Result {
    if (buyIn < this.settings.minBuyIn || buyIn > this.settings.maxBuyIn) {
      return {
        ok: false,
        code: 'BUY_IN_OUT_OF_RANGE',
        message: `Buy-in must be between ${formatMoney(this.settings.minBuyIn)} and ${formatMoney(this.settings.maxBuyIn)}.`,
      };
    }
    return { ok: true };
  }

  /** Mid-hand, a bot still in the hand is folded on its turn and leaves when the hand ends — same as any owner removal (see removeSeatOccupant). */
  removeBot(seatId: number): { ok: true; vacated: VacatedSeat | null } | { ok: false; code: string; message: string } {
    const engineSeat = this.state.seats[seatId];
    const liveSeat = this.seats[seatId];
    if (!engineSeat || !liveSeat?.botPolicyName || engineSeat.status === 'empty') {
      return { ok: false, code: 'NOT_A_BOT', message: 'That seat is not a computer player.' };
    }
    return this.removeSeatOccupant(seatId, false);
  }

  /**
   * Owner-only: takes a seat's occupant (human or bot) off the table, any
   * time. With `deleteSeat`, the seat slot itself goes too.
   *
   * Not in the current hand (empty seat, between hands, or sitting out):
   * happens right now, and `vacated` carries the refund for the caller to
   * credit. Still in the hand (even folded — those chips are in the pot
   * and the engine's pot bookkeeping still reads the seat): marked
   * `pendingRemoval` instead — folded automatically when their turn comes
   * (an all-in player has no decisions left and simply plays the hand
   * out), then vacated and refunded the moment the hand ends, through
   * `callbacks.onSeatsVacated`. A hand in progress is never altered
   * underneath itself.
   */
  removeSeatOccupant(seatId: number, deleteSeat: boolean): { ok: true; vacated: VacatedSeat | null } | { ok: false; code: string; message: string } {
    const engineSeat = this.state.seats[seatId];
    const liveSeat = this.seats[seatId];
    if (!engineSeat || !liveSeat || this.removedSeatIds.has(seatId)) return { ok: false, code: 'NO_SUCH_SEAT', message: 'That seat does not exist.' };
    if (engineSeat.status === 'empty') {
      if (!deleteSeat) return { ok: false, code: 'SEAT_EMPTY', message: 'That seat is already empty.' };
      this.markSeatRemoved(seatId);
      return { ok: true, vacated: null };
    }
    if (this.isInCurrentHand(seatId)) {
      liveSeat.pendingRemoval = deleteSeat ? 'seat' : 'player';
      liveSeat.sittingOutRequested = true;
      if (this.state.betting.actingSeat === seatId) this.armClockOrBot();
      return { ok: true, vacated: null };
    }
    const vacated = this.vacateSeat(seatId, deleteSeat ? 'removed by the owner (seat deleted)' : 'removed by the owner');
    if (deleteSeat) this.markSeatRemoved(seatId);
    void this.saveReport();
    return { ok: true, vacated };
  }

  /** Owner-only: deletes an empty seat slot, or removes its occupant and then the slot — see removeSeatOccupant. */
  deleteSeat(seatId: number): { ok: true; vacated: VacatedSeat | null } | { ok: false; code: string; message: string } {
    if (this.visibleSeatCount <= 2) return { ok: false, code: 'TOO_FEW_SEATS', message: 'A table needs at least 2 seats.' };
    return this.removeSeatOccupant(seatId, true);
  }

  /**
   * Owner-only: adds a seat — restores the lowest-numbered deleted slot if
   * there is one (it's still an empty engine seat, so this is instant even
   * mid-hand), otherwise appends a brand-new slot, up to 9. An appended
   * slot is an empty engine seat, so it's safe to add mid-hand too; only
   * the engine's `maxSeats` (which the odd-chip rule reads at showdown)
   * waits for the hand to end.
   */
  addSeat(): { ok: true; seatId: number } | { ok: false; code: string; message: string } {
    const restorable = [...this.removedSeatIds].sort((a, b) => a - b)[0];
    if (restorable !== undefined) {
      this.removedSeatIds.delete(restorable);
      this.seats[restorable] = this.emptyLiveSeat(restorable);
      return { ok: true, seatId: restorable };
    }
    const seatId = this.state.seats.length;
    if (seatId >= 9) return { ok: false, code: 'MAX_SEATS', message: 'A table can have at most 9 seats.' };
    const blank = { ...createTableState({ ...this.state.config, maxSeats: 1 }, []).seats[0]!, seatId };
    this.state = { ...this.state, seats: [...this.state.seats, blank] };
    this.seats.push(this.emptyLiveSeat(seatId));
    this.settings = { ...this.settings, maxSeats: seatId + 1 };
    this.setEngineConfig({ maxSeats: seatId + 1 });
    return { ok: true, seatId };
  }

  private markSeatRemoved(seatId: number): void {
    this.removedSeatIds.add(seatId);
    // An unused invite to this seat is void; a used one still brings its guest back (to another seat).
    for (const [hash, a] of this.seatAssignments) if (a.seatId === seatId && a.guestUserId === null) this.voidInvite(hash);
  }

  /** Empties a seat right now and returns what its occupant is owed. Only ever called when the seat isn't in a hand in progress. */
  private vacateSeat(seatId: number, note = 'removed by the owner'): VacatedSeat {
    const vacated: VacatedSeat = { seatId, userId: this.seats[seatId]?.userId ?? null, refund: this.cashOutAmount(seatId) };
    // A player who already left mid-hand was cashed out (and booked) then — nothing more to book.
    if (!this.handLeavers.has(seatId) || this.seats[seatId]?.userId || this.seats[seatId]?.botPolicyName) this.bookCashOut(seatId, vacated.refund, note);
    const newEngineSeats = this.state.seats.map((s, i) => (i === seatId ? { ...s, playerId: '', stack: 0, status: 'empty' as const } : s));
    this.state = { ...this.state, seats: newEngineSeats };
    this.seats[seatId] = this.emptyLiveSeat(seatId);
    return vacated;
  }

  /** Changes the engine's config now if no hand is in progress, otherwise queues it for when the current hand ends. */
  private setEngineConfig(patch: Partial<TableConfig>): void {
    if (this.inHand) {
      this.pendingConfig = { ...this.pendingConfig, ...patch };
    } else {
      this.state = { ...this.state, config: { ...this.state.config, ...patch } };
    }
  }

  /** Blind/ante/straddle values the owner has set that aren't in force yet — see ProjectedTableState.pendingSettings. */
  get pendingSettings(): PendingTableSettings | null {
    const { smallBlind, bigBlind, ante, straddleEnabled } = this.pendingConfig;
    const pending: PendingTableSettings = {
      ...(smallBlind !== undefined ? { smallBlind } : {}),
      ...(bigBlind !== undefined ? { bigBlind } : {}),
      ...(ante !== undefined ? { ante } : {}),
      ...(straddleEnabled !== undefined ? { straddleEnabled } : {}),
    };
    return Object.keys(pending).length > 0 ? pending : null;
  }

  /**
   * Owner-only, any time. Everything except the engine's own config takes
   * effect immediately (a new buy-in range only governs buy-ins from now
   * on; a new action time applies from the next turn's clock). Blinds,
   * ante and straddle are read by the engine on every street, so mid-hand
   * they queue (`pendingSettings`) and apply the moment the hand ends.
   * Validated against the settings as they'll be AFTER the change, so a
   * patch can't leave the table inconsistent (e.g. SB above BB).
   */
  updateSettings(rawPatch: UpdateTableSettingsIntent): { ok: true; deferred: boolean } | { ok: false; code: string; message: string } {
    const patch = definedOnly(rawPatch);
    const target = { ...this.settings, ...this.pendingSettings, ...patch };
    if (target.smallBlind > target.bigBlind) return { ok: false, code: 'INVALID_SETTINGS', message: 'The small blind cannot be bigger than the big blind.' };
    if (target.minBuyIn > target.maxBuyIn) return { ok: false, code: 'INVALID_SETTINGS', message: 'The minimum buy-in cannot be above the maximum.' };
    if (target.ante > target.bigBlind) return { ok: false, code: 'INVALID_SETTINGS', message: 'The ante cannot be bigger than the big blind.' };
    if (patch.openSeatStack !== undefined && !this.openSeating) return { ok: false, code: 'INVALID_SETTINGS', message: 'Starting chips only apply to an open-invite table.' };
    if (this.openSeating && (target.openSeatStack ?? target.maxBuyIn) < target.bigBlind) {
      return { ok: false, code: 'INVALID_SETTINGS', message: 'Starting chips must be at least one big blind.' };
    }
    // Only its link gets anyone into an open-invite table — it can't go public.
    if (patch.isPrivate === false && this.openSeating) return { ok: false, code: 'INVALID_SETTINGS', message: 'An open-invite table is always private.' };

    const { smallBlind, bigBlind, ante, straddleEnabled, name, ...immediate } = patch;
    if (name !== undefined) {
      this.name = name;
      this.book.tableName = name;
    }
    if (immediate.isPrivate === true && !this.inviteCode) this.inviteCode = randomBytes(4).toString('hex');
    this.settings = { ...this.settings, ...immediate };

    const engineChanges: Partial<TableConfig> = {
      ...(smallBlind !== undefined ? { smallBlind } : {}),
      ...(bigBlind !== undefined ? { bigBlind } : {}),
      ...(ante !== undefined ? { ante } : {}),
      ...(straddleEnabled !== undefined ? { straddleEnabled } : {}),
    };
    const deferred = this.inHand && Object.keys(engineChanges).length > 0;
    if (!deferred) this.settings = { ...this.settings, ...engineChanges };
    this.setEngineConfig(engineChanges);
    return { ok: true, deferred };
  }

  /** The settings as they'll be once anything pending applies — what gets persisted. */
  get targetSettings(): TableSettings {
    return { ...this.settings, ...this.pendingSettings };
  }

  /** An open-invite table: anyone with its link picks their own seat (see socketServer.ts). */
  get openSeating(): boolean {
    return this.settings.openSeating === true;
  }

  /** Seats someone could sit down in right now. */
  freeSeatCount(): number {
    return this.state.seats.filter((s) => this.checkSeatUsable(s.seatId).ok).length;
  }

  /** On an open-invite table: whether this user may take a free seat now — while a seat is held for the waitlist's first person, everyone else can only take the others. */
  canTakeOpenSeat(userId: string): boolean {
    if (!this.seatOffer || this.seatOffer.userId === userId) return true;
    return this.freeSeatCount() > 1;
  }

  get currentSeatOffer(): SeatOffer | null {
    return this.seatOffer;
  }

  /**
   * The open-invite waitlist, kept fair: whenever a seat is free and people
   * are waiting, one free seat is held for whoever is first in line, for
   * SEAT_OFFER_MS — their browser alerts them (see the web Table page). If
   * they don't take it in time they drop off the list and the next person
   * gets it. Called after anything that can free or fill a seat, or change
   * the queue; returns whether the offer changed (so the caller broadcasts).
   */
  syncSeatOffer(): boolean {
    const before = this.seatOffer;
    const now = this.callbacks.now();
    if (!this.openSeating) {
      this.seatOffer = null;
    } else {
      const offer = this.seatOffer;
      if (offer) {
        const stillWaiting = this.waitlist.some((w) => w.userId === offer.userId);
        if (!stillWaiting || this.seatOfUser(offer.userId) !== null || this.freeSeatCount() === 0) {
          this.seatOffer = null;
        } else if (now >= offer.expiresAt) {
          // Missed it: off the list, and the seat goes to the next person.
          this.removeFromWaitlist(offer.userId);
          this.seatOffer = null;
        }
      }
      const first = this.waitlist[0];
      if (!this.seatOffer && first && this.freeSeatCount() > 0) {
        this.seatOffer = { userId: first.userId, displayName: first.displayName, expiresAt: now + seatOfferMs() };
      }
    }
    return this.seatOffer !== before;
  }

  joinWaitlist(userId: string, displayName: string): { ok: true } | { ok: false; code: string; message: string } {
    if (this.seatOfUser(userId) !== null) {
      return { ok: false, code: 'ALREADY_SEATED', message: 'You already have a seat at this table.' };
    }
    if (!this.waitlist.some((w) => w.userId === userId)) {
      this.waitlist.push({ userId, displayName });
    }
    return { ok: true };
  }

  leaveWaitlist(userId: string): void {
    this.removeFromWaitlist(userId);
  }

  private removeFromWaitlist(userId: string): void {
    this.waitlist = this.waitlist.filter((w) => w.userId !== userId);
  }

  leaveSeat(seatId: number): { userId: string; stack: number } | null {
    const engineSeat = this.state.seats[seatId];
    const liveSeat = this.seats[seatId];
    if (!engineSeat || !liveSeat?.userId || engineSeat.status === 'empty') return null;
    if (this.state.phase === 'in-hand' && (engineSeat.status === 'active' || engineSeat.status === 'all-in')) {
      throw new Error('CANNOT_LEAVE_MID_HAND');
    }
    const result = { userId: liveSeat.userId, stack: this.cashOutAmount(seatId) };
    const who = this.bookIdentity(seatId);
    if (who) {
      this.book.cashOut(who.key, result.stack, this.nowDate(), 'left the table');
      void this.saveReport();
    }
    if (this.isInCurrentHand(seatId)) {
      // A folded player leaving mid-hand. They're cashed out and free to go
      // right now, but the engine seat must stay 'folded' until the hand
      // ends: their chips are still in this hand's pot, and pot building
      // only excludes FOLDED contributors (packages/engine/src/pots.ts) —
      // an 'empty' seat with chips in would be made eligible to win and
      // crash the showdown. So: stack 0, still folded, vacated at hand end.
      if (who) this.handLeavers.set(seatId, { key: who.key, stack: result.stack });
      this.state = { ...this.state, seats: this.state.seats.map((s, i) => (i === seatId ? { ...s, stack: 0 } : s)) };
      this.seats[seatId] = {
        ...this.emptyLiveSeat(seatId),
        displayName: liveSeat.displayName,
        avatarSeed: liveSeat.avatarSeed,
        isGuest: liveSeat.isGuest,
        pendingRemoval: 'player',
      };
      return result;
    }
    const newEngineSeats = this.state.seats.map((s, i) => (i === seatId ? { ...s, playerId: '', stack: 0, status: 'empty' as const } : s));
    this.state = { ...this.state, seats: newEngineSeats };
    this.seats[seatId] = this.emptyLiveSeat(seatId);
    return result;
  }

  /**
   * Owner-only "start completely fresh at this same table" action: empties
   * every seat — bots are simply discarded, real humans' stacks are
   * returned via the array this returns (same shape as leaveSeat's
   * result, one entry per seated human, for the caller to credit back to
   * their chip balance) — clears any in-progress hand and its timers,
   * and rebuilds the engine state from scratch. Same tableId/settings/
   * inviteCode throughout, so the table itself (and its URL) stays valid
   * — this does NOT remove the table the way close()/dispose() does.
   */
  resetTable(): { userId: string; stack: number }[] {
    this.clearClock();
    this.clearBotMove();
    this.clearNextHandTimer();
    this.nextHandAt = null;
    // Any not-yet-used invite links are void once the table's reset; used ones still bring their guests back.
    for (const [hash, a] of this.seatAssignments) if (a.guestUserId === null) this.voidInvite(hash);
    // A reset ends the game: everyone is cashed out, so this game's books
    // close here and the next buy-in starts a new one.
    void this.closeBook('table reset by the owner');
    this.gameCount += 1;
    const nextBook = new GameBook(this.tableId, this.name, this.gameCount, this.nowDate());
    const refunds: { userId: string; stack: number }[] = [];
    for (let i = 0; i < this.seats.length; i++) {
      const liveSeat = this.seats[i]!;
      const engineSeat = this.state.seats[i];
      if (liveSeat.userId && engineSeat) refunds.push({ userId: liveSeat.userId, stack: this.voidedHandRefund(i) });
    }
    // No hand survives a reset, so anything queued for "when this hand
    // ends" applies right now. Deleted seats stay deleted — a reset clears
    // who's sitting, not how the table is laid out.
    this.settings = this.targetSettings;
    this.pendingConfig = {};
    this.state = this.freshState();
    this.seats = Array.from({ length: this.settings.maxSeats }, (_, seatId) => this.emptyLiveSeat(seatId));
    this.book = nextBook;
    return refunds;
  }

  setConnected(userId: string, connected: boolean): void {
    const seat = this.seats.find((s) => s.userId === userId);
    if (seat) seat.isConnected = connected;
  }

  /** Sit out: takes effect immediately if between hands, or from next hand if mid-hand (their current hand plays on as normal). */
  sitOut(seatId: number): void {
    const liveSeat = this.seats[seatId];
    if (liveSeat) liveSeat.sittingOutRequested = true;
    const engineSeat = this.state.seats[seatId];
    if (engineSeat && engineSeat.status === 'active' && this.state.phase !== 'in-hand') {
      const newSeats = this.state.seats.map((s, i) => (i === seatId ? { ...s, status: 'sitting-out' as const } : s));
      this.state = { ...this.state, seats: newSeats };
    }
  }

  sitIn(seatId: number): void {
    const liveSeat = this.seats[seatId];
    if (liveSeat) liveSeat.sittingOutRequested = false;
    const engineSeat = this.state.seats[seatId];
    if (engineSeat && engineSeat.status === 'sitting-out') {
      const newSeats = this.state.seats.map((s, i) => (i === seatId ? { ...s, status: 'active' as const } : s));
      this.state = { ...this.state, seats: newSeats };
    }
  }

  /** Between-hand cleanup: applies any queued sit-out requests, and sits out anyone whose seat busted to zero. */
  applyPendingSitOuts(): void {
    for (let seatId = 0; seatId < this.state.seats.length; seatId++) {
      const engineSeat = this.state.seats[seatId];
      const liveSeat = this.seats[seatId];
      if (!engineSeat || !liveSeat) continue;
      if (engineSeat.status === 'active' && liveSeat.sittingOutRequested) {
        const newSeats = this.state.seats.map((s, i) => (i === seatId ? { ...s, status: 'sitting-out' as const } : s));
        this.state = { ...this.state, seats: newSeats };
      }
    }
  }

  private dealtInCount(): number {
    // A seat that folded or went all-in LAST hand isn't reset back to
    // 'active' until the next hand actually deals (see
    // resetSeatForNewHand in packages/engine/src/hand.ts) — so between
    // hands, counting only currently-'active' seats would undercount who
    // is really available for the next hand, and could leave
    // canStartHand() permanently false after any hand that ended by a
    // fold (the common case, not an edge case). "Will be active on the
    // next deal" is: not empty, not sitting out, and has chips.
    return this.state.seats.filter((s) => s.status !== 'empty' && s.status !== 'sitting-out' && s.stack > 0).length;
  }

  /** Seats actually being dealt into a hand right now, as a sorted ring — same model the engine itself uses internally for button/blind rotation (`dealtInRing` in packages/engine/src/button.ts, not exported, so re-derived here identically). */
  private dealtInRing(): number[] {
    return this.state.seats
      .filter((s) => s.status === 'active' && s.stack > 0)
      .map((s) => s.seatId)
      .sort((a, b) => a - b);
  }

  canStartHand(): boolean {
    // At least one real human must be seated — otherwise a table left with
    // only bots would deal itself forever with nobody watching, burning
    // server resources for no one's benefit. See DECISIONS.md.
    const hasHuman = this.seats.some((s) => s.userId !== null);
    const breakOver = this.nextHandAt === null || this.callbacks.now() >= this.nextHandAt;
    return this.state.phase !== 'in-hand' && this.dealtInCount() >= 2 && hasHuman && breakOver;
  }

  /**
   * Standard "everyone draws one card, highest wins the button" opening
   * draw — used exactly once, before a table's very first hand, so the
   * initial dealer position isn't arbitrarily fixed to "whichever seat ID
   * is lowest". Ties are impossible (a shuffled 52-card deck never deals
   * the same rank+suit twice), so ranking high-to-low then breaking on
   * suit (spades > hearts > diamonds > clubs, the conventional order —
   * `SUITS` is already declared in exactly that order) always produces a
   * single winner.
   */
  private drawInitialButtonSeat(ring: readonly number[]): number {
    const draw = shuffle(fullDeck(), this.botRng);
    let winnerSeat = ring[0]!;
    let winnerCard = draw[0]!;
    for (let i = 1; i < ring.length; i++) {
      const card = draw[i]!;
      const rankDiff = rankIndex(card) - rankIndex(winnerCard);
      const isHigher = rankDiff !== 0 ? rankDiff > 0 : SUITS.indexOf(suitOf(card)) < SUITS.indexOf(suitOf(winnerCard));
      if (isHigher) {
        winnerCard = card;
        winnerSeat = ring[i]!;
      }
    }
    return winnerSeat;
  }

  /** Deals a new hand: generates+commits the server seed, derives the deck, and runs it through the engine. */
  startNextHand(): void {
    if (!this.canStartHand()) return;

    if (this.state.lastBigBlindSeat === null) {
      // This table's very first hand — seed the moving-button rotation
      // with a `lastBigBlindSeat` chosen so that the ENGINE's own normal
      // rotation math (not a special case here) lands the button exactly
      // on the high-card draw's winner. Heads-up's "button === small
      // blind" assignment happens to make button equal lastBigBlindSeat
      // directly; a 3+-way ring is one step further around, since the
      // engine derives button as (bb → prev → prev) from lastBigBlindSeat.
      const ring = this.dealtInRing();
      const winnerSeat = this.drawInitialButtonSeat(ring);
      const seeded = ring.length === 2 ? winnerSeat : ring[(ring.indexOf(winnerSeat) + 1) % ring.length]!;
      this.state = { ...this.state, lastBigBlindSeat: seeded };
    }

    const serverSeed = generateServerSeed();
    const commitment = commitmentFor(serverSeed);
    const clientSeeds = this.seats
      .filter((s) => s.userId !== null)
      .map((s) => s.clientSeed ?? '')
      .sort(); // order-independent: sorted so no seat's position can bias the "last" input
    const handNumber = this.state.handNumber + 1;
    const deck = deriveDeckForHand(serverSeed, clientSeeds, handNumber);

    this.currentHandId = randomUUID();
    this.currentHandRng = { commitment, serverSeed, clientSeeds, nonce: handNumber };
    this.currentHandDeck = deck;
    this.currentHandInitialState = this.state;
    this.handChipAdds = new Map();
    this.handLeavers = new Map();
    this.actionLog = [];
    this.revealedSeatIds = new Set();
    this.handStartedAt = new Date();
    this.lastActionAt = this.callbacks.now();
    this.nextHandAt = null;
    this.foldWinSeatId = null;
    this.clearNextHandTimer();

    for (const seat of this.seats) {
      seat.lastAction = null;
      seat.preAction = null;
    }

    const result = startHand(this.state, deck);
    if (!result.ok) {
      // Shouldn't happen: canStartHand() already checked >=2 dealt-in seats and phase.
      this.currentHandRng = null;
      this.currentHandId = null;
      return;
    }
    this.state = result.state;
    this.recordEngineEvents(result.events);
    this.armClockOrBot();
    this.broadcastAll(result.events);
  }

  private recordEngineEvents(events: readonly GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'action-taken') {
        this.actionLog.push({
          seq: this.actionLog.length,
          street: this.state.street,
          seat: e.seatId,
          action: e.action.type,
          amount: e.action.amountTo ?? null,
          potAfter: this.state.pots.reduce((s, p) => s + p.amount, 0),
          msToAct: null,
        });
        const seat = this.seats[e.seatId];
        if (seat) seat.lastAction = { type: e.action.type, ...(e.action.amountTo !== undefined ? { amountTo: e.action.amountTo } : {}) };
      }
      if (e.type === 'showdown-reveal') this.revealedSeatIds.add(e.seatId);
    }
  }

  /**
   * `null` unless this hand ended with zero `showdown-reveal` events (no
   * real showdown, no early all-in runout reveal) AND every `pot-awarded`
   * event named the exact same single winner — i.e. everyone else folded
   * and the survivor never had to show anything. Checked against
   * `this.revealedSeatIds` AFTER `recordEngineEvents` has already folded
   * this hand's own events into it, so a genuine showdown's reveals are
   * always accounted for first.
   */
  private computeFoldWinSeatId(events: readonly GameEvent[]): number | null {
    if (this.revealedSeatIds.size > 0) return null;
    const winnerSeatIds = new Set<number>();
    for (const e of events) {
      if (e.type === 'pot-awarded') for (const w of e.winners) winnerSeatIds.add(w.seatId);
    }
    if (winnerSeatIds.size !== 1) return null;
    return [...winnerSeatIds][0]!;
  }

  private armClock(): void {
    this.clearClock();
    if (this.state.phase !== 'in-hand' || this.state.betting.actingSeat === null) {
      this.actionDeadline = null;
      return;
    }
    const seat = this.seats[this.state.betting.actingSeat];
    const baseMs = this.settings.actionSeconds * 1000;
    this.actionDeadline = this.callbacks.now() + baseMs;
    this.clockTimer = setTimeout(() => {
      this.handleTimeout();
    }, baseMs + (seat?.timeBankMsRemaining ?? 0));
  }

  private clearClock(): void {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = null;
  }

  /** Arms the human action-timeout clock, unless the seat now on the clock is a computer player — then schedules its move instead. */
  private armClockOrBot(): void {
    const actingSeat = this.state.betting.actingSeat;
    if (this.state.phase === 'in-hand' && actingSeat !== null) {
      const liveSeat = this.seats[actingSeat];
      if (liveSeat?.pendingRemoval) {
        // The owner removed this player — fold for them (always legal for
        // an active seat; see computeLegalActions). Reuses the bot-move
        // timer slot: every path that cancels a pending bot move (hand
        // end, reset, dispose) must cancel this too.
        this.clearClock();
        this.actionDeadline = null;
        this.clearBotMove();
        this.botMoveTimer = setTimeout(() => {
          this.botMoveTimer = null;
          if (this.state.phase !== 'in-hand' || this.state.betting.actingSeat !== actingSeat) return;
          this.applyPlayerAction(actingSeat, { seatId: actingSeat, type: 'fold' }, true);
        }, FORCED_FOLD_DELAY_MS);
        return;
      }
      if (liveSeat?.botPolicyName) {
        this.clearClock();
        this.actionDeadline = null;
        this.scheduleBotMove(actingSeat, liveSeat.botPolicyName);
        return;
      }
    }
    this.armClock();
  }

  private clearBotMove(): void {
    if (this.botMoveTimer) clearTimeout(this.botMoveTimer);
    this.botMoveTimer = null;
  }

  private clearNextHandTimer(): void {
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    this.nextHandTimer = null;
  }

  private scheduleBotMove(seatId: number, policyName: string): void {
    this.clearBotMove();
    const delay = BOT_MOVE_MIN_MS + this.botRng.nextInt(BOT_MOVE_JITTER_MS);
    this.botMoveTimer = setTimeout(() => {
      this.playBotTurn(seatId, policyName);
    }, delay);
  }

  /** Computes and applies one computer player's move, through the exact same `applyPlayerAction` path a real client's action takes. */
  private playBotTurn(seatId: number, policyName: string): void {
    this.botMoveTimer = null;
    // The table may have moved on since this was scheduled (hand ended
    // some other way, the bot was removed) — bail out silently rather
    // than applying a now-nonsensical action.
    if (this.state.phase !== 'in-hand' || this.state.betting.actingSeat !== seatId) return;
    const liveSeat = this.seats[seatId];
    if (liveSeat?.botPolicyName !== policyName) return;
    const policy = this.botPolicies.get(policyName);
    if (!policy) return;
    const view = projectSeatView(this.state, seatId);
    const legal = getLegalActions(this.state, seatId);
    const action = policy.decide(view, legal, this.botRng);
    this.applyPlayerAction(seatId, action);
  }

  private handleTimeout(): void {
    const actingSeatId = this.state.betting.actingSeat;
    if (actingSeatId === null || this.state.phase !== 'in-hand') return;
    const seat = this.seats[actingSeatId];
    if (seat) {
      seat.consecutiveTimeouts += 1;
      seat.timeBankMsRemaining = 0;
    }
    // On timeout: check if free, otherwise fold.
    const toCall = this.state.betting.currentBet - (this.state.seats[actingSeatId]?.committedThisStreet ?? 0);
    const action: PlayerAction = toCall <= 0 ? { seatId: actingSeatId, type: 'check' } : { seatId: actingSeatId, type: 'fold' };
    this.applyPlayerAction(actingSeatId, action, true);

    const MAX_CONSECUTIVE_TIMEOUTS = 3;
    if (seat && seat.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
      seat.sittingOutRequested = true;
    }
  }

  /**
   * The entry point for a real client's action intent, over the wire.
   * Rejects stale/duplicate/mismatched-hand submissions before the
   * action ever reaches the engine — `handId` must match the hand
   * currently in progress, and `actionSeq` must match the table's
   * current `actionSeq` (which the engine increments on every applied
   * action), so a replayed or out-of-order message can never land.
   */
  submitAction(
    seatId: number,
    intent: { handId: string; actionSeq: number; type: PlayerAction['type']; amountTo?: number | undefined },
  ): { ok: true } | { ok: false; code: string; message: string } {
    if (this.currentHandId === null || intent.handId !== this.currentHandId) {
      return { ok: false, code: 'STALE_HAND', message: 'This action refers to a hand that is not currently in progress.' };
    }
    if (intent.actionSeq !== this.state.actionSeq) {
      return { ok: false, code: 'STALE_ACTION_SEQ', message: 'This action is out of sequence (stale or duplicate).' };
    }
    const action: PlayerAction = intent.amountTo === undefined ? { seatId, type: intent.type } : { seatId, type: intent.type, amountTo: intent.amountTo };
    return this.applyPlayerAction(seatId, action);
  }

  /** The one entry point for a real player's action; server-validated end to end via the engine. */
  applyPlayerAction(seatId: number, action: PlayerAction, isTimeout = false): { ok: true } | { ok: false; code: string; message: string } {
    if (this.state.phase !== 'in-hand') return { ok: false, code: 'HAND_NOT_ACTIVE', message: 'No hand is in progress.' };
    if (this.state.betting.actingSeat !== seatId) return { ok: false, code: 'NOT_YOUR_TURN', message: 'It is not your turn.' };

    const msToAct = this.callbacks.now() - this.lastActionAt;
    const result = applyAction(this.state, action);
    if (!result.ok) {
      return { ok: false, code: result.error.code, message: result.error.message };
    }

    if (this.actionLog.length > 0) {
      const last = this.actionLog[this.actionLog.length - 1];
      if (last && last.seat === seatId) last.msToAct = msToAct;
    }
    this.lastActionAt = this.callbacks.now();
    const seat = this.seats[seatId];
    if (seat) {
      if (!isTimeout) seat.consecutiveTimeouts = 0;
      // Time bank: refund unused main clock time isn't modeled granularly; refill happens per-orbit in the table registry's hand-complete hook.
    }

    this.state = result.state;
    this.recordEngineEvents(result.events);

    if (this.state.phase === 'hand-complete') {
      this.foldWinSeatId = this.computeFoldWinSeatId(result.events);
      this.clearClock();
      this.clearBotMove();
      this.actionDeadline = null;
      this.nextHandAt = this.callbacks.now() + HAND_BREAK_MS;
      // canStartHand() is derived fresh on every projection, but nothing
      // else naturally prompts a NEW broadcast once the break elapses on
      // its own — without this, every viewer's client keeps showing the
      // last-known (false) canStartHand forever, until some unrelated
      // event happens to trigger another broadcast. This is the same
      // "make sure a client eventually finds out, even with nobody doing
      // anything" role armClock()'s own clockTimer plays for the action
      // clock, just a plain broadcast instead of a forced action.
      this.clearNextHandTimer();
      this.nextHandTimer = setTimeout(() => this.broadcastAll([]), HAND_BREAK_MS);
      // settleHand snapshots everything it needs synchronously, before its
      // first await — so the hand-end changes below (pending rebuys landing
      // on stacks, removed players leaving) can never leak into this hand's
      // own results or ledger entries.
      const finishedHand = { initial: this.currentHandInitialState, handId: this.currentHandId, startedAt: this.handStartedAt };
      void this.settleHand();
      if (finishedHand.initial && finishedHand.handId) this.bookHand(finishedHand.initial, finishedHand.handId, finishedHand.startedAt, result.events);
      this.applyHandEndChanges();
      this.reconcileBook();
      void this.saveReport();
    } else {
      this.armClockOrBot();
    }

    this.broadcastAll(result.events);
    return { ok: true };
  }

  private async settleHand(): Promise<void> {
    if (!this.currentHandInitialState || !this.currentHandRng) return;
    // Everything below the first `await` must come from this snapshot, not
    // live fields: applyHandEndChanges runs right after this method yields
    // and changes stacks/seats. See applyPlayerAction.
    const finalState = this.state;
    const initialState = this.currentHandInitialState;
    const rng = this.currentHandRng;
    const handId = this.currentHandId;
    const actionLog = [...this.actionLog];
    const revealedSeatIds = new Set(this.revealedSeatIds);
    const userIdBySeat = new Map(this.seats.map((s) => [s.seatId, s.userId]));
    const handStartedAt = this.handStartedAt;
    this.currentHandRng = null;
    this.currentHandInitialState = null;
    const endedAt = new Date();
    const potTotal = finalState.pots.reduce((s, p) => s + p.amount, 0);
    const rake = this.settings.rakePercent > 0 ? Math.min(Math.floor((potTotal * this.settings.rakePercent) / 100), this.settings.rakeCap || Infinity) : 0;

    const winningsBySeat = new Map<number, { amount: number; handName: string | null; bestFive: readonly Card[] | null }>();
    // Re-derive from state: net result per seat = final stack - (stack at hand start - committedThisHand contribution isn't tracked post-reset).
    // We instead reconstruct net result as (current stack - starting stack for the hand), using the initial snapshot.
    for (const seat of finalState.seats) {
      const before = initialState.seats.find((s) => s.seatId === seat.seatId);
      if (!before) continue;
      const net = seat.stack - before.stack;
      if (net !== 0) winningsBySeat.set(seat.seatId, { amount: net, handName: null, bestFive: null });
    }

    const ledgerEntries: { userId: string; amount: number }[] = [];
    for (const [seatId, w] of winningsBySeat) {
      const userId = userIdBySeat.get(seatId);
      if (userId) ledgerEntries.push({ userId, amount: w.amount });
    }
    if (ledgerEntries.length > 0) {
      const houseAmount = -ledgerEntries.reduce((s, e) => s + e.amount, 0);
      await this.store.recordLedgerEntries([
        ...ledgerEntries.map((e) => ({ userId: e.userId, isHouse: false, amount: e.amount, reason: 'pot_win' as const, tableId: this.tableId })),
        ...(houseAmount !== 0 ? [{ userId: null, isHouse: true, amount: houseAmount, reason: 'pot_win' as const, tableId: this.tableId }] : []),
      ]);
    }

    if (!handId) return;
    await this.store.recordHand({
      id: handId,
      tableId: this.tableId,
      handNumber: finalState.handNumber,
      buttonSeat: finalState.buttonSeat,
      boardCards: finalState.board,
      potTotal,
      rakeTaken: rake,
      initialState,
      seats: initialState.seats
        .filter((s) => s.status !== 'empty')
        .map((s) => {
          const finalSeat = finalState.seats.find((fs) => fs.seatId === s.seatId);
          return {
            seat: s.seatId,
            userId: userIdBySeat.get(s.seatId) ?? null,
            startingStack: s.stack,
            holeCards: finalSeat?.holeCards ?? [],
            netResult: (finalSeat?.stack ?? s.stack) - s.stack,
            showedDown: revealedSeatIds.has(s.seatId),
          };
        }),
      actions: actionLog,
      results: [], // pot-awarded detail is available in the broadcast event log; kept minimal here for time
      rngCommit: {
        commitment: rng.commitment,
        serverSeed: rng.serverSeed,
        clientSeeds: rng.clientSeeds,
        nonce: rng.nonce,
        deckOrder: this.currentHandDeck,
        revealedAt: endedAt,
      },
      startedAt: handStartedAt ?? endedAt,
      endedAt,
    });

    // currentHandRng/currentHandInitialState were nulled at the top (they
    // guard this whole method against a double-settlement re-entry — see
    // the early return). Deliberately NOT nulling currentHandId, though. `projectionFor()`'s
    // `handId` needs to keep identifying the just-finished hand for the
    // ENTIRE post-hand break (the "Verify hand fairness" link is gated on
    // `state.handId` being truthy) — it's overwritten with a fresh id the
    // moment the next hand actually deals (startNextHand(), a few lines
    // below this method). This was invisible before nextHandTimer existed
    // (see applyPlayerAction) since nothing re-broadcast between a hand
    // ending and the next one starting to expose the already-nulled id.
  }

  /** Between hands: refill time banks, apply queued sit-outs, auto-sit-out busted seats. Call before startNextHand(). */
  prepareNextOrbit(): void {
    for (const seat of this.seats) {
      seat.timeBankMsRemaining = Math.min(seat.timeBankMsRemaining + DEFAULT_TIME_BANK_REFILL_MS, this.settings.timeBankSeconds * 1000);
    }
    this.applyPendingSitOuts();
    const newSeats = this.state.seats.map((s) => (s.status === 'active' && s.stack === 0 ? { ...s, status: 'sitting-out' as const } : s));
    this.state = { ...this.state, seats: newSeats };
  }

  /**
   * Owner-only rebuy/add-on, any time; the caller has already capped the
   * amount and debited the player. A seat still in the hand in progress
   * gets it as `pendingChips`, credited when the hand ends (its stack is
   * part of that hand's all-in/side-pot math, so it can't change mid-hand).
   * Any other seat gets it on its stack right now. A busted seat that was
   * sat out is dealt back in — right away between hands, or from the next
   * hand if one is running.
   */
  addChips(seatId: number, amount: number): { appliedNow: boolean } {
    const liveSeat = this.seats[seatId];
    if (!liveSeat) return { appliedNow: false };
    liveSeat.sittingOutRequested = false;
    const who = this.bookIdentity(seatId);
    const inHand = this.isInCurrentHand(seatId) && this.state.seats[seatId]?.status !== 'folded';
    if (who) this.book.buyIn(who.key, who.name, who.kind, amount, 'rebuy', this.nowDate(), inHand ? 'added mid-hand, on the stack once the hand ended' : null);
    void this.saveReport();
    if (inHand) {
      liveSeat.pendingChips += amount;
      return { appliedNow: false };
    }
    if (this.inHand) this.handChipAdds.set(seatId, (this.handChipAdds.get(seatId) ?? 0) + amount);
    // A folded seat's stack takes no further part in the hand, so it can
    // grow now. Its status stays 'folded' — the engine resets it at the
    // next deal (see resetSeatForNewHand).
    const newSeats = this.state.seats.map((s, i) => {
      if (i !== seatId) return s;
      const stack = s.stack + amount;
      if (s.status !== 'sitting-out') return { ...s, stack };
      if (this.inHand) {
        liveSeat.joinsNextHand = true;
        return { ...s, stack };
      }
      return { ...s, stack, status: 'active' as const };
    });
    this.state = { ...this.state, seats: newSeats };
    return { appliedNow: true };
  }

  /**
   * How much the owner can still add to this seat, counting chips still
   * pending. The owner has full control of anyone's chips — the table's max
   * buy-in doesn't cap a rebuy (an open-invite table's starting chips can be
   * above it anyway); only the app-wide balance ceiling does.
   */
  rebuyHeadroom(seatId: number): number {
    return Math.max(0, MAX_BALANCE_CENTS - this.cashOutAmount(seatId));
  }

  /**
   * Books a finished hand: each dealt-in player's result is what they end
   * with minus what they started with — less any chips the owner added
   * straight onto their stack during the hand (not a result), and using
   * the stack a folded player left with if they left mid-hand. Results
   * always sum to zero (no rake is taken); the book's own running counts
   * are checked against the table right after (reconcileBook).
   */
  private bookHand(initial: TableState, handId: string, startedAt: Date | null, events: readonly GameEvent[]): void {
    const final = this.state;
    const results = new Map<string, number>();
    for (const start of initial.seats) {
      if (start.status === 'empty' || !start.playerId) continue;
      const end = final.seats[start.seatId];
      const leaver = this.handLeavers.get(start.seatId);
      const left = leaver?.key === start.playerId;
      const dealtIn = left || (end?.playerId === start.playerId && (end.status === 'active' || end.status === 'folded' || end.status === 'all-in'));
      if (!dealtIn || !end) continue;
      // A player who left mid-hand took their stack with them; the seat now shows 0.
      const endStack = left ? leaver.stack : end.stack;
      results.set(start.playerId, endStack - (this.handChipAdds.get(start.seatId) ?? 0) - start.stack);
    }
    // One line per winner per hand: a player who takes the main pot and a
    // side pot gets their total, described by the first pot's hand.
    const byWinner = new Map<string, { key: string; amount: number; handName: string | null }>();
    for (const e of events) {
      if (e.type !== 'pot-awarded') continue;
      for (const w of e.winners) {
        const key = final.seats[w.seatId]?.playerId;
        if (!key) continue;
        const prev = byWinner.get(key);
        byWinner.set(key, { key, amount: (prev?.amount ?? 0) + w.amount, handName: prev?.handName ?? w.handName ?? null });
      }
    }
    const winners = [...byWinner.values()];
    this.book.tableName = this.name;
    this.book.recordHand({
      number: final.handNumber,
      handId,
      startedAt: startedAt ?? this.nowDate(),
      endedAt: this.nowDate(),
      smallBlind: initial.config.smallBlind,
      bigBlind: initial.config.bigBlind,
      ante: initial.config.ante,
      board: final.board,
      pot: final.pots.reduce((sum, p) => sum + p.amount, 0),
      results,
      winners,
    });
  }

  /** Checks the book's chip count for every seated player against what the table holds for them (stack + pending). A mismatch is a bookkeeping bug — logged, and flagged in the report. */
  private reconcileBook(): void {
    const actual = new Map<string, number>();
    for (let seatId = 0; seatId < this.state.seats.length; seatId++) {
      const who = this.bookIdentity(seatId);
      if (who) actual.set(who.key, this.cashOutAmount(seatId));
    }
    const mismatched = this.book.reconcile(actual);
    if (mismatched.length > 0) {
      process.stderr.write(`Game book for table ${this.tableId} disagrees with the table after hand #${String(this.state.handNumber)} for: ${mismatched.join(', ')}\n`);
    }
  }

  /**
   * Runs the moment a hand ends: everything the owner changed mid-hand
   * that had to wait for it — queued blinds/ante/seat-count, pending
   * rebuys onto stacks, mid-hand joiners dealt in, removed players
   * vacated (and handed to `onSeatsVacated` for their refund).
   */
  private applyHandEndChanges(): void {
    if (Object.keys(this.pendingConfig).length > 0) {
      this.settings = { ...this.settings, ...this.pendingConfig };
      this.state = { ...this.state, config: { ...this.state.config, ...this.pendingConfig } };
      this.pendingConfig = {};
    }

    const vacated: VacatedSeat[] = [];
    for (const liveSeat of this.seats) {
      const seatId = liveSeat.seatId;
      if (liveSeat.pendingRemoval) {
        const deleteSeat = liveSeat.pendingRemoval === 'seat';
        vacated.push(this.vacateSeat(seatId, deleteSeat ? 'removed by the owner (seat deleted), after the hand' : 'removed by the owner, after the hand'));
        if (deleteSeat) this.markSeatRemoved(seatId);
        continue;
      }
      if (liveSeat.pendingChips > 0) {
        const amount = liveSeat.pendingChips;
        liveSeat.pendingChips = 0;
        this.state = { ...this.state, seats: this.state.seats.map((s, i) => (i === seatId ? { ...s, stack: s.stack + amount } : s)) };
      }
      if (liveSeat.joinsNextHand) {
        liveSeat.joinsNextHand = false;
        const engineSeat = this.state.seats[seatId];
        if (engineSeat?.status === 'sitting-out' && engineSeat.stack > 0 && !liveSeat.sittingOutRequested) {
          this.state = { ...this.state, seats: this.state.seats.map((s, i) => (i === seatId ? { ...s, status: 'active' as const } : s)) };
        }
      }
    }
    if (vacated.length > 0) this.callbacks.onSeatsVacated?.(this.tableId, vacated);
  }

  seatMetaMap(): Map<number, SeatMeta> {
    const map = new Map<number, SeatMeta>();
    for (const s of this.seats) {
      map.set(s.seatId, {
        playerId: s.userId,
        displayName: s.displayName,
        isGuest: s.isGuest,
        avatarSeed: s.avatarSeed,
        isConnected: s.isConnected,
        lastAction: s.lastAction,
        timeBankMs: s.timeBankMsRemaining,
        isBot: s.botPolicyName !== null,
        ownerNickname: s.ownerNickname,
        pendingChips: s.pendingChips,
        leavingAfterHand: s.pendingRemoval !== null,
        joiningNextHand: s.joinsNextHand,
      });
    }
    return map;
  }

  get handId(): string | null {
    return this.currentHandId;
  }

  /** See `ProjectedTableState.revealEligibleSeatId`'s doc comment. */
  get revealEligibleSeatId(): number | null {
    if (this.state.phase !== 'hand-complete' || this.foldWinSeatId === null) return null;
    return this.revealedSeatIds.has(this.foldWinSeatId) ? null : this.foldWinSeatId;
  }

  /**
   * A human voluntarily shows their hand after winning a pot nobody else
   * contested to the end — either "showing the bluff" or just showing a
   * real hand for fun. Only the seat that actually won that way, only
   * once, and only before the next hand deals (`handId` still identifies
   * the just-finished hand until then — see the `currentHandId` doc
   * comment in `settleHand`). Reuses the same `showdown-reveal` event a
   * genuine showdown broadcasts, so every client's existing "make this
   * seat's hole cards visible" logic (projection.ts's `revealedSeatIds`
   * gate) picks it up with no special-casing.
   */
  revealHand(seatId: number, handId: string): { ok: true } | { ok: false; code: string; message: string } {
    if (this.currentHandId === null || handId !== this.currentHandId) {
      return { ok: false, code: 'STALE_HAND', message: 'This action refers to a hand that is not currently in progress.' };
    }
    if (this.revealEligibleSeatId !== seatId) {
      return { ok: false, code: 'NOT_ELIGIBLE', message: 'You are not eligible to reveal your hand right now.' };
    }
    const engineSeat = this.state.seats[seatId];
    if (!engineSeat) return { ok: false, code: 'SEAT_EMPTY', message: 'That seat is empty.' };

    this.revealedSeatIds.add(seatId);
    const event: GameEvent = { type: 'showdown-reveal', seatId, holeCards: [...engineSeat.holeCards] };

    // Extend whatever's actually left on the current break, never shorten
    // it (a reveal arriving right as the break was about to elapse still
    // gets the dealer a full extra 1.5s, not "1.5s minus whatever's left").
    const now = this.callbacks.now();
    const remainingMs = this.nextHandAt !== null ? Math.max(0, this.nextHandAt - now) : 0;
    const extendedMs = remainingMs + REVEAL_HAND_BREAK_EXTENSION_MS;
    this.nextHandAt = now + extendedMs;
    this.clearNextHandTimer();
    this.nextHandTimer = setTimeout(() => this.broadcastAll([]), extendedMs);

    this.broadcastAll([event]);
    return { ok: true };
  }

  /** `viewerIsAdmin` reveals every seat's `ownerNickname` — see projectStateForSeat's own doc comment. Only ever passed `true` for the owner's own dedicated broadcast (adminRoom in socketServer.ts). */
  projectionFor(viewerSeatId: number | null, viewerIsAdmin = false): ProjectedTableState {
    return projectStateForSeat(
      this.state,
      {
        tableId: this.tableId,
        tableName: this.name,
        handId: this.currentHandId,
        handCommitment: this.currentHandRng?.commitment ?? null,
        waitlist: this.waitlist,
        settings: this.settings,
        seatMeta: this.seatMetaMap(),
        revealedSeatIds: this.revealedSeatIds,
        actionDeadline: this.actionDeadline,
        nextHandAt: this.nextHandAt,
        revealEligibleSeatId: this.revealEligibleSeatId,
        now: this.callbacks.now(),
        rakePot: 0,
        removedSeatIds: [...this.removedSeatIds].sort((a, b) => a - b),
        pendingSettings: this.pendingSettings,
        seatOffer: this.seatOffer,
      },
      viewerSeatId,
      viewerIsAdmin,
    );
  }

  private broadcastAll(events: readonly GameEvent[]): void {
    const perSeat = new Map<number | null, BroadcastPayload>();
    const viewers: (number | null)[] = [...this.seats.filter((s) => s.userId !== null).map((s) => s.seatId), null];
    for (const viewer of viewers) {
      perSeat.set(viewer, {
        toSeatId: viewer,
        state: this.projectionFor(viewer),
        events: events.flatMap((e) => projectEvent(e, viewer)),
      });
    }
    this.callbacks.onBroadcast(this.tableId, perSeat, events);
  }

  dispose(): void {
    this.clearClock();
    this.clearBotMove();
    this.clearNextHandTimer();
  }
}

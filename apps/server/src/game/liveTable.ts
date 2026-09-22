import { randomUUID } from 'node:crypto';
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
  projectEvent,
  projectStateForSeat,
  type ProjectedGameEvent,
  type ProjectedTableState,
  type SeatMeta,
  type TableSettings,
  type WaitlistEntry,
} from '@pokerclause/shared';
import { ALL_BOT_POLICIES, projectSeatView, type BotPolicy } from '@pokerclause/sim';
import type { Store } from '../db/store.js';
import { commitmentFor, deriveDeckForHand, generateServerSeed } from '../rng/commitReveal.js';

/**
 * Computer players, for practice/solo play — see `addBot`/`removeBot`
 * below. `adversarial` is excluded: it's a QA tool deliberately built to
 * probe engine edge cases (pinned-to-the-boundary raises, chained short
 * all-ins), not a fun or legible opponent for a casual game.
 */
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
}

const DEFAULT_TIME_BANK_REFILL_MS = 15000;

export class LiveTable {
  readonly tableId: string;
  name: string;
  settings: TableSettings;
  state: TableState;
  seats: LiveSeat[];
  private revealedSeatIds = new Set<number>();
  private actionLog: PendingActionLogEntry[] = [];
  private currentHandId: string | null = null;
  private currentHandInitialState: TableState | null = null;
  private currentHandDeck: readonly Card[] = [];
  private currentHandRng: { commitment: string; serverSeed: string; clientSeeds: string[]; nonce: number } | null = null;
  private handStartedAt: Date | null = null;
  private lastActionAt = 0;
  actionDeadline: number | null = null;
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private waitlist: WaitlistEntry[] = [];
  /** token -> pending owner-generated seat assignment. See createSeatAssignment/redeemSeatAssignment. */
  private readonly seatAssignments = new Map<string, { seatId: number; buyIn: number; ownerNickname: string | null }>();
  private botMoveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly botRng: RandomSource = cryptoSource();
  private readonly botPolicies = new Map<string, BotPolicy>(SELECTABLE_BOT_POLICIES.map((p) => [p.name, p]));

  constructor(
    tableId: string,
    name: string,
    settings: TableSettings,
    private readonly store: Store,
    private readonly callbacks: LiveTableCallbacks,
    readonly inviteCode: string | null = null,
  ) {
    this.tableId = tableId;
    this.name = name;
    this.settings = settings;
    this.state = this.freshState();
    this.seats = Array.from({ length: settings.maxSeats }, (_, seatId) => this.emptyLiveSeat(seatId));
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
    };
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
    const engineSeat = this.state.seats[seatId];
    if (!engineSeat || engineSeat.status !== 'empty') throw new Error('SEAT_TAKEN');
    const newEngineSeats = this.state.seats.map((s, i) =>
      i === seatId
        ? { ...s, playerId: userId, stack: buyIn, status: 'active' as const }
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
    };
    this.removeFromWaitlist(userId);
  }

  /**
   * Owner-only chip economy (see DECISIONS.md): the owner picks an empty
   * seat and a buy-in, generating a one-time token instead of seating
   * anyone directly — the human it's sent to redeems it themselves via
   * redeemSeatAssignment, which is what actually calls takeSeat. Kept as
   * simple in-memory bookkeeping on the table itself, consistent with
   * everything else about a live table (no DB row — these don't need to
   * survive a restart any more than an in-progress hand does).
   */
  createSeatAssignment(
    seatId: number,
    buyIn: number,
    ownerNickname: string | null = null,
  ): { ok: true; token: string } | { ok: false; code: string; message: string } {
    const engineSeat = this.state.seats[seatId];
    if (!engineSeat || engineSeat.status !== 'empty') return { ok: false, code: 'SEAT_TAKEN', message: 'That seat is not empty.' };
    if (buyIn < this.settings.minBuyIn || buyIn > this.settings.maxBuyIn) {
      return { ok: false, code: 'BUY_IN_OUT_OF_RANGE', message: `Buy-in must be between ${String(this.settings.minBuyIn)} and ${String(this.settings.maxBuyIn)}.` };
    }
    const token = randomUUID();
    this.seatAssignments.set(token, { seatId, buyIn, ownerNickname });
    return { ok: true, token };
  }

  /** Validates and consumes a seat-assignment token — the caller (socketServer.ts) still does the actual takeSeat + chip-ledger work, exactly like a normal take-seat, just sourcing seatId/buyIn/ownerNickname from here instead of the client's own say-so. */
  redeemSeatAssignment(
    token: string,
  ): { ok: true; seatId: number; buyIn: number; ownerNickname: string | null } | { ok: false; code: string; message: string } {
    const assignment = this.seatAssignments.get(token);
    if (!assignment) return { ok: false, code: 'INVALID_ASSIGNMENT', message: 'This invite link is invalid or has already been used.' };
    const engineSeat = this.state.seats[assignment.seatId];
    if (!engineSeat || engineSeat.status !== 'empty') {
      this.seatAssignments.delete(token);
      return { ok: false, code: 'SEAT_TAKEN', message: 'That seat was taken before this link was used.' };
    }
    this.seatAssignments.delete(token);
    return { ok: true, seatId: assignment.seatId, buyIn: assignment.buyIn, ownerNickname: assignment.ownerNickname };
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
    const engineSeat = this.state.seats[seatId];
    if (!engineSeat || engineSeat.status !== 'empty') return { ok: false, code: 'SEAT_TAKEN', message: 'That seat is not empty.' };
    const newEngineSeats = this.state.seats.map((s, i) =>
      i === seatId ? { ...s, playerId: `bot:${policy.name}:${String(seatId)}`, stack: buyIn, status: 'active' as const } : s,
    );
    this.state = { ...this.state, seats: newEngineSeats };
    this.seats[seatId] = {
      ...this.emptyLiveSeat(seatId),
      displayName: BOT_PERSONA_LABELS[policy.name] ?? policy.name,
      avatarSeed: `bot-${policy.name}`,
      isConnected: true,
      botPolicyName: policy.name,
    };
    return { ok: true };
  }

  removeBot(seatId: number): { ok: true } | { ok: false; code: string; message: string } {
    const engineSeat = this.state.seats[seatId];
    const liveSeat = this.seats[seatId];
    if (!engineSeat || !liveSeat?.botPolicyName || engineSeat.status === 'empty') {
      return { ok: false, code: 'NOT_A_BOT', message: 'That seat is not a computer player.' };
    }
    if (this.state.phase === 'in-hand' && (engineSeat.status === 'active' || engineSeat.status === 'all-in')) {
      return { ok: false, code: 'CANNOT_REMOVE_MID_HAND', message: 'Cannot remove a computer player mid-hand.' };
    }
    const newEngineSeats = this.state.seats.map((s, i) => (i === seatId ? { ...s, playerId: '', stack: 0, status: 'empty' as const } : s));
    this.state = { ...this.state, seats: newEngineSeats };
    this.seats[seatId] = this.emptyLiveSeat(seatId);
    return { ok: true };
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
    const result = { userId: liveSeat.userId, stack: engineSeat.stack };
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
    this.seatAssignments.clear(); // any not-yet-redeemed invite links are void once the table's reset
    const refunds: { userId: string; stack: number }[] = [];
    for (let i = 0; i < this.seats.length; i++) {
      const liveSeat = this.seats[i]!;
      const engineSeat = this.state.seats[i];
      if (liveSeat.userId && engineSeat) refunds.push({ userId: liveSeat.userId, stack: engineSeat.stack });
    }
    this.state = this.freshState();
    this.seats = Array.from({ length: this.settings.maxSeats }, (_, seatId) => this.emptyLiveSeat(seatId));
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
    return this.state.phase !== 'in-hand' && this.dealtInCount() >= 2 && hasHuman;
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
    this.actionLog = [];
    this.revealedSeatIds = new Set();
    this.handStartedAt = new Date();
    this.lastActionAt = this.callbacks.now();

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
      this.clearClock();
      this.clearBotMove();
      this.actionDeadline = null;
      void this.settleHand();
    } else {
      this.armClockOrBot();
    }

    this.broadcastAll(result.events);
    return { ok: true };
  }

  private async settleHand(): Promise<void> {
    if (!this.currentHandInitialState || !this.currentHandRng) return;
    const endedAt = new Date();
    const potTotal = this.state.pots.reduce((s, p) => s + p.amount, 0);
    const rake = this.settings.rakePercent > 0 ? Math.min(Math.floor((potTotal * this.settings.rakePercent) / 100), this.settings.rakeCap || Infinity) : 0;

    const winningsBySeat = new Map<number, { amount: number; handName: string | null; bestFive: readonly Card[] | null }>();
    // Re-derive from state: net result per seat = final stack - (stack at hand start - committedThisHand contribution isn't tracked post-reset).
    // We instead reconstruct net result as (current stack - starting stack for the hand), using the initial snapshot.
    for (const seat of this.state.seats) {
      const before = this.currentHandInitialState.seats.find((s) => s.seatId === seat.seatId);
      if (!before) continue;
      const net = seat.stack - before.stack;
      if (net !== 0) winningsBySeat.set(seat.seatId, { amount: net, handName: null, bestFive: null });
    }

    const ledgerEntries: { userId: string; amount: number }[] = [];
    for (const [seatId, w] of winningsBySeat) {
      const userId = this.seats[seatId]?.userId;
      if (userId) ledgerEntries.push({ userId, amount: w.amount });
    }
    if (ledgerEntries.length > 0) {
      const houseAmount = -ledgerEntries.reduce((s, e) => s + e.amount, 0);
      await this.store.recordLedgerEntries([
        ...ledgerEntries.map((e) => ({ userId: e.userId, isHouse: false, amount: e.amount, reason: 'pot_win' as const, tableId: this.tableId })),
        ...(houseAmount !== 0 ? [{ userId: null, isHouse: true, amount: houseAmount, reason: 'pot_win' as const, tableId: this.tableId }] : []),
      ]);
    }

    if (!this.currentHandId) return;
    await this.store.recordHand({
      id: this.currentHandId,
      tableId: this.tableId,
      handNumber: this.state.handNumber,
      buttonSeat: this.state.buttonSeat,
      boardCards: this.state.board,
      potTotal,
      rakeTaken: rake,
      initialState: this.currentHandInitialState,
      seats: this.currentHandInitialState.seats
        .filter((s) => s.status !== 'empty')
        .map((s) => {
          const finalSeat = this.state.seats.find((fs) => fs.seatId === s.seatId);
          return {
            seat: s.seatId,
            userId: this.seats[s.seatId]?.userId ?? null,
            startingStack: s.stack,
            holeCards: finalSeat?.holeCards ?? [],
            netResult: (finalSeat?.stack ?? s.stack) - s.stack,
            showedDown: this.revealedSeatIds.has(s.seatId),
          };
        }),
      actions: this.actionLog,
      results: [], // pot-awarded detail is available in the broadcast event log; kept minimal here for time
      rngCommit: {
        commitment: this.currentHandRng.commitment,
        serverSeed: this.currentHandRng.serverSeed,
        clientSeeds: this.currentHandRng.clientSeeds,
        nonce: this.currentHandRng.nonce,
        deckOrder: this.currentHandDeck,
        revealedAt: endedAt,
      },
      startedAt: this.handStartedAt ?? endedAt,
      endedAt,
    });

    this.currentHandRng = null;
    this.currentHandInitialState = null;
    this.currentHandId = null;
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

  /** Between-hand top-up: adds chips to a busted (or any) seat's stack, capped by the caller against maxBuyIn. */
  rebuy(seatId: number, amount: number): void {
    if (this.state.phase === 'in-hand') throw new Error('CANNOT_REBUY_MID_HAND');
    const newSeats = this.state.seats.map((s, i) =>
      i === seatId ? { ...s, stack: s.stack + amount, status: s.status === 'sitting-out' && s.stack + amount > 0 ? ('active' as const) : s.status } : s,
    );
    this.state = { ...this.state, seats: newSeats };
    const liveSeat = this.seats[seatId];
    if (liveSeat) liveSeat.sittingOutRequested = false;
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
      });
    }
    return map;
  }

  get handId(): string | null {
    return this.currentHandId;
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
        rakePot: 0,
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
  }
}

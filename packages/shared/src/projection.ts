import type { GameEvent, TableState } from '@pokerclause/engine';
import { getLegalActions } from '@pokerclause/engine';
import type { ProjectedGameEvent } from './events.js';
import type { ProjectedSeat, ProjectedTableState, TableSettings, WaitlistEntry } from './types.js';

export interface SeatMeta {
  playerId: string | null;
  displayName: string | null;
  isGuest: boolean;
  avatarSeed: string | null;
  isConnected: boolean;
  lastAction: { type: string; amountTo?: number } | null;
  timeBankMs: number;
  isBot: boolean;
  ownerNickname: string | null;
}

export interface ProjectionContext {
  tableId: string;
  tableName: string;
  settings: TableSettings;
  seatMeta: ReadonlyMap<number, SeatMeta>;
  /**
   * Seats whose hole cards are legitimately public this hand (from a real
   * showdown-reveal — never populated just because a hand ended by fold).
   */
  revealedSeatIds: ReadonlySet<number>;
  actionDeadline: number | null;
  /** Epoch ms — a new hand can't start before this (the post-hand shuffle break). */
  nextHandAt: number | null;
  /** Server's own clock at projection time — compared against `nextHandAt` for `canStartHand`, not `Date.now()`, so this stays testable with a fake clock exactly like `actionDeadline` already is. */
  now: number;
  rakePot: number;
  handId: string | null;
  handCommitment: string | null;
  waitlist: readonly WaitlistEntry[];
}

const EMPTY_SEAT_META: SeatMeta = {
  playerId: null,
  displayName: null,
  isGuest: false,
  avatarSeed: null,
  isConnected: false,
  lastAction: null,
  timeBankMs: 0,
  isBot: false,
  ownerNickname: null,
};

/**
 * The anti-cheat boundary: builds exactly what one viewer (a seated
 * player, identified by `viewerSeatId`, or `null` for a spectator) is
 * allowed to receive. Never includes `state.deck`, `state.burned`, or any
 * OTHER seat's real hole cards unless that seat is in `revealedSeatIds`.
 * `legalActions` is only ever populated when it's genuinely this
 * viewer's own seat's turn. See `projection.test.ts` for the dedicated
 * leak assertion this function must satisfy.
 *
 * `viewerIsAdmin` gates `ownerNickname` the same way `viewerSeatId` gates
 * hole cards — `false` (the default, used for every regular seat/
 * spectator broadcast) forces every seat's `ownerNickname` to `null`
 * regardless of what's actually stored; only the table owner's own
 * dedicated broadcast (see `adminRoom` in socketServer.ts) passes `true`.
 */
export function projectStateForSeat(
  state: TableState,
  ctx: ProjectionContext,
  viewerSeatId: number | null,
  viewerIsAdmin = false,
): ProjectedTableState {
  const seats: ProjectedSeat[] = state.seats.map((s) => {
    const meta = ctx.seatMeta.get(s.seatId) ?? EMPTY_SEAT_META;
    const showRealCards = s.seatId === viewerSeatId || ctx.revealedSeatIds.has(s.seatId);
    return {
      seatId: s.seatId,
      playerId: meta.playerId,
      displayName: meta.displayName,
      isGuest: meta.isGuest,
      avatarSeed: meta.avatarSeed,
      stack: s.stack,
      holeCards: showRealCards ? s.holeCards : [],
      status: s.status,
      committedThisStreet: s.committedThisStreet,
      committedThisHand: s.committedThisHand,
      hasActedThisRound: s.hasActedThisRound,
      isAllowedToRaise: s.isAllowedToRaise,
      isConnected: meta.isConnected,
      missedSmallBlind: s.missedSmallBlind,
      missedBigBlind: s.missedBigBlind,
      lastAction: meta.lastAction,
      timeBankMs: meta.timeBankMs,
      isBot: meta.isBot,
      ownerNickname: viewerIsAdmin ? meta.ownerNickname : null,
    };
  });

  const legalActions =
    viewerSeatId !== null && state.phase === 'in-hand' && state.betting.actingSeat === viewerSeatId
      ? getLegalActions(state, viewerSeatId)
      : null;

  // Mirrors LiveTable.canStartHand() exactly (same underlying seat data,
  // just read from the engine's own TableState + this projection's seat
  // metadata instead of LiveTable's private bookkeeping). In particular,
  // "dealt-in" here means "will be active on the next deal" (not empty,
  // not sitting out, has chips) — NOT literally status === 'active' right
  // now, since a seat that folded or went all-in last hand stays that way
  // until the next hand's dealing resets it. See LiveTable.dealtInCount.
  const dealtInCount = state.seats.filter((s) => s.status !== 'empty' && s.status !== 'sitting-out' && s.stack > 0).length;
  const hasHuman = state.seats.some((s) => (ctx.seatMeta.get(s.seatId) ?? EMPTY_SEAT_META).playerId !== null);
  const breakOver = ctx.nextHandAt === null || ctx.now >= ctx.nextHandAt;
  const canStartHand = state.phase !== 'in-hand' && dealtInCount >= 2 && hasHuman && breakOver;

  return {
    tableId: ctx.tableId,
    tableName: ctx.tableName,
    handId: ctx.handId,
    handNumber: state.handNumber,
    actionSeq: state.actionSeq,
    handCommitment: ctx.handCommitment,
    settings: ctx.settings,
    seats,
    buttonSeat: state.buttonSeat,
    street: state.street,
    board: state.board,
    betting: state.betting,
    pots: state.pots,
    anteTotal: state.anteTotal,
    phase: state.phase,
    canStartHand,
    legalActions,
    viewerSeatId,
    actionDeadline: ctx.actionDeadline,
    nextHandAt: ctx.nextHandAt,
    rakePot: ctx.rakePot,
    waitlist: ctx.waitlist,
  };
}

/**
 * Redacts a single engine GameEvent for broadcast. `cards-dealt` (which
 * carries every dealt seat's real hole cards) is split: the viewer's own
 * cards go out as a separate `your-cards` event (never broadcast to
 * anyone else), and everyone gets a card-value-free `cards-dealt` so
 * clients can still play the deal animation.
 */
export function projectEvent(event: GameEvent, viewerSeatId: number | null): ProjectedGameEvent[] {
  if (event.type === 'cards-dealt') {
    const out: ProjectedGameEvent[] = [{ type: 'cards-dealt', seats: event.deals.map((d) => d.seatId) }];
    if (viewerSeatId !== null) {
      const own = event.deals.find((d) => d.seatId === viewerSeatId);
      if (own) out.push({ type: 'your-cards', cards: own.cards });
    }
    return out;
  }
  return [event];
}

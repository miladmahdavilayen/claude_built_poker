import { getLegalActions, type PlayerAction, type TableState } from '@pokerclause/engine';

export interface InvariantViolation {
  code: string;
  message: string;
  actual?: unknown;
  expected?: unknown;
}

export class InvariantFailure extends Error {
  readonly violation: InvariantViolation;
  constructor(violation: InvariantViolation) {
    super(`[${violation.code}] ${violation.message}`);
    this.violation = violation;
  }
}

function fail(code: string, message: string, actual?: unknown, expected?: unknown): never {
  throw new InvariantFailure({ code, message, actual, expected });
}

/** Total chips accounted for: in stacks, or committed-but-not-yet-potted this hand (incl. antes). */
export function currentTotal(state: TableState): number {
  const inStacks = state.seats.reduce((sum, s) => sum + s.stack, 0);
  if (state.phase === 'hand-complete' || state.phase === 'waiting') return inStacks;
  const committed = state.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
  return inStacks + committed + state.anteTotal;
}

const STREET_BOARD_LENGTH: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 };
const STREET_BURN_COUNT: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3, showdown: 3 };

/** Invariants checkable from a single TableState snapshot (1, 3-9, 11, 12, 14-16). */
export function checkStateInvariants(state: TableState, initialTotal: number): void {
  // 1. Conservation.
  const total = currentTotal(state);
  if (total !== initialTotal) {
    fail('CONSERVATION', 'chip total drifted from the hand-start total', total, initialTotal);
  }

  // 3. No negative stacks or pots.
  for (const seat of state.seats) {
    if (seat.stack < 0) fail('NEGATIVE_STACK', `seat ${String(seat.seatId)} has a negative stack`, seat.stack);
  }
  for (const pot of state.pots) {
    if (pot.amount < 0) fail('NEGATIVE_POT', `pot ${String(pot.index)} has a negative amount`, pot.amount);
  }

  // 4. deck ∪ board ∪ burned ∪ all holeCards === exactly the 52-card deck.
  const seen = new Set<string>();
  let total52 = 0;
  const record = (c: string): void => {
    if (seen.has(c)) fail('DUPLICATE_CARD', `card ${c} appears twice across deck/board/burned/hole cards`, c);
    seen.add(c);
    total52 += 1;
  };
  for (const c of state.deck) record(c);
  for (const c of state.board) record(c);
  for (const c of state.burned) record(c);
  for (const seat of state.seats) for (const c of seat.holeCards) record(c);
  if (total52 !== 52) fail('CARD_COUNT', 'deck+board+burned+hole cards must total exactly 52', total52, 52);

  if (state.phase === 'in-hand') {
    // 5. board length matches street.
    const expectedBoard = STREET_BOARD_LENGTH[state.street] ?? 0;
    if (state.board.length !== expectedBoard) {
      fail('BOARD_LENGTH', `board length does not match street ${state.street}`, state.board.length, expectedBoard);
    }
    // 6. burned length matches streets dealt past preflop.
    const expectedBurn = STREET_BURN_COUNT[state.street] ?? 0;
    if (state.burned.length !== expectedBurn) {
      fail('BURN_COUNT', `burned count does not match street ${state.street}`, state.burned.length, expectedBurn);
    }
    // 7. currentBet equals the max committedThisStreet.
    const maxCommitted = Math.max(0, ...state.seats.map((s) => s.committedThisStreet));
    if (state.betting.currentBet !== maxCommitted) {
      fail('CURRENT_BET_MISMATCH', 'currentBet does not equal the max committedThisStreet', state.betting.currentBet, maxCommitted);
    }
    // 8. lastFullRaiseIncrement > 0 whenever currentBet > 0.
    if (state.betting.currentBet > 0 && state.betting.lastFullRaiseIncrement <= 0) {
      fail('ZERO_RAISE_INCREMENT', 'lastFullRaiseIncrement must be positive whenever currentBet > 0', state.betting.lastFullRaiseIncrement);
    }
    // 12. an all-in seat is never the acting seat.
    if (state.betting.actingSeat !== null) {
      const actor = state.seats.find((s) => s.seatId === state.betting.actingSeat);
      if (actor?.status === 'all-in') {
        fail('ALL_IN_SEAT_ACTING', `seat ${String(actor.seatId)} is all-in but is the acting seat`);
      }
    }

    // 9 & 11 & 13 (partial): re-derive expected reopening from public SeatState
    // fields and cross-check against getLegalActions. Restricted to the
    // acting seat (O(1) instead of O(seats) getLegalActions calls, each of
    // which does a full state clone) — a bug in this logic will surface
    // for whichever seat is asked to act, so checking every seat on every
    // transition is redundant work, not extra safety, and was the
    // dominant cost in deep-stacked many-seat adversarial hands.
    const actingSeatState = state.seats.find((s) => s.seatId === state.betting.actingSeat);
    if (actingSeatState && actingSeatState.status === 'active') {
      const seat = actingSeatState;
      const legal = getLegalActions(state, seat.seatId);
      if (legal.canRaise && legal.minRaiseTo > legal.maxRaiseTo) {
        fail('RAISE_RANGE_INVERTED', `seat ${String(seat.seatId)}: minRaiseTo > maxRaiseTo`, legal, undefined);
      }
      if (legal.canBet && legal.minBet > legal.maxBet) {
        fail('BET_RANGE_INVERTED', `seat ${String(seat.seatId)}: minBet > maxBet`, legal, undefined);
      }
      if (!seat.isAllowedToRaise && legal.canRaise) {
        fail('RAISE_DESPITE_NOT_ALLOWED', `seat ${String(seat.seatId)}: isAllowedToRaise=false but canRaise=true`);
      }
      const canReachBeyondCurrentBet = seat.stack + seat.committedThisStreet > state.betting.currentBet;
      const expectedReopened =
        canReachBeyondCurrentBet &&
        (!seat.hasActedThisRound || state.betting.currentBet - seat.lastActedAtBet >= state.betting.lastFullRaiseIncrement);
      if (state.betting.currentBet > 0 && expectedReopened !== legal.canRaise) {
        fail(
          'REOPENING_MISMATCH',
          `seat ${String(seat.seatId)}: independently-recomputed reopening (${String(expectedReopened)}) disagrees with canRaise (${String(legal.canRaise)})`,
        );
      }
    }
  }

  // 15 & 16: pot shape.
  let prevCap = -1;
  for (const pot of state.pots) {
    if (pot.eligibleSeatIds.length === 0) fail('EMPTY_POT_ELIGIBILITY', `pot ${String(pot.index)} has no eligible seats`);
    for (const seatId of pot.eligibleSeatIds) {
      const seat = state.seats.find((s) => s.seatId === seatId);
      if (seat?.status === 'folded') fail('FOLDED_SEAT_ELIGIBLE', `pot ${String(pot.index)} lists folded seat ${String(seatId)} as eligible`);
    }
    if (pot.cappedAt <= prevCap) fail('POT_CAP_NOT_ASCENDING', 'pot cappedAt values must be strictly ascending by index', pot.cappedAt, prevCap);
    prevCap = pot.cappedAt;
  }
}

/**
 * Invariant #10: a short (non-full) bet/raise must never move
 * lastFullRaiseIncrement, and a full one must set it to exactly its own
 * increment — checked from public state across one transition, only when
 * the street didn't also change (an auto-run-out cascade resets betting
 * state for a new street, which is expected and unrelated).
 */
export function checkRaiseSizingTransition(prev: TableState, next: TableState, action: PlayerAction): void {
  if (action.type !== 'bet' && action.type !== 'raise') return;
  if (prev.street !== next.street) return;
  if (action.amountTo === undefined) return;
  const increment = action.amountTo - prev.betting.currentBet;
  const requiredIncrement = prev.betting.lastFullRaiseIncrement;
  const isFull = increment >= requiredIncrement;
  if (isFull) {
    if (next.betting.lastFullRaiseIncrement !== increment) {
      fail('FULL_RAISE_INCREMENT_NOT_UPDATED', 'a full raise must set lastFullRaiseIncrement to its own increment', next.betting.lastFullRaiseIncrement, increment);
    }
  } else if (next.betting.lastFullRaiseIncrement !== requiredIncrement) {
    fail('SHORT_RAISE_MOVED_INCREMENT', 'a short (non-full) raise must not change lastFullRaiseIncrement', next.betting.lastFullRaiseIncrement, requiredIncrement);
  }
}

/** Invariant #17: side pots (higher index) must be awarded before the main pot (index 0). */
export function checkPotAwardOrder(potAwardIndexes: readonly number[]): void {
  for (let i = 1; i < potAwardIndexes.length; i++) {
    if (potAwardIndexes[i]! >= potAwardIndexes[i - 1]!) {
      fail('POT_AWARD_ORDER', 'pots must be awarded in strictly descending index order (side pots before main)', potAwardIndexes);
    }
  }
}

/** Invariant #2: total payouts at showdown/fold-win equal total contributions. */
export function checkPayoutsEqualContributions(state: TableState): void {
  const totalPots = state.pots.reduce((sum, p) => sum + p.amount, 0);
  const totalContributed = state.seats.reduce((sum, s) => sum + s.committedThisHand, 0) + state.anteTotal;
  if (totalPots !== totalContributed) {
    fail('PAYOUT_MISMATCH', 'sum of pot amounts must equal sum of contributions', totalPots, totalContributed);
  }
}

/**
 * Invariant #14 (soft upper bound): every pot tier comes from SOME
 * distinct contribution level — including a folded player's level, which
 * can still anchor a real pot that non-folded players above it are
 * eligible for. So the true upper bound is the number of distinct levels
 * among ALL contributors (folded or not); tier-merging (engine
 * DECISIONS.md #6, an all-folded-ineligible tier merging into the pot
 * below) can only ever reduce the pot count from there, never increase it.
 */
export function checkPotCountBound(state: TableState): void {
  const allLevels = new Set(state.seats.filter((s) => s.committedThisHand > 0).map((s) => s.committedThisHand));
  const upperBound = Math.max(1, allLevels.size);
  if (state.pots.length > upperBound) {
    fail('TOO_MANY_POTS', 'pot count exceeds the number of distinct contribution levels', state.pots.length, upperBound);
  }
}

/** Invariant #18: a hand must terminate within a bounded number of actions. */
export function checkActionBound(actionCount: number, maxActions = 500): void {
  if (actionCount > maxActions) {
    fail('ACTION_BOUND_EXCEEDED', `hand exceeded ${String(maxActions)} actions without terminating`, actionCount, maxActions);
  }
}

import type { BettingState, LegalActions, SeatState, TableState } from './types.js';

/**
 * The minimal read-only shape computeLegalActions needs. It never
 * mutates anything, so it accepts this instead of the mutable `Draft` —
 * letting `getLegalActions` (a pure query, called at least once per
 * action) read directly from a `TableState` with NO clone at all, rather
 * than paying `toDraft`'s full deep clone just to answer a read. `Draft`
 * (whose seats are `MutableSeat[]`) is also structurally assignable here,
 * so betting.ts's internal use during applyAction is unaffected.
 */
export interface LegalActionsView {
  phase: TableState['phase'];
  betting: BettingState;
  seats: readonly SeatState[];
}

function closed(seatId: number): LegalActions {
  return {
    seatId,
    canFold: false,
    canCheck: false,
    canCall: false,
    callAmount: 0,
    canBet: false,
    minBet: 0,
    maxBet: 0,
    canRaise: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    isAllInOnly: false,
  };
}

/** Whether raising is currently reopened for this seat (see DECISIONS.md). */
export function isReopenedForSeat(seat: SeatState, currentBet: number, lastFullRaiseIncrement: number): boolean {
  if (!seat.hasActedThisRound) return true;
  return currentBet - seat.lastActedAtBet >= lastFullRaiseIncrement;
}

/**
 * Pure query: what this seat could legally do right now, based on its own
 * facing-bet state, independent of whose actual turn it is. Turn order is
 * enforced separately by applyAction's NOT_YOUR_TURN check — this lets a
 * caller preview, e.g., "if action gets back to seat X, what can they do,"
 * which the spec's reopening-rule scenario tests rely on directly.
 */
export function computeLegalActions(view: LegalActionsView, seatId: number): LegalActions {
  if (view.phase !== 'in-hand') return closed(seatId);
  const seat = view.seats.find((s) => s.seatId === seatId);
  if (!seat || seat.status !== 'active') return closed(seatId);

  const { currentBet, lastFullRaiseIncrement, lastFullBetAmount } = view.betting;
  const toCall = currentBet - seat.committedThisStreet;
  const canCheck = toCall <= 0;
  const canCall = toCall > 0;
  const callAmount = canCall ? Math.min(toCall, seat.stack) : 0;
  const maxCommit = seat.stack + seat.committedThisStreet;

  let canBet = false;
  let minBet = 0;
  let maxBet = 0;
  let canRaise = false;
  let minRaiseTo = 0;
  let maxRaiseTo = 0;
  let isAllInOnly = false;

  // The minimum legal size is anchored to the last FULL bet/raise, not to
  // `currentBet` itself — a short all-in raises currentBet (what must be
  // called) without moving this anchor. The `currentBet + 1` floor only
  // matters in the rare cascading-short-all-ins case where that anchor
  // would otherwise sit at or below the amount already owed. See
  // DECISIONS.md.
  const trueMin = Math.max(lastFullBetAmount + lastFullRaiseIncrement, currentBet + 1);

  if (seat.stack > 0) {
    if (currentBet === 0) {
      canBet = true;
      minBet = Math.min(trueMin, maxCommit);
      maxBet = maxCommit;
      isAllInOnly = maxCommit < trueMin;
    } else if (maxCommit > currentBet && isReopenedForSeat(seat, currentBet, lastFullRaiseIncrement)) {
      // maxCommit > currentBet is required: a seat whose entire stack
      // doesn't even reach currentBet can only call all-in for less (or
      // fold) — that's a short CALL, not a raise, regardless of reopening.
      canRaise = true;
      minRaiseTo = Math.min(trueMin, maxCommit);
      maxRaiseTo = maxCommit;
      isAllInOnly = maxCommit < trueMin;
    }
  }

  return {
    seatId,
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    canBet,
    minBet,
    maxBet,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
    isAllInOnly,
  };
}

import { computeLegalActions, isReopenedForSeat } from './legalActions.js';
import type { Draft } from './table.js';
import { getSeat } from './table.js';
import type { EngineError, GameEvent, PlayerAction } from './types.js';

export type ApplyPlayerActionResult = { ok: true; events: GameEvent[] } | { ok: false; error: EngineError };

export function applyPlayerAction(draft: Draft, action: PlayerAction): ApplyPlayerActionResult {
  if (draft.phase !== 'in-hand') {
    return { ok: false, error: { code: 'HAND_NOT_ACTIVE', message: 'No hand is in progress.' } };
  }
  const seat = getSeat(draft.seats, action.seatId);
  if (!seat) {
    return { ok: false, error: { code: 'UNKNOWN_SEAT', message: `Unknown seat ${String(action.seatId)}.` } };
  }
  if (draft.betting.actingSeat !== action.seatId) {
    return { ok: false, error: { code: 'NOT_YOUR_TURN', message: `It is not seat ${String(action.seatId)}'s turn.` } };
  }
  if (seat.status !== 'active') {
    return { ok: false, error: { code: 'SEAT_NOT_ACTIVE', message: `Seat ${String(action.seatId)} is not active in this hand.` } };
  }

  const legal = computeLegalActions(draft, action.seatId);

  switch (action.type) {
    case 'fold': {
      if (!legal.canFold) return { ok: false, error: { code: 'CANNOT_FOLD', message: 'Fold is not legal here.' } };
      seat.status = 'folded';
      seat.hasActedThisRound = true;
      seat.lastActedAtBet = draft.betting.currentBet;
      break;
    }
    case 'check': {
      if (!legal.canCheck) {
        return { ok: false, error: { code: 'CANNOT_CHECK', message: 'Check is not legal here; a bet is outstanding.' } };
      }
      seat.hasActedThisRound = true;
      seat.lastActedAtBet = draft.betting.currentBet;
      break;
    }
    case 'call': {
      if (!legal.canCall) return { ok: false, error: { code: 'CANNOT_CALL', message: 'Call is not legal here.' } };
      const amount = legal.callAmount;
      seat.stack -= amount;
      seat.committedThisStreet += amount;
      seat.committedThisHand += amount;
      seat.hasActedThisRound = true;
      seat.lastActedAtBet = draft.betting.currentBet;
      if (seat.stack === 0) seat.status = 'all-in';
      break;
    }
    case 'bet':
    case 'raise': {
      const isBet = action.type === 'bet';
      if (isBet && !legal.canBet) return { ok: false, error: { code: 'CANNOT_BET', message: 'Bet is not legal here.' } };
      if (!isBet && !legal.canRaise) {
        return {
          ok: false,
          error: { code: 'RAISE_NOT_ALLOWED', message: 'Raise is not legal here (action is not reopened for this seat).' },
        };
      }
      const amountTo = action.amountTo;
      if (amountTo === undefined || !Number.isFinite(amountTo) || !Number.isInteger(amountTo)) {
        return { ok: false, error: { code: 'ILLEGAL_AMOUNT', message: 'amountTo must be an integer.' } };
      }
      const min = isBet ? legal.minBet : legal.minRaiseTo;
      const max = isBet ? legal.maxBet : legal.maxRaiseTo;
      const maxCommit = seat.stack + seat.committedThisStreet;
      const isExactAllIn = amountTo === maxCommit;
      if (amountTo < min && !isExactAllIn) {
        return { ok: false, error: { code: 'ILLEGAL_AMOUNT', message: `Amount ${String(amountTo)} is below the legal minimum ${String(min)}.` } };
      }
      if (amountTo > max) {
        return { ok: false, error: { code: 'ILLEGAL_AMOUNT', message: `Amount ${String(amountTo)} exceeds the seat's available chips.` } };
      }

      const oldCurrentBet = draft.betting.currentBet;
      const increment = amountTo - oldCurrentBet;
      const delta = amountTo - seat.committedThisStreet;
      seat.stack -= delta;
      seat.committedThisStreet = amountTo;
      seat.committedThisHand += delta;
      seat.hasActedThisRound = true;
      if (seat.stack === 0) seat.status = 'all-in';

      const requiredIncrement = draft.betting.lastFullRaiseIncrement;
      const isFull = increment >= requiredIncrement;
      draft.betting.currentBet = amountTo;
      draft.betting.lastAggressorSeat = seat.seatId;
      if (isFull) {
        draft.betting.lastFullRaiseIncrement = increment;
        draft.betting.lastFullBetAmount = amountTo;
      }
      seat.lastActedAtBet = draft.betting.currentBet;
      // Other seats needing to act again is determined by `needsToAct`
      // (committedThisStreet < currentBet), not by resetting
      // hasActedThisRound here — that flag must stay true once a seat has
      // genuinely acted, or the reopening check below can't distinguish
      // "never acted this street" (always reopened) from "already acted,
      // now facing a bigger bet" (reopened only if growth >= full increment).
      break;
    }
    default:
      return { ok: false, error: { code: 'INVALID_ACTION_TYPE', message: 'Unknown action type.' } };
  }

  syncAllowedToRaiseFlags(draft);
  const event: GameEvent = {
    type: 'action-taken',
    seatId: seat.seatId,
    action,
    resultingStack: seat.stack,
    committedThisStreet: seat.committedThisStreet,
  };
  return { ok: true, events: [event] };
}

/** Keeps the display-only SeatState.isAllowedToRaise field consistent with the lazily-derived reopening rule. */
export function syncAllowedToRaiseFlags(draft: Draft): void {
  for (const seat of draft.seats) {
    if (seat.status !== 'active') continue;
    seat.isAllowedToRaise = isReopenedForSeat(seat, draft.betting.currentBet, draft.betting.lastFullRaiseIncrement);
  }
}

export function needsToAct(draft: Draft): number[] {
  return draft.seats
    .filter((s) => s.status === 'active' && (!s.hasActedThisRound || s.committedThisStreet < draft.betting.currentBet))
    .map((s) => s.seatId);
}

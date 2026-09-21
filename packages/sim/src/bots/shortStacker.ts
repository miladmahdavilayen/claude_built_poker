import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';
import { isPlayablePreflop, ownSeat } from './helpers.js';

/**
 * A short-stacked push/fold bot. Its buy-in behavior (minimum buy-in) is
 * the table-churn layer's responsibility, not this policy's — this only
 * implements the shove-or-fold decision.
 */
export const shortStacker: BotPolicy = {
  name: 'short-stacker',
  decide(view: SeatView, legal: LegalActions, _rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    const seat = ownSeat(view);
    const playable = view.street === 'preflop' ? isPlayablePreflop(seat.holeCards) : true;

    if (!playable) {
      if (legal.canCheck) return { seatId, type: 'check' };
      return { seatId, type: 'fold' };
    }
    if (legal.canRaise) return { seatId, type: 'raise', amountTo: legal.maxRaiseTo };
    if (legal.canBet) return { seatId, type: 'bet', amountTo: legal.maxBet };
    if (legal.canCall) return { seatId, type: 'call' };
    if (legal.canCheck) return { seatId, type: 'check' };
    return { seatId, type: 'fold' };
  },
};

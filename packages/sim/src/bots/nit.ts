import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';
import { hasMadeHand, isPremiumPreflop, ownSeat } from './helpers.js';

export const nit: BotPolicy = {
  name: 'nit',
  decide(view: SeatView, legal: LegalActions, _rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    const seat = ownSeat(view);
    const strong = view.street === 'preflop' ? isPremiumPreflop(seat.holeCards) : hasMadeHand(view.board, seat.holeCards);

    if (!strong) {
      if (legal.canCheck) return { seatId, type: 'check' };
      return { seatId, type: 'fold' };
    }

    // At most one raise/bet per street, then call any further aggression
    // instead of re-raising again — "strong" never changes no matter how
    // big the bet gets (nit has no bet-size awareness at all), so without
    // this cap two nits both holding a premium hand re-raise each other
    // the legal minimum forever. Hit for real at 1M-hand nightly-sim scale
    // (deep enough stacks for it to run past the 500-action safety bound
    // before either side's stack could actually be exhausted).
    if (!seat.hasActedThisRound) {
      if (legal.canRaise) return { seatId, type: 'raise', amountTo: legal.minRaiseTo };
      if (legal.canBet) return { seatId, type: 'bet', amountTo: legal.minBet };
    }
    if (legal.canCall) return { seatId, type: 'call' };
    if (legal.canCheck) return { seatId, type: 'check' };
    return { seatId, type: 'fold' };
  },
};

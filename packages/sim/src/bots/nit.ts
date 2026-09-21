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

    if (legal.canRaise) return { seatId, type: 'raise', amountTo: legal.minRaiseTo };
    if (legal.canBet) return { seatId, type: 'bet', amountTo: legal.minBet };
    if (legal.canCall) return { seatId, type: 'call' };
    if (legal.canCheck) return { seatId, type: 'check' };
    return { seatId, type: 'fold' };
  },
};

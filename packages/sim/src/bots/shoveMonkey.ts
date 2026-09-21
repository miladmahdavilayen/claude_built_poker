import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';

export const shoveMonkey: BotPolicy = {
  name: 'shove-monkey',
  decide(view: SeatView, legal: LegalActions, _rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    if (legal.canRaise) return { seatId, type: 'raise', amountTo: legal.maxRaiseTo };
    if (legal.canBet) return { seatId, type: 'bet', amountTo: legal.maxBet };
    if (legal.canCall) return { seatId, type: 'call' };
    if (legal.canCheck) return { seatId, type: 'check' };
    return { seatId, type: 'fold' };
  },
};

import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';

export const checkFold: BotPolicy = {
  name: 'check-fold',
  decide(view: SeatView, legal: LegalActions, _rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    if (legal.canCheck) return { seatId, type: 'check' };
    return { seatId, type: 'fold' };
  },
};

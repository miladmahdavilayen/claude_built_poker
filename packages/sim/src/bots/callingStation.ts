import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';

export const callingStation: BotPolicy = {
  name: 'calling-station',
  decide(view: SeatView, legal: LegalActions, rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    if (legal.canCheck) return { seatId, type: 'check' };
    if (legal.canCall) {
      const foldsAnyway = rnd.nextInt(100) < 5;
      return foldsAnyway ? { seatId, type: 'fold' } : { seatId, type: 'call' };
    }
    return { seatId, type: 'fold' };
  },
};

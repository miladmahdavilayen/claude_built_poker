import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';
import { randomBetweenHighBias } from './helpers.js';

export const maniac: BotPolicy = {
  name: 'maniac',
  decide(view: SeatView, legal: LegalActions, rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    const aggressive = rnd.nextInt(100) < 60;
    if (aggressive && legal.canRaise) {
      return { seatId, type: 'raise', amountTo: randomBetweenHighBias(legal.minRaiseTo, legal.maxRaiseTo, rnd) };
    }
    if (aggressive && legal.canBet) {
      return { seatId, type: 'bet', amountTo: randomBetweenHighBias(legal.minBet, legal.maxBet, rnd) };
    }
    if (legal.canCheck) return { seatId, type: 'check' };
    if (legal.canCall) return { seatId, type: 'call' };
    return { seatId, type: 'fold' };
  },
};

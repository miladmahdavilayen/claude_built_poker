import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';
import { pickUniform, randomBetween } from './helpers.js';

type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export const randomLegal: BotPolicy = {
  name: 'random-legal',
  decide(view: SeatView, legal: LegalActions, rnd: RandomSource): PlayerAction {
    const kinds: ActionKind[] = [];
    if (legal.canFold) kinds.push('fold');
    if (legal.canCheck) kinds.push('check');
    if (legal.canCall) kinds.push('call');
    if (legal.canBet) kinds.push('bet');
    if (legal.canRaise) kinds.push('raise');
    const kind = pickUniform(kinds, rnd);
    const seatId = view.seatId;
    switch (kind) {
      case 'bet':
        return { seatId, type: 'bet', amountTo: randomBetween(legal.minBet, legal.maxBet, rnd) };
      case 'raise':
        return { seatId, type: 'raise', amountTo: randomBetween(legal.minRaiseTo, legal.maxRaiseTo, rnd) };
      default:
        return { seatId, type: kind };
    }
  },
};

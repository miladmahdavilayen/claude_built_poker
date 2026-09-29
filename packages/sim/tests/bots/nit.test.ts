import type { LegalActions } from '@pokerclause/engine';
import { seededSource } from '@pokerclause/rng';
import { describe, expect, it } from 'vitest';
import { nit } from '../../src/bots/nit.js';
import type { SeatView } from '../../src/types.js';

const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };

function seatView(hasActedThisRound: boolean): SeatView {
  return {
    seatId: 0,
    handNumber: 1,
    config,
    buttonSeat: 0,
    street: 'preflop',
    board: [],
    betting: { currentBet: 100, lastFullRaiseIncrement: 2, lastFullBetAmount: 98, lastAggressorSeat: 1, actingSeat: 0 },
    pots: [],
    phase: 'in-hand',
    seats: [
      {
        seatId: 0,
        playerId: 'nit-a',
        stack: 1000,
        holeCards: ['As', 'Ah'],
        status: 'active',
        committedThisStreet: 98,
        committedThisHand: 98,
        hasActedThisRound,
        isAllowedToRaise: true,
      },
      {
        seatId: 1,
        playerId: 'nit-b',
        stack: 1000,
        holeCards: [],
        status: 'active',
        committedThisStreet: 100,
        committedThisHand: 100,
        hasActedThisRound: true,
        isAllowedToRaise: true,
      },
    ],
  };
}

const facingARaiseLegal: LegalActions = {
  seatId: 0,
  canFold: true,
  canCheck: false,
  canCall: true,
  callAmount: 2,
  canBet: false,
  minBet: 0,
  maxBet: 0,
  canRaise: true,
  minRaiseTo: 102,
  maxRaiseTo: 1098,
  isAllInOnly: false,
};

// Regression test: with a premium hand, `nit` used to raise unconditionally
// whenever `canRaise` was true, with zero memory of having already raised
// this same street. Two `nit` bots both holding a premium hand (the same
// pocket aces never stops being "strong" no matter how big the bet gets)
// would therefore re-raise each other the legal minimum forever — hit for
// real at 1,000,000-hand nightly-sim scale (deep enough stacks that the
// war ran past the engine's 500-action safety bound before either side's
// stack could actually be exhausted). Fixed by capping `nit` to at most
// one raise/bet per street; see nit.ts.
describe('nit', () => {
  it('raises a premium hand on its first action this street', () => {
    const action = nit.decide(seatView(false), facingARaiseLegal, seededSource('nit-first-action'));
    expect(action.type).toBe('raise');
    expect(action.amountTo).toBe(facingARaiseLegal.minRaiseTo);
  });

  it('calls instead of re-raising again once it has already acted this street', () => {
    const action = nit.decide(seatView(true), facingARaiseLegal, seededSource('nit-already-acted'));
    expect(action.type).toBe('call');
  });
});

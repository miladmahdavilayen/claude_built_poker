import type { Card, LegalActions } from '@pokerclause/engine';
import { seededSource } from '@pokerclause/rng';
import { describe, expect, it } from 'vitest';
import { allanKeating } from '../../src/bots/allanKeating.js';
import type { SeatView } from '../../src/types.js';

const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, straddleEnabled: false };

function seatView(overrides: Partial<SeatView> & { seatId: number; holeCards: readonly Card[] }): SeatView {
  const { seatId, holeCards, ...rest } = overrides;
  return {
    seatId,
    handNumber: 1,
    config,
    buttonSeat: seatId, // best position unless a test overrides it
    street: 'preflop',
    board: [],
    betting: { currentBet: 0, lastFullRaiseIncrement: config.bigBlind, lastFullBetAmount: 0, lastAggressorSeat: null, actingSeat: seatId },
    pots: [],
    phase: 'in-hand',
    seats: [
      { seatId, playerId: 'hero', stack: 200, holeCards, status: 'active', committedThisStreet: 0, committedThisHand: 0, hasActedThisRound: false, isAllowedToRaise: true },
      { seatId: seatId === 0 ? 1 : 0, playerId: 'villain', stack: 200, holeCards: [], status: 'active', committedThisStreet: 0, committedThisHand: 0, hasActedThisRound: false, isAllowedToRaise: true },
    ],
    ...rest,
  };
}

const closedLegal: LegalActions = {
  seatId: 0,
  canFold: true,
  canCheck: false,
  canCall: false,
  callAmount: 0,
  canBet: false,
  minBet: 0,
  maxBet: 0,
  canRaise: false,
  minRaiseTo: 0,
  maxRaiseTo: 0,
  isAllInOnly: false,
};

describe('allanKeating', () => {
  it('raises pocket aces preflop, first to act, facing only the big blind', () => {
    const view = seatView({
      seatId: 0,
      holeCards: ['As', 'Ah'],
      seats: [
        { seatId: 0, playerId: 'hero', stack: 200, holeCards: ['As', 'Ah'], status: 'active', committedThisStreet: 0, committedThisHand: 0, hasActedThisRound: false, isAllowedToRaise: true },
        { seatId: 1, playerId: 'villain', stack: 200, holeCards: [], status: 'active', committedThisStreet: 2, committedThisHand: 2, hasActedThisRound: false, isAllowedToRaise: true },
      ],
      betting: { currentBet: 2, lastFullRaiseIncrement: 2, lastFullBetAmount: 2, lastAggressorSeat: 1, actingSeat: 0 },
    });
    const legal: LegalActions = {
      ...closedLegal,
      canCall: true,
      callAmount: 2,
      canRaise: true,
      minRaiseTo: 4,
      maxRaiseTo: 200,
    };

    const action = allanKeating.decide(view, legal, seededSource('allan-aa-raise'));

    expect(action.type).toBe('raise');
    expect(action.amountTo).toBeGreaterThanOrEqual(legal.minRaiseTo);
    expect(action.amountTo).toBeLessThanOrEqual(legal.maxRaiseTo);
  });

  it('folds 7-2 offsuit facing a big raise with poor pot odds', () => {
    const view = seatView({
      seatId: 0,
      holeCards: ['7c', '2d'],
      seats: [
        { seatId: 0, playerId: 'hero', stack: 200, holeCards: ['7c', '2d'], status: 'active', committedThisStreet: 2, committedThisHand: 2, hasActedThisRound: false, isAllowedToRaise: true },
        { seatId: 1, playerId: 'villain', stack: 200, holeCards: [], status: 'active', committedThisStreet: 50, committedThisHand: 50, hasActedThisRound: true, isAllowedToRaise: true },
      ],
      betting: { currentBet: 50, lastFullRaiseIncrement: 48, lastFullBetAmount: 50, lastAggressorSeat: 1, actingSeat: 0 },
    });
    const legal: LegalActions = {
      ...closedLegal,
      canCall: true,
      callAmount: 48,
      canRaise: true,
      minRaiseTo: 98,
      maxRaiseTo: 198,
    };

    const action = allanKeating.decide(view, legal, seededSource('allan-72o-fold'));

    expect(action.type).toBe('fold');
  });

  it('never returns an amountTo outside the legal min/max, across several hands and seeds', () => {
    const scenarios: { holeCards: [Card, Card]; legal: LegalActions }[] = [
      { holeCards: ['Ks', 'Qs'], legal: { ...closedLegal, canBet: true, minBet: 2, maxBet: 200 } },
      { holeCards: ['5h', '5d'], legal: { ...closedLegal, canCall: true, callAmount: 20, canRaise: true, minRaiseTo: 40, maxRaiseTo: 180 } },
      { holeCards: ['2c', '9h'], legal: { ...closedLegal, canCheck: true, canRaise: true, minRaiseTo: 4, maxRaiseTo: 200 } }, // BB option
    ];
    for (const [i, scenario] of scenarios.entries()) {
      const view = seatView({ seatId: 0, holeCards: scenario.holeCards });
      const action = allanKeating.decide(view, scenario.legal, seededSource(`allan-bounds-${String(i)}`));
      if (action.type === 'bet') {
        expect(action.amountTo).toBeGreaterThanOrEqual(scenario.legal.minBet);
        expect(action.amountTo).toBeLessThanOrEqual(scenario.legal.maxBet);
      }
      if (action.type === 'raise') {
        expect(action.amountTo).toBeGreaterThanOrEqual(scenario.legal.minRaiseTo);
        expect(action.amountTo).toBeLessThanOrEqual(scenario.legal.maxRaiseTo);
      }
      if (action.amountTo !== undefined) expect(Number.isInteger(action.amountTo)).toBe(true);
    }
  });

  it('is deterministic for a given seed', () => {
    const view = seatView({
      seatId: 0,
      holeCards: ['Jc', 'Jd'],
      betting: { currentBet: 2, lastFullRaiseIncrement: 2, lastFullBetAmount: 2, lastAggressorSeat: 1, actingSeat: 0 },
      seats: [
        { seatId: 0, playerId: 'hero', stack: 200, holeCards: ['Jc', 'Jd'], status: 'active', committedThisStreet: 0, committedThisHand: 0, hasActedThisRound: false, isAllowedToRaise: true },
        { seatId: 1, playerId: 'villain', stack: 200, holeCards: [], status: 'active', committedThisStreet: 2, committedThisHand: 2, hasActedThisRound: false, isAllowedToRaise: true },
      ],
    });
    const legal: LegalActions = { ...closedLegal, canCall: true, callAmount: 2, canRaise: true, minRaiseTo: 4, maxRaiseTo: 200 };

    const a = allanKeating.decide(view, legal, seededSource('allan-determinism'));
    const b = allanKeating.decide(view, legal, seededSource('allan-determinism'));
    expect(a).toEqual(b);
  });

  it('never picks an action the legal set does not actually allow', () => {
    const view = seatView({ seatId: 0, holeCards: ['4c', '9d'] });
    const legal: LegalActions = { ...closedLegal, canCheck: true }; // nothing else legal but fold/check
    const action = allanKeating.decide(view, legal, seededSource('allan-legality'));
    expect(['fold', 'check']).toContain(action.type);
  });
});

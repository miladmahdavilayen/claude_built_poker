import type { LegalActions } from '@pokerclause/engine';
import { seededSource } from '@pokerclause/rng';
import { describe, expect, it } from 'vitest';
import { TEST_CAMERA_BOTS } from '../../src/bots/testCamera.js';
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

// The owner's test players (testCamera.ts): never fold, never raise — check when they can, call otherwise — so every
// hand they're in goes to a showdown, whatever they hold.
const base: LegalActions = {
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

describe('test camera bots', () => {
  it('are seven, each checking when it can and calling otherwise — a big bet, an all-in, the worst hand — never folding or raising', () => {
    expect(TEST_CAMERA_BOTS.map((b) => b.name)).toEqual(['test-cam-ava', 'test-cam-ben', 'test-cam-cleo', 'test-cam-dev', 'test-cam-eli', 'test-cam-fay', 'test-cam-gus']);
    const rnd = seededSource('test-camera-bots');
    const view = { ...seatView(false), seats: seatView(false).seats.map((s, i) => (i === 0 ? { ...s, holeCards: ['7d', '2c'] } : s)) } as SeatView;
    for (const bot of TEST_CAMERA_BOTS) {
      expect(bot.decide(view, { ...base, canCheck: true, canBet: true, minBet: 2, maxBet: 1000 }, rnd).type).toBe('check');
      expect(bot.decide(view, { ...base, canCall: true, callAmount: 900, canRaise: true, minRaiseTo: 1800, maxRaiseTo: 1000 }, rnd).type).toBe('call');
      // Only all in for less left: still a call.
      expect(bot.decide(view, { ...base, canCall: true, callAmount: 1000, isAllInOnly: true }, rnd).type).toBe('call');
    }
  });
});

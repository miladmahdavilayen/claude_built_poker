import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fullDeck } from '../src/deck.js';
import { applyAction, startHand } from '../src/engine.js';
import { createTableState } from '../src/factory.js';
import type { PlayerAction, TableState } from '../src/types.js';

const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 4, straddleEnabled: false };

function freshInHandState(): TableState {
  const t = createTableState(
    config,
    [0, 1, 2, 3].map((seatId) => ({ seatId, playerId: `P${String(seatId)}`, stack: 200 })),
  );
  const result = startHand(t, fullDeck());
  if (!result.ok) throw new Error('unreachable: setup failed');
  return result.state;
}

function freshHandCompleteState(): TableState {
  let state = freshInHandState();
  // Fold everyone but one seat to reach hand-complete quickly.
  for (let i = 0; i < 10 && state.phase === 'in-hand'; i++) {
    const seatId = state.betting.actingSeat;
    if (seatId === null) break;
    const result = applyAction(state, { seatId, type: 'fold' });
    if (!result.ok) break;
    state = result.state;
  }
  return state;
}

const malformedAction = fc.record(
  {
    seatId: fc.oneof(
      fc.integer({ min: -1000, max: 1000 }),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.constant(-Infinity),
      fc.double(),
    ),
    type: fc.oneof(
      fc.constantFrom('fold', 'check', 'call', 'bet', 'raise'),
      fc.constantFrom('post-blind', 'post-ante', 'garbage', '', 'FOLD', 'allin'),
      fc.constant(undefined),
    ),
    amountTo: fc.oneof(
      fc.constant(undefined),
      fc.integer({ min: -1000, max: 100000 }),
      fc.double(),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.constant(-Infinity),
    ),
  },
  { requiredKeys: ['seatId'] },
);

describe('fuzz: malformed actions never crash the engine', () => {
  it('always returns a typed error for garbage actions mid-hand', () => {
    const state = freshInHandState();
    fc.assert(
      fc.property(malformedAction, (raw) => {
        expect(() => {
          const result = applyAction(state, raw as unknown as PlayerAction);
          if (!result.ok) {
            expect(typeof result.error.code).toBe('string');
            expect(result.error.code.length).toBeGreaterThan(0);
          }
        }).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });

  it('always returns a typed error for garbage actions after the hand is complete', () => {
    const state = freshHandCompleteState();
    expect(state.phase).toBe('hand-complete');
    fc.assert(
      fc.property(malformedAction, (raw) => {
        expect(() => {
          const result = applyAction(state, raw as unknown as PlayerAction);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.code).toBe('HAND_NOT_ACTIVE');
        }).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('rejects an out-of-turn action from a seat other than the one acting', () => {
    const state = freshInHandState();
    const actingSeat = state.betting.actingSeat!;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: config.maxSeats - 1 }).filter((s) => s !== actingSeat),
        fc.constantFrom<PlayerAction['type']>('fold', 'check', 'call'),
        (seatId, type) => {
          const result = applyAction(state, { seatId, type });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.code).toBe('NOT_YOUR_TURN');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects an unknown seat id cleanly', () => {
    const state = freshInHandState();
    for (const seatId of [-1, 999, config.maxSeats, 1000000]) {
      const result = applyAction(state, { seatId, type: 'fold' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['UNKNOWN_SEAT', 'NOT_YOUR_TURN']).toContain(result.error.code);
    }
  });
});

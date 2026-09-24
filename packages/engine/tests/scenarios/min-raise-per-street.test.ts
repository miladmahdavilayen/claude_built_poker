import { describe, expect, it } from 'vitest';
import { applyAction, getLegalActions, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectErr, expectOk, orderedDeck } from '../helpers.js';

// The minimum legal raise on any given street is double the first bet that
// opened betting on that street — the increment a raise must clear has to
// be at least as big as the bet it's raising (standard no-limit hold'em;
// see RULES.md). Preflop is already covered by preflop-basics.test.ts's
// "min-raise chain" scenario (the big blind itself is the opening bet
// there); this covers the same rule independently reopening fresh on the
// flop, turn, and river, since `startNextStreet` (streets.ts) resets
// `lastFullBetAmount`/`lastFullRaiseIncrement` at the start of every
// street rather than carrying anything over from the previous one.
describe('min raise is double the street-opening bet, on every street', () => {
  it('flop, turn, and river each independently require a raise to at least double that street\'s first bet', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 1000 },
      { seatId: 1, playerId: 'BB', stack: 1000 },
    ]);
    const deck = orderedDeck('As', 'Kd', '2c', '7h');
    const started = expectOk(startHand(t, deck));

    // Heads-up: the button (SB) acts first preflop, last postflop.
    expect(started.betting.actingSeat).toBe(0);
    let s = expectOk(applyAction(started, { seatId: 0, type: 'call' })); // BTN completes to the BB
    s = expectOk(applyAction(s, { seatId: 1, type: 'check' })); // BB checks its option
    expect(s.street).toBe('flop');

    // --- Flop: BB opens for 10; the minimum raise is double that (20). ---
    expect(s.betting.actingSeat).toBe(1); // non-button acts first postflop
    s = expectOk(applyAction(s, { seatId: 1, type: 'bet', amountTo: 10 }));
    expect(getLegalActions(s, 0).minRaiseTo).toBe(20);
    expect(expectErr(applyAction(s, { seatId: 0, type: 'raise', amountTo: 19 }))).toBe('ILLEGAL_AMOUNT');
    s = expectOk(applyAction(s, { seatId: 0, type: 'raise', amountTo: 20 })); // exactly double — legal
    s = expectOk(applyAction(s, { seatId: 1, type: 'call' }));
    expect(s.street).toBe('turn');

    // --- Turn: a fresh street resets the anchor — BB opens for 30 this
    // time; the minimum raise is double THAT (60), not double the flop's
    // final bet (which was 20). ---
    expect(s.betting.actingSeat).toBe(1);
    s = expectOk(applyAction(s, { seatId: 1, type: 'bet', amountTo: 30 }));
    expect(getLegalActions(s, 0).minRaiseTo).toBe(60);
    expect(expectErr(applyAction(s, { seatId: 0, type: 'raise', amountTo: 59 }))).toBe('ILLEGAL_AMOUNT');
    s = expectOk(applyAction(s, { seatId: 0, type: 'call' })); // just close the street this time
    expect(s.street).toBe('river');

    // --- River: opens for 50; minimum raise is double (100). ---
    expect(s.betting.actingSeat).toBe(1);
    s = expectOk(applyAction(s, { seatId: 1, type: 'bet', amountTo: 50 }));
    expect(getLegalActions(s, 0).minRaiseTo).toBe(100);
    expect(expectErr(applyAction(s, { seatId: 0, type: 'raise', amountTo: 99 }))).toBe('ILLEGAL_AMOUNT');
    s = expectOk(applyAction(s, { seatId: 0, type: 'raise', amountTo: 100 }));
    expect(s.betting.currentBet).toBe(100);
  });
});

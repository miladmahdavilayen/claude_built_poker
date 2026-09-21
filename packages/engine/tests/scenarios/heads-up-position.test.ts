import { describe, expect, it } from 'vitest';
import { applyAction, getLegalActions, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck, totalChips } from '../helpers.js';

const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };

function headsUpTable() {
  return createTableState(config, [
    { seatId: 0, playerId: 'A', stack: 200 },
    { seatId: 1, playerId: 'B', stack: 200 },
  ]);
}

describe('heads-up position (scenario 1)', () => {
  it('button posts SB, acts first preflop, and acts last postflop', () => {
    const table = headsUpTable();
    const deck = orderedDeck('As', 'Kd', '2c', '2d');
    const started = startHand(table, deck);
    const s0 = expectOk(started);

    expect(s0.buttonSeat).toBe(0);
    const sb = s0.seats[0]!;
    const bb = s0.seats[1]!;
    expect(sb.committedThisStreet).toBe(1);
    expect(bb.committedThisStreet).toBe(2);
    expect(sb.holeCards).toEqual(['As', '2c']);
    expect(bb.holeCards).toEqual(['Kd', '2d']);

    // Button/SB acts first preflop.
    expect(s0.betting.actingSeat).toBe(0);
    const legal0 = getLegalActions(s0, 0);
    expect(legal0.canCall).toBe(true);
    expect(legal0.callAmount).toBe(1);
    expect(legal0.canRaise).toBe(true);
    expect(legal0.minRaiseTo).toBe(4);

    const afterCall = expectOk(applyAction(s0, { seatId: 0, type: 'call' }));
    // BB gets the option.
    expect(afterCall.betting.actingSeat).toBe(1);
    const legalBB = getLegalActions(afterCall, 1);
    expect(legalBB.canCheck).toBe(true);
    expect(legalBB.canRaise).toBe(true);

    const afterCheck = expectOk(applyAction(afterCall, { seatId: 1, type: 'check' }));
    expect(afterCheck.street).toBe('flop');
    // BB acts first postflop; button/SB acts last.
    expect(afterCheck.betting.actingSeat).toBe(1);

    expect(totalChips(afterCheck)).toBe(400);
  });
});

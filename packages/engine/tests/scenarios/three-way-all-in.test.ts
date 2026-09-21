import { describe, expect, it } from 'vitest';
import { applyAction, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

describe('scenario 6: three-way all-in produces three pots', () => {
  it('builds main + 2 side pots with correct amounts, eligibility, and independent winners', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 300 },
      { seatId: 1, playerId: 'SB', stack: 50 },
      { seatId: 2, playerId: 'BB', stack: 120 },
    ]);
    // Deal order starts at SB(1): SB gets deck[0,3], BB gets deck[1,4], BTN gets deck[2,5].
    const deck = orderedDeck(
      'As', 'Tc', '2c', // first card to SB, BB, BTN
      'Ad', 'Td', '7d', // second card to SB, BB, BTN
      '2h', // burn
      '4h', '5h', '6h', // flop
      '3h', // burn
      '9s', // turn
      '4d', // burn
      'Kd', // river
    );
    const started = expectOk(startHand(t, deck));
    // 3-handed: button=0, sb=1, bb=2; order: BTN(0) -> SB(1) -> BB(2).
    expect(started.betting.actingSeat).toBe(0);

    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'raise', amountTo: 300 })); // BTN all-in
    const s2 = expectOk(applyAction(s1, { seatId: 1, type: 'call' })); // SB all-in for 50
    const final = expectOk(applyAction(s2, { seatId: 2, type: 'call' })); // BB all-in for 120

    expect(final.phase).toBe('hand-complete');
    expect(final.pots).toHaveLength(3);
    expect(final.pots[0]).toMatchObject({ index: 0, amount: 150, cappedAt: 50, eligibleSeatIds: [0, 1, 2] });
    expect(final.pots[1]).toMatchObject({ index: 1, amount: 140, cappedAt: 120, eligibleSeatIds: [0, 2] });
    expect(final.pots[2]).toMatchObject({ index: 2, amount: 180, cappedAt: 300, eligibleSeatIds: [0] });

    // SB has the best hand overall (pocket aces) and wins the main pot only.
    // BB (pocket tens) beats BTN for the side pot it's eligible for.
    // BTN wins the top side pot uncontested. The short stack (SB) never
    // collects a share of either side pot.
    expect(final.seats[1]!.stack).toBe(150); // SB
    expect(final.seats[2]!.stack).toBe(140); // BB
    expect(final.seats[0]!.stack).toBe(180); // BTN

    const totalAfter = final.seats.reduce((sum, s) => sum + s.stack, 0);
    expect(totalAfter).toBe(300 + 50 + 120);
  });
});

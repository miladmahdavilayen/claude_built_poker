import { describe, expect, it } from 'vitest';
import { applyAction, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

describe('scenario 7: uncalled bet returned before pots are formed', () => {
  it('returns the excess of an unmatched raise before pot formation', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 300 },
      { seatId: 1, playerId: 'B', stack: 80 },
    ]);
    const deck = orderedDeck('As', 'Kd', '2c', '2d');
    const started = expectOk(startHand(t, deck));
    // Heads-up: button(0) is SB and acts first preflop.
    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'raise', amountTo: 200 })); // A shoves 200
    const result = applyAction(s1, { seatId: 1, type: 'call' }); // B calls all-in for 80
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const returnEvent = result.events.find((e) => e.type === 'uncalled-bet-returned');
    expect(returnEvent).toMatchObject({ type: 'uncalled-bet-returned', seatId: 0, amount: 120 });
    const potsFormedIndex = result.events.findIndex((e) => e.type === 'pots-formed');
    const returnIndex = result.events.findIndex((e) => e.type === 'uncalled-bet-returned');
    expect(returnIndex).toBeLessThan(potsFormedIndex);

    expect(result.state.pots).toHaveLength(1);
    expect(result.state.pots[0]!.amount).toBe(160); // 80 (A) + 80 (B)
  });
});

describe('scenario 8: split pot odd chip goes to the seat closest left of the button', () => {
  it('awards the odd chip to the tied winner nearest left of the button', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 1, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 50 },
      { seatId: 2, playerId: 'BB', stack: 51 },
    ]);
    // Deal order starts at SB(1): SB=[deck0,deck3], BB=[deck1,deck4], BTN=[deck2,deck5].
    // Board "plays" a straight (9-T-J-Q-K) for both SB and BB: a guaranteed exact tie.
    const deck = orderedDeck(
      '2s', '4h', '6d', // first card to SB, BB, BTN
      '3d', '5c', '7d', // second card to SB, BB, BTN
      '2h', '9c', 'Tc', 'Jd', // burn, flop
      '3h', 'Qh', // burn, turn
      '4c', 'Ks', // burn, river
    );
    const started = expectOk(startHand(t, deck));
    // 3-handed: button=0, sb=1, bb=2; order: BTN(0) -> SB(1) -> BB(2).
    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'fold' }));
    const s2 = expectOk(applyAction(s1, { seatId: 1, type: 'raise', amountTo: 50 })); // SB all-in
    const final = expectOk(applyAction(s2, { seatId: 2, type: 'call' })); // BB all-in, matches exactly

    expect(final.phase).toBe('hand-complete');
    expect(final.pots).toHaveLength(1);
    expect(final.pots[0]!.amount).toBe(101);

    // SB (seat 1) is immediately left of the button (seat 0); BB (seat 2) is not.
    expect(final.seats[1]!.stack).toBe(51); // 50 share + the odd chip
    expect(final.seats[2]!.stack).toBe(50);
  });
});

describe('scenario 9: a folded contributor leaves their chips in the pot', () => {
  it('keeps a folded seat\'s contribution in the pot without granting them a share', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 500 },
    ]);
    const deck = orderedDeck('As', 'Kd', '2c', 'Ac', 'Kh', '2d');
    const started = expectOk(startHand(t, deck));

    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'raise', amountTo: 30 })); // BTN raises to 30
    const s2 = expectOk(applyAction(s1, { seatId: 1, type: 'call' })); // SB calls 30
    const s3 = expectOk(applyAction(s2, { seatId: 2, type: 'raise', amountTo: 100 })); // BB re-raises to 100
    const btnStackBeforeFold = s3.seats[0]!.stack;
    const s4 = expectOk(applyAction(s3, { seatId: 0, type: 'fold' })); // BTN folds, forfeiting their 30
    expect(s4.seats[0]!.stack).toBe(btnStackBeforeFold); // folding doesn't return or cost more chips
    const s5 = expectOk(applyAction(s4, { seatId: 1, type: 'call' })); // SB calls to 100
    expect(s5.street).toBe('flop');

    // Both players still have chips behind; check it down to showdown.
    let s = s5;
    for (let i = 0; i < 3; i++) {
      s = expectOk(applyAction(s, { seatId: 1, type: 'check' }));
      s = expectOk(applyAction(s, { seatId: 2, type: 'check' }));
    }
    const final = s;

    expect(final.phase).toBe('hand-complete');
    const totalPot = final.pots.reduce((sum, p) => sum + p.amount, 0);
    expect(totalPot).toBe(30 + 100 + 100); // BTN's 30 + SB's 100 + BB's 100

    // BTN (folded) must not appear among any pot's winners.
    expect(final.seats[0]!.stack).toBe(500 - 30);
  });
});

describe('scenario 11: everyone folds to the big blind', () => {
  it('awards the pot to the BB without a showdown', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 500 },
    ]);
    const deck = orderedDeck('2c', '3c', '4c', '5c', '6c', '7c');
    const started = expectOk(startHand(t, deck));

    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'fold' }));
    const result = applyAction(s1, { seatId: 1, type: 'fold' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const final = result.state;

    expect(final.phase).toBe('hand-complete');
    expect(final.seats[2]!.stack).toBe(500 + 1 + 0); // wins BTN's 0 + SB's 1, keeps own blind
    expect(result.events.some((e) => e.type === 'showdown-reveal')).toBe(false);
    expect(final.betting.actingSeat).toBeNull();
  });
});

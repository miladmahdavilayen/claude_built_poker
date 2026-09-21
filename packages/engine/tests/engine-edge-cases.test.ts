import { describe, expect, it } from 'vitest';
import * as PublicApi from '../src/index.js';
import { expectErr, expectOk, orderedDeck } from './helpers.js';

const { applyAction, createTableState, fullDeck, getLegalActions, startHand } = PublicApi;

describe('engine edge cases and error paths', () => {
  it('rejects starting a hand while one is already in progress', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 200 },
      { seatId: 1, playerId: 'B', stack: 200 },
    ]);
    const started = expectOk(startHand(t, fullDeck()));
    const again = startHand(started, fullDeck());
    expect(expectErr(again)).toBe('HAND_ALREADY_IN_PROGRESS');
  });

  it('rejects a malformed deck', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 200 },
      { seatId: 1, playerId: 'B', stack: 200 },
    ]);
    expect(expectErr(startHand(t, fullDeck().slice(0, 51)))).toBe('INVALID_DECK');
    expect(expectErr(startHand(t, [...fullDeck().slice(0, 51), 'As']))).toBe('INVALID_DECK');
  });

  it('rejects starting a hand with fewer than 2 seats with chips', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [{ seatId: 0, playerId: 'A', stack: 200 }]);
    expect(expectErr(startHand(t, fullDeck()))).toBe('NOT_ENOUGH_PLAYERS');
  });

  it('straddle: UTG posts 2x BB and acts last preflop, as the effective opening bet', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 4, straddleEnabled: true };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 500 },
      { seatId: 3, playerId: 'UTG', stack: 500 },
    ]);
    const deck = orderedDeck('2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c');
    const started = expectOk(startHand(t, deck));

    expect(started.straddleSeat).toBe(3);
    expect(started.seats[3]!.committedThisStreet).toBe(4);
    expect(started.betting.currentBet).toBe(4);
    expect(started.betting.lastFullRaiseIncrement).toBe(4);

    // Action still starts left of the straddle (BTN, seat 0), and the
    // straddler (UTG) is last to act preflop.
    expect(started.betting.actingSeat).toBe(0);

    let s = expectOk(applyAction(started, { seatId: 0, type: 'call' }));
    s = expectOk(applyAction(s, { seatId: 1, type: 'call' }));
    s = expectOk(applyAction(s, { seatId: 2, type: 'call' }));
    expect(s.betting.actingSeat).toBe(3);
    // The straddler gets the option, just like the BB would on a limped pot.
    const legal = getLegalActions(s, 3);
    expect(legal.canCheck).toBe(true);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(8);
  });

  it('a heads-up table never straddles even when straddleEnabled is true', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: true };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 200 },
      { seatId: 1, playerId: 'B', stack: 200 },
    ]);
    const started = expectOk(startHand(t, fullDeck()));
    expect(started.straddleSeat).toBeNull();
  });
});

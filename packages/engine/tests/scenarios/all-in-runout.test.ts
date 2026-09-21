import { describe, expect, it } from 'vitest';
import { applyAction, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

describe('scenario 10: all-in preflop runs out every street with a single early reveal', () => {
  it('emits showdown-reveal once, before the flop/turn/river run-out', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 100 },
      { seatId: 1, playerId: 'B', stack: 100 },
    ]);
    const deck = orderedDeck('As', 'Kd', '2c', '2d');
    const started = expectOk(startHand(t, deck));

    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'raise', amountTo: 100 })); // A shoves
    const result = applyAction(s1, { seatId: 1, type: 'call' }); // B calls all-in
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const types = result.events.map((e) => e.type);
    const revealIndices = types.reduce<number[]>((acc, t2, i) => (t2 === 'showdown-reveal' ? [...acc, i] : acc), []);
    const firstFlopIndex = types.indexOf('street-dealt');

    // Exactly one reveal per contender, both before the flop is dealt.
    expect(revealIndices).toHaveLength(2);
    for (const idx of revealIndices) expect(idx).toBeLessThan(firstFlopIndex);

    // All three remaining streets were dealt automatically.
    expect(types.filter((t2) => t2 === 'street-dealt')).toHaveLength(3);
    expect(result.state.street).toBe('river');
    expect(result.state.board).toHaveLength(5);
    expect(result.state.phase).toBe('hand-complete');

    // No duplicate reveal at the final showdown.
    expect(types.filter((t2) => t2 === 'showdown-reveal')).toHaveLength(2);
  });
});

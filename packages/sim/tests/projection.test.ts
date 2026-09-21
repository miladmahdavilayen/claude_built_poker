import { createTableState, fullDeck, startHand } from '@pokerclause/engine';
import { describe, expect, it } from 'vitest';
import { projectSeatView } from '../src/projection.js';

describe('projectSeatView', () => {
  it('never leaks another seat\'s hole cards or the undealt deck', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 4, straddleEnabled: false };
    const t = createTableState(
      config,
      [0, 1, 2, 3].map((seatId) => ({ seatId, playerId: `P${String(seatId)}`, stack: 200 })),
    );
    const result = startHand(t, fullDeck());
    if (!result.ok) throw new Error('unreachable');
    const state = result.state;

    const allDealtCards = new Set(state.seats.flatMap((s) => s.holeCards));
    expect(allDealtCards.size).toBeGreaterThan(0);

    for (const viewerSeat of state.seats) {
      const view = projectSeatView(state, viewerSeat.seatId);
      expect((view as unknown as { deck?: unknown }).deck).toBeUndefined();
      expect((view as unknown as { burned?: unknown }).burned).toBeUndefined();

      for (const seatInView of view.seats) {
        if (seatInView.seatId === viewerSeat.seatId) {
          expect(seatInView.holeCards).toEqual(viewerSeat.holeCards);
        } else {
          expect(seatInView.holeCards).toEqual([]);
          // Belt and suspenders: none of the real cards for other seats leak anywhere in the view.
          const realOtherCards = state.seats.find((s) => s.seatId === seatInView.seatId)!.holeCards;
          for (const card of realOtherCards) {
            expect(JSON.stringify(view)).not.toContain(card);
          }
        }
      }
    }
  });

  it('preserves every other field the bot needs to decide', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 200 },
      { seatId: 1, playerId: 'B', stack: 200 },
    ]);
    const result = startHand(t, fullDeck());
    if (!result.ok) throw new Error('unreachable');
    const view = projectSeatView(result.state, 0);
    expect(view.street).toBe('preflop');
    expect(view.betting.currentBet).toBe(2);
    expect(view.config).toEqual(config);
    expect(view.seats).toHaveLength(2);
  });
});

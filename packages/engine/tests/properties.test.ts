import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fullDeck } from '../src/deck.js';
import { applyAction, getLegalActions, startHand } from '../src/engine.js';
import { createTableState } from '../src/factory.js';
import type { Card, LegalActions, PlayerAction, TableState } from '../src/types.js';

function pickAction(legal: LegalActions, n: number): PlayerAction {
  const options: PlayerAction[] = [];
  if (legal.canFold) options.push({ seatId: legal.seatId, type: 'fold' });
  if (legal.canCheck) options.push({ seatId: legal.seatId, type: 'check' });
  if (legal.canCall) options.push({ seatId: legal.seatId, type: 'call' });
  if (legal.canBet) {
    options.push({ seatId: legal.seatId, type: 'bet', amountTo: legal.minBet });
    options.push({ seatId: legal.seatId, type: 'bet', amountTo: legal.maxBet });
    if (legal.maxBet > legal.minBet + 1) {
      options.push({ seatId: legal.seatId, type: 'bet', amountTo: Math.floor((legal.minBet + legal.maxBet) / 2) });
    }
  }
  if (legal.canRaise) {
    options.push({ seatId: legal.seatId, type: 'raise', amountTo: legal.minRaiseTo });
    options.push({ seatId: legal.seatId, type: 'raise', amountTo: legal.maxRaiseTo });
    if (legal.maxRaiseTo > legal.minRaiseTo + 1) {
      options.push({ seatId: legal.seatId, type: 'raise', amountTo: Math.floor((legal.minRaiseTo + legal.maxRaiseTo) / 2) });
    }
  }
  if (options.length === 0) throw new Error('unreachable: no legal action available on this seat\'s turn');
  return options[((n % options.length) + options.length) % options.length]!;
}

function assertNoDuplicateCards(state: TableState): void {
  const seen = new Set<Card>();
  const dupes: Card[] = [];
  const record = (c: Card) => {
    if (seen.has(c)) dupes.push(c);
    seen.add(c);
  };
  for (const c of state.deck) record(c);
  for (const c of state.board) record(c);
  for (const c of state.burned) record(c);
  for (const seat of state.seats) for (const c of seat.holeCards) record(c);
  expect(dupes, `duplicate cards found: ${JSON.stringify(dupes)}`).toEqual([]);
  expect(seen.size).toBeLessThanOrEqual(52);
}

function currentTotal(state: TableState): number {
  const inStacks = state.seats.reduce((sum, s) => sum + s.stack, 0);
  if (state.phase === 'hand-complete' || state.phase === 'waiting') return inStacks;
  const committed = state.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
  return inStacks + committed + state.anteTotal;
}

describe('property: engine invariants over random legal action sequences', () => {
  it('holds chip conservation, no negative stacks, no duplicate cards, and termination', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }), // seat count
        fc.array(fc.integer({ min: 2, max: 100 }), { minLength: 2, maxLength: 5 }), // stacks pool
        fc.shuffledSubarray(fullDeck(), { minLength: 52, maxLength: 52 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 20, maxLength: 300 }), // action choices
        (seatCount, stackPool, deck, choices) => {
          const numPlayers = Math.min(seatCount, stackPool.length);
          fc.pre(numPlayers >= 2);
          const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: numPlayers, straddleEnabled: false };
          const players = Array.from({ length: numPlayers }, (_, i) => ({
            seatId: i,
            playerId: `P${String(i)}`,
            stack: stackPool[i]!,
          }));
          const initial = createTableState(config, players);
          const initialTotal = players.reduce((sum, p) => sum + p.stack, 0);

          let result = startHand(initial, deck);
          if (!result.ok) {
            // NOT_ENOUGH_PLAYERS can't happen (numPlayers>=2, all stacks>0); anything else is a real failure.
            throw new Error(`startHand failed unexpectedly: ${result.error.code}`);
          }

          let choiceIdx = 0;
          let steps = 0;
          const maxSteps = 2000;

          while (result.ok && result.state.phase === 'in-hand') {
            steps += 1;
            expect(steps, 'hand did not terminate within the step bound').toBeLessThan(maxSteps);

            expect(result.state.seats.every((s) => s.stack >= 0)).toBe(true);
            expect(currentTotal(result.state)).toBe(initialTotal);
            assertNoDuplicateCards(result.state);

            for (const seat of result.state.seats) {
              const legal = getLegalActions(result.state, seat.seatId);
              if (legal.canRaise) expect(legal.minRaiseTo).toBeLessThanOrEqual(legal.maxRaiseTo);
              if (legal.canBet) expect(legal.minBet).toBeLessThanOrEqual(legal.maxBet);
            }

            const seatId = result.state.betting.actingSeat;
            if (seatId === null) throw new Error('unreachable: in-hand with no acting seat');
            const legal = getLegalActions(result.state, seatId);
            const action = pickAction(legal, choices[choiceIdx % choices.length]!);
            choiceIdx += 1;

            const next = applyAction(result.state, action);
            if (!next.ok) {
              throw new Error(`a legal action was rejected: ${JSON.stringify(action)} -> ${next.error.code}: ${next.error.message}`);
            }
            result = next;
          }

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.state.phase).toBe('hand-complete');
          expect(result.state.seats.every((s) => s.stack >= 0)).toBe(true);
          expect(currentTotal(result.state)).toBe(initialTotal);
          assertNoDuplicateCards(result.state);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

import type { ProjectedGameEvent } from '@pokerclause/shared';
import { expect, test } from '@playwright/test';
import { dealerCalls, newHandTrack } from '../../src/dealerVoice.js';

// The house dealer's spoken calls (src/dealerVoice.ts): the action in a
// word (never who did it, never a raise amount), all-ins, heads up, how
// many see the flop, the board, showdown — and who won, by name.

const act = (seatId: number, type: string, resultingStack = 100): ProjectedGameEvent => ({ type: 'action-taken', seatId, action: { type }, resultingStack, committedThisStreet: 0 });
const NAMES = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve'];
const nameOf = (seatId: number): string => NAMES[seatId]!;
const start = (seats: number[]): ProjectedGameEvent[] => [
  { type: 'hand-started', handNumber: 1, buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2 },
  { type: 'cards-dealt', seats },
];

test('every action is called in a word; all-ins as such; a fold down to two players is "heads up" — and the flop goes on without saying it twice', () => {
  const hand = newHandTrack();
  expect(dealerCalls([...start([0, 1, 2, 3]), act(3, 'call'), act(0, 'raise'), act(1, 'fold'), act(2, 'fold')], hand, nameOf)).toEqual([
    'Call',
    'Raise',
    'Fold',
    'Fold',
    'Heads up',
  ]);
  expect(dealerCalls([act(3, 'call'), { type: 'street-dealt', street: 'flop', board: ['As', 'Kd', '7c'] }], hand, nameOf)).toEqual(['Call', 'Flop']);
  expect(dealerCalls([act(3, 'bet', 0), act(0, 'call', 0)], hand, nameOf)).toEqual(['All in', 'Call, all in']);
});

test('how many see the flop: "Four players to the flop", or "Heads up to the flop" when only two do', () => {
  const four = newHandTrack();
  dealerCalls([...start([0, 1, 2, 3, 4]), act(3, 'call'), act(4, 'fold'), act(0, 'call'), act(1, 'call'), act(2, 'check')], four, nameOf);
  expect(dealerCalls([{ type: 'street-dealt', street: 'flop', board: ['As', 'Kd', '7c'] }], four, nameOf)).toEqual(['Four players to the flop', 'Flop']);
  const two = newHandTrack();
  dealerCalls([...start([0, 1]), act(0, 'call'), act(1, 'check')], two, nameOf);
  expect(dealerCalls([{ type: 'street-dealt', street: 'flop', board: ['As', 'Kd', '7c'] }], two, nameOf)).toEqual(['Heads up to the flop', 'Flop']);
});

test('the result by name: the winner and their hand, a two-way chop by both names, three or more ways just "the pot is split"', () => {
  const hand = newHandTrack();
  dealerCalls(start([0, 1, 2]), hand, nameOf);
  expect(
    dealerCalls(
      [
        { type: 'street-dealt', street: 'turn', board: ['As', 'Kd', '7c', '2h'] },
        { type: 'street-dealt', street: 'river', board: ['As', 'Kd', '7c', '2h', '9s'] },
        { type: 'showdown-reveal', seatId: 0, holeCards: ['Ah', 'Ac'] },
        { type: 'showdown-reveal', seatId: 1, holeCards: ['Kh', 'Kc'] },
        { type: 'pot-awarded', potIndex: 0, winners: [{ seatId: 0, amount: 40, handName: 'three of a kind' }] },
        // A side pot to someone else gets a word; one to the main pot's winner doesn't.
        { type: 'pot-awarded', potIndex: 1, winners: [{ seatId: 1, amount: 10, handName: 'three of a kind' }] },
        { type: 'pot-awarded', potIndex: 2, winners: [{ seatId: 0, amount: 10, handName: 'three of a kind' }] },
      ],
      hand,
      nameOf,
    ),
  ).toEqual(['Turn', 'River', 'Showdown', 'Ann wins with three of a kind', 'Ben takes the side pot']);
  const flush = { amount: 20, handName: 'flush' };
  expect(dealerCalls([{ type: 'pot-awarded', potIndex: 0, winners: [{ seatId: 0, ...flush }, { seatId: 2, ...flush }] }], newHandTrack(), nameOf)).toEqual([
    'Ann and Cat split the pot',
  ]);
  expect(
    dealerCalls([{ type: 'pot-awarded', potIndex: 0, winners: [{ seatId: 0, ...flush }, { seatId: 1, ...flush }, { seatId: 2, ...flush }] }], newHandTrack(), nameOf),
  ).toEqual(['The pot is split']);
  expect(
    dealerCalls([{ type: 'pot-awarded', potIndex: 0, winners: [{ seatId: 3, amount: 20, handName: 'straight flush', bestFive: ['As', 'Ks', 'Qs', 'Js', 'Ts'] }] }], newHandTrack(), nameOf),
  ).toEqual(['Dan wins with a royal flush']);
  // Won uncontested — everyone else folded: just who.
  expect(dealerCalls([{ type: 'pot-awarded', potIndex: 0, winners: [{ seatId: 4, amount: 3 }] }], newHandTrack(), nameOf)).toEqual(['Eve wins']);
});

import type { ProjectedGameEvent } from '@pokerclause/shared';
import { expect, test } from '@playwright/test';
import { dealerCalls, newHandTrack } from '../../src/dealerVoice.js';
import { adminLogin, closeTableMenu, createTable, openTableMenu } from './helpers.js';

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
  ).toEqual(['Turn', 'River', 'Showdown', 'Ann wins with three aces', 'Ben takes the side pot with three kings']);
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

test('how the pot was won, made plain: the kicker when the board gives both players the same hand, the deciding cards of a flush, the full house', () => {
  const showdown = (board: string[], hands: Record<number, string[]>, winners: number[]): string => {
    const hand = newHandTrack();
    dealerCalls(start(Object.keys(hands).map(Number)), hand, nameOf);
    const events: ProjectedGameEvent[] = [
      { type: 'street-dealt', street: 'river', board: board as never },
      ...Object.entries(hands).map(([seat, cards]) => ({ type: 'showdown-reveal' as const, seatId: Number(seat), holeCards: cards as never })),
      { type: 'pot-awarded', potIndex: 0, winners: winners.map((seatId) => ({ seatId, amount: 10 })) },
    ];
    return dealerCalls(events, hand, nameOf).at(-1)!;
  };
  // The reported case: the board is two pair with a low card; Ann's lone ace plays as the kicker.
  expect(showdown(['Ks', 'Kd', '7c', '7h', '2s'], { 0: ['As', '3d'], 1: ['4c', '5d'] }, [0])).toBe('Ann wins with two pair, kings and sevens, ace kicker');
  // A better hand outright needs no kicker.
  expect(showdown(['Ks', 'Kd', '7c', '9h', '2s'], { 0: ['9s', '3d'], 1: ['Ac', '5d'] }, [0])).toBe('Ann wins with two pair, kings and nines');
  // Same pair, decided by the kicker.
  expect(showdown(['Qs', 'Qd', '8c', '6h', '2s'], { 0: ['Ad', '3c'], 1: ['Kc', '5d'] }, [0])).toBe('Ann wins with a pair of queens, ace kicker');
  // Two flushes, the same top card: the cards down to the one that decided it.
  expect(showdown(['Ah', '9h', '6h', '2h', 'Kc'], { 0: ['Qh', '3c'], 1: ['Jh', '5d'] }, [0])).toBe('Ann wins with a flush, ace, queen high');
  expect(showdown(['Ah', 'Ad', '9c', '9h', '4s'], { 0: ['As', '2c'], 1: ['9s', '5d'] }, [0])).toBe('Ann wins with a full house, aces full of nines');
  expect(showdown(['5h', '4d', '3c', 'Kh', '9s'], { 0: ['Ac', '2d'], 1: ['Kc', 'Kd'] }, [0])).toBe('Ann wins with a straight, five high');
  expect(showdown(['5h', '4d', '3c', '9h', 'Ts'], { 0: ['Ac', 'Qd'], 1: ['Kc', 'Jd'] }, [0])).toBe('Ann wins with ace high');
  // A chop between two: both names, and what they share.
  expect(showdown(['Ah', 'Kd', 'Qc', 'Jh', 'Ts'], { 0: ['2c', '3d'], 1: ['4c', '5d'] }, [0, 1])).toBe('Ann and Ben split the pot, both with a straight, ace high');
});

test('a winner who chooses to show after everyone folded: "Ann shows the hand", or "Ann shows the bluff" — never "Showdown"', () => {
  const won = (holeCards: string[]): string[] => {
    const hand = newHandTrack();
    dealerCalls(start([0, 1]), hand, nameOf);
    dealerCalls([{ type: 'street-dealt', street: 'flop', board: ['As', 'Kd', '7c'] }, { type: 'street-dealt', street: 'turn', board: ['As', 'Kd', '7c', '2h'] }], hand, nameOf);
    // Ben folds to Ann's bet: she wins, uncontested.
    expect(
      dealerCalls(
        [act(0, 'bet'), act(1, 'fold'), { type: 'pot-awarded', potIndex: 0, winners: [{ seatId: 0, amount: 30 }] }, { type: 'hand-complete', handNumber: 1 }],
        hand,
        nameOf,
      ),
    ).toEqual(['Bet', 'Fold', 'Ann wins']);
    // Then, by her own choice (Reveal Hand / Show Bluff), her cards.
    return dealerCalls([{ type: 'showdown-reveal', seatId: 0, holeCards: holeCards as never }], hand, nameOf);
  };
  expect(won(['Ah', '3c'])).toEqual(['Ann shows the hand']); // a pair of aces
  expect(won(['9s', '4h'])).toEqual(['Ann shows the bluff']); // nothing at all
});

test('the dealer is on whenever a table opens, in the voice picked last — a mute lasts only while you are there', async ({ page }) => {
  // An old "off" from before is not carried into a new table.
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('seeded')) return;
    window.sessionStorage.setItem('seeded', '1');
    window.localStorage.setItem('pokerclause.dealerVoice', 'off');
  });
  await adminLogin(page);
  await createTable(page, { name: 'Dealer Voice On', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await expect(page.getByRole('button', { name: 'Mute the dealer' })).toBeVisible();
  const menu = await openTableMenu(page);
  await expect(menu.getByRole('radiogroup', { name: 'Dealer voice' }).getByLabel('Female', { exact: true })).toBeChecked();
  await menu.getByRole('radiogroup', { name: 'Dealer voice' }).getByLabel('Male', { exact: true }).check();
  await closeTableMenu(page);
  await page.getByRole('button', { name: 'Mute the dealer' }).click();
  await expect(page.getByRole('button', { name: 'Unmute the dealer' })).toBeVisible();
  // Back at the table later: on again, in the voice picked.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Mute the dealer' })).toBeVisible();
  await expect((await openTableMenu(page)).getByRole('radiogroup', { name: 'Dealer voice' }).getByLabel('Male', { exact: true })).toBeChecked();
});

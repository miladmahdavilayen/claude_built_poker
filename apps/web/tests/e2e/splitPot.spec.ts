import { expect, test, type Page } from '@playwright/test';
import { buildPotAnnouncements, describeHand, splitLogLine, type PotAward } from '../../src/splitPot.js';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// The split-pot announcement (components/SplitPotAnnouncement.tsx). Its
// words come from splitPot.ts, tested directly first; then the real thing
// at a table. A real split can't be dealt on demand, so the awards are
// handed to the dev-only `__splitPot` hook — the same path a showdown's
// 'pot-awarded' events take.

const names: Record<number, string> = { 0: 'Alice', 3: 'Bob', 5: 'Cara' };
const nameOf = (id: number): string => names[id] ?? `Seat ${String(id + 1)}`;
const straightA = ['As', 'Kd', 'Qh', 'Jc', 'Ts'] as const;

test('a 2-way chop names both players, the amount each, and the hand they share', () => {
  const anns = buildPotAnnouncements(
    [{ potIndex: 0, winners: [{ seatId: 0, amount: 500, handName: 'straight', bestFive: [...straightA] }, { seatId: 3, amount: 500, handName: 'straight', bestFive: [...straightA] }] }],
    nameOf,
    ['As', 'Kd', 'Qh', '2c', '3s'],
  )!;
  expect(anns).toHaveLength(1);
  expect(anns[0]).toMatchObject({ split: true, label: null, title: 'SPLIT POT', subline: 'Alice & Bob chop $5 each', handLine: 'Both have an Ace-high straight' });
});

test('3-way, unequal (odd chip) and board-plays splits read right, with the exact amounts given', () => {
  const three = buildPotAnnouncements(
    [{ potIndex: 0, winners: [0, 3, 5].map((seatId) => ({ seatId, amount: 300, handName: 'flush', bestFive: ['Ah', 'Jh', '9h', '6h', '2h'] })) }],
    nameOf,
    ['Ah', 'Jh', '9h', '6h', '2h'],
  )!;
  expect(three[0]).toMatchObject({ title: 'SPLIT POT: 3 WAYS', subline: 'Alice, Bob & Cara — $3 each', handLine: 'Board plays' });

  const odd = buildPotAnnouncements([{ potIndex: 0, winners: [{ seatId: 0, amount: 251 }, { seatId: 3, amount: 250 }] }], nameOf, [])!;
  expect(odd[0]).toMatchObject({ title: 'SPLIT POT', subline: 'Alice $2.51, Bob $2.50', handLine: null });

  const oddThree = buildPotAnnouncements([{ potIndex: 0, winners: [{ seatId: 0, amount: 34 }, { seatId: 3, amount: 33 }, { seatId: 5, amount: 33 }] }], nameOf, [])!;
  expect(oddThree[0]!.subline).toBe('Alice $0.34 · Bob $0.33 · Cara $0.33');
});

test('several pots are announced one by one in award order, each labeled; one winner per pot keeps the usual celebration', () => {
  // The engine awards side pots first, then the main pot.
  const awards: PotAward[] = [
    { potIndex: 1, winners: [{ seatId: 5, amount: 400, handName: 'two pairs', bestFive: ['Kh', 'Ks', '5d', '5c', '9h'] }] },
    { potIndex: 0, winners: [{ seatId: 0, amount: 600 }, { seatId: 3, amount: 600 }] },
  ];
  const anns = buildPotAnnouncements(awards, nameOf, [])!;
  expect(anns.map((a) => a.label)).toEqual(['Side Pot 1', 'Main Pot']);
  expect(anns[0]).toMatchObject({ split: false, title: 'Cara wins', subline: '$4', handLine: 'with two pair, Kings and Fives' });
  expect(anns[1]).toMatchObject({ split: true, subline: 'Alice & Bob chop $6 each' });
  // No pot split at all: nothing to announce here.
  expect(buildPotAnnouncements([{ potIndex: 0, winners: [{ seatId: 0, amount: 900 }] }], nameOf, [])).toBeNull();
  expect(buildPotAnnouncements([awards[0]!], nameOf, [])).toBeNull();
});

test('the hand log and chat get the split in plain words', () => {
  expect(splitLogLine({ potIndex: 0, winners: [{ seatId: 0, amount: 500 }, { seatId: 3, amount: 500 }] }, nameOf, 1)).toBe('Alice and Bob split the pot, $5 each');
  expect(splitLogLine({ potIndex: 1, winners: [{ seatId: 0, amount: 251 }, { seatId: 3, amount: 250 }] }, nameOf, 2)).toBe('Alice and Bob split the side pot 1, Alice $2.51, Bob $2.50');
  expect(splitLogLine({ potIndex: 0, winners: [{ seatId: 0, amount: 500 }] }, nameOf, 1)).toBeNull();
  expect(describeHand('full house', ['Kh', 'Ks', 'Kd', '5c', '5h'])).toBe('Kings full of Fives');
  expect(describeHand('straight', ['As', '2d', '3h', '4c', '5s'])).toBe('a Five-high straight');
  expect(describeHand('straight flush', ['Ts', 'Js', 'Qs', 'Ks', 'As'])).toBe('a Royal Flush');
  expect(describeHand('one pair', ['6h', '6s', 'Ad', '9c', '2h'])).toBe('a pair of Sixes');
});

async function splitTable(browser: import('@playwright/test').Browser, view: '2d' | 'seated'): Promise<{ owner: Page; bob: Page; close: () => Promise<void> }> {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  for (const ctx of [ctxA, ctxB]) {
    await ctx.addInitScript((v) => {
      window.localStorage.setItem('pokerclause.tableView', v);
      // A fixed 3D quality: software rendering here would otherwise step itself down to 2D.
      window.localStorage.setItem('pokerclause.tableQuality', 'low');
    }, view);
  }
  const owner = await ctxA.newPage();
  const bob = await ctxB.newPage();
  await adminLogin(owner);
  await createTable(owner, { name: `Split ${view}`, smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 200);
  await guestSignup(bob, 'Bob');
  await inviteToSeat(owner, bob, 3, 200);
  await startHand(owner);
  await owner.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });
  return {
    owner,
    bob,
    close: async () => {
      await ctxA.close();
      await ctxB.close();
    },
  };
}

const announce = (page: Page, awards: PotAward[]): Promise<void> =>
  page.evaluate((a) => (window as unknown as { __splitPot: (a: PotAward[]) => void }).__splitPot(a), awards);

test('a split pot at the table: banner, each winner glowing with their +$X, the others dimmed, a chat line — and a tap skips it', async ({ browser }) => {
  const { owner, bob, close } = await splitTable(browser, '2d');
  const awards: PotAward[] = [{ potIndex: 0, winners: [{ seatId: 0, amount: 500 }, { seatId: 3, amount: 500 }] }];
  await announce(owner, awards);
  await announce(bob, awards);
  for (const page of [owner, bob]) {
    const banner = page.getByTestId('split-pot-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('SPLIT POT');
    await expect(page.getByTestId('split-pot-sub')).toHaveText(/& .* chop \$5 each/);
    await expect(page.getByTestId('split-float-0')).toHaveText('+$5');
    await expect(page.getByTestId('split-float-3')).toHaveText('+$5');
    await expect(page.locator('[data-testid="seat-0"] .seat')).toHaveClass(/seat-split-winner/);
    await expect(page.locator('[data-testid="seat-3"] .seat')).toHaveClass(/seat-split-winner/);
  }
  // In the chat, in plain words, for everyone.
  await owner.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(owner.locator('.chat-message--dealer')).toContainText('split the pot, $5 each');

  // Tapping the banner skips straight to the end: nothing left behind.
  await owner.getByTestId('split-pot-banner').click();
  await expect(owner.getByTestId('split-pot-banner')).toHaveCount(0);
  await expect(owner.locator('.split-pot-float, .split-pot-pile, .seat-split-winner, .seat-split-dim')).toHaveCount(0);
  // Left alone, it goes by itself.
  await expect(bob.getByTestId('split-pot-banner')).toHaveCount(0, { timeout: 6000 });
  await expect(bob.locator('.split-pot-float, .split-pot-pile, .seat-split-winner')).toHaveCount(0);
  await close();
});

test('several pots play one at a time, in order, never two banners at once', async ({ browser }) => {
  const { owner, close } = await splitTable(browser, '2d');
  await announce(owner, [
    { potIndex: 1, winners: [{ seatId: 3, amount: 400 }] },
    { potIndex: 0, winners: [{ seatId: 0, amount: 301 }, { seatId: 3, amount: 300 }] },
  ]);
  const banner = owner.getByTestId('split-pot-banner');
  await expect(banner).toHaveAttribute('data-pot-index', '1');
  await expect(banner).toContainText('Side Pot 1');
  await expect(banner).toHaveCount(1);
  await expect(banner).toHaveAttribute('data-pot-index', '0', { timeout: 5000 });
  await expect(banner).toContainText('Main Pot');
  await expect(owner.getByTestId('split-pot-sub')).toHaveText(/\$3\.01, .* \$3(\.00)?$/);
  await expect(banner).toHaveCount(1);
  await close();
});

test('on the 3D table too: the same banner, readable, over the scene', async ({ browser }) => {
  const { owner, close } = await splitTable(browser, 'seated');
  const webgl = await owner.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  test.skip(!webgl, 'No WebGL in this browser');
  await expect(owner.getByTestId('table-3d')).toBeVisible({ timeout: 20_000 });
  await announce(owner, [{ potIndex: 0, winners: [0, 3].map((seatId) => ({ seatId, amount: 250 })) }]);
  await expect(owner.getByTestId('split-pot-banner')).toContainText('chop $2.50 each');
  await expect(owner.locator('[data-testid="seat-3"] .seat')).toHaveClass(/seat-split-winner/);
  await close();
});

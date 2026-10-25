import { expect, test } from '@playwright/test';
import { winTierOf } from '../../src/winTiers.js';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// The trophy show for the viewer's own straight-or-better win (see
// components/TrophyCelebration.tsx). A real straight can't be dealt on
// demand, so the show is fired through the dev-only `__celebrate` hook
// (WinCelebration.tsx) — the same path a real pot-awarded event takes.

test('hand names map to celebration tiers, a royal flush being the straight flush to the ace', () => {
  expect(winTierOf('one pair', undefined)).toBe(0);
  expect(winTierOf('three of a kind', undefined)).toBe(0);
  expect(winTierOf(undefined, undefined)).toBe(0);
  expect(winTierOf('straight', undefined)).toBe(1);
  expect(winTierOf('flush', undefined)).toBe(2);
  expect(winTierOf('full house', undefined)).toBe(3);
  expect(winTierOf('four of a kind', undefined)).toBe(4);
  expect(winTierOf('straight flush', ['5s', '6s', '7s', '8s', '9s'])).toBe(5);
  // The wheel has an ace but no king: still "only" a straight flush.
  expect(winTierOf('straight flush', ['As', '2s', '3s', '4s', '5s'])).toBe(5);
  expect(winTierOf('straight flush', ['Ts', 'Js', 'Qs', 'Ks', 'As'])).toBe(6);
});

test('a straight-or-better win shows a trophy that grows with the hand, clear of the board and the seats', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await adminLogin(pageA);
  await createTable(pageA, { name: 'Trophy Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageB, 'Bob');
  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 3, 200);
  await startHand(pageA);
  await pageA.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });

  const celebrate = (tier: number): Promise<void> => pageA.evaluate((t) => (window as unknown as { __celebrate: (t: number) => void }).__celebrate(t), tier);
  const show = pageA.getByTestId('trophy-celebration');

  await celebrate(1);
  await expect(show).toHaveAttribute('data-tier', '1');
  await expect(show.locator('.viewer-win-banner')).toContainText('You Win!');
  await expect(show.locator('.trophy-hand-name')).toHaveAttribute('aria-label', 'Straight');
  await expect(show.locator('.trophy-crown')).toHaveCount(0);
  // The trophy and its words keep off the community cards and the seated
  // players — checked once it has settled (it re-checks its spot over the
  // first second, in case the seats move at showdown).
  await pageA.waitForTimeout(1500);
  const clash = await pageA.evaluate(() => {
    const r = (el: Element): DOMRect => el.getBoundingClientRect();
    const hit = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const name = (el: Element): string => `${el.className} ${JSON.stringify(r(el).toJSON())}`;
    const mine = [document.querySelector('.trophy-icon')!, document.querySelector('.viewer-win-banner--trophy')!];
    const others = [...document.querySelectorAll('.board-cards, .seat:not(.seat-empty)')];
    return mine.flatMap((m) => others.filter((o) => hit(r(m), r(o))).map((o) => `${name(m)} x ${name(o)}`));
  });
  expect(clash).toEqual([]);
  // It goes away on its own.
  await expect(show).toHaveCount(0, { timeout: 6000 });

  await celebrate(6);
  await expect(show).toHaveAttribute('data-tier', '6');
  await expect(show.locator('.trophy-hand-name')).toHaveAttribute('aria-label', 'Royal Flush');
  // The royal show's extras: a crown, turning rays, a second ring, a flash.
  await expect(show.locator('.trophy-crown')).toHaveCount(1);
  await expect(pageA.locator('.trophy-backdrop .trophy-rays')).toHaveCount(1);
  await expect(pageA.locator('.trophy-backdrop .trophy-ring')).toHaveCount(2);
  await expect(pageA.locator('.trophy-backdrop .trophy-flash')).toHaveCount(1);

  // An ordinary win keeps the plain banner.
  await celebrate(0);
  await expect(show).toHaveCount(0);
  await expect(pageA.locator('.viewer-win-banner')).toContainText('You Win!');

  // Nobody else sees the viewer's trophy.
  await expect(pageB.getByTestId('trophy-celebration')).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});

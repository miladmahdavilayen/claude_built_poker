import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// Regression test: the "1/2 pot" and "Pot" bet-sizer preset buttons used
// to compute against `state.pots`, which the engine only ever populates
// once a hand fully concludes (showdown or a fold-win) — so mid-hand
// `potSize` was always 0 and both presets silently resolved to the
// minimum legal bet/raise, no matter how big the real pot actually was.
// Fixed via a client-side `livePotTotal` derived from every seat's
// `committedThisHand` (+ ante), which is correct at every point in a
// hand, not just after it ends. See DECISIONS.md.
test('the "Pot" preset bet-sizer button reflects the real live pot, not always the minimum bet', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Alice is the table owner (self-seating and inviting are both owner-only now — see DECISIONS.md).
  await adminLogin(pageA);
  await createTable(pageA, { name: 'Bet Sizer Presets Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });

  await guestSignup(pageB, 'Bob');

  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 1, 200);

  await startHand(pageA);
  await expect(pageA.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // Heads-up preflop: whichever page is button/SB acts first, facing a
  // call — raise it to a fixed, known amount so the resulting pot is
  // deterministic regardless of which page that turns out to be.
  const raiseFirst = (await pageA.locator('.btn-bet').isVisible().catch(() => false)) ? pageA : pageB;
  const callSecond = raiseFirst === pageA ? pageB : pageA;

  await raiseFirst.locator('.bet-sizer input[type="number"]').fill('10');
  await raiseFirst.locator('.btn-bet').click();
  await expect(callSecond.locator('.btn-call')).toBeVisible();
  await callSecond.locator('.btn-call').click();

  // Postflop, heads-up: BB (whichever page just called) acts first, facing
  // nobody's bet yet — a genuine "Bet", not "Raise", with a live pot of
  // exactly 10 + 10 = 20.
  await expect(callSecond.locator('.bet-sizer')).toBeVisible({ timeout: 10_000 });
  await callSecond.locator('.bet-sizer').getByRole('button', { name: 'Pot', exact: true }).click();
  const potPresetValue = await callSecond.locator('.bet-sizer input[type="number"]').inputValue();
  expect(Number(potPresetValue)).toBe(20);
});

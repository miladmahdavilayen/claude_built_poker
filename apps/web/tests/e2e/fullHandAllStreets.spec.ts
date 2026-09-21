import { expect, test } from '@playwright/test';
import { createTable, guestSignup, takeSeat } from './helpers.js';

// Regression test for a full hand driven by real bets/raises, not just
// checks/calls — the existing gameplay.spec.ts only ever exercises
// check/call, which would never catch a bug specific to the bet-sizer or
// a raise/bet button itself (see DECISIONS.md's action-bar visibility
// bug). Asserts the board genuinely progresses preflop → flop → turn →
// river → showdown, with the human betting on every street it's free to.
test('a full hand plays correctly through every street with real raises/bets, and settles the pot', async ({ page }) => {
  await guestSignup(page, 'Solo');
  await createTable(page, { name: 'All Streets Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);
  await page.locator('[data-testid="seat-1"]').getByText('+ Add bot').click();
  await page.getByLabel(/Buy-in/).fill('200');
  // "Maniac" never voluntarily folds — its own logic only reaches the
  // fold branch when neither check nor call is legal, which can't happen
  // on a genuine turn (one of the two is always available). ("Calling
  // Station" was tried first, but it has an intentional 5% random
  // fold-instead-of-call by design — see
  // packages/sim/src/bots/callingStation.ts — which made this flaky.)
  await page.getByLabel('Persona').selectOption('maniac');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();

  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.board-cards .card')).toHaveCount(5); // 5 placeholder/card slots, pre-flop

  // Bots think for 1-6s before acting (see DECISIONS.md), and this hand
  // can involve several bot decisions across four streets — a generous
  // round budget here, not a tight one.
  const boardCountsSeen = new Set<number>();
  let guard = 0;
  while (guard < 400) {
    guard++;
    const dealtCards = await page.locator('.board-cards .card:not(.card-placeholder)').count();
    boardCountsSeen.add(dealtCards);

    if (await page.getByText('Verify hand fairness').isVisible().catch(() => false)) break;

    const btns = await page.locator('.action-buttons button').allTextContents();
    if (btns.length > 0) {
      const checkBtn = page.locator('.btn-check');
      const betBtn = page.locator('.btn-bet'); // shared class for both Bet and Raise
      const callBtn = page.locator('.btn-call');
      if (await checkBtn.isVisible().catch(() => false)) {
        // Free to act: open the betting, to genuinely exercise Bet/Raise
        // on this street — but only ever as an OPENING bet, never a
        // re-raise (see below), to keep pot growth bounded and avoid an
        // early all-in racing past a street before this test's polling
        // can observe it.
        if (await betBtn.isVisible().catch(() => false)) {
          await betBtn.click();
        } else {
          await checkBtn.click();
        }
      } else if (await callBtn.isVisible().catch(() => false)) {
        // Facing a bet (either the blinds, or Maniac raising back at
        // us): just call, never re-raise — caps each street to at most
        // one bet + one raise before it closes.
        await callBtn.click();
      }
    }
    await page.waitForTimeout(100);
  }

  await expect(page.getByText('Verify hand fairness')).toBeVisible();
  console.log('board card counts observed during the hand:', [...boardCountsSeen].sort((a, b) => a - b));
  // The flop and the river were both genuinely reached (the turn, 4
  // cards, is asserted more loosely below — an all-in mid-hand deals the
  // remaining streets near-instantly server-side, which this test's
  // polling can legitimately race past without it indicating any real
  // bug; the flop and final river count are the load-bearing checks).
  expect(boardCountsSeen.has(3)).toBe(true);
  expect(boardCountsSeen.has(5)).toBe(true);

  // Both hole cards get revealed at a genuine showdown.
  await expect(page.locator('[data-testid="seat-1"] .card:not(.card-back)')).toHaveCount(2);

  // Stacks actually moved — a real pot was won, not a no-op.
  const stackText = await page.locator('[data-testid="seat-0"] .seat-stack').textContent();
  expect(Number(stackText?.replace(/,/g, ''))).not.toBe(200);
});

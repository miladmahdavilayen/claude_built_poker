import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// Regression/feature test for the voluntary post-fold-win reveal (see
// components/RevealHandButton.tsx and LiveTable.revealHand): whoever wins
// a hand purely because the other player folded — never having to show
// anything — gets a one-shot "Reveal Hand"/"Show Bluff" button, and using
// it broadcasts their real cards to every viewer and tacks 5 more real
// seconds onto the shuffle break (on top of this suite's own shortened
// HAND_BREAK_MS — see playwright.config.ts).
test('the fold-win winner can voluntarily reveal their cards, and it extends the shuffle break', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Alice (pageA, seat 0) is the table owner; Bob (pageB, seat 1) is invited. See helpers.ts.
  await adminLogin(pageA);
  await createTable(pageA, { name: 'Reveal Hand Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageB, 'Bob');
  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 1, 200);
  await startHand(pageA);
  await pageA.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });

  // Heads-up: whoever is first to act folds immediately, ending the hand
  // right away with no showdown at all — exactly the scenario this
  // feature is for.
  let folded = false;
  for (let guard = 0; guard < 100 && !folded; guard++) {
    for (const page of [pageA, pageB]) {
      const foldBtn = page.getByRole('button', { name: 'Fold' });
      if (await foldBtn.isVisible().catch(() => false)) {
        await foldBtn.click();
        folded = true;
        break;
      }
    }
    if (!folded) await pageA.waitForTimeout(50);
  }
  expect(folded).toBe(true);

  // The reveal button appears ONLY on the winner's own page — pageA and
  // pageB are separate browser contexts, so each locator is checked on
  // its own page rather than combined with `.or()` (which requires both
  // locators to share one frame).
  const revealA = pageA.locator('.btn-reveal-hand');
  const revealB = pageB.locator('.btn-reveal-hand');
  let aliceWon = false;
  for (let guard = 0; guard < 50; guard++) {
    if (await revealA.isVisible().catch(() => false)) {
      aliceWon = true;
      break;
    }
    if (await revealB.isVisible().catch(() => false)) break;
    await pageA.waitForTimeout(100);
  }
  const winnerPage = aliceWon ? pageA : pageB;
  const otherPage = aliceWon ? pageB : pageA;
  const winnerSeatId = aliceWon ? 0 : 1;
  await expect(winnerPage.locator('.btn-reveal-hand')).toBeVisible({ timeout: 5000 });
  await expect(otherPage.locator('.btn-reveal-hand')).toHaveCount(0);

  const revealBtn = winnerPage.locator('.btn-reveal-hand');
  await expect(revealBtn).toHaveText(/^(Reveal Hand|Show Bluff)$/);

  // Clicking it flips the winner's hole cards face-up for EVERYONE watching, not just the winner, and consumes the one-shot option.
  await revealBtn.click();
  await expect(revealBtn).toHaveCount(0);
  for (const page of [pageA, pageB]) {
    await expect(page.locator(`[data-testid="seat-${String(winnerSeatId)}"] .seat-cards .card`)).toHaveCount(2, { timeout: 3000 });
  }

  // The break must stay well past this suite's own shortened 1200ms
  // HAND_BREAK_MS (see playwright.config.ts) thanks to the extra 5s the
  // reveal tacks on, but still come back eventually.
  const playHandBtn = pageA.getByRole('button', { name: 'Play Hand' });
  await pageA.waitForTimeout(3000);
  await expect(playHandBtn).toHaveCount(0);
  await expect(playHandBtn).toBeVisible({ timeout: 6000 });

  await ctxA.close();
  await ctxB.close();
});

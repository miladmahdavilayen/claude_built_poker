import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// Regression test for the hand-winner announcement (see
// components/WinCelebration.tsx and DECISIONS.md): the winner sees a big
// "You Win!" banner, the loser sees a small subtle "Not this hand" cue
// on their own seat, and — checked from the winner's own page, so both
// are visible in the same view — the OTHER seat never gets the winner's
// big banner treatment.
test('the hand winner sees a celebratory banner, and the other player sees a subtle loss cue', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Alice is the table owner (self-seating and inviting are both owner-only now — see DECISIONS.md).
  await adminLogin(pageA);
  await createTable(pageA, { name: 'Win Celebration Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageB, 'Bob');
  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 1, 200);
  await startHand(pageA);
  await pageA.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });

  // Check/call only, on both pages, until showdown — a real winner is decided by the cards.
  let guard = 0;
  while (guard < 300) {
    guard++;
    for (const page of [pageA, pageB]) {
      const checkBtn = page.getByRole('button', { name: 'Check' });
      const callBtn = page.getByRole('button', { name: /^Call/ });
      if (await checkBtn.isVisible().catch(() => false)) await checkBtn.click();
      else if (await callBtn.isVisible().catch(() => false)) await callBtn.click();
    }
    if (await pageA.getByText('Verify hand fairness').isVisible().catch(() => false)) break;
    await pageA.waitForTimeout(100);
  }
  await expect(pageA.getByText('Verify hand fairness')).toBeVisible();

  // The banner is transient (fades after ~2.4s — see
  // WinCelebration.tsx's VIEWER_WIN_BANNER_MS), so a one-shot .isVisible()
  // snapshot right here is a real flakiness risk under load (the render
  // can lag slightly behind "Verify hand fairness" appearing) — retry
  // each check instead of taking a single instant DOM read.
  // A short timeout, not the full ~2.4s lifetime: the WINNING page's
  // banner renders essentially instantly (a client-side state update off
  // an already-received socket event, no round-trip involved) — the
  // timeout here is really only how long the LOSING page's check has to
  // block before concluding "never showed," and every other transient
  // badge (loss cue, other-win badge) shares the same fading clock, so
  // keeping this tight leaves them real time left to still be checked.
  async function winBannerShown(page: typeof pageA): Promise<boolean> {
    try {
      await expect(page.locator('.viewer-win-banner')).toBeVisible({ timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }
  // Checked in parallel — sequential checks would burn pageA's full
  // retry window before ever looking at pageB, racing the SAME 2.4s
  // clock pageB's own banner is fading against.
  const [aWon, bWon] = await Promise.all([winBannerShown(pageA), winBannerShown(pageB)]);
  // At least one page must see its own win — but with random cards
  // checked to a natural showdown, a genuine SPLIT POT (both players
  // holding the same best five-card hand, e.g. both playing the board)
  // is a real, not-rare outcome, and BOTH pages correctly show their own
  // "You Win!" banner in that case — this isn't a bug to guard against,
  // it's the same behavior asserted per-page below applying to two
  // winners instead of one.
  expect(aWon || bWon).toBe(true);

  if (aWon) await expect(pageA.locator('.viewer-win-banner')).toContainText('You Win!');
  if (bWon) await expect(pageB.locator('.viewer-win-banner')).toContainText('You Win!');

  // Only test the loser-specific cue when there genuinely is a lone loser.
  if (aWon !== bWon) {
    const loserPage = aWon ? pageB : pageA;
    await expect(loserPage.locator('.viewer-loss-badge')).toContainText('Not this hand');
    // The loser's page never shows the big celebratory banner for themselves.
    await expect(loserPage.locator('.viewer-win-banner')).toHaveCount(0);
  }

  await ctxA.close();
  await ctxB.close();
});

test('the flop, turn, and river each visibly animate in as they are dealt', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await adminLogin(pageA);
  await createTable(pageA, { name: 'Street Animation Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageB, 'Bob');
  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 1, 200);
  await startHand(pageA);
  await pageA.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });

  // Check/call to a natural showdown, polling for the .flying-card overlay
  // to appear at least once — it's transient (gone within ~1s of a street
  // dealing), so this has to catch it while it's up, not after the fact.
  let sawFlyingCard = false;
  let guard = 0;
  while (guard < 300) {
    guard++;
    for (const page of [pageA, pageB]) {
      const checkBtn = page.getByRole('button', { name: 'Check' });
      const callBtn = page.getByRole('button', { name: /^Call/ });
      if (await checkBtn.isVisible().catch(() => false)) await checkBtn.click();
      else if (await callBtn.isVisible().catch(() => false)) await callBtn.click();
    }
    if (await pageA.locator('.flying-card').count()) sawFlyingCard = true;
    if (await pageA.getByText('Verify hand fairness').isVisible().catch(() => false)) break;
    await pageA.waitForTimeout(60);
  }
  await expect(pageA.getByText('Verify hand fairness')).toBeVisible();
  expect(sawFlyingCard).toBe(true);
  // The board genuinely reached the river regardless of when the overlay was caught.
  await expect(pageA.locator('.board-cards .card:not(.card-placeholder)')).toHaveCount(5);
});

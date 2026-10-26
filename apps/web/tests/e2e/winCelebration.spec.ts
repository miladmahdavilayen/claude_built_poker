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

  // The banner and the loss cue are transient (they fade after ~2.4s — see
  // WinCelebration.tsx), and a slow CI runner can take longer than that just
  // to notice the hand ended. So each page watches for them from now on —
  // catching them the moment they appear — rather than looking afterwards.
  const watch = (page: typeof pageA, selector: string): Promise<string | null> =>
    page
      .locator(selector)
      .first()
      .waitFor({ state: 'visible', timeout: 120_000 })
      .then(async () => (await page.locator(selector).first().textContent().catch(() => '')) ?? '')
      .catch(() => null);
  const seen = { aWin: watch(pageA, '.viewer-win-banner'), bWin: watch(pageB, '.viewer-win-banner'), aLoss: watch(pageA, '.viewer-loss-badge'), bLoss: watch(pageB, '.viewer-loss-badge') };
  // Whatever it saw within a few seconds of the hand ending (null: nothing).
  const within = (p: Promise<string | null>): Promise<string | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 6000))]);

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

  const [aWin, bWin] = await Promise.all([within(seen.aWin), within(seen.bWin)]);
  // At least one page sees its own win. With random cards checked down to a
  // showdown, a genuine split pot (both playing the board, say) is a real
  // outcome, and then BOTH pages rightly show their own "You Win!".
  expect(aWin !== null || bWin !== null).toBe(true);
  if (aWin !== null) expect(aWin).toContain('You Win!');
  if (bWin !== null) expect(bWin).toContain('You Win!');

  // Only test the loser-specific cue when there genuinely is a lone loser.
  if ((aWin !== null) !== (bWin !== null)) {
    const loserLoss = await within(aWin !== null ? seen.bLoss : seen.aLoss);
    expect(loserLoss).toContain('Not this hand');
    // The loser's page never showed the big celebratory banner for themselves.
    expect(aWin !== null ? bWin : aWin).toBeNull();
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

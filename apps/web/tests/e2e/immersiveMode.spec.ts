import { expect, test } from '@playwright/test';
import { adminLogin, createTable, startHand, takeSeat } from './helpers.js';

// Regression test: toggling full-screen/immersive mode used to replay the
// shuffle/deal animation and sound out of nowhere, well after a hand had
// already been dealt. Root cause was in Table.tsx, not the toggle itself
// — `positions` (an array DealAnimation.tsx's effect depends on) was
// recomputed fresh on every render with no memoization, and the last
// non-empty events batch is never reset back to [] once consumed, so ANY
// re-render (immersive mode toggling its own local state included)
// retriggered that effect with the stale-but-still-truthy last batch. See
// DECISIONS.md. Asserts zero new `.shuffle-deck`/`.flying-card` elements
// appear while toggling, well after the real deal has already finished.
test('toggling full screen after a hand has already been dealt does not replay the shuffle/deal animation', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'Immersive Mode Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);
  await page.locator('[data-testid="seat-1"]').getByText('+ Add bot').click();
  await page.getByLabel(/Buy-in/).fill('200');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();
  await startHand(page);
  await page.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });

  // Let the real shuffle/deal animation finish well before watching —
  // SHUFFLE_MS (700) + DEAL_START_DELAY_MS (650) + per-seat stagger, with
  // margin (DealAnimation.tsx).
  await page.waitForTimeout(3000);

  const watchDone = page.evaluate(async () => {
    let sawShuffleOrDeal = false;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (
            node instanceof Element &&
            (node.matches('.shuffle-deck, .flying-card') || node.querySelector('.shuffle-deck, .flying-card'))
          ) {
            sawShuffleOrDeal = true;
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    await new Promise((r) => setTimeout(r, 3000));
    obs.disconnect();
    return sawShuffleOrDeal;
  });

  // Exit and re-enter full screen a few times during the watch window —
  // exactly the reported repro (toggle after a hand's already dealt).
  for (let i = 0; i < 3; i++) {
    await page.locator('.immersive-toggle').click();
    await page.waitForTimeout(300);
  }

  const sawShuffleOrDeal = await watchDone;
  expect(sawShuffleOrDeal).toBe(false);
});

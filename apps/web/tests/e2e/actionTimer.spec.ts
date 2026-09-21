import { expect, test } from '@playwright/test';
import { adminLogin, createTable, startHand, takeSeat } from './helpers.js';

// Regression test for the action-timer flicker (see ActionTimer.tsx's
// doc comment and DECISIONS.md): `state.actionDeadline` goes null every
// time it's a COMPUTER PLAYER's turn (no human clock shown for a bot's
// own think-time), which used to unmount and remount the entire
// `.action-timer` element on every bot/human handoff — a real, visible
// flash on essentially every turn in any hand with a bot seated. Fixed
// by keeping the element permanently mounted for the whole hand and
// only toggling a CSS opacity class. Asserts zero add/remove DOM
// mutations for `.action-timer` while a bot is genuinely acting and
// handing control back and forth with the human.
test('the action timer never unmounts/remounts during a hand with a bot, even across bot/human handoffs', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'Action Timer Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);
  await page.locator('[data-testid="seat-1"]').getByText('+ Add bot').click();
  await page.getByLabel(/Buy-in/).fill('200');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();
  await startHand(page);
  await page.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });

  const watchDone = page.evaluate(async () => {
    let removeCount = 0;
    let addCount = 0;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.removedNodes)) {
          if (node instanceof Element && (node.matches('.action-timer') || node.querySelector('.action-timer'))) removeCount++;
        }
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof Element && (node.matches('.action-timer') || node.querySelector('.action-timer'))) addCount++;
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    await new Promise((r) => setTimeout(r, 7000));
    obs.disconnect();
    return { removeCount, addCount };
  });

  // Act a few times ourselves during the watch window, to force real bot/human handoffs.
  for (let i = 0; i < 4; i++) {
    const checkBtn = page.getByRole('button', { name: 'Check' });
    const callBtn = page.getByRole('button', { name: /^Call/ });
    if (await checkBtn.isVisible().catch(() => false)) await checkBtn.click();
    else if (await callBtn.isVisible().catch(() => false)) await callBtn.click();
    await page.waitForTimeout(1500);
  }

  const counts = await watchDone;
  expect(counts).toEqual({ removeCount: 0, addCount: 0 });
});

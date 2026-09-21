import { expect, test } from '@playwright/test';
import { adminLogin, createTable, playHandToCompletion, startHand, takeSeat } from './helpers.js';

// Regression test for manual hand-start gating: nothing should ever deal
// automatically — not the table's very first hand, and not the next one
// after a hand completes. A seated player must explicitly click "Play
// Hand" every time. See DECISIONS.md.
test('no hand deals automatically — seating players only enables "Play Hand", which must be clicked every time', async ({ page }) => {
  // Self-seating and adding a bot are both owner-only now (see DECISIONS.md).
  await adminLogin(page);
  await createTable(page, { name: 'Start Hand Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });

  // Before anyone is seated: the panel shows a passive "waiting" hint (no button to click).
  await expect(page.getByText(/Waiting for a seated player to start a hand/)).toBeVisible();

  await takeSeat(page, 0, 200);

  // One seated human, no second player yet: "Play Hand" is visible but disabled.
  const playHandBtn = page.getByRole('button', { name: 'Play Hand' });
  await expect(playHandBtn).toBeVisible();
  await expect(playHandBtn).toBeDisabled();
  await expect(page.getByText(/Waiting for at least 2 seated players/)).toBeVisible();

  // No hand has started — no dealer button, no position labels, no hole cards, no fairness commitment.
  await expect(page.locator('[data-testid="fairness-commitment"]')).toHaveCount(0);
  await expect(page.locator('.dealer-button')).toHaveCount(0);
  await expect(page.locator('[data-testid="seat-0"] .seat-cards')).toHaveCount(0);

  await page.locator('[data-testid="seat-1"]').getByText('+ Add bot').click();
  await page.getByLabel(/Buy-in/).fill('200');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();

  // Two dealt-in seats now (one human, one bot) — button becomes enabled, but STILL nothing deals on its own.
  await expect(playHandBtn).toBeEnabled();
  await page.waitForTimeout(500); // give any (incorrect) auto-deal a real chance to happen
  await expect(page.locator('[data-testid="fairness-commitment"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="seat-0"] .seat-cards')).toHaveCount(0);

  // Clicking it is what actually deals the hand.
  await startHand(page);
  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="seat-0"] .seat-cards')).toBeVisible();
  await expect(playHandBtn).toHaveCount(0); // no start-hand panel while a hand is actually in progress

  await playHandToCompletion([page]);
  await expect(page.getByText('Verify hand fairness')).toBeVisible();

  // Hand over: the "Play Hand" panel comes back, and — same as before —
  // nothing deals a second hand on its own, no matter how long we wait.
  await expect(playHandBtn).toBeVisible();
  await expect(playHandBtn).toBeEnabled();
  await page.waitForTimeout(500);
  await expect(page.getByText('Verify hand fairness')).toBeVisible(); // still showing the FIRST hand's result, not a fresh one

  // A second explicit click deals hand #2.
  await startHand(page);
  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });
});

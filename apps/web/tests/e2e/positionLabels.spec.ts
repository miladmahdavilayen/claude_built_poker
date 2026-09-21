import { expect, test } from '@playwright/test';
import { createTable, guestSignup, takeSeat } from './helpers.js';

async function positionLabelFor(page: import('@playwright/test').Page, seatId: number): Promise<string | null> {
  const locator = page.locator(`[data-testid="seat-${seatId}"] .position-label`);
  // .count() never waits/hangs on a genuinely-absent element (unlike
  // .textContent(), which auto-waits up to the test timeout) — the
  // button seat legitimately has no .position-label (see Seat.tsx), so
  // checking existence first is required, not just a nicety.
  if ((await locator.count()) === 0) return null;
  return locator.textContent();
}

test('position labels (UTG, HJ, CO, etc.) and the dealer button match seat count and rotate with it', async ({ page }) => {
  await guestSignup(page, 'Solo');
  await createTable(page, { name: 'Position Labels Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 150);

  for (let seatId = 1; seatId <= 5; seatId++) {
    await page.locator(`[data-testid="seat-${seatId}"]`).getByText('+ Add bot').click();
    await page.getByLabel(/Buy-in/).fill('150');
    await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();
    await page.waitForTimeout(150);
  }

  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // 6-handed: exactly one seat is BTN (shown via the "D" disc, no redundant
  // text label), and the rest get UTG / HJ / CO / SB / BB — one of each,
  // no seat left unlabeled and no label reused.
  await expect(page.locator('.dealer-button')).toHaveCount(1);

  const labels: string[] = [];
  for (let seatId = 0; seatId <= 5; seatId++) {
    const text = await positionLabelFor(page, seatId);
    if (text) labels.push(text);
  }
  expect(labels.sort()).toEqual(['BB', 'CO', 'HJ', 'SB', 'UTG'].sort());

  // The button seat's own label is the dealer disc, not a redundant "BTN" text badge.
  const buttonSeatSlot = page.locator('[data-testid^="seat-"]').filter({ has: page.locator('.dealer-button') });
  await expect(buttonSeatSlot.locator('.position-label')).toHaveCount(0);
});

test('heads-up: the button seat is also effectively the small blind, and only BB gets a text label', async ({ page }) => {
  await guestSignup(page, 'Solo');
  await createTable(page, { name: 'Heads-Up Labels Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 150);
  await page.locator('[data-testid="seat-1"]').getByText('+ Add bot').click();
  await page.getByLabel(/Buy-in/).fill('150');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();

  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  await expect(page.locator('.dealer-button')).toHaveCount(1);

  const labels: string[] = [];
  for (let seatId = 0; seatId <= 1; seatId++) {
    const text = await positionLabelFor(page, seatId);
    if (text) labels.push(text);
  }
  expect(labels).toEqual(['BB']);
});

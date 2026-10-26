import { expect, test } from '@playwright/test';
import { addBot, adminLogin, chooseSeatOption, createTable, startHand, takeSeat } from './helpers.js';

// Seat changes (LiveTable.moveSeat) and the SB/BB tags (positionLabels.ts's blindTags).

test('the blinds are tagged in front of their seats, and a seated player moves to an empty seat — after the hand if they are in it', async ({ page }) => {
  test.setTimeout(120_000);
  await adminLogin(page);
  await createTable(page, { name: 'Seat Move', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await addBot(page, 1, 'calling-station', 200);
  await addBot(page, 2, 'calling-station', 200);
  await takeSeat(page, 0, 200);
  await startHand(page);

  // Three players: exactly one SB and one BB tag, on two different seats.
  await expect(page.locator('.blind-tag--sb')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.blind-tag--bb')).toHaveCount(1);
  await expect(page.locator('.blind-tag--sb')).toHaveText('SB');

  // Mid-hand: the move waits for the hand to end, and says so first.
  await chooseSeatOption(page, 4, 'Move to this seat');
  const dialog = page.getByRole('dialog', { name: 'Move to seat 5' });
  await expect(dialog).toContainText('as soon as this hand ends');
  await dialog.getByRole('button', { name: /^Move/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-testid="seat-0"]')).toContainText('to seat 5');

  // Play it out (checking/calling); then the seat has moved, stack and all.
  const ours = page.getByRole('button', { name: /^(Check|Call)/ }).first();
  const playHand = page.getByRole('button', { name: 'Play Hand' });
  for (let i = 0; i < 20 && !(await playHand.isVisible()); i++) {
    await expect(ours.or(playHand)).toBeVisible({ timeout: 30_000 });
    if (await ours.isVisible()) await ours.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await expect(page.locator('[data-testid="seat-4"]')).not.toHaveAttribute('data-seat-status', 'empty', { timeout: 10_000 });
  await expect(page.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'empty');
  // A taken seat offers no move.
  await expect(page.locator('[data-testid="seat-1"] .seat-empty-tap')).toHaveCount(0);
});

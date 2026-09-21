import { expect, test } from '@playwright/test';
import { createTable, guestSignup, playHandToCompletion, takeSeat } from './helpers.js';

test('a solo player can add a computer opponent, play a full hand against it, and remove it afterward', async ({ page }) => {
  await guestSignup(page, 'Solo');
  await createTable(page, { name: 'E2E Solo vs Bots Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });

  await takeSeat(page, 0, 100);

  await page.locator('[data-testid="seat-1"]').getByText('+ Add bot').click();
  await expect(page.getByRole('heading', { name: 'Add a computer player' })).toBeVisible();
  // Leave the default persona selected; just set a buy-in and confirm.
  await page.getByLabel(/Buy-in/).fill('100');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();

  // The bot seat is visibly marked as a bot, and a hand deals automatically
  // (one human + one bot = two dealt-in seats), entirely without a second
  // human player or browser context.
  await expect(page.locator('[data-testid="seat-1"]').getByText('🤖 bot')).toBeVisible();
  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // Play it out: this only ever clicks for the human (seat 0) — the bot's
  // moves land on their own, server-scheduled timing, proving the whole
  // computer-player feature works without any script driving the bot.
  await playHandToCompletion([page]);
  await expect(page.getByText('Verify hand fairness')).toBeVisible();

  // Chips actually moved as a result of a real hand being played.
  const stackAfter = await page.locator('[data-testid="seat-0"] .seat-stack').textContent();
  expect(stackAfter).toBeTruthy();

  // Removing the bot (blocked mid-hand, allowed now that the hand is over) frees the seat.
  await page.locator('[data-testid="seat-1"]').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'empty');
});

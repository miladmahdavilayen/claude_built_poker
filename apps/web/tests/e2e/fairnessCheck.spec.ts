import { expect, test } from '@playwright/test';
import { addBot, adminLogin, createTable, playHandToCompletion, startHand, takeSeat } from './helpers.js';

// The fairness check in plain words (components/FairnessCheck.tsx), with the
// deal re-checked in the player's own browser (fairness.ts) — not just the
// server's say-so.

test('after a hand, Verify hand fairness explains the check in plain words, and the browser itself checks the deal was the sealed one', async ({ page }) => {
  test.setTimeout(90_000);
  await adminLogin(page);
  await createTable(page, { name: 'Fairness Check', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await addBot(page, 1, 'calling-station', 200);
  await takeSeat(page, 0, 200);
  await startHand(page);

  await expect(page.getByTestId('fairness-commitment')).toContainText('Fairness commitment', { timeout: 10_000 });
  const dialog = page.getByRole('dialog', { name: 'Hand fairness' });

  await playHandToCompletion([page]);
  await page.getByRole('button', { name: /Verify hand fairness/ }).click();
  await expect(dialog).toContainText('This hand was dealt fairly', { timeout: 15_000 });
  await expect(dialog.locator('.fairness-step--done')).toHaveCount(3);
  await expect(dialog).toContainText('✅ The secret’s fingerprint matches the fairness commitment');
  await expect(dialog).toContainText('✅ Shuffling with the secret and the players’ seeds gives exactly the deck that was dealt');
  // The rebuilt deck is shown, and the raw numbers are there for anyone who wants them.
  expect(await dialog.locator('.fairness-card').count()).toBeGreaterThanOrEqual(12);
  await dialog.getByText('Check it yourself (the numbers)').click();
  await expect(dialog.getByText('Server seed (revealed)')).toBeVisible();
});

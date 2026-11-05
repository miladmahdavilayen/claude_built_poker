import { expect, test } from '@playwright/test';
import { adminLogin, createTable, googlePlayerLogin, startHand, tableMenuAction, takeSeat } from './helpers.js';

// A registered player invited to a table is treated exactly like a guest: the seat and the money are what the owner
// chose, and their account's reward balance is neither used nor added to.
test('a signed-in player opening a seat invite: the exact seat, the exact money, and their balance untouched', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  const player = await (await browser.newContext()).newPage();
  await owner.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await createTable(owner, { name: 'Friends Only', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: true });
  await takeSeat(owner, 0, 200);
  await googlePlayerLogin(player, `e2e.invited.${String(Date.now())}@gmail.com`, 'Polly');
  await expect(player.getByTestId('lobby-balance')).toHaveText('$1,000');

  await owner.locator('[data-testid="seat-3"] .seat-empty-tap').click();
  await owner.getByRole('menuitem', { name: 'Invite a player to this seat' }).click();
  await owner.getByLabel(/Buy-in/).fill('150');
  await owner.getByRole('button', { name: 'Generate link' }).click();
  const link = await owner.locator('.assign-link-input').inputValue();
  await owner.getByRole('button', { name: 'Done' }).click();

  await player.goto(link);
  const seat = player.locator('[data-testid="seat-3"]');
  await expect(seat).toHaveAttribute('data-seat-status', 'active', { timeout: 20_000 });
  await expect(seat).toContainText('Polly');
  await expect(seat.locator('.seat-stack')).toHaveText('$150');
  await expect(owner.locator('[data-testid="seat-3"] .seat-stack')).toHaveText('$150');

  // A hand: the result stays at the table.
  await startHand(owner);
  let folded = false;
  for (let i = 0; i < 100 && !folded; i++) {
    for (const p of [owner, player]) {
      const fold = p.getByRole('button', { name: 'Fold' });
      if (await fold.isVisible().catch(() => false)) {
        await fold.click();
        folded = true;
        break;
      }
    }
    if (!folded) await owner.waitForTimeout(100);
  }
  await expect(player.getByText('Verify hand fairness')).toBeVisible({ timeout: 10_000 });
  const stack = (await seat.locator('.seat-stack').textContent())!;
  expect(stack).not.toBe('$150');

  // Leaving says so, and the lobby's balance is what it was.
  await tableMenuAction(player, 'Leave table');
  await expect(player.locator('.modal')).toContainText('don’t go to your account’s balance');
  await player.locator('.modal').getByRole('button', { name: 'Yes, leave' }).click();
  await expect(player.getByTestId('lobby-balance')).toHaveText('$1,000', { timeout: 10_000 });

  // Back by the same link: the same seat, with what they left with.
  await player.goto(link);
  await expect(seat).toHaveAttribute('data-seat-status', /active|sitting-out/, { timeout: 20_000 });
  await expect(seat.locator('.seat-stack')).toHaveText(stack);
});

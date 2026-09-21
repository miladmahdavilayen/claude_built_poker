import { expect, test } from '@playwright/test';
import { createTable, guestSignup, takeSeat } from './helpers.js';

// Regression test for the chip-visual system: SB/BB (and any other
// current-street bet) should render as an actual chip-stack graphic on
// the felt in front of the associated seat, not just plain text buried
// inside the seat's own info panel (see DECISIONS.md).
test('SB and BB post real chip visuals in front of the correct seats, and the pot shows a chip icon once it grows', async ({ page }) => {
  await guestSignup(page, 'Solo');
  await createTable(page, { name: 'Chip Visuals Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);
  await page.locator('[data-testid="seat-1"]').getByText('+ Add bot').click();
  await page.getByLabel(/Buy-in/).fill('200');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();

  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // Heads-up: the button posts the small blind (1), the other seat posts
  // the big blind (2) — but WHICH seat is button is now a genuine
  // high-card draw (see DECISIONS.md), so this can't assume seat 0 is
  // always SB. Both bet-chip slots must be visible and showing the right
  // amounts for whichever seat actually is SB vs BB.
  const chips0 = page.locator('[data-testid="bet-chips-0"]');
  const chips1 = page.locator('[data-testid="bet-chips-1"]');
  await expect(chips0).toBeVisible();
  await expect(chips1).toBeVisible();
  const amounts = await Promise.all([
    chips0.locator('.chip-stack-amount').textContent(),
    chips1.locator('.chip-stack-amount').textContent(),
  ]);
  expect(amounts.sort()).toEqual(['1', '2']);
  const sbChips = (await chips0.locator('.chip-stack-amount').textContent()) === '1' ? chips0 : chips1;
  await expect(sbChips.locator('.chip-disc')).toHaveCount(1); // 1 chip: the $1 white denomination

  // The pot itself gets a chip icon once there's anything in it (no numeric label duplicated on the icon — the "Pot: N" text carries that).
  await expect(page.locator('.pot-display .chip-disc').first()).toBeVisible();
});

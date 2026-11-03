import { expect, test } from '@playwright/test';
import { adminLogin, closeTableMenu, createTable, guestSignup, inviteToSeat, openTableMenu, takeSeat } from './helpers.js';

// The 3D table's designs (tableDesigns.ts): the owner picks one from the picker (Table and dealer, in the menu) and
// everyone at the table sees it; a guest has no picker. Each design builds a new scene without a hitch.
const DESIGNS = ['classic', 'vip', 'emerald', 'midnight', 'onyx', 'imperial', 'saloon'] as const;

test('the owner picks any of the seven table designs; the whole table sees it; a guest cannot pick', async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  for (const page of [owner, guest]) {
    await page.addInitScript(() => {
      localStorage.setItem('pokerclause.tableQuality', 'low');
      localStorage.setItem('pokerclause.tableView', 'seated');
    });
  }
  await adminLogin(owner);
  await createTable(owner, { name: 'Designs', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 200);
  await guestSignup(guest, 'Dana');
  await inviteToSeat(owner, guest, 3, 200);
  // A new table's dealer is a VIP character, so it starts as the VIP table (see dealers.ts's tableTheme).
  await expect(owner.getByTestId('table-3d')).toHaveAttribute('data-theme', 'vip', { timeout: 20_000 });
  await expect(guest.getByTestId('table-3d')).toHaveAttribute('data-theme', 'vip', { timeout: 20_000 });

  // The guest's menu has no picker.
  await expect((await openTableMenu(guest)).getByRole('button', { name: 'Table and dealer' })).toHaveCount(0);
  await closeTableMenu(guest);

  for (const id of DESIGNS.filter((d) => d !== 'vip')) {
    await (await openTableMenu(owner)).getByRole('button', { name: 'Table and dealer' }).click();
    const picker = owner.getByRole('dialog', { name: 'Choose the house dealer' });
    await expect(picker.getByRole('radio')).toHaveCount(DESIGNS.length);
    await owner.waitForTimeout(500);
    await picker.getByTestId(`table-design-${id}`).click();
    await expect(picker.getByTestId(`table-design-${id}`)).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    await picker.getByRole('button', { name: 'Close' }).click();
    // A new scene for the design, for both of them.
    await expect(owner.getByTestId('table-3d')).toHaveAttribute('data-theme', id, { timeout: 10_000 });
    await expect(guest.getByTestId('table-3d')).toHaveAttribute('data-theme', id, { timeout: 10_000 });
    await expect(owner.locator('.table3d-canvas')).toBeVisible();
    await expect(owner.getByTestId('table-3d')).toHaveAttribute('data-mode', 'seated');
  }
});

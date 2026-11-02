import { expect, test } from '@playwright/test';
import { addBot, adminLogin, closeTableMenu, createTable, guestSignup, inviteToSeat, openTableMenu, startHand, takeSeat } from './helpers.js';

const savedView = (page: import('@playwright/test').Page): Promise<string | null> => page.evaluate(() => localStorage.getItem('pokerclause.tableView'));

// An invited player starts in the view the owner was using when they made the invite — 2D or 3D — and can change it
// from the menu afterwards; their own choice sticks from then on.
test("an invited player starts in the owner's view, and can change it after", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await owner.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await createTable(owner, { name: 'View Invite', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 100);
  await guestSignup(guest, 'Vera');
  // The guest's own browser would show 3D.
  await guest.evaluate(() => localStorage.setItem('pokerclause.tableView', 'standing'));

  await inviteToSeat(owner, guest, 1, 100);
  // Arrived in the owner's 2D view, the link's `view=` gone from the address.
  expect(await savedView(guest)).toBe('2d');
  await expect(guest.getByTestId('table-3d')).toHaveCount(0);
  await expect.poll(() => new URL(guest.url()).searchParams.get('view')).toBeNull();

  // Their choice from the menu wins from now on — a refresh keeps it.
  await (await openTableMenu(guest)).getByLabel(/3D — Seated/).check();
  await closeTableMenu(guest);
  expect(await savedView(guest)).toBe('seated');
  await guest.reload();
  await expect.poll(() => savedView(guest)).toBe('seated');
});

// Four or more playing on the 2D table: the 3D table is recommended, with a way straight there.
test('a game of 4+ on the 2D table recommends the 3D table', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('pokerclause.tableView', '2d');
      localStorage.setItem('pokerclause.tableQuality', 'low');
      sessionStorage.setItem('seeded', '1');
    }
  });
  await adminLogin(page);
  await createTable(page, { name: 'Suggest 3D', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 100);
  await addBot(page, 1, 'calling-station', 100);
  await addBot(page, 2, 'calling-station', 100);
  await startHand(page);
  // Three players: no notice.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('suggest-3d')).toHaveCount(0);
  await addBot(page, 3, 'calling-station', 100);
  const hint = page.getByTestId('suggest-3d');
  await expect(hint).toBeVisible({ timeout: 10_000 });
  await expect(hint).toContainText('4 players');
  await hint.getByRole('button', { name: 'Switch to 3D' }).click();
  expect(await savedView(page)).toBe('seated');
  await expect(hint).toHaveCount(0);
});

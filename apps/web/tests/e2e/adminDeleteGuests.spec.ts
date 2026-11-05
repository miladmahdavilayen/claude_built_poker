import { expect, test, type Page } from '@playwright/test';
import { adminLogin, createTable, openAdminSection, seedRealAccount, tableMenuAction, takeSeat } from './helpers.js';

/** A guest comes in by a real seat invite, agreeing to the terms; `stay` leaves them seated. */
async function inviteGuest(owner: Page, guest: Page, seatId: number, name: string, stay = false): Promise<void> {
  await owner.locator(`[data-testid="seat-${String(seatId)}"] .seat-empty-tap`).click();
  await owner.getByRole('menuitem', { name: 'Invite a player to this seat' }).click();
  await owner.getByLabel(/Buy-in/).fill('100');
  await owner.getByRole('button', { name: 'Generate link' }).click();
  const link = await owner.locator('.assign-link-input').inputValue();
  await owner.getByRole('button', { name: 'Done' }).click();
  await guest.goto(link);
  await guest.getByLabel('Display name').fill(name);
  await guest.getByLabel('I’ve read and agree to the guest terms').check();
  await guest.getByRole('button', { name: 'Play now' }).click();
  await expect(guest.locator(`[data-testid="seat-${String(seatId)}"]`)).toHaveAttribute('data-seat-status', 'active', { timeout: 15_000 });
  if (stay) return;
  await tableMenuAction(guest, 'Leave table');
  await guest.locator('.modal').getByRole('button', { name: 'Yes, leave' }).click();
  await expect(guest).toHaveURL(/\/left/, { timeout: 10_000 });
}

// The owner deletes any player but themselves: a few ticked, Select all, or one from their page. A guest goes to
// Deleted users with their agreement; anyone seated at a table stays, and the owner is told why.
test('the owner deletes guests and registered players: one, a few, or all; seated ones stay', async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await (await browser.newContext()).newPage();
  await owner.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await createTable(owner, { name: 'Delete Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 200);
  const tag = String(Date.now()).slice(-6);
  const name = (n: string): string => `${n}${tag}`;
  for (const [i, n] of ['Una', 'Dos', 'Tre'].entries()) await inviteGuest(owner, await (await browser.newContext()).newPage(), i + 1, name(n));
  const seated = await (await browser.newContext()).newPage();
  await inviteGuest(owner, seated, 4, name('Sit'), true);
  const table = owner.url();
  await seedRealAccount(owner, name('Reg'));

  await owner.goto('/admin');
  await owner.getByPlaceholder('Search by name or email...').fill(tag);
  const row = (n: string) => owner.locator('.admin-user-row', { hasText: name(n) });
  await expect(row('Una')).toContainText('Guest · invited');

  // One, from their page: asks first.
  await row('Una').click();
  const detail = owner.getByTestId('guest-detail');
  await detail.getByRole('button', { name: 'Delete this guest' }).click();
  await detail.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(row('Una')).toHaveCount(0);
  await expect(detail).toHaveCount(0);

  // A few, ticked: opening nobody on the way.
  await owner.getByLabel(`Select ${name('Dos')}`).check();
  await expect(detail).toHaveCount(0);
  await owner.getByRole('button', { name: 'Delete 1 selected' }).click();
  await expect(row('Dos')).toHaveCount(0);
  await expect(row('Tre')).toBeVisible();

  // Select all takes in guests and registered alike; the one at a table stays, ticked, and the owner is told.
  await owner.getByLabel('Select all').check();
  await owner.getByRole('button', { name: 'Delete 3 selected' }).click();
  await expect(row('Tre')).toHaveCount(0);
  await expect(row('Reg')).toHaveCount(0);
  await expect(row('Sit')).toBeVisible();
  await expect(owner.getByText('1 player is seated at a table')).toBeVisible();
  await expect(owner.getByLabel(`Select ${name('Sit')}`)).toBeChecked();

  // Filed under Deleted users, marked as a guest, their agreement with them.
  await openAdminSection(owner, 'Deleted users');
  const gone = owner.locator('.admin-deleted-row', { hasText: name('Una') });
  await expect(gone).toContainText('Guest');
  await gone.click();
  const agreement = owner.getByTestId('deleted-guest-agreement');
  await expect(agreement).toContainText('Agreed');
  await expect(agreement).toContainText('IP address');

  // And the game went on undisturbed.
  await owner.goto(table);
  await expect(owner.locator('[data-testid="seat-4"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 15_000 });
});

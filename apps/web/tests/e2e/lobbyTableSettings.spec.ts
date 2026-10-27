import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, tableIdFromUrl, takeSeat, openTableMenu } from './helpers.js';

// The owner changes a table's settings from the lobby by holding its card
// (or right-clicking it) — public or private — and everyone at the table
// sees the change. See components/TableSettingsModal.tsx.

async function hold(page: Page, target: Locator): Promise<void> {
  // Other tests' tables fill the lobby too: this one may be below the fold.
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
}

const card = (page: Page, tableId: string): Locator => page.getByTestId(`lobby-table-${tableId}`);

test('the owner holds a lobby table to edit its settings, and the table follows', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const owner = await ctxA.newPage();
  const bob = await ctxB.newPage();
  await adminLogin(owner);
  await createTable(owner, { name: 'Lobby Edit Public', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const id = tableIdFromUrl(owner.url());
  await takeSeat(owner, 0, 200);
  await guestSignup(bob, 'Bob');
  await inviteToSeat(owner, bob, 1, 200);
  await owner.goto('/lobby');

  // Hold the public table's card.
  await hold(owner, card(owner, id));
  const dialog = owner.getByRole('dialog', { name: 'Table settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Table name')).toHaveValue('Lobby Edit Public');
  // A public table has no invite link to share.
  await expect(dialog.getByLabel('Table invite link')).toHaveCount(0);
  await dialog.getByLabel('Table name').fill('Lobby Edited');
  await dialog.getByLabel('Small blind ($)').fill('5');
  await dialog.getByLabel('Big blind ($)').fill('10');
  await dialog.getByLabel('Seconds per action').fill('45');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  // The lobby card and the table itself both show it.
  await expect(card(owner, id)).toContainText('Lobby Edited');
  await expect(card(owner, id)).toContainText('$5/$10');
  await expect((await openTableMenu(bob)).locator('.table-menu-title')).toContainText('Lobby Edited', { timeout: 10_000 });

  // Rules still apply: the small blind can't exceed the big blind.
  await hold(owner, card(owner, id));
  await dialog.getByLabel('Small blind ($)').fill('50');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.locator('.error-banner')).toContainText('small blind cannot be bigger');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await ctxA.close();
  await ctxB.close();
});

test('private and open-invite tables are editable from the lobby too — by right-click on a desktop', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await adminLogin(page);
  const privLink = await createTable(page, { name: 'Lobby Edit Private', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: true });
  const privId = tableIdFromUrl(page.url());
  await page.goto('/lobby');
  const openLink = await createTable(page, { name: 'Lobby Edit Open', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false, openSeating: true, openSeatStack: 500 });
  const openId = tableIdFromUrl(page.url());
  await page.goto('/lobby');

  const priv = card(page, privId);
  await expect(page.getByTestId('lobby-private-tables').locator(priv)).toBeVisible();
  await priv.click({ button: 'right' });
  const dialog = page.getByRole('dialog', { name: 'Table settings' });
  await expect(dialog.getByLabel(/Private table/)).toBeChecked();
  // Its live invite link, ready to copy and share.
  // The same link the table was created with.
  await expect(dialog.getByLabel('Table invite link')).toHaveValue(privLink!);
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied ✓' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(privLink);
  await dialog.getByLabel('Max buy-in ($)').fill('900');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(priv).toContainText('$80–$900');

  // An open-invite table: its starting chips are editable, and it can't be made public.
  await card(page, openId).click({ button: 'right' });
  await expect(dialog.getByLabel('Starting chips for each player ($)')).toHaveValue('500');
  await expect(dialog.getByLabel(/Private table/)).toHaveCount(0);
  await expect(dialog.getByText(/Open invite link/)).toBeVisible();
  await expect(dialog.getByLabel('Table invite link')).toHaveValue(openLink!);
  await dialog.getByLabel('Starting chips for each player ($)').fill('750');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await card(page, openId).click({ button: 'right' });
  await expect(dialog.getByLabel('Starting chips for each player ($)')).toHaveValue('750');
});

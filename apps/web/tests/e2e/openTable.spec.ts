import { expect, test, type Browser, type Page } from '@playwright/test';
import { adminLogin, createTable, tableMenuAction, closeTableMenu } from './helpers.js';

/** Opens the shared link as a brand-new visitor: the guest form, a name, and in. */
async function arriveByLink(browser: Browser, link: string, name: string): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['notifications'] });
  const page = await ctx.newPage();
  await page.goto(link);
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('I’ve read and agree to the guest terms').check();
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(page.locator('[data-testid="seat-0"]')).toBeVisible();
  return page;
}

/** A guest by the open link doesn't pick a buy-in: they sit with the table's starting chips (or what they left with). */
async function sitAt(page: Page, seatId: number): Promise<void> {
  await page.locator(`[data-testid="seat-${String(seatId)}"]`).getByText('Sit here').click();
  await expect(page.getByTestId('open-seat-stack')).toBeVisible();
  await expect(page.getByLabel(/Buy-in/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sit down' }).click();
  await expect(page.locator(`[data-testid="seat-${String(seatId)}"]`)).toHaveAttribute('data-seat-status', /active|sitting-out/);
}

test('an open-invite table: one link for everyone — pick a seat, a waitlist when full, and the first in line is alerted and gets the next seat', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  const link = (await createTable(owner, { name: 'Group Chat Game', smallBlind: 1, bigBlind: 2, maxSeats: 2, isPrivate: false, openSeating: true }))!;
  expect(link).toMatch(/\/table\/[^?]+\?code=[A-Za-z0-9_-]{16}$/);

  // Two people from the group chat take the two seats themselves.
  const ann = await arriveByLink(browser, link, 'Ann');
  await expect(ann.getByText('Pick any empty seat to sit down.')).toBeVisible();
  await sitAt(ann, 0);
  const ben = await arriveByLink(browser, link, 'Ben');
  await sitAt(ben, 1);

  // Full: the next two join the waitlist instead.
  const cat = await arriveByLink(browser, link, 'Cat');
  await expect(cat.locator('[data-testid="seat-0"]').getByText('Sit here')).toHaveCount(0);
  await tableMenuAction(cat, 'Join waitlist');
  await expect(cat.getByRole('button', { name: 'Leave waitlist (#1)' })).toBeVisible();
  const dan = await arriveByLink(browser, link, 'Dan');
  await tableMenuAction(dan, 'Join waitlist');
  await expect(dan.getByRole('button', { name: 'Leave waitlist (#2)' })).toBeVisible();

  // Ann leaves: the seat is held for Cat, who's alerted; Dan can see why he can't take it.
  await tableMenuAction(ann, 'Leave table');
  await ann.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(cat.getByText('A seat is open for you!')).toBeVisible();
  await expect.poll(() => cat.title()).toContain('Your seat is open');
  await expect(dan.getByText('A seat is being held for')).toContainText('Cat');
  await expect(dan.locator('[data-testid="seat-0"]').getByText('Sit here')).toHaveCount(0);

  await closeTableMenu(cat);
  await sitAt(cat, 0);
  await expect(cat.getByText('A seat is open for you!')).toHaveCount(0);
  await expect(dan.getByRole('button', { name: 'Leave waitlist (#1)' })).toBeVisible();

  // A wrong code gets nowhere.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(link.replace(/code=.*/, 'code=AAAAAAAAAAAAAAAA'));
  await stranger.getByLabel('Display name').fill('Mallory');
  await stranger.getByLabel('I’ve read and agree to the guest terms').check();
  await stranger.getByRole('button', { name: 'Play now' }).click();
  await expect(stranger.getByText(/invalid or has already been used/)).toBeVisible();
});

test('the owner double-taps a player’s seat (holds an empty one) or right-clicks for its menu — in full screen too — and removes a player from it', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  const link = (await createTable(owner, { name: 'Menu Game', smallBlind: 1, bigBlind: 2, maxSeats: 3, isPrivate: false, openSeating: true }))!;
  const tableUrl = owner.url();
  const ann = await arriveByLink(browser, link, 'Ann');
  await sitAt(ann, 1);

  await owner.goto(tableUrl);
  const seat = owner.locator('[data-testid="seat-1"]');
  await expect(seat).toContainText('Ann');

  // Right-click: the occupied seat's options only.
  await seat.click({ button: 'right' });
  const menu = owner.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Rebuy (add chips)', 'Remove player', 'Delete seat']);
  await owner.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // A single tap on a player's seat does nothing; a double tap opens the same menu.
  await seat.click();
  await owner.waitForTimeout(500);
  await expect(menu).toHaveCount(0);
  await seat.dblclick();
  await expect(menu.getByRole('menuitem')).toHaveText(['Rebuy (add chips)', 'Remove player', 'Delete seat']);
  await owner.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Holding for a second on an empty seat: its own options.
  const empty = owner.locator('[data-testid="seat-2"]');
  const box = (await empty.boundingBox())!;
  await owner.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await owner.mouse.down();
  await owner.waitForTimeout(400);
  await expect(menu).toHaveCount(0); // not yet — it takes a full second
  await owner.waitForTimeout(800);
  await owner.mouse.up();
  await expect(menu.getByRole('menuitem')).toHaveText(['Sit here', 'Add a computer player', 'Invite a player to this seat', 'Delete seat']);
  await owner.keyboard.press('Escape');

  // Remove Ann — it asks for a second tap first.
  await seat.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Remove player' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Tap again to remove player' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Tap again to remove player' }).click();
  await expect(seat).toHaveAttribute('data-seat-status', 'empty');
});

test('chat and the hand log are behind the chat button: new chat shows a badge on it; the sheet has both, and closes', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  const link = (await createTable(owner, { name: 'Dock Game', smallBlind: 1, bigBlind: 2, maxSeats: 3, isPrivate: false, openSeating: true }))!;
  const tableUrl = owner.url();
  await owner.goto(tableUrl);
  await expect(owner.getByPlaceholder('Say something...')).toHaveCount(0);

  const ann = await arriveByLink(browser, link, 'Ann');
  await ann.getByRole('button', { name: 'Chat', exact: true }).click();
  await ann.getByPlaceholder('Say something...').fill('gl everyone');
  await ann.keyboard.press('Enter');

  await expect(owner.locator('.table-chat-badge')).toHaveText('1');
  await owner.getByRole('button', { name: 'Chat, 1 new' }).click();
  const sheet = owner.getByRole('dialog', { name: 'Chat and hand log' });
  await expect(sheet.getByText('gl everyone')).toBeVisible();
  await expect(owner.locator('.table-chat-badge')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Hand log', exact: true }).click();
  await expect(owner.getByPlaceholder('Say something...')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close chat' }).click();
  await expect(sheet).toHaveCount(0);
  // The hand log is in the table menu too.
  await tableMenuAction(owner, 'Hand log');
  await expect(sheet.getByRole('button', { name: 'Hand log', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('an open-invite table’s starting chips: everyone who joins by the link sits with them — and a guest who leaves comes back with what they had', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  const link = (await createTable(owner, { name: 'Five Hundred Game', smallBlind: 1, bigBlind: 2, maxSeats: 9, isPrivate: false, openSeating: true, openSeatStack: 500 }))!;
  const tableUrl = owner.url();

  const gil = await arriveByLink(browser, link, 'Gil');
  await gil.locator('[data-testid="seat-3"]').getByText('Sit here').click();
  await expect(gil.getByTestId('open-seat-stack')).toContainText('$500');
  await gil.getByRole('button', { name: 'Sit down' }).click();
  await expect(gil.locator('[data-testid="seat-3"] .seat-stack')).toHaveText('$500');

  // The owner tops Gil up from the seat's menu: $550.
  await owner.goto(tableUrl);
  await owner.locator('[data-testid="seat-3"]').click({ button: 'right' });
  await owner.getByRole('menuitem', { name: 'Rebuy (add chips)' }).click();
  await owner.getByLabel('Amount').fill('50');
  await owner.locator('.modal').getByRole('button', { name: 'Confirm' }).click();
  await expect(gil.locator('[data-testid="seat-3"] .seat-stack')).toHaveText('$550', { timeout: 10_000 });

  // Gil leaves — the table stays — and comes back with his $550, not a fresh $500.
  await tableMenuAction(gil, 'Leave table');
  await gil.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(gil).toHaveURL(/\/left/);
  await gil.getByRole('button', { name: 'Rejoin table' }).click();
  await gil.locator('[data-testid="seat-5"]').getByText('Sit here').click();
  await gil.getByRole('button', { name: 'Sit down' }).click();
  await expect(gil.locator('[data-testid="seat-5"] .seat-stack')).toHaveText('$550');
  await expect(owner.locator('[data-testid="seat-5"]')).toContainText('Gil');
});

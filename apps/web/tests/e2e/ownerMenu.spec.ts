import { expect, test, type Page } from '@playwright/test';
import { adminLogin, closeTableMenu, createTable, guestSignup, inviteToSeat, openOwnerMenu, openTableMenu, playHandToCompletion, startHand, takeSeat } from './helpers.js';

// The owner's table-controls drawer (OwnerMenu.tsx): every change works
// mid-hand. Whatever can't safely change under a hand in progress waits
// for it to end — these tests check both halves of that, from the other
// players' side too, not just the owner's.

async function ownerAndAliceMidHand(browser: import('@playwright/test').Browser, tableName: string): Promise<{ owner: Page; alice: Page }> {
  const owner = await (await browser.newContext()).newPage();
  const alice = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  await createTable(owner, { name: tableName, smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 100);
  await guestSignup(alice, 'Alice');
  await inviteToSeat(owner, alice, 1, 100);
  await startHand(owner);
  await expect(owner.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });
  return { owner, alice };
}

async function betAmounts(page: Page): Promise<string[]> {
  const texts = await page.locator('.bet-chips-slot .chip-stack-amount').allTextContents();
  return texts.sort();
}

test('a blind change mid-hand is announced to everyone and only applies from the next hand — down to $0.10/$0.20', async ({ browser }) => {
  const { owner, alice } = await ownerAndAliceMidHand(browser, 'Blinds Mid Hand');
  expect(await betAmounts(owner)).toEqual(['$1', '$2']);

  await openOwnerMenu(owner);
  await owner.getByLabel('Small blind ($)').fill('0.10');
  await owner.getByLabel('Big blind ($)').fill('0.20');
  await owner.getByRole('button', { name: 'Save changes' }).click();
  await expect(owner.getByText('Saved — blinds/ante/straddle switch over when this hand ends.')).toBeVisible();
  await owner.getByRole('button', { name: 'Close table controls' }).click();

  // Everyone is told, and the hand in progress keeps its $1/$2.
  await expect(alice.locator('.pending-settings-banner')).toHaveText('Next hand: blinds go to $0.10/$0.20');
  expect(await betAmounts(owner)).toEqual(['$1', '$2']);

  await playHandToCompletion([owner, alice]);
  await expect(alice.locator('.pending-settings-banner')).toHaveCount(0);

  await startHand(owner);
  await expect.poll(() => betAmounts(alice), { timeout: 10_000 }).toEqual(['$0.10', '$0.20']);
});

test('removing a player mid-hand: they are marked as leaving, folded on their turn, and gone with their chips once the hand ends', async ({ browser }) => {
  const { owner, alice } = await ownerAndAliceMidHand(browser, 'Remove Mid Hand');
  // Remove her while it's the OWNER's turn: removed on her own turn, she's folded 400ms later, the hand
  // ends and her seat empties — before a slow machine gets to look for the "leaving" tag.
  const ownerTurn = owner.getByRole('button', { name: /^(Check|Call)/ });
  const aliceCall = alice.getByRole('button', { name: /^Call/ });
  await expect.poll(async () => (await ownerTurn.isVisible()) || (await aliceCall.isVisible()), { timeout: 10_000 }).toBe(true);
  if (await aliceCall.isVisible()) await aliceCall.click();
  await expect(ownerTurn).toBeVisible();

  await openOwnerMenu(owner);
  const aliceRow = owner.getByTestId('owner-seat-1');
  await aliceRow.getByRole('button', { name: 'Remove player' }).click();
  await expect(aliceRow).toContainText('Remove this player after this hand?');
  await aliceRow.getByRole('button', { name: 'Yes' }).click();
  await expect(aliceRow).toContainText('leaving after this hand');
  await owner.getByRole('button', { name: 'Close table controls' }).click();

  await expect(alice.locator('[data-testid="seat-1"] .seat-tag-leaving')).toBeVisible();
  // Heads-up: whichever of them acts, the hand ends — Alice is folded automatically on her turn.
  await playHandToCompletion([owner]);
  await expect(alice.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'empty', { timeout: 10_000 });
  await expect(owner.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'empty');
});

test('chips added mid-hand show as pending and land on the stack when the hand ends', async ({ browser }) => {
  const { owner, alice } = await ownerAndAliceMidHand(browser, 'Rebuy Mid Hand');

  await openOwnerMenu(owner);
  const aliceRow = owner.getByTestId('owner-seat-1');
  await aliceRow.getByRole('button', { name: 'Add chips' }).click();
  await aliceRow.getByLabel('Add ($)').fill('50');
  await aliceRow.getByRole('button', { name: 'Add chips' }).click();
  await expect(aliceRow).toContainText('+$50 after this hand');
  await owner.getByRole('button', { name: 'Close table controls' }).click();
  await expect(alice.locator('[data-testid="seat-1"] .seat-tag-pending')).toHaveText('+$50');

  const stackText = async (): Promise<number> => Number(((await alice.locator('[data-testid="seat-1"] .seat-stack').textContent()) ?? '').replace(/[$,]/g, ''));
  await playHandToCompletion([owner, alice]);
  await expect(alice.locator('[data-testid="seat-1"] .seat-tag-pending')).toHaveCount(0);
  // Whatever the hand did to her stack, the table's chips grew by exactly the $50. (Polled: a winner's stack
  // counts up to its new total for a moment after the hand — Seat.tsx's count-up.)
  const ownerStackText = async (): Promise<number> => Number(((await owner.locator('[data-testid="seat-0"] .seat-stack').textContent()) ?? '').replace(/[$,]/g, ''));
  await expect.poll(async () => (await ownerStackText()) + (await stackText()), { timeout: 5000 }).toBe(250);
});

test('deleting a seat mid-hand removes it for everyone; adding a seat brings it back', async ({ browser }) => {
  const { owner, alice } = await ownerAndAliceMidHand(browser, 'Seats Mid Hand');
  await expect(alice.locator('.seat-slot')).toHaveCount(6);
  // Let the hand's own deal animation finish first, so the check below sees only a replay.
  await expect(alice.locator('.flying-card, .shuffle-deck')).toHaveCount(0, { timeout: 10_000 });

  await openOwnerMenu(owner);
  const row = owner.getByTestId('owner-seat-5');
  await row.getByRole('button', { name: 'Delete seat' }).click();
  await row.getByRole('button', { name: 'Yes' }).click();
  await expect(owner.getByTestId('owner-seat-5')).toHaveCount(0);
  await expect(alice.locator('.seat-slot')).toHaveCount(5);
  await expect(alice.locator('[data-testid="seat-5"]')).toHaveCount(0);
  // The layout changing must not replay the hand's shuffle/deal animation
  // (regression). Checked once, right away — a retrying assertion would
  // just wait out a replay that did happen.
  await alice.waitForTimeout(150);
  expect(await alice.locator('.flying-card, .shuffle-deck').count()).toBe(0);

  await owner.getByRole('button', { name: '+ Add seat' }).click();
  await expect(alice.locator('.seat-slot')).toHaveCount(6);
  await expect(alice.locator('[data-testid="seat-5"]')).toHaveAttribute('data-seat-status', 'empty');
});

test('a $0.10/$0.20 table with a $10 buy-in can be created and played from the lobby', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('button', { name: 'Create table' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Dime Game');
  await page.getByLabel('Small blind').fill('0.10');
  await page.getByLabel('Big blind').fill('0.20');
  await expect(page.getByLabel('Min buy-in ($)')).toHaveValue('8');
  await expect(page.getByLabel('Max buy-in ($)')).toHaveValue('20');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Go to table' }).click();

  await takeSeat(page, 0, 10);
  await expect(page.locator('[data-testid="seat-0"] .seat-stack')).toHaveText('$10');
  await page.locator('[data-testid="seat-1"]').locator('.seat-empty-tap').click();
  await page.getByRole('menuitem', { name: 'Add a computer player' }).click();
  await page.getByLabel(/Buy-in/).fill('12.50');
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();
  await expect(page.locator('[data-testid="seat-1"] .seat-stack')).toHaveText('$12.50');

  await startHand(page);
  await expect.poll(() => betAmounts(page), { timeout: 10_000 }).toEqual(['$0.10', '$0.20']);
});

test('the table always fills the screen: one menu button top-right, the chat bottom-left with the dealer’s mute above it, nothing else around the felt', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'Full Screen Always', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await expect(page.locator('.table-page')).toHaveClass(/immersive/);
  await expect(page.getByRole('button', { name: /Full screen/ })).toHaveCount(0);
  const felt = (await page.locator('.felt').boundingBox())!;
  const view = page.viewportSize()!;
  // The felt takes the page: no header above it, no panels below.
  expect(felt.y).toBeLessThan(20);
  expect(felt.y + felt.height).toBeGreaterThan(view.height - 20);
  const menuBtn = (await page.getByRole('button', { name: 'Menu', exact: true }).boundingBox())!;
  expect(menuBtn.x + menuBtn.width).toBeGreaterThan(view.width - 30);
  expect(menuBtn.y).toBeLessThan(30);
  expect(menuBtn.width).toBeGreaterThanOrEqual(40);
  const chat = (await page.getByRole('button', { name: 'Chat', exact: true }).boundingBox())!;
  expect(chat.x).toBeLessThan(felt.x + 40);
  expect(chat.y + chat.height).toBeGreaterThan(felt.y + felt.height - 40);
  // The dealer's mute sits right above the chat.
  const mute = (await page.getByRole('button', { name: /the dealer$/ }).boundingBox())!;
  expect(mute.y + mute.height).toBeLessThanOrEqual(chat.y);
  expect(chat.y - (mute.y + mute.height)).toBeLessThan(16);
});

test('a regular player has no table controls and no owner-only seat buttons', async ({ browser }) => {
  const { owner, alice } = await ownerAndAliceMidHand(browser, 'No Menu For Players');
  await owner.locator('[data-testid="seat-2"]').locator('.seat-empty-tap').click();
  await owner.getByRole('menuitem', { name: 'Add a computer player' }).click();
  await owner.getByLabel(/Buy-in/).fill('100');
  await owner.locator('.modal').getByRole('button', { name: 'Add bot' }).click();
  await expect(alice.locator('[data-testid="seat-2"] .seat-tag-pending')).toHaveText('next hand');

  // Everyone has the table menu; only the owner's has their table controls.
  await expect((await openTableMenu(owner)).getByRole('button', { name: 'Table controls' })).toBeVisible();
  await closeTableMenu(owner);
  await expect(owner.locator('[data-testid="seat-2"]').getByRole('button', { name: 'Remove' })).toBeVisible();
  await expect((await openTableMenu(alice)).getByRole('button', { name: 'Table controls' })).toHaveCount(0);
  await closeTableMenu(alice);
  await expect(alice.locator('[data-testid="seat-2"]').getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

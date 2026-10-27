import { expect, test } from '@playwright/test';
import { addBot, adminLogin, chooseSeatOption, createTable, guestSignup, inviteToSeat, playHandToCompletion, startHand, takeSeat } from './helpers.js';

// Seat changes (LiveTable.moveSeat) and the SB/BB tags (positionLabels.ts's blindTags).

test('the blinds are tagged in front of their seats, and a seated player moves to an empty seat — after the hand if they are in it', async ({ page }) => {
  test.setTimeout(120_000);
  await adminLogin(page);
  await createTable(page, { name: 'Seat Move', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await addBot(page, 1, 'calling-station', 200);
  await addBot(page, 2, 'calling-station', 200);
  await takeSeat(page, 0, 200);
  await startHand(page);

  // Three players: exactly one SB and one BB tag, on two different seats.
  await expect(page.locator('.blind-tag--sb')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.blind-tag--bb')).toHaveCount(1);
  await expect(page.locator('.blind-tag--sb')).toHaveText('SB');

  // Mid-hand: the move waits for the hand to end, and says so first.
  await chooseSeatOption(page, 4, 'Move to this seat');
  const dialog = page.getByRole('dialog', { name: 'Move to seat 5' });
  await expect(dialog).toContainText('as soon as this hand ends');
  await dialog.getByRole('button', { name: /^Move/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-testid="seat-0"]')).toContainText('to seat 5');

  // Play it out (checking/calling); then the seat has moved, stack and all.
  const ours = page.getByRole('button', { name: /^(Check|Call)/ }).first();
  const playHand = page.getByRole('button', { name: 'Play Hand' });
  for (let i = 0; i < 20 && !(await playHand.isVisible()); i++) {
    await expect(ours.or(playHand)).toBeVisible({ timeout: 30_000 });
    if (await ours.isVisible()) await ours.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await expect(page.locator('[data-testid="seat-4"]')).not.toHaveAttribute('data-seat-status', 'empty', { timeout: 10_000 });
  await expect(page.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'empty');
  // A taken seat offers no move.
  await expect(page.locator('[data-testid="seat-1"] .seat-empty-tap')).toHaveCount(0);
});

// The reported bug: a player (not the owner, whose view is built
// separately) who moved went on seeing their OLD seat's view — no cards,
// not their own box — until they reloaded the page.
test('a player who moves sees their new seat at once — and again after a move that waited for the hand — with no reload', async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  await createTable(owner, { name: 'Guest Seat Move', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 200);
  await guestSignup(guest, 'Gus');
  await inviteToSeat(owner, guest, 1, 200);
  await expect(guest.locator('[data-testid="seat-1"] .seat')).toHaveClass(/seat-viewer/);

  // Between hands: at once.
  await chooseSeatOption(guest, 3, 'Move to this seat');
  const dialog = guest.getByRole('dialog', { name: 'Move to seat 4' });
  await dialog.getByRole('button', { name: /^Move/ }).click();
  await expect(guest.locator('[data-testid="seat-3"] .seat')).toHaveClass(/seat-viewer/, { timeout: 10_000 });
  await expect(guest.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'empty');
  // Their own controls are on their new box.
  await expect(guest.locator('[data-testid="seat-3"] .seat-call')).toHaveCount(1);

  // Mid-hand: when the hand ends — and the next hand deals them their cards in the new seat.
  await startHand(owner);
  await expect(guest.locator('[data-testid="seat-3"] .card:not(.card-back)')).toHaveCount(2, { timeout: 15_000 });
  await chooseSeatOption(guest, 5, 'Move to this seat');
  await guest.getByRole('dialog', { name: 'Move to seat 6' }).getByRole('button', { name: /^Move/ }).click();
  await playHandToCompletion([owner, guest]);
  await expect(guest.locator('[data-testid="seat-5"] .seat')).toHaveClass(/seat-viewer/, { timeout: 15_000 });
  await expect.poll(() => owner.getByRole('button', { name: 'Play Hand' }).isEnabled(), { timeout: 15_000 }).toBe(true);
  await startHand(owner);
  await expect(guest.locator('[data-testid="seat-5"] .card:not(.card-back)')).toHaveCount(2, { timeout: 15_000 });
});

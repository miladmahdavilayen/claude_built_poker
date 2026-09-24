import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, takeSeat } from './helpers.js';

// Regression test: the owner's per-seat "Rebuy" button renders as a corner
// overlay on that seat's video tile. In full-screen/immersive mode a
// seat's video effectively fills the whole visible camera, so the button
// used to sit right over the player's face. It's now hidden while
// immersive mode is active and reappears the instant the owner exits full
// screen — the owner can still rebuy anyone, just not while that seat's
// camera is full-screen. See Table.tsx's onRebuyClick wiring, DECISIONS.md.
test('the owner rebuy button is hidden in full screen and reappears when exited', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxBob = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageBob = await ctxBob.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Rebuy Full Screen Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageBob, 'Bob');
  await takeSeat(pageOwner, 0, 200);
  await inviteToSeat(pageOwner, pageBob, 1, 200);

  const rebuyButton = pageOwner.locator('[data-testid="seat-1"]').getByRole('button', { name: 'Rebuy' });
  await expect(rebuyButton).toBeVisible();

  await pageOwner.locator('.immersive-toggle').click();
  await expect(rebuyButton).toHaveCount(0);

  await pageOwner.locator('.immersive-toggle').click();
  await expect(rebuyButton).toBeVisible();

  await ctxOwner.close();
  await ctxBob.close();
});

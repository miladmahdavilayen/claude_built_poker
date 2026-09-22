import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// Regression test for the card/video merge: a seat with its camera on
// renders its hole cards directly over the video (a bottom fade keeps them
// legible) instead of in their own row below it — see Seat.tsx's
// `.seat-video-cards` and styles.css. A seat with no camera keeps the
// original standalone `.seat-cards` row. Both must coexist correctly on
// the same table.
test('a seat with video on shows its cards overlaid on the video; a seat with no video keeps its own card row', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxGuest = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageGuest = await ctxGuest.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Card Video Overlay Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageGuest, 'Nora');

  await takeSeat(pageOwner, 0, 100);
  await inviteToSeat(pageOwner, pageGuest, 1, 100);

  // Only the owner (seat 0) turns their camera on — seat 1 stays without video.
  await pageOwner.getByRole('button', { name: '🎥 Join with video' }).click();
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-video video')).toBeVisible({ timeout: 15_000 });

  await startHand(pageOwner);
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-cards')).toBeVisible({ timeout: 10_000 });
  await expect(pageOwner.locator('[data-testid="seat-1"] .seat-cards')).toBeVisible();

  // Seat 0 (video on): its 2 cards are nested inside the video's own
  // fade-overlay container, not in a separate standalone row.
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-video .seat-video-cards .card')).toHaveCount(2);
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-video-cards')).toHaveCount(1);

  // Seat 1 (no video): its cards render in the plain standalone row —
  // there is no video box, and no video-cards overlay, on this seat at all.
  await expect(pageOwner.locator('[data-testid="seat-1"] .seat-video')).toHaveCount(0);
  await expect(pageOwner.locator('[data-testid="seat-1"] .seat-video-cards')).toHaveCount(0);
  await expect(pageOwner.locator('[data-testid="seat-1"] .card')).toHaveCount(2);

  await ctxOwner.close();
  await ctxGuest.close();
});

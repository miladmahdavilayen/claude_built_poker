import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// Regression test for the video-fills-the-whole-seat merge: a seat with its
// camera on shows video as the full seat background, with its name (top)
// and cards/stack/rebuy (bottom) rendered as overlays directly on top of
// it — see Seat.tsx's `.seat-video-overlay-top`/`.seat-video-overlay-bottom`
// and styles.css. A seat with no camera keeps the original standalone
// `.seat-cards`/`.seat-info` rows. Both must coexist correctly on the same
// table.
test('a seat with video on overlays its name/cards/stack on the full-size video; a seat with no video keeps its own rows', async ({ browser }) => {
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

  // Seat 0 (video on): the seat itself is the video frame (no separate,
  // smaller, redundant video-only border) — its name renders in the top
  // overlay, its cards/stack/rebuy in the bottom one, both nested inside
  // .seat-video (i.e. on top of the video), not in a standalone .seat-info.
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat')).toHaveClass(/\bseat-has-video\b/);
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-video .seat-video-overlay-top .seat-name')).toBeVisible();
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-video .seat-video-overlay-bottom .card')).toHaveCount(2);
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-video .seat-video-overlay-bottom .seat-stack')).toBeVisible();
  await expect(pageOwner.locator('[data-testid="seat-0"] .seat-info')).toHaveCount(0);

  // Seat 1 (no video): plain standalone rows — no video box, no overlays.
  await expect(pageOwner.locator('[data-testid="seat-1"] .seat')).not.toHaveClass(/\bseat-has-video\b/);
  await expect(pageOwner.locator('[data-testid="seat-1"] .seat-video')).toHaveCount(0);
  await expect(pageOwner.locator('[data-testid="seat-1"] .seat-info .seat-name')).toBeVisible();
  await expect(pageOwner.locator('[data-testid="seat-1"] .card')).toHaveCount(2);

  await ctxOwner.close();
  await ctxGuest.close();
});

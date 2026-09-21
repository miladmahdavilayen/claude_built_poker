import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, takeSeat } from './helpers.js';

test('two seated players joining voice+video see each other\'s video rendered on their seats', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Eve is the table owner (self-seating and inviting are both owner-only now — see DECISIONS.md).
  await adminLogin(pageA);
  await createTable(pageA, { name: 'E2E Voice Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });

  await guestSignup(pageB, 'Frank');

  await takeSeat(pageA, 0, 100);
  await inviteToSeat(pageA, pageB, 1, 100);

  await pageA.getByRole('button', { name: '🎥 Join with video' }).click();
  await pageB.getByRole('button', { name: '🎥 Join with video' }).click();

  // Each seat gets its OWN video element rendered directly on it — the
  // player's own seat (their local, muted preview) and the other seated
  // player's seat (the remote peer's stream), proving the rtc-join →
  // rtc-peers → offer/answer/ICE handshake actually completed a real peer
  // connection whose track landed on the correct seat, not just that a
  // generic tile list updated somewhere on the page.
  await expect(pageA.locator('[data-testid="seat-0"] .seat-video video')).toBeVisible({ timeout: 15_000 });
  await expect(pageA.locator('[data-testid="seat-1"] .seat-video video')).toBeVisible({ timeout: 15_000 });
  await expect(pageB.locator('[data-testid="seat-0"] .seat-video video')).toBeVisible({ timeout: 15_000 });
  await expect(pageB.locator('[data-testid="seat-1"] .seat-video video')).toBeVisible({ timeout: 15_000 });

  // With both players seated, the compact spectator/unseated-voice strip
  // in the header panel should stay empty — there's nowhere else for
  // their video to (incorrectly) show up.
  await expect(pageA.locator('.voice-tile')).toHaveCount(0);
  await expect(pageB.locator('.voice-tile')).toHaveCount(0);

  // Leaving the call removes the video from both seats on the other side.
  await pageA.getByRole('button', { name: 'Leave call' }).click();
  await expect(pageB.locator('[data-testid="seat-0"] .seat-video')).toHaveCount(0, { timeout: 10_000 });

  await ctxA.close();
  await ctxB.close();
});

test('a spectator (no seat) using voice chat appears in the compact voice strip instead', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await guestSignup(pageA, 'Grace');
  await createTable(pageA, { name: 'E2E Voice Spectator Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageA.url();

  await guestSignup(pageB, 'Hank');
  await pageB.goto(tableUrl);
  // Neither player takes a seat — both are spectators.

  await pageA.getByRole('button', { name: '🎤 Join voice' }).click();
  await pageB.getByRole('button', { name: '🎤 Join voice' }).click();

  await expect(pageA.locator('.voice-tile')).toHaveCount(2, { timeout: 15_000 });
  await expect(pageB.locator('.voice-tile')).toHaveCount(2, { timeout: 15_000 });

  await ctxA.close();
  await ctxB.close();
});

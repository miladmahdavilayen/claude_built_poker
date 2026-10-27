import { expect, test, type Page } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, takeSeat, joinCall, openTableMenu, closeTableMenu } from './helpers.js';

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

  await joinCall(pageA, true);
  await joinCall(pageB, true);

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

/** True once `locator`'s <audio> is actually playing a live remote stream with sound. */
async function isPlayingRemoteAudio(page: Page, locator: string): Promise<boolean> {
  return page.locator(locator).first().evaluate((el) => {
    const audio = el as HTMLAudioElement;
    const stream = audio.srcObject as MediaStream | null;
    return !!stream && stream.getAudioTracks().length > 0 && !audio.paused && !audio.muted;
  });
}

/** If the browser held back unmuted playback until a gesture, take the offered "tap to hear" path, as a real viewer would. */
async function tapToHearIfOffered(page: Page): Promise<void> {
  const unlock = page.getByRole('button', { name: '🔊 Tap to hear the table' });
  if (await unlock.isVisible()) await unlock.click();
}

// Nobody has to open their own mic/camera to hear the table: every human
// is a receive-ready peer from the moment they arrive (see
// useVoiceChat.ts). Seeing other players' cameras, though, is for people
// who've joined the call — a non-owner who hasn't gets sound only.
test("a seated player who never joins the call still hears another player, but sees no video until they join", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await adminLogin(pageA);
  await createTable(pageA, { name: 'Auto-Receive Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageB, 'Ivan');
  await takeSeat(pageA, 0, 100);
  await inviteToSeat(pageA, pageB, 1, 100);

  // Only A ever touches voice controls — B never clicks anything voice-related.
  await joinCall(pageA, true);

  // B hears A, with zero action on B's part...
  await expect(pageB.locator('[data-testid="seat-0"] audio')).toHaveCount(1, { timeout: 15_000 });
  await tapToHearIfOffered(pageB);
  await expect.poll(() => isPlayingRemoteAudio(pageB, '[data-testid="seat-0"] audio'), { timeout: 10_000 }).toBe(true);
  // ...but sees no camera, on A's seat or anywhere else.
  await expect(pageB.locator('.seat-video')).toHaveCount(0);
  await expect(pageB.locator('video')).toHaveCount(0);

  // Joining the call (B's own choice) brings A's video in.
  await joinCall(pageB, false);
  await expect(pageB.locator('[data-testid="seat-0"] .seat-video video')).toBeVisible({ timeout: 15_000 });

  // A stops sending — B's copy of A's media goes away again.
  await pageA.getByRole('button', { name: 'Leave call' }).click();
  await expect(pageB.locator('[data-testid="seat-0"] .seat-video')).toHaveCount(0, { timeout: 10_000 });

  await ctxA.close();
  await ctxB.close();
});

// The reported bug: an invited guest was in the call, and the owner — not
// seated, never joined the call — could neither see nor hear them.
test('the owner, without joining the call or taking a seat, sees and hears an invited guest who is on camera', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxGuest = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageGuest = await ctxGuest.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Owner Watches Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageGuest, 'Grace');
  await inviteToSeat(pageOwner, pageGuest, 2, 100);

  await joinCall(pageGuest, true);

  // The owner never clicked a voice button and has no seat (their call buttons are in the table menu).
  await expect((await openTableMenu(pageOwner)).getByRole('button', { name: '🎥 Join with video' })).toBeVisible();
  await closeTableMenu(pageOwner);
  await expect(pageOwner.locator('[data-testid="seat-2"] .seat-video video')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => pageOwner.locator('[data-testid="seat-2"] .seat-video video').evaluate((v) => (v as HTMLVideoElement).videoWidth > 0), { timeout: 10_000 })
    .toBe(true);
  await tapToHearIfOffered(pageOwner);
  await expect.poll(() => isPlayingRemoteAudio(pageOwner, '[data-testid="seat-2"] audio'), { timeout: 10_000 }).toBe(true);

  await ctxOwner.close();
  await ctxGuest.close();
});

test('a spectator (no seat) using voice chat appears in the small strip over the table instead, and sees themselves in the menu', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Table creation is admin/logged-in-human-only now — see DECISIONS.md.
  await adminLogin(pageA);
  await createTable(pageA, { name: 'E2E Voice Spectator Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageA.url();

  await guestSignup(pageB, 'Hank');
  await pageB.goto(tableUrl);
  // Neither player takes a seat — both are spectators.

  await joinCall(pageA, false);
  await joinCall(pageB, false);

  // Each sees the other in the strip over the table…
  await expect(pageA.locator('.table-unseated .voice-tile')).toHaveCount(1, { timeout: 15_000 });
  await expect(pageB.locator('.table-unseated .voice-tile')).toHaveCount(1, { timeout: 15_000 });
  // …and themselves in the menu's Call section, with their own controls.
  const menu = await openTableMenu(pageA);
  await expect(menu.locator('.voice-tile')).toHaveCount(1);
  await expect(menu.getByRole('button', { name: 'Leave call' })).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

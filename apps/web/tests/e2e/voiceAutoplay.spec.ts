import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat } from './helpers.js';

// Real browsers hold back UNMUTED playback until the page has had a user
// gesture — the reason a viewer who never clicked "Join voice" used to see
// and hear nothing. The test browser can't reproduce that on its own (it
// treats every page as already interacted with), so the owner's window
// gets the same rule installed before the app loads: unmuted play() is
// refused with NotAllowedError until the first click or key press.
const STRICT_AUTOPLAY = () => {
  let hadGesture = false;
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => (hadGesture = true), true);
  const proto = HTMLMediaElement.prototype;
  const realPlay = Object.getOwnPropertyDescriptor(proto, 'play')?.value as (this: HTMLMediaElement) => Promise<void>;
  proto.play = function play(this: HTMLMediaElement) {
    if (!this.muted && !hadGesture) return Promise.reject(new DOMException('play() needs a user gesture', 'NotAllowedError'));
    return realPlay.call(this);
  };
};

test('under strict autoplay rules, an owner who has not clicked anything still sees cameras at once, and hears the table after one tap', async ({ browser }) => {
  const ctxSetup = await browser.newContext();
  const ctxGuest = await browser.newContext();
  const pageSetup = await ctxSetup.newPage();
  const pageGuest = await ctxGuest.newPage();

  await adminLogin(pageSetup);
  await createTable(pageSetup, { name: 'Autoplay Rules Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageSetup.url();
  await guestSignup(pageGuest, 'Gina');
  await inviteToSeat(pageSetup, pageGuest, 1, 100);
  await pageGuest.getByRole('button', { name: '🎥 Join with video' }).click();

  // The owner opens the table cold: a new window, signed in, never clicked.
  // (Only the login session carries over from the setup window.)
  const session = await ctxSetup.storageState();
  await ctxSetup.close();
  const ctxOwner = await browser.newContext({ storageState: session });
  await ctxOwner.addInitScript(STRICT_AUTOPLAY);
  const pageOwner = await ctxOwner.newPage();
  await pageOwner.goto(tableUrl);

  // Video is muted, which browsers always allow — the face shows right away.
  const video = pageOwner.locator('[data-testid="seat-1"] .seat-video video');
  await expect(video).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth > 0), { timeout: 10_000 }).toBe(true);

  // Sound is held back, and the page says so instead of staying silent.
  const audio = pageOwner.locator('[data-testid="seat-1"] audio');
  await expect(audio).toHaveCount(1);
  const unlock = pageOwner.getByRole('button', { name: '🔊 Tap to hear the table' });
  await expect(unlock).toBeVisible({ timeout: 10_000 });
  expect(await audio.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(true);

  await unlock.click();
  await expect.poll(() => audio.evaluate((a) => !(a as HTMLAudioElement).paused), { timeout: 10_000 }).toBe(true);
  await expect(unlock).toHaveCount(0);

  await ctxOwner.close();
  await ctxGuest.close();
});

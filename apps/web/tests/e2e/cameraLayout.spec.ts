import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, takeSeat } from './helpers.js';

const PHONE_VIEWPORT = { width: 375, height: 812 };
const LAPTOP_VIEWPORT = { width: 1280, height: 800 };

/**
 * Seats the owner (seat 0) plus one guest per name (seats 1..N) at a
 * fresh table, each in its own browser context at the given viewport.
 * Nobody has joined voice/video yet — each test drives that itself,
 * since who mutes when matters for the active-speaker assertions below.
 */
async function seatHumans(
  browser: Browser,
  guestNames: string[],
  viewport: { width: number; height: number },
): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
  const ownerCtx = await browser.newContext({ viewport });
  const ownerPage = await ownerCtx.newPage();
  await adminLogin(ownerPage);
  await createTable(ownerPage, { name: 'Camera Layout Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(ownerPage, 0, 100);

  const contexts = [ownerCtx];
  const pages = [ownerPage];
  for (let i = 0; i < guestNames.length; i++) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await guestSignup(page, guestNames[i]!);
    await inviteToSeat(ownerPage, page, i + 1, 100);
    contexts.push(ctx);
    pages.push(page);
  }
  return { pages, contexts };
}

async function closeAll(contexts: BrowserContext[]): Promise<void> {
  for (const ctx of contexts) await ctx.close();
}

test('exactly 4 human cameras on a phone screen still show individual per-seat video (no collapse below the >4 threshold)', async ({ browser }) => {
  const { pages, contexts } = await seatHumans(browser, ['Alice', 'Bob', 'Carol'], PHONE_VIEWPORT);
  const [owner] = pages as [Page, Page, Page, Page];

  for (const page of pages) {
    await page.getByRole('button', { name: '🎥 Join with video' }).click();
  }

  for (let seatId = 0; seatId <= 3; seatId++) {
    await expect(owner.locator(`[data-testid="seat-${String(seatId)}"] .seat-video video`)).toBeVisible({ timeout: 20_000 });
  }
  await expect(owner.locator('.speaker-bar')).toHaveCount(0);

  await closeAll(contexts);
});

test('more than 4 human cameras on a phone screen collapse to a 2-tile speaker bar showing only who is actually speaking', async ({ browser }) => {
  const { pages, contexts } = await seatHumans(browser, ['Gina', 'Hank', 'Iris', 'Jack'], PHONE_VIEWPORT);
  const [owner, gina, hank, iris, jack] = pages as [Page, Page, Page, Page, Page];

  // Owner, Gina, and Hank join but immediately mute — Chromium's fake
  // audio device (see playwright.config.ts) only emits its tone while a
  // track stays enabled, so muting is a real (not simulated) way to make
  // them silent.
  for (const page of [owner, gina, hank]) {
    await page.getByRole('button', { name: '🎥 Join with video' }).click();
    await page.getByRole('button', { name: '🎤 Mute' }).click();
  }
  // Iris joins and stays unmuted, and her connection to the owner is
  // confirmed fully negotiated (video — and thus the same stream's audio
  // track — actually flowing) BEFORE the 5th camera (Jack) pushes the
  // table into collapsed mode. Only 4 cameras are on at this point, so
  // collapse hasn't triggered yet and her seat's own .seat-video is still
  // visible to check directly — this is what a slow CI runner's full
  // 5-way WebRTC mesh needs the most headroom for, and checking it here
  // (before collapse hides all seat video) is more direct than just
  // giving the post-collapse accuracy check itself a longer timeout.
  await iris.getByRole('button', { name: '🎥 Join with video' }).click();
  await expect(owner.locator('[data-testid="seat-3"] .seat-video video')).toBeVisible({ timeout: 20_000 });
  // Jack joins last, unmuted — the 5th camera, pushing past the >4
  // threshold on this phone-sized viewport.
  await jack.getByRole('button', { name: '🎥 Join with video' }).click();

  // Every seat's own video is suppressed table-wide now...
  await expect(owner.locator('.seat-video')).toHaveCount(0, { timeout: 20_000 });
  // ...replaced by a 2-tile bar...
  await expect(owner.locator('.speaker-bar-tile')).toHaveCount(2, { timeout: 20_000 });
  // ...showing specifically the 2 still-unmuted (actually speaking) players, not just any 2 —
  // proves the selection is accuracy-correct, not just count-correct. Wrapped in toPass since
  // the active-speaker poll (useActiveSpeakers.ts) needs a tick or two to converge, with a
  // generous margin for a slower/more constrained CI runner.
  await expect(async () => {
    const labels = (await owner.locator('.speaker-bar-label').allTextContents()).sort();
    expect(labels).toEqual(['Iris', 'Jack']);
  }).toPass({ timeout: 30_000 });

  await closeAll(contexts);
});

test('the same 5-camera scenario never collapses on a laptop-sized screen', async ({ browser }) => {
  const { pages, contexts } = await seatHumans(browser, ['Kate', 'Leo', 'Mona', 'Nate'], LAPTOP_VIEWPORT);
  const [owner] = pages as [Page, Page, Page, Page, Page];

  for (const page of pages) {
    await page.getByRole('button', { name: '🎥 Join with video' }).click();
  }

  for (let seatId = 0; seatId <= 4; seatId++) {
    await expect(owner.locator(`[data-testid="seat-${String(seatId)}"] .seat-video video`)).toBeVisible({ timeout: 20_000 });
  }
  await expect(owner.locator('.speaker-bar')).toHaveCount(0);

  await closeAll(contexts);
});

import { expect, test, type Page } from '@playwright/test';
import { addBot, adminLogin, closeTableMenu, createTable, openTableMenu, startHand, takeSeat } from './helpers.js';

const LANDSCAPE = { width: 844, height: 390 };
const PORTRAIT = { width: 390, height: 844 };

/** A phone: touch, and held whichever way `viewport` says. The owner, at a nine-seat table, in `seat`, with `bots` computer players. */
async function phoneAtTable(browser: import('@playwright/test').Browser, viewport: { width: number; height: number }, seat: number, bots: number[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    if (!localStorage.getItem('pokerclause.tableView')) localStorage.setItem('pokerclause.tableView', '2d');
  });
  await adminLogin(page);
  await createTable(page, { name: 'Sideways', smallBlind: 1, bigBlind: 2, maxSeats: 9, isPrivate: false });
  await takeSeat(page, seat, 200);
  for (const s of bots) await addBot(page, s, 'calling-station', 200);
  return page;
}

// Held sideways, a phone has width to spare and no height. The turn's buttons are a full finger's size each, never
// squeezed; and the bet slider opens beside its presets, the whole of it on screen, instead of one column too tall.
test('a phone on its side: the turn’s buttons are finger-sized, and the bet slider fits on screen', async ({ browser }) => {
  const page = await phoneAtTable(browser, LANDSCAPE, 0, [1]);
  await startHand(page);
  const fold = page.getByRole('button', { name: 'Fold' });
  await expect(fold).toBeVisible({ timeout: 30_000 });
  for (const name of [/^Fold$/, /^(Call|Check)/, /^(Raise|Bet)$/]) {
    const b = (await page.locator('.bet-overlay-rail').getByRole('button', { name }).boundingBox())!;
    expect(b.height, String(name)).toBeGreaterThanOrEqual(48);
    expect(b.width, String(name)).toBeGreaterThanOrEqual(110);
    expect(b.y + b.height).toBeLessThanOrEqual(LANDSCAPE.height + 0.5);
  }
  // The clock isn't under them, nor under the menu button.
  const clock = (await page.locator('.action-timer').boundingBox())!;
  const rail = (await page.locator('.bet-overlay-rail').boundingBox())!;
  const menu = (await page.locator('.table-menu-button').boundingBox())!;
  expect(clock.y + clock.height).toBeLessThanOrEqual(rail.y);
  expect(clock.x + clock.width).toBeLessThanOrEqual(menu.x);

  await page.locator('.bet-overlay-rail').getByRole('button', { name: /^(Raise|Bet)$/ }).click();
  // Everything of the sizer is on screen: the slider end to end, the amount, the presets, the − and +.
  for (const sel of ['.vbs-track', '.bet-overlay-input', '.bet-overlay-presets', '.vbs-nudge', '.bet-overlay-close']) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.y, sel).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height, sel).toBeLessThanOrEqual(LANDSCAPE.height + 0.5);
    expect(b.x + b.width, sel).toBeLessThanOrEqual(LANDSCAPE.width + 0.5);
  }
  expect((await page.locator('.vbs-track').boundingBox())!.height).toBeGreaterThan(200);
  await page.getByRole('button', { name: 'All-in' }).click();
  await expect(page.getByTestId('vbs-thumb')).toContainText(/Raise|Bet/);
  await page.context().close();
});

// With three or more at the table, a phone held upright is told, once, that sideways shows more. Two players: nothing.
// Turned sideways, it goes; dismissed, it stays away.
test('a phone held upright at a table of three or more is advised to turn sideways', async ({ browser }) => {
  const page = await phoneAtTable(browser, PORTRAIT, 0, [1]);
  const hint = page.getByTestId('suggest-rotate');
  await expect(hint).toHaveCount(0);
  await addBot(page, 2, 'calling-station', 200);
  await expect(hint).toContainText('With 3 players, turn your phone sideways');
  await page.setViewportSize(LANDSCAPE);
  await expect(hint).toHaveCount(0);
  await page.setViewportSize(PORTRAIT);
  await expect(hint).toBeVisible();
  await hint.getByRole('button', { name: 'Dismiss' }).click();
  await expect(hint).toHaveCount(0);
  await addBot(page, 3, 'calling-station', 200);
  await expect(hint).toHaveCount(0);
  await page.context().close();
});

// Seated on the 3D table with the phone on its side, the view pulls back until every other seat's player is on screen
// looking straight ahead — clear of where the turn's buttons go — from any seat. Seat 1 has everyone but seat 9 to
// fit (the house dealer stands between those two). Upright again, the view is back at your own eyes.
for (const seat of [4, 0] as const) {
  test(`a phone on its side, seated in 3D at seat ${String(seat + 1)}: every other player is in view without looking round`, async ({ browser }) => {
    test.setTimeout(150_000);
    const others = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((s) => s !== seat);
    const page = await phoneAtTable(browser, LANDSCAPE, seat, others);
    await (await openTableMenu(page)).getByLabel(/3D — Seated/).check();
    await closeTableMenu(page);
    await expect(page.getByTestId('table-3d')).toBeVisible({ timeout: 20_000 });
    const eyeBack = (): Promise<number> => page.evaluate(() => (window as unknown as { __scene3d?: { debugState: () => { eyeBack: number } } }).__scene3d?.debugState().eyeBack ?? -1);
    await expect.poll(eyeBack, { timeout: 20_000 }).toBeGreaterThan(0.5);
    await page.waitForTimeout(2500);
    // Everyone who has to be in view has their nameplate on screen, left of the buttons' rail.
    const mustSee = seat === 0 ? others.filter((s) => s !== 8) : others;
    for (const s of mustSee) {
      const plate = page.locator(`[data-testid="seat-${String(s)}"]`);
      await expect(plate, `seat ${String(s + 1)}`).toBeVisible();
      const b = (await plate.boundingBox())!;
      expect(b.x, `seat ${String(s + 1)}`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width / 2, `seat ${String(s + 1)}`).toBeLessThan(LANDSCAPE.width - 128);
      expect(b.y, `seat ${String(s + 1)}`).toBeGreaterThanOrEqual(0);
    }
    // Upright: your own eyes at your seat again.
    await page.setViewportSize(PORTRAIT);
    await expect.poll(eyeBack, { timeout: 10_000 }).toBe(0);
    await page.context().close();
  });
}

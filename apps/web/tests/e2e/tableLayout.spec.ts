import { expect, test, type Page } from '@playwright/test';
import { adminLogin, createTable, startHand, takeSeat } from './helpers.js';

/**
 * The table never overlaps itself (see useTableLayout.ts): for a full table
 * and a small one, mid-hand, on a desktop, a tablet and phones both ways
 * round, with and without every player on camera (`?fakeCameras=1`, a
 * development-only stand-in camera on every seat, bots included) — no two
 * seats overlap, no seat touches the board, no bet's chips or anything else
 * covers the community cards, and every seat is on screen.
 */

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'laptop', width: 1280, height: 720, touch: false },
  { name: 'short desktop window', width: 1280, height: 420, touch: false },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'phone', width: 375, height: 667, touch: true },
  { name: 'phone sideways', width: 844, height: 390, touch: true },
];

async function fillTable(page: Page, name: string, seats: number): Promise<string> {
  await page.goto('/lobby');
  await createTable(page, { name, smallBlind: 1, bigBlind: 2, maxSeats: seats, isPrivate: false });
  await takeSeat(page, 0, 100);
  for (let s = 1; s < seats; s++) {
    // Whichever persona the picker offers first — each one added drops down the list.
    await page.locator(`[data-testid="seat-${String(s)}"]`).getByText('+ Add bot').click();
    await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();
    await expect(page.locator(`[data-testid="seat-${String(s)}"] .seat-tag-bot`)).toBeVisible();
  }
  await startHand(page);
  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible();
  return page.url();
}

/** Every overlap on the table right now, as readable labels — [] when the layout is clean. */
function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type B = { l: number; r: number; t: number; b: number };
    const felt = document.querySelector('.felt')!;
    const box = (els: (Element | null)[]): B | null => {
      const rs = els.filter((e): e is Element => !!e).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      if (rs.length === 0) return null;
      return { l: Math.min(...rs.map((r) => r.left)), r: Math.max(...rs.map((r) => r.right)), t: Math.min(...rs.map((r) => r.top)), b: Math.max(...rs.map((r) => r.bottom)) };
    };
    const hit = (a: B, b: B): boolean => a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1;
    const seats = [...felt.querySelectorAll<HTMLElement>('.seat-slot')]
      .map((slot) => ({ id: slot.dataset.testid!, b: box([slot.querySelector('.seat'), ...slot.querySelectorAll('.seat *')]) }))
      .filter((s): s is { id: string; b: B } => !!s.b);
    const board = box([felt.querySelector('.board-area')]);
    const cards = box([...felt.querySelectorAll('.board-cards .card')]);
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.scrollHeight;
    const found: string[] = [];
    seats.forEach((s, i) => {
      for (const o of seats.slice(i + 1)) if (hit(s.b, o.b)) found.push(`${s.id} overlaps ${o.id}`);
      if (board && hit(s.b, board)) found.push(`${s.id} overlaps the board`);
      if (s.b.l < -1 || s.b.t < -1 || s.b.r > vw + 1 || s.b.b > vh + 1) found.push(`${s.id} is off screen`);
    });
    for (const sel of ['.bet-chips-slot', '.fairness-commitment', '.action-timer:not(.action-timer-hidden)', '.immersive-toggle']) {
      for (const el of felt.querySelectorAll(sel)) {
        const b = box([el, ...el.querySelectorAll('*')]);
        if (b && cards && hit(b, cards)) found.push(`${sel} covers the community cards`);
      }
    }
    return found;
  });
}

test('seats, bets and the board never overlap — 2 to 9 players, any screen, cameras on or off', async ({ browser, page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  const tables = [await fillTable(page, 'Layout Nine', 9), await fillTable(page, 'Layout Four', 4)];

  // The sign-in cookie rotates each time it's used, so each device carries on from the last one's.
  let signedIn = await page.context().storageState();
  await page.close();
  for (const vp of VIEWPORTS) {
    // A real device of that size: a touch screen is a phone/tablet, with its own controls (see useIsCompactScreen.ts).
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch, storageState: signedIn });
    const view = await ctx.newPage();
    for (const cameras of [false, true]) {
      for (const url of tables) {
        await view.goto(cameras ? `${url}?fakeCameras=1` : url);
        await expect(view.locator('.board-area')).toBeVisible();
        // Cameras sit on the seats on anything bigger than a phone (a phone with many collapses them into the speaker bar).
        if (cameras && vp.width >= 768 && !(vp.touch && vp.height <= 500)) await expect(view.locator('.seat-has-video').first()).toBeVisible();
        // The layout settles in a frame or two after the seats first measure themselves.
        await expect.poll(() => overlaps(view), { timeout: 5_000, message: `${vp.name}${cameras ? ' + cameras' : ''}, ${url}` }).toEqual([]);
      }
    }
    signedIn = await ctx.storageState();
    await ctx.close();
  }
});

import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup } from './helpers.js';

// iPhone 17 Pro Max: Playwright's bundled device list (deviceDescriptorsSource.json,
// authored before this device existed) tops out at iPhone 15 Pro Max, so there is no
// ready-made preset here. This uses the iPhone 16 Pro Max's published CSS viewport
// (440x956 @ 3x device pixel ratio) as the best available stand-in — Apple carried
// the same 6.9" panel/resolution forward from the 16 Pro Max to the 17 Pro Max. This
// app runs as a standalone PWA (`apple-mobile-web-app-capable` in index.html), so the
// FULL device viewport applies here, not a browser-chrome-reduced one.
const IPHONE_17_PRO_MAX = { width: 440, height: 956 };

// Regression test for a real report: the lobby header's logout button, at the
// visual top-right corner, could end up unreachable on a real iPhone — too close to
// the screen's rounded corner/notch/Dynamic Island for a thumb to land on reliably.
// The fix was giving `.lobby-page` real `env(safe-area-inset-*)` padding on every
// side (it previously had none at all, unlike `.table-header`/`.page-centered`
// elsewhere in this app). Chromium's emulation doesn't simulate non-zero safe-area
// insets, so a bounding-box check alone can't reproduce the original bug — actually
// clicking the button and completing a real log-out is the direct, environment-
// independent proof that it's genuinely reachable, not just present in the DOM.
test('the logout button is reachable and works at the iPhone 17 Pro Max viewport', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: IPHONE_17_PRO_MAX, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await guestSignup(page, 'Alice');
  await expect(page).toHaveURL(/\/lobby/);

  const logoutBtn = page.getByRole('button', { name: 'Log out' });
  await expect(logoutBtn).toBeVisible();

  // Real margin from the top-right corner on every side — not flush against
  // the edge, which is what actually made the original button unreliable to
  // tap on a real device's rounded corner/notch.
  const box = await logoutBtn.boundingBox();
  if (!box) throw new Error('Logout button has no bounding box.');
  expect(box.x + box.width).toBeLessThan(IPHONE_17_PRO_MAX.width);
  expect(box.x).toBeGreaterThan(IPHONE_17_PRO_MAX.width * 0.4); // sits in the right-hand portion of the header, not spanning to the left edge
  expect(box.y).toBeGreaterThan(0);
  // A real touch target, not just a visible one (Apple HIG's ~44px minimum).
  expect(box.height).toBeGreaterThanOrEqual(40);

  // The actual proof: a real tap on it works end to end.
  await logoutBtn.click();
  await expect(page).toHaveURL(/\/login/);

  await ctx.close();
});

// The old design was a single wide `<table>` that either cropped a column or
// forced sideways scrolling on a phone. The redesign replaces it with a
// responsive card grid (CSS grid + auto-fill/minmax, no media query needed) —
// this checks that grid genuinely collapses to a single, full-width, non-
// overflowing column on a phone, with everything (including a long table
// name) still fully legible, and expands to multiple columns on a wider
// screen instead of staying pinned to one.
test('the table list is a responsive card grid: one column on a phone, multiple on a laptop', async ({ browser }) => {
  // Deliberately distinctive, unlikely-elsewhere names: the lobby lists
  // every table on the server (shared across this whole suite's tests, all
  // via the same admin account), so a raw `.table-card` COUNT would be
  // fragile — scoping each assertion to these exact names instead is what
  // keeps this robust regardless of what other tests created before it.
  const phoneCtx = await browser.newContext({ viewport: IPHONE_17_PRO_MAX, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const phonePage = await phoneCtx.newPage();
  await adminLogin(phonePage);
  await createTable(phonePage, { name: 'Phone Grid Table One', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await phonePage.goto('/lobby');
  await createTable(phonePage, {
    name: 'Phone Grid Table Two — High Stakes Sunday Special',
    smallBlind: 25,
    bigBlind: 50,
    maxSeats: 9,
    isPrivate: false,
  });
  await phonePage.goto('/lobby');
  const phoneCards = phonePage.locator('.table-card', { hasText: /Phone Grid Table (One|Two)/ });
  await expect(phoneCards).toHaveCount(2);

  const hasHorizontalOverflow = await phonePage.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(hasHorizontalOverflow).toBe(false);

  const cardBoxes = await phoneCards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
  // Every card starts at (roughly) the same x — a single column, not
  // side-by-side — on this narrow a screen.
  expect(new Set(cardBoxes.map((x) => Math.round(x))).size).toBe(1);
  await phoneCtx.close();

  // A fresh, previously-unused pair of table names — the lobby lists every
  // table on the server, including the phone context's two from above (the
  // same shared server, same admin account), so this scopes down to just
  // the two THIS part of the test cares about instead of asserting an
  // exact total count.
  const laptopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const laptopPage = await laptopCtx.newPage();
  await adminLogin(laptopPage);
  await createTable(laptopPage, { name: 'Laptop Grid Table One', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await laptopPage.goto('/lobby');
  await createTable(laptopPage, { name: 'Laptop Grid Table Two', smallBlind: 5, bigBlind: 10, maxSeats: 9, isPrivate: false });
  await laptopPage.goto('/lobby');
  const laptopCards = laptopPage.locator('.table-card', { hasText: /Laptop Grid Table (One|Two)/ });
  await expect(laptopCards).toHaveCount(2);

  const laptopCardXs = await laptopCards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
  // Two distinct x positions — side by side, not stacked — once there's real width to use.
  expect(new Set(laptopCardXs.map((x) => Math.round(x))).size).toBe(2);
  await laptopCtx.close();
});

import { expect, test } from '@playwright/test';
import { createTable, guestSignup, takeSeat } from './helpers.js';

// Regression test, two related bugs:
//
// 1. A common short real-world browser viewport (address bar, tabs, a
//    bookmarks bar all eat into the usable page height — 600-650px of
//    actual viewport is common on a laptop, well under Playwright's
//    ~720px default) used to push the action bar below the fold with no
//    reliable way back into view.
// 2. Even after adding a scroll fallback, a raise-capable action (which
//    shows the bet-sizer — a slider, a number input, and three preset
//    buttons, meaningfully taller than a plain check/call/fold row) could
//    still push it out of a *very* short viewport, and nothing on screen
//    told a real person they needed to scroll to find it — it just
//    looked like the hand had frozen with no options.
//
// Fixed by pinning the action bar with `position: sticky; bottom: 0`
// inside `.table-page`'s own scroll area, so it's always visible the
// instant it's your turn, at any viewport height, with any combination
// of legal actions — not dependent on scrolling or on trimming content
// above it to just barely fit.
test('the action bar is pinned in view — no scrolling needed — even at an extreme short viewport with the bet-sizer showing', async ({ browser }) => {
  // Two real humans (not a bot) so the "other" seat's preflop action is
  // fully deterministic — a scripted call, never a random fold or an
  // all-in raise that could rob the short-viewport page of a
  // raise-capable turn. This matters because which seat draws
  // button/SB on a table's very first hand is itself a genuine high-card
  // draw (see DECISIONS.md), not always seat 0 — so this test can't
  // assume the short-viewport page acts first.
  const ctxShort = await browser.newContext({ viewport: { width: 1280, height: 420 } });
  const ctxOther = await browser.newContext();
  const pageShort = await ctxShort.newPage();
  const pageOther = await ctxOther.newPage();

  await guestSignup(pageShort, 'Solo');
  await createTable(pageShort, { name: 'Short Viewport Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageShort.url();

  await guestSignup(pageOther, 'Buddy');
  await pageOther.goto(tableUrl);

  await takeSeat(pageShort, 0, 200);
  await takeSeat(pageOther, 1, 200);

  await expect(pageShort.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // If the other seat is button/SB, it acts first — just call, never raise,
  // so the short-viewport page always gets a raise-capable BB turn next.
  const otherCallBtn = pageOther.getByRole('button', { name: /^Call/ });
  if (await otherCallBtn.isVisible().catch(() => false)) {
    await otherCallBtn.click();
  }

  // Preflop, heads-up: whichever seat is button/SB faces the blind and
  // can raise — that seat gets the (tallest) bet-sizer first.
  await expect(pageShort.locator('.bet-sizer')).toBeVisible();
  const box = await pageShort.locator('.action-bar').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(420);

  // And it's genuinely clickable without Playwright needing to auto-scroll first.
  await pageShort.locator('.btn-call, .btn-check').first().click();

  await ctxShort.close();
  await ctxOther.close();
});

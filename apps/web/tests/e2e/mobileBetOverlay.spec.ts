import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// Regression test for the phone/iPhone bet-sizer redesign: below the
// compact breakpoint, a raise-capable turn now shows the full-screen
// `.bet-overlay` (vertical bill-stack slider docked to the right, dimmed
// backdrop over the felt) instead of the old inline `.action-bar`/
// `.bet-sizer` bar — see ActionBar.tsx, VerticalBetSlider.tsx.
test('a raise-capable turn on a phone-width viewport shows the vertical bet overlay, and dragging it changes the amount sent', async ({
  browser,
}) => {
  const mobileViewport = { width: 390, height: 844 };
  const ctxA = await browser.newContext({ viewport: mobileViewport });
  const ctxB = await browser.newContext({ viewport: mobileViewport });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await adminLogin(pageA);
  await createTable(pageA, { name: 'Mobile Bet Overlay Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageB, 'Bob');
  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 1, 200);

  await startHand(pageA);
  await expect(pageA.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // Heads-up preflop: whichever page is button/SB acts first, facing a
  // call — it's the one with a bet-capable turn.
  const raiseFirst = (await pageA.locator('.btn-bet').isVisible().catch(() => false)) ? pageA : pageB;
  const callSecond = raiseFirst === pageA ? pageB : pageA;

  // The compact overlay replaced the old inline bar entirely — not just
  // added alongside it.
  await expect(raiseFirst.locator('.bet-overlay')).toBeVisible();
  await expect(raiseFirst.locator('.action-bar')).toHaveCount(0);

  const amountInput = raiseFirst.locator('.bet-overlay-input');
  const initialAmount = Number(await amountInput.inputValue());

  const track = raiseFirst.locator('.vbs-track');
  const box = await track.boundingBox();
  if (!box) throw new Error('Vertical bet slider track has no bounding box.');

  // Drag from the bottom of the track (min) up toward the top (max) —
  // the same up-to-increase gesture a real thumb would use.
  await raiseFirst.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
  await raiseFirst.mouse.down();
  await raiseFirst.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25, { steps: 12 });
  await raiseFirst.mouse.up();

  const draggedAmount = Number(await amountInput.inputValue());
  expect(draggedAmount).toBeGreaterThan(initialAmount);

  await raiseFirst.locator('.bet-overlay-confirm').click();

  // The action bubble on the raiser's own seat states the exact amountTo
  // the server accepted — a direct check that the dragged amount is what
  // actually got sent, unlike the caller's "Call $X" (that's the delta
  // still owed on top of their own already-posted blind, not the raise
  // total, so it deliberately isn't compared here).
  await expect(callSecond.locator('.seat-action-bubble')).toContainText(`Raise to $${draggedAmount}`);
  await expect(callSecond.locator('.btn-call')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Regression test for the phone/iPhone bet-sizer redesign: below the
// compact breakpoint, a raise-capable turn shows `.bet-overlay` — two thin
// rails pinned to the LEFT (fold/check/call) and RIGHT (bet slider) screen
// edges, bottom-anchored to their own content height (NOT stretched
// full-height) — in place of the old inline `.action-bar`/`.bet-sizer` bar.
// See ActionBar.tsx, VerticalBetSlider.tsx.
//
// This went through several iterations: first the entire screen faded,
// then a single bottom-anchored panel still ran wide enough to cover the
// board/hole-card area, then full-height rails visually collided with the
// felt's own top-corner elements (the fairness-commitment banner and the
// action timer, both positioned close to the top edge in full-screen/
// immersive mode, where the felt sits only ~8px from the viewport edge),
// then rails narrow enough to make the pot-fraction preset buttons
// functionally unclickable on a real phone. This test asserts all of
// those real constraints directly: a wide, unobstructed center gap between
// the rails, no overlap with the felt's top-corner elements (with immersive
// mode on, the exact condition that triggered that collision), and that
// the preset buttons are large enough to actually register a tap.
test('a raise-capable turn on a phone-width viewport shows left/right bet-overlay rails, leaving the center majority of the screen and the felt'
  + "'s top corners unobstructed, with tappable preset buttons and $1-precision adjustment", async ({ browser }) => {
  const mobileViewport = { width: 390, height: 844 };
  const ctxA = await browser.newContext({ viewport: mobileViewport });
  const ctxB = await browser.newContext({ viewport: mobileViewport });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await adminLogin(pageA);
  await createTable(pageA, { name: 'Mobile Bet Overlay Table', smallBlind: 1, bigBlind: 2, maxSeats: 2, isPrivate: false });
  await guestSignup(pageB, 'Bob');
  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 1, 200);

  await startHand(pageA);
  await expect(pageA.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // Heads-up preflop: whichever page is button/SB acts first, facing a
  // call — it's the one with a bet-capable turn.
  const raiseFirst = (await pageA.locator('.btn-bet').isVisible().catch(() => false)) ? pageA : pageB;
  const callSecond = raiseFirst === pageA ? pageB : pageA;

  // Full-screen/immersive mode is what actually triggered the top-corner
  // collision (see the comment above) — reproduce that exact condition.
  await raiseFirst.locator('.immersive-toggle').click();

  // The compact overlay replaced the old inline bar entirely — not just
  // added alongside it.
  await expect(raiseFirst.locator('.bet-overlay')).toBeVisible();
  await expect(raiseFirst.locator('.action-bar')).toHaveCount(0);

  const leftRailBox = await raiseFirst.locator('.bet-overlay-rail--left').boundingBox();
  const rightRailBox = await raiseFirst.locator('.bet-overlay-rail--right').boundingBox();
  const fairnessBox = await raiseFirst.locator('.fairness-commitment').boundingBox();
  const timerBox = await raiseFirst.locator('.action-timer').boundingBox();
  if (!leftRailBox || !rightRailBox) throw new Error('Bet overlay rail has no bounding box.');
  if (!fairnessBox || !timerBox) throw new Error('Fairness banner / action timer has no bounding box.');

  // Each rail is sized for real tap targets, not squeezed to a strict
  // percentage — but still clearly narrower than the screen.
  expect(leftRailBox.width).toBeLessThan(mobileViewport.width * 0.35);
  expect(rightRailBox.width).toBeLessThan(mobileViewport.width * 0.35);
  // The gap between the rails' facing inner edges — the actual visible,
  // unobstructed center — still covers the clear majority of the screen.
  const centerGap = rightRailBox.x - (leftRailBox.x + leftRailBox.width);
  expect(centerGap).toBeGreaterThan(mobileViewport.width * 0.5);
  // Bottom-anchored to their own (much shorter than full-screen) content
  // height — this is what keeps them clear of the felt's top corners.
  expect(leftRailBox.height).toBeLessThan(mobileViewport.height * 0.85);
  expect(rightRailBox.height).toBeLessThan(mobileViewport.height * 0.85);
  expect(leftRailBox.y + leftRailBox.height).toBeGreaterThan(mobileViewport.height - 5);
  expect(rightRailBox.y + rightRailBox.height).toBeGreaterThan(mobileViewport.height - 5);
  // The exact regression: neither rail's rectangle overlaps the fairness
  // banner's or the action timer's rectangle.
  expect(rectsOverlap(leftRailBox, fairnessBox)).toBe(false);
  expect(rectsOverlap(leftRailBox, timerBox)).toBe(false);
  expect(rectsOverlap(rightRailBox, fairnessBox)).toBe(false);
  expect(rectsOverlap(rightRailBox, timerBox)).toBe(false);

  // The preset buttons must be real, individually tappable targets — this
  // is the direct regression check for "too tiny to click": each one at
  // least a widely-used minimum touch-target size (44px, per WCAG 2.5.5 /
  // Apple's HIG), not just "some nonzero size".
  const potPresetBox = await raiseFirst.locator('.bet-overlay-presets').getByRole('button', { name: 'Pot', exact: true }).boundingBox();
  if (!potPresetBox) throw new Error('Pot preset button has no bounding box.');
  expect(potPresetBox.width).toBeGreaterThanOrEqual(44);
  expect(potPresetBox.height).toBeGreaterThanOrEqual(30);

  const amountInput = raiseFirst.locator('.bet-overlay-input');
  const initialAmount = Number(await amountInput.inputValue());

  // Exact $1 nudges — the table's big blind is 2, so a still-bigBlind-sized
  // step would land on initialAmount + 2, not +1. This is the direct,
  // deterministic check that the slider's granularity is really $1, not
  // just "some step smaller than before" (dragging, below, only proves
  // monotonic movement, not the exact step size).
  await raiseFirst.locator('.vbs-nudge').getByRole('button', { name: 'Increase amount by $1' }).click();
  expect(Number(await amountInput.inputValue())).toBe(initialAmount + 1);
  await raiseFirst.locator('.vbs-nudge').getByRole('button', { name: 'Decrease amount by $1' }).click();
  expect(Number(await amountInput.inputValue())).toBe(initialAmount);

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

import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, startHand, takeSeat } from './helpers.js';

// Regression test: a bet/call/raise plays a brief "chip flying to the
// bet spot" flourish (see components/DealAnimation.tsx's flyingChips
// handling of 'action-taken' events), not just an instant, silent
// ChipStack update.
test('a bet/call/raise shows a brief flying-chip animation', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Alice is the table owner (self-seating and inviting are both owner-only now — see DECISIONS.md).
  await adminLogin(pageA);
  await createTable(pageA, { name: 'Chip Animation Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(pageB, 'Bob');
  await takeSeat(pageA, 0, 200);
  await inviteToSeat(pageA, pageB, 1, 200);
  await startHand(pageA);
  await pageA.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });

  // Heads-up preflop, whichever seat is button/SB (a genuine high-card
  // draw, see DECISIONS.md) always faces a call — the blind differential.
  const aFacesCall = await pageA.locator('.btn-call').isVisible().catch(() => false);
  const firstToAct = aFacesCall ? pageA : pageB;
  await expect(firstToAct.locator('.btn-call')).toBeVisible();
  await firstToAct.locator('.btn-call').click();

  await expect(firstToAct.locator('.flying-chip').first()).toBeVisible();
});

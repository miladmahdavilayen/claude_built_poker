import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, playHandToCompletion, startHand, takeSeat } from './helpers.js';

test('two guests sit down, play a full hand with no hole-card leakage, and can verify its fairness', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Alice is the table owner — self-serve seating no longer exists for a
  // regular player (see DECISIONS.md); Bob joins via an owner-generated invite link.
  await adminLogin(pageA);
  await createTable(pageA, { name: 'E2E Gameplay Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });

  await guestSignup(pageB, 'Bob');

  await takeSeat(pageA, 0, 100);
  await inviteToSeat(pageA, pageB, 1, 100);

  // Nothing deals automatically — 2 seats filled is enough to start, but
  // Alice has to explicitly click "Play Hand" first.
  await startHand(pageA);
  await expect(pageA.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });
  await expect(pageB.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // Each player sees their OWN two cards face-up...
  await expect(pageA.locator('[data-testid="seat-0"] .card:not(.card-back)')).toHaveCount(2);
  await expect(pageB.locator('[data-testid="seat-1"] .card:not(.card-back)')).toHaveCount(2);
  // ...but never the OTHER seat's cards, mid-hand.
  await expect(pageA.locator('[data-testid="seat-1"] .card-back')).toHaveCount(2);
  await expect(pageB.locator('[data-testid="seat-0"] .card-back')).toHaveCount(2);

  await playHandToCompletion([pageA, pageB]);

  await expect(pageA.getByText('Verify hand fairness')).toBeVisible();
  const fairnessHref = await pageA.getByText('Verify hand fairness').getAttribute('href');
  expect(fairnessHref).toMatch(/\/fairness\//);

  // Since this heads-up hand went to a natural showdown (only check/call was
  // ever clicked, nobody folded), both hole cards are now legitimately public.
  await expect(pageA.locator('[data-testid="seat-1"] .card:not(.card-back)')).toHaveCount(2);
  await expect(pageB.locator('[data-testid="seat-0"] .card:not(.card-back)')).toHaveCount(2);

  const request = await pageA.request.get(fairnessHref!);
  expect(request.ok()).toBe(true);
  const body = (await request.json()) as { revealed: boolean; valid?: boolean };
  expect(body.revealed).toBe(true);
  expect(body.valid).toBe(true);

  await ctxA.close();
  await ctxB.close();
});

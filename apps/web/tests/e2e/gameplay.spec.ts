import { expect, test } from '@playwright/test';
import { createTable, guestSignup, playHandToCompletion, takeSeat } from './helpers.js';

test('two guests sit down, play a full hand with no hole-card leakage, and can verify its fairness', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await guestSignup(pageA, 'Alice');
  await createTable(pageA, { name: 'E2E Gameplay Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageA.url();

  await guestSignup(pageB, 'Bob');
  await pageB.goto(tableUrl);

  await takeSeat(pageA, 0, 100);
  await takeSeat(pageB, 1, 100);

  // A hand deals automatically once 2 seats are filled — wait for the fairness
  // commitment to appear, which only exists once a hand is in progress.
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

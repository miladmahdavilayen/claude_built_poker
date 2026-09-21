import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, takeSeat } from './helpers.js';

test('a player not seated can join and leave the waitlist, and everyone sees the queue', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Grace is the table owner (self-seating is owner-only now — see DECISIONS.md).
  await adminLogin(pageA);
  // Only one seat gets taken below, so no hand ever deals — keeps this test
  // focused purely on the waitlist wiring, not hand lifecycle.
  await createTable(pageA, { name: 'E2E Waitlist Table', smallBlind: 1, bigBlind: 2, maxSeats: 4, isPrivate: false });
  const tableUrl = pageA.url();
  await takeSeat(pageA, 0, 100);

  await guestSignup(pageB, 'Heidi');
  await pageB.goto(tableUrl);

  await expect(pageB.getByRole('button', { name: 'Join waitlist' })).toBeVisible();
  await pageB.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(pageB.getByRole('button', { name: 'Leave waitlist (#1)' })).toBeVisible();

  // The queue itself is visible to everyone at the table, including the seated player.
  await expect(pageA.getByText('Heidi')).toBeVisible();

  await pageB.getByRole('button', { name: 'Leave waitlist (#1)' }).click();
  await expect(pageB.getByRole('button', { name: 'Join waitlist' })).toBeVisible();
  await expect(pageA.getByText('Heidi')).not.toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

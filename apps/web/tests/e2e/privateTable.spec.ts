import { expect, test } from '@playwright/test';
import { createTable, guestSignup, tableIdFromUrl } from './helpers.js';

test('a private table rejects joining without the invite code, and admits joining with it', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await guestSignup(pageA, 'Carol');
  const link = await createTable(pageA, { name: 'E2E Private Table', smallBlind: 1, bigBlind: 2, maxSeats: 4, isPrivate: true });
  expect(link).toBeTruthy();
  const tableId = tableIdFromUrl(link!);
  const code = new URL(link!).searchParams.get('code');
  expect(code).toBeTruthy();

  await guestSignup(pageB, 'Dave');

  // A private table must not appear in the public lobby listing.
  await expect(pageB.getByText('E2E Private Table')).not.toBeVisible();

  // Navigating straight to the table id, with no code, must be rejected —
  // and must show no table state (no seats, no board) while rejected.
  await pageB.goto(`/table/${tableId}`);
  await expect(pageB.getByRole('heading', { name: 'This table is private' })).toBeVisible();
  await expect(pageB.locator('[data-testid^="seat-"]')).toHaveCount(0);

  // The same table, with the correct code, is admitted.
  await pageB.goto(`/table/${tableId}?code=${code}`);
  await expect(pageB.locator('[data-testid="seat-0"]')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

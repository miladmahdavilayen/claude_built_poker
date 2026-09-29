import { expect, test } from '@playwright/test';
import { addBot, adminLogin, createTable, guestSignup, takeSeat } from './helpers.js';

// This sandbox has no real Google Cloud OAuth Client ID to drive an actual
// "sign in with Google" click-through with (see googleSignIn.spec.ts's own
// comment) — Google explicitly disallows automating its own consent
// screens anyway. The genuinely NEW permission this feature adds (a
// signed-in non-guest human can self-serve seat themselves and add bots,
// but ONLY on the table they created) is instead verified at the protocol
// level, with a real non-guest account created directly in the store —
// see apps/server/tests/socketServer.test.ts's "a signed-in (non-guest)
// human can self-serve seat..." test. What's covered here, using the
// admin account as a stand-in real (non-guest) human, is the actual UI
// wiring: the create/self-seat/add-bot flow works end to end in a real
// browser, and the guest-facing restriction (no "Create table" at all)
// and the new admin/profile pages render and function correctly.

test('a guest never sees "Create table" — only a signed-in human (or the admin) can', async ({ page }) => {
  await guestSignup(page, 'Gary');
  await expect(page.getByRole('button', { name: '+ Create table' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Join private table/ })).toBeVisible();
});

test('a signed-in human can create their own table, sit themselves down, and add a bot, all self-serve', async ({ page }) => {
  // Admin is also a genuine non-guest account (isGuest: false) — this
  // proves the CREATE → SELF-SEAT → ADD-BOT UI flow itself works; the
  // narrower claim that a REGULAR (non-admin) human gets this same
  // ability only on their OWN table is proven server-side (see this
  // file's own top comment).
  await adminLogin(page);
  await createTable(page, { name: 'My Practice Table', smallBlind: 1, bigBlind: 2, maxSeats: 4, isPrivate: false });
  await expect(page.locator('[data-testid="seat-0"]').getByText('Sit here')).toBeVisible();

  await takeSeat(page, 0, 100);
  await expect(page.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'active');

  await addBot(page, 1, 'nit', 100);
  await expect(page.locator('[data-testid="seat-1"]').getByText('🤖 bot')).toBeVisible();
});

test('the login page offers only Google and guest — no self-registration — with a small hidden admin-login trigger', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Display name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play now' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);

  await page.locator('.admin-login-trigger').click();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
});

test('profile page shows a signed-in human’s balance and history, and never offers to delete the admin account', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/profile');
  await expect(page.getByText('My profile')).toBeVisible();
  await expect(page.getByText('Balance', { exact: true })).toBeVisible();
  await expect(page.getByText('Net result from playing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete my account' })).toHaveCount(0);
});

test('admin dashboard lists every account and can adjust a guest’s balance and rename them', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  const guestPage = await guestCtx.newPage();

  await guestSignup(guestPage, 'Wendy');
  await adminLogin(adminPage);
  await adminPage.goto('/admin');

  await adminPage.getByPlaceholder('Search by name or email...').fill('Wendy');
  const wendyRow = adminPage.locator('.admin-user-row', { hasText: 'Wendy' });
  await expect(wendyRow).toBeVisible();
  await wendyRow.click();

  const detail = adminPage.locator('.admin-user-detail');
  const balanceValue = detail.locator('.profile-stat-card', { hasText: 'Balance' }).locator('.stat-value');
  await expect(balanceValue).toHaveText('$5,000'); // guest starting grant

  await detail.getByLabel(/Adjust balance/).fill('500');
  await detail.getByLabel('Reason').fill('E2E test bonus');
  await detail.getByRole('button', { name: 'Apply' }).click();
  await expect(balanceValue).toHaveText('$5,500');

  const nameInput = detail.getByLabel('Display name');
  await nameInput.fill('Wendy Updated');
  await detail.getByRole('button', { name: 'Save name' }).click();
  await expect(adminPage.locator('.admin-user-detail-header').getByText('Wendy Updated')).toBeVisible();
  await expect(adminPage.locator('.admin-user-row', { hasText: 'Wendy Updated' })).toBeVisible();

  await adminCtx.close();
  await guestCtx.close();
});

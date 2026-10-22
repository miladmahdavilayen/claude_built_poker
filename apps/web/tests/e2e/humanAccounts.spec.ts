import { expect, test } from '@playwright/test';
import { addBot, adminLogin, createAccessKey, createTable, googlePlayerLogin, guestSignup, seedRealAccount, takeSeat } from './helpers.js';

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

test('a guest never sees "Create table" — only the admin can', async ({ page }) => {
  await guestSignup(page, 'Gary');
  await expect(page.getByRole('button', { name: '+ Create table' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Join private table/ })).toBeVisible();
});

test('the admin can create a table, sit themselves down, and add a bot, all self-serve', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'My Practice Table', smallBlind: 1, bigBlind: 2, maxSeats: 4, isPrivate: false });
  await expect(page.locator('[data-testid="seat-0"]').getByText('Sit here')).toBeVisible();

  await takeSeat(page, 0, 100);
  await expect(page.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'active');

  await addBot(page, 1, 'nit', 100);
  await expect(page.locator('[data-testid="seat-1"]').getByText('🤖 bot')).toBeVisible();
});

test('the landing page offers an invitation or an access key — the key gates Google sign-up — with a small hidden admin-login trigger', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Invitation link or code')).toBeVisible();
  await expect(page.getByLabel('Access key')).toBeVisible();
  await expect(page.locator('.google-signin-row')).toHaveCount(0);
  await expect(page.getByLabel('Display name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play now' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);

  await page.getByLabel('Invitation link or code').fill('not an invite');
  await page.getByRole('button', { name: 'Join table' }).click();
  await expect(page.getByText("doesn't look like an invitation")).toBeVisible();
  await page.getByLabel('Invitation link or code').fill('00000000-0000-4000-8000-000000000000');
  await page.getByRole('button', { name: 'Join table' }).click();
  await expect(page.getByText('invalid or has already been used')).toBeVisible();

  await page.getByLabel('Access key').fill('wrong key');
  await page.getByRole('button', { name: 'Continue to sign up' }).click();
  await expect(page.getByText('That access key isn’t valid')).toBeVisible();
  await page.getByLabel('Access key').fill(await createAccessKey('Landing test'));
  await page.getByRole('button', { name: 'Continue to sign up' }).click();
  await expect(page.getByText('Create your account with Google')).toBeVisible();
  await page.getByRole('button', { name: '← Back' }).click();

  await page.locator('.admin-login-trigger').click();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
});

test('profile page shows only registration info, and never offers to delete the admin account', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/profile');
  await expect(page.getByText('My profile')).toBeVisible();
  await expect(page.locator('.profile-fields')).toContainText('admin@pokerclause.local');
  await expect(page.locator('.profile-fields')).toContainText('Email and password');
  await expect(page.getByText('Balance', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete my account' })).toHaveCount(0);
});

test('a Google player: $1,000 welcome bonus, a bots-only table of the size they pick, deleted when they leave; delete account and re-register gets their balance back', async ({ page }) => {
  const email = `e2e.player.${String(Date.now())}@gmail.com`;
  await googlePlayerLogin(page, email, 'Polly');
  await expect(page.getByTestId('lobby-balance')).toHaveText('$1,000');
  // No public tables, no table creation, no private-table join — just their own game.
  await expect(page.locator('.table-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Create table/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Join private table/ })).toHaveCount(0);

  await page.getByRole('radio', { name: '4 bots' }).click();
  await expect(page.getByText('5 seats — you plus 4 computer players')).toBeVisible();
  await page.getByRole('radio', { name: /\$1\/\$2/ }).click();
  await page.getByLabel(/Buy-in/).fill('150');
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/table\//);
  const tableUrl = page.url();

  await expect(page.locator('[data-testid^="seat-"]')).toHaveCount(5);
  await expect(page.locator('[data-testid="seat-0"]')).toContainText('Polly');
  await expect(page.getByText('🤖 bot')).toHaveCount(4);
  await expect(page.locator('.seat-tag', { hasText: 'practice' })).toBeVisible();
  // Bots only: no table menu, no invite/sit buttons, no waitlist, no voice.
  await expect(page.locator('.owner-menu-toggle')).toHaveCount(0);
  await expect(page.getByText('+ Assign human')).toHaveCount(0);
  await expect(page.getByText('Sit here')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Join voice/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Leave table' }).click();
  await expect(page).toHaveURL(/\/lobby/);
  await expect(page.getByTestId('lobby-balance')).toHaveText('$1,000');
  // The table is gone for good.
  await page.goto(tableUrl);
  await expect(page.getByText('Table not found')).toBeVisible();

  await page.goto('/profile');
  await expect(page.locator('.profile-fields')).toContainText(email);
  await expect(page.locator('.profile-fields')).toContainText('Google');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await page.getByLabel(/Type/).fill('delete my account');
  await page.getByRole('button', { name: 'Permanently delete' }).click();
  await expect(page).toHaveURL(/\/login/);
  // Account gone: this browser no longer greets them as a member.
  await expect(page.getByLabel('Access key')).toBeVisible();

  // Same person, same email (Gmail ignores dots and case): their $1,000 is
  // back — what they had when they deleted — and it isn't a second bonus.
  await googlePlayerLogin(page, email.replace('e2e.', 'E2E'), 'Polly Again');
  await expect(page.getByTestId('lobby-balance')).toHaveText('$1,000');
  await expect(page.getByRole('button', { name: 'Start game' })).toBeEnabled();
});

// A guest is never persisted at all anymore (see HybridStore /
// DECISIONS.md) — "Wendy" here is a real account, seeded directly on the
// server (this sandbox can't drive an actual Google sign-in — see this
// file's own top comment), which is what makes her visible/manageable
// from the admin dashboard in the first place.
test('admin dashboard lists a real account and can adjust their balance and rename them', async ({ page }) => {
  await adminLogin(page);
  await seedRealAccount(page, 'Wendy');
  await page.goto('/admin');

  await page.getByPlaceholder('Search by name or email...').fill('Wendy');
  const wendyRow = page.locator('.admin-user-row', { hasText: 'Wendy' });
  await expect(wendyRow).toBeVisible();
  await wendyRow.click();

  const detail = page.locator('.admin-user-detail');
  const balanceValue = detail.locator('.profile-stat-card', { hasText: 'Balance' }).locator('.stat-value');
  await expect(balanceValue).toHaveText('$1,000'); // the welcome bonus — see authService.ts

  await detail.getByLabel(/Amount in \$/).fill('500');
  await detail.getByLabel('Reason').fill('E2E test bonus');
  await detail.getByRole('button', { name: 'Add to balance' }).click();
  await expect(balanceValue).toHaveText('$1,500');

  // Or set it to an exact amount instead of adding.
  await detail.getByLabel(/Amount in \$/).fill('75.5');
  await detail.getByRole('button', { name: 'Set balance to this' }).click();
  await expect(balanceValue).toHaveText('$75.50');

  const nameInput = detail.getByLabel('Display name');
  await nameInput.fill('Wendy Updated');
  await detail.getByRole('button', { name: 'Save name' }).click();
  await expect(page.locator('.admin-user-detail-header').getByText('Wendy Updated')).toBeVisible();
  await expect(page.locator('.admin-user-row', { hasText: 'Wendy Updated' })).toBeVisible();
});

test('a guest never appears in the admin dashboard — nothing about them is ever persisted', async ({ browser }) => {
  const guestCtx = await browser.newContext();
  const guestPage = await guestCtx.newPage();
  await guestSignup(guestPage, 'ExcludedGuest');
  await guestCtx.close();

  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await adminLogin(adminPage);
  await adminPage.goto('/admin');
  await adminPage.getByPlaceholder('Search by name or email...').fill('ExcludedGuest');
  await expect(adminPage.getByText('No users match.')).toBeVisible();
  await expect(adminPage.locator('.admin-user-row')).toHaveCount(0);
  await adminCtx.close();
});

test('admin can swipe a row left to reveal and use a per-row delete action', async ({ page }) => {
  await adminLogin(page);
  await seedRealAccount(page, 'SwipeTarget');
  await page.goto('/admin');
  await page.getByPlaceholder('Search by name or email...').fill('SwipeTarget');
  // The game reports panel above loads on its own; let it settle so the row
  // isn't pushed down between measuring it and dragging it.
  await expect(page.locator('.admin-reports')).not.toContainText('Loading…');

  const rowWrap = page.locator('.admin-user-row-wrap', { has: page.locator('.admin-user-row', { hasText: 'SwipeTarget' }) });
  const row = rowWrap.locator('.admin-user-row');
  // With games on record the reports panel can push the player list below
  // the fold — and a mouse drag only lands on what's inside the viewport.
  await row.scrollIntoViewIfNeeded();
  const beforeBox = await row.boundingBox();
  if (!beforeBox) throw new Error('Row has no bounding box.');

  // A real drag gesture, not a synthetic CSS check — this is what
  // actually exercises the pointer handlers, same as a finger would.
  await page.mouse.move(beforeBox.x + beforeBox.width - 20, beforeBox.y + beforeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeBox.x - 100, beforeBox.y + beforeBox.height / 2, { steps: 12 });
  await page.mouse.up();

  const afterBox = await row.boundingBox();
  expect(afterBox!.x).toBeLessThan(beforeBox.x); // the row visibly slid left, revealing the action underneath

  // Only actually clickable once genuinely uncovered by the swipe — a
  // click here would fail Playwright's own actionability check otherwise.
  await rowWrap.locator('.admin-user-row-delete-action').click();
  await expect(page.locator('.admin-user-row', { hasText: 'SwipeTarget' })).toHaveCount(0);
});

test('admin can select multiple accounts (or select all) and delete them in one action', async ({ page }) => {
  await adminLogin(page);
  await seedRealAccount(page, 'BulkOne');
  await seedRealAccount(page, 'BulkTwo');
  await page.goto('/admin');
  await page.getByPlaceholder('Search by name or email...').fill('Bulk');
  await expect(page.locator('.admin-user-row', { hasText: /^Bulk/ })).toHaveCount(2);

  await page.getByLabel('Select all').check();
  const bulkButton = page.getByRole('button', { name: /Delete 2 selected/ });
  await expect(bulkButton).toBeVisible();
  await bulkButton.click();

  await expect(page.locator('.admin-user-row', { hasText: /^Bulk/ })).toHaveCount(0);
});

test('the owner can set their own balance to an exact amount, and add to it, from the admin page', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/admin');
  const card = page.getByTestId('admin-my-balance');
  await expect(card).toBeVisible();

  await card.getByLabel('Amount in $').fill('12345.67');
  await card.getByRole('button', { name: 'Set my balance to this' }).click();
  await expect(card.getByText('Your balance is now $12,345.67.')).toBeVisible();
  await expect(card.locator('.admin-my-balance-value')).toHaveText('$12,345.67');

  await card.getByLabel('Amount in $').fill('100');
  await card.getByRole('button', { name: 'Add to my balance' }).click();
  await expect(card.locator('.admin-my-balance-value')).toHaveText('$12,445.67');

  // Past the $20,000,000 ceiling is refused, and nothing changes.
  await card.getByLabel('Amount in $').fill('25000000');
  await card.getByRole('button', { name: 'Set my balance to this' }).click();
  await expect(card.locator('.error-banner')).toBeVisible();
  await expect(card.locator('.admin-my-balance-value')).toHaveText('$12,445.67');
});

test('a returning player who logged out is greeted with Google sign-in, not the access key', async ({ page }) => {
  await googlePlayerLogin(page, `e2e.returning.${String(Date.now())}@gmail.com`, 'Ronnie');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('Welcome back')).toBeVisible();
  await expect(page.getByLabel('Access key')).toHaveCount(0);
  await page.getByRole('button', { name: 'New here, or invited to a table?' }).click();
  await expect(page.getByLabel('Access key')).toBeVisible();
});

test('a new Google player must agree to the friendly-game waiver with their initials before playing — once', async ({ page, browser }) => {
  const email = `e2e.waiver.${String(Date.now())}@gmail.com`;
  const res = await page.request.post('http://localhost:4210/test-only/google-login', { data: { email, displayName: 'Wanda Waiver' } });
  expect(res.ok()).toBe(true);
  // Every page leads to the waiver until they agree.
  for (const path of ['/lobby', '/profile', '/table/anything']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/waiver/);
  }
  await expect(page.getByText('Friendly game agreement')).toBeVisible();
  await expect(page.getByText('play money only')).toBeVisible();
  await expect(page.getByText('give up any right to sue')).toBeVisible();
  const agree = page.getByRole('button', { name: 'I agree' });
  await expect(agree).toBeDisabled();
  await page.getByLabel(/Your initials/).fill('w.w');
  await expect(agree).toBeDisabled();
  await page.getByLabel(/Your initials/).fill('ww');
  await expect(page.getByLabel(/Your initials/)).toHaveValue('WW');
  await agree.click();
  await expect(page.locator('.practice-card')).toBeVisible();

  // Agreed for good: a reload goes straight to the lobby.
  await page.reload();
  await expect(page.locator('.practice-card')).toBeVisible();

  // And the owner can see it on the account.
  const ownerPage = await (await browser.newContext()).newPage();
  await adminLogin(ownerPage);
  await ownerPage.goto('/admin');
  await ownerPage.getByPlaceholder('Search by name or email...').fill('Wanda Waiver');
  await ownerPage.locator('.admin-user-row', { hasText: 'Wanda Waiver' }).click();
  await expect(ownerPage.locator('.admin-user-detail')).toContainText('Agreed (WW)');
  await ownerPage.context().close();
});

test('declining the waiver logs the player out', async ({ page }) => {
  const res = await page.request.post('http://localhost:4210/test-only/google-login', {
    data: { email: `e2e.decline.${String(Date.now())}@gmail.com`, displayName: 'Dee Cline' },
  });
  expect(res.ok()).toBe(true);
  await page.goto('/lobby');
  await page.getByRole('button', { name: /I don’t agree/ }).click();
  await expect(page.getByText('Welcome back')).toBeVisible();
});

test('the owner generates a one-time access key; it registers exactly one new player, and then shows as used', async ({ page, browser }) => {
  await adminLogin(page);
  await page.goto('/admin');
  const panel = page.getByTestId('admin-access-keys');
  await panel.getByLabel('Who it’s for').fill('Kim from work');
  await panel.getByRole('button', { name: 'Generate key' }).click();
  const key = (await page.getByTestId('fresh-access-key').locator('.admin-key-value').textContent())!.trim();
  expect(key).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  const row = panel.locator('.admin-key-row', { hasText: 'Kim from work' });
  await expect(row).toContainText('Active');
  await expect(row).toContainText(`…${key.slice(-4)}`);

  // A new visitor: the key gets them to Google sign-up…
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto('/');
  await visitor.getByLabel('Access key').fill(key.toLowerCase());
  await visitor.getByRole('button', { name: 'Continue to sign up' }).click();
  await expect(visitor.getByText('Create your account with Google')).toBeVisible();
  // …and registering with it (standing in for Google's button) uses it up.
  const email = `e2e.kim.${String(Date.now())}@gmail.com`;
  const signup = await visitor.request.post('http://localhost:4210/test-only/google-login', { data: { email, displayName: 'Kim', signupKey: key } });
  expect(signup.ok()).toBe(true);

  await page.reload();
  await expect(page.getByTestId('admin-access-keys').locator('.admin-key-row', { hasText: 'Kim from work' })).toContainText('Used');
  await expect(page.getByTestId('admin-access-keys').locator('.admin-key-row', { hasText: 'Kim from work' })).toContainText('registered Kim');

  // Spent: nobody else gets in with it.
  const second = await (await browser.newContext()).newPage();
  await second.goto('/');
  await second.getByLabel('Access key').fill(key);
  await second.getByRole('button', { name: 'Continue to sign up' }).click();
  await expect(second.getByText('That access key isn’t valid')).toBeVisible();
  const reuse = await second.request.post('http://localhost:4210/test-only/google-login', { data: { email: `other.${email}`, displayName: 'Other', signupKey: key } });
  expect(reuse.status()).toBe(403);
});

test('a revoked access key stops working straight away', async ({ page, browser }) => {
  await adminLogin(page);
  await page.goto('/admin');
  const panel = page.getByTestId('admin-access-keys');
  await panel.getByLabel('Who it’s for').fill('Revoke me');
  await panel.getByRole('button', { name: 'Generate key' }).click();
  const key = (await page.getByTestId('fresh-access-key').locator('.admin-key-value').textContent())!.trim();
  const row = panel.locator('.admin-key-row', { hasText: 'Revoke me' });
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toContainText('Revoked');

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto('/');
  await visitor.getByLabel('Access key').fill(key);
  await visitor.getByRole('button', { name: 'Continue to sign up' }).click();
  await expect(visitor.getByText('That access key isn’t valid')).toBeVisible();
});

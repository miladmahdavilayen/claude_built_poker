import { expect, test } from '@playwright/test';
import { guestSignup } from './helpers.js';

// Regression test: the refresh token is single-use and rotates on every
// call. React StrictMode double-invokes effects in development, which
// used to fire two concurrent /auth/refresh requests on mount — the
// request that lost the race to consume the token got a 401, and if its
// promise settled after the winner's, it clobbered good session state
// right back to "logged out". Fixed by deduping to one shared in-flight
// promise in AuthContext.tsx (`refreshOnce`).
test('a hard page reload keeps the session logged in via the refresh cookie', async ({ page }) => {
  await guestSignup(page, 'ReloadUser');
  await expect(page.getByText('ReloadUser')).toBeVisible();

  await page.reload();
  await expect(page.getByText('ReloadUser')).toBeVisible({ timeout: 5000 });
});

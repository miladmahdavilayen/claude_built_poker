import { expect, test } from '@playwright/test';
import { guestSignup } from './helpers.js';

// This sandbox has no real Google Cloud OAuth Client ID to test the actual
// "click the button, sign in with a real Google account" flow with — that
// inherently requires credentials only the person deploying this app can
// provide (see README.md's Google sign-in setup section), and Google
// explicitly disallows automating its own consent screens anyway. What IS
// fully testable, and matters just as much for "guests should still be
// able to play": that the app degrades gracefully with zero Google
// configuration, which is exactly the state these E2E tests run in
// (playwright.config.ts sets neither GOOGLE_CLIENT_ID nor
// VITE_GOOGLE_CLIENT_ID for the webServer).
test('with no Google configuration, the server reports it unavailable, the sign-in button is absent, and guest play is unaffected', async ({
  page,
  request,
}) => {
  const availability = await request.get('http://localhost:4210/auth/google/available');
  expect(await availability.json()).toEqual({ available: false });

  // The front page is Google sign-in only: with nothing configured, the
  // button doesn't render and the visitor is told sign-in isn't available —
  // and guest play (the way an owner-invited player gets in) is unaffected.
  await page.goto('/');
  await expect(page.locator('.google-signin-row iframe')).toHaveCount(0);
  await expect(page.getByText('Sign-in isn’t available right now')).toBeVisible();

  await guestSignup(page, 'NoGoogleGuest');
  await expect(page.getByText('NoGoogleGuest')).toBeVisible();
});

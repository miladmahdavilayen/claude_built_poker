import { expect, test } from '@playwright/test';

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

  await page.goto('/');
  await expect(page.getByText('Play as guest')).toBeVisible();
  // No Google button container should be rendered at all.
  await expect(page.locator('.google-signin-row div')).toHaveCount(0);

  await page.getByLabel('Display name').fill('NoGoogleGuest');
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(page).toHaveURL(/\/lobby/);
  await expect(page.getByText('NoGoogleGuest')).toBeVisible();
});

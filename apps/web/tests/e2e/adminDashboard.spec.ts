import { expect, test } from '@playwright/test';
import { adminLogin, createTable, openAdminSection } from './helpers.js';

const API = 'http://localhost:4210';

test('a guest ticks "I agree" to join by an invite, and the owner finds them — tagged, with the name they were given and their agreement', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  await createTable(owner, { name: 'Terms Table', smallBlind: 1, bigBlind: 2, maxSeats: 4, isPrivate: false });
  await owner.locator('[data-testid="seat-1"]').locator('.seat-empty-tap').click();
  await owner.getByRole('menuitem', { name: 'Invite a player to this seat' }).click();
  await owner.getByLabel('Nickname (only visible to you)').fill('Cousin Vinny');
  await owner.getByLabel(/Buy-in/).fill('100');
  await owner.getByRole('button', { name: 'Generate link' }).click();
  const link = await owner.locator('.assign-link-input').inputValue();
  await owner.getByRole('button', { name: 'Done' }).click();

  // The guest reads the short terms, and can't play until they tick the box.
  const guest = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone) E2EGuest' })).newPage();
  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: 'Guest terms' })).toBeVisible();
  await expect(guest.getByText('Chips are play money only')).toBeVisible();
  await guest.getByLabel('Display name').fill('Vinnie');
  const play = guest.getByRole('button', { name: 'Play now' });
  await expect(play).toBeDisabled();
  await guest.getByLabel('I’ve read and agree to the guest terms').check();
  await play.click();
  await expect(guest.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 10_000 });

  // The owner: Players, filtered to invited guests, finds them by the name they gave the invite.
  await owner.goto('/admin');
  await owner.getByRole('button', { name: /^Invited guests/ }).click();
  await owner.getByPlaceholder('Search by name or email...').fill('cousin vinny');
  const row = owner.locator('.admin-user-row', { hasText: 'Vinnie' });
  await expect(row).toContainText('Guest · invited');
  await expect(row).toContainText('“Cousin Vinny”');
  await expect(row).toContainText('Terms Table');
  // Not a registered player.
  await owner.getByRole('button', { name: /^Registered/ }).click();
  await expect(row).toHaveCount(0);
  await owner.getByRole('button', { name: /^Invited guests/ }).click();
  await row.click();
  const detail = owner.getByTestId('guest-detail');
  await expect(detail).toContainText('Cousin Vinny');
  await expect(detail).toContainText('Your seat invite');
  const agreement = owner.getByTestId('guest-agreement');
  await expect(agreement).toContainText('Agreed');
  await expect(agreement).toContainText('IP address');
  await expect(agreement).toContainText('iPhone');
  await expect(agreement).toContainText('E2EGuest');
});

test('a deleted account moves to Deleted users — kept whole — and the same person can sign up again with what they had', async ({ page, playwright }) => {
  const email = `e2e.leaver.${String(Date.now())}@gmail.com`;
  // The player's own requests, in their own cookie jar — not the owner's page's.
  const player = await playwright.request.newContext();
  const signUp = () => player.post(`${API}/test-only/google-login`, { data: { email, displayName: 'Lee Leaver' } });
  const first = (await (await signUp()).json()) as { accessToken: string; user: { chips: number } };
  expect(first.user.chips).toBe(100_000);
  expect((await player.delete(`${API}/users/me`, { headers: { authorization: `Bearer ${first.accessToken}` } })).ok()).toBe(true);

  await adminLogin(page);
  await page.goto('/admin');
  await page.getByPlaceholder('Search by name or email...').fill(email);
  await expect(page.locator('.admin-user-row')).toHaveCount(0);
  await expect(page.getByText('No players match.')).toBeVisible();

  await openAdminSection(page, 'Deleted users');
  const deleted = page.getByTestId('admin-deleted-users');
  await deleted.getByLabel('Search deleted users').fill(email);
  await deleted.locator('.admin-deleted-row', { hasText: email }).click();
  const detail = page.getByTestId('deleted-user-detail');
  await expect(detail).toContainText('Lee Leaver');
  await expect(detail).toContainText('$1,000');
  await expect(detail).toContainText('by them');
  await expect(detail).toContainText('Welcome bonus');

  // Back again: a normal sign-up, with the $1,000 they left with — not a second bonus.
  const again = (await (await signUp()).json()) as { user: { chips: number } };
  expect(again.user.chips).toBe(100_000);
  await page.reload();
  await page.getByPlaceholder('Search by name or email...').fill(email);
  const back = page.getByTestId('admin-section-players').locator('.admin-user-row', { hasText: email });
  await expect(back).toContainText('Registered');
  await back.click();
  await expect(page.locator('.admin-user-detail')).toContainText('Balance restored (re-registered)');
  await player.dispose();
});

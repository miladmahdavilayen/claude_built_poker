import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat } from './helpers.js';

// Regression test for the owner-only chip economy end to end (see
// DECISIONS.md): a regular player sees no self-serve seating/rebuy
// affordances at all, the owner sees them plus an "Assign human" flow
// that generates a real, redeemable, exact-amount invite link, and the
// owner can rebuy a seated human directly.
test('a regular player has no self-serve options; the owner assigns a seat via link and can rebuy it', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxAlice = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageAlice = await ctxAlice.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Owner Economy Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageOwner.url();

  await guestSignup(pageAlice, 'Alice');
  await pageAlice.goto(tableUrl);

  // Alice (not the owner) sees plain "Empty" seats — no "Sit here", no
  // "+ Add bot", no "+ Assign human" anywhere on the table.
  await expect(pageAlice.locator('[data-testid="seat-1"]').getByText('Sit here')).toHaveCount(0);
  await expect(pageAlice.locator('[data-testid="seat-1"]').getByText('+ Add bot')).toHaveCount(0);
  await expect(pageAlice.locator('[data-testid="seat-1"]').getByText('+ Assign human')).toHaveCount(0);
  await expect(pageAlice.locator('[data-testid="seat-1"]').getByText('Empty')).toBeVisible();

  // The owner sees all three on an empty seat.
  await expect(pageOwner.locator('[data-testid="seat-1"]').getByText('Sit here')).toBeVisible();
  await expect(pageOwner.locator('[data-testid="seat-1"]').getByText('+ Add bot')).toBeVisible();
  await expect(pageOwner.locator('[data-testid="seat-1"]').getByText('+ Assign human')).toBeVisible();

  // The owner assigns seat 1 to Alice with an exact buy-in via a generated link.
  await inviteToSeat(pageOwner, pageAlice, 1, 120);
  await expect(pageAlice.locator('[data-testid="seat-1"] .seat-stack')).toHaveText('$120');

  // Alice, now seated, still has no self-serve rebuy anywhere on the page.
  await expect(pageAlice.getByRole('button', { name: 'Rebuy' })).toHaveCount(0);

  // The owner sees a "Rebuy" control on Alice's seat specifically (not on empty seats, not on a bot).
  await expect(pageOwner.locator('[data-testid="seat-1"]').getByRole('button', { name: 'Rebuy' })).toBeVisible();
  await pageOwner.locator('[data-testid="seat-1"]').getByRole('button', { name: 'Rebuy' }).click();
  await expect(pageOwner.getByText('Rebuy seat 1')).toBeVisible();
  await pageOwner.getByLabel('Amount').fill('30');
  await pageOwner.locator('.modal').getByRole('button', { name: 'Confirm' }).click();

  await expect(pageAlice.locator('[data-testid="seat-1"] .seat-stack')).toHaveText('$150', { timeout: 10_000 });

  await ctxOwner.close();
  await ctxAlice.close();
});

// Regression test: opening an owner-generated invite link used to lose
// the destination entirely for a visitor who wasn't signed in yet — the
// auth guard bounced them to /login with no memory of where they were
// headed, and after entering a name they landed on the generic lobby,
// not the table (or seat) they were actually invited to. See
// DECISIONS.md.
test('a fresh visitor (not yet signed in) opening an invite link lands directly on that table, not the lobby', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxVisitor = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageVisitor = await ctxVisitor.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Fresh Visitor Invite Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageOwner.url();

  // Generate the invite link without seating anyone yet.
  await pageOwner.locator('[data-testid="seat-1"]').getByText('+ Assign human').click();
  await pageOwner.getByLabel(/Buy-in/).fill('130');
  await pageOwner.getByRole('button', { name: 'Generate link' }).click();
  const link = await pageOwner.locator('.assign-link-input').inputValue();
  await pageOwner.getByRole('button', { name: 'Done' }).click();

  // A totally fresh, never-authenticated visitor opens the link directly
  // (no prior guestSignup — that's the whole point of this test).
  await pageVisitor.goto(link);
  await expect(pageVisitor).toHaveURL(/\/login/);

  await pageVisitor.getByLabel('Display name').fill('Fresh Visitor');
  await pageVisitor.getByRole('button', { name: 'Play now' }).click();

  // Lands directly on the invited table — never the lobby — and the
  // invite link's own buy-in took effect automatically.
  await expect(pageVisitor).toHaveURL(tableUrl);
  await expect(pageVisitor.locator('[data-testid="seat-1"] .seat-stack')).toHaveText('$130');

  await ctxOwner.close();
  await ctxVisitor.close();
});

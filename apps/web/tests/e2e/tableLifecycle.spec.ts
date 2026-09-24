import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, takeSeat } from './helpers.js';

test('leaving a table navigates back to the lobby and genuinely frees the seat for someone else', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxCarol = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  // A second human, so the table doesn't auto-terminate when Alice
  // leaves (see the dedicated auto-terminate test below for that case) —
  // this test is specifically about the seat itself freeing up.
  const pageCarol = await ctxCarol.newPage();

  // Alice is the table owner (self-seating and inviting are both owner-only now — see DECISIONS.md).
  await adminLogin(pageA);
  await createTable(pageA, { name: 'Leave Test Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageA.url();
  await takeSeat(pageA, 0, 100);

  await guestSignup(pageCarol, 'Carol');
  await inviteToSeat(pageA, pageCarol, 1, 100);

  await pageA.getByRole('button', { name: 'Leave table' }).click();
  await expect(pageA).toHaveURL(/\/lobby/);

  // The seat is genuinely free now — Alice (still the owner, just no
  // longer seated) rejoins to invite Bob into it.
  await pageA.goto(tableUrl);
  await guestSignup(pageB, 'Bob');
  await inviteToSeat(pageA, pageB, 0, 100);
  await expect(pageB.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'active');

  await ctxA.close();
  await ctxB.close();
  await ctxCarol.close();
});

test('a table auto-terminates once the last human leaves, and any watching spectator is sent back to the lobby', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxSpec = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageSpec = await ctxSpec.newPage();

  await adminLogin(pageA);
  await createTable(pageA, { name: 'Auto Terminate Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageA.url();
  await takeSeat(pageA, 0, 100);

  await guestSignup(pageSpec, 'Watcher');
  await pageSpec.goto(tableUrl); // never takes a seat — a spectator
  // Make sure the spectator has genuinely joined the table's socket room
  // before Alice leaves — otherwise this races the 'table-closed'
  // broadcast against the spectator's own join, and a broadcast that
  // fires before a socket joins its room is simply never delivered to it.
  await expect(pageSpec.locator('[data-testid="seat-0"]')).toBeVisible();

  await pageA.getByRole('button', { name: 'Leave table' }).click();
  await expect(pageA).toHaveURL(/\/lobby/);
  // The spectator gets swept back to the lobby too, once the table closes.
  await expect(pageSpec).toHaveURL(/\/lobby/, { timeout: 10_000 });

  await ctxA.close();
  await ctxSpec.close();
});

test('the owner can terminate a table with confirmation, closing it for a seated player too', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxAlice = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageAlice = await ctxAlice.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Owner Terminate Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });

  await guestSignup(pageAlice, 'Alice');
  await inviteToSeat(pageOwner, pageAlice, 0, 100);

  // A non-owner never even sees the control.
  await expect(pageAlice.getByRole('button', { name: 'Terminate table' })).toHaveCount(0);

  await pageOwner.getByRole('button', { name: 'Terminate table' }).click();
  await expect(pageOwner.getByText('Terminate this table?')).toBeVisible();
  await pageOwner.getByRole('button', { name: 'Yes, terminate' }).click();

  await expect(pageOwner).toHaveURL(/\/lobby/);
  await expect(pageAlice).toHaveURL(/\/lobby/, { timeout: 10_000 });

  await ctxOwner.close();
  await ctxAlice.close();
});

test('an invited guest leaving the table gets a confirm first, then a hard end to their session — never the lobby', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxAlice = await browser.newContext();
  const ctxCarol = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageAlice = await ctxAlice.newPage();
  // A second seated human, so the table doesn't auto-terminate when Alice
  // leaves (see the dedicated auto-terminate test above for that case) —
  // this test is specifically about Alice's own leave-table flow.
  const pageCarol = await ctxCarol.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Guest Leave Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });

  await guestSignup(pageAlice, 'Alice');
  await inviteToSeat(pageOwner, pageAlice, 0, 100);
  await guestSignup(pageCarol, 'Carol');
  await inviteToSeat(pageOwner, pageCarol, 1, 100);

  // No lobby link at all for an invited guest — self-serve seating
  // doesn't exist, so there's genuinely nowhere for them to go back to.
  await expect(pageAlice.getByRole('link', { name: /Lobby/ })).toHaveCount(0);
  // The owner still has theirs, unaffected by any of this.
  await expect(pageOwner.getByRole('link', { name: /Lobby/ })).toBeVisible();

  await pageAlice.getByRole('button', { name: 'Leave table' }).click();
  await expect(pageAlice.getByText('Leave this table?')).toBeVisible();

  // Backing out leaves the guest exactly where they were — still seated.
  await pageAlice.getByRole('button', { name: 'No, stay' }).click();
  await expect(pageAlice.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'active');

  await pageAlice.getByRole('button', { name: 'Leave table' }).click();
  await pageAlice.getByRole('button', { name: 'Yes, leave' }).click();

  // Never the lobby — a dead-end page instead, with nothing that could
  // take them to the lobby, login, or account creation.
  await expect(pageAlice).toHaveURL(/\/left/, { timeout: 10_000 });
  await expect(pageAlice.getByText('left the table')).toBeVisible();
  await expect(pageAlice.getByRole('link')).toHaveCount(0);

  // The session is genuinely over — reloading (or any later navigation)
  // can't recover it, since the refresh cookie was actually revoked.
  await pageAlice.reload();
  await expect(pageAlice).toHaveURL(/\/left/);

  // The table's still alive (Carol's still seated) — just Alice's seat is
  // free now, for the owner to bring in someone new.
  await expect(pageCarol.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'empty', { timeout: 10_000 });
  await expect(pageCarol.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'active');

  await ctxOwner.close();
  await ctxAlice.close();
  await ctxCarol.close();
});

test('the owner can reset a table, freeing every seat while keeping the table itself alive at the same link', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxAlice = await browser.newContext();
  const pageOwner = await ctxOwner.newPage();
  const pageAlice = await ctxAlice.newPage();

  await adminLogin(pageOwner);
  await createTable(pageOwner, { name: 'Owner Reset Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = pageOwner.url();

  await guestSignup(pageAlice, 'Alice');
  await inviteToSeat(pageOwner, pageAlice, 0, 100);

  await pageOwner.getByRole('button', { name: 'Reset table' }).click();
  await expect(pageOwner.getByText('Reset this table?')).toBeVisible();
  await pageOwner.getByRole('button', { name: 'Yes, reset' }).click();

  // Both pages stay ON the table (it wasn't closed) — the seat just empties out.
  await expect(pageAlice.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'empty', { timeout: 10_000 });
  await expect(pageAlice).toHaveURL(tableUrl);

  // The table still works — a fresh invite + redemption right after.
  await inviteToSeat(pageOwner, pageAlice, 0, 100);
  await expect(pageAlice.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'active');

  await ctxOwner.close();
  await ctxAlice.close();
});

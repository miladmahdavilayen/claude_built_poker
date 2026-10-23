import { expect, test } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, openOwnerMenu, takeSeat } from './helpers.js';

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

test('a table stays in the lobby when the last human leaves — a watching spectator stays put too', async ({ browser }) => {
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
  // Still listed, and the seat is free again.
  await expect(pageA.locator('.table-card', { hasText: 'Auto Terminate Table' })).toBeVisible();
  await expect(pageSpec.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'empty');
  await pageSpec.waitForTimeout(1500);
  await expect(pageSpec).toHaveURL(tableUrl);

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

  // A non-owner never even sees the control — nor the owner menu it lives in.
  await expect(pageAlice.getByRole('button', { name: 'Table menu' })).toHaveCount(0);
  await expect(pageAlice.getByRole('button', { name: 'Terminate table' })).toHaveCount(0);

  await openOwnerMenu(pageOwner);
  await pageOwner.getByRole('button', { name: 'Terminate table' }).click();
  await expect(pageOwner.getByText('Terminate this table?')).toBeVisible();
  await pageOwner.getByRole('button', { name: 'Yes, terminate' }).click();

  await expect(pageOwner).toHaveURL(/\/lobby/);
  await expect(pageAlice).toHaveURL(/\/lobby/, { timeout: 10_000 });

  await ctxOwner.close();
  await ctxAlice.close();
});

test('an invited guest can leave (after a confirm) without closing the table — and rejoin by the same link, here or on another device, as the same guest', async ({ browser }) => {
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

  // Never the lobby — a page with just the way back in.
  await expect(pageAlice).toHaveURL(/\/left/, { timeout: 10_000 });
  await expect(pageAlice.getByRole('heading', { name: /left “Guest Leave Table”/ })).toBeVisible();
  await expect(pageAlice.getByRole('link')).toHaveCount(0);

  // The table's still alive (Carol's still seated) — only Alice's seat is free.
  await expect(pageCarol.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'empty', { timeout: 10_000 });
  await expect(pageCarol.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'active');

  // Rejoin: back in her own seat, by her own invite link.
  await pageAlice.getByRole('button', { name: 'Rejoin table' }).click();
  await expect(pageAlice.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 10_000 });
  await expect(pageCarol.locator('[data-testid="seat-0"]')).toContainText('Alice');

  // Leaving again — and coming back on another device by the same link: the same Alice.
  const link = await pageAlice.evaluate((): string => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? '';
      if (k.startsWith('pokerclause-rejoin:')) return localStorage.getItem(k) ?? '';
    }
    return '';
  });
  expect(link).toMatch(/\?assign=/);
  await pageAlice.getByRole('button', { name: 'Leave table' }).click();
  await pageAlice.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(pageAlice).toHaveURL(/\/left/, { timeout: 10_000 });
  const phone = await (await browser.newContext()).newPage();
  await phone.goto(link);
  await phone.getByLabel('Display name').fill('Someone Else');
  await phone.getByLabel('I’ve read and agree to the guest terms').check();
  await phone.getByRole('button', { name: 'Play now' }).click();
  await expect(phone.locator('[data-testid="seat-0"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 10_000 });
  await expect(phone.locator('[data-testid="seat-0"]')).toContainText('Alice');
  // Nobody else can take her link.
  await expect(pageCarol.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'active');
  await phone.context().close();

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

  await openOwnerMenu(pageOwner);
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

test('the owner swipes a table card left in the lobby and deletes it after confirming; nobody else can', async ({ browser }) => {
  const ctxOwner = await browser.newContext();
  const ctxGuest = await browser.newContext();
  const owner = await ctxOwner.newPage();
  const guest = await ctxGuest.newPage();

  await adminLogin(owner);
  await createTable(owner, { name: 'Swipe Me Away', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = owner.url();
  await guestSignup(guest, 'Watcher Wes');
  await guest.goto(tableUrl); // watching it when it goes
  await expect(guest.locator('[data-testid="seat-0"]')).toBeVisible();

  // A non-admin's lobby has nothing to swipe.
  const guestLobby = await (await ctxGuest.browser()!.newContext()).newPage();
  await guestSignup(guestLobby, 'Lobby Lou');
  await expect(guestLobby.locator('.table-card', { hasText: 'Swipe Me Away' })).toBeVisible();
  await expect(guestLobby.locator('.swipe-delete')).toHaveCount(0);

  await owner.goto('/lobby');
  const card = owner.locator('.swipe-delete', { hasText: 'Swipe Me Away' });
  await expect(card).toBeVisible();
  // Swipe like a slow phone would: on a throttled CPU, React renders lag
  // behind fast pointer moves — which once made a full swipe snap shut.
  const cdp = await owner.context().newCDPSession(owner);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  // Swipe it left with the mouse (the lobby may be long — bring the card into view first).
  const swipeLeft = async (): Promise<void> => {
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    await owner.mouse.move(box.x + box.width * 0.7, box.y + 30);
    await owner.mouse.down();
    for (let dx = 10; dx <= 140; dx += 10) await owner.mouse.move(box.x + box.width * 0.7 - dx, box.y + 32);
    await owner.mouse.up();
  };
  await swipeLeft();
  await card.getByRole('button', { name: 'Delete Swipe Me Away' }).click();

  // Confirmation first; cancelling keeps it.
  await expect(owner.getByText('Delete “Swipe Me Away”?')).toBeVisible();
  await owner.getByRole('button', { name: 'Cancel' }).click();
  // Wait for the dialog to be gone — otherwise, on a slow machine, the next
  // swipe lands on its backdrop instead of the card.
  await expect(owner.getByText('Delete “Swipe Me Away”?')).toBeHidden();
  await expect(owner.locator('.table-card', { hasText: 'Swipe Me Away' })).toBeVisible();

  // This time a quick flick whose release arrives before any of its moves —
  // what a busy browser does with batched move events (it once left the card
  // shut on a slow CI runner).
  await card.scrollIntoViewIfNeeded();
  const item = card.locator('.swipe-delete-item');
  const box = (await item.boundingBox())!;
  const at = (dx: number) => ({ clientX: box.x + box.width * 0.7 - dx, clientY: box.y + 30, pointerId: 7, isPrimary: true, bubbles: true });
  await item.dispatchEvent('pointerdown', at(0));
  await item.dispatchEvent('pointerup', at(140));
  await card.getByRole('button', { name: 'Delete Swipe Me Away' }).click();
  await owner.getByRole('button', { name: 'Delete table' }).click();
  await expect(owner.locator('.table-card', { hasText: 'Swipe Me Away' })).toHaveCount(0);

  // The watcher is sent back to the lobby; it's gone for everyone.
  await expect(guest).toHaveURL(/\/lobby/, { timeout: 10_000 });
  await guestLobby.reload();
  await expect(guestLobby.locator('.table-card', { hasText: 'Swipe Me Away' })).toHaveCount(0);

  await ctxOwner.close();
  await ctxGuest.close();
});

test('tapping Join on an owner’s swipeable card still joins the table', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'Tap To Join', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const tableUrl = page.url();
  await page.goto('/lobby');
  await page.locator('.swipe-delete', { hasText: 'Tap To Join' }).getByRole('button', { name: 'Join table' }).click();
  await expect(page).toHaveURL(tableUrl);
});

test('a private table the owner leaves stays in their lobby, under Private tables — and only theirs', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  await createTable(owner, { name: 'Homegame Private', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: true });
  await takeSeat(owner, 0, 100);
  await owner.getByRole('button', { name: 'Leave table' }).click();
  await expect(owner).toHaveURL(/\/lobby/);

  const privateSection = owner.getByTestId('lobby-private-tables');
  const card = privateSection.locator('.table-card', { hasText: 'Homegame Private' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Private');
  // Not mixed in with the public tables above.
  await expect(owner.locator('.table-grid').first().locator('.table-card', { hasText: 'Homegame Private' })).toHaveCount(0);
  // Still one tap away.
  await card.getByRole('button', { name: 'Join table' }).click();
  await expect(owner).toHaveURL(/\/table\//);
  await expect(owner.locator('[data-testid="seat-0"]')).toBeVisible();

  // Anyone else's lobby doesn't list it.
  const other = await (await browser.newContext()).newPage();
  await guestSignup(other, 'Nosy');
  await expect(other.locator('.table-card', { hasText: 'Homegame Private' })).toHaveCount(0);
  await expect(other.getByTestId('lobby-private-tables')).toHaveCount(0);
});

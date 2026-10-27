import { expect, request, type Locator, type Page } from '@playwright/test';

/**
 * Starts a guest session through the test-only route (testSeed.ts): the
 * real /auth/guest only creates one for a visitor holding a live invite
 * (see Login.tsx), and most tests just need a guest to spectate or be
 * invited later. The refresh cookie lands in this page's browser context,
 * so loading the app signs it in exactly as a real guest would be.
 */
export async function guestSignup(page: Page, name: string): Promise<void> {
  const res = await page.request.post('http://localhost:4210/test-only/guest', { data: { displayName: name } });
  expect(res.ok()).toBe(true);
  await page.goto('/lobby');
  await expect(page).toHaveURL(/\/lobby/);
}

/**
 * Logs in as the owner/admin account the server bootstraps on every boot
 * (`ensureAdminAccount` in apps/server/src/index.ts) — real credentials,
 * not a mock, so this exercises the actual admin-only gating end to end.
 * The email/password form is reached only via the small, deliberately
 * unadvertised trigger in the bottom-right corner — see Login.tsx.
 */
export async function adminLogin(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.admin-login-trigger').click();
  await page.getByLabel('Email or username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.locator('form').getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/lobby/);
}

/**
 * Creates a real, persisted (non-guest) account directly on the server —
 * the only way this suite can get a second real, admin-dashboard-visible
 * account onto the page, since there's no way to drive an actual Google
 * OAuth click-through in an automated test (see DECISIONS.md). Only
 * works because playwright.config.ts sets `ALLOW_TEST_SEEDING=true` for
 * this suite's own server process — the route this hits doesn't exist at
 * all in a real deployment. Returns the new account's id.
 */
export async function seedRealAccount(page: Page, displayName: string): Promise<string> {
  const res = await page.request.post('http://localhost:4210/test-only/seed-account', { data: { displayName } });
  const body = (await res.json()) as { id: string; displayName: string };
  return body.id;
}

/**
 * Signs in exactly as a verified Google account with this email would
 * (through the test-only route — see testSeed.ts; no real Google OAuth
 * here), then opens the lobby. The same email signs back into the same
 * account; once deleted, it registers again — without a second bonus.
 */
export async function googlePlayerLogin(page: Page, email: string, displayName: string): Promise<void> {
  // No access key: this test-only route lets anyone register (see testSeed.ts).
  const res = await page.request.post('http://localhost:4210/test-only/google-login', { data: { email, displayName } });
  expect(res.ok()).toBe(true);
  await page.goto('/lobby');
  // A new player (or one who never agreed) gets the friendly-game waiver first.
  await page.locator('.practice-card, .waiver-card').first().waitFor();
  if (await page.locator('.waiver-card').isVisible()) {
    await page.getByLabel(/Your initials/).fill(displayName.slice(0, 2));
    await drawSignature(page);
    await page.getByRole('button', { name: 'I agree and sign' }).click();
  }
  await expect(page.locator('.practice-card')).toBeVisible();
}

/**
 * Generates a one-time access key as the owner, through the API, in its own
 * request context — so the owner's session cookie never lands in any test
 * page's browser.
 */
export async function createAccessKey(label: string, email?: string): Promise<string> {
  const api = await request.newContext({ baseURL: 'http://localhost:4210' });
  const login = await api.post('/auth/login', { data: { email: 'admin', password: 'admin' } });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const res = await api.post('/admin/signup-keys', { data: email ? { label, email } : { label }, headers: { authorization: `Bearer ${accessToken}` } });
  expect(res.status()).toBe(201);
  const { key } = (await res.json()) as { key: string };
  await api.dispose();
  return key;
}

/** Signs the waiver's signature pad with the mouse — a looping scrawl, like a real signature. */
export async function drawSignature(page: Page): Promise<void> {
  const pad = page.locator('.signature-pad-canvas');
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  const y0 = box.y + box.height * 0.55;
  await page.mouse.move(box.x + 30, y0);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const x = box.x + 30 + i * ((box.width - 60) / 40);
    await page.mouse.move(x, y0 + Math.sin(i / 2.2) * 26);
  }
  await page.mouse.up();
}

export interface CreateTableOptions {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  isPrivate: boolean;
  /** An open-invite table — one shareable link, anyone with it picks their own seat. */
  openSeating?: boolean;
  /** An open-invite table's starting chips for each player, in dollars. */
  openSeatStack?: number;
}

/** Creates a table from the lobby and lands on it. Returns the invite link when private, else null. */
export async function createTable(page: Page, opts: CreateTableOptions): Promise<string | null> {
  await page.getByRole('button', { name: 'Create table' }).click();
  await page.getByLabel('Name', { exact: true }).fill(opts.name);
  await page.getByLabel('Small blind').fill(String(opts.smallBlind));
  await page.getByLabel('Big blind').fill(String(opts.bigBlind));
  await page.getByLabel('Max seats').fill(String(opts.maxSeats));
  if (opts.openSeating) {
    await page.getByLabel(/Open invite link/).check();
    if (opts.openSeatStack !== undefined) await page.getByLabel('Starting chips for each player').fill(String(opts.openSeatStack));
  }
  else if (opts.isPrivate) await page.getByLabel(/Private/).check();
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  let link: string | null = null;
  if (opts.isPrivate || opts.openSeating) {
    link = await page.locator('.modal input[readonly]').inputValue();
  }
  await page.getByRole('button', { name: 'Go to table' }).click();
  await expect(page).toHaveURL(/\/table\//);
  return link;
}

export function tableIdFromUrl(url: string): string {
  const match = /\/table\/([^/?]+)/.exec(url);
  if (!match?.[1]) throw new Error(`Could not extract table id from URL: ${url}`);
  return match[1];
}

/**
 * Taps an empty seat and picks one of its options from the menu that opens
 * (see Seat.tsx's emptyTap) — or, when that's the only thing this viewer
 * can do there, the tap itself does it.
 */
export async function chooseSeatOption(page: Page, seatId: number, option: 'Sit here' | 'Add a computer player' | 'Invite a player to this seat' | 'Move to this seat'): Promise<void> {
  await page.locator(`[data-testid="seat-${String(seatId)}"] .seat-empty-tap`).click();
  const item = page.getByRole('menuitem', { name: option });
  const modal = page.locator('.modal');
  await item.or(modal).first().waitFor();
  if (await item.isVisible()) await item.click();
}

/**
 * Owner-only now (see DECISIONS.md) — self-serve seating no longer
 * exists for a regular player. `page` must be logged in as the owner
 * (see `adminLogin`); this seats the OWNER's own account directly. For
 * anyone else, use `inviteToSeat` instead.
 */
export async function takeSeat(page: Page, seatId: number, buyIn: number): Promise<void> {
  await chooseSeatOption(page, seatId, 'Sit here');
  await page.getByLabel(/Buy-in/).fill(String(buyIn));
  await page.getByRole('button', { name: 'Sit down' }).click();
}

/** Owner-only — adds a computer player. `page` must be logged in as the owner. */
export async function addBot(page: Page, seatId: number, persona: string, buyIn: number): Promise<void> {
  await chooseSeatOption(page, seatId, 'Add a computer player');
  await page.getByLabel('Persona').selectOption(persona);
  await page.getByLabel(/Buy-in/).fill(String(buyIn));
  await page.locator('.modal').getByRole('button', { name: 'Add bot' }).click();
}

/**
 * The real way a regular (non-owner) human gets seated now (see
 * DECISIONS.md): the owner generates a one-time, seat-and-amount-specific
 * invite link, and the target redeems it by opening it — no buy-in
 * prompt shown to them at all. `ownerPage` must already be on the table,
 * logged in as the owner; `targetPage` must already be signed in (e.g.
 * via `guestSignup`) but not yet on this table.
 */
export async function inviteToSeat(ownerPage: Page, targetPage: Page, seatId: number, buyIn: number, nickname?: string): Promise<void> {
  await chooseSeatOption(ownerPage, seatId, 'Invite a player to this seat');
  if (nickname) await ownerPage.getByLabel('Nickname (only visible to you)').fill(nickname);
  await ownerPage.getByLabel(/Buy-in/).fill(String(buyIn));
  await ownerPage.getByRole('button', { name: 'Generate link' }).click();
  const link = await ownerPage.locator('.assign-link-input').inputValue();
  await ownerPage.getByRole('button', { name: 'Done' }).click();

  await targetPage.goto(link);
  await expect(targetPage.locator(`[data-testid="seat-${String(seatId)}"]`)).toHaveAttribute('data-seat-status', 'active', { timeout: 10_000 });
}

/**
 * Clicks "Play Hand" — nothing deals automatically, ever (not even the
 * table's very first hand): a seated player must explicitly start every
 * hand. Waits for the button to actually be enabled first, since state
 * sync from a just-completed seat/add-bot action can lag a tick behind
 * the click that triggered it. See DECISIONS.md.
 */
export async function startHand(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: 'Play Hand' });
  await expect(btn).toBeEnabled({ timeout: 10_000 });
  await btn.click();
}

/**
 * Repeatedly checks/calls on whichever page currently has the turn,
 * until the hand reaches showdown/completion. The default round budget
 * is generous (not just fast-human-only): bots think for a random 1-6s
 * before acting (see DECISIONS.md), and this same helper is reused by
 * tests with several bot seats across several streets, so idle rounds
 * (nothing visible yet, just waiting on a bot) need real headroom — a
 * human-only hand still finishes in a handful of rounds regardless of
 * how high this ceiling is set.
 */
export async function playHandToCompletion(pages: Page[], maxRounds = 300): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    for (const page of pages) {
      const checkBtn = page.getByRole('button', { name: 'Check' });
      const callBtn = page.getByRole('button', { name: /^Call/ });
      if (await checkBtn.isVisible().catch(() => false)) {
        await checkBtn.click();
      } else if (await callBtn.isVisible().catch(() => false)) {
        await callBtn.click();
      }
    }
    if (await pages[0]?.getByText('Verify hand fairness').isVisible().catch(() => false)) return;
    await pages[0]?.waitForTimeout(150);
  }
  throw new Error('Hand did not reach completion within the round budget.');
}

/** Opens the table's ☰ menu (top-right) if it isn't already, and returns it — your seat, the waitlist, the view, the call for anyone not seated. */
export async function openTableMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole('dialog', { name: 'Table menu' });
  if (!(await menu.isVisible())) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Closes the table's ☰ menu if it's open. */
export async function closeTableMenu(page: Page): Promise<void> {
  const menu = page.getByRole('dialog', { name: 'Table menu' });
  if (await menu.isVisible()) await page.getByRole('button', { name: 'Close menu' }).click();
  await expect(menu).toHaveCount(0);
}

/** One of the table menu's items: "Leave table", "Sit out next hand", "Hand log", "Join waitlist"... */
export async function tableMenuAction(page: Page, name: string | RegExp): Promise<void> {
  const menu = await openTableMenu(page);
  await menu.getByRole('button', { name, exact: typeof name === 'string' }).click();
}

/**
 * Joins the call: from your own seat box's buttons when seated, from the
 * table menu's Call section when not.
 */
export async function joinCall(page: Page, withVideo: boolean): Promise<void> {
  const name = withVideo ? 'Join with video' : 'Join voice';
  const onSeat = page.locator('.seat-call').getByRole('button', { name, exact: true });
  if ((await onSeat.count()) > 0) {
    await onSeat.click();
    return;
  }
  const menu = await openTableMenu(page);
  await menu.getByRole('button', { name: new RegExp(name) }).click();
  await closeTableMenu(page);
}

/** Opens the owner's table controls (☰ → Table controls) — reset/terminate, settings, seats and chips all live there. */
export async function openOwnerMenu(page: Page): Promise<void> {
  await tableMenuAction(page, 'Table controls');
  await expect(page.getByRole('dialog', { name: 'Table controls' })).toBeVisible();
}

/** Opens one of the admin dashboard's folding sections ("Game reports", "Access keys", "Deleted users") if it isn't already. Players starts open. */
export async function openAdminSection(page: Page, title: string): Promise<void> {
  const toggle = page.locator('.admin-section-toggle', { hasText: title });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

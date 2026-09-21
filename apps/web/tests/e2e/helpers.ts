import { expect, type Page } from '@playwright/test';

export async function guestSignup(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(page).toHaveURL(/\/lobby/);
}

/**
 * Logs in as the owner/admin account the server bootstraps on every boot
 * (`ensureAdminAccount` in apps/server/src/index.ts) — real credentials,
 * not a mock, so this exercises the actual admin-only gating end to end.
 */
export async function adminLogin(page: Page): Promise<void> {
  await page.goto('/');
  // "Log in" is the accessible name of both the mode tab AND the submit
  // button once that mode is active — scope each click so Playwright
  // doesn't see two matches.
  await page.locator('.auth-tabs').getByRole('button', { name: 'Log in' }).click();
  await page.getByLabel('Email').fill('admin@pokerclause.local');
  await page.getByLabel('Password').fill('admin12345');
  await page.locator('form').getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/lobby/);
}

export interface CreateTableOptions {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  isPrivate: boolean;
}

/** Creates a table from the lobby and lands on it. Returns the invite link when private, else null. */
export async function createTable(page: Page, opts: CreateTableOptions): Promise<string | null> {
  await page.getByRole('button', { name: 'Create table' }).click();
  await page.getByLabel('Name').fill(opts.name);
  await page.getByLabel('Small blind').fill(String(opts.smallBlind));
  await page.getByLabel('Big blind').fill(String(opts.bigBlind));
  await page.getByLabel('Max seats').fill(String(opts.maxSeats));
  if (opts.isPrivate) await page.getByLabel(/Private/).check();
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  let link: string | null = null;
  if (opts.isPrivate) {
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
 * Owner-only now (see DECISIONS.md) — self-serve seating no longer
 * exists for a regular player. `page` must be logged in as the owner
 * (see `adminLogin`); this seats the OWNER's own account directly. For
 * anyone else, use `inviteToSeat` instead.
 */
export async function takeSeat(page: Page, seatId: number, buyIn: number): Promise<void> {
  await page.locator(`[data-testid="seat-${String(seatId)}"]`).getByText('Sit here').click();
  await page.getByLabel(/Buy-in/).fill(String(buyIn));
  await page.getByRole('button', { name: 'Sit down' }).click();
}

/** Owner-only — adds a computer player. `page` must be logged in as the owner. */
export async function addBot(page: Page, seatId: number, persona: string, buyIn: number): Promise<void> {
  await page.locator(`[data-testid="seat-${String(seatId)}"]`).getByText('+ Add bot').click();
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
  await ownerPage.locator(`[data-testid="seat-${String(seatId)}"]`).getByText('+ Assign human').click();
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

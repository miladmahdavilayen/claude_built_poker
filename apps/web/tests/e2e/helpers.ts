import { expect, type Page } from '@playwright/test';

export async function guestSignup(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Play now' }).click();
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

export async function takeSeat(page: Page, seatId: number, buyIn: number): Promise<void> {
  await page.locator(`[data-testid="seat-${String(seatId)}"]`).getByText('Sit here').click();
  await page.getByLabel(/Buy-in/).fill(String(buyIn));
  await page.getByRole('button', { name: 'Sit down' }).click();
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

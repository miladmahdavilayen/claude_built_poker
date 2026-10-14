import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, openOwnerMenu, playHandToCompletion, startHand, takeSeat } from './helpers.js';

// The admin's game report (apps/server/src/game/gameBook.ts): downloadable
// any time from the table's own menu — mid-hand included — as YAML or PDF,
// named with the table, game, exact hand number and time; and listed
// permanently on the admin dashboard.

async function saved(download: Download): Promise<string> {
  return readFile(await download.path(), 'utf8');
}

async function downloadFrom(page: Page, testId: string): Promise<Download> {
  const pending = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  return pending;
}

test('the owner downloads the live game report mid-hand, as YAML and PDF, and finds it on the admin dashboard', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const alice = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  await createTable(owner, { name: 'Report Night', smallBlind: 0.1, bigBlind: 0.2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 10);
  await guestSignup(alice, 'Alice');
  await inviteToSeat(owner, alice, 1, 12.5);

  // Hand #1 plays out; hand #2 starts — the download happens in the middle of it.
  await startHand(owner);
  await playHandToCompletion([owner, alice]);
  await startHand(owner);
  await expect(owner.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  await openOwnerMenu(owner);
  await expect(owner.getByRole('dialog', { name: 'Table controls' })).toContainText('Right now it covers 1 hand (through hand #1).');

  const yamlDownload = await downloadFrom(owner, 'table-report-yaml');
  expect(yamlDownload.suggestedFilename()).toMatch(/^report-night_game-1_hand-1_\d{4}-\d{2}-\d{2}_\d{4}-UTC\.yaml$/);
  const yaml = await saved(yamlDownload);
  expect(yaml).toContain('status: live');
  expect(yaml).toContain('hands_played: 1');
  expect(yaml).toContain('books_balance: true');
  expect(yaml).toContain('total_bought_in: $22.50');
  expect(yaml).toContain('player: Alice');
  expect(yaml).toMatch(/hand: 1\n/);
  await expect(owner.getByText(/^Saved report-night_game-1_hand-1_.*\.yaml$/)).toBeVisible();

  const pdfDownload = await downloadFrom(owner, 'table-report-pdf');
  expect(pdfDownload.suggestedFilename()).toMatch(/^report-night_game-1_hand-1_.*\.pdf$/);
  const pdf = await readFile(await pdfDownload.path());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

  // The admin dashboard lists the same game, live.
  const dashboard = await (await browser.newContext()).newPage();
  await adminLogin(dashboard);
  await dashboard.goto('/admin');
  const row = dashboard.locator('.admin-report-row', { hasText: 'Report Night' });
  await expect(row).toContainText('live');
  await expect(row).toContainText('1 hand');
  // Titled by the table's name, under the day it started, with the game's numbers and standings at a glance.
  await expect(row.locator('.admin-report-name')).toHaveText('Report Night');
  await expect(row).toContainText('$0.10/$0.20 blinds');
  await expect(row).toContainText('2 players · $22.50 bought in');
  await expect(row.locator('.admin-report-standings')).toContainText('Alice');
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  await expect(dashboard.locator('.admin-reports-group', { has: row }).locator('.admin-reports-day')).toHaveText(today);
  // Search by table or player name narrows the list.
  await dashboard.getByLabel('Search game reports by table or player').fill('alice');
  await expect(row).toBeVisible();
  await dashboard.getByLabel('Search game reports by table or player').fill('no such table');
  await expect(row).toHaveCount(0);
  await dashboard.getByLabel('Search game reports by table or player').fill('');
  const fromDashboard = dashboard.waitForEvent('download');
  await row.getByRole('button', { name: 'Download YAML' }).click();
  expect(await saved(await fromDashboard)).toContain('hands_played: 1');
});

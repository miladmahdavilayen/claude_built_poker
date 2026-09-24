import { expect, test } from '@playwright/test';
import { addBot, adminLogin, createTable, playHandToCompletion, startHand, takeSeat } from './helpers.js';

// Regression/coverage test for the new "Allan Keating" bot persona: proves
// the full pipeline end to end — the UI's persona dropdown, the add-bot
// socket call, the server resolving it via SELECTABLE_BOT_POLICIES, and
// the bot's own Monte-Carlo-equity decide() actually running live on the
// server's scheduled timing — works for this specific persona, not just
// whichever one every other bot e2e test happens to leave as the default.
test('a human can add "Allan Keating" specifically and play a full hand against it', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'Allan Keating Table', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);

  await addBot(page, 1, 'allan-keating', 200);
  await expect(page.locator('[data-testid="seat-1"]').getByText('🤖 bot')).toBeVisible();
  // BOT_PERSONA_LABELS['allan-keating'] — the short label that actually
  // renders as this seat's display name.
  await expect(page.locator('[data-testid="seat-1"]')).toContainText('Keating');

  await startHand(page);
  await expect(page.locator('[data-testid="fairness-commitment"]')).toBeVisible({ timeout: 10_000 });

  // Play it out: this only ever clicks for the human (seat 0) — Allan
  // Keating's own moves (fold/call/raise, whatever its equity estimate
  // says) land on their own, server-scheduled timing.
  await playHandToCompletion([page]);
  await expect(page.getByText('Verify hand fairness')).toBeVisible();
});

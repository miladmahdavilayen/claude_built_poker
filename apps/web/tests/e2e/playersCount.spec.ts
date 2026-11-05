import { expect, test, type Page } from '@playwright/test';
import { adminLogin, closeTableMenu, createTable, guestSignup, inviteToSeat, openTableMenu, startHand, takeSeat } from './helpers.js';

const count = (p: Page) => p.getByTestId('players-count');

/** Whoever's turn it is folds; returns them. */
async function foldOne(pages: Page[]): Promise<Page> {
  for (let i = 0; i < 150; i++) {
    for (const p of pages) {
      const fold = p.getByRole('button', { name: 'Fold' });
      if (await fold.isVisible().catch(() => false)) {
        await fold.click();
        return p;
      }
    }
    await pages[0]!.waitForTimeout(100);
  }
  throw new Error('Nobody was asked to act.');
}

// The small count in the table's corner: players still in the hand / everyone at the table — the same for everyone
// watching, on either table.
test('the players count: all in as it is dealt, one fewer with each fold, on 2D and 3D', async ({ browser }) => {
  test.setTimeout(150_000);
  const pages = await Promise.all([0, 1, 2, 3].map(async () => (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()));
  const [owner, a, b, c] = pages as [Page, Page, Page, Page];
  await owner.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    if (!sessionStorage.getItem('view-seeded')) {
      localStorage.setItem('pokerclause.tableView', '2d');
      sessionStorage.setItem('view-seeded', '1');
    }
  });
  await adminLogin(owner);
  await createTable(owner, { name: 'Count', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(a, 'Ana');
  await guestSignup(b, 'Ben');
  await guestSignup(c, 'Cy');
  await expect(count(owner)).toHaveCount(0);
  await takeSeat(owner, 0, 200);
  await expect(count(owner)).toHaveText('1/1');
  await inviteToSeat(owner, a, 1, 200);
  await inviteToSeat(owner, b, 3, 200);
  await inviteToSeat(owner, c, 4, 200);
  await expect(count(owner)).toHaveText('4/4');

  await startHand(owner);
  await expect(owner.locator('[data-testid="seat-0"] .seat-cards .card-face')).toHaveCount(2, { timeout: 15_000 });
  for (const p of pages) await expect(count(p)).toHaveText('4/4');

  const first = await foldOne(pages);
  for (const p of pages) await expect(count(p)).toHaveText('3/4');
  await expect(count(owner)).toHaveAttribute('aria-label', '3 of 4 players still in');

  // The same count on the 3D table.
  await (await openTableMenu(owner)).getByLabel(/3D — Seated/).check();
  await closeTableMenu(owner);
  await expect(owner.getByTestId('table-3d')).toBeVisible({ timeout: 40_000 });
  await expect(count(owner)).toHaveText('3/4');

  await foldOne(pages.filter((p) => p !== first));
  await expect(count(owner)).toHaveText('2/4');
});

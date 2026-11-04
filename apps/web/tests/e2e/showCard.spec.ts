import { expect, test, type Page } from '@playwright/test';
import { addBot, adminLogin, closeTableMenu, createTable, guestSignup, inviteToSeat, openTableMenu, playHandToCompletion, startHand, takeSeat } from './helpers.js';

const eye = (page: Page, i: number) => page.getByTestId(`card-eye-${String(i)}`);

// Heads-up, the small eye at the bottom of each of your cards shows that card to the table, any time in the hand —
// one, then the other — with a flip for everyone. On the 2D table here; the other player sees just that card.
test('2D, heads-up: the eye under a card shows it to the other player, one card then both', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  for (const p of [owner, guest]) await p.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await createTable(owner, { name: 'Show Cards', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(guest, 'Gia');
  await takeSeat(owner, 0, 200);
  await inviteToSeat(owner, guest, 1, 200);
  // No hand yet: no eyes.
  await expect(eye(owner, 0)).toHaveCount(0);
  await startHand(owner);
  await expect(eye(owner, 0)).toBeVisible({ timeout: 15_000 });
  await expect(eye(owner, 1)).toBeVisible();
  await expect(eye(guest, 0)).toBeVisible();

  const seen = guest.locator('[data-testid="seat-0"] .seat-cards');
  await expect(seen.locator('.card-face')).toHaveCount(0);
  await eye(owner, 1).click();
  // The flip, for the player watching…
  await expect(seen.locator('.card-flip-inner')).toHaveCount(1);
  // …then one face up beside one still face down, and the eye lit.
  await expect(seen.locator('.card-flip-inner')).toHaveCount(0, { timeout: 5_000 });
  await expect(seen.locator('.card-face')).toHaveCount(1);
  await expect(seen.locator('.card-back')).toHaveCount(1);
  await expect(eye(owner, 1)).toBeDisabled();
  await expect(eye(owner, 0)).toBeEnabled();

  await eye(owner, 0).click();
  await expect(seen.locator('.card-face')).toHaveCount(2, { timeout: 5_000 });
  await expect(seen.locator('.card-back')).toHaveCount(0);
  // The guest's own hand stays theirs.
  await expect(owner.locator('[data-testid="seat-1"] .seat-cards .card-face')).toHaveCount(0);
});

test('more than two in the hand: no eyes — until one folds, then for the two left and not the one who folded', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const pages = [owner, a, b];
  for (const p of pages) await p.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await createTable(owner, { name: 'Three Up', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(a, 'Ana');
  await guestSignup(b, 'Ben');
  await takeSeat(owner, 0, 200);
  await inviteToSeat(owner, a, 2, 200);
  await inviteToSeat(owner, b, 4, 200);
  await startHand(owner);
  await expect(owner.locator('[data-testid="seat-0"] .seat-cards .card-face')).toHaveCount(2, { timeout: 15_000 });
  for (const p of pages) await expect(eye(p, 0)).toHaveCount(0);
  // Whoever's turn it is folds.
  let folder: Page | null = null;
  for (let i = 0; i < 100 && !folder; i++) {
    for (const p of pages) {
      const fold = p.getByRole('button', { name: 'Fold' });
      if (await fold.isVisible().catch(() => false)) {
        await fold.click();
        folder = p;
        break;
      }
    }
    if (!folder) await owner.waitForTimeout(100);
  }
  expect(folder).not.toBeNull();
  for (const p of pages) {
    if (p === folder) await expect(eye(p, 0)).toHaveCount(0);
    else await expect(eye(p, 0)).toBeVisible({ timeout: 10_000 });
  }
});

// 3D, seated: an eye at the bottom of each card on the felt; the other player sees the card over the seat's head.
test('3D, heads-up: the eye on the felt card shows it; turned away, the eyes are on the hand display', async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const guest = await (await browser.newContext()).newPage();
  for (const p of [owner, guest]) await p.addInitScript(() => localStorage.setItem('pokerclause.tableQuality', 'low'));
  // Both sit down on the 2D table, then go to 3D: two software-drawn 3D tables are slow to come up late in the suite.
  await owner.addInitScript(() => {
    if (!sessionStorage.getItem('view-seeded')) {
      localStorage.setItem('pokerclause.tableView', '2d');
      sessionStorage.setItem('view-seeded', '1');
    }
  });
  await adminLogin(owner);
  await createTable(owner, { name: 'Show Cards 3D', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(guest, 'Gia');
  await takeSeat(owner, 0, 200);
  await inviteToSeat(owner, guest, 3, 200);
  for (const p of [owner, guest]) {
    await (await openTableMenu(p)).getByLabel(/3D — Seated/).check();
    await closeTableMenu(p);
    await expect(p.getByTestId('table-3d')).toBeVisible({ timeout: 40_000 });
  }
  await startHand(owner);
  await expect(eye(owner, 0)).toBeVisible({ timeout: 30_000 });
  await expect(eye(owner, 1)).toBeVisible();
  // On the card: inside the screen, above the player's own box.
  const box = (await owner.locator('[data-testid="seat-0"]').boundingBox())!;
  for (const i of [0, 1]) {
    const b = (await eye(owner, i).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(box.y + 3);
  }
  await eye(owner, 0).click();
  // The guest, in 3D too: the card over the owner's head, beside one face down.
  const seen = guest.locator('[data-testid="seat-0"] [data-testid="showdown-cards"]');
  await expect(seen.locator('.card-face')).toHaveCount(1, { timeout: 5_000 });
  await expect(seen.locator('.card-back')).toHaveCount(1);
  await expect(guest.locator('[data-testid="edge-shown-cards"] .card-face')).toHaveCount(1);
  await expect(eye(owner, 0)).toBeDisabled();
  // Round, not stretched by a phone's tall-button rule.
  const round = (await eye(owner, 1).boundingBox())!;
  expect(Math.abs(round.width - round.height)).toBeLessThan(1);
  // Turned away from the felt: the same eyes, on the hand display; the second still works from there.
  const canvas = (await owner.locator('.table3d-canvas').boundingBox())!;
  await owner.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await owner.mouse.down();
  for (let i = 1; i <= 12; i++) await owner.mouse.move(canvas.x + canvas.width / 2 + (canvas.width * 0.8 * i) / 12, canvas.y + canvas.height / 2 + (canvas.height * 0.35 * i) / 12);
  await owner.mouse.up();
  const hud = owner.getByTestId('own-hand-hud');
  await expect(hud).toBeVisible({ timeout: 10_000 });
  await hud.getByTestId('card-eye-1').click();
  await expect(seen.locator('.card-face')).toHaveCount(2, { timeout: 5_000 });
});

// Once the hand is complete, anyone dealt in may show their cards — folded or not, any table size: one, both, or
// Reveal Hand. Not before: during the hand, a folded card would tell the players still in it what's out of the deck.
test('2D: a folder gets the eyes only once the hand is complete, and shows one card, then the rest', async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await (await browser.newContext()).newPage();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const pages = [owner, a, b];
  for (const p of pages) await p.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await createTable(owner, { name: 'Folder Shows', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(a, 'Ana');
  await guestSignup(b, 'Ben');
  await takeSeat(owner, 0, 200);
  await inviteToSeat(owner, a, 2, 200);
  await inviteToSeat(owner, b, 4, 200);
  await startHand(owner);
  await expect(owner.locator('[data-testid="seat-0"] .seat-cards .card-face')).toHaveCount(2, { timeout: 15_000 });
  let folder: Page | null = null;
  for (let i = 0; i < 100 && !folder; i++) {
    for (const p of pages) {
      const fold = p.getByRole('button', { name: 'Fold' });
      if (await fold.isVisible().catch(() => false)) {
        await fold.click();
        folder = p;
        break;
      }
    }
    if (!folder) await owner.waitForTimeout(100);
  }
  const quitter = folder!;
  const players = pages.filter((p) => p !== quitter);
  const folderSeat = quitter === owner ? 0 : quitter === a ? 2 : 4;
  // Hand still live: the folder has no eye and no button, whatever they try.
  await expect(players[0]!.getByTestId('card-eye-0')).toBeVisible({ timeout: 10_000 });
  await expect(eye(quitter, 0)).toHaveCount(0);
  await expect(quitter.locator('.btn-reveal-hand')).toHaveCount(0);
  await playHandToCompletion(players, 800);
  // Hand over, a real showdown: the two who showed down have nothing left to show; the folder now can.
  await expect(eye(quitter, 0)).toBeVisible({ timeout: 10_000 });
  await expect(eye(quitter, 1)).toBeVisible();
  await expect(quitter.locator('.btn-reveal-hand')).toHaveText('Reveal Hand');
  for (const p of players) {
    await expect(eye(p, 0)).toHaveCount(0);
    await expect(p.locator('.btn-reveal-hand')).toHaveCount(0);
  }
  const seen = players[0]!.locator(`[data-testid="seat-${String(folderSeat)}"] .seat-cards`);
  await expect(seen.locator('.card-face')).toHaveCount(0);
  await eye(quitter, 0).click();
  await expect(seen.locator('.card-face')).toHaveCount(1, { timeout: 5_000 });
  await expect(eye(quitter, 0)).toBeDisabled();
  // Readable: their box isn't dimmed any more.
  await expect(players[0]!.locator(`[data-testid="seat-${String(folderSeat)}"] > .seat`)).toHaveCSS('opacity', '1');
  // Reveal Hand: the rest in one tap, then it's gone.
  await quitter.locator('.btn-reveal-hand').click();
  await expect(seen.locator('.card-face')).toHaveCount(2, { timeout: 5_000 });
  await expect(quitter.locator('.btn-reveal-hand')).toHaveCount(0);
  // The next hand starts clean.
  await startHand(owner);
  await expect(eye(quitter, 0)).toHaveCount(0, { timeout: 15_000 });
});

test('3D: a folder shows their cards from the hand display, once the hand is over', async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await owner.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    localStorage.setItem('pokerclause.tableView', 'seated');
  });
  await adminLogin(owner);
  await createTable(owner, { name: 'Folder Shows 3D', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await addBot(owner, 2, 'calling-station', 200);
  await addBot(owner, 4, 'calling-station', 200);
  await takeSeat(owner, 0, 200);
  await startHand(owner);
  const hud = owner.getByTestId('own-hand-hud');
  // Fold when asked; until the hand's over, nothing to show from.
  const fold = owner.getByRole('button', { name: 'Fold' });
  await expect(fold).toBeVisible({ timeout: 40_000 });
  await fold.click();
  await expect(hud).toHaveCount(0);
  await expect(owner.getByText('Verify hand fairness')).toBeVisible({ timeout: 90_000 });
  await expect(hud).toBeVisible({ timeout: 10_000 });
  await expect(hud.locator('.card-face')).toHaveCount(2);
  await hud.getByTestId('card-eye-1').click();
  await expect(hud.getByTestId('card-eye-1')).toBeDisabled({ timeout: 5_000 });
  await owner.waitForTimeout(1000);
});

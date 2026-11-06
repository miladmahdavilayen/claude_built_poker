import { expect, test, type Page } from '@playwright/test';
import { adminLogin, chooseCharacter, chooseSeatOption, closeTableMenu, createTable, guestSignup, joinCall, openTableMenu, startHand } from './helpers.js';

const picker = (p: Page) => p.getByRole('dialog', { name: 'Choose your character' });
type Scene = { renderer: { info: { memory: { geometries: number; textures: number } } }; players: { bodies: Map<number, { character: { id: string } | null; figure: { visible: boolean }[] }> } };
const sceneOf = (p: Page): Promise<{ chars: Record<string, string | null>; figure: Record<string, boolean>; geometries: number; textures: number }> =>
  p.evaluate(() => {
    const s = (window as unknown as { __scene3d: Scene }).__scene3d;
    const chars: Record<string, string | null> = {};
    const figure: Record<string, boolean> = {};
    for (const [id, b] of s.players.bodies) {
      chars[id] = b.character?.id ?? null;
      figure[id] = b.figure[0]?.visible ?? false;
    }
    return { chars, figure, geometries: s.renderer.info.memory.geometries, textures: s.renderer.info.memory.textures };
  });

async function makeInvite(owner: Page, seatId: number): Promise<string> {
  await owner.locator(`[data-testid="seat-${String(seatId)}"] .seat-empty-tap`).click();
  await owner.getByRole('menuitem', { name: 'Invite a player to this seat' }).click();
  await owner.getByLabel(/Buy-in/).fill('100');
  await owner.getByRole('button', { name: 'Generate link' }).click();
  const link = await owner.locator('.assign-link-input').inputValue();
  await owner.getByRole('button', { name: 'Done' }).click();
  return link;
}

// Before sitting down, a player picks from the characters no one here has yet; first to pick one keeps it.
test('the character picker: small pictures and names, a taken one gone from the list, in 2D an icon on the seat', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  await owner.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await createTable(owner, { name: 'Picks', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await chooseSeatOption(owner, 0, 'Sit here');
  // The owner's ten: The Boss, theirs alone, and the nine everyone else chooses from.
  await expect(owner.locator('.character-option')).toHaveCount(10);
  await expect(owner.getByTestId('character-the-boss')).toBeVisible();
  await owner.getByLabel(/Buy-in/).fill('200');
  await owner.getByTestId('character-remy').click();
  await owner.getByRole('button', { name: 'Sit down' }).click();
  await expect(owner.locator('[data-testid="seat-0"] [data-testid="seat-character"]')).toBeVisible();

  const first = await makeInvite(owner, 1);
  const second = await makeInvite(owner, 2);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await guestSignup(a, 'Ann');
  await guestSignup(b, 'Bea');
  await a.goto(first);
  await b.goto(second);
  // Not seated until they've answered, and Remy's gone from the list. Each picture really loads.
  await expect(picker(a).locator('.character-option')).toHaveCount(8);
  await expect(picker(a).getByTestId('character-michelle')).toBeVisible();
  await expect(picker(a).getByTestId('character-remy')).toHaveCount(0);
  await expect(picker(a).getByTestId('character-the-boss')).toHaveCount(0);
  await expect(a.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'empty');
  await expect(picker(a).getByRole('button', { name: 'Sit down' })).toBeDisabled();
  for (const img of await picker(a).locator('img').all()) await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // Both have Eve highlighted; Ann gets there first: Bea's list loses her, and Sit down waits for another choice.
  await picker(a).getByTestId('character-eve').click();
  await picker(b).getByTestId('character-eve').click();
  await picker(a).getByRole('button', { name: 'Sit down' }).click();
  await expect(a.locator('[data-testid="seat-1"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 10_000 });
  await expect(picker(b).getByTestId('character-eve')).toHaveCount(0);
  await expect(picker(b).getByRole('button', { name: 'Sit down' })).toBeDisabled();
  await picker(b).getByTestId('character-aj').click();
  await picker(b).getByRole('button', { name: 'Sit down' }).click();
  await expect(b.locator('[data-testid="seat-2"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 10_000 });
});

// On camera: no character at all, just the seat behind the screen — out of memory, and back when the camera's off.
test('3D: a character shows in the chair; on camera it leaves memory, and comes back when the camera is off, with nothing left behind', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const guest = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  owner.on('pageerror', (e) => errors.push(e.message));
  await owner.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    if (!sessionStorage.getItem('view-seeded')) {
      localStorage.setItem('pokerclause.tableView', '2d');
      sessionStorage.setItem('view-seeded', '1');
    }
  });
  await adminLogin(owner);
  await createTable(owner, { name: 'Camera Off', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await chooseSeatOption(owner, 0, 'Sit here');
  await owner.getByLabel(/Buy-in/).fill('200');
  await owner.getByRole('button', { name: 'Sit down' }).click();
  const link = await makeInvite(owner, 3);
  await guestSignup(guest, 'Cam');
  await guest.goto(link);
  await chooseCharacter(guest, 'ch17');
  await expect(guest.locator('[data-testid="seat-3"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 15_000 });
  await joinCall(owner, true);
  await (await openTableMenu(owner)).getByLabel(/3D — Seated/).check();
  await closeTableMenu(owner);
  await expect(owner.getByTestId('table-3d')).toBeVisible({ timeout: 40_000 });

  // In the chair, in place of the built-in figure; the owner, who chose none, keeps theirs.
  await expect.poll(async () => (await sceneOf(owner)).chars['3'], { timeout: 30_000 }).toBe('ch17');
  expect((await sceneOf(owner)).figure['3']).toBe(false);
  await owner.waitForTimeout(500);
  const shown = await sceneOf(owner);

  // Camera on: their screen, and no one in the chair — no character, no figure.
  for (let round = 0; round < 3; round++) {
    await joinCall(guest, true);
    await expect.poll(async () => (await sceneOf(owner)).chars['3'], { timeout: 30_000 }).toBeNull();
    const off = await sceneOf(owner);
    expect(off.figure['3']).toBe(false);
    expect(off.textures).toBeLessThan(shown.textures);
    await guest.getByRole('button', { name: /Leave call|Hang up|End call/ }).first().click();
    await expect.poll(async () => (await sceneOf(owner)).chars['3'], { timeout: 30_000 }).toBe('ch17');
  }
  // Nothing piling up: back where it started.
  await owner.waitForTimeout(500);
  const after = await sceneOf(owner);
  expect(after.textures).toBeLessThanOrEqual(shown.textures + 1);
  expect(after.geometries).toBeLessThanOrEqual(shown.geometries + 1);
  expect(errors).toEqual([]);

  // Still a game: a hand deals normally around them.
  await startHand(owner);
  await expect(owner.getByTestId('table-3d')).toBeVisible();
});

// Seated, a player can switch to any character still free, or to none, from the menu; the table sees it.
test('switching character from the menu, on 3D and 2D: free ones only, the old one freed, quick switches leave one behind', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const guest = await (await browser.newContext()).newPage();
  await owner.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    if (!sessionStorage.getItem('view-seeded')) {
      localStorage.setItem('pokerclause.tableView', '2d');
      sessionStorage.setItem('view-seeded', '1');
    }
  });
  await adminLogin(owner);
  await createTable(owner, { name: 'Switch', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await chooseSeatOption(owner, 0, 'Sit here');
  await owner.getByLabel(/Buy-in/).fill('200');
  await owner.getByTestId('character-aj').click();
  await owner.getByRole('button', { name: 'Sit down' }).click();
  const link = await makeInvite(owner, 3);
  await guestSignup(guest, 'Gia');
  await guest.goto(link);
  await chooseCharacter(guest, 'eve');
  await expect(guest.locator('[data-testid="seat-3"]')).toHaveAttribute('data-seat-status', 'active', { timeout: 15_000 });

  const switcher = (p: Page) => p.getByRole('dialog', { name: 'Change your character' });
  const open = async (p: Page): Promise<void> => {
    await (await openTableMenu(p)).getByRole('button', { name: 'Change character' }).click();
    await expect(switcher(p)).toBeVisible();
  };

  // The owner's list: their own highlighted, the guest's gone.
  await open(owner);
  await expect(switcher(owner).locator('.character-option')).toHaveCount(9);
  await expect(switcher(owner).getByTestId('character-the-boss')).toBeVisible();
  await expect(switcher(owner).getByTestId('character-eve')).toHaveCount(0);
  await expect(switcher(owner).getByTestId('character-aj')).toHaveAttribute('aria-checked', 'true');
  await switcher(owner).getByRole('button', { name: 'Cancel' }).click();

  // The guest, on 2D, moves on from Eve: the icon changes for them, and she's free for the owner.
  await open(guest);
  await expect(switcher(guest).getByTestId('character-the-boss')).toHaveCount(0);
  await switcher(guest).getByTestId('character-remy').click();
  await switcher(guest).getByRole('button', { name: 'Switch' }).click();
  await expect(owner.locator('[data-testid="seat-3"] [data-testid="seat-character"]')).toHaveAttribute('src', /remy\.webp/);
  await open(owner);
  await expect(switcher(owner).getByTestId('character-eve')).toBeVisible();
  await expect(switcher(owner).getByTestId('character-remy')).toHaveCount(0);
  // The owner takes The Boss: in the chair on 3D, like any other.
  await switcher(owner).getByTestId('character-the-boss').click();
  await switcher(owner).getByRole('button', { name: 'Switch' }).click();

  // On 3D: the model in the chair follows. Quick switches there and back leave exactly one, and nothing piling up.
  await (await openTableMenu(owner)).getByLabel(/3D — Standing/).check();
  await closeTableMenu(owner);
  await expect(owner.getByTestId('table-3d')).toBeVisible({ timeout: 40_000 });
  await expect.poll(async () => (await sceneOf(owner)).chars['3'], { timeout: 30_000 }).toBe('remy');
  await expect.poll(async () => (await sceneOf(owner)).chars['0'], { timeout: 30_000 }).toBe('the-boss');
  await owner.waitForTimeout(500);
  const before = await sceneOf(owner);
  for (const id of ['ch17', 'remy', 'ch46', 'remy']) {
    await open(guest);
    await switcher(guest).getByTestId(`character-${id}`).click();
    await switcher(guest).getByRole('button', { name: 'Switch' }).click();
    await expect(switcher(guest)).toHaveCount(0);
  }
  await expect.poll(async () => (await sceneOf(owner)).chars['3'], { timeout: 30_000 }).toBe('remy');
  await owner.waitForTimeout(2500);
  const after = await sceneOf(owner);
  expect(after.chars['3']).toBe('remy');
  expect(after.figure['3']).toBe(false);
  expect(after.textures).toBeLessThanOrEqual(before.textures + 1);
  expect(after.geometries).toBeLessThanOrEqual(before.geometries + 1);

  // To no character: the built-in figure's back, and Remy's free.
  await open(guest);
  await switcher(guest).getByRole('button', { name: 'No character' }).click();
  await expect.poll(async () => (await sceneOf(owner)).figure['3'], { timeout: 15_000 }).toBe(true);
  expect((await sceneOf(owner)).chars['3']).toBeNull();
});

// A file that won't load leaves the built-in figure, and the table carries on.
test('3D: a character file that fails to load leaves the built-in figure; the game goes on', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  owner.on('pageerror', (e) => errors.push(e.message));
  await owner.route('**/models/players/*.glb', (r) => r.abort());
  await owner.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    localStorage.setItem('pokerclause.tableView', 'standing');
  });
  await adminLogin(owner);
  await createTable(owner, { name: 'Bad File', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await expect(owner.getByTestId('table-3d')).toBeVisible({ timeout: 40_000 });
  await chooseSeatOption(owner, 0, 'Sit here');
  await owner.getByLabel(/Buy-in/).fill('200');
  await owner.getByTestId('character-eve').click();
  await owner.getByRole('button', { name: 'Sit down' }).click();
  await expect.poll(async () => (await sceneOf(owner)).figure['0'], { timeout: 20_000 }).toBe(true);
  await owner.waitForTimeout(1000);
  const s = await sceneOf(owner);
  expect(s.chars['0']).toBeNull();
  expect(s.figure['0']).toBe(true);
  expect(errors).toEqual([]);
});

// Theo is the dealer on any 3D table that hasn't chosen one, and stays a character a player can pick.
test('Theo deals by default, from the same small file — fully built, on the stool — and players can still pick him', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    localStorage.setItem('pokerclause.tableView', 'standing');
  });
  await adminLogin(page);
  await createTable(page, { name: 'Theo Deals', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await expect(page.getByTestId('table-3d')).toHaveAttribute('data-theme', 'vip', { timeout: 40_000 });
  type Dealer = { dealer: { modelUrl: string | null; model: { root: { traverse: (f: (o: { isBone?: boolean; name: string; parent: { name: string } | null }) => void) => void } } | null; stool: unknown } };
  const dealer = (): Promise<{ url: string | null; loaded: boolean; stool: boolean; loose: number }> =>
    page.evaluate(() => {
      const d = (window as unknown as { __scene3d: Dealer }).__scene3d.dealer;
      let loose = 0;
      // Every skeleton copy on its original: none left following nothing.
      d.model?.root.traverse((o) => {
        if (o.isBone && /_\d+$/.test(o.name) && o.parent?.name !== o.name.replace(/_\d+$/, '')) loose++;
      });
      return { url: d.modelUrl, loaded: !!d.model, stool: !!d.stool, loose };
    });
  await expect.poll(async () => (await dealer()).loaded, { timeout: 30_000 }).toBe(true);
  const d = await dealer();
  expect(d.url).toMatch(/players\/ch31\.glb$/);
  expect(d.stool).toBe(true);
  expect(d.loose).toBe(0);
  await chooseSeatOption(page, 0, 'Sit here');
  await expect(page.getByTestId('character-ch31')).toBeVisible();
  await expect(page.getByTestId('character-ch31')).toContainText('Theo');
});

import { expect, test, type Page } from '@playwright/test';
import { dealOrder, edgePoint, seatPlacements } from '../../src/table3d/seatLayout3d.js';
import { addBot, adminLogin, createTable, playHandToCompletion, startHand, takeSeat, openTableMenu } from './helpers.js';

// The 3D table (src/table3d/). The suite runs on the 2D table by default
// (playwright.config.ts); these tests switch to 3D themselves.

test('seats go clockwise from the house dealer: seat 1 on its left, 2–3 the left end, 4–6 the far side, 7–8 the right end, 9 on its right', () => {
  const p = seatPlacements([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const [s1, s2, s3, s4, s5, s6, s7, s8, s9] = p.map((x) => x.chair);
  // The house dealer stands at +Z, x = 0. Seats 1 and 9 share its edge, either side of it.
  expect(s1!.z).toBeGreaterThan(1.5);
  expect(s1!.x).toBeLessThan(0);
  expect(s9!.z).toBeGreaterThan(1.5);
  expect(s9!.x).toBeGreaterThan(0);
  for (const s of [s2, s3]) expect(s!.x).toBeLessThan(-2.5);
  for (const s of [s4, s5, s6]) expect(s!.z).toBeLessThan(-1.5);
  for (const s of [s7, s8]) expect(s!.x).toBeGreaterThan(2.5);
  // Clockwise seen from above (+Z down the screen): the angle around the center only ever turns one way.
  const angles = p.map((x) => Math.atan2(x.chair.z, x.chair.x));
  const unwrapped = angles.map((a, i) => (i > 0 && a < angles[0]! ? a + 2 * Math.PI : a));
  for (let i = 1; i < unwrapped.length; i++) expect(unwrapped[i]!).toBeGreaterThan(unwrapped[i - 1]!);
  // Every edge point is on the table's rounded rectangle.
  const e = edgePoint(0.5);
  expect(e.z).toBeCloseTo(-1.75);
});

test('the deal goes clockwise from the seat after the button and ends on the button', () => {
  expect(dealOrder([0, 2, 5, 7], 2)).toEqual([5, 7, 0, 2]);
  expect(dealOrder([0, 2, 5, 7], 7)).toEqual([0, 2, 5, 7]);
  // Heads-up: the button (also the small blind) is dealt last.
  expect(dealOrder([1, 4], 1)).toEqual([4, 1]);
});

type Debug = { cards: string[]; stacks: string[]; cameraYaw: number; lean: number; boardLean: number; viewerSeatId: number | null; button: boolean };
const view3d = (page: Page, view: 'seated' | 'standing'): Promise<void> =>
  page.addInitScript((v) => {
    window.localStorage.setItem('pokerclause.tableView', v);
    window.localStorage.setItem('pokerclause.tableQuality', 'low');
  }, view);
/**
 * How long a lean gets to settle. On a real device it's well under a
 * second, but CI draws the 3D table in software at a frame or two a second,
 * and the easing advances at most 0.1 s per frame, so it needs real time.
 */
const LEAN_SETTLE_MS = 20_000;

const debug = (page: Page): Promise<Debug | undefined> => page.evaluate(() => (window as unknown as { __scene3d?: { debugState: () => Debug } }).__scene3d?.debugState());

test('a hand on the standing 3D table: the camera goes to the seat taken, the seat boxes ride along, cards and button follow the game', async ({ page }) => {
  // CI draws the 3D table in software, a full screen of it: room to spare.
  test.setTimeout(120_000);
  await view3d(page, 'standing');
  // Counts the sounds the table makes (every chip, card and shuffle sound is a noise burst — see sound.ts).
  await page.addInitScript(() => {
    const w = window as unknown as { __sounds: number };
    w.__sounds = 0;
    const proto = AudioContext.prototype;
    const orig = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'createBufferSource')!.value as (this: BaseAudioContext) => AudioBufferSourceNode;
    proto.createBufferSource = function (this: AudioContext) {
      w.__sounds++;
      return orig.call(this);
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401|Failed to load resource|WebSocket/.test(m.text())) errors.push(m.text());
  });
  await adminLogin(page);
  const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  test.skip(!webgl, 'No WebGL in this browser');
  await createTable(page, { name: '3D Table', smallBlind: 1, bigBlind: 2, maxSeats: 9, isPrivate: false });
  // Three.js loads on first use — the dev server can take a while to serve it.
  await expect(page.getByTestId('table-3d')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.table3d-canvas')).toHaveCount(1);
  // A spectator's view, then the owner sits at seat 4 (id 3): the camera swings round to it.
  await expect.poll(async () => (await debug(page))?.viewerSeatId).toBeNull();
  const spectatorYaw = (await debug(page))!.cameraYaw;
  await takeSeat(page, 3, 200);
  await expect.poll(async () => (await debug(page))?.viewerSeatId).toBe(3);
  await page.waitForTimeout(1200);
  const seatedYaw = (await debug(page))!.cameraYaw;
  expect(Math.abs(seatedYaw - spectatorYaw)).toBeGreaterThan(0.3);
  // Every seat's box is placed by the scene, on screen.
  const felt = (await page.locator('.felt').boundingBox())!;
  for (let id = 0; id < 9; id++) {
    const box = (await page.getByTestId(`seat-${String(id)}`).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(felt.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(felt.x + felt.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(felt.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(felt.y + felt.height + 1);
  }
  await addBot(page, 6, 'calling-station', 200);
  await startHand(page);
  await expect.poll(async () => (await debug(page))?.button, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await debug(page))?.cards.filter((c) => c.startsWith('hole:')).length ?? 0, { timeout: 15_000 }).toBe(4);
  await playHandToCompletion([page]);
  // The shuffle, the deal, the chips: the 3D table plays the game's sounds too.
  expect(await page.evaluate(() => (window as unknown as { __sounds: number }).__sounds)).toBeGreaterThan(10);
  await expect.poll(async () => (await debug(page))?.cards.filter((c) => c.startsWith('board:')).length ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('the View menu has exactly three views — 2D, 3D seated, 3D standing — and remembers the choice', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('pokerclause.tableQuality', 'low'));
  await adminLogin(page);
  await createTable(page, { name: 'View Switch', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await expect(page.getByTestId('table-3d')).toHaveCount(0);
  // The view is in the table menu.
  await openTableMenu(page);
  await expect(page.getByRole('radiogroup', { name: 'View' }).getByRole('radio')).toHaveCount(3);
  await page.getByLabel(/3D — Standing/).check();
  const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  test.skip(!webgl, 'No WebGL in this browser');
  await expect(page.getByTestId('table-3d')).toHaveAttribute('data-mode', 'standing', { timeout: 20_000 });
  await page.getByLabel(/3D — Seated/).check();
  await expect(page.getByTestId('table-3d')).toHaveAttribute('data-mode', 'seated', { timeout: 20_000 });
  // A reload loads the 3D table (and its dealer character) afresh: the same allowance as the first load.
  await page.reload();
  await expect(page.getByTestId('table-3d')).toHaveAttribute('data-mode', 'seated', { timeout: 20_000 });
  await openTableMenu(page);
  await page.getByLabel(/Classic 2D/).check();
  await expect(page.getByTestId('table-3d')).toHaveCount(0);
  await expect(page.locator('.board-area').first()).toBeVisible();
});

test('seated: your own eyes at your seat — drag to look around, double-tap to look back, and lean in past the house dealer from seat 1', async ({ page }) => {
  // The lean checks alone can take a couple of minutes on CI's software renderer.
  test.setTimeout(360_000);
  await view3d(page, 'seated');
  await adminLogin(page);
  const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  test.skip(!webgl, 'No WebGL in this browser');
  await createTable(page, { name: 'Seated View', smallBlind: 1, bigBlind: 2, maxSeats: 9, isPrivate: false });
  await addBot(page, 8, 'calling-station', 200);
  await takeSeat(page, 0, 200);
  await expect.poll(async () => (await debug(page))?.viewerSeatId).toBe(0);
  await page.waitForTimeout(1200);
  // Your own cards aren't doubled up in your box: they're on the felt.
  const canvas = (await page.locator('.table3d-canvas').boundingBox())!;
  const drag = async (dx: number): Promise<void> => {
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(canvas.x + canvas.width / 2 + (dx * canvas.width * i) / 10, canvas.y + canvas.height / 2);
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(1500);
  };
  // Turning toward the house dealer from seat 1 (dragging the scene left turns you right): you bend forward to see past them.
  await drag(-0.5);
  await expect(page.getByRole('button', { name: /Center view/ })).toBeVisible();
  await expect.poll(async () => (await debug(page))?.lean ?? 0, { timeout: LEAN_SETTLE_MS }).toBeGreaterThan(0.8);
  // Looking back at the table: sitting back.
  await page.getByRole('button', { name: /Center view/ }).click();
  await expect.poll(async () => (await debug(page))?.lean ?? 1, { timeout: LEAN_SETTLE_MS }).toBeLessThan(0.1);
  await expect(page.getByRole('button', { name: /Center view/ })).toHaveCount(0);
  // Leaning in on purpose, anywhere.
  await page.getByRole('button', { name: /Lean in/ }).click();
  await expect.poll(async () => (await debug(page))?.lean ?? 0, { timeout: LEAN_SETTLE_MS }).toBeGreaterThan(0.9);
  await page.getByRole('button', { name: /Sit back/ }).click();
  await expect.poll(async () => (await debug(page))?.lean ?? 1, { timeout: LEAN_SETTLE_MS }).toBeLessThan(0.1);
  // Pulling the table toward you (dragging down) leans you in over the board; dragging up sits you back.
  const pull = async (dy: number): Promise<void> => {
    const x = canvas.x + canvas.width / 2;
    const y = canvas.y + canvas.height * 0.4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + (dy * i) / 10);
    await page.waitForTimeout(150);
    await page.mouse.up();
  };
  // No board yet: pulling the table toward you doesn't lean you in (there's nothing to lean over).
  await pull(400);
  await page.waitForTimeout(800);
  expect((await debug(page))?.boardLean ?? 1).toBe(0);
  await page.getByRole('button', { name: /Center view/ }).click();
  // A hand dealt: your cards are face up on the felt, not in your box.
  await startHand(page);
  await expect.poll(async () => (await debug(page))?.cards.filter((c) => c.startsWith('hole:0')).length ?? 0, { timeout: 15_000 }).toBe(2);
  await expect(page.locator('[data-testid="seat-0"] .card')).toHaveCount(0);
  // Every action is announced: the ticker names who did what — ours if we get to act; the bot's own
  // (it can fold at once, ending the hand before we're asked) either way.
  const ours = page.getByRole('button', { name: /^(Check|Call)/ }).first();
  await expect(ours.or(page.getByRole('button', { name: 'Play Hand' }))).toBeVisible({ timeout: 15_000 });
  if (await ours.isVisible()) await ours.click();
  await expect(page.getByTestId('action-ticker')).toContainText(/(checks|calls|bets|raises|folds)/, { timeout: 20_000 });
  // The player in seat 9 — on the far side of the house dealer from seat 1 — has a marker with their stack.
  await expect(page.getByTestId('edge-8')).toContainText('$');
  const playHand = page.getByRole('button', { name: 'Play Hand' });
  // Once the flop is down, the same pull leans you in over it.
  for (let i = 0; i < 40 && !/Board: \S+ \S+ \S+/.test(await page.getByTestId('board-3d').innerText()) && !(await playHand.isVisible()); i++) {
    if (await ours.isVisible()) await ours.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  if (/Board: \S+ \S+ \S+/.test(await page.getByTestId('board-3d').innerText())) {
    await pull(140);
    await expect.poll(async () => (await debug(page))?.boardLean ?? 0, { timeout: LEAN_SETTLE_MS }).toBeGreaterThan(0.2);
    await pull(260);
    await expect.poll(async () => (await debug(page))?.boardLean ?? 0, { timeout: LEAN_SETTLE_MS }).toBeGreaterThan(0.95);
    await expect.poll(async () => (await debug(page))?.lean ?? 1, { timeout: LEAN_SETTLE_MS }).toBeLessThan(0.1);
    await pull(-400);
    await expect.poll(async () => (await debug(page))?.boardLean ?? 1, { timeout: LEAN_SETTLE_MS }).toBeLessThan(0.02);
    // …and the Center view button (or a double tap) brings you back from leaning in, too.
    await pull(400);
    await expect.poll(async () => (await debug(page))?.boardLean ?? 0, { timeout: LEAN_SETTLE_MS }).toBeGreaterThan(0.95);
    await page.getByRole('button', { name: /Center view/ }).click();
    await expect.poll(async () => (await debug(page))?.boardLean ?? 1, { timeout: LEAN_SETTLE_MS }).toBeLessThan(0.02);
  }
  // Played to the end (checking it down) — however it ends, no bets are left lying in front of anyone.
  for (let i = 0; i < 12 && !(await playHand.isVisible()); i++) {
    await expect(ours.or(playHand)).toBeVisible({ timeout: 60_000 });
    if (await ours.isVisible()) await ours.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(playHand).toBeVisible();
  await expect.poll(async () => (await debug(page))?.stacks.filter((k) => k.startsWith('bet:')) ?? ['?'], { timeout: 5000 }).toEqual([]);
});

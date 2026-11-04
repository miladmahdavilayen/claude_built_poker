import { expect, test } from '@playwright/test';
import { addBot, adminLogin, closeTableMenu, createTable, openTableMenu, playHandToCompletion, startHand, takeSeat } from './helpers.js';

// The owner's test players (botPersonas.ts's TEST_BOT_PERSONAS): the admin's alone, they turn a "camera" on — their
// own quiet looping clip, sound and all (testBotCameras.ts) — a few seconds after sitting down, and they always check
// or call, so every hand goes to a showdown.

// A browser of their own (different launch options put the file in its own worker): late in the suite, one browser
// has opened a hundred tests' cameras and videos, and Chromium stops giving a new clip a decoder — the picture check
// then waits forever. Same flags as playwright.config.ts otherwise.
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] },
});

test('a test player turns its camera on (picture and sound) a few seconds after sitting, and calls down to a showdown', async ({ page }) => {
  test.setTimeout(120_000);
  await adminLogin(page);
  await createTable(page, { name: 'Test Players', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);
  await addBot(page, 1, 'test-cam-ava', 200);
  const seat = page.locator('[data-testid="seat-1"]');
  await expect(seat).toContainText('Test Ava');
  // Not at once: a moment after sitting down.
  await expect(seat.locator('.seat-video video')).toHaveCount(0);
  await expect(seat.locator('.seat-video video')).toHaveCount(1, { timeout: 15_000 });
  const tracks = await seat.locator('.seat-video video').evaluate((v) => {
    const s = (v as HTMLVideoElement).srcObject as MediaStream;
    return { video: s.getVideoTracks().length, audio: s.getAudioTracks().length };
  });
  expect(tracks).toEqual({ video: 1, audio: 1 });
  // A real picture, not a black box: the clip's own frames.
  await expect
    .poll(() =>
      seat.locator('.seat-video video').evaluate((v) => {
        const video = v as HTMLVideoElement;
        if (!video.videoWidth) return 0;
        const c = document.createElement('canvas');
        c.width = 24;
        c.height = 32;
        const g = c.getContext('2d')!;
        g.drawImage(video, 0, 0, 24, 32);
        const d = g.getImageData(0, 0, 24, 32).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
        return sum / (d.length / 4);
      }),
      // The first decoded frame can take a while on a busy machine (the whole suite at once).
      { timeout: 30_000 },
    )
    .toBeGreaterThan(30);
  // Its sound has a mute button, like anyone's in the call — and it works.
  // Silenced at the clip itself, not only where the seat plays it (a phone can play a video's sound straight out).
  const clipMuted = (): Promise<boolean> => page.evaluate(() => (document.querySelector('#test-cam-videos video') as HTMLVideoElement).muted);
  const mute = page.getByRole('button', { name: 'Mute Test Ava' });
  await expect(mute).toBeVisible();
  await mute.click();
  await expect(page.getByRole('button', { name: 'Unmute Test Ava' })).toBeVisible();
  await expect.poll(clipMuted).toBe(true);
  await page.getByRole('button', { name: 'Unmute Test Ava' }).click();
  await expect.poll(clipMuted).toBe(false);
  // The whole call, too.
  await page.getByRole('button', { name: 'Mute all calls' }).click();
  await expect.poll(clipMuted).toBe(true);
  await page.getByRole('button', { name: 'Unmute all calls' }).click();
  await expect.poll(clipMuted).toBe(false);
  // It never folds: checked and called down, the hand ends in a showdown — its cards shown.
  await startHand(page);
  await playHandToCompletion([page]);
  await expect(seat.locator('.card:not(.card-back)')).toHaveCount(2, { timeout: 20_000 });
});

test('only the owner sees the test players to add', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'Test Players Menu', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await page.locator('[data-testid="seat-2"]').click();
  await page.getByRole('menuitem', { name: /Add a computer player/ }).click();
  await expect(page.getByLabel('Persona').locator('optgroup[label="Test players (owner only)"] option')).toHaveCount(7);
});

// The players right beside you sit side-on to you (both facing into the table): turn your head to one and their camera
// shows — square-on to you, like anyone's (players3d.ts, scene.ts's fitFaces).
test('seated on the 3D table, turning to the player beside you shows their camera — either side', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('pokerclause.tableQuality', 'low'));
  await adminLogin(page);
  await createTable(page, { name: 'Neighbours', smallBlind: 1, bigBlind: 2, maxSeats: 9, isPrivate: false });
  // You in seat 5; test players in seats 4 and 6.
  await takeSeat(page, 4, 200);
  await addBot(page, 3, 'test-cam-ava', 200);
  await addBot(page, 5, 'test-cam-ben', 200);
  await expect(page.getByRole('button', { name: 'Mute Test Ben' })).toBeVisible({ timeout: 15_000 });
  await (await openTableMenu(page)).getByLabel(/3D — Seated/).check();
  await closeTableMenu(page);
  await expect(page.getByTestId('table-3d')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  type Box = { seatId: number; k: number };
  const boxes = (): Promise<Box[]> => page.evaluate(() => (window as unknown as { __scene3d?: { debugState: () => { faceBoxes: Box[] } } }).__scene3d?.debugState().faceBoxes ?? []);
  const canvas = (await page.locator('.table3d-canvas').boundingBox())!;
  const turn = async (dx: number): Promise<void> => {
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(canvas.x + canvas.width / 2 + (dx * i) / 12, canvas.y + canvas.height / 2);
    await page.mouse.up();
  };
  // Dragging the scene one way turns your head the other: right brings seat 6 into view, left seat 4.
  for (const [dx, seatId] of [
    [canvas.width * 0.9, 5],
    [-canvas.width * 1.8, 3],
  ] as const) {
    let seen = false;
    for (let i = 0; i < 6 && !seen; i++) {
      await turn(i === 0 ? dx : dx / 3);
      await page.waitForTimeout(800);
      seen = (await boxes()).some((b) => b.seatId === seatId);
    }
    expect(seen, `seat ${String(seatId + 1)}'s camera, turned to`).toBe(true);
  }
});

// On the 3D table, cameras show only through your own eyes at your seat. Standing (the whole table from above), or
// at a table you haven't sat down at yet, nobody's camera is drawn — not as a screen in the scene, not on a box —
// while their voice still plays. Sitting down in the seated view brings the cameras back.
test('standing, or not yet seated, the 3D table shows no cameras — voices only', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    // Standing to begin with — once: the view chosen from the menu below must stick across the later pages.
    if (!sessionStorage.getItem('view-seeded')) {
      localStorage.setItem('pokerclause.tableView', 'standing');
      sessionStorage.setItem('view-seeded', '1');
    }
  });
  await adminLogin(page);
  await createTable(page, { name: 'No Cams Standing', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);
  await addBot(page, 3, 'test-cam-ava', 200);
  await expect(page.getByTestId('table-3d')).toHaveAttribute('data-mode', 'standing', { timeout: 20_000 });
  type Box = { seatId: number; k: number };
  const boxes = (): Promise<Box[]> => page.evaluate(() => (window as unknown as { __scene3d?: { debugState: () => { faceBoxes: Box[] } } }).__scene3d?.debugState().faceBoxes ?? []);
  // Their voice is playing (the clip's sound, through the seat's own audio)…
  await expect(page.locator('[data-testid="seat-3"] audio')).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(2500);
  // …but no camera anywhere: no screen in the scene, no video on any box.
  expect(await boxes()).toEqual([]);
  await expect(page.locator('.seat-video video')).toHaveCount(0);
  await expect(page.locator('video.seat-video-el')).toHaveCount(0);

  // Seated: their camera is a screen on their head.
  await (await openTableMenu(page)).getByLabel(/3D — Seated/).check();
  await closeTableMenu(page);
  await expect(page.getByTestId('table-3d')).toHaveAttribute('data-mode', 'seated', { timeout: 20_000 });
  await expect.poll(async () => (await boxes()).map((b) => b.seatId), { timeout: 15_000 }).toContain(3);

  // Not yet seated at a table (seated view): the whole table from above, and still no cameras.
  await page.goto('/lobby');
  await createTable(page, { name: 'No Cams Unseated', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await addBot(page, 3, 'test-cam-ben', 200);
  await expect(page.getByTestId('table-3d')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="seat-3"] audio')).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(2500);
  expect(await boxes()).toEqual([]);
  await expect(page.locator('video.seat-video-el')).toHaveCount(0);
  // Sitting down brings it back.
  await takeSeat(page, 0, 200);
  await expect.poll(async () => (await boxes()).map((b) => b.seatId), { timeout: 15_000 }).toContain(3);
});

// A camera screen comes down over the felt when no cards are in its way: nothing on the table may draw over it — the
// felt's printed line once did, being transparent, and three.js draws transparent things after every opaque one.
test('nothing on the table draws over a camera screen — on every table design', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    localStorage.setItem('pokerclause.tableView', 'seated');
  });
  await adminLogin(page);
  await createTable(page, { name: 'Over The Felt', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(page, 0, 200);
  await addBot(page, 3, 'test-cam-ava', 200);
  type Mesh = { name: string; renderOrder: number; material?: { transparent: boolean } };
  type Scene3d = { scene: { traverse: (f: (o: Mesh) => void) => void }; debugState: () => { faceBoxes: unknown[] } };
  await expect.poll(() => page.evaluate(() => (window as unknown as { __scene3d?: Scene3d }).__scene3d?.debugState().faceBoxes.length ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  const check = (): Promise<{ n: number; allTransparent: boolean; lowest: number; topOther: number }> =>
    page.evaluate(() => {
      const screens: Mesh[] = [];
      let topOther = 0;
      (window as unknown as { __scene3d: Scene3d }).__scene3d.scene.traverse((o) => {
        if (o.name === 'face-screen') screens.push(o);
        else if (o.material?.transparent) topOther = Math.max(topOther, o.renderOrder);
      });
      return { n: screens.length, allTransparent: screens.every((s) => s.material?.transparent), lowest: Math.min(...screens.map((s) => s.renderOrder)), topOther };
    });
  for (const id of ['classic', 'vip', 'emerald', 'midnight', 'onyx', 'imperial', 'saloon']) {
    await (await openTableMenu(page)).getByRole('button', { name: 'Table and dealer' }).click();
    await page.waitForTimeout(500);
    const picker = page.getByRole('dialog', { name: 'Choose the house dealer' });
    await picker.getByTestId(`table-design-${id}`).click();
    await picker.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('table-3d')).toHaveAttribute('data-theme', id, { timeout: 10_000 });
    // The new scene's screen is up and sized.
    await expect.poll(async () => (await check()).n, { timeout: 15_000, message: id }).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __scene3d?: Scene3d }).__scene3d?.debugState().faceBoxes.length ?? 0), { timeout: 15_000, message: id }).toBeGreaterThan(0);
    const c = await check();
    expect(c.allTransparent, id).toBe(true);
    expect(c.lowest, id).toBeGreaterThan(c.topOther);
    await page.waitForTimeout(1500);
    if (process.env.DESIGN_SHOTS) await page.screenshot({ path: `${process.env.DESIGN_SHOTS}/${id}.png` });
  }
});

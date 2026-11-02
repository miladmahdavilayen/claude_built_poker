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

import { expect, test } from '@playwright/test';
import { adminLogin, createTable } from './helpers.js';

// Before the game, soft music: the login page and the lobby each have their
// own track (BackgroundMusic.tsx), with a button to turn it off — none at a
// table. At the table, the table's own sounds (shuffle, cards, chips) have a
// mute of their own, apart from the dealer's voice, and are on whenever a
// table opens.

test('soft music on the login page and in the lobby — off at a table — and a button that turns it off', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __music: string[] };
    w.__music = [];
    const proto = HTMLMediaElement.prototype;
    const play = Object.getOwnPropertyDescriptor(proto, 'play')!.value as (this: HTMLMediaElement) => Promise<void>;
    proto.play = function (this: HTMLMediaElement) {
      const p = play.call(this);
      void p.then(
        () => w.__music.push(`playing ${this.src.split('/').pop() ?? ''}`),
        () => undefined,
      );
      return p;
    };
  });
  const played = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __music: string[] }).__music);
  await page.goto('/');
  await page.mouse.click(10, 10); // the first tap lets the browser start it
  await expect.poll(played).toContain('playing login-piano.mp3');
  await expect(page.getByRole('button', { name: 'Turn music off' })).toBeVisible();

  await adminLogin(page);
  await expect.poll(played).toContain('playing lobby-swing.mp3');
  await page.getByRole('button', { name: 'Turn music off' }).click();
  await expect(page.getByRole('button', { name: 'Turn music on' })).toBeVisible();
  // Remembered.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Turn music on' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn music on' }).click();

  await createTable(page, { name: 'No Music Here', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await expect(page.getByRole('button', { name: /Turn music/ })).toHaveCount(0);
});

test('the table’s own sounds have their own mute, apart from the dealer’s voice — and are on again at the next table', async ({ page }) => {
  await adminLogin(page);
  await createTable(page, { name: 'Table Sounds', smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  const muted = (): Promise<boolean> =>
    // The page's own sound module, as the dev server serves it.
    page.evaluate(async (path) => ((await import(path)) as { isTableSoundMuted: () => boolean }).isTableSoundMuted(), '/src/sound.ts');
  // Stacked: table sounds, then the dealer's voice right under it.
  const table = (await page.getByRole('button', { name: 'Mute table sounds' }).boundingBox())!;
  const dealer = (await page.getByRole('button', { name: 'Mute the dealer' }).boundingBox())!;
  expect(table.y + table.height).toBeLessThanOrEqual(dealer.y);
  expect(await muted()).toBe(false);
  await page.getByRole('button', { name: 'Mute table sounds' }).click();
  expect(await muted()).toBe(true);
  // The dealer's voice is untouched.
  await expect(page.getByRole('button', { name: 'Mute the dealer' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Mute table sounds' })).toBeVisible();
  expect(await muted()).toBe(false);
});

import { expect, test, type Page } from '@playwright/test';
import { addBot, adminLogin, createTable, startHand, takeSeat } from './helpers.js';

// At the table a finger is for turning the 3D view and tapping seats and
// buttons: a double tap, a triple tap or a press anywhere never selects text
// (useNoTableSelection.ts and .table-page in styles.css). Only what you type
// in stays selectable.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const selected = (page: Page): Promise<string> => page.evaluate(() => document.getSelection()?.toString() ?? '');

test('a phone at the 3D table: double and triple taps anywhere never select text, but the chat box still does', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.localStorage.setItem('pokerclause.tableView', 'seated');
    window.localStorage.setItem('pokerclause.tableQuality', 'low');
  });
  await adminLogin(page);
  await createTable(page, { name: 'No Selecting', smallBlind: 1, bigBlind: 2, maxSeats: 9, isPrivate: false });
  await addBot(page, 4, 'calling-station', 200);
  await takeSeat(page, 0, 200);
  await startHand(page);
  await expect(page.getByTestId('seat-4')).toBeVisible({ timeout: 15_000 });

  // Everywhere with words or pictures on it: the 3D view itself, both seat boxes, the board strip, the hint, the corner and menu buttons.
  const targets = ['.table3d-canvas', '[data-testid="seat-4"]', '[data-testid="seat-0"]', '.table3d-look-hint', '.table-corner', '.table-menu-button', '[data-testid="action-ticker"]'];
  for (const sel of targets) {
    const el = page.locator(sel).first();
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = (await el.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.dblclick(x, y);
    expect(await selected(page), `double tap on ${sel}`).toBe('');
    await page.mouse.click(x, y, { clickCount: 3 });
    expect(await selected(page), `triple tap on ${sel}`).toBe('');
    // A press held and dragged across the screen — turning the view — selects nothing on its way.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(20, 400, { steps: 8 });
    await page.mouse.up();
    expect(await selected(page), `drag from ${sel}`).toBe('');
    await page.keyboard.press('Escape');
  }

  // If the browser selects anyway (iOS has its own ways), the selection is dropped at once.
  await page.evaluate(() => document.getSelection()?.selectAllChildren(document.body));
  await expect.poll(() => selected(page)).toBe('');

  // The chat box is still a text box: what you typed can be selected and edited.
  await page.getByRole('button', { name: /^Chat/ }).click();
  const input = page.getByPlaceholder('Say something...');
  await input.fill('hello table');
  await input.selectText();
  expect(await input.evaluate((el: HTMLInputElement) => (el.selectionEnd ?? 0) - (el.selectionStart ?? 0))).toBe('hello table'.length);
});

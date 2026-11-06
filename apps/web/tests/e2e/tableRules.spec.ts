import { expect, test, type Page } from '@playwright/test';
import { adminLogin, closeTableMenu, createTable, guestSignup, inviteToSeat, joinCall, openTableMenu, startHand, takeSeat, tableMenuAction } from './helpers.js';

async function table(browser: import('@playwright/test').Browser, name: string, view: '2d' | 'seated' = '2d'): Promise<{ owner: Page; guest: Page }> {
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const guest = await (await browser.newContext()).newPage();
  await owner.addInitScript((v) => {
    localStorage.setItem('pokerclause.tableQuality', 'low');
    localStorage.setItem('pokerclause.tableView', v);
  }, view);
  await adminLogin(owner);
  await createTable(owner, { name, smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await takeSeat(owner, 0, 200);
  await guestSignup(guest, 'Gia');
  await inviteToSeat(owner, guest, 3, 200);
  return { owner, guest };
}

// A new table: the owner kicks it off, and everyone else waits. After that, anyone seated can deal the next hand.
test('only the owner starts the first hand; after it anyone can; players can already sit and use the call', async ({ browser }) => {
  test.setTimeout(120_000);
  const { owner, guest } = await table(browser, 'Kickoff');
  await expect(guest.getByTestId('waiting-for-owner')).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Play Hand' })).toHaveCount(0);
  await expect(owner.getByTestId('waiting-for-owner')).toHaveCount(0);
  await joinCall(guest, true);
  await expect(guest.locator('[data-testid="seat-3"] .seat-video video')).toBeVisible({ timeout: 15_000 });

  await startHand(owner);
  await expect(guest.getByTestId('waiting-for-owner')).toHaveCount(0, { timeout: 10_000 });
  // The hand ends: Play Hand is the guest's to press now.
  for (let i = 0; i < 100; i++) {
    let done = false;
    for (const p of [owner, guest]) {
      const fold = p.getByRole('button', { name: 'Fold' });
      if (await fold.isVisible().catch(() => false)) {
        await fold.click();
        done = true;
        break;
      }
    }
    if (done) break;
    await owner.waitForTimeout(100);
  }
  await startHand(guest);
  // A new hand: one of them is asked to act.
  await expect
    .poll(async () => (await guest.getByRole('button', { name: 'Fold' }).isVisible()) || (await owner.getByRole('button', { name: 'Fold' }).isVisible()), { timeout: 15_000 })
    .toBe(true);
});

// The timer: optional, set in the settings, moved from table controls, a small clock top left for everyone.
test('the table timer: off by default, on from table controls, moved live, seen by all, in 3D too; removable', async ({ browser }) => {
  test.setTimeout(150_000);
  const { owner, guest } = await table(browser, 'Timer', 'seated');
  await expect(owner.getByTestId('table-3d')).toBeVisible({ timeout: 40_000 });
  await expect(owner.getByTestId('table-clock')).toHaveCount(0);
  // Not the guest's to change.
  await expect((await openTableMenu(guest)).getByRole('button', { name: 'Table controls' })).toHaveCount(0);
  await closeTableMenu(guest);

  await tableMenuAction(owner, 'Table controls');
  const controls = owner.getByRole('dialog', { name: 'Table controls' });
  await controls.getByLabel(/Table timer/).check();
  await controls.getByLabel('Minutes').fill('30');
  await controls.getByRole('button', { name: /Save/ }).click();
  await expect(owner.getByTestId('table-clock')).toContainText(/^⏱ (30:00|29:\d\d)$/, { timeout: 10_000 });
  await expect(guest.getByTestId('table-clock')).toContainText(/29:\d\d|30:00/);
  await expect(controls.getByTestId('table-timer-control')).toBeVisible();

  await controls.getByRole('button', { name: '+15 min' }).click();
  await expect(guest.getByTestId('table-clock')).toContainText(/44:\d\d|45:00/);
  await controls.getByRole('button', { name: '−5 min' }).click();
  await expect(guest.getByTestId('table-clock')).toContainText(/39:\d\d|40:00/);
  await controls.getByLabel('Set to (minutes)').fill('120');
  await controls.getByRole('button', { name: 'Set', exact: true }).click();
  await expect(guest.getByTestId('table-clock')).toContainText(/2:00:00|1:59:\d\d/);
  await owner.screenshot({ path: '/tmp/charshots/clock-controls.png' });

  await controls.getByLabel('Close table controls').click();
  await owner.waitForTimeout(800);
  await owner.screenshot({ path: '/tmp/charshots/clock-3d.png' });
  const clock = (await owner.getByTestId('table-clock').boundingBox())!;
  expect(clock.x).toBeLessThan(60);
  expect(clock.y).toBeLessThan(60);

  await tableMenuAction(owner, 'Table controls');
  await controls.getByLabel(/Table timer/).uncheck();
  await controls.getByRole('button', { name: /Save/ }).click();
  await expect(guest.getByTestId('table-clock')).toHaveCount(0, { timeout: 10_000 });
});

// Set when the table's created, a timer that runs out ends the table for everyone.
test('a table created with a timer shows it from the start, and audio only offers no camera', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  await owner.addInitScript(() => localStorage.setItem('pokerclause.tableView', '2d'));
  await adminLogin(owner);
  await owner.goto('/lobby');
  await owner.getByRole('button', { name: /Create table/ }).click();
  const modal = owner.locator('.modal');
  await modal.getByLabel(/Table name|Name/).first().fill('All In One');
  await modal.getByLabel(/Table timer/).check();
  await modal.getByLabel('Minutes').fill('45');
  await modal.getByLabel(/Video in the table/).uncheck();
  await modal.getByRole('button', { name: 'Create' }).click();
  await owner.locator('.modal').getByRole('button', { name: /Go to|Open|Enter|table/i }).first().click();
  await expect(owner.getByTestId('table-clock')).toContainText(/44:\d\d|45:00/, { timeout: 15_000 });
  await expect(owner.locator('[data-testid^="seat-"]').first()).toBeVisible();
  await takeSeat(owner, 0, 200);
  await expect(owner.locator('.seat-call').getByRole('button', { name: 'Join voice' })).toBeVisible();
  await expect(owner.locator('.seat-call').getByRole('button', { name: 'Join with video' })).toHaveCount(0);
});

test('audio only: no camera offered or shown; turning it on mid-call takes a camera off, for everyone', async ({ browser }) => {
  test.setTimeout(150_000);
  const { owner, guest } = await table(browser, 'Audio');
  await joinCall(guest, true);
  await joinCall(owner, true);
  await expect(owner.locator('[data-testid="seat-3"] .seat-video video')).toBeVisible({ timeout: 20_000 });

  await tableMenuAction(owner, 'Table controls');
  const controls = owner.getByRole('dialog', { name: 'Table controls' });
  await controls.getByLabel(/Video in the table/).uncheck();
  await controls.getByRole('button', { name: /Save/ }).click();
  await expect(owner.locator('.seat-video video')).toHaveCount(0, { timeout: 10_000 });
  await expect(guest.locator('.seat-video video')).toHaveCount(0, { timeout: 10_000 });
  await expect(guest.locator('.seat-call').getByRole('button', { name: /Camera/ })).toHaveCount(0);
  await expect(guest.locator('.seat-call').getByRole('button', { name: 'Mute', exact: true })).toBeVisible();
  // Voice still flows: the guest's sound reaches the owner.
  await expect(owner.locator('[data-testid="seat-3"] audio')).toHaveCount(1);

  // Out of the call: only voice on offer.
  await guest.locator('.seat-call').getByRole('button', { name: 'Leave call' }).click();
  await expect(guest.locator('.seat-call').getByRole('button', { name: 'Join voice' })).toBeVisible();
  await expect(guest.locator('.seat-call').getByRole('button', { name: 'Join with video' })).toHaveCount(0);
});

import { expect, test, type Page } from '@playwright/test';
import { adminLogin, createTable, guestSignup, inviteToSeat, openOwnerMenu, startHand, takeSeat } from './helpers.js';

const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** Whether `sel`'s first match is clear of every seat box, the board, the corner controls, the clock and the menu button. */
const clearOfTable = (page: Page, sel: string): Promise<string[]> =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return ['missing'];
    const a = el.getBoundingClientRect();
    const hit: string[] = [];
    for (const other of ['.seat-slot > .seat', '.board-area', '.table-corner', '.action-timer:not(.action-timer-hidden)', '.table-menu-button', '.start-hand-panel > *']) {
      for (const o of document.querySelectorAll(other)) {
        const b = o.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) hit.push(other);
      }
    }
    return hit;
  }, sel);

async function twoAtTheTable(browser: import('@playwright/test').Browser, name: string): Promise<{ owner: Page; guest: Page }> {
  const owner = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await adminLogin(owner);
  await createTable(owner, { name, smallBlind: 1, bigBlind: 2, maxSeats: 6, isPrivate: false });
  await guestSignup(guest, 'Bea');
  await takeSeat(owner, 0, 200);
  await inviteToSeat(owner, guest, 1, 200);
  return { owner, guest };
}

// Typing @ in the chat offers the players at the table; the one mentioned is alerted with a note over the table —
// which lands on nothing — and finds the message picked out in the chat. An ordinary line shows as a quieter note.
test('a chat mention alerts the player it names; any new line shows for a moment, clear of the table', async ({ browser }) => {
  const { owner, guest } = await twoAtTheTable(browser, 'Mentions');

  await owner.getByRole('button', { name: /^Chat/ }).click();
  const input = owner.getByLabel('Chat message');
  await input.fill('nice hand @');
  const options = owner.getByRole('listbox', { name: 'Mention a player' });
  await expect(options.getByRole('option')).toHaveText(['@Bea']);
  await options.getByRole('option', { name: '@Bea' }).click();
  await expect(input).toHaveValue('nice hand @Bea ');
  await input.press('Enter');
  await expect(owner.locator('.chat-mention')).toHaveText('@Bea');

  const mention = guest.getByTestId('toast-mention');
  await expect(mention).toBeVisible();
  await expect(mention).toContainText('mentioned you');
  await expect(mention).toContainText('nice hand @Bea');
  expect(await clearOfTable(guest, '[data-testid="toast-mention"]')).toEqual([]);
  await shot(guest, 'mention-toast');

  // An ordinary line: a quieter note, there for a moment.
  await input.fill('good luck all');
  await input.press('Enter');
  const plain = guest.getByTestId('toast-chat');
  await expect(plain).toContainText('good luck all');
  expect(await clearOfTable(guest, '[data-testid="toast-chat"]')).toEqual([]);
  await expect(plain).toBeHidden({ timeout: 8_000 });

  // The mention opens the chat, where it's picked out; with the chat open, new lines aren't shown over the table too.
  await mention.click();
  await expect(guest.locator('.chat-message--mentions-me')).toContainText('nice hand');
  await expect(guest.locator('.chat-mention--me')).toHaveText('@Bea');
  await input.fill('one more');
  await input.press('Enter');
  await expect(guest.locator('.chat-message').last()).toContainText('one more');
  await expect(guest.getByTestId('toast-chat')).toHaveCount(0);
});

// A turn past its first stretch: the clock is red; the player on it is told, and can buy more time out of their stack
// into the pot; everyone else can poke them, once. Then the owner sits the player out mid-hand: their hand is played
// for them and they're out of the next ones until they sit back in.
test('a slow turn goes red: the player can buy time, the others can poke once; the owner can sit a player out mid-hand', async ({ browser }) => {
  test.setTimeout(120_000);
  const { owner, guest } = await twoAtTheTable(browser, 'Slow Turn');
  // The shortest first stretch a table allows, so the test waits seconds rather than half a minute.
  await openOwnerMenu(owner);
  await owner.getByLabel('Seconds per action').fill('5');
  await owner.getByRole('button', { name: 'Save changes' }).click();
  await owner.getByRole('button', { name: 'Close table controls' }).click();

  await startHand(owner);
  await owner.waitForSelector('[data-testid="fairness-commitment"]', { timeout: 10_000 });
  const ownerActs = await owner.getByRole('button', { name: 'Fold' }).isVisible({ timeout: 10_000 }).catch(() => false);
  const [actor, other] = ownerActs ? [owner, guest] : [guest, owner];
  if (!ownerActs) await expect(guest.getByRole('button', { name: 'Fold' })).toBeVisible({ timeout: 10_000 });

  // Calm at first: no banner, nothing to poke.
  await expect(actor.locator('.action-timer')).toHaveAttribute('data-phase', 'calm');
  await expect(actor.getByTestId('turn-banner')).toHaveCount(0);
  await expect(other.getByTestId('poke')).toHaveCount(0);

  // Past the first stretch: red for everyone.
  await expect(actor.locator('.action-timer')).toHaveAttribute('data-phase', 'red', { timeout: 10_000 });
  await expect(other.locator('.action-timer')).toHaveAttribute('data-phase', 'red');
  await expect(actor.getByTestId('turn-banner')).toContainText('Your time is running out');
  expect(await clearOfTable(actor, '[data-testid="turn-banner"]')).toEqual([]);
  await shot(actor, 'turn-banner-mine');

  // The other player pokes — once.
  await expect(other.getByTestId('turn-banner')).toContainText('is taking a while');
  await shot(other, 'turn-banner-poke');
  await other.getByTestId('poke').click();
  await expect(actor.getByTestId('toast-poke')).toContainText('poked you');
  await expect(other.getByTestId('poke')).toHaveCount(0);
  await expect(other.getByTestId('turn-banner')).toContainText('Poked');
  await shot(actor, 'poked');

  // The player on the clock buys time: a big blind from a 100 big blind stack, into the pot.
  const actorSeat = ownerActs ? 0 : 1;
  const stackBefore = await actor.locator(`[data-testid="seat-${String(actorSeat)}"] .seat-stack`).innerText();
  await expect(actor.getByTestId('buy-time')).toHaveText('+30s for $2');
  await actor.getByTestId('buy-time').click();
  await expect(other.getByTestId('toast-info').filter({ hasText: /bought 30 more seconds for \$2/ })).toBeVisible();
  await expect(actor.locator(`[data-testid="seat-${String(actorSeat)}"] .seat-stack`)).not.toHaveText(stackBefore);
  // Still their turn.
  await expect(actor.getByRole('button', { name: 'Fold' })).toBeVisible();

  // The owner sits the guest out (the seat's own menu): if it's on them, their hand is played for them at once.
  await owner.locator('[data-testid="seat-1"]').click({ button: 'right' });
  await owner.getByRole('menuitem', { name: 'Sit out (pause player)' }).click();
  await expect(guest.getByTestId('toast-info').filter({ hasText: 'sat you out' })).toBeVisible();
  if (!ownerActs) await expect(guest.getByRole('button', { name: 'Fold' })).toBeHidden({ timeout: 5_000 });
  await expect(guest.getByRole('button', { name: 'Sit back in' })).toBeVisible();
  await owner.locator('[data-testid="seat-1"]').click({ button: 'right' });
  await expect(owner.getByRole('menuitem', { name: 'Sit back in' })).toBeVisible();
  await owner.keyboard.press('Escape');

  // Back at the table, they sit themselves in again.
  await guest.getByRole('button', { name: 'Sit back in' }).click();
  await expect(guest.getByRole('button', { name: 'Sit out next hand' })).toBeVisible();
});

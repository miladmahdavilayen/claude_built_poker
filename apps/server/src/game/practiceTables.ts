import { randomInt } from 'node:crypto';
import { formatMoney, PRACTICE_STAKES, type CreatePracticeTableInput, type TableSettings } from '@pokerclause/shared';
import { needsWaiver } from '../auth/waiver.js';
import type { Store, UserRecord } from '../db/store.js';
import type { LiveTable } from './liveTable.js';
import { SELECTABLE_BOT_POLICIES } from './liveTable.js';
import type { TableRegistry } from './tableRegistry.js';

export type OpenPracticeTableResult = { ok: true; table: LiveTable } | { ok: false; status: number; code: string; message: string; tableId?: string };

/** One request per player at a time, so a double-click can't open two tables or spend the same balance twice. */
const opening = new Set<string>();

/**
 * Opens a signed-in player's practice table: a temporary, private table
 * with the player in seat 0 and 1–4 computer players in the seats after
 * it — never another human (the socket server refuses every way one could
 * get in; see socketServer.ts). The player's buy-in comes out of their own
 * balance, ledgered like any other buy-in; the bots' chips are play chips,
 * same as a bot anywhere else. Nothing about the table outlives it: it
 * lives only in memory (see HybridStore) and is deleted the moment it
 * closes — when the player leaves, or a while after they disconnect.
 */
export async function openPracticeTable(store: Store, registry: TableRegistry, user: UserRecord, input: CreatePracticeTableInput): Promise<OpenPracticeTableResult> {
  if (user.isGuest) return { ok: false, status: 403, code: 'GUEST_CANNOT_CREATE_TABLE', message: 'Sign in with Google to play.' };
  if (needsWaiver(user)) return { ok: false, status: 403, code: 'WAIVER_REQUIRED', message: 'Please agree to the friendly-game waiver first.' };
  const existing = registry.practiceTableOf(user.id);
  if (existing) {
    return { ok: false, status: 409, code: 'PRACTICE_TABLE_OPEN', message: 'You already have a table open.', tableId: existing.tableId };
  }
  const stakes = PRACTICE_STAKES[input.stakes];
  if (input.buyIn < stakes.minBuyIn || input.buyIn > stakes.maxBuyIn) {
    return {
      ok: false,
      status: 400,
      code: 'BUY_IN_OUT_OF_RANGE',
      message: `Buy-in must be between ${formatMoney(stakes.minBuyIn)} and ${formatMoney(stakes.maxBuyIn)}.`,
    };
  }
  if (user.chips < input.buyIn) return { ok: false, status: 400, code: 'INSUFFICIENT_CHIPS', message: 'Not enough chips for that buy-in.' };
  if (opening.has(user.id)) return { ok: false, status: 409, code: 'PRACTICE_TABLE_OPENING', message: 'Your table is already being set up.' };

  opening.add(user.id);
  try {
    const settings: TableSettings = {
      smallBlind: stakes.smallBlind,
      bigBlind: stakes.bigBlind,
      ante: 0,
      maxSeats: input.bots + 1,
      straddleEnabled: false,
      minBuyIn: stakes.minBuyIn,
      maxBuyIn: stakes.maxBuyIn,
      actionSeconds: 25,
      timeBankSeconds: 60,
      runItTwiceEnabled: false,
      rakePercent: 0,
      rakeCap: 0,
      noFlopNoDrop: true,
      // Hidden from every lobby listing; join-table admits only the owner (and the admin) regardless.
      isPrivate: true,
      disableChatInHand: false,
    };
    const table = await registry.createTable(`${user.displayName}'s table`, settings, user.id, null, true);
    table.takeSeat(0, user.id, { displayName: user.displayName, isGuest: false, avatarSeed: user.avatarSeed, clientSeed: user.clientSeed }, input.buyIn);
    await store.adjustUserChips(user.id, -input.buyIn);
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: -input.buyIn, reason: 'buy_in', tableId: table.tableId },
      { userId: null, isHouse: true, amount: input.buyIn, reason: 'buy_in', tableId: table.tableId },
    ]);
    for (const [i, persona] of pickPersonas(input.bots).entries()) {
      table.addBot(i + 1, persona, input.buyIn);
    }
    return { ok: true, table };
  } finally {
    opening.delete(user.id);
  }
}

/** `count` different personas in random order — a table of five maniacs isn't much of a game. */
function pickPersonas(count: number): string[] {
  const names = SELECTABLE_BOT_POLICIES.map((p) => p.name);
  for (let i = names.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [names[i], names[j]] = [names[j]!, names[i]!];
  }
  return names.slice(0, count);
}

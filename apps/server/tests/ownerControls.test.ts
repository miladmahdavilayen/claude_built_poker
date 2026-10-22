import type { GameEvent } from '@pokerclause/engine';
import type { TableSettings } from '@pokerclause/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';
import { LiveTable, type VacatedSeat } from '../src/game/liveTable.js';

// Amounts are cents: $0.10/$0.20 blinds, $8–$20 buy-in.
const SETTINGS: TableSettings = {
  smallBlind: 10,
  bigBlind: 20,
  ante: 0,
  maxSeats: 4,
  straddleEnabled: false,
  minBuyIn: 800,
  maxBuyIn: 2000,
  actionSeconds: 25,
  timeBankSeconds: 60,
  runItTwiceEnabled: false,
  rakePercent: 0,
  rakeCap: 0,
  noFlopNoDrop: true,
  isPrivate: false,
  disableChatInHand: false,
};

function meta(name: string) {
  return { displayName: name, isGuest: false, avatarSeed: 'seed', clientSeed: `client-${name}` };
}

/** Checks or calls for whoever is acting until the hand ends (bots and forced folds run on timers). */
async function playOut(table: LiveTable): Promise<void> {
  for (let guard = 0; table.state.phase === 'in-hand' && guard < 100; guard++) {
    const seatId = table.state.betting.actingSeat!;
    const live = table.seats[seatId]!;
    if (live.botPolicyName || live.pendingRemoval) {
      await vi.advanceTimersByTimeAsync(6500);
      continue;
    }
    const toCall = table.state.betting.currentBet - table.state.seats[seatId]!.committedThisStreet;
    table.applyPlayerAction(seatId, toCall > 0 ? { seatId, type: 'call' } : { seatId, type: 'check' });
  }
  expect(table.state.phase).toBe('hand-complete');
}

describe('LiveTable: owner controls mid-hand', () => {
  let store: MemoryStore;
  let table: LiveTable;
  let vacatedLog: VacatedSeat[];
  let eventsLog: GameEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    store = new MemoryStore();
    vacatedLog = [];
    eventsLog = [];
    table = new LiveTable('table-1', 'Owner Table', SETTINGS, store, {
      onBroadcast: (_tableId, _perSeat, raw) => eventsLog.push(...raw),
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
      onSeatsVacated: (_tableId, vacated) => vacatedLog.push(...vacated),
    });
  });

  afterEach(() => {
    table.dispose();
    vi.useRealTimers();
  });

  it('seating someone mid-hand keeps them out of that hand and deals them in from the next one', async () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.startNextHand();

    table.takeSeat(2, 'c', meta('Carol'), 1000);
    expect(table.state.seats[2]?.status).toBe('sitting-out');
    expect(table.projectionFor(2).seats[2]?.joiningNextHand).toBe(true);
    // Never asked to act in a hand she wasn't dealt into.
    await playOut(table);
    expect(table.state.seats[2]?.holeCards).toEqual([]);

    // Dealt in the moment the hand ends — so she also counts towards "can start a hand".
    expect(table.state.seats[2]?.status).toBe('active');
    expect(table.projectionFor(2).seats[2]?.joiningNextHand).toBe(false);
  });

  it('a mid-hand rebuy for a player still in the hand lands only when it ends, and is never counted as winnings', async () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.startNextHand();
    const stackBefore = table.state.seats[0]!.stack;

    expect(table.addChips(0, 500)).toEqual({ appliedNow: false });
    expect(table.state.seats[0]!.stack).toBe(stackBefore); // untouched mid-hand
    expect(table.projectionFor(0).seats[0]?.pendingChips).toBe(500);
    expect(table.cashOutAmount(0)).toBe(stackBefore + 500);

    await playOut(table);
    await vi.runAllTimersAsync(); // let settleHand's ledger writes finish

    const finalA = table.state.seats[0]!.stack;
    const finalB = table.state.seats[1]!.stack;
    // Chips are conserved: the 500 rebuy is the only thing added to the table.
    expect(finalA + finalB).toBe(1000 + 1000 + 500);
    expect(table.seats[0]!.pendingChips).toBe(0);
    // Hand results (pot_win) net to zero between the two players — the rebuy isn't in them.
    const potWins = [...(await store.ledgerEntriesForUser('a', 50)), ...(await store.ledgerEntriesForUser('b', 50))].filter((e) => e.reason === 'pot_win');
    expect(potWins.reduce((sum, e) => sum + e.amount, 0)).toBe(0);
  });

  it('a rebuy for a player who already folded this hand goes straight onto their stack', () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.takeSeat(2, 'c', meta('Carol'), 1000);
    table.startNextHand();
    const first = table.state.betting.actingSeat!;
    table.applyPlayerAction(first, { seatId: first, type: 'fold' });
    const before = table.state.seats[first]!.stack;

    expect(table.addChips(first, 300)).toEqual({ appliedNow: true });
    expect(table.state.seats[first]!.stack).toBe(before + 300);
    expect(table.state.seats[first]!.status).toBe('folded'); // engine resets it at the next deal
  });

  it('removing a player mid-hand folds them on their turn, then vacates the seat and refunds stack plus any pending rebuy', async () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.takeSeat(2, 'c', meta('Carol'), 1000);
    table.startNextHand();
    const target = table.state.betting.actingSeat!;
    table.addChips(target, 200); // pending — must come back in the refund

    expect(table.removeSeatOccupant(target, false)).toEqual({ ok: true, vacated: null });
    expect(table.state.seats[target]?.status).toBe('active'); // still in the hand for now
    await vi.advanceTimersByTimeAsync(1000); // forced-fold delay
    expect(eventsLog.some((e) => e.type === 'action-taken' && e.seatId === target && e.action.type === 'fold')).toBe(true);

    await playOut(table);
    expect(vacatedLog).toHaveLength(1);
    const v = vacatedLog[0]!;
    expect(v.seatId).toBe(target);
    expect(v.userId).toBe(['a', 'b', 'c'][target]);
    // First to act preflop 3-handed is the button, who posted nothing: the full 1000, plus the pending 200.
    expect(v.refund).toBe(1000 + 200);
    expect(table.state.seats[target]?.status).toBe('empty');
    expect(table.projectionFor(null).removedSeatIds).toEqual([]); // removing the player keeps the seat
  });

  it('an all-in player who is removed plays the hand out and is refunded whatever they end with', async () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.startNextHand();
    const first = table.state.betting.actingSeat!;
    const allIn = table.state.seats[first]!.stack + table.state.seats[first]!.committedThisStreet;
    table.applyPlayerAction(first, { seatId: first, type: 'raise', amountTo: allIn });
    const caller = table.state.betting.actingSeat!;
    expect(table.removeSeatOccupant(first, false)).toEqual({ ok: true, vacated: null });
    table.applyPlayerAction(caller, { seatId: caller, type: 'call' });
    await vi.runAllTimersAsync();

    expect(table.state.phase).toBe('hand-complete');
    expect(vacatedLog).toHaveLength(1);
    const finalStackOfFirst = vacatedLog[0]!.refund;
    // One of them has everything — or, when the hands tie (the deck is
    // really shuffled, so now and then they do), they split the pot.
    expect([0, 1000, 2000]).toContain(finalStackOfFirst);
    expect(finalStackOfFirst + table.state.seats[caller]!.stack).toBe(2000);
  });

  it('a player who folds with chips in the pot and leaves mid-hand never breaks the showdown (regression: the hand used to crash)', () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.takeSeat(2, 'c', meta('Carol'), 1000);
    table.startNextHand();
    let left: { userId: string; stack: number } | null = null;
    for (let guard = 0; table.state.phase === 'in-hand' && guard < 100; guard++) {
      const seatId = table.state.betting.actingSeat!;
      const seat = table.state.seats[seatId]!;
      if (!left && seat.committedThisHand > 0 && table.state.street === 'flop') {
        table.applyPlayerAction(seatId, { seatId, type: 'fold' });
        left = table.leaveSeat(seatId);
        // Free to go right away, chips in hand...
        expect(table.seatOfUser(left!.userId)).toBeNull();
        // ...but the seat stays folded (its chips are still in this pot) until the hand ends.
        expect(table.state.seats[seatId]?.status).toBe('folded');
        continue;
      }
      const toCall = table.state.betting.currentBet - seat.committedThisStreet;
      table.applyPlayerAction(seatId, toCall > 0 ? { seatId, type: 'call' } : { seatId, type: 'check' });
    }
    expect(left).not.toBeNull();
    expect(table.state.phase).toBe('hand-complete');
    const leftSeat = table.state.seats.findIndex((s, i) => s.status === 'empty' && i < 3);
    expect(leftSeat).toBeGreaterThanOrEqual(0);
    // Every chip accounted for: what's on the table plus what the leaver took.
    expect(table.state.seats.reduce((sum, s) => sum + s.stack, 0) + left!.stack).toBe(3000);
  });

  it('deleting an empty seat hides it, blocks sitting there, and adding a seat brings the same slot back', () => {
    expect(table.deleteSeat(3)).toEqual({ ok: true, vacated: null });
    expect(table.projectionFor(null).removedSeatIds).toEqual([3]);
    expect(table.visibleSeatCount).toBe(3);
    expect(() => table.takeSeat(3, 'a', meta('Alice'), 1000)).toThrow('NO_SUCH_SEAT');
    expect(table.addBot(3, 'nit', 1000)).toMatchObject({ ok: false, code: 'NO_SUCH_SEAT' });

    expect(table.addSeat()).toEqual({ ok: true, seatId: 3 });
    expect(table.projectionFor(null).removedSeatIds).toEqual([]);
    expect(() => table.takeSeat(3, 'a', meta('Alice'), 1000)).not.toThrow();
  });

  it('adding seats beyond the original count appends new slots, up to 9', () => {
    for (let expected = 4; expected < 9; expected++) expect(table.addSeat()).toEqual({ ok: true, seatId: expected });
    expect(table.addSeat()).toMatchObject({ ok: false, code: 'MAX_SEATS' });
    expect(table.state.seats).toHaveLength(9);
    expect(table.state.config.maxSeats).toBe(9);
    expect(() => table.takeSeat(8, 'a', meta('Alice'), 1000)).not.toThrow();
  });

  it('a table keeps at least 2 seats', () => {
    expect(table.deleteSeat(3).ok).toBe(true);
    expect(table.deleteSeat(2).ok).toBe(true);
    expect(table.deleteSeat(1)).toMatchObject({ ok: false, code: 'TOO_FEW_SEATS' });
  });

  it('deleting an occupied seat mid-hand waits for the hand to end, then removes player and seat together', async () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.takeSeat(2, 'c', meta('Carol'), 1000);
    table.startNextHand();
    expect(table.deleteSeat(2)).toEqual({ ok: true, vacated: null });
    expect(table.projectionFor(null).removedSeatIds).toEqual([]);

    await playOut(table);
    expect(vacatedLog.map((v) => v.seatId)).toEqual([2]);
    expect(table.projectionFor(null).removedSeatIds).toEqual([2]);
    expect(table.state.seats[2]?.status).toBe('empty');
  });

  it('blind changes mid-hand never touch the hand in progress and apply from the next deal', async () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.startNextHand();

    expect(table.updateSettings({ smallBlind: 25, bigBlind: 50, actionSeconds: 40 })).toEqual({ ok: true, deferred: true });
    // In force right now: old blinds, new action time (that one is immediate).
    expect(table.settings.bigBlind).toBe(20);
    expect(table.settings.actionSeconds).toBe(40);
    expect(table.state.config.bigBlind).toBe(20);
    expect(table.projectionFor(null).pendingSettings).toEqual({ smallBlind: 25, bigBlind: 50 });

    await playOut(table);
    expect(table.settings.bigBlind).toBe(50);
    expect(table.state.config.smallBlind).toBe(25);
    expect(table.projectionFor(null).pendingSettings).toBeNull();

    eventsLog.length = 0;
    vi.advanceTimersByTime(10_000); // post-hand break
    table.prepareNextOrbit();
    table.startNextHand();
    const posted = eventsLog.find((e) => e.type === 'blinds-posted');
    expect(posted?.type === 'blinds-posted' && posted.posts.map((p) => p.amount).sort((x, y) => x - y)).toEqual([25, 50]);
  });

  it('between hands, blind changes apply immediately', () => {
    expect(table.updateSettings({ smallBlind: 5, bigBlind: 10 })).toEqual({ ok: true, deferred: false });
    expect(table.settings.smallBlind).toBe(5);
    expect(table.state.config.bigBlind).toBe(10);
  });

  it('rejects settings that would leave the table inconsistent', () => {
    expect(table.updateSettings({ smallBlind: 30 })).toMatchObject({ ok: false, code: 'INVALID_SETTINGS' });
    expect(table.updateSettings({ minBuyIn: 5000 })).toMatchObject({ ok: false, code: 'INVALID_SETTINGS' });
    expect(table.updateSettings({ ante: 21 })).toMatchObject({ ok: false, code: 'INVALID_SETTINGS' });
    expect(table.settings).toEqual(SETTINGS); // nothing partially applied
  });

  it('a rejected change never half-applies, even alongside valid fields', () => {
    expect(table.updateSettings({ name: 'Renamed', smallBlind: 999 }).ok).toBe(false);
    expect(table.name).toBe('Owner Table');
  });

  it('making a table private generates an invite code, and a new buy-in range governs new buy-ins immediately', () => {
    expect(table.inviteCode).toBeNull();
    table.updateSettings({ isPrivate: true, minBuyIn: 100, maxBuyIn: 400 });
    expect(table.inviteCode).toMatch(/^[0-9a-f]{8}$/);
    expect(table.checkBuyInRange(400)).toEqual({ ok: true });
    expect(table.checkBuyInRange(401)).toMatchObject({ ok: false, message: 'Buy-in must be between $1 and $4.' });
  });

  it('a mid-hand reset voids the hand — every bet comes back — applies anything pending, and keeps deleted seats deleted', () => {
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(1, 'b', meta('Bob'), 1000);
    table.deleteSeat(3);
    table.startNextHand();
    table.updateSettings({ smallBlind: 50, bigBlind: 100 });
    table.addChips(0, 300);

    const refunds = table.resetTable();
    // The hand in progress is void: posted blinds come back too, plus the pending rebuy.
    expect(refunds.reduce((sum, r) => sum + r.stack, 0)).toBe(2000 + 300);
    expect(table.settings.bigBlind).toBe(100);
    expect(table.projectionFor(null).removedSeatIds).toEqual([3]);
  });
});

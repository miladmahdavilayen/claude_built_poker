import type { GameEvent } from '@pokerclause/engine';
import type { TableSettings } from '@pokerclause/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';
import { LiveTable } from '../src/game/liveTable.js';

// Amounts are cents: $0.10/$0.20 blinds, $8–$20 buy-in.
const SETTINGS: TableSettings = {
  smallBlind: 10,
  bigBlind: 20,
  ante: 0,
  maxSeats: 6,
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

describe('LiveTable: changing seats', () => {
  let table: LiveTable;
  let eventsLog: GameEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    eventsLog = [];
    table = new LiveTable('table-1', 'Seats', SETTINGS, new MemoryStore(), {
      onBroadcast: (_tableId, _perSeat, raw) => eventsLog.push(...raw),
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    table.takeSeat(2, 'b', meta('Bob'), 1000);
    table.takeSeat(4, 'c', meta('Carol'), 1000);
  });

  afterEach(() => {
    table.dispose();
    vi.useRealTimers();
  });

  const ring = [0, 2, 4];
  const next = (seat: number): number => ring.find((s) => s > seat) ?? ring[0]!;

  it('before the first hand, a move is free and immediate; a taken seat is never available', () => {
    expect(table.moveSeat(0, 1)).toEqual({ ok: true, when: 'now', owes: 0 });
    expect(table.seats[1]!.userId).toBe('a');
    expect(table.seats[0]!.userId).toBeNull();
    expect(table.state.seats[1]!.stack).toBe(1000);
    expect(table.moveSeat(1, 2)).toMatchObject({ ok: false, code: 'SEAT_TAKEN' });
  });

  it('moving away from the big blind owes one, posted live on the next hand; moving no further away is free', async () => {
    table.startNextHand();
    await playOut(table);
    await vi.runAllTimersAsync();
    const lastBb = table.state.lastBigBlindSeat!;
    const due = next(lastBb); // big blind next hand
    const last = next(next(due)); // the furthest from it
    // The furthest from the big blind can sit anywhere for free.
    for (const empty of [1, 3, 5]) expect(table.quoteSeatMove(last, empty)).toMatchObject({ ok: true, owes: 0 });
    // The player due the big blind, moving to just behind it, would skip a whole orbit: owes it.
    const behind = (lastBb + 5) % 6;
    expect(table.moveSeat(due, behind)).toEqual({ ok: true, when: 'now', owes: 20 });
    expect(table.projectionFor(behind).seats[behind]?.missedBigBlind).toBe(true);
    eventsLog = [];
    await vi.advanceTimersByTimeAsync(10_000);
    table.startNextHand();
    const posts = eventsLog.flatMap((e) => (e.type === 'blinds-posted' ? e.posts : []));
    expect(posts).toContainEqual({ seatId: behind, kind: 'missed-big-blind', amount: 20, allIn: false });
    expect(table.state.seats[behind]!.committedThisStreet).toBe(20);
    expect(table.state.seats[behind]!.missedBigBlind).toBe(false);
  });

  it('asked mid-hand, the move waits for the hand to end, the new seat held meanwhile', async () => {
    table.startNextHand();
    expect(table.quoteSeatMove(0, 5)).toMatchObject({ ok: true, when: 'after-hand' });
    expect(table.moveSeat(0, 5)).toMatchObject({ ok: true, when: 'after-hand' });
    expect(table.projectionFor(0).seats[0]?.movingToSeatId).toBe(5);
    expect(table.seats[0]!.userId).toBe('a');
    // Held: nobody else can take it or move into it meanwhile.
    expect(table.moveSeat(2, 5)).toMatchObject({ ok: false, code: 'SEAT_TAKEN' });
    const total = table.state.seats.reduce((n, s) => n + s.stack + s.committedThisHand, 0);
    await playOut(table);
    await vi.runAllTimersAsync();
    expect(table.seats[5]!.userId).toBe('a');
    expect(table.seats[0]!.userId).toBeNull();
    expect(table.state.seats[0]!.status).toBe('empty');
    // Every chip is still on the table.
    expect(table.state.seats.reduce((n, s) => n + s.stack, 0)).toBe(total);
  });
});

describe('LiveTable: the owner moving a computer player', () => {
  let table: LiveTable;

  beforeEach(() => {
    vi.useFakeTimers();
    table = new LiveTable('table-2', 'Bots', SETTINGS, new MemoryStore(), {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
    table.takeSeat(0, 'a', meta('Alice'), 1000);
    expect(table.addBot(3, 'calling-station', 1000)).toMatchObject({ ok: true });
  });

  afterEach(() => {
    table.dispose();
    vi.useRealTimers();
  });

  it('between hands it moves at once, stack and all; only a computer player, and only to an empty seat', () => {
    expect(table.moveBot(3, 5)).toEqual({ ok: true, when: 'now', owes: 0 });
    expect(table.seats[5]!.botPolicyName).toBeTruthy();
    expect(table.state.seats[5]!.stack).toBe(1000);
    expect(table.state.seats[3]!.status).toBe('empty');
    expect(table.moveBot(5, 0)).toMatchObject({ ok: false, code: 'SEAT_TAKEN' });
    expect(table.moveBot(0, 1)).toMatchObject({ ok: false, code: 'NOT_A_BOT' });
    expect(table.moveBot(2, 1)).toMatchObject({ ok: false, code: 'NOT_A_BOT' });
  });

  it('mid-hand, it moves once the hand is over, and keeps playing from its new seat', async () => {
    table.startNextHand();
    expect(table.moveBot(3, 1)).toMatchObject({ ok: true, when: 'after-hand' });
    expect(table.seats[3]!.botPolicyName).toBeTruthy();
    await playOut(table);
    await vi.runAllTimersAsync();
    expect(table.seats[1]!.botPolicyName).toBeTruthy();
    expect(table.state.seats[3]!.status).toBe('empty');
    await vi.advanceTimersByTimeAsync(10_000);
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');
    await playOut(table);
  });
});

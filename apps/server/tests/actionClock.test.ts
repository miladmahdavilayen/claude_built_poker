import type { TableSettings } from '@pokerclause/shared';
import { mentionedNames } from '@pokerclause/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';
import { LiveTable } from '../src/game/liveTable.js';

const SETTINGS: TableSettings = {
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  maxSeats: 4,
  straddleEnabled: false,
  minBuyIn: 80,
  maxBuyIn: 2000,
  actionSeconds: 30,
  timeBankSeconds: 60,
  runItTwiceEnabled: false,
  rakePercent: 0,
  rakeCap: 0,
  noFlopNoDrop: true,
  isPrivate: false,
  disableChatInHand: false,
};

function meta(name: string) {
  return { displayName: name, isGuest: true, avatarSeed: 'seed', clientSeed: `client-${name}` };
}

describe('LiveTable: the action clock, bought time, pokes and the owner’s sit-out', () => {
  let table: LiveTable;

  beforeEach(() => {
    vi.useFakeTimers();
    table = new LiveTable('table-1', 'Test Table', SETTINGS, new MemoryStore(), {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    table.dispose();
    vi.useRealTimers();
  });

  /** Three people, a hand dealt: returns who's on the clock. */
  function deal(stacks: [number, number, number] = [200, 200, 200]): number {
    table.takeSeat(0, 'user-a', meta('Alice'), stacks[0]);
    table.takeSeat(1, 'user-b', meta('Bob'), stacks[1]);
    table.takeSeat(2, 'user-c', meta('Cy'), stacks[2]);
    table.startNextHand();
    return table.state.betting.actingSeat!;
  }

  it('gives 30 seconds, then 30 in red, then a 10 second final warning — and only then acts for the player', () => {
    const acting = deal();
    const clock = table.projectionFor(null).actionClock!;
    expect(clock.seatId).toBe(acting);
    expect(clock.normalEndsAt - clock.startedAt).toBe(30_000);
    expect(clock.redEndsAt - clock.normalEndsAt).toBe(30_000);
    expect(clock.endsAt - clock.redEndsAt).toBe(10_000);
    expect(table.projectionFor(null).actionDeadline).toBe(clock.normalEndsAt);

    vi.advanceTimersByTime(69_000);
    expect(table.state.betting.actingSeat).toBe(acting);
    vi.advanceTimersByTime(1_100);
    // Out of time facing the big blind: folded, and the clock is on the next player.
    expect(table.state.seats[acting]!.status).toBe('folded');
    expect(table.projectionFor(null).actionClock?.seatId).toBe(table.state.betting.actingSeat);
  });

  it('sells more time for a small blind from a short stack: into the pot, the red stretch 30 seconds longer, twice a turn at most', () => {
    const acting = deal([80, 80, 80]);
    const before = table.state.seats[acting]!.stack;
    const handId = table.handId!;
    expect(table.projectionFor(acting).actionClock!.timeBuyCost).toBe(1);

    const first = table.projectionFor(null).actionClock!;
    expect(table.buyTime(acting, handId)).toEqual({ ok: true, cost: 1, seconds: 30 });
    const second = table.projectionFor(null).actionClock!;
    expect(second.redEndsAt).toBe(first.redEndsAt + 30_000);
    expect(second.endsAt).toBe(first.endsAt + 30_000);
    expect(table.state.seats[acting]!.stack).toBe(before - 1);
    expect(table.state.anteTotal).toBe(1);
    // Still their turn, same legal actions as before.
    expect(table.state.betting.actingSeat).toBe(acting);

    expect(table.buyTime(acting, handId).ok).toBe(true);
    expect(table.projectionFor(null).actionClock!.timeBuyCost).toBeNull();
    expect(table.buyTime(acting, handId)).toMatchObject({ ok: false, code: 'CANNOT_BUY_TIME' });
    // Not anyone else's to buy, and not for another hand.
    expect(table.buyTime((acting + 1) % 3, handId)).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(table.buyTime(acting, 'another-hand')).toMatchObject({ ok: false, code: 'STALE_HAND' });

    // The whole clock, with both purchases: 30 + 30 + 60 + 10.
    vi.advanceTimersByTime(129_000);
    expect(table.state.betting.actingSeat).toBe(acting);
    vi.advanceTimersByTime(1_100);
    expect(table.state.seats[acting]!.status).toBe('folded');
  });

  it('bought during the final warning, the extra time counts from now', () => {
    const acting = deal();
    vi.advanceTimersByTime(65_000);
    expect(table.buyTime(acting, table.handId!).ok).toBe(true);
    const clock = table.projectionFor(null).actionClock!;
    expect(clock.redEndsAt).toBe(Date.now() + 30_000);
    expect(clock.endsAt).toBe(Date.now() + 40_000);
  });

  it('costs a big blind from a deep stack, and the money bought with stays in the game: every chip is still on the table', async () => {
    const acting = deal([1000, 1000, 1000]);
    expect(table.projectionFor(null).actionClock!.timeBuyCost).toBe(2);
    expect(table.buyTime(acting, table.handId!)).toMatchObject({ ok: true, cost: 2 });
    // Voided now, they'd get it back along with anything else they put in.
    const committed = table.state.seats[acting]!.committedThisHand;
    expect(table.voidedHandRefund(acting)).toBe(table.state.seats[acting]!.stack + committed + 2);

    let guard = 0;
    while (table.state.phase === 'in-hand' && guard++ < 60) {
      const seatId = table.state.betting.actingSeat!;
      const toCall = table.state.betting.currentBet - table.state.seats[seatId]!.committedThisStreet;
      expect(table.applyPlayerAction(seatId, { seatId, type: toCall > 0 ? 'call' : 'check' }).ok).toBe(true);
    }
    expect(table.state.phase).toBe('hand-complete');
    expect(table.state.seats.reduce((sum, s) => sum + s.stack, 0)).toBe(3000);
    await vi.advanceTimersByTimeAsync(20);
  });

  it('lets each other player poke once, and only after the first 30 seconds', () => {
    const acting = deal();
    const others = [0, 1, 2].filter((id) => id !== acting);
    expect(table.poke(others[0]!)).toMatchObject({ ok: false, code: 'TOO_EARLY' });
    vi.advanceTimersByTime(30_500);
    expect(table.poke(acting)).toMatchObject({ ok: false, code: 'CANNOT_POKE' });
    expect(table.poke(others[0]!)).toEqual({ ok: true, targetSeatId: acting });
    expect(table.poke(others[0]!)).toMatchObject({ ok: false, code: 'ALREADY_POKED' });
    expect(table.poke(others[1]!)).toEqual({ ok: true, targetSeatId: acting });
    expect(table.projectionFor(null).actionClock!.pokedBy).toEqual([...others].sort());
    // An empty seat can't poke.
    expect(table.poke(3)).toMatchObject({ ok: false, code: 'NOT_SEATED' });

    // A new turn is a new clock: nobody has poked it.
    table.applyPlayerAction(acting, { seatId: acting, type: 'fold' });
    expect(table.projectionFor(null).actionClock!.pokedBy).toEqual([]);
  });

  it('a computer player is never poked', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 200);
    table.addBot(1, 'calling-station', 200);
    table.startNextHand();
    if (table.state.betting.actingSeat === 1) {
      expect(table.projectionFor(null).actionClock).toBeNull();
      expect(table.poke(0)).toMatchObject({ ok: false, code: 'NO_ONE_TO_POKE' });
    }
  });

  it('the owner sits a player out mid-hand: played for them when their turn comes, out of the next hands, until they sit back in', () => {
    const acting = deal();
    expect(table.ownerSitOut(acting)).toEqual({ ok: true });
    expect(table.projectionFor(null).seats[acting]!.satOutByOwner).toBe(true);
    // On the clock right then: no clock for them, and they're folded (there's a bet to call) a moment later.
    expect(table.projectionFor(null).actionClock).toBeNull();
    vi.advanceTimersByTime(500);
    expect(table.state.seats[acting]!.status).toBe('folded');

    // The hand plays out between the other two.
    let guard = 0;
    while (table.state.phase === 'in-hand' && guard++ < 60) {
      const seatId = table.state.betting.actingSeat!;
      const toCall = table.state.betting.currentBet - table.state.seats[seatId]!.committedThisStreet;
      table.applyPlayerAction(seatId, { seatId, type: toCall > 0 ? 'call' : 'check' });
    }
    vi.advanceTimersByTime(8_000);
    table.prepareNextOrbit();
    table.startNextHand();
    expect(table.state.seats[acting]!.status).toBe('sitting-out');
    expect(table.state.seats[acting]!.holeCards).toHaveLength(0);

    // Back: their own sit-in clears it, from the next hand.
    table.sitIn(acting);
    expect(table.projectionFor(null).seats[acting]!.satOutByOwner).toBe(false);
    expect(table.projectionFor(null).seats[acting]!.sittingOutNextHand).toBe(false);
  });

  it('sat out later in the hand, with nothing to call, they are checked rather than folded; the owner can sit them back in', () => {
    const acting = deal();
    // Everyone calls round to the flop.
    let guard = 0;
    while (table.state.board.length === 0 && table.state.phase === 'in-hand' && guard++ < 10) {
      const seatId = table.state.betting.actingSeat!;
      const toCall = table.state.betting.currentBet - table.state.seats[seatId]!.committedThisStreet;
      table.applyPlayerAction(seatId, { seatId, type: toCall > 0 ? 'call' : 'check' });
    }
    expect(acting).toBeGreaterThanOrEqual(0);
    expect(table.state.board.length).toBe(3);
    const first = table.state.betting.actingSeat!;
    expect(table.ownerSitOut(first)).toEqual({ ok: true });
    vi.advanceTimersByTime(500);
    expect(table.state.seats[first]!.status).toBe('active');
    expect(table.state.betting.actingSeat).not.toBe(first);

    expect(table.ownerSitIn(first)).toEqual({ ok: true });
    expect(table.projectionFor(null).seats[first]!.satOutByOwner).toBe(false);
    expect(table.ownerSitOut(3)).toMatchObject({ ok: false, code: 'SEAT_EMPTY' });
  });
});

describe('chat mentions', () => {
  it('finds the names a message mentions, whatever the case, longest name first', () => {
    expect(mentionedNames('hey @alice your turn', ['Alice', 'Bob'])).toEqual(['Alice']);
    expect(mentionedNames('@Ann Lee and @bob', ['Ann', 'Ann Lee', 'Bob'])).toEqual(['Ann Lee', 'Bob']);
    expect(mentionedNames('no one here, alice', ['Alice'])).toEqual([]);
    expect(mentionedNames('mail me at a@bob.com', ['Bobby'])).toEqual([]);
  });
});

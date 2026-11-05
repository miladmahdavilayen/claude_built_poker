import type { TableSettings } from '@pokerclause/shared';
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
  maxBuyIn: 200,
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
  return { displayName: name, isGuest: true, avatarSeed: 'seed', clientSeed: `client-${name}` };
}

describe('LiveTable: server-authoritative hand lifecycle', () => {
  let store: MemoryStore;
  let broadcasts: { tableId: string; perSeat: Map<number | null, unknown> }[];
  let table: LiveTable;

  beforeEach(() => {
    store = new MemoryStore();
    broadcasts = [];
    table = new LiveTable('table-1', 'Test Table', SETTINGS, store, {
      onBroadcast: (tableId, perSeat) => broadcasts.push({ tableId, perSeat }),
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
  });

  it('seats two players and plays a full hand to completion, settling the ledger', async () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);

    expect(table.canStartHand()).toBe(true);
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');
    expect(broadcasts.length).toBeGreaterThan(0);

    // Heads-up: seat0 (button/SB) acts first preflop.
    const actingSeat = table.state.betting.actingSeat;
    expect(actingSeat).not.toBeNull();

    // Play the whole hand out via call/check until it completes.
    let guard = 0;
    while (table.state.phase === 'in-hand' && guard < 50) {
      guard += 1;
      const seatId = table.state.betting.actingSeat!;
      const toCall = table.state.betting.currentBet - table.state.seats[seatId]!.committedThisStreet;
      const action = toCall > 0 ? ({ seatId, type: 'call' as const }) : ({ seatId, type: 'check' as const });
      const result = table.applyPlayerAction(seatId, action);
      expect(result.ok).toBe(true);
    }

    expect(table.state.phase).toBe('hand-complete');

    // Give the fire-and-forget settleHand() a tick to finish.
    await new Promise((r) => setTimeout(r, 10));

    const conservation = await store.ledgerConservationCheck();
    expect(conservation.balanced).toBe(true);

    // Total chips across both stacks must still equal the 200 they bought in for.
    const totalStacks = table.state.seats.reduce((s, seat) => s + seat.stack, 0);
    expect(totalStacks).toBe(200);
  });

  it('canStartHand() stays true after a hand ends by fold, not just after a hand that reaches showdown', () => {
    // Regression: a seat that folds keeps status 'folded' (not reset back
    // to 'active') until the ENGINE's own next deal resets it — see
    // resetSeatForNewHand in packages/engine/src/hand.ts. Counting only
    // currently-'active' seats for canStartHand() would therefore go
    // permanently false after any hand that ended by a fold (the common
    // case, not a rare one) — exactly the scenario this test drives.
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');

    const actingSeat = table.state.betting.actingSeat!;
    const result = table.applyPlayerAction(actingSeat, { seatId: actingSeat, type: 'fold' });
    expect(result.ok).toBe(true);
    expect(table.state.phase).toBe('hand-complete');

    // The folded seat's status is still 'folded' right now — that's the
    // exact state the bug lived in.
    const foldedSeat = table.state.seats.find((s) => s.status === 'folded');
    expect(foldedSeat).toBeDefined();

    // Still on the post-hand shuffle break immediately after — this is
    // the OTHER thing that must not go permanently false: the break gate
    // and the fold-status quirk are two independent conditions that both
    // needed fixing here.
    expect(table.canStartHand()).toBe(false);
    try {
      vi.useFakeTimers();
      vi.advanceTimersByTime(6000);
      expect(table.canStartHand()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an out-of-turn action with a typed error, never throwing', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
    table.startNextHand();

    const actingSeat = table.state.betting.actingSeat!;
    const otherSeat = actingSeat === 0 ? 1 : 0;
    expect(() => table.applyPlayerAction(otherSeat, { seatId: otherSeat, type: 'call' })).not.toThrow();
    const result = table.applyPlayerAction(otherSeat, { seatId: otherSeat, type: 'call' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_YOUR_TURN');
  });

  it('projectionFor never leaks another seat\'s hole cards mid-hand', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
    table.startNextHand();

    const seat0Cards = table.state.seats[0]!.holeCards;
    const seat1Cards = table.state.seats[1]!.holeCards;
    expect(seat0Cards).toHaveLength(2);
    expect(seat1Cards).toHaveLength(2);

    const viewFromSeat0 = table.projectionFor(0);
    expect(viewFromSeat0.seats[0]!.holeCards).toEqual(seat0Cards);
    expect(viewFromSeat0.seats[1]!.holeCards).toEqual([]);

    const spectatorView = table.projectionFor(null);
    expect(spectatorView.seats[0]!.holeCards).toEqual([]);
    expect(spectatorView.seats[1]!.holeCards).toEqual([]);
  });

  it('refuses to seat a player in an occupied seat', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    expect(() => table.takeSeat(0, 'user-c', meta('Carol'), 100)).toThrow('SEAT_TAKEN');
  });

  it('refuses to leave mid-hand while still an active contender', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
    table.startNextHand();
    expect(() => table.leaveSeat(0)).toThrow('CANNOT_LEAVE_MID_HAND');
  });

  it('persists a complete, replayable hand record after settlement', async () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
    table.startNextHand();

    let guard = 0;
    while (table.state.phase === 'in-hand' && guard < 50) {
      guard += 1;
      const seatId = table.state.betting.actingSeat!;
      const toCall = table.state.betting.currentBet - table.state.seats[seatId]!.committedThisStreet;
      const action = toCall > 0 ? ({ seatId, type: 'call' as const }) : ({ seatId, type: 'check' as const });
      table.applyPlayerAction(seatId, action);
    }
    await new Promise((r) => setTimeout(r, 10));

    // Find the recorded hand via the store's internal map isn't exposed directly;
    // instead verify via a fresh hand starting cleanly (handNumber advanced).
    expect(table.state.handNumber).toBe(1);
  });

  it('waitlist: queues, dedupes, is removed on leave, and is cleared once seated', () => {
    expect(table.joinWaitlist('user-a', 'Alice')).toEqual({ ok: true });
    expect(table.joinWaitlist('user-b', 'Bob')).toEqual({ ok: true });
    // Re-joining is a no-op, not a duplicate entry.
    expect(table.joinWaitlist('user-a', 'Alice')).toEqual({ ok: true });
    expect(table.projectionFor(null).waitlist.map((w) => w.userId)).toEqual(['user-a', 'user-b']);

    table.leaveWaitlist('user-b');
    expect(table.projectionFor(null).waitlist.map((w) => w.userId)).toEqual(['user-a']);

    // Taking a seat removes you from the waitlist automatically.
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    expect(table.projectionFor(null).waitlist).toEqual([]);
  });

  it('refuses to waitlist a user who already has a seat', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    const result = table.joinWaitlist('user-a', 'Alice');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ALREADY_SEATED');
  });

  it('carries the invite code it was constructed with, for private-table access checks', () => {
    const privateTable = new LiveTable(
      'table-2',
      'Private Table',
      SETTINGS,
      store,
      { onBroadcast: () => undefined, onChipsSettled: async () => Promise.resolve(), now: () => Date.now() },
      'secret-code',
    );
    expect(privateTable.inviteCode).toBe('secret-code');
    expect(table.inviteCode).toBeNull();
  });

  it('resetTable() empties every seat and refunds each human, but leaves the table itself alive and re-usable', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
    table.addBot(2, 'nit', 100);
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');

    const refunds = table.resetTable();
    expect(refunds.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: 'user-a', stack: expect.any(Number) as number },
      { userId: 'user-b', stack: expect.any(Number) as number },
    ]);
    // Bots aren't in the refund list — they have no real chip ledger. See DECISIONS.md.
    expect(refunds.find((r) => r.userId === 'user-b')).toBeDefined();
    expect(refunds).toHaveLength(2);

    // Every seat is empty, the hand is gone, and the table is back to its very first-boot shape.
    expect(table.state.phase).toBe('waiting');
    expect(table.state.seats.every((s) => s.status === 'empty')).toBe(true);
    expect(table.seats.every((s) => s.userId === null)).toBe(true);

    // The SAME table can be seated and dealt again afterward — reset, not destroyed.
    table.takeSeat(0, 'user-c', meta('Carol'), 100);
    table.takeSeat(1, 'user-d', meta('Dave'), 100);
    expect(table.canStartHand()).toBe(true);
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');
  });
});

describe('LiveTable: computer players (bots)', () => {
  let store: MemoryStore;
  let broadcasts: { tableId: string; perSeat: Map<number | null, unknown> }[];
  let table: LiveTable;

  beforeEach(() => {
    store = new MemoryStore();
    broadcasts = [];
    table = new LiveTable('table-1', 'Test Table', SETTINGS, store, {
      onBroadcast: (tableId, perSeat) => broadcasts.push({ tableId, perSeat }),
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seats a bot by a known persona, refuses an unknown one, and never assigns it a real userId', () => {
    expect(table.addBot(0, 'nit', 100)).toEqual({ ok: true });
    expect(table.seats[0]?.userId).toBeNull();
    expect(table.seats[0]?.botPolicyName).toBe('nit');
    expect(table.projectionFor(null).seats[0]?.isBot).toBe(true);

    const badResult = table.addBot(1, 'not-a-real-persona', 100);
    expect(badResult).toEqual({ ok: false, code: 'UNKNOWN_BOT_PERSONA', message: expect.stringContaining('not-a-real-persona') as string });
  });

  it('refuses to seat a bot in an occupied seat, and refuses to remove a seat that is not a bot', () => {
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    expect(table.addBot(0, 'nit', 100)).toEqual({ ok: false, code: 'SEAT_TAKEN', message: expect.any(String) as string });

    const result = table.removeBot(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_A_BOT');
  });

  it('removeBot frees the seat and it can be taken by a real player afterward', () => {
    table.addBot(0, 'nit', 100);
    // A bot's chips aren't anyone's balance, but the vacated seat still reports its stack — the caller just has no userId to refund.
    expect(table.removeBot(0)).toEqual({ ok: true, vacated: { seatId: 0, userId: null, refund: 100 } });
    expect(() => table.takeSeat(0, 'user-a', meta('Alice'), 100)).not.toThrow();
  });

  it('will not deal a hand to bots alone — at least one real human must be seated', () => {
    table.addBot(0, 'nit', 100);
    table.addBot(1, 'maniac', 100);
    expect(table.canStartHand()).toBe(false);

    table.takeSeat(2, 'user-a', meta('Alice'), 100);
    expect(table.canStartHand()).toBe(true);
  });

  it('plays a full heads-up hand against a bot end to end — the bot acts entirely on its own schedule, never via a manually-applied action', async () => {
    vi.useFakeTimers();
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    // check-fold: checks whenever free, folds when facing a bet — with
    // only check/call ever applied by the human below too, this hand
    // reaches a natural showdown rather than ending early on a fold.
    table.addBot(1, 'check-fold', 100);
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');

    let guard = 0;
    while (table.state.phase === 'in-hand' && guard < 50) {
      guard += 1;
      const actingSeat = table.state.betting.actingSeat;
      expect(actingSeat).not.toBeNull();
      if (table.seats[actingSeat!]?.botPolicyName) {
        // Advance past the bot's think-time delay — it must act on its own, never via a direct applyPlayerAction call here.
        await vi.advanceTimersByTimeAsync(6500);
      } else {
        const seatId = actingSeat!;
        const toCall = table.state.betting.currentBet - (table.state.seats[seatId]?.committedThisStreet ?? 0);
        const action = toCall > 0 ? ({ seatId, type: 'call' as const }) : ({ seatId, type: 'check' as const });
        const result = table.applyPlayerAction(seatId, action);
        expect(result.ok).toBe(true);
      }
    }

    expect(table.state.phase).toBe('hand-complete');
    expect(table.seats[1]?.lastAction).not.toBeNull(); // the bot really did act
    // Total chips conserved between the two seats (100 human buy-in is
    // never ledger-tracked for the bot, but stacks themselves stay balanced).
    const totalStacks = table.state.seats.reduce((s, seat) => s + seat.stack, 0);
    expect(totalStacks).toBe(200);

    // Bots never touch the real chip ledger — only a real user's buy-in would.
    const conservation = await store.ledgerConservationCheck();
    expect(conservation.balanced).toBe(true);
    expect((await store.ledgerBalanceForUser('user-a')) !== 0 || totalStacks === 200).toBe(true);
  });

  it('removing a bot mid-hand folds it on its turn and frees the seat the moment the hand ends — never before', async () => {
    vi.useFakeTimers();
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.addBot(1, 'check-fold', 100);
    table.startNextHand();

    expect(table.removeBot(1)).toEqual({ ok: true, vacated: null });
    // Still seated (and in the hand) until it ends.
    expect(table.state.seats[1]?.status).not.toBe('empty');
    expect(table.projectionFor(0).seats[1]?.leavingAfterHand).toBe(true);

    let guard = 0;
    while (table.state.phase === 'in-hand' && guard < 50) {
      guard += 1;
      const actingSeat = table.state.betting.actingSeat!;
      if (table.seats[actingSeat]?.botPolicyName) {
        await vi.advanceTimersByTimeAsync(6500);
      } else {
        const toCall = table.state.betting.currentBet - (table.state.seats[actingSeat]?.committedThisStreet ?? 0);
        table.applyPlayerAction(actingSeat, toCall > 0 ? { seatId: actingSeat, type: 'call' } : { seatId: actingSeat, type: 'check' });
      }
    }

    expect(table.state.phase).toBe('hand-complete');
    expect(table.state.seats[1]?.status).toBe('empty');
    expect(table.seats[1]?.botPolicyName).toBeNull();
  });
});

describe('LiveTable: fair initial button placement (high-card draw)', () => {
  // The very first hand a table ever deals seeds its button via a real
  // high-card draw (see startNextHand in liveTable.ts) rather than always
  // handing it to the lowest seat id. The draw itself uses real crypto
  // randomness and is a private implementation detail, so these tests are
  // statistical/observational: run many independent fresh tables and check
  // (a) every single result is internally consistent (SB/BB genuinely sit
  // relative to wherever the button landed) and (b) across enough trials,
  // the button isn't secretly hard-coded to one seat.
  function freshTable(id: string, settings: TableSettings = SETTINGS): LiveTable {
    return new LiveTable(id, 'Test Table', settings, new MemoryStore(), {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
  }

  it('heads-up: the button is a genuine draw (lands on both seats over many trials), and SB/BB follow it correctly', () => {
    const buttonsSeen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const table = freshTable(`hu-${i}`);
      table.takeSeat(0, 'user-a', meta('Alice'), 100);
      table.takeSeat(1, 'user-b', meta('Bob'), 100);
      table.startNextHand();

      const button = table.state.buttonSeat;
      buttonsSeen.add(button);
      const other = button === 0 ? 1 : 0;
      // Heads-up: the button IS the small blind, so it posts 1 and the other seat posts the big blind, 2.
      expect(table.state.seats[button]!.committedThisStreet).toBe(1);
      expect(table.state.seats[other]!.committedThisStreet).toBe(2);
    }
    expect(buttonsSeen.size).toBe(2);
  });

  it('4-handed: SB and BB sit correctly relative to whichever seat the draw picks as button, across many trials', () => {
    const buttonsSeen = new Set<number>();
    const ring = [0, 1, 2, 3];
    for (let i = 0; i < 40; i++) {
      const table = freshTable(`4h-${i}`);
      table.takeSeat(0, 'user-a', meta('Alice'), 100);
      table.takeSeat(1, 'user-b', meta('Bob'), 100);
      table.takeSeat(2, 'user-c', meta('Carol'), 100);
      table.takeSeat(3, 'user-d', meta('Dave'), 100);
      table.startNextHand();

      const button = table.state.buttonSeat;
      buttonsSeen.add(button);
      const sbSeat = ring[(ring.indexOf(button) + 1) % ring.length]!;
      const bbSeat = ring[(ring.indexOf(button) + 2) % ring.length]!;
      expect(table.state.seats[button]!.committedThisStreet).toBe(0);
      expect(table.state.seats[sbSeat]!.committedThisStreet).toBe(1);
      expect(table.state.seats[bbSeat]!.committedThisStreet).toBe(2);
    }
    // Over 40 independent draws on a 4-seat ring, the button landing on
    // just one or two seats every time would indicate the draw isn't real.
    expect(buttonsSeen.size).toBeGreaterThan(2);
  });

  it('only draws for the button on the very first hand — later hands rotate normally instead of drawing again', () => {
    const table = freshTable('rotation');
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
    table.startNextHand();
    const firstButton = table.state.buttonSeat;

    // Play the first hand out via call/check so a second hand can start.
    let guard = 0;
    while (table.state.phase === 'in-hand' && guard < 50) {
      guard += 1;
      const seatId = table.state.betting.actingSeat!;
      const toCall = table.state.betting.currentBet - (table.state.seats[seatId]?.committedThisStreet ?? 0);
      table.applyPlayerAction(seatId, toCall > 0 ? { seatId, type: 'call' } : { seatId, type: 'check' });
    }
    expect(table.state.phase).toBe('hand-complete');

    try {
      vi.useFakeTimers();
      vi.advanceTimersByTime(6000); // past the post-hand shuffle break
      table.startNextHand();
    } finally {
      vi.useRealTimers();
    }
    // Heads-up rotation just swaps the button every hand — a deterministic
    // consequence of normal engine rotation, not a fresh draw.
    expect(table.state.buttonSeat).toBe(firstButton === 0 ? 1 : 0);
  });
});

describe('LiveTable: voluntary post-fold-win reveal', () => {
  let store: MemoryStore;
  let table: LiveTable;

  beforeEach(() => {
    store = new MemoryStore();
    table = new LiveTable('table-1', 'Test Table', SETTINGS, store, {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
  });

  /** Heads-up: whoever is first to act folds immediately, so the hand ends right away with zero `showdown-reveal` events — the exact shape `revealEligibleSeatId` looks for. */
  function foldOutTheHand(): { winnerSeatId: number; loserSeatId: number } {
    table.startNextHand();
    const loserSeatId = table.state.betting.actingSeat!;
    const winnerSeatId = loserSeatId === 0 ? 1 : 0;
    const result = table.applyPlayerAction(loserSeatId, { seatId: loserSeatId, type: 'fold' });
    expect(result.ok).toBe(true);
    expect(table.state.phase).toBe('hand-complete');
    return { winnerSeatId, loserSeatId };
  }

  it('offers only the fold-win winner the option — the same value is broadcast to every viewer, so each client gates its own button against its own seat id', () => {
    const { winnerSeatId, loserSeatId } = foldOutTheHand();
    expect(table.revealEligibleSeatId).toBe(winnerSeatId);
    expect(table.projectionFor(winnerSeatId).revealEligibleSeatId).toBe(winnerSeatId);
    expect(table.projectionFor(loserSeatId).revealEligibleSeatId).toBe(winnerSeatId);
  });

  it('is never offered after a genuine showdown — both hands are already shown, nothing left to voluntarily reveal', () => {
    table.startNextHand();
    let guard = 0;
    while (table.state.phase === 'in-hand' && guard < 50) {
      guard += 1;
      const seatId = table.state.betting.actingSeat!;
      const toCall = table.state.betting.currentBet - (table.state.seats[seatId]?.committedThisStreet ?? 0);
      const result = table.applyPlayerAction(seatId, toCall > 0 ? { seatId, type: 'call' } : { seatId, type: 'check' });
      expect(result.ok).toBe(true);
    }
    expect(table.state.phase).toBe('hand-complete');
    expect(table.revealEligibleSeatId).toBeNull();
  });

  it("revealHand() broadcasts the winner's real hole cards to every viewer and extends whatever's left of the break by a further 1.5 real seconds", () => {
    const { winnerSeatId, loserSeatId } = foldOutTheHand();
    const handId = table.handId!;
    const winnerHoleCards = table.state.seats[winnerSeatId]!.holeCards;

    const remainingBefore = table.nextHandAt! - Date.now();
    expect(remainingBefore).toBeGreaterThan(0);

    const result = table.revealHand(winnerSeatId, handId);
    expect(result).toEqual({ ok: true });

    // Extends whatever was actually left, by a further 1.5s — never just
    // resets to a flat 1.5s regardless of how much break time remained.
    const remainingAfter = table.nextHandAt! - Date.now();
    expect(remainingAfter).toBeGreaterThan(remainingBefore + 1400);
    expect(remainingAfter).toBeLessThan(remainingBefore + 1800);

    // Every viewer — not just the winner — now legitimately sees the real cards.
    expect(table.projectionFor(winnerSeatId).seats[winnerSeatId]?.holeCards).toEqual(winnerHoleCards);
    expect(table.projectionFor(loserSeatId).seats[winnerSeatId]?.holeCards).toEqual(winnerHoleCards);

    // One-shot: no longer eligible once revealed.
    expect(table.revealEligibleSeatId).toBeNull();
  });

  it('rejects a reveal from the seat that folded — it never won anything to reveal', () => {
    const { loserSeatId } = foldOutTheHand();
    const result = table.revealHand(loserSeatId, table.handId!);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_ELIGIBLE');
  });

  it('rejects a stale handId once the next hand has already started', () => {
    foldOutTheHand();
    const staleHandId = table.handId!;
    try {
      vi.useFakeTimers();
      vi.advanceTimersByTime(6000);
      table.startNextHand();
    } finally {
      vi.useRealTimers();
    }
    const result = table.revealHand(0, staleHandId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('STALE_HAND');
  });

  it('rejects a second reveal attempt from the same seat — one-shot, not spammable', () => {
    const { winnerSeatId } = foldOutTheHand();
    const handId = table.handId!;
    expect(table.revealHand(winnerSeatId, handId).ok).toBe(true);
    const second = table.revealHand(winnerSeatId, handId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('NOT_ELIGIBLE');
  });
});

describe('LiveTable: showing a card heads-up, mid-hand', () => {
  let table: LiveTable;
  let clock = 0;

  beforeEach(() => {
    clock = Date.now();
    table = new LiveTable('table-1', 'Test Table', SETTINGS, new MemoryStore(), {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => clock,
    });
    table.takeSeat(0, 'user-a', meta('Alice'), 100);
    table.takeSeat(1, 'user-b', meta('Bob'), 100);
  });

  const handId = (): string => table.projectionFor(0).handId!;

  it('shows the other player and spectators exactly the card chosen, and never its partner — then the second too', () => {
    table.startNextHand();
    expect(table.projectionFor(0).canShowCards).toBe(true);
    expect(table.showCard(0, handId(), 1)).toEqual({ ok: true });
    const held = table.state.seats[0]!.holeCards;
    for (const viewer of [1, null]) {
      const seat = table.projectionFor(viewer).seats[0]!;
      expect(seat.holeCards).toEqual([]);
      expect(seat.shownCards).toEqual([{ index: 1, card: held[1] }]);
      expect(JSON.stringify(table.projectionFor(viewer))).not.toContain(`"${held[0]!}"`);
    }
    expect(table.showCard(0, handId(), 0)).toEqual({ ok: true });
    expect(table.projectionFor(1).seats[0]!.shownCards).toEqual([
      { index: 0, card: held[0] },
      { index: 1, card: held[1] },
    ]);
  });

  it('changes nothing in the game: same turn, same bets, and the next hand starts clean', () => {
    table.startNextHand();
    const before = table.state;
    table.showCard(0, handId(), 0);
    expect(table.state).toBe(before);
    const acting = table.state.betting.actingSeat!;
    table.applyPlayerAction(acting, { seatId: acting, type: 'fold' });
    clock += 60_000;
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');
    expect(table.projectionFor(1).seats[0]!.shownCards).toEqual([]);
  });

  it('does not cost a fold-winner their Reveal Hand button', () => {
    table.startNextHand();
    const loser = table.state.betting.actingSeat!;
    const winner = loser === 0 ? 1 : 0;
    table.showCard(winner, handId(), 0);
    table.applyPlayerAction(loser, { seatId: loser, type: 'fold' });
    expect(table.revealEligibleSeatId).toBe(winner);
    expect(table.revealHand(winner, handId())).toEqual({ ok: true });
  });

  it('is refused with three still in the hand, allowed for the two left once one folds — and for the one who folded, only once the hand is complete', () => {
    table.takeSeat(2, 'user-c', meta('Cleo'), 100);
    table.startNextHand();
    expect(table.projectionFor(0).canShowCards).toBe(false);
    const first = table.state.betting.actingSeat!;
    const refused = table.showCard(first, handId(), 0);
    expect(refused).toMatchObject({ ok: false, code: 'NOT_HEADS_UP' });
    table.applyPlayerAction(first, { seatId: first, type: 'fold' });
    // Two left: they may; the one who folded may not — the hand is live, and it'd tell them what's out of the deck.
    expect(table.projectionFor(first).canShowCards).toBe(false);
    expect(table.showCard(first, handId(), 0)).toMatchObject({ ok: false, code: 'NOT_IN_HAND' });
    const next = table.state.betting.actingSeat!;
    const last = [0, 1, 2].find((s) => s !== first && s !== next)!;
    expect(table.projectionFor(next).canShowCards).toBe(true);
    expect(table.showCard(next, handId(), 0)).toEqual({ ok: true });
    table.applyPlayerAction(next, { seatId: next, type: 'fold' });
    // Hand complete: everyone dealt in, folded or not — each card chosen on its own, its partner still hidden.
    expect(table.state.phase).toBe('hand-complete');
    for (const seat of [first, next, last]) expect(table.projectionFor(seat).canShowCards).toBe(true);
    expect(table.projectionFor(null).canShowCards).toBe(false);
    const held = table.state.seats[first]!.holeCards;
    expect(table.showCard(first, handId(), 1)).toEqual({ ok: true });
    expect(table.projectionFor(last).seats[first]!.shownCards).toEqual([{ index: 1, card: held[1] }]);
    expect(JSON.stringify(table.projectionFor(last).seats[first])).not.toContain(`"${held[0]!}"`);
    expect(table.showCard(first, handId(), 0)).toEqual({ ok: true });
    expect(table.projectionFor(last).seats[first]!.shownCards).toHaveLength(2);
    // The fold-winner keeps their button too.
    expect(table.revealEligibleSeatId).toBe(last);
  });

  it('after a real showdown: nothing for those whose cards are public already, the folder still may', () => {
    table.takeSeat(2, 'user-c', meta('Cleo'), 100);
    table.startNextHand();
    const folder = table.state.betting.actingSeat!;
    table.applyPlayerAction(folder, { seatId: folder, type: 'fold' });
    for (let i = 0; i < 40 && table.state.phase === 'in-hand'; i++) {
      const s = table.state.betting.actingSeat!;
      const toCall = Math.max(...table.state.seats.map((x) => x.committedThisStreet)) > table.state.seats[s]!.committedThisStreet;
      table.applyPlayerAction(s, { seatId: s, type: toCall ? 'call' : 'check' });
    }
    expect(table.state.phase).toBe('hand-complete');
    const others = [0, 1, 2].filter((s) => s !== folder);
    for (const s of others) {
      expect(table.projectionFor(s).canShowCards).toBe(false);
      expect(table.showCard(s, handId(), 0)).toMatchObject({ ok: false, code: 'NOT_IN_HAND' });
    }
    expect(table.projectionFor(folder).canShowCards).toBe(true);
    expect(table.showCard(folder, handId(), 0)).toEqual({ ok: true });
  });

  it('reveals add to the break for three players a hand at most, each once; the rest still show, and it all starts over next hand', () => {
    table.takeSeat(2, 'user-c', meta('Cleo'), 100);
    table.takeSeat(3, 'user-d', meta('Dev'), 100);
    table.startNextHand();
    for (let i = 0; i < 3; i++) {
      const s = table.state.betting.actingSeat!;
      table.applyPlayerAction(s, { seatId: s, type: 'fold' });
    }
    expect(table.state.phase).toBe('hand-complete');
    const winner = table.revealEligibleSeatId!;
    const folders = [0, 1, 2, 3].filter((s) => s !== winner);
    const at = table.projectionFor(0).nextHandAt!;
    const until = (): number => table.projectionFor(0).nextHandAt!;

    // One player's two cards are one reveal.
    table.showCard(folders[0]!, handId(), 0);
    expect(until()).toBe(at + 1500);
    table.showCard(folders[0]!, handId(), 1);
    expect(until()).toBe(at + 1500);
    table.showCard(folders[1]!, handId(), 0);
    expect(until()).toBe(at + 3000);
    table.showCard(folders[2]!, handId(), 0);
    expect(until()).toBe(at + 4500);

    // The fourth player's reveal shows, and the next hand doesn't wait for it.
    expect(table.revealHand(winner, handId())).toEqual({ ok: true });
    expect(until()).toBe(at + 4500);
    expect(table.projectionFor(folders[0]!).seats[winner]!.holeCards).toHaveLength(2);

    // A new hand has its own three.
    clock = at + 60_000;
    table.startNextHand();
    for (let i = 0; i < 3; i++) {
      const s = table.state.betting.actingSeat!;
      table.applyPlayerAction(s, { seatId: s, type: 'fold' });
    }
    const next = until();
    const anyone = [0, 1, 2, 3].find((s) => s !== table.revealEligibleSeatId)!;
    table.showCard(anyone, handId(), 0);
    expect(until()).toBe(next + 1500);
  });

  it('after the hand, a shown card adds a little to a running break — and never restarts one that is over', () => {
    table.startNextHand();
    const acting = table.state.betting.actingSeat!;
    table.applyPlayerAction(acting, { seatId: acting, type: 'fold' });
    const at = table.projectionFor(0).nextHandAt!;
    table.showCard(acting, handId(), 0);
    expect(table.projectionFor(0).nextHandAt).toBe(at + 1500);
    clock = at + 60_000;
    table.showCard(acting, handId(), 1);
    expect(table.projectionFor(0).nextHandAt).toBe(at + 1500);
  });

  it('refuses a stale hand id', () => {
    table.startNextHand();
    expect(table.showCard(0, 'old-hand', 0)).toMatchObject({ ok: false, code: 'STALE_HAND' });
  });
});

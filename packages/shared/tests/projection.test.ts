import { applyAction, createTableState, type Card } from '@pokerclause/engine';
import { startHand } from '@pokerclause/engine';
import { freshDeck, seededSource, shuffle } from '@pokerclause/rng';
import { describe, expect, it } from 'vitest';
import { projectEvent, projectStateForSeat, type ProjectionContext, type SeatMeta } from '../src/projection.js';
import type { TableSettings } from '../src/types.js';

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

function seatMeta(seatId: number, ownerNickname: string | null = null): SeatMeta {
  return {
    playerId: `user-${String(seatId)}`,
    displayName: `Player${String(seatId)}`,
    isGuest: false,
    avatarSeed: 'x',
    isConnected: true,
    lastAction: null,
    timeBankMs: 60000,
    isBot: false,
    ownerNickname,
  };
}

function makeContext(revealedSeatIds: ReadonlySet<number> = new Set()): ProjectionContext {
  const seatMetaMap = new Map<number, SeatMeta>();
  for (let i = 0; i < 4; i++) seatMetaMap.set(i, seatMeta(i));
  return {
    tableId: 'table-1',
    tableName: 'Test Table',
    settings: SETTINGS,
    seatMeta: seatMetaMap,
    revealedSeatIds,
    actionDeadline: null,
    nextHandAt: null,
    now: 0,
    rakePot: 0,
    handId: 'hand-1',
    handCommitment: 'commitment-1',
    waitlist: [],
  };
}

describe('projectStateForSeat: the anti-cheat boundary', () => {
  it('never includes another seat\'s hole cards, for any viewer, at any point in a hand', () => {
    const rnd = seededSource('projection-leak-seed');
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 4, straddleEnabled: false };
    const table = createTableState(
      config,
      [0, 1, 2, 3].map((seatId) => ({ seatId, playerId: `P${String(seatId)}`, stack: 200 })),
    );
    const deck = shuffle(freshDeck(), rnd);
    const started = startHand(table, deck);
    if (!started.ok) throw new Error('unreachable');
    let state = started.state;

    const ctx = makeContext();

    function assertNoLeak(): void {
      for (const viewer of [...state.seats.map((s) => s.seatId), null]) {
        const projected = projectStateForSeat(state, ctx, viewer);

        // No raw engine fields ever present.
        expect((projected as unknown as { deck?: unknown }).deck).toBeUndefined();
        expect((projected as unknown as { burned?: unknown }).burned).toBeUndefined();

        for (const seat of projected.seats) {
          const realSeat = state.seats.find((s) => s.seatId === seat.seatId)!;
          if (seat.seatId === viewer) {
            expect(seat.holeCards).toEqual(realSeat.holeCards);
          } else {
            expect(seat.holeCards).toEqual([]);
            // Belt and suspenders: the real card strings never appear anywhere in the payload.
            const serialized = JSON.stringify(projected);
            for (const card of realSeat.holeCards) {
              if (card) expect(serialized.includes(card)).toBe(false);
            }
          }
        }

        // legalActions only ever populated for the viewer's own, genuinely-acting seat.
        if (projected.legalActions !== null) {
          expect(viewer).not.toBeNull();
          expect(state.phase).toBe('in-hand');
          expect(state.betting.actingSeat).toBe(viewer);
        }
      }
    }

    assertNoLeak();

    // Play the hand to completion, checking after every single transition.
    let steps = 0;
    while (state.phase === 'in-hand' && steps < 200) {
      steps += 1;
      const seatId = state.betting.actingSeat;
      if (seatId === null) break;
      const action = { seatId, type: 'call' as const };
      const result = applyAction(state, action);
      if (!result.ok) {
        // fall back to fold if call illegal (e.g. facing a raise already matched)
        const r2 = applyAction(state, { seatId, type: 'check' });
        const r3 = r2.ok ? r2 : applyAction(state, { seatId, type: 'fold' });
        if (!r3.ok) throw new Error('unreachable: no legal fallback');
        state = r3.state;
      } else {
        state = result.state;
      }
      assertNoLeak();
    }
  });

  it('reveals a showdown-participant\'s cards to everyone once truly revealed, never before', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const table = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 100 },
      { seatId: 1, playerId: 'B', stack: 100 },
    ]);
    const deck = freshDeck();
    const started = startHand(table, deck);
    if (!started.ok) throw new Error('unreachable');
    const state = started.state;

    const seat1RealCards = state.seats[1]!.holeCards;

    // Before reveal: viewer 0 must not see seat 1's cards.
    const beforeCtx = makeContext();
    const beforeProjected = projectStateForSeat(state, beforeCtx, 0);
    expect(beforeProjected.seats[1]!.holeCards).toEqual([]);

    // After a genuine showdown reveal for seat 1: now it's legitimately public.
    const afterCtx = makeContext(new Set([1]));
    const afterProjected = projectStateForSeat(state, afterCtx, 0);
    expect(afterProjected.seats[1]!.holeCards).toEqual(seat1RealCards);
    // And a spectator (viewer=null) sees it too, since it's genuinely public now.
    const spectatorProjected = projectStateForSeat(state, afterCtx, null);
    expect(spectatorProjected.seats[1]!.holeCards).toEqual(seat1RealCards);
  });

  it('projectEvent splits cards-dealt: only the owning viewer receives real card values', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const table = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 100 },
      { seatId: 1, playerId: 'B', stack: 100 },
    ]);
    const deck = freshDeck();
    const started = startHand(table, deck);
    if (!started.ok) throw new Error('unreachable');
    const dealtEvent = started.events.find((e) => e.type === 'cards-dealt');
    expect(dealtEvent).toBeDefined();
    if (!dealtEvent || dealtEvent.type !== 'cards-dealt') throw new Error('unreachable');

    for (const viewer of [0, 1, null] as const) {
      const projected = projectEvent(dealtEvent, viewer);
      const cardsDealt = projected.find((e) => e.type === 'cards-dealt');
      expect(cardsDealt).toEqual({ type: 'cards-dealt', seats: dealtEvent.deals.map((d) => d.seatId) });
      const serialized = JSON.stringify(cardsDealt);
      const allCards: Card[] = dealtEvent.deals.flatMap((d) => d.cards);
      for (const card of allCards) expect(serialized.includes(card)).toBe(false);

      const yours = projected.find((e) => e.type === 'your-cards');
      if (viewer === null) {
        expect(yours).toBeUndefined();
      } else {
        const own = dealtEvent.deals.find((d) => d.seatId === viewer)!;
        expect(yours).toEqual({ type: 'your-cards', cards: own.cards });
      }
    }
  });

  it('ownerNickname is redacted to null for every viewer except viewerIsAdmin=true', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 2, straddleEnabled: false };
    const state = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 100 },
      { seatId: 1, playerId: 'B', stack: 100 },
    ]);
    const seatMetaMap = new Map<number, SeatMeta>([
      [0, seatMeta(0, 'Dave from work')],
      [1, seatMeta(1)],
    ]);
    const ctx: ProjectionContext = { ...makeContext(), seatMeta: seatMetaMap };

    for (const viewer of [0, 1, null] as const) {
      const projected = projectStateForSeat(state, ctx, viewer);
      expect(projected.seats[0]!.ownerNickname).toBeNull();
      // Belt and suspenders — the label itself never appears anywhere in the payload.
      expect(JSON.stringify(projected).includes('Dave from work')).toBe(false);
    }

    // Only the owner's own dedicated projection includes it.
    const adminProjected = projectStateForSeat(state, ctx, null, true);
    expect(adminProjected.seats[0]!.ownerNickname).toBe('Dave from work');
    expect(adminProjected.seats[1]!.ownerNickname).toBeNull();
  });
});

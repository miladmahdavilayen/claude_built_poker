import { createTableState, type Card, type PlayerAction, type TableState } from '@pokerclause/engine';
import { freshDeck, seededSource, shuffle } from '@pokerclause/rng';
import { ALL_BOT_POLICIES } from './bots/index.js';
import { CoverageCounters } from './coverage.js';
import { runOneHand } from './handRunner.js';
import type { BotPolicy } from './types.js';

export const GOLDEN_SEED = 'pokerclause-golden-fixture-v1';
export const GOLDEN_HAND_COUNT = 200;

export interface GoldenHand {
  index: number;
  initialState: TableState;
  deck: readonly Card[];
  actionLog: PlayerAction[];
  finalState: TableState;
  eventTypeCounts: Record<string, number>;
}

export function generateGoldenHands(): GoldenHand[] {
  const rnd = seededSource(GOLDEN_SEED);
  const coverage = new CoverageCounters();
  const hands: GoldenHand[] = [];

  for (let i = 0; i < GOLDEN_HAND_COUNT; i++) {
    const numSeats = 2 + rnd.nextInt(8);
    const config = {
      smallBlind: 1,
      bigBlind: 2,
      ante: rnd.nextInt(3) === 0 ? 1 : 0,
      maxSeats: numSeats,
      straddleEnabled: rnd.nextInt(4) === 0,
    };
    const players = Array.from({ length: numSeats }, (_, s) => ({
      seatId: s,
      playerId: `P${s.toString()}`,
      stack: 40 * config.bigBlind + rnd.nextInt(60 * config.bigBlind),
    }));
    const table = createTableState(config, players);
    const bots = new Map<number, BotPolicy>();
    for (let s = 0; s < numSeats; s++) bots.set(s, ALL_BOT_POLICIES[rnd.nextInt(ALL_BOT_POLICIES.length)]!);
    const deck = shuffle(freshDeck(), rnd);

    const result = runOneHand(table, deck, { bots, rnd, coverage, adversarialProbeChance: 5 });

    const eventTypeCounts: Record<string, number> = {};
    for (const e of result.events) eventTypeCounts[e.type] = (eventTypeCounts[e.type] ?? 0) + 1;

    hands.push({
      index: i,
      initialState: result.initialState,
      deck: result.deck,
      actionLog: result.actionLog,
      finalState: result.finalState,
      eventTypeCounts,
    });
  }

  return hands;
}

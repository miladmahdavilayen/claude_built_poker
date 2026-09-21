import { createTableState } from '@pokerclause/engine';
import { freshDeck, seededSource, shuffle } from '@pokerclause/rng';
import { describe, expect, it } from 'vitest';
import { ALL_BOT_POLICIES } from '../src/bots/index.js';
import { CoverageCounters } from '../src/coverage.js';
import { runOneHand } from '../src/handRunner.js';
import type { BotPolicy } from '../src/types.js';

describe('runOneHand smoke test', () => {
  it('plays 2000 random hands with every bot policy mixed in without an invariant failure', () => {
    const rnd = seededSource('hand-runner-smoke-seed');
    const coverage = new CoverageCounters();

    for (let hand = 0; hand < 2000; hand++) {
      const numSeats = 2 + rnd.nextInt(8); // 2..9
      const config = {
        smallBlind: 1,
        bigBlind: 2,
        ante: rnd.nextInt(3) === 0 ? 1 : 0,
        maxSeats: numSeats,
        straddleEnabled: rnd.nextInt(4) === 0,
      };
      const players = Array.from({ length: numSeats }, (_, i) => ({
        seatId: i,
        playerId: `P${String(i)}`,
        stack: 10 + rnd.nextInt(400),
      }));
      const table = createTableState(config, players);
      const bots = new Map<number, BotPolicy>();
      for (let i = 0; i < numSeats; i++) {
        bots.set(i, ALL_BOT_POLICIES[rnd.nextInt(ALL_BOT_POLICIES.length)]!);
      }
      const deck = shuffle(freshDeck(), rnd);

      expect(() => {
        runOneHand(table, deck, { bots, rnd, coverage, adversarialProbeChance: 20 });
      }).not.toThrow();
    }
  });
});

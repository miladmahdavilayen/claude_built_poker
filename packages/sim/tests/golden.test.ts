import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateGoldenHands, type GoldenHand } from '../src/golden.js';
import { replayHand, statesAreIdentical } from '../src/replay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = join(HERE, 'golden', 'hands.json');

describe('golden corpus: 200 hands from a fixed seed', () => {
  const committed = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as GoldenHand[];

  it('has exactly 200 committed hands', () => {
    expect(committed).toHaveLength(200);
  });

  it('regenerating from the fixed seed reproduces the committed fixtures exactly', () => {
    const regenerated = generateGoldenHands();
    expect(regenerated).toHaveLength(committed.length);
    for (let i = 0; i < regenerated.length; i++) {
      expect(regenerated[i]!.finalState, `hand ${String(i)} final state`).toEqual(committed[i]!.finalState);
      expect(regenerated[i]!.actionLog, `hand ${String(i)} action log`).toEqual(committed[i]!.actionLog);
      expect(regenerated[i]!.eventTypeCounts, `hand ${String(i)} event type counts`).toEqual(committed[i]!.eventTypeCounts);
    }
  });

  it('every committed hand replays to byte-identical final state', () => {
    for (const hand of committed) {
      const replayed = replayHand(hand.initialState, hand.deck, hand.actionLog);
      expect(statesAreIdentical(replayed, hand.finalState), `hand ${String(hand.index)} replay mismatch`).toBe(true);
    }
  });
});

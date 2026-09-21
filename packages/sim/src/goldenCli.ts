import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGoldenHands, type GoldenHand } from './golden.js';
import { replayHand, statesAreIdentical } from './replay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = join(HERE, '..', 'tests', 'golden', 'hands.json');

function main(): void {
  const update = process.argv.includes('--update');
  const hands = generateGoldenHands();

  if (update) {
    mkdirSync(dirname(GOLDEN_FILE), { recursive: true });
    writeFileSync(GOLDEN_FILE, JSON.stringify(hands, null, 2), 'utf8');
    process.stdout.write(`Wrote ${String(hands.length)} golden hands to ${GOLDEN_FILE}\n`);
    return;
  }

  const existingRaw = readFileSync(GOLDEN_FILE, 'utf8');
  const existing = JSON.parse(existingRaw) as GoldenHand[];
  let failures = 0;
  for (const hand of hands) {
    const expected = existing[hand.index];
    if (!expected) {
      failures += 1;
      process.stdout.write(`hand ${String(hand.index)}: no fixture recorded\n`);
      continue;
    }
    if (JSON.stringify(hand.finalState) !== JSON.stringify(expected.finalState)) {
      failures += 1;
      process.stdout.write(`hand ${String(hand.index)}: final state mismatch vs committed fixture\n`);
    }
    const replayed = replayHand(hand.initialState, hand.deck, hand.actionLog);
    if (!statesAreIdentical(replayed, hand.finalState)) {
      failures += 1;
      process.stdout.write(`hand ${String(hand.index)}: replay mismatch\n`);
    }
  }
  process.stdout.write(failures === 0 ? `All ${String(hands.length)} golden hands match.\n` : `${String(failures)} mismatches found.\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();

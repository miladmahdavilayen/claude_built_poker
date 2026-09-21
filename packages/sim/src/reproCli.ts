import { readFileSync } from 'node:fs';
import { applyAction, startHand, type EngineResult, type PlayerAction, type TableState } from '@pokerclause/engine';
import { checkActionBound, checkPayoutsEqualContributions, checkPotAwardOrder, checkPotCountBound, checkStateInvariants, InvariantFailure } from './invariants.js';

interface ReproFile {
  masterSeed: string;
  handIndex: number;
  handSeed: string;
  violation: { code: string; message: string };
  initialState: TableState;
  deck: string[];
  actionLog: PlayerAction[];
  shrunk: {
    stateBeforeFailingAction: TableState;
    failingAction: PlayerAction | null;
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const fileFlagIdx = args.indexOf('--file');
  const file = fileFlagIdx !== -1 ? args[fileFlagIdx + 1] : undefined;
  if (!file) {
    process.stderr.write('Usage: pnpm sim:repro --file sim-failures/<name>.json\n');
    process.exitCode = 1;
    return;
  }

  const raw = JSON.parse(readFileSync(file, 'utf8')) as ReproFile;
  process.stdout.write(`Reproducing failure from ${file}\n`);
  process.stdout.write(`Original violation: [${raw.violation.code}] ${raw.violation.message}\n`);
  process.stdout.write(`Master seed: ${raw.masterSeed}, hand index: ${String(raw.handIndex)}\n\n`);

  process.stdout.write('--- Minimal (shrunk) repro: one state + one transition ---\n');
  const { stateBeforeFailingAction, failingAction } = raw.shrunk;
  let result: EngineResult;
  try {
    result = failingAction === null ? startHand(stateBeforeFailingAction, raw.deck as never) : applyAction(stateBeforeFailingAction, failingAction);
  } catch (err) {
    process.stdout.write(`THREW (matches an ENGINE_THREW-class failure): ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  if (!result.ok) {
    process.stdout.write(`applyAction/startHand returned an error: ${result.error.code}: ${result.error.message}\n`);
    process.stdout.write('This does NOT reproduce the original failure (it now returns a typed error instead of the bad state) — looks fixed.\n');
    return;
  }

  process.stdout.write('Transition succeeded; re-running the same invariant checks used by the harness...\n');
  try {
    checkStateInvariants(result.state, computeInitialTotal(stateBeforeFailingAction));
    if (result.state.phase === 'hand-complete') {
      checkPayoutsEqualContributions(result.state);
      checkPotCountBound(result.state);
      checkPotAwardOrder(result.events.filter((e) => e.type === 'pot-awarded').map((e) => e.potIndex));
    }
    checkActionBound(raw.actionLog.length + 1);
    process.stdout.write('All invariants passed on replay — this failure appears to be FIXED.\n');
  } catch (err) {
    if (err instanceof InvariantFailure) {
      process.stdout.write(`STILL FAILS: [${err.violation.code}] ${err.violation.message}\n`);
      process.stdout.write(`actual=${JSON.stringify(err.violation.actual)} expected=${JSON.stringify(err.violation.expected)}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function computeInitialTotal(state: TableState): number {
  const inStacks = state.seats.reduce((sum, s) => sum + s.stack, 0);
  if (state.phase === 'hand-complete' || state.phase === 'waiting') return inStacks;
  const committed = state.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
  return inStacks + committed + state.anteTotal;
}

main();

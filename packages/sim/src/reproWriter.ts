import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandFailure } from './handFailure.js';

export interface ReproFilePayload {
  masterSeed: string;
  handIndex: number;
  handSeed: string;
  violation: { code: string; message: string; actual?: unknown; expected?: unknown };
  initialState: unknown;
  deck: unknown;
  actionLog: unknown;
  /** The minimal, one-action repro: apply `failingAction` to `stateBeforeFailingAction` via applyAction. */
  shrunk: {
    stateBeforeFailingAction: unknown;
    failingAction: unknown;
  };
  reproCommand: string;
}

export function writeReproFile(
  dir: string,
  failure: HandFailure,
  context: { masterSeed: string; handIndex: number; handSeed: string },
): string {
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}-${failure.violation.code}.json`;
  const filepath = join(dir, filename);

  const payload: ReproFilePayload = {
    masterSeed: context.masterSeed,
    handIndex: context.handIndex,
    handSeed: context.handSeed,
    violation: failure.violation,
    initialState: failure.initialState,
    deck: failure.deck,
    actionLog: failure.actionLog,
    shrunk: {
      stateBeforeFailingAction: failure.stateBeforeFailingAction,
      failingAction: failure.failingAction,
    },
    reproCommand: `pnpm sim:repro --file ${filepath}`,
  };

  writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');
  return filepath;
}

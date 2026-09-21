import { createTableState, type TableConfig, type TableState } from '@pokerclause/engine';
import { freshDeck, seededSource, shuffle, type RandomSource } from '@pokerclause/rng';
import { ALL_BOT_POLICIES, adversarial } from './bots/index.js';
import { churnBetweenHands, DEFAULT_CHURN_CONFIG } from './churn.js';
import { COVERAGE_KEYS, CoverageCounters } from './coverage.js';
import { HandFailure } from './handFailure.js';
import { runOneHand, type HandRunResult } from './handRunner.js';
import type { InvariantViolation } from './invariants.js';
import { observeCoverage } from './observeCoverage.js';
import { replayHand, statesAreIdentical } from './replay.js';
import { writeReproFile } from './reproWriter.js';
import { StatsCollector, type StatCheckResult, type StatsSnapshot } from './stats.js';
import type { BotPolicy } from './types.js';

export type BotMix = 'balanced' | 'adversarial' | 'passive' | 'custom';

export interface HarnessOptions {
  hands: number;
  seats: number | 'random';
  seed: string;
  mix: BotMix;
  failFast: boolean;
  verbose: boolean;
  reproDir: string;
  /** For a `custom` mix: an explicit list of bot names to sample from. */
  customPolicies?: readonly string[];
  onProgress?: (handsDone: number) => void;
}

export interface RecordedFailure {
  handIndex: number;
  violation: InvariantViolation;
  reproFile?: string;
}

export interface HarnessSummary {
  handsPlayed: number;
  elapsedMs: number;
  handsPerSecond: number;
  coverage: CoverageCounters;
  statsResults: StatCheckResult[];
  statsSnapshot: StatsSnapshot;
  failures: RecordedFailure[];
  replayMismatches: number;
  zeroCoverageCounters: string[];
}

const PASSIVE_POLICY_NAMES = ['calling-station', 'check-fold', 'nit', 'random-legal'];

function pickSeatCount(seats: HarnessOptions['seats'], rnd: RandomSource): number {
  return seats === 'random' ? 2 + rnd.nextInt(8) : seats;
}

function buildTableConfig(numSeats: number, rnd: RandomSource): TableConfig {
  return {
    smallBlind: 1,
    bigBlind: 2,
    ante: rnd.nextInt(3) === 0 ? 1 : 0, // ~1/3 of tables run an ante
    maxSeats: numSeats,
    straddleEnabled: rnd.nextInt(4) === 0, // ~1/4 of tables straddle
  };
}

function buildFreshTable(numSeats: number, rnd: RandomSource): TableState {
  const config = buildTableConfig(numSeats, rnd);
  const players = Array.from({ length: numSeats }, (_, i) => ({
    seatId: i,
    playerId: `P${i.toString()}`,
    stack: DEFAULT_CHURN_CONFIG.minBuyInBB * config.bigBlind + rnd.nextInt((DEFAULT_CHURN_CONFIG.maxBuyInBB - DEFAULT_CHURN_CONFIG.minBuyInBB) * config.bigBlind),
  }));
  return createTableState(config, players);
}

function policyPoolForTable(mix: BotMix, tableIsAdversarialHeavy: boolean, customPolicies: readonly string[] | undefined): readonly BotPolicy[] {
  if (mix === 'adversarial' || tableIsAdversarialHeavy) return ALL_BOT_POLICIES;
  if (mix === 'passive') return ALL_BOT_POLICIES.filter((p) => PASSIVE_POLICY_NAMES.includes(p.name));
  if (mix === 'custom' && customPolicies && customPolicies.length > 0) {
    return ALL_BOT_POLICIES.filter((p) => customPolicies.includes(p.name));
  }
  return ALL_BOT_POLICIES;
}

function assignBots(numSeats: number, mix: BotMix, tableIsAdversarialHeavy: boolean, customPolicies: readonly string[] | undefined, rnd: RandomSource): Map<number, BotPolicy> {
  const pool = policyPoolForTable(mix, tableIsAdversarialHeavy, customPolicies);
  const bots = new Map<number, BotPolicy>();
  for (let seatId = 0; seatId < numSeats; seatId++) {
    if ((mix === 'adversarial' || tableIsAdversarialHeavy) && rnd.nextInt(100) < 70) {
      bots.set(seatId, adversarial);
    } else {
      bots.set(seatId, pool[rnd.nextInt(pool.length)] ?? adversarial);
    }
  }
  return bots;
}

/** Random table lifetime, in hands, before the harness fully tears down and rebuilds a table (fresh config, fresh players). */
function randomTableLifetime(rnd: RandomSource): number {
  return 200 + rnd.nextInt(1800);
}

export function runSimulation(opts: HarnessOptions): HarnessSummary {
  const rnd = seededSource(opts.seed);
  const coverage = new CoverageCounters();
  const stats = new StatsCollector();
  const failures: RecordedFailure[] = [];
  let replayMismatches = 0;

  let numSeats = pickSeatCount(opts.seats, rnd);
  let table = buildFreshTable(numSeats, rnd);
  let tableIsAdversarialHeavy = rnd.nextInt(100) < 30;
  let handsSinceTableBuilt = 0;
  let tableLifetime = randomTableLifetime(rnd);

  const startTime = Date.now();
  let handsPlayed = 0;

  for (let handIndex = 0; handIndex < opts.hands; handIndex++) {
    if (handsSinceTableBuilt >= tableLifetime) {
      numSeats = pickSeatCount(opts.seats, rnd);
      table = buildFreshTable(numSeats, rnd);
      tableIsAdversarialHeavy = rnd.nextInt(100) < 30;
      handsSinceTableBuilt = 0;
      tableLifetime = randomTableLifetime(rnd);
    }

    const beforeChurn = new Set(table.seats.filter((s) => s.status !== 'empty').map((s) => s.seatId));
    table = churnBetweenHands(table, rnd, DEFAULT_CHURN_CONFIG, coverage);
    const afterChurn = new Set(table.seats.filter((s) => s.status !== 'empty').map((s) => s.seatId));
    const deadButtonSuspected = [...beforeChurn].some((id) => !afterChurn.has(id));

    const bots = assignBots(table.config.maxSeats, opts.mix, tableIsAdversarialHeavy, opts.customPolicies, rnd);
    const deck = shuffle(freshDeck(), rnd);
    const adversarialProbeChance = opts.mix === 'adversarial' || tableIsAdversarialHeavy ? 15 : opts.mix === 'passive' ? 0 : 5;

    let handResult: HandRunResult;
    try {
      handResult = runOneHand(table, deck, { bots, rnd, coverage, adversarialProbeChance });
    } catch (err) {
      if (err instanceof HandFailure) {
        const handSeed = `${opts.seed}:hand:${String(handIndex)}`;
        const reproFile = writeReproFile(opts.reproDir, err, { masterSeed: opts.seed, handIndex, handSeed });
        failures.push({ handIndex, violation: err.violation, reproFile });
        if (opts.failFast) break;
        handsSinceTableBuilt = tableLifetime; // force a fresh table next iteration
        continue;
      }
      throw err;
    }

    const replayed = replayHand(handResult.initialState, handResult.deck, handResult.actionLog);
    if (!statesAreIdentical(replayed, handResult.finalState)) {
      replayMismatches += 1;
      failures.push({ handIndex, violation: { code: 'REPLAY_MISMATCH', message: 'replayed final state does not match the live final state' } });
      if (opts.failFast) break;
    }

    observeCoverage(handResult, coverage, deadButtonSuspected);
    stats.observeHandComplete(handResult.finalState, handResult.events, handResult.initialState.lastBigBlindSeat === null);

    table = handResult.finalState;
    handsSinceTableBuilt += 1;
    handsPlayed += 1;
    opts.onProgress?.(handsPlayed);
  }

  const elapsedMs = Date.now() - startTime;
  return {
    handsPlayed,
    elapsedMs,
    handsPerSecond: elapsedMs > 0 ? (handsPlayed / elapsedMs) * 1000 : handsPlayed,
    coverage,
    statsResults: stats.report(),
    statsSnapshot: stats.toSnapshot(),
    failures,
    replayMismatches,
    zeroCoverageCounters: coverage.zeroKeys(),
  };
}

export { COVERAGE_KEYS };

import type { BotMix } from './harness.js';

export interface CliArgs {
  hands: number;
  seats: number | 'random';
  seed: string;
  mix: BotMix;
  workers: number;
  verbose: boolean;
  failFast: boolean;
  out?: string;
  reproDir: string;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx === argv.length - 1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const handsRaw = readFlag(argv, 'hands') ?? '10000';
  const seatsRaw = readFlag(argv, 'seats') ?? 'random';
  const seed = readFlag(argv, 'seed') ?? `seed-${Date.now().toString()}`;
  const mixRaw = (readFlag(argv, 'mix') ?? 'balanced') as BotMix;
  const workersRaw = readFlag(argv, 'workers') ?? '1';
  const failFastRaw = readFlag(argv, 'fail-fast');

  const out = readFlag(argv, 'out');

  return {
    hands: Number.parseInt(handsRaw, 10),
    seats: seatsRaw === 'random' ? 'random' : Number.parseInt(seatsRaw, 10),
    seed,
    mix: mixRaw,
    workers: Number.parseInt(workersRaw, 10),
    verbose: hasFlag(argv, 'verbose'),
    failFast: failFastRaw === undefined ? true : failFastRaw !== 'false',
    reproDir: readFlag(argv, 'repro-dir') ?? 'sim-failures',
    ...(out !== undefined ? { out } : {}),
  };
}

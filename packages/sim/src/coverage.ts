export type CoverageKey =
  | 'headsUpHand'
  | 'potsExactly2'
  | 'potsExactly3'
  | 'pots4OrMore'
  | 'shortAllInDidNotReopen'
  | 'cumulativeShortAllInReopened'
  | 'sidePotDifferentWinnerThanMain'
  | 'splitPotOddChip'
  | 'threeWaySplit'
  | 'foldedContributorChipsStayed'
  | 'uncalledBetReturned'
  | 'deadButtonHand'
  | 'missedBlindPosted'
  | 'waitedForBB'
  | 'allInLessThanSmallBlind'
  | 'allInPreflopRanOutAllStreets'
  | 'everyoneFoldsToBB'
  | 'bbOptionRaiseOnLimpedPot'
  | 'anteHand'
  | 'straddledHand'
  | 'rejectedIllegalRaiseAtMinMinusOne';

export const COVERAGE_KEYS: readonly CoverageKey[] = [
  'headsUpHand',
  'potsExactly2',
  'potsExactly3',
  'pots4OrMore',
  'shortAllInDidNotReopen',
  'cumulativeShortAllInReopened',
  'sidePotDifferentWinnerThanMain',
  'splitPotOddChip',
  'threeWaySplit',
  'foldedContributorChipsStayed',
  'uncalledBetReturned',
  'deadButtonHand',
  'missedBlindPosted',
  'waitedForBB',
  'allInLessThanSmallBlind',
  'allInPreflopRanOutAllStreets',
  'everyoneFoldsToBB',
  'bbOptionRaiseOnLimpedPot',
  'anteHand',
  'straddledHand',
  'rejectedIllegalRaiseAtMinMinusOne',
];

export class CoverageCounters {
  private readonly counts = new Map<CoverageKey, number>(COVERAGE_KEYS.map((k) => [k, 0]));

  bump(key: CoverageKey, by = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  get(key: CoverageKey): number {
    return this.counts.get(key) ?? 0;
  }

  merge(other: CoverageCounters): void {
    for (const key of COVERAGE_KEYS) this.bump(key, other.get(key));
  }

  zeroKeys(): CoverageKey[] {
    return COVERAGE_KEYS.filter((k) => this.get(k) === 0);
  }

  toJSON(): Record<CoverageKey, number> {
    const out = {} as Record<CoverageKey, number>;
    for (const key of COVERAGE_KEYS) out[key] = this.get(key);
    return out;
  }

  toTable(): string {
    const rows = COVERAGE_KEYS.map((k) => `  ${k.padEnd(38)} ${String(this.get(k)).padStart(10)}`);
    return rows.join('\n');
  }
}

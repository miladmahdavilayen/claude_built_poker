// The money-only entry point: the package's main one pulls in Node-only engine code that can't run in a browser.
import { formatMoney } from '@pokerclause/shared/money';

export interface ChipDenomination {
  /** In cents, like every amount — see packages/shared/src/money.ts. */
  value: number;
  base: string;
  edge: string;
}

/**
 * Every displayed chip amount goes through this. Amounts are integer cents
 * everywhere; this is the one place they become dollars ("$2", "$0.10",
 * "$12.50"). See packages/shared/src/money.ts and DECISIONS.md.
 */
export const formatChips = formatMoney;

// Standard casino chip color coding (the common US convention), ordered
// highest value first so a greedy breakdown naturally reaches for the
// biggest chips first — same as a real dealer would. Values are cents; the
// three sub-dollar chips exist for low-stakes tables ($0.10/$0.20 and up).
export const CHIP_DENOMINATIONS: readonly ChipDenomination[] = [
  { value: 10_000_000, base: '#c026a3', edge: '#f5f5f0' }, // pink $100,000
  { value: 2_500_000, base: '#7c4a1e', edge: '#f5f5f0' }, // brown $25,000
  { value: 500_000, base: '#0e7490', edge: '#f5f5f0' }, // light blue $5,000
  { value: 100_000, base: '#f59e0b', edge: '#1a1a1a' }, // yellow/orange $1,000
  { value: 50_000, base: '#7e22ce', edge: '#f5f5f0' }, // purple $500
  { value: 10_000, base: '#18181b', edge: '#f5f5f0' }, // black $100
  { value: 2_500, base: '#15803d', edge: '#f5f5f0' }, // green $25
  { value: 1_000, base: '#2563eb', edge: '#f5f5f0' }, // blue $10
  { value: 500, base: '#dc2626', edge: '#f5f5f0' }, // red $5
  { value: 100, base: '#f5f5f0', edge: '#18181b' }, // white $1
  { value: 25, base: '#94a3b8', edge: '#f5f5f0' }, // silver 25¢
  { value: 5, base: '#14b8a6', edge: '#f5f5f0' }, // teal 5¢
  { value: 1, base: '#fda4af', edge: '#18181b' }, // light pink 1¢
];

/**
 * Picks up to `maxChips` denominations that best represent `amount`,
 * largest first, so a chip stack's colors roughly communicate its size at
 * a glance. This is a decorative representation, not a literal chip
 * count — a real stack of e.g. 137 chips would never render as 137 discs.
 */
export function chipBreakdown(amount: number, maxChips = 3): ChipDenomination[] {
  if (amount <= 0) return [];
  const chips: ChipDenomination[] = [];
  let remaining = amount;
  for (const denom of CHIP_DENOMINATIONS) {
    if (chips.length >= maxChips) break;
    if (remaining >= denom.value) {
      chips.push(denom);
      remaining -= denom.value;
    }
  }
  if (chips.length === 0) chips.push(CHIP_DENOMINATIONS[CHIP_DENOMINATIONS.length - 1]!);
  return chips;
}

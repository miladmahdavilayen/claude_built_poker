export interface ChipDenomination {
  value: number;
  base: string;
  edge: string;
}

/**
 * Every displayed chip amount goes through this — a cosmetic "$" prefix
 * over the same underlying numbers the engine/server already use (no
 * exchange rate, no change to any real value anywhere). See DECISIONS.md.
 */
export function formatChips(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

// Standard casino chip color coding (the common US convention), ordered
// highest value first so a greedy breakdown naturally reaches for the
// biggest chips first — same as a real dealer would.
export const CHIP_DENOMINATIONS: readonly ChipDenomination[] = [
  { value: 100000, base: '#c026a3', edge: '#f5f5f0' }, // pink
  { value: 25000, base: '#7c4a1e', edge: '#f5f5f0' }, // brown
  { value: 5000, base: '#0e7490', edge: '#f5f5f0' }, // light blue
  { value: 1000, base: '#f59e0b', edge: '#1a1a1a' }, // yellow/orange
  { value: 500, base: '#7e22ce', edge: '#f5f5f0' }, // purple
  { value: 100, base: '#18181b', edge: '#f5f5f0' }, // black
  { value: 25, base: '#15803d', edge: '#f5f5f0' }, // green
  { value: 10, base: '#2563eb', edge: '#f5f5f0' }, // blue
  { value: 5, base: '#dc2626', edge: '#f5f5f0' }, // red
  { value: 1, base: '#f5f5f0', edge: '#18181b' }, // white
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

import type { Card } from '@pokerclause/engine';
import { formatChips } from './chips.js';

// What a showdown's pot awards say, in words — for the split-pot
// announcement (components/SplitPotAnnouncement.tsx), the hand log and the
// chat. Everything comes straight from the server's 'pot-awarded' events:
// who won each pot and exactly how much (odd chips included). Nothing here
// works out a winner or recomputes a share, it only describes them.

export interface PotWinner {
  seatId: number;
  amount: number;
  handName?: string;
  bestFive?: readonly Card[];
}

export interface PotAward {
  potIndex: number;
  winners: readonly PotWinner[];
}

export interface PotAnnouncement {
  potIndex: number;
  /** "Main Pot" / "Side Pot 1" when the hand had more than one pot; null otherwise. */
  label: string | null;
  /** Two or more winners shared this pot. */
  split: boolean;
  title: string;
  subline: string;
  /** The shared winning hand, once ("Both have an Ace-high straight", "Board plays"), when there's one to name. */
  handLine: string | null;
  winners: { seatId: number; name: string; amount: number }[];
}

const RANK_NAME: Record<string, string> = {
  A: 'Ace',
  K: 'King',
  Q: 'Queen',
  J: 'Jack',
  T: 'Ten',
  '9': 'Nine',
  '8': 'Eight',
  '7': 'Seven',
  '6': 'Six',
  '5': 'Five',
  '4': 'Four',
  '3': 'Three',
  '2': 'Two',
};
const RANK_VALUE: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };

function plural(rank: string): string {
  const name = RANK_NAME[rank] ?? rank;
  return name === 'Six' ? 'Sixes' : `${name}s`;
}

/** Ranks by how many of each there are, then by rank: "full house, kings over fives" → K K K 5 5 → [K, 5]. */
function groups(bestFive: readonly Card[]): string[] {
  const counts = new Map<string, number>();
  for (const c of bestFive) counts.set(c.slice(0, -1), (counts.get(c.slice(0, -1)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (RANK_VALUE[b[0]] ?? 0) - (RANK_VALUE[a[0]] ?? 0)).map(([r]) => r);
}

/** The top card of a straight (a wheel, A-2-3-4-5, is five-high). */
function straightHigh(bestFive: readonly Card[]): string {
  const ranks = bestFive.map((c) => c.slice(0, -1));
  if (ranks.includes('A') && ranks.includes('5') && !ranks.includes('K')) return '5';
  return [...ranks].sort((a, b) => (RANK_VALUE[b] ?? 0) - (RANK_VALUE[a] ?? 0))[0] ?? '';
}

/** A hand in plain words — "an Ace-high straight", "Kings full of Fives" — from the engine's hand name and best five cards. */
export function describeHand(handName: string, bestFive: readonly Card[] | undefined): string {
  const name = handName.toLowerCase();
  if (!bestFive || bestFive.length < 5) return name;
  const g = groups(bestFive);
  const high = (r: string | undefined): string => RANK_NAME[r ?? ''] ?? r ?? '';
  const article = (word: string): string => (/^[AEIOU]/.test(word) ? 'an' : 'a');
  switch (name) {
    case 'straight flush': {
      const top = straightHigh(bestFive);
      return top === 'A' ? 'a Royal Flush' : `${article(high(top))} ${high(top)}-high straight flush`;
    }
    case 'four of a kind':
      return `four ${plural(g[0]!)}`;
    case 'full house':
      return `${plural(g[0]!)} full of ${plural(g[1]!)}`;
    case 'flush':
      return `${article(high(g[0]))} ${high(g[0])}-high flush`;
    case 'straight': {
      const top = high(straightHigh(bestFive));
      return `${article(top)} ${top}-high straight`;
    }
    case 'three of a kind':
      return `three ${plural(g[0]!)}`;
    case 'two pairs':
      return `two pair, ${plural(g[0]!)} and ${plural(g[1]!)}`;
    case 'one pair':
      return `a pair of ${plural(g[0]!)}`;
    case 'high card':
      return `${high(g[0])} high`;
    default:
      return name;
  }
}

/** "Alice", "Alice & Bob", "Alice, Bob & Cara". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names.at(-1)!}`;
}

export function potLabel(potIndex: number, potCount: number): string | null {
  if (potCount <= 1) return null;
  return potIndex === 0 ? 'Main Pot' : `Side Pot ${String(potIndex)}`;
}

function boardPlays(winners: readonly PotWinner[], board: readonly Card[]): boolean {
  if (board.length !== 5) return false;
  const b = new Set(board);
  return winners.every((w) => w.bestFive?.length === 5 && w.bestFive.every((c) => b.has(c)));
}

/** The shared hand line for a split, or null when the winners don't share one to name. */
function sharedHand(winners: readonly PotWinner[], board: readonly Card[]): string | null {
  if (boardPlays(winners, board)) return 'Board plays';
  const first = winners[0];
  if (!first?.handName) return null;
  if (!winners.every((w) => w.handName === first.handName)) return null;
  const hand = describeHand(first.handName, first.bestFive);
  return `${winners.length === 2 ? 'Both have' : `All ${String(winners.length)} have`} ${hand}`;
}

/**
 * One announcement per pot, in the order the server awarded them — or null
 * when no pot this hand was split, so a hand with a single winner per pot
 * keeps the usual win celebration exactly as it was.
 */
export function buildPotAnnouncements(awards: readonly PotAward[], nameOf: (seatId: number) => string, board: readonly Card[]): PotAnnouncement[] | null {
  if (!awards.some((a) => a.winners.length > 1)) return null;
  const potCount = awards.length;
  return awards.map((a) => {
    const winners = a.winners.map((w) => ({ seatId: w.seatId, name: nameOf(w.seatId), amount: w.amount }));
    const label = potLabel(a.potIndex, potCount);
    if (winners.length < 2) {
      const w = a.winners[0];
      return {
        potIndex: a.potIndex,
        label,
        split: false,
        title: `${winners[0]?.name ?? 'Player'} wins`,
        subline: formatChips(winners[0]?.amount ?? 0),
        handLine: w?.handName ? `with ${describeHand(w.handName, w.bestFive)}` : null,
        winners,
      };
    }
    const equal = winners.every((w) => w.amount === winners[0]!.amount);
    const names = winners.map((w) => w.name);
    let subline: string;
    if (winners.length === 2) {
      subline = equal ? `${joinNames(names)} chop ${formatChips(winners[0]!.amount)} each` : winners.map((w) => `${w.name} ${formatChips(w.amount)}`).join(', ');
    } else {
      subline = equal ? `${joinNames(names)} — ${formatChips(winners[0]!.amount)} each` : winners.map((w) => `${w.name} ${formatChips(w.amount)}`).join(' · ');
    }
    return {
      potIndex: a.potIndex,
      label,
      split: true,
      title: winners.length === 2 ? 'SPLIT POT' : `SPLIT POT: ${String(winners.length)} WAYS`,
      subline,
      handLine: sharedHand(a.winners, board),
      winners,
    };
  });
}

/**
 * A split pot in one plain sentence, for the hand log and chat — "Alice and
 * Bob split the pot, $5 each" — or null for a pot with one winner (the log
 * keeps its usual "wins" line for those).
 */
export function splitLogLine(award: PotAward, nameOf: (seatId: number) => string, potCount: number): string | null {
  if (award.winners.length < 2) return null;
  const names = award.winners.map((w) => nameOf(w.seatId));
  const who = names.length === 2 ? `${names[0]!} and ${names[1]!}` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
  const label = potLabel(award.potIndex, potCount);
  const what = label ? `the ${label.toLowerCase()}` : 'the pot';
  const equal = award.winners.every((w) => w.amount === award.winners[0]!.amount);
  const amounts = equal ? `${formatChips(award.winners[0]!.amount)} each` : award.winners.map((w) => `${nameOf(w.seatId)} ${formatChips(w.amount)}`).join(', ');
  const first = award.winners[0]!;
  const hand = first.handName && award.winners.every((w) => w.handName === first.handName) ? ` (${describeHand(first.handName, first.bestFive)})` : '';
  return `${who} split ${what}, ${amounts}${hand}`;
}

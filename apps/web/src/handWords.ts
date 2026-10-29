// A hand in words, the way a dealer reads it out: "two pair, kings and
// sevens", "a full house, aces full of nines", "a flush, queen high" — and,
// when that alone doesn't separate the winner from someone who showed the
// same hand, the card that did: "…, ace kicker". Only for saying it out
// loud (dealerVoice.ts): who wins is always the server's decision.

const RANKS = '23456789TJQKA';
const NAME = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];
const PLURAL = ['twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'];

/** 0 high card … 8 straight flush. */
type Category = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface RankedHand {
  category: Category;
  /** Rank indexes (0 = two … 12 = ace), most significant first — the whole tiebreak. */
  key: number[];
}

/** How many leading entries of `key` the hand's own name already says ("two pair, kings and sevens": 2). */
const NAMED: Record<Category, number> = { 0: 1, 1: 1, 2: 2, 3: 1, 4: 1, 5: 1, 6: 2, 7: 1, 8: 1 };

/** The top card of a straight in these ranks (an ace also plays low), or -1. */
function straightTop(ranks: Set<number>): number {
  for (let top = 12; top >= 3; top--) {
    let ok = true;
    for (let k = 0; k < 5 && ok; k++) {
      const r = top - k;
      ok = r === -1 ? ranks.has(12) : ranks.has(r);
    }
    if (ok) return top;
  }
  // The wheel: A-2-3-4-5, five high.
  return ranks.has(12) && [0, 1, 2, 3].every((r) => ranks.has(r)) ? 3 : -1;
}

/** The best five-card poker hand out of these cards ("As", "Td"…). */
export function rankHand(cards: readonly string[]): RankedHand | null {
  if (cards.length < 5) return null;
  const parsed = cards.map((c) => ({ r: RANKS.indexOf(c[0]!), s: c[1]! })).filter((c) => c.r >= 0);
  const counts = new Map<number, number>();
  for (const c of parsed) counts.set(c.r, (counts.get(c.r) ?? 0) + 1);
  const desc = [...counts.keys()].sort((a, b) => b - a);
  const bySuit = new Map<string, number[]>();
  for (const c of parsed) bySuit.set(c.s, [...(bySuit.get(c.s) ?? []), c.r]);
  const flush = [...bySuit.values()].find((rs) => rs.length >= 5)?.sort((a, b) => b - a) ?? null;

  if (flush) {
    const sf = straightTop(new Set(flush));
    if (sf >= 0) return { category: 8, key: [sf] };
  }
  const withCount = (n: number): number[] => desc.filter((r) => (counts.get(r) ?? 0) >= n);
  const others = (...used: number[]): number[] => desc.filter((r) => !used.includes(r));
  const quads = desc.filter((r) => counts.get(r) === 4);
  if (quads.length) return { category: 7, key: [quads[0]!, ...others(quads[0]!).slice(0, 1)] };
  const trips = desc.filter((r) => counts.get(r) === 3);
  if (trips.length) {
    const pair = withCount(2).find((r) => r !== trips[0]);
    if (pair !== undefined) return { category: 6, key: [trips[0]!, pair] };
  }
  if (flush) return { category: 5, key: flush.slice(0, 5) };
  const st = straightTop(new Set(desc));
  if (st >= 0) return { category: 4, key: [st] };
  if (trips.length) return { category: 3, key: [trips[0]!, ...others(trips[0]!).slice(0, 2)] };
  const pairs = desc.filter((r) => counts.get(r) === 2);
  if (pairs.length >= 2) return { category: 2, key: [pairs[0]!, pairs[1]!, ...others(pairs[0]!, pairs[1]!).slice(0, 1)] };
  if (pairs.length === 1) return { category: 1, key: [pairs[0]!, ...others(pairs[0]!).slice(0, 3)] };
  return { category: 0, key: desc.slice(0, 5) };
}

/** The hand's name: "two pair, kings and sevens". */
export function handName(h: RankedHand): string {
  const [a = 0, b = 0] = h.key;
  switch (h.category) {
    case 8:
      return a === 12 ? 'a royal flush' : `a straight flush, ${NAME[a]!} high`;
    case 7:
      return `four ${PLURAL[a]!}`;
    case 6:
      return `a full house, ${PLURAL[a]!} full of ${PLURAL[b]!}`;
    case 5:
      return `a flush, ${NAME[a]!} high`;
    case 4:
      return `a straight, ${NAME[a]!} high`;
    case 3:
      return `three ${PLURAL[a]!}`;
    case 2:
      return `two pair, ${PLURAL[a]!} and ${PLURAL[b]!}`;
    case 1:
      return `a pair of ${PLURAL[a]!}`;
    default:
      return `${NAME[a]!} high`;
  }
}

/**
 * The winner's hand as a dealer says it, made plain against the hands it
 * beat: its name, and — only when a beaten hand had the same name — the
 * card that decided it ("…, ace kicker"; for a flush or high card, the
 * cards down to it: "a flush, ace, king high").
 */
export function winningWords(winner: RankedHand, beaten: readonly RankedHand[]): string {
  let decider = -1;
  for (const other of beaten) {
    if (other.category !== winner.category) continue;
    const at = winner.key.findIndex((r, i) => r !== other.key[i]);
    if (at > decider) decider = at;
  }
  const named = NAMED[winner.category];
  if (decider < named) return handName(winner);
  if (winner.category === 5 || winner.category === 0) {
    const cards = winner.key.slice(0, decider + 1).map((r) => NAME[r]!);
    return winner.category === 5 ? `a flush, ${cards.join(', ')} high` : `${cards.join(', ')} high`;
  }
  return `${handName(winner)}, ${NAME[winner.key[decider]!]!} kicker`;
}

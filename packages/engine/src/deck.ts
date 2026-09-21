import type { Card, Rank, Suit } from './types.js';

export const RANKS: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];

export function fullDeck(): Card[] {
  const cards: Card[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      cards.push(`${r}${s}`);
    }
  }
  return cards;
}

export function rankOf(card: Card): Rank {
  return card.slice(0, 1) as Rank;
}

export function suitOf(card: Card): Suit {
  return card.slice(1) as Suit;
}

export function rankIndex(card: Card): number {
  return RANKS.indexOf(rankOf(card));
}

export function isValidDeck(deck: readonly Card[]): boolean {
  if (deck.length !== 52) return false;
  const seen = new Set<Card>();
  for (const c of deck) {
    if (seen.has(c)) return false;
    seen.add(c);
  }
  return true;
}

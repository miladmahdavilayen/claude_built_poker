import { describe, expect, it } from 'vitest';
import { fullDeck, isValidDeck, rankIndex, rankOf, suitOf } from '../src/deck.js';

describe('deck utilities', () => {
  it('fullDeck produces exactly 52 unique cards', () => {
    const deck = fullDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });

  it('rankOf / suitOf split a card string correctly', () => {
    expect(rankOf('As')).toBe('A');
    expect(suitOf('As')).toBe('s');
    expect(rankOf('Td')).toBe('T');
    expect(suitOf('Td')).toBe('d');
  });

  it('rankIndex orders ranks from 2 (lowest) to A (highest)', () => {
    expect(rankIndex('2c')).toBe(0);
    expect(rankIndex('As')).toBe(12);
    expect(rankIndex('Kd')).toBeGreaterThan(rankIndex('Qd'));
  });

  it('isValidDeck accepts a full unique 52-card deck and rejects anything else', () => {
    expect(isValidDeck(fullDeck())).toBe(true);
    expect(isValidDeck(fullDeck().slice(0, 51))).toBe(false);
    const withDuplicate = [...fullDeck().slice(0, 51), 'As'] as const;
    expect(isValidDeck(withDuplicate)).toBe(false);
  });
});

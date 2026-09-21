import PokerEvaluator from 'poker-evaluator';
import type { Card } from './types.js';

export interface EvaluatedHand {
  /** Lower value = stronger hand. */
  value: number;
  name: string;
  bestFive: Card[];
}

export interface HandEvaluator {
  /** Accepts 5-7 cards. */
  evaluate(cards: readonly Card[]): EvaluatedHand;
}

function combinations5(cards: readonly Card[]): Card[][] {
  const result: Card[][] = [];
  const n = cards.length;
  const pick = (start: number, chosen: Card[]): void => {
    if (chosen.length === 5) {
      result.push([...chosen]);
      return;
    }
    for (let i = start; i < n; i++) {
      const card = cards[i];
      if (card === undefined) continue;
      chosen.push(card);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return result;
}

/**
 * Wraps `poker-evaluator` (a perfect-hash 5-card evaluator) behind the
 * project's HandEvaluator interface, adding best-5-of-7 selection via
 * exhaustive combination search (at most C(7,5)=21 evaluations).
 *
 * `poker-evaluator`'s own `value` is HIGHER-is-better; this wrapper
 * negates it so the project-wide convention (LOWER value = stronger,
 * matching classic hand-rank tables) holds everywhere in the engine.
 * See DECISIONS.md.
 */
export class PokerToolsEvaluator implements HandEvaluator {
  evaluate(cards: readonly Card[]): EvaluatedHand {
    if (cards.length < 5 || cards.length > 7) {
      throw new Error(`HandEvaluator.evaluate expects 5-7 cards, got ${cards.length}`);
    }
    const candidates = cards.length === 5 ? [Array.from(cards)] : combinations5(cards);
    let best: { raw: ReturnType<typeof PokerEvaluator.evalHand>; five: Card[] } | null = null;
    for (const five of candidates) {
      const raw = PokerEvaluator.evalHand(five);
      if (best === null || raw.value > best.raw.value) {
        best = { raw, five };
      }
    }
    if (best === null) {
      throw new Error('unreachable: no 5-card combination produced');
    }
    return {
      value: -best.raw.value,
      name: best.raw.handName,
      bestFive: best.five,
    };
  }
}

export function createDefaultEvaluator(): HandEvaluator {
  return new PokerToolsEvaluator();
}

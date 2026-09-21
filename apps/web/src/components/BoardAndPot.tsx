import type { Card, Pot } from '@pokerclause/engine';
import { ChipStack } from './ChipStack.js';
import { PlayingCard } from './PlayingCard.js';

export function BoardAndPot({
  board,
  pots,
  liveTotal,
}: {
  board: readonly Card[];
  pots: readonly Pot[];
  /** See potTotal.ts — the true running total, correct both mid-hand and after. `pots` itself is only used below for its side-pot breakdown. */
  liveTotal: number;
}): React.JSX.Element {
  const total = liveTotal;
  return (
    <div className="board-area">
      <div className="board-cards">
        {board.map((c, i) => (
          <PlayingCard key={`${c}-${String(i)}`} card={c} />
        ))}
        {Array.from({ length: 5 - board.length }).map((_, i) => (
          <div key={`ph-${String(i)}`} className="card card-placeholder" />
        ))}
      </div>
      {total > 0 && (
        <div className="pot-display">
          <ChipStack amount={total} size="md" showAmount={false} />
          <span>Pot: {total.toLocaleString()}</span>
          {pots.length > 1 && (
            <span className="side-pots"> ({pots.map((p) => `${String(p.amount)}`).join(' + ')})</span>
          )}
        </div>
      )}
    </div>
  );
}

import type { Card, Pot } from '@pokerclause/engine';
import { formatChips } from '../chips.js';
import { ChipStack } from './ChipStack.js';
import { PlayingCard } from './PlayingCard.js';

export function BoardAndPot({
  board,
  pots,
  liveTotal,
  top,
}: {
  board: readonly Card[];
  pots: readonly Pot[];
  /** See potTotal.ts — the true running total, correct both mid-hand and after. `pots` itself is only used below for its side-pot breakdown. */
  liveTotal: number;
  /** The board's center as a % of the felt's height — chosen by the table layout (useTableLayout.ts); the stylesheet's default otherwise. */
  top?: number | undefined;
}): React.JSX.Element {
  const total = liveTotal;
  return (
    <div className="board-area" style={top !== undefined ? { top: `${String(top)}%` } : undefined}>
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
          <span>Pot: {formatChips(total)}</span>
          {pots.length > 1 && <span className="side-pots"> ({pots.map((p) => formatChips(p.amount)).join(' + ')})</span>}
        </div>
      )}
    </div>
  );
}

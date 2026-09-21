import type { Card } from '@pokerclause/engine';

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);

export function PlayingCard({ card, faceDown = false }: { card: Card | null; faceDown?: boolean }): React.JSX.Element {
  if (faceDown || card === null) {
    return <div className="card card-back" aria-hidden="true" />;
  }
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const isRed = RED_SUITS.has(suit);
  return (
    <div className={`card ${isRed ? 'card-red' : 'card-black'}`}>
      <span className="card-rank">{rank}</span>
      <span className="card-suit">{SUIT_SYMBOL[suit] ?? suit}</span>
    </div>
  );
}

import type { Card } from '@pokerclause/engine';

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);

/**
 * `justRevealed` plays a one-shot 3D flip from a card-back to the real
 * face (see useJustRevealedSeats.ts) — both faces are stacked and rotated
 * together via CSS (see .card-flip-* in styles.css) rather than the plain
 * instant swap below, which is what every OTHER card on the table still
 * uses (a normal deal, a genuine showdown, a street card landing).
 */
export function PlayingCard({
  card,
  faceDown = false,
  justRevealed = false,
}: {
  card: Card | null;
  faceDown?: boolean;
  justRevealed?: boolean;
}): React.JSX.Element {
  if (faceDown || card === null) {
    return <div className="card card-back" aria-hidden="true" />;
  }
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const isRed = RED_SUITS.has(suit);
  const front = (
    <div className={`card ${isRed ? 'card-red' : 'card-black'}`}>
      <span className="card-rank">{rank}</span>
      <span className="card-suit">{SUIT_SYMBOL[suit] ?? suit}</span>
    </div>
  );
  if (!justRevealed) return front;
  return (
    <div className="card-flip-wrap">
      <div className="card-flip-inner">
        <div className="card card-back card-flip-face card-flip-back" aria-hidden="true" />
        <div className={`card ${isRed ? 'card-red' : 'card-black'} card-flip-face card-flip-front`}>
          <span className="card-rank">{rank}</span>
          <span className="card-suit">{SUIT_SYMBOL[suit] ?? suit}</span>
        </div>
      </div>
    </div>
  );
}

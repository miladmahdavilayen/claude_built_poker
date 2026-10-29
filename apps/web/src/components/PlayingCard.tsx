import type { Card } from '@pokerclause/engine';

const SUIT_NAME: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const RANK_NAME: Record<string, string> = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };

/**
 * The classic face — the very artwork on the 3D table's cards (public/cards:
 * Adrian Kennard's CC0 deck, portrait jacks, queens and kings) — filling the
 * card. The same files the table loads, cached by the browser for weeks.
 */
function Face({ card }: { card: Card }): React.JSX.Element {
  const name = `${RANK_NAME[card.slice(0, -1)] ?? card.slice(0, -1)} of ${SUIT_NAME[card.slice(-1)] ?? card.slice(-1)}`;
  return <img className="card-art" src={`/cards/${card}.webp`} alt={name} draggable={false} decoding="async" />;
}

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
  winning = false,
}: {
  card: Card | null;
  faceDown?: boolean;
  justRevealed?: boolean;
  /** Part of a split pot's winning hand — raised while the split is announced (see SplitPotAnnouncement.tsx). */
  winning?: boolean;
}): React.JSX.Element {
  if (faceDown || card === null) {
    return <div className="card card-back" aria-hidden="true" />;
  }
  const front = (
    <div className={`card card-face${winning ? ' card-winning' : ''}`}>
      <Face card={card} />
    </div>
  );
  if (!justRevealed) return front;
  return (
    <div className="card-flip-wrap">
      <div className="card-flip-inner">
        <div className="card card-back card-flip-face card-flip-back" aria-hidden="true" />
        <div className="card card-face card-flip-face card-flip-front">
          <Face card={card} />
        </div>
      </div>
    </div>
  );
}

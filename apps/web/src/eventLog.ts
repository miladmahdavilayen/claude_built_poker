import type { Card } from '@pokerclause/engine';
import type { ProjectedGameEvent } from '@pokerclause/shared';

function cardsToStr(cards: readonly Card[]): string {
  return cards.join(' ');
}

/** Turns a raw engine event into one human-readable log line, or null for events not worth showing. */
export function describeEvent(event: ProjectedGameEvent, seatName: (seatId: number) => string): string | null {
  switch (event.type) {
    case 'hand-started':
      return `— Hand #${String(event.handNumber)} —`;
    case 'blinds-posted':
      return event.posts.map((p) => `${seatName(p.seatId)} posts ${p.kind} ${String(p.amount)}${p.allIn ? ' (all-in)' : ''}`).join(', ');
    case 'ante-posted':
      return event.posts.length > 0 ? `Ante posted (${String(event.posts.reduce((s, p) => s + p.amount, 0))} total)` : null;
    case 'street-dealt':
      return `${event.street[0]?.toUpperCase()}${event.street.slice(1)}: ${cardsToStr(event.board)}`;
    case 'action-taken': {
      const name = seatName(event.seatId);
      switch (event.action.type) {
        case 'fold':
          return `${name} folds`;
        case 'check':
          return `${name} checks`;
        case 'call':
          return `${name} calls`;
        case 'bet':
          return `${name} bets ${String(event.action.amountTo ?? '')}`;
        case 'raise':
          return `${name} raises to ${String(event.action.amountTo ?? '')}`;
        default:
          return `${name} ${event.action.type}`;
      }
    }
    case 'uncalled-bet-returned':
      return `${String(event.amount)} returned to ${seatName(event.seatId)}`;
    case 'showdown-reveal':
      return `${seatName(event.seatId)} shows ${cardsToStr(event.holeCards)}`;
    case 'pot-awarded':
      return event.winners
        .map((w) => `${seatName(w.seatId)} wins ${String(w.amount)}${w.handName ? ` with ${w.handName}` : ''}`)
        .join(', ');
    case 'hand-complete':
      return null;
    case 'cards-dealt':
    case 'your-cards':
    case 'betting-round-closed':
    case 'pots-formed':
      return null;
    default:
      return null;
  }
}

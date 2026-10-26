import { formatChips } from './chips.js';
import type { Card } from '@pokerclause/engine';
import type { ProjectedGameEvent } from '@pokerclause/shared';
import { splitLogLine } from './splitPot.js';

function cardsToStr(cards: readonly Card[]): string {
  return cards.join(' ');
}

/** Turns a raw engine event into one human-readable log line, or null for events not worth showing. `potCount` is how many pots its hand awarded (for naming a split side pot). */
export function describeEvent(event: ProjectedGameEvent, seatName: (seatId: number) => string, potCount = 1): string | null {
  switch (event.type) {
    case 'hand-started':
      return `— Hand #${String(event.handNumber)} —`;
    case 'blinds-posted':
      return event.posts.map((p) => `${seatName(p.seatId)} posts ${p.kind} ${formatChips(p.amount)}${p.allIn ? ' (all-in)' : ''}`).join(', ');
    case 'ante-posted':
      return event.posts.length > 0 ? `Ante posted (${formatChips(event.posts.reduce((s, p) => s + p.amount, 0))} total)` : null;
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
          return `${name} bets ${event.action.amountTo !== undefined ? formatChips(event.action.amountTo) : ''}`;
        case 'raise':
          return `${name} raises to ${event.action.amountTo !== undefined ? formatChips(event.action.amountTo) : ''}`;
        default:
          return `${name} ${event.action.type}`;
      }
    }
    case 'uncalled-bet-returned':
      return `${formatChips(event.amount)} returned to ${seatName(event.seatId)}`;
    case 'showdown-reveal':
      return `${seatName(event.seatId)} shows ${cardsToStr(event.holeCards)}`;
    case 'pot-awarded':
      // A split reads as one: "Alice and Bob split the pot, $5 each".
      return (
        splitLogLine(event, seatName, potCount) ??
        event.winners
          .map((w) => `${seatName(w.seatId)} wins ${formatChips(w.amount)}${w.handName ? ` with ${w.handName}` : ''}`)
          .join(', ')
      );
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

/** Every event's log line, in order — each pot award knowing how many pots its hand had. */
export function describeEvents(events: readonly ProjectedGameEvent[], seatName: (seatId: number) => string): string[] {
  const potCounts = new Map<number, number>();
  let hand = 0;
  events.forEach((e) => {
    if (e.type === 'hand-started') hand++;
    if (e.type === 'pot-awarded') potCounts.set(hand, (potCounts.get(hand) ?? 0) + 1);
  });
  const lines: string[] = [];
  hand = 0;
  for (const e of events) {
    if (e.type === 'hand-started') hand++;
    const line = describeEvent(e, seatName, potCounts.get(hand) ?? 1);
    if (line !== null) lines.push(line);
  }
  return lines;
}

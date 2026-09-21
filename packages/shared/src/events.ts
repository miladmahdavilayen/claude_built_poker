import type { Card, Pot } from '@pokerclause/engine';

export type ProjectedGameEvent =
  | { type: 'hand-started'; handNumber: number; buttonSeat: number; smallBlindSeat: number | null; bigBlindSeat: number }
  | { type: 'ante-posted'; posts: readonly { seatId: number; amount: number }[] }
  | { type: 'blinds-posted'; posts: readonly { seatId: number; kind: string; amount: number; allIn: boolean }[] }
  | { type: 'cards-dealt'; seats: readonly number[] } // never carries card values over the wire for anyone else
  | { type: 'your-cards'; cards: readonly Card[] } // sent only to the owning seat, never broadcast
  | { type: 'action-taken'; seatId: number; action: { type: string; amountTo?: number }; resultingStack: number; committedThisStreet: number }
  | { type: 'street-dealt'; street: string; board: readonly Card[] }
  | { type: 'betting-round-closed'; street: string }
  | { type: 'uncalled-bet-returned'; seatId: number; amount: number }
  | { type: 'pots-formed'; pots: readonly Pot[] }
  | { type: 'showdown-reveal'; seatId: number; holeCards: readonly Card[] }
  | { type: 'pot-awarded'; potIndex: number; winners: readonly { seatId: number; amount: number; handName?: string; bestFive?: readonly Card[] }[] }
  | { type: 'hand-complete'; handNumber: number };

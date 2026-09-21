import type { ProjectedGameEvent } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';
import type { SeatPosition } from '../seatLayout.js';
import { playCardFlickSound, playChipSound, playShuffleSound } from '../sound.js';

// Same spot BoardAndPot renders at — only ever occupied for the brief
// shuffle/deal window, well before any street's cards land there, and by
// then the board itself has already reset to empty placeholders (the same
// 'state' broadcast that carries 'hand-started' also carries the fresh,
// empty board).
const DECK_LEFT = 50;
const DECK_TOP = 42;
// Approximate on-screen spacing of the 5 board-card slots, centered under
// the deck spot — a felt-relative percentage, same convention as every
// other coordinate here (see seatLayout.ts), not a pixel-measured DOM
// read, which would add real complexity for a purely decorative flourish.
const BOARD_SLOT_SPACING = 5.2;
const STREET_NEW_CARD_COUNT: Record<string, number> = { flop: 3, turn: 1, river: 1 };

const SHUFFLE_MS = 700;
const DEAL_START_DELAY_MS = 650; // let the shuffle read as "finishing" before the first card leaves the deck
const CARD_FLIGHT_MS = 380;
const PER_SEAT_STAGGER_MS = 90;
const ROUND_GAP_MS = 140;
const STREET_CARD_STAGGER_MS = 140;
const CHIP_FLIGHT_MS = 260;

interface FlyingCard {
  id: string;
  toLeft: number;
  toTop: number;
  delayMs: number;
}

interface FlyingChip {
  id: string;
  fromLeft: number;
  fromTop: number;
  toLeft: number;
  toTop: number;
}

function boardSlotPosition(index: number): { left: number; top: number } {
  return { left: 50 + (index - 2) * BOARD_SLOT_SPACING, top: DECK_TOP };
}

/**
 * Lightweight, purely decorative animations with synthesized sound (see
 * sound.ts) — driven entirely by events already broadcast for other
 * reasons ('hand-started', 'cards-dealt', 'street-dealt', 'action-taken'),
 * so none of this needed a server change. Timeouts are ref-tracked rather
 * than tied to useEffect's per-dependency cleanup, specifically so an
 * unrelated later event (e.g. a bot's action arriving mid-shuffle) can't
 * cut an in-progress animation short — see the individual refs below.
 */
export function DealAnimation({
  events,
  positions,
}: {
  events: readonly ProjectedGameEvent[];
  positions: readonly SeatPosition[];
}): React.JSX.Element {
  const [shuffling, setShuffling] = useState(false);
  const [flyingCards, setFlyingCards] = useState<FlyingCard[]>([]);
  const [boardFlyingCards, setBoardFlyingCards] = useState<FlyingCard[]>([]);
  const [flyingChips, setFlyingChips] = useState<FlyingChip[]>([]);
  const shuffleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dealBatchRef = useRef(0);
  const streetBatchRef = useRef(0);
  const chipBatchRef = useRef(0);

  useEffect(() => {
    if (events.some((e) => e.type === 'hand-started')) {
      playShuffleSound();
      setShuffling(true);
      if (shuffleTimeoutRef.current) clearTimeout(shuffleTimeoutRef.current);
      shuffleTimeoutRef.current = setTimeout(() => setShuffling(false), SHUFFLE_MS);
    }

    const cardsDealt = events.find((e): e is Extract<ProjectedGameEvent, { type: 'cards-dealt' }> => e.type === 'cards-dealt');
    if (cardsDealt && cardsDealt.seats.length > 0) {
      const batchId = ++dealBatchRef.current;
      const seats = cardsDealt.seats;
      const cards: FlyingCard[] = [];
      let maxDelay = 0;
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < seats.length; i++) {
          const seatId = seats[i]!;
          const pos = positions.find((p) => p.seatId === seatId);
          if (!pos) continue;
          const delayMs = DEAL_START_DELAY_MS + round * (seats.length * PER_SEAT_STAGGER_MS + ROUND_GAP_MS) + i * PER_SEAT_STAGGER_MS;
          maxDelay = Math.max(maxDelay, delayMs);
          cards.push({ id: `${String(batchId)}-${String(round)}-${String(seatId)}`, toLeft: pos.left, toTop: pos.top, delayMs });
          playCardFlickSound(delayMs / 1000);
        }
      }
      setFlyingCards(cards);
      if (dealTimeoutRef.current) clearTimeout(dealTimeoutRef.current);
      dealTimeoutRef.current = setTimeout(() => {
        if (dealBatchRef.current === batchId) setFlyingCards([]);
      }, maxDelay + CARD_FLIGHT_MS + 60);
    }

    const streetDealt = events.find((e): e is Extract<ProjectedGameEvent, { type: 'street-dealt' }> => e.type === 'street-dealt');
    if (streetDealt) {
      const newCount = STREET_NEW_CARD_COUNT[streetDealt.street] ?? 0;
      const startIndex = streetDealt.board.length - newCount;
      if (newCount > 0 && startIndex >= 0) {
        const batchId = ++streetBatchRef.current;
        const cards: FlyingCard[] = [];
        let maxDelay = 0;
        for (let i = 0; i < newCount; i++) {
          const slot = boardSlotPosition(startIndex + i);
          const delayMs = i * STREET_CARD_STAGGER_MS;
          maxDelay = Math.max(maxDelay, delayMs);
          cards.push({ id: `street-${String(batchId)}-${String(i)}`, toLeft: slot.left, toTop: slot.top, delayMs });
          playCardFlickSound(delayMs / 1000);
        }
        setBoardFlyingCards(cards);
        if (streetTimeoutRef.current) clearTimeout(streetTimeoutRef.current);
        streetTimeoutRef.current = setTimeout(() => {
          if (streetBatchRef.current === batchId) setBoardFlyingCards([]);
        }, maxDelay + CARD_FLIGHT_MS + 60);
      }
    }

    const betActions = events.filter(
      (e): e is Extract<ProjectedGameEvent, { type: 'action-taken' }> =>
        e.type === 'action-taken' && (e.action.type === 'bet' || e.action.type === 'raise' || e.action.type === 'call'),
    );
    if (betActions.length > 0) {
      const batchId = ++chipBatchRef.current;
      const chips: FlyingChip[] = [];
      betActions.forEach((action, i) => {
        const pos = positions.find((p) => p.seatId === action.seatId);
        if (!pos) return;
        chips.push({ id: `chip-${String(batchId)}-${String(action.seatId)}`, fromLeft: pos.left, fromTop: pos.top, toLeft: pos.betLeft, toTop: pos.betTop });
        playChipSound(i * 0.06);
      });
      setFlyingChips(chips);
      if (chipTimeoutRef.current) clearTimeout(chipTimeoutRef.current);
      chipTimeoutRef.current = setTimeout(() => {
        if (chipBatchRef.current === batchId) setFlyingChips([]);
      }, CHIP_FLIGHT_MS + 60);
    }
  }, [events, positions]);

  // Only ever cleared on unmount — NOT on every `events` change, which is
  // the whole point of ref-tracking these instead of returning a cleanup
  // closure from the effect above.
  useEffect(
    () => () => {
      if (shuffleTimeoutRef.current) clearTimeout(shuffleTimeoutRef.current);
      if (dealTimeoutRef.current) clearTimeout(dealTimeoutRef.current);
      if (streetTimeoutRef.current) clearTimeout(streetTimeoutRef.current);
      if (chipTimeoutRef.current) clearTimeout(chipTimeoutRef.current);
    },
    [],
  );

  return (
    <>
      {shuffling && (
        <div className="shuffle-deck" style={{ left: `${String(DECK_LEFT)}%`, top: `${String(DECK_TOP)}%` }}>
          <span className="shuffle-card" />
          <span className="shuffle-card" />
          <span className="shuffle-card" />
        </div>
      )}
      {[...flyingCards, ...boardFlyingCards].map((c) => (
        <span
          key={c.id}
          className="flying-card"
          style={
            {
              '--from-left': `${String(DECK_LEFT)}%`,
              '--from-top': `${String(DECK_TOP)}%`,
              '--to-left': `${String(c.toLeft)}%`,
              '--to-top': `${String(c.toTop)}%`,
              '--delay': `${String(c.delayMs)}ms`,
            } as React.CSSProperties
          }
        />
      ))}
      {flyingChips.map((c) => (
        <span
          key={c.id}
          className="flying-chip"
          style={
            {
              '--from-left': `${String(c.fromLeft)}%`,
              '--from-top': `${String(c.fromTop)}%`,
              '--to-left': `${String(c.toLeft)}%`,
              '--to-top': `${String(c.toTop)}%`,
            } as React.CSSProperties
          }
        />
      ))}
    </>
  );
}

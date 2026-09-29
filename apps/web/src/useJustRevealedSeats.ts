import type { Card } from '@pokerclause/engine';
import type { ProjectedGameEvent } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';
import { isBluffHand } from './handStrength.js';
import { playBluffRevealSound, playHandRevealSound } from './sound.js';

const REVEAL_FLIP_MS = 900;

/**
 * Seats whose hole cards just flipped face-up via a voluntary post-fold-win
 * reveal (see RevealHandButton.tsx) — true for a brief window so
 * Seat/PlayingCard can play a one-shot flip animation instead of the cards
 * just silently appearing, and so the right sound (a genuine hand vs a
 * bluff, per isBluffHand) plays exactly once per reveal.
 *
 * Deliberately narrower than "any `showdown-reveal` event": a genuine
 * two-way showdown ALSO broadcasts `showdown-reveal`, but arrives bundled
 * in the same batch as that hand's own `pot-awarded`/`hand-complete`
 * events (see LiveTable.applyPlayerAction), while a voluntary reveal is
 * always its own standalone broadcast (see LiveTable.revealHand). That
 * bundling is what tells the two apart here, with no server protocol
 * change needed — existing showdown rendering is completely untouched.
 */
export function useJustRevealedSeats(events: readonly ProjectedGameEvent[], board: readonly Card[]): ReadonlySet<number> {
  const [justRevealed, setJustRevealed] = useState<ReadonlySet<number>>(new Set());
  const timeoutsRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const reveals = events.filter((e): e is Extract<ProjectedGameEvent, { type: 'showdown-reveal' }> => e.type === 'showdown-reveal');
    if (reveals.length === 0) return;
    const isVoluntaryReveal = !events.some((e) => e.type === 'pot-awarded' || e.type === 'hand-complete');
    if (!isVoluntaryReveal) return;

    setJustRevealed((prev) => {
      const next = new Set(prev);
      for (const r of reveals) next.add(r.seatId);
      return next;
    });

    for (const r of reveals) {
      if (isBluffHand(r.holeCards, board)) playBluffRevealSound();
      else playHandRevealSound();

      const existing = timeoutsRef.current.get(r.seatId);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        setJustRevealed((prev) => {
          const next = new Set(prev);
          next.delete(r.seatId);
          return next;
        });
        timeoutsRef.current.delete(r.seatId);
      }, REVEAL_FLIP_MS);
      timeoutsRef.current.set(r.seatId, timeout);
    }
  }, [events, board]);

  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      for (const t of timeouts.values()) clearTimeout(t);
    };
  }, []);

  return justRevealed;
}

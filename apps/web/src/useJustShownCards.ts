import type { ProjectedSeat } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';
import { playHandRevealSound } from './sound.js';

const FLIP_MS = 900;

/**
 * Cards just shown by choice (`seat.shownCards`), as "seat:index" —
 * for a moment, so they can play their flip — with the reveal's sound for each,
 * once. Cards already shown when the page first sees them just stay shown.
 */
export function useJustShownCards(seats: readonly ProjectedSeat[], handId: string | null): ReadonlySet<string> {
  const [just, setJust] = useState<ReadonlySet<string>>(new Set());
  const known = useRef<{ hand: string | null; keys: Set<string> } | null>(null);
  const keys = seats.flatMap((s) => s.shownCards.map((c) => `${String(s.seatId)}:${String(c.index)}`));
  const signature = keys.join(',');
  useEffect(() => {
    const prev = known.current;
    known.current = { hand: handId, keys: new Set(keys) };
    if (!prev || prev.hand !== handId) return;
    const fresh = keys.filter((k) => !prev.keys.has(k));
    if (fresh.length === 0) return;
    playHandRevealSound();
    setJust((cur) => new Set([...cur, ...fresh]));
    // Not cleared on the next change: a second card shown right after mustn't leave the first flipping for ever.
    setTimeout(() => {
      setJust((cur) => new Set([...cur].filter((k) => !fresh.includes(k))));
    }, FLIP_MS);
    // `signature` stands for `keys`.
  }, [signature, handId]);
  return just;
}

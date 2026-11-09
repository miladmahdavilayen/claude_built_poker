import { useEffect, useState } from 'react';
import { playShuffleSound } from '../sound.js';

/**
 * Owns the whole `.start-hand-panel` — not just an addition alongside it —
 * specifically so its 200ms countdown tick (same pattern as
 * ActionTimer.tsx, see that component's own doc comment) only ever
 * re-renders this one small piece, not the entire table page.
 *
 * `nextHandAt` (set server-side the instant a hand ends — see
 * LiveTable.HAND_BREAK_MS) blocks `canStartHand` for a few real seconds,
 * representing the time a dealer needs to riffle-shuffle and set up the
 * next hand. While it's in the future, this shows that riffle instead of
 * the "Play Hand" button; once it elapses, this falls back to exactly
 * today's button/hint behavior.
 */
export function HandBreakPanel({
  nextHandAt,
  canStartHand,
  amSeated,
  waitingForOwner = false,
  paused = false,
  onStartHand,
}: {
  nextHandAt: number | null;
  canStartHand: boolean;
  amSeated: boolean;
  /** A new or reset table: its owner starts the first hand, and everyone else waits for them. */
  waitingForOwner?: boolean;
  /** A timed table out of time: nothing deals until the owner decides. */
  paused?: boolean;
  onStartHand: () => void;
}): React.JSX.Element {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (nextHandAt === null) {
      setRemainingMs(null);
      return;
    }
    const tick = (): void => setRemainingMs(Math.max(0, nextHandAt - Date.now()));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [nextHandAt]);

  // Once per break, when a fresh nextHandAt actually arrives — not on
  // every 200ms tick above, and not for the initial `null` (no hand has
  // completed yet at all).
  useEffect(() => {
    if (nextHandAt !== null) playShuffleSound();
  }, [nextHandAt]);

  const onBreak = remainingMs !== null && remainingMs > 0;

  // One tap, one request: the button holds until the table's answer arrives (a new state), or 3s at most.
  const [sent, setSent] = useState(false);
  useEffect(() => setSent(false), [nextHandAt, canStartHand]);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 3000);
    return () => clearTimeout(t);
  }, [sent]);

  return (
    <div className="start-hand-panel">
      {onBreak ? (
        <>
          <div className="hand-break-shuffle" aria-hidden="true">
            <span className="shuffle-card" />
            <span className="shuffle-card" />
            <span className="shuffle-card" />
          </div>
          <span className="start-hand-hint">Shuffling&hellip; next hand in {Math.ceil(remainingMs / 1000)}s</span>
        </>
      ) : paused ? (
        <span className="start-hand-hint" data-testid="time-up-paused">
          Time&rsquo;s up &mdash; paused
        </span>
      ) : waitingForOwner ? (
        <span className="start-hand-hint" data-testid="waiting-for-owner">
          Waiting for the table&rsquo;s owner to start the game&hellip;
        </span>
      ) : amSeated ? (
        <>
          <button
            type="button"
            className="btn-start-hand"
            disabled={!canStartHand || sent}
            onClick={() => {
              setSent(true);
              onStartHand();
            }}
          >
            Play Hand
          </button>
          {!canStartHand && <span className="start-hand-hint">Waiting for at least 2 seated players&hellip;</span>}
        </>
      ) : (
        <span className="start-hand-hint">Waiting for a seated player to start a hand&hellip;</span>
      )}
    </div>
  );
}

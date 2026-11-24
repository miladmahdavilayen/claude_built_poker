import type { ActionClock } from '@pokerclause/shared';
import { useEffect, useRef } from 'react';
import { formatChips } from '../chips.js';
import { playFinalWarningBeep } from '../sound.js';
import { useClockPhase } from './ActionTimer.js';

/**
 * What a slow turn puts in front of people, once its first stretch is up:
 *
 * - on your own turn, how long you have left in red — with the button that
 *   buys more time (its price out of your stack, into the pot) — and then
 *   the final warning, counted down out loud;
 * - on someone else's, the button to poke them: once each per turn.
 *
 * Nothing shows during the first, calm stretch. Ticks on its own, like the
 * clock ring (ActionTimer.tsx), so the table page isn't re-rendered for it.
 */
export function TurnClockBanner({
  clock,
  viewerSeatId,
  actorName,
  actorIsMe,
  onBuyTime,
  onPoke,
}: {
  clock: ActionClock | null;
  /** The viewer's seat, or null watching: only a seated player can poke. */
  viewerSeatId: number | null;
  actorName: string;
  actorIsMe: boolean;
  onBuyTime: () => void;
  onPoke: () => void;
}): React.JSX.Element | null {
  const now = useClockPhase(clock);
  const seconds = now ? Math.ceil(now.remainingMs / 1000) : 0;
  const final = now?.phase === 'final';

  // Your final warning is heard: a long beep as it starts, a short one each second after.
  const beeped = useRef<string | null>(null);
  useEffect(() => {
    if (!clock || !actorIsMe || !final) return;
    const key = `${String(clock.startedAt)}:${String(clock.endsAt)}:${String(seconds)}`;
    if (beeped.current === key) return;
    const first = !beeped.current?.startsWith(`${String(clock.startedAt)}:${String(clock.endsAt)}:`);
    beeped.current = key;
    playFinalWarningBeep(first);
    if (first) navigator.vibrate?.([200, 80, 200]);
  }, [clock, actorIsMe, final, seconds]);

  if (!clock || !now || now.phase === 'calm') return null;

  if (actorIsMe) {
    return (
      <div className={`turn-banner turn-banner--mine${final ? ' turn-banner--final' : ''}`} role="alert" data-testid="turn-banner" data-phase={now.phase}>
        <span className="turn-banner-text">
          {final ? (
            <>
              <strong>Final warning</strong> — act in {seconds}s or your hand is played for you
            </>
          ) : (
            <>Your time is running out — {seconds}s</>
          )}
        </span>
        {clock.timeBuyCost !== null && (
          <button type="button" className="turn-banner-button" data-testid="buy-time" onClick={onBuyTime}>
            +{clock.timeBuySeconds}s for {formatChips(clock.timeBuyCost)}
          </button>
        )}
      </div>
    );
  }

  const canPoke = viewerSeatId !== null && !clock.pokedBy.includes(viewerSeatId);
  const poked = viewerSeatId !== null && clock.pokedBy.includes(viewerSeatId);
  if (viewerSeatId === null) return null;
  return (
    <div className={`turn-banner${final ? ' turn-banner--final' : ''}`} role="status" data-testid="turn-banner" data-phase={now.phase}>
      <span className="turn-banner-text">
        {final ? `${actorName}: final warning, ${String(seconds)}s` : `${actorName} is taking a while`}
      </span>
      {canPoke && (
        <button type="button" className="turn-banner-button" data-testid="poke" onClick={onPoke}>
          <span aria-hidden="true">👉</span> Poke
        </button>
      )}
      {poked && <span className="turn-banner-done">Poked</span>}
    </div>
  );
}

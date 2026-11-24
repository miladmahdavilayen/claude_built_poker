import type { ActionClock } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';

const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export type ClockPhase = 'calm' | 'red' | 'final';

/** Where a turn's clock stands at `now`: which stretch it's in, when that started and ends. */
export function clockPhase(clock: ActionClock, now: number): { phase: ClockPhase; from: number; to: number; remainingMs: number } {
  if (now < clock.normalEndsAt) return { phase: 'calm', from: clock.startedAt, to: clock.normalEndsAt, remainingMs: clock.normalEndsAt - now };
  if (now < clock.redEndsAt) return { phase: 'red', from: Math.min(clock.normalEndsAt, clock.redEndsAt), to: clock.redEndsAt, remainingMs: clock.redEndsAt - now };
  return { phase: 'final', from: clock.redEndsAt, to: clock.endsAt, remainingMs: Math.max(0, clock.endsAt - now) };
}

/** The clock's stretch right now, re-read a few times a second — only the component using it re-renders. */
export function useClockPhase(clock: ActionClock | null): ReturnType<typeof clockPhase> | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!clock) return;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [clock]);
  return clock ? clockPhase(clock, Date.now()) : null;
}

/**
 * The clock on whoever's turn it is: the table's action time (30 seconds) in
 * a calm colour, then 30 more in red, then a 10-second final warning,
 * flashing — each stretch its own sweep of the ring and its own countdown.
 * Time a player buys lengthens the red stretch.
 *
 * Isolated on purpose: this used to be a `setInterval` tick living in
 * `TablePage`'s own state, which re-rendered the ENTIRE table page (every
 * seat, the felt, position labels, voice stream lookups — everything)
 * 4 times a second for as long as the clock was running. Keeping the
 * tick local to this one small component means a countdown only ever
 * re-renders itself.
 *
 * The DOM structure stays mounted for the whole hand (only a CSS opacity
 * class changes — the clock is null on every computer player's turn, and
 * mounting and unmounting on each handoff was a visible flash), and the
 * ring's sweep is driven by the Web Animations API on a persistent ref: a
 * fresh `.animate()` per stretch restarts it cleanly without destroying the
 * element it animates.
 */
export function ActionTimer({ clock }: { clock: ActionClock | null }): React.JSX.Element {
  const now = useClockPhase(clock);
  const arcRef = useRef<SVGCircleElement>(null);
  const phase = now?.phase ?? null;
  const from = now?.from ?? 0;
  const to = now?.to ?? 0;

  useEffect(() => {
    if (phase === null || !arcRef.current || to <= from) return;
    const animation = arcRef.current.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: CIRCUMFERENCE }], {
      duration: to - from,
      easing: 'linear',
      fill: 'forwards',
    });
    // Picked up partway through (a reconnect, a purchase of more time): the ring starts where the clock is.
    animation.currentTime = Math.max(0, Math.min(to - from, Date.now() - from));
    return () => animation.cancel();
  }, [phase, from, to]);

  const visible = now !== null;
  const seconds = now ? Math.ceil(now.remainingMs / 1000) : 0;
  const label = !now ? undefined : now.phase === 'final' ? `Final warning: ${String(seconds)} seconds` : `${String(seconds)} seconds to act`;

  return (
    <div
      className={`action-timer action-timer-${phase ?? 'calm'}${visible ? '' : ' action-timer-hidden'}`}
      role="timer"
      data-phase={phase ?? undefined}
      aria-hidden={!visible}
      aria-label={label}
    >
      <svg viewBox="0 0 40 40" className="action-timer-ring">
        <circle className="action-timer-track" cx="20" cy="20" r={RADIUS} />
        <circle ref={arcRef} className="action-timer-arc" cx="20" cy="20" r={RADIUS} strokeDasharray={CIRCUMFERENCE} />
      </svg>
      <span className="action-timer-number">{visible ? seconds : ''}</span>
    </div>
  );
}

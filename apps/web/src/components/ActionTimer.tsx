import { useEffect, useState } from 'react';

const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Isolated on purpose: this used to be a `setInterval` tick living in
 * `TablePage`'s own state, which re-rendered the ENTIRE table page (every
 * seat, the felt, position labels, voice stream lookups — everything)
 * 4 times a second for as long as the clock was running. That's real,
 * measurable jank, and jank is exactly what a "funky, flashing" timer
 * complaint looks like from the outside. Keeping the tick local to this
 * one small component means a countdown only ever re-renders itself.
 */
export function ActionTimer({ deadline, totalSeconds }: { deadline: number | null; totalSeconds: number }): React.JSX.Element | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) {
      setRemainingMs(null);
      return;
    }
    const tick = (): void => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [deadline]);

  if (remainingMs === null) return null;

  const seconds = Math.ceil(remainingMs / 1000);
  const fraction = totalSeconds > 0 ? Math.min(1, Math.max(0, remainingMs / (totalSeconds * 1000))) : 0;
  // Calm by default; only shifts toward red as time genuinely runs out,
  // rather than being a solid alarming red for the entire duration.
  const urgency = fraction < 0.25 ? 'urgent' : fraction < 0.5 ? 'warning' : 'calm';

  return (
    <div className={`action-timer action-timer-${urgency}`} role="timer" aria-label={`${String(seconds)} seconds to act`}>
      <svg viewBox="0 0 40 40" className="action-timer-ring">
        <circle className="action-timer-track" cx="20" cy="20" r={RADIUS} />
        <circle
          className="action-timer-arc"
          cx="20"
          cy="20"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        />
      </svg>
      <span className="action-timer-number">{seconds}</span>
    </div>
  );
}

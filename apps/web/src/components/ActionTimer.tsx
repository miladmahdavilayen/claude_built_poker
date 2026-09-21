import { useEffect, useRef, useState } from 'react';

const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Isolated on purpose: this used to be a `setInterval` tick living in
 * `TablePage`'s own state, which re-rendered the ENTIRE table page (every
 * seat, the felt, position labels, voice stream lookups — everything)
 * 4 times a second for as long as the clock was running. Keeping the
 * tick local to this one small component means a countdown only ever
 * re-renders itself.
 *
 * Two more remount-flash bugs lived here after that fix, both worth
 * recording because neither showed up in a static screenshot or a
 * DOM-mutation-count check — they're about an element being destroyed
 * and recreated, not a static structural difference:
 *
 * 1. The ring's sweep used to be driven by JS setting `strokeDashoffset`
 *    on every 200ms tick, animated via a CSS `transition:
 *    stroke-dashoffset 0.2s`. A 200ms tick racing a 200ms transition
 *    means each new tick's target routinely lands before the previous
 *    transition finishes, so the property keeps getting retargeted
 *    mid-flight instead of ever settling into one smooth sweep.
 * 2. Fixing (1) with `key={deadline}` on the `<circle>` (forcing a fresh
 *    element so a CSS `@keyframes` animation restarts cleanly) traded
 *    one bug for a worse one: `state.actionDeadline` goes `null`
 *    whenever the acting seat is a COMPUTER PLAYER (no reason to show a
 *    human action-clock for a bot's own think-time — see
 *    `armClockOrBot` in liveTable.ts) — not just once between hands, but
 *    on every single handoff to or from a bot. This component used to
 *    `return null` whenever `remainingMs` was `null`, which tore the
 *    entire `.action-timer` div/svg/circle subtree out of the DOM and
 *    reinserted it fresh on every bot-to-human or human-to-bot turn
 *    change — in a hand with any bot seats, that's most turns, each one
 *    a real visible flash.
 *
 * Fixed by keeping the DOM structure permanently mounted for the whole
 * hand (only toggling a CSS opacity class, never actually
 * mounting/unmounting) and driving the ring's sweep with the Web
 * Animations API directly on a persistent ref — a fresh `.animate()`
 * call per turn (cancelling the previous one) restarts the sweep
 * cleanly without ever destroying the element it's animating.
 */
export function ActionTimer({ deadline, totalSeconds }: { deadline: number | null; totalSeconds: number }): React.JSX.Element {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const arcRef = useRef<SVGCircleElement>(null);

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

  useEffect(() => {
    if (deadline === null || !arcRef.current) return;
    const animation = arcRef.current.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: CIRCUMFERENCE }], {
      duration: totalSeconds * 1000,
      easing: 'linear',
      fill: 'forwards',
    });
    return () => animation.cancel();
  }, [deadline, totalSeconds]);

  const visible = remainingMs !== null;
  const seconds = remainingMs !== null ? Math.ceil(remainingMs / 1000) : 0;
  const fraction = remainingMs !== null && totalSeconds > 0 ? Math.min(1, Math.max(0, remainingMs / (totalSeconds * 1000))) : 0;
  // Calm by default; only shifts toward red as time genuinely runs low,
  // rather than being a solid alarming red for the entire duration.
  const urgency = fraction < 0.25 ? 'urgent' : fraction < 0.5 ? 'warning' : 'calm';

  return (
    <div
      className={`action-timer action-timer-${urgency}${visible ? '' : ' action-timer-hidden'}`}
      role="timer"
      aria-hidden={!visible}
      aria-label={visible ? `${String(seconds)} seconds to act` : undefined}
    >
      <svg viewBox="0 0 40 40" className="action-timer-ring">
        <circle className="action-timer-track" cx="20" cy="20" r={RADIUS} />
        <circle ref={arcRef} className="action-timer-arc" cx="20" cy="20" r={RADIUS} strokeDasharray={CIRCUMFERENCE} />
      </svg>
      <span className="action-timer-number">{visible ? seconds : ''}</span>
    </div>
  );
}

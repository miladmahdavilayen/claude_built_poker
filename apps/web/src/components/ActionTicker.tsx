import type { ProjectedGameEvent, ProjectedSeat } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';
import { formatChips } from '../chips.js';

/** How long each action stays in the ticker, and how many show at once. */
const TICKER_MS = 3800;
const TICKER_MAX = 4;

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

/** An action in a few words — "calls $2", "raises to $12" — and its kind (for its colour). */
export function describeTableAction(
  e: Extract<ProjectedGameEvent, { type: 'action-taken' }>,
): { text: string; kind: ActionKind } {
  const allIn = e.resultingStack === 0 && e.action.type !== 'fold';
  const amount = e.action.amountTo !== undefined ? formatChips(e.action.amountTo) : '';
  let text: string;
  let kind: ActionKind;
  switch (e.action.type) {
    case 'fold':
      return { text: 'folds', kind: 'fold' };
    case 'check':
      return { text: 'checks', kind: 'check' };
    case 'call':
      text = `calls ${formatChips(e.committedThisStreet)}`;
      kind = 'call';
      break;
    case 'bet':
      text = `bets ${amount}`;
      kind = 'bet';
      break;
    case 'raise':
      text = `raises to ${amount}`;
      kind = 'raise';
      break;
    default:
      text = e.action.type;
      kind = 'bet';
  }
  return allIn ? { text: `${text} · ALL-IN`, kind: 'allin' } : { text, kind };
}

interface Line {
  id: number;
  name: string;
  text: string;
  kind: ActionKind;
}

/**
 * Every player's action as it happens — "Nit · calls $2" — in a small
 * feed in the corner of the 3D table: colour-coded, a few at a time, each
 * fading after a few seconds. It never covers the table, and it means a
 * player you can't see from your seat (behind the house dealer, beside
 * you) is never acting unnoticed.
 */
export function ActionTicker({ events, seats }: { events: readonly ProjectedGameEvent[]; seats: readonly ProjectedSeat[] }): React.JSX.Element | null {
  const [lines, setLines] = useState<Line[]>([]);
  const lastRef = useRef<readonly ProjectedGameEvent[] | null>(null);
  const idRef = useRef(0);
  const seatsRef = useRef(seats);
  seatsRef.current = seats;
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    if (events === lastRef.current) return;
    lastRef.current = events;
    const fresh: Line[] = [];
    for (const e of events) {
      if (e.type === 'hand-started') setLines([]);
      if (e.type !== 'action-taken') continue;
      const seat = seatsRef.current.find((s) => s.seatId === e.seatId);
      const { text, kind } = describeTableAction(e);
      fresh.push({ id: ++idRef.current, name: seat?.displayName ?? `Seat ${String(e.seatId + 1)}`, text, kind });
    }
    if (fresh.length === 0) return;
    setLines((prev) => [...prev, ...fresh].slice(-TICKER_MAX));
    const ids = new Set(fresh.map((l) => l.id));
    // Each batch fades on its own clock — a newer action never cuts an older one's time short.
    const t = setTimeout(() => {
      timers.current.delete(t);
      setLines((prev) => prev.filter((l) => !ids.has(l.id)));
    }, TICKER_MS);
    timers.current.add(t);
  }, [events]);

  if (lines.length === 0) return null;
  return (
    <div className="action-ticker" data-testid="action-ticker" aria-live="polite">
      {lines.map((l) => (
        <div key={l.id} className={`action-ticker-line action-ticker-line--${l.kind}`}>
          <span className="action-ticker-name">{l.name}</span> {l.text}
        </div>
      ))}
    </div>
  );
}

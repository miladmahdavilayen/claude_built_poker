import { useEffect, useState } from 'react';

export function clockText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

/** Ticks once a second, for whoever shows the time left: its own small piece, not the whole table page. */
export function useTimeLeft(endsAt: number | undefined): number | null {
  const [left, setLeft] = useState<number | null>(endsAt === undefined ? null : endsAt - Date.now());
  useEffect(() => {
    if (endsAt === undefined) {
      setLeft(null);
      return;
    }
    const tick = (): void => setLeft(endsAt - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt]);
  return left;
}

/** The table timer's small clock, top left of the table, for everyone at it: how long before the table ends. */
export function TableClock({ endsAt }: { endsAt: number }): React.JSX.Element | null {
  const left = useTimeLeft(endsAt);
  if (left === null) return null;
  const up = left <= 0;
  const tone = left < 60_000 ? ' table-clock--last' : left < 300_000 ? ' table-clock--soon' : '';
  return (
    <div className={`table-clock${tone}`} data-testid="table-clock" role="timer" title="Time left before this table ends" aria-label={up ? 'Time is up: the table ends after this hand' : `Time left before this table ends: ${clockText(left)}`}>
      <span aria-hidden="true">⏱</span> {up ? 'Last hand' : clockText(left)}
    </div>
  );
}

/**
 * The owner's live control of a running timer (table controls, and the lobby's table settings): a tap moves it at
 * once, for everyone at the table.
 */
export function TableTimerControl({ endsAt, onChange }: { endsAt: number; onChange: (patch: { timerAddMinutes: number } | { timerMinutes: number }) => void }): React.JSX.Element {
  const left = useTimeLeft(endsAt);
  const [minutes, setMinutes] = useState<number | ''>('');
  return (
    <div className="table-timer-control" data-testid="table-timer-control">
      <p className="owner-menu-note">
        Time left: <strong data-testid="table-timer-left">{left === null ? '—' : clockText(left)}</strong>
      </p>
      <div className="table-timer-buttons">
        {[-15, -5, 5, 15, 30, 60].map((m) => (
          <button key={m} type="button" onClick={() => onChange({ timerAddMinutes: m })}>
            {m > 0 ? '+' : '−'}
            {Math.abs(m)} min
          </button>
        ))}
      </div>
      <div className="table-timer-set">
        <label>
          Set to (minutes)
          <input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value === '' ? '' : Number(e.target.value))} />
        </label>
        <button
          type="button"
          disabled={minutes === '' || minutes < 1 || minutes > 1440}
          onClick={() => {
            if (minutes !== '') onChange({ timerMinutes: Math.round(minutes) });
            setMinutes('');
          }}
        >
          Set
        </button>
      </div>
    </div>
  );
}

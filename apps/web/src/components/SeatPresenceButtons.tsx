/**
 * Your place at the table, in the corner stack with the sound buttons: an
 * armchair to sit out (a pause on it) or back in (a play arrow, gold), and
 * an open door to leave. Drawn in the button's own text colour.
 */

function ChairIcon({ out }: { out: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* An armchair: back, seat, arms, legs. */}
      <path d="M5.5 11V6.5A2.5 2.5 0 0 1 8 4h5a2.5 2.5 0 0 1 2.5 2.5V11" />
      <path d="M3.5 11.5a1.5 1.5 0 0 1 3 0V14h8v-2.5a1.5 1.5 0 0 1 3 0V17h-14z" />
      <path d="M5 17v2.5M16 17v2.5" />
      {/* The badge: pause (sit out), or play (sit back in). */}
      <circle cx="18.5" cy="6" r="4.6" fill={out ? '#f2bd4d' : '#0e121a'} stroke={out ? '#f2bd4d' : 'currentColor'} strokeWidth="1.3" />
      {out ? <path d="M17.3 4.1v3.8l3-1.9z" fill="#0e121a" stroke="#0e121a" strokeWidth="1" /> : <path d="M17.4 4.3v3.4M19.6 4.3v3.4" strokeWidth="1.5" />}
    </svg>
  );
}

function DoorIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* An open door in its frame, and the way out. */}
      <path d="M13 4H5.5v16H13" />
      <path d="M5.5 4l6 2v14l-6-2" fill="currentColor" fillOpacity="0.18" />
      <circle cx="9.6" cy="12.4" r="0.7" fill="currentColor" />
      <path d="M14.5 12h7M18.5 9l3 3-3 3" stroke="#ff8a80" />
    </svg>
  );
}

/**
 * Sit out next hand, or back in. `out` is true while you're sitting out —
 * or about to, from the next hand — so a second tap undoes it.
 */
export function SitOutButton({ out, onToggle }: { out: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`table-voice-button${out ? ' table-presence-button--out' : ''}`}
      aria-label={out ? 'Sit back in' : 'Sit out next hand'}
      aria-pressed={out}
      title={out ? 'Sitting out — tap to be dealt in again' : 'Sit out from the next hand (keep your seat)'}
      onClick={onToggle}
    >
      <ChairIcon out={out} />
    </button>
  );
}

/** Leave the table — it asks first (see Table.tsx's leave confirm). */
export function LeaveTableButton({ onLeave }: { onLeave: () => void }): React.JSX.Element {
  return (
    <button type="button" className="table-voice-button table-presence-button--leave" aria-label="Leave table" title="Leave the table" onClick={onLeave}>
      <DoorIcon />
    </button>
  );
}

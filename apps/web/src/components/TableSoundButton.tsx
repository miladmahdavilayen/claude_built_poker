import { useSyncExternalStore } from 'react';
import { isTableSoundMuted, onTableSoundMuteChange, setTableSoundMuted } from '../sound.js';

/** A poker chip — the table's own sounds — sounding or silenced. */
function TableSoundIcon({ muted }: { muted: boolean }): React.JSX.Element {
  // The chip's six edge stripes, round its rim.
  const stripes = [0, 60, 120, 180, 240, 300].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { x1: 8.5 + Math.cos(a) * 4.6, y1: 12 + Math.sin(a) * 4.6, x2: 8.5 + Math.cos(a) * 6.9, y2: 12 + Math.sin(a) * 6.9 };
  });
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8.5" cy="12" r="7" fill="#d2a344" />
      {stripes.map((l, i) => (
        <line key={i} {...l} stroke="#f7f1e3" strokeWidth="2" strokeLinecap="butt" />
      ))}
      <circle cx="8.5" cy="12" r="3.6" fill="#7a1422" stroke="#f7f1e3" strokeWidth="1" />
      {muted ? (
        <path d="M17 9.5l4.5 4.5M21.5 9.5L17 14" stroke="#ff8a80" strokeWidth="2" />
      ) : (
        <g stroke="currentColor" strokeWidth="1.7">
          <path d="M16.6 9.6a3.4 3.4 0 0 1 0 4.8" />
          <path d="M19.2 7.4a6.6 6.6 0 0 1 0 9.2" />
        </g>
      )}
    </svg>
  );
}

/** The table's own sounds (the shuffle, cards, chips) off and back on — the dealer's voice and the call have their own buttons. */
export function TableSoundButton(): React.JSX.Element {
  const muted = useSyncExternalStore(onTableSoundMuteChange, isTableSoundMuted, isTableSoundMuted);
  return (
    <button
      type="button"
      className={`table-voice-button${muted ? ' table-voice-button--off' : ''}`}
      aria-label={muted ? 'Unmute table sounds' : 'Mute table sounds'}
      aria-pressed={muted}
      title={muted ? 'Table sounds off — tap for the shuffle, cards and chips' : 'Table sounds on — tap to mute the shuffle, cards and chips'}
      onClick={() => setTableSoundMuted(!muted)}
    >
      <TableSoundIcon muted={muted} />
    </button>
  );
}

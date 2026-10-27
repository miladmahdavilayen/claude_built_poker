import { isPeerMuted, toggleMuteAll, togglePeer, useCallAudio } from '../callAudio.js';

/** A speaker, sounding or silenced — or, for the whole call, two people talking. Drawn in the button's text colour. */
function CallIcon({ muted, everyone }: { muted: boolean; everyone: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={everyone ? 22 : 16} height={everyone ? 22 : 16} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {everyone ? (
        <>
          {/* Two people, one behind the other. */}
          <circle cx="7" cy="8" r="2.6" />
          <path d="M2.5 18c0-2.8 2-4.6 4.5-4.6s4.5 1.8 4.5 4.6" />
          <circle cx="12" cy="6.5" r="2.2" opacity="0.7" />
          <path d="M9.6 11.6c.7-.5 1.5-.8 2.4-.8 2 0 3.6 1.4 3.9 3.6" opacity="0.7" />
        </>
      ) : (
        // A speaker.
        <path d="M3 9.5h3.5L11 5.5v13l-4.5-4H3z" fill="currentColor" />
      )}
      {muted ? (
        <path d="M16 9l5 5M21 9l-5 5" stroke="#ff8a80" strokeWidth="2" />
      ) : (
        <>
          <path d="M15.5 9.2a3.4 3.4 0 0 1 0 4.6" />
          <path d="M18.2 7a6.8 6.8 0 0 1 0 9" />
        </>
      )}
    </svg>
  );
}

/**
 * The whole call off and back on — in the table's corner, shown only while
 * someone in it is talking. Muting changes only what you hear.
 */
export function MuteAllCallsButton(): React.JSX.Element {
  const { muteAll } = useCallAudio();
  return (
    <button
      type="button"
      className={`table-call-mute-button${muteAll ? ' table-call-mute-button--off' : ''}`}
      aria-label={muteAll ? 'Unmute all calls' : 'Mute all calls'}
      aria-pressed={muteAll}
      title={muteAll ? 'Call voices off — tap to hear everyone' : 'Hearing the call — tap to mute everyone'}
      onClick={toggleMuteAll}
    >
      <CallIcon muted={muteAll} everyone />
    </button>
  );
}

/**
 * One player's voice off and back on, on their own box. `everyone` (the
 * user ids in the call) lets a tap here, while the whole call is muted,
 * mean "just them".
 */
export function PeerMuteButton({ userId, name, everyone }: { userId: string; name: string; everyone: readonly string[] }): React.JSX.Element {
  const audio = useCallAudio();
  const muted = isPeerMuted(userId, audio);
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation();
  return (
    <button
      type="button"
      className={`peer-mute-button${muted ? ' peer-mute-button--off' : ''}`}
      aria-label={muted ? `Unmute ${name}` : `Mute ${name}`}
      aria-pressed={muted}
      title={muted ? `${name} is muted for you — tap to hear them` : `Mute ${name} (only for you)`}
      onPointerDown={stop}
      onPointerUp={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onClick={(e) => {
        e.stopPropagation();
        togglePeer(userId, everyone);
      }}
    >
      <CallIcon muted={muted} everyone={false} />
    </button>
  );
}

import type { VoiceChatApi } from '../useVoiceChat.js';

/**
 * The call, on your own seat box: small round buttons along its top edge —
 * each with a finger-sized tap area around it. Out of the call: join with
 * your mic, or with your camera too. In it: mute, camera, and leave. Taps
 * here never reach the seat's own gestures (the owner's double-tap menu)
 * or the 3D table's look-around drag. Shown even where calling can't work
 * (a browser without it, a plain-http address): a tap says why.
 */
export function SeatCallControls({ voice }: { voice: VoiceChatApi }): React.JSX.Element {
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation();
  return (
    <div className="seat-call" onPointerDown={stop} onPointerUp={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop}>
      {!voice.inCall ? (
        <>
          <button type="button" className="seat-call-btn" aria-label="Join voice" title="Join voice" onClick={() => voice.joinCall(false)}>
            🎤
          </button>
          <button type="button" className="seat-call-btn" aria-label="Join with video" title="Join with video" onClick={() => voice.joinCall(true)}>
            🎥
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={`seat-call-btn${voice.micOn ? '' : ' seat-call-btn--off'}`}
            aria-label={voice.micOn ? 'Mute' : 'Unmute'}
            aria-pressed={!voice.micOn}
            title={voice.micOn ? 'Mute' : 'Unmute'}
            onClick={voice.toggleMic}
          >
            {voice.micOn ? '🎤' : '🔇'}
          </button>
          <button
            type="button"
            className={`seat-call-btn${voice.cameraOn ? '' : ' seat-call-btn--off'}`}
            aria-label={voice.cameraOn ? 'Camera off' : 'Camera on'}
            aria-pressed={!voice.cameraOn}
            title={voice.cameraOn ? 'Turn your camera off' : 'Turn your camera on'}
            onClick={voice.toggleCamera}
          >
            🎥
          </button>
          <button type="button" className="seat-call-btn seat-call-btn--leave" aria-label="Leave call" title="Leave the call" onClick={voice.leaveCall}>
            📞
          </button>
        </>
      )}
    </div>
  );
}

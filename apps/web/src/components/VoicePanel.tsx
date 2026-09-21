import type { VoiceChatApi, VoicePeer } from '../useVoiceChat.js';
import { StreamMedia } from './StreamMedia.js';

/**
 * Seated players' video/audio renders directly on their seat (see
 * `Seat.tsx`) — this panel is just the join/mute/camera/leave controls,
 * plus a small strip for anyone in the call who ISN'T seated (a
 * spectator using voice chat has no seat to render their tile on).
 */
function UnseatedTile({ stream, isLocal, label }: { stream: MediaStream | null; isLocal: boolean; label: string }): React.JSX.Element {
  const hasVideo = !!stream && stream.getVideoTracks().length > 0;
  return (
    <div className="voice-tile">
      {hasVideo ? <StreamMedia stream={stream} isLocal={isLocal} /> : <div className="voice-tile-avatar">{label.slice(0, 1).toUpperCase()}</div>}
      {stream && !hasVideo && <StreamMedia stream={stream} isLocal={isLocal} />}
      <span className="voice-tile-label">{label}</span>
    </div>
  );
}

export function VoicePanel({
  voice,
  myName,
  amSeated,
  unseatedPeers,
}: {
  voice: VoiceChatApi;
  myName: string;
  amSeated: boolean;
  unseatedPeers: VoicePeer[];
}): React.JSX.Element | null {
  if (!voice.supported) return null;

  return (
    <div className="voice-panel">
      {!voice.inCall ? (
        <div className="voice-controls">
          <button type="button" onClick={() => voice.joinCall(false)}>
            🎤 Join voice
          </button>
          <button type="button" onClick={() => voice.joinCall(true)}>
            🎥 Join with video
          </button>
        </div>
      ) : (
        <>
          <div className="voice-controls">
            <button type="button" className={voice.micOn ? '' : 'voice-off'} onClick={voice.toggleMic}>
              {voice.micOn ? '🎤 Mute' : '🔇 Unmute'}
            </button>
            <button type="button" className={voice.cameraOn ? '' : 'voice-off'} onClick={voice.toggleCamera}>
              {voice.cameraOn ? '🎥 Camera off' : '🎥 Camera on'}
            </button>
            <button type="button" className="voice-leave" onClick={voice.leaveCall}>
              Leave call
            </button>
          </div>
          {(!amSeated || unseatedPeers.length > 0) && (
            <div className="voice-tiles">
              {!amSeated && <UnseatedTile stream={voice.localStream} isLocal label={`${myName} (you)`} />}
              {unseatedPeers.map((p) => (
                <UnseatedTile key={p.socketId} stream={p.stream} isLocal={false} label={p.displayName} />
              ))}
            </div>
          )}
        </>
      )}
      {voice.error && <div className="error-banner">{voice.error}</div>}
    </div>
  );
}

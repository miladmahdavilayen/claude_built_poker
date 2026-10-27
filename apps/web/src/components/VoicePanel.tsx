import { unlockMedia, useMediaBlocked } from '../mediaUnlock.js';
import type { VoiceChatApi, VoicePeer } from '../useVoiceChat.js';
import { StreamMedia } from './StreamMedia.js';

/**
 * Seated players' video/audio renders directly on their seat (see
 * `Seat.tsx`) — this panel is just the join/mute/camera/leave controls,
 * plus a small strip for anyone in the call who ISN'T seated (a
 * spectator using voice chat has no seat to render their tile on).
 *
 * Nobody has to join to hear the table: every human already receives
 * whoever is sending (see useVoiceChat.ts), so the strip shows whether or
 * not this viewer is in the call. Video is shown only when `canSeeVideo`
 * (see Table.tsx) — audio plays either way.
 */
export function UnseatedTile({
  stream,
  isLocal,
  label,
  canSeeVideo,
  peerId,
  mute,
}: {
  stream: MediaStream | null;
  isLocal: boolean;
  label: string;
  canSeeVideo: boolean;
  /** Whose voice this is (their user id), for the viewer's own mutes. */
  peerId?: string | undefined;
  /** The button muting them for you (see CallAudioButtons.tsx). */
  mute?: React.ReactNode;
}): React.JSX.Element {
  const hasVideo = !!stream && stream.getVideoTracks().length > 0 && canSeeVideo;
  return (
    <div className="voice-tile">
      {!hasVideo && <div className="voice-tile-avatar">{label.slice(0, 1).toUpperCase()}</div>}
      <StreamMedia stream={stream} isLocal={isLocal} showVideo={canSeeVideo} peerId={peerId} />
      {mute && <div className="voice-tile-mute">{mute}</div>}
      <span className="voice-tile-label">{label}</span>
    </div>
  );
}

export function VoicePanel({
  voice,
  myName,
  amSeated,
  unseatedPeers,
  canSeeVideo,
}: {
  voice: VoiceChatApi;
  myName: string;
  amSeated: boolean;
  unseatedPeers: VoicePeer[];
  canSeeVideo: boolean;
}): React.JSX.Element | null {
  const audioBlocked = useMediaBlocked();
  if (!voice.supported) return null;
  const someoneSending = voice.peers.some((p) => p.stream !== null);

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
          {someoneSending && !audioBlocked && <span className="voice-listening">🔊 Listening to the table</span>}
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
        </>
      )}
      {audioBlocked && (
        <button type="button" className="voice-unlock" onClick={unlockMedia}>
          🔊 Tap to hear the table
        </button>
      )}
      {((voice.inCall && !amSeated) || unseatedPeers.length > 0) && (
        <div className="voice-tiles">
          {voice.inCall && !amSeated && <UnseatedTile stream={voice.localStream} isLocal label={`${myName} (you)`} canSeeVideo />}
          {unseatedPeers.map((p) => (
            <UnseatedTile key={p.socketId} stream={p.stream} isLocal={false} label={p.displayName} canSeeVideo={canSeeVideo} />
          ))}
        </div>
      )}
    </div>
  );
}

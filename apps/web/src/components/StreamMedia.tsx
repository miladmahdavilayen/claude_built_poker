import { useEffect, useRef } from 'react';
import { isPeerMuted, useCallAudio } from '../callAudio.js';
import { forgetMedia, playOrQueue } from '../mediaUnlock.js';

/**
 * Attaches a WebRTC MediaStream to the DOM so it actually plays.
 *
 * Video is always rendered muted and a remote stream's sound always goes
 * through its own `<audio>` element. Two reasons: browsers let muted video
 * autoplay without a user gesture, so faces appear immediately even for a
 * viewer who never joined the call; and the audio element can be retried
 * on the viewer's first tap if the browser blocked it (see mediaUnlock.ts),
 * instead of an unmuted `<video>` silently refusing to play at all. Local
 * media never gets an `<audio>` (you'd hear yourself).
 *
 * `peerId` (the player's user id) is who this is, for the viewer's own
 * mutes: their voice is silenced here if the viewer muted them, or the
 * whole call (see callAudio.ts).
 *
 * `showVideo` (default true) lets a caller suppress the video while the
 * audio keeps playing — used by the camera speaker-bar collapse, and for a
 * viewer who may hear the table but not see it (see Table.tsx's
 * `canSeeVideo`).
 */
export function StreamMedia({
  stream,
  isLocal,
  showVideo = true,
  peerId,
}: {
  stream: MediaStream | null;
  isLocal: boolean;
  showVideo?: boolean;
  peerId?: string | null | undefined;
}): React.JSX.Element | null {
  const muted = isPeerMuted(peerId, useCallAudio());
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const hasVideo = !!stream && stream.getVideoTracks().length > 0;
  const renderVideo = hasVideo && showVideo;
  const renderAudio = !!stream && !isLocal;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = renderVideo ? stream : null;
    if (renderVideo) playOrQueue(el);
    return () => forgetMedia(el);
  }, [stream, renderVideo]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = renderAudio ? stream : null;
    if (renderAudio) playOrQueue(el);
    return () => forgetMedia(el);
  }, [stream, renderAudio]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted, renderAudio]);

  if (!stream) return null;
  return (
    <>
      {renderVideo && <video ref={videoRef} autoPlay playsInline muted className="seat-video-el" />}
      {/* Started only by playOrQueue, never by the autoplay attribute, so a blocked start is always noticed and retried. */}
      {renderAudio && <audio ref={audioRef} />}
    </>
  );
}

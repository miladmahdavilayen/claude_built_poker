import { useEffect, useRef } from 'react';

/**
 * Attaches a WebRTC MediaStream to the DOM so it actually plays.
 *
 * Local video is rendered muted (so you don't hear yourself). A remote
 * stream with no video track still needs an explicit `<audio>` element —
 * without one, its audio track is never attached to anything and never
 * plays. (An earlier version of this only rendered `<video>` when a video
 * track was present, which silently meant audio-only calls carried no
 * sound at all — fixed here.)
 */
export function StreamMedia({ stream, isLocal }: { stream: MediaStream | null; isLocal: boolean }): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const hasVideo = !!stream && stream.getVideoTracks().length > 0;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = hasVideo ? stream : null;
  }, [stream, hasVideo]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.srcObject = !isLocal && !hasVideo ? stream : null;
  }, [stream, isLocal, hasVideo]);

  if (!stream) return null;
  if (hasVideo) return <video ref={videoRef} autoPlay playsInline muted={isLocal} className="seat-video-el" />;
  return <audio ref={audioRef} autoPlay />;
}

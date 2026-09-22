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
 *
 * `showVideo` (default true) lets a caller force the audio-only fallback
 * even when a video track exists — used by the camera speaker-bar
 * collapse (see Table.tsx/Seat.tsx) to keep a suppressed seat's audio
 * playing without rendering its video.
 */
export function StreamMedia({
  stream,
  isLocal,
  showVideo = true,
}: {
  stream: MediaStream | null;
  isLocal: boolean;
  showVideo?: boolean;
}): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const hasVideo = !!stream && stream.getVideoTracks().length > 0;
  const renderVideo = hasVideo && showVideo;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = renderVideo ? stream : null;
  }, [stream, renderVideo]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.srcObject = !isLocal && !renderVideo ? stream : null;
  }, [stream, isLocal, renderVideo]);

  if (!stream) return null;
  if (renderVideo) return <video ref={videoRef} autoPlay playsInline muted={isLocal} className="seat-video-el" />;
  return <audio ref={audioRef} autoPlay />;
}

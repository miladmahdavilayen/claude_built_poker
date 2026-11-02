import { useEffect, useRef, useState } from 'react';
import { TEST_BOT_PERSONAS } from './botPersonas.js';
import { isPeerMuted, onCallAudioChange } from './callAudio.js';

// The owner's test players' cameras (see TEST_BOT_PERSONAS): a few seconds
// after one sits down, it "turns on its camera" — its own short clip from
// public/test-cams/ (cut from the Blender Foundation's open movies, CC BY —
// see public/test-cams/CREDITS.md), looping, quiet. The clip is turned into
// a MediaStream like a real camera's: the picture drawn onto a canvas and
// captured, the sound through Web Audio — so everything a camera feeds (the
// seat's video, the 3D table's screens, the call's sound and its mute
// buttons, the camera layout) treats it exactly as a person on camera.

/** How long after sitting down a test player's camera comes on. */
const CAMERA_DELAY_MS = 3000;

/** Who a test player on camera is in the call (for its mute button — they've no account): by seat. */
export const testCamCallId = (seatId: number): string => `test-cam:${String(seatId)}`;

/** A test player's clip, from their seat's avatar seed (`bot-test-cam-ava` …) — its path without the file type — or null for anyone else. */
export function testCamClip(avatarSeed: string | null | undefined): string | null {
  if (!avatarSeed?.startsWith('bot-test-cam-')) return null;
  const i = TEST_BOT_PERSONAS.findIndex((p) => `bot-${p.id}` === avatarSeed);
  return i < 0 ? null : `/test-cams/cam-${String(i + 1)}`;
}

let audio: AudioContext | null = null;
function audioContext(): AudioContext | null {
  if (audio) return audio;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  audio = Ctor ? new Ctor() : null;
  return audio;
}

/** Where the clips play from — in the document (off screen), so a phone keeps decoding them. */
function shelf(): HTMLElement {
  let el = document.getElementById('test-cam-videos');
  if (!el) {
    el = document.createElement('div');
    el.id = 'test-cam-videos';
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
  }
  return el;
}

interface TestCam {
  stream: MediaStream;
  stop: () => void;
}

function startTestCam(clip: string, callId: string): TestCam {
  const video = document.createElement('video');
  // WebM (VP9, Opus) where the browser plays it, otherwise MP4 (H.264, AAC — an older iPhone).
  video.src = `${clip}.${video.canPlayType('video/webm; codecs="vp9, opus"') ? 'webm' : 'mp4'}`;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  shelf().appendChild(video);
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 320;
  const draw = canvas.getContext('2d')!;
  const paint = (): void => {
    if (video.readyState >= 2) draw.drawImage(video, 0, 0, canvas.width, canvas.height);
  };
  paint();
  const timer = setInterval(paint, 1000 / 24);
  const tracks: MediaStreamTrack[] = [...canvas.captureStream(24).getVideoTracks()];
  // The sound, through Web Audio into the stream (not straight out of the element): the seat plays it like any
  // caller's voice, so the mute buttons work on it. The clips themselves are quiet (about −28 dB).
  const ac = audioContext();
  let source: MediaElementAudioSourceNode | null = null;
  let level: GainNode | null = null;
  if (ac) {
    source = ac.createMediaElementSource(video);
    level = ac.createGain();
    const out = ac.createMediaStreamDestination();
    source.connect(level).connect(out);
    tracks.push(...out.stream.getAudioTracks());
  }
  // Muted (its own button, or the whole call): silenced at the clip itself, not only where the seat plays it — a
  // phone can play a video's sound straight out, round Web Audio.
  const muted = (): boolean => isPeerMuted(callId);
  const applyMute = (): void => {
    const m = muted();
    if (level) level.gain.value = m ? 0 : 1;
    if (m) video.muted = true;
    else if (video.muted && !video.paused) video.muted = false;
  };
  const unsubscribe = onCallAudioChange(applyMute);
  // A browser plays sound only after the page has had a tap: until then the clip runs silent, and the first tap
  // brings its sound in.
  const start = (): void => {
    void ac?.resume().catch(() => undefined);
    video.muted = muted();
    video.play().catch(() => {
      video.muted = true;
      void video.play().catch(() => undefined);
    });
  };
  const events = ['touchend', 'click', 'keydown'] as const;
  const onGesture = (): void => {
    if ((!video.muted || muted()) && ac?.state === 'running' && !video.paused) return;
    start();
  };
  for (const e of events) window.addEventListener(e, onGesture, true);
  start();
  applyMute();
  return {
    stream: new MediaStream(tracks),
    stop: () => {
      unsubscribe();
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, onGesture, true);
      for (const t of tracks) t.stop();
      source?.disconnect();
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    },
  };
}

/**
 * The test players at the table on camera, by seat: each one's camera comes on a few seconds after they sit down,
 * and goes when they leave.
 */
export function useTestBotCameras(seats: readonly { seatId: number; isBot: boolean; avatarSeed: string | null; status: string }[]): ReadonlyMap<number, MediaStream> {
  const [streams, setStreams] = useState<ReadonlyMap<number, MediaStream>>(new Map());
  const cams = useRef(new Map<string, { cam: TestCam | null; timer: ReturnType<typeof setTimeout> | null; seatId: number }>());
  const wanted = seats
    .filter((s) => s.isBot && s.status !== 'empty' && testCamClip(s.avatarSeed))
    .map((s) => `${String(s.seatId)}|${s.avatarSeed ?? ''}`)
    .join(',');
  useEffect(() => {
    const keys = new Set(wanted ? wanted.split(',') : []);
    const publish = (): void => {
      const next = new Map<number, MediaStream>();
      for (const c of cams.current.values()) if (c.cam) next.set(c.seatId, c.cam.stream);
      setStreams(next);
    };
    let changed = false;
    for (const [key, c] of cams.current) {
      if (keys.has(key)) continue;
      if (c.timer) clearTimeout(c.timer);
      c.cam?.stop();
      cams.current.delete(key);
      changed = true;
    }
    for (const key of keys) {
      if (cams.current.has(key)) continue;
      const [seat = '0', seed = ''] = key.split('|');
      const clip = testCamClip(seed);
      if (!clip) continue;
      const entry: { cam: TestCam | null; timer: ReturnType<typeof setTimeout> | null; seatId: number } = { cam: null, timer: null, seatId: Number(seat) };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.cam = startTestCam(clip, testCamCallId(Number(seat)));
        publish();
      }, CAMERA_DELAY_MS);
      cams.current.set(key, entry);
    }
    if (changed) publish();
  }, [wanted]);
  // Leaving the table: every test camera off.
  useEffect(
    () => () => {
      for (const c of cams.current.values()) {
        if (c.timer) clearTimeout(c.timer);
        c.cam?.stop();
      }
      cams.current.clear();
    },
    [],
  );
  return streams;
}

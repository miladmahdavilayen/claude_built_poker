import { useEffect } from 'react';
import { isPeerMuted, onCallAudioChange } from './callAudio.js';
import { forgetMedia, playOrQueue } from './mediaUnlock.js';

// The call's voices, for everyone at the table — whether or not they've
// turned on a mic or camera of their own, and whatever is on screen.
//
// Each remote player's sound has its own <audio> element, kept on the page
// itself rather than inside that player's seat box: a seat box comes and
// goes (the 2D and 3D tables, a camera turning on, a player out of view),
// and a voice must never go with it.
//
// The elements come from a small pool that is "primed" on the viewer's
// taps: an iPhone only lets an <audio> element start by itself once that
// same element has been played from a tap — unless the page is using the
// mic, which is why voices used to be heard only by players in the call. A
// primed element can be given a new voice later and play it at once, so
// whoever starts talking next is heard without another tap.

interface Voice {
  el: HTMLAudioElement;
  stream: MediaStream;
  userId: string | null;
}

export interface CallVoice {
  /** One per connection (the peer's socket id). */
  key: string;
  stream: MediaStream;
  /** Whose voice it is, for the viewer's own mutes (callAudio.ts). */
  userId: string | null;
  /** Their seat, if they have one (on the element, for whoever inspects the page). */
  seatId?: number | null;
}

const POOL_SIZE = 10;
const voices = new Map<string, Voice>();
const spare: HTMLAudioElement[] = [];
const primed = new WeakSet<HTMLAudioElement>();

function shelf(): HTMLElement {
  let el = document.getElementById('call-voices');
  if (!el) {
    el = document.createElement('div');
    el.id = 'call-voices';
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
  }
  return el;
}

function newElement(): HTMLAudioElement {
  const el = document.createElement('audio');
  el.setAttribute('playsinline', '');
  shelf().appendChild(el);
  return el;
}

/** Inside a tap: every waiting element is played once (nothing to hear yet), and any voice the browser held back starts. */
function prime(): void {
  while (spare.length + voices.size < POOL_SIZE) spare.push(newElement());
  for (const el of spare) {
    if (primed.has(el)) continue;
    primed.add(el);
    void el.play().catch(() => undefined);
  }
  for (const v of voices.values()) {
    primed.add(v.el);
    if (v.el.paused) playOrQueue(v.el);
  }
}

if (typeof document !== 'undefined') {
  for (const type of ['pointerdown', 'touchend', 'click', 'keydown'] as const) {
    document.addEventListener(type, prime, { capture: true, passive: true });
  }
  onCallAudioChange(() => {
    for (const v of voices.values()) v.el.muted = isPeerMuted(v.userId);
  });
}

/** Makes the voices playing exactly these: new ones start, gone ones stop, the rest carry on untouched. */
export function setCallVoices(list: readonly CallVoice[]): void {
  const wanted = new Map(list.map((v) => [v.key, v]));
  for (const [key, v] of voices) {
    if (wanted.get(key)?.stream === v.stream) continue;
    v.el.pause();
    v.el.srcObject = null;
    delete v.el.dataset.peer;
    delete v.el.dataset.seat;
    forgetMedia(v.el);
    spare.push(v.el);
    voices.delete(key);
  }
  for (const [key, want] of wanted) {
    const playing = voices.get(key);
    if (playing) {
      playing.userId = want.userId;
      playing.el.muted = isPeerMuted(want.userId);
      playing.el.dataset.seat = want.seatId == null ? '' : String(want.seatId);
      // Held back earlier (no tap yet), or their sound arrived after their picture: try again now.
      if (playing.el.paused) playOrQueue(playing.el);
      continue;
    }
    const el = spare.pop() ?? newElement();
    el.srcObject = want.stream;
    el.muted = isPeerMuted(want.userId);
    el.dataset.peer = want.userId ?? '';
    el.dataset.seat = want.seatId == null ? '' : String(want.seatId);
    voices.set(key, { el, stream: want.stream, userId: want.userId });
    playOrQueue(el);
  }
}

/** Plays every remote player's voice for as long as the table is open (see this file's own comment). */
export function useCallVoices(
  peers: readonly { socketId: string; userId: string; stream: MediaStream | null }[],
  seatOf: (userId: string) => number | null = () => null,
): void {
  // A stream gains its sound without changing identity (a track added to it): the track count is part of the key.
  const key = peers
    .map((p) => `${p.socketId}:${String(seatOf(p.userId))}:${p.stream ? `${p.stream.id}:${String(p.stream.getAudioTracks().length)}` : '-'}`)
    .join('|');
  useEffect(() => {
    setCallVoices(
      peers.flatMap((p) => (p.stream && p.stream.getAudioTracks().length > 0 ? [{ key: p.socketId, stream: p.stream, userId: p.userId, seatId: seatOf(p.userId) }] : [])),
    );
    // `key` says everything about `peers` that matters here.
  }, [key]);
  useEffect(() => () => setCallVoices([]), []);
}

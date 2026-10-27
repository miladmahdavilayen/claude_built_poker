// Lightweight sound effects synthesized entirely with the Web Audio API —
// no audio asset files to ship or load. Card/chip/shuffle sounds are
// short filtered noise bursts; win/loss cues are simple oscillator tones
// (no randomness needed for a deterministic little melody).
//
// Noise generation needs many fast random values per buffer (thousands of
// samples), so it can't call a real entropy source per value the way
// @pokerclause/rng's cryptoSource does (Node's node:crypto isn't even
// available in a browser bundle, and per-sample Web Crypto calls would be
// slow enough to audibly stutter). Instead: seed a tiny local xorshift32
// PRNG from one real Web Crypto draw, then expand it with cheap
// arithmetic. Math.random() itself is never called — repo-wide, that's a
// hard ban (see eslint.config.mjs) — and correctness/determinism don't
// matter here anyway, since this is decorative audio with no gameplay or
// fairness implications.
function xorshift32(seed: number): () => number {
  let state = seed | 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function newRandomFloat01(): () => number {
  const seedArray = new Uint32Array(1);
  (typeof crypto !== 'undefined' ? crypto : window.crypto).getRandomValues(seedArray);
  return xorshift32(seedArray[0]!);
}

let ctx: AudioContext | null = null;
const stateListeners = new Set<() => void>();

/**
 * The table's sound plays with the phone on silent too, like the call's
 * voices (which are media, and always did). An iPhone puts a page's own
 * sound in the "ambient" category, which the silent switch mutes. Newer
 * Safari lets a page say its sound is "playback" instead (the Audio
 * Session API), which the switch leaves alone — and covers the dealer's
 * spoken voice too. Where that's missing (an older iPhone), the sound goes
 * out through a hidden `<audio>` element instead of straight to the
 * speaker: media, so heard just the same.
 */
let mediaOut: { node: MediaStreamAudioDestinationNode; el: HTMLAudioElement } | null = null;

function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Where every sound goes: the speaker, or — an older iPhone — the media element that carries it past the silent switch. */
function speaker(c: AudioContext): AudioNode {
  return mediaOut?.node ?? c.destination;
}

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    ctx = new Ctor();
    if (!session && isIOS() && typeof ctx.createMediaStreamDestination === 'function') {
      const el = document.createElement('audio');
      el.setAttribute('playsinline', '');
      const node = ctx.createMediaStreamDestination();
      el.srcObject = node.stream;
      mediaOut = { node, el };
      for (const e of ['playing', 'pause'] as const)
        el.addEventListener(e, () => {
          for (const l of stateListeners) l();
        });
    }
    ctx.addEventListener('statechange', () => {
      for (const l of stateListeners) l();
    });
  }
  return ctx;
}

/**
 * Game sound is on for everyone — but a browser won't play any until the
 * page has had a real tap, click or key press, and a phone can pause it
 * again later (a call coming in, the app sent to the background). So the
 * table's sound is unlocked on the first such gesture and on every one
 * after, for as long as it isn't running — never just once. On a phone the
 * events that count are the end of a touch (touchend, click), not its
 * start; and an iPhone also wants a sound actually started inside the
 * gesture, so a silent one is. (The phone's own silent switch still
 * silences it: that's the viewer's choice.)
 */
export function unlockAudio(): void {
  const c = getCtx();
  // The media element carrying the sound (an older iPhone) is started by the same gesture, and again if it stopped.
  if (mediaOut?.el.paused) void mediaOut.el.play().catch(() => undefined);
  if (!c || c.state === 'running') return;
  void c.resume().catch(() => undefined);
  const src = c.createBufferSource();
  src.buffer = c.createBuffer(1, 1, c.sampleRate);
  src.connect(speaker(c));
  src.start(0);
}

/** Starts the table's sound now if the browser allows it, and on every gesture until it's running. Returns the cleanup. */
export function installAudioUnlock(): () => void {
  // Created now (allowed without a gesture — it just starts out suspended), so whether it's locked is known at once.
  getCtx();
  const events = ['touchend', 'click', 'pointerup', 'keydown'] as const;
  for (const e of events) window.addEventListener(e, unlockAudio, { capture: true, passive: true });
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') unlockAudio();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    for (const e of events) window.removeEventListener(e, unlockAudio, { capture: true });
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** True while the table's sound is waiting for a tap to start (or restart). */
export function isAudioLocked(): boolean {
  return !!ctx && (ctx.state !== 'running' || !!mediaOut?.el.paused);
}

export function onAudioStateChange(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function noiseBuffer(c: AudioContext, durationSec: number): AudioBuffer {
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * durationSec)), c.sampleRate);
  const data = buffer.getChannelData(0);
  const rand = newRandomFloat01();
  for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
  return buffer;
}

function burst(c: AudioContext, startTime: number, durationSec: number, frequency: number, peakGain: number): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, durationSec);
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = 1;
  const gain = c.createGain();
  // exponentialRamp can't target exactly 0, so it floors just above silence.
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peakGain, startTime + Math.min(0.01, durationSec / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);
  src.connect(filter).connect(gain).connect(speaker(c));
  src.start(startTime);
  src.stop(startTime + durationSec + 0.02);
}

/** A quick riffle-shuffle: several overlapping noise bursts at slightly varied pitch. */
export function playShuffleSound(): void {
  const c = getCtx();
  if (!c) return;
  const rand = newRandomFloat01();
  const bursts = 5;
  for (let i = 0; i < bursts; i++) {
    burst(c, c.currentTime + i * 0.1, 0.09, 1700 + rand() * 900, 0.14);
  }
}

/** One short percussive "flick," for a single card landing on the felt. */
export function playCardFlickSound(delaySec = 0): void {
  const c = getCtx();
  if (!c) return;
  burst(c, c.currentTime + delaySec, 0.045, 3200, 0.12);
}

/** A crisp double-click "clink," for a chip stack landing in front of a player. */
export function playChipSound(delaySec = 0): void {
  const c = getCtx();
  if (!c) return;
  const start = c.currentTime + delaySec;
  burst(c, start, 0.03, 4500, 0.1);
  burst(c, start + 0.045, 0.03, 5200, 0.08);
}

function playTone(startTime: number, durationSec: number, frequency: number, peakGain: number, type: OscillatorType): void {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = frequency;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);
  osc.connect(gain).connect(speaker(c));
  osc.start(startTime);
  osc.stop(startTime + durationSec + 0.02);
}

/** A short triumphant ascending arpeggio — for the viewer's own hand win. */
export function playWinFanfare(): void {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
  notes.forEach((freq, i) => playTone(now + i * 0.09, 0.35, freq, 0.16, 'triangle'));
}

/** A quiet two-note chime — for announcing someone ELSE's win, deliberately understated. */
export function playWinChimeSound(): void {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  playTone(now, 0.25, 880, 0.07, 'sine');
  playTone(now + 0.05, 0.25, 1318.5, 0.05, 'sine');
}

/** A soft, low single tone — for the viewer's own loss, deliberately subtle. */
export function playSoftLossTone(): void {
  const c = getCtx();
  if (!c) return;
  playTone(c.currentTime, 0.3, 220, 0.05, 'sine');
}

/** A bright flick-and-chime — for a player voluntarily showing a genuine made hand after winning without a call. See RevealHandButton.tsx. */
export function playHandRevealSound(): void {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  burst(c, now, 0.05, 3000, 0.12);
  playTone(now + 0.05, 0.22, 1046.5, 0.12, 'triangle'); // C6
  playTone(now + 0.14, 0.22, 1318.5, 0.12, 'triangle'); // E6
}

/** A comedic descending "sad trombone" — for a player voluntarily showing they were bluffing. See RevealHandButton.tsx. */
export function playBluffRevealSound(): void {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  burst(c, now, 0.05, 3000, 0.1);
  const notes = [392, 349.23, 293.66]; // G4, F4, D4 — descending
  notes.forEach((freq, i) => playTone(now + 0.08 + i * 0.16, 0.3, freq, 0.14, 'sawtooth'));
}

/** A bright, unmistakable three-note ding — a seat is being held for you (open-invite waitlist). Meant to be heard from another tab. */
export function playSeatOfferAlert(): void {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  [784, 1046.5, 1568].forEach((freq, i) => playTone(now + i * 0.14, 0.4, freq, 0.14, 'triangle'));
  [784, 1046.5, 1568].forEach((freq, i) => playTone(now + 0.75 + i * 0.14, 0.4, freq, 0.12, 'triangle'));
}

// ---- Trophy fanfares (see components/TrophyCelebration.tsx) ----
//
// One per winning-hand tier, straight (1) up to royal flush (6), each a
// step grander than the last: a bell arpeggio and a brass chord for a
// straight; a pickup note and a cymbal for a flush; the classic
// "da-da-da DAAA" with a timpani boom for a full house; a second, higher
// phrase for quads; a key change and a cymbal swell for a straight flush;
// and a two-phrase regal fanfare with a choir pad and a falling sparkle
// cascade for a royal. Still synthesized (no audio files): "brass" is two
// slightly detuned sawtooths through a lowpass filter that opens on the
// attack, bells are a sine with two inharmonic partials, and everything
// runs through a small generated hall reverb and a compressor so stacked
// chords stay loud without clipping.

const NOTE = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, Fs5: 739.99, F5: 698.46, G5: 783.99, A5: 880, B5: 987.77,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, Fs6: 1479.98, G6: 1567.98, A6: 1760, B6: 1975.53, C7: 2093, D7: 2349.32, E7: 2637.02,
} as const;

let fanfareBus: { ctx: AudioContext; input: GainNode } | null = null;

/** A stereo hall impulse: noise with a cubic decay — a cheap, convincing room. */
function hallImpulse(c: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(c.sampleRate * seconds);
  const buffer = c.createBuffer(2, length, c.sampleRate);
  const rand = newRandomFloat01();
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (rand() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buffer;
}

function trophyBus(c: AudioContext): GainNode {
  if (fanfareBus?.ctx === c) return fanfareBus.input;
  const input = c.createGain();
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  const verb = c.createConvolver();
  verb.buffer = hallImpulse(c, 2.2);
  const wet = c.createGain();
  wet.gain.value = 0.3;
  input.connect(comp);
  input.connect(verb).connect(wet).connect(comp);
  comp.connect(speaker(c));
  fanfareBus = { ctx: c, input };
  return input;
}

function brass(c: AudioContext, out: AudioNode, t: number, freq: number, dur: number, peak: number): void {
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 2;
  filter.frequency.setValueAtTime(freq * 1.5, t);
  filter.frequency.exponentialRampToValueAtTime(freq * 7, t + 0.06);
  filter.frequency.exponentialRampToValueAtTime(freq * 3.5, t + 0.25);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.03);
  gain.gain.setValueAtTime(peak * 0.8, t + Math.max(0.05, dur - 0.12));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  filter.connect(gain).connect(out);
  for (const cents of [-7, 7]) {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = cents;
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

function bell(c: AudioContext, out: AudioNode, t: number, freq: number, peak: number, dur = 1.1): void {
  for (const [ratio, level, length] of [
    [1, 1, 1],
    [2.76, 0.35, 0.45],
    [5.4, 0.12, 0.25],
  ] as const) {
    const osc = c.createOscillator();
    osc.frequency.value = freq * ratio;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak * level, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur * length);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + dur * length + 0.02);
  }
}

function cymbal(c: AudioContext, out: AudioNode, t: number, peak: number, dur: number, swell = false): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur);
  const filter = c.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 6500;
  const gain = c.createGain();
  if (swell) {
    // A reversed-cymbal rise that lands exactly on t + dur.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + dur);
    gain.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  } else {
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  src.connect(filter).connect(gain).connect(out);
  src.start(t);
  src.stop(t + dur + 0.05);
}

function boom(c: AudioContext, out: AudioNode, t: number, peak: number): void {
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(130, t);
  osc.frequency.exponentialRampToValueAtTime(48, t + 0.45);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.75);
}

function pad(c: AudioContext, out: AudioNode, t: number, freqs: readonly number[], dur: number, peak: number): void {
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.3);
  gain.gain.setValueAtTime(peak, t + dur - 0.6);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  gain.connect(out);
  for (const f of freqs) {
    for (const cents of [-10, 0, 10]) {
      const osc = c.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      osc.detune.value = cents;
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }
}

/** The viewer's own win with a straight (tier 1) up to a royal flush (6). */
export function playTrophyFanfare(tier: 1 | 2 | 3 | 4 | 5 | 6): void {
  const c = getCtx();
  if (!c) return;
  const out = trophyBus(c);
  const t0 = c.currentTime + 0.03;
  const chord = (at: number, notes: readonly number[], dur: number, peak: number): void => {
    for (const f of notes) brass(c, out, t0 + at, f, dur, peak);
  };
  const bells = (at: number, notes: readonly number[], step: number, peak: number): void => {
    notes.forEach((f, i) => bell(c, out, t0 + at + i * step, f, peak));
  };
  const n = NOTE;

  switch (tier) {
    case 1:
      bells(0, [n.C5, n.E5, n.G5, n.C6], 0.08, 0.12);
      chord(0.32, [n.C4, n.E4, n.G4, n.C5], 0.75, 0.06);
      bell(c, out, t0 + 0.34, n.E6, 0.07);
      break;
    case 2:
      brass(c, out, t0, n.G4, 0.13, 0.09);
      chord(0.16, [n.C4, n.E4, n.G4, n.C5, n.E5], 0.95, 0.06);
      bells(0.2, [n.C6, n.E6, n.G6, n.C7], 0.07, 0.09);
      cymbal(c, out, t0 + 0.16, 0.05, 1.1);
      break;
    case 3:
      [0, 0.13, 0.26].forEach((at) => brass(c, out, t0 + at, n.G4, 0.11, 0.1));
      chord(0.4, [n.C4, n.G4, n.C5, n.E5, n.G5], 1.2, 0.06);
      boom(c, out, t0 + 0.4, 0.45);
      cymbal(c, out, t0 + 0.4, 0.08, 1.6);
      bells(0.45, [n.C6, n.E6, n.G6, n.C7], 0.07, 0.09);
      break;
    case 4:
      [0, 0.12, 0.24].forEach((at) => brass(c, out, t0 + at, n.G4, 0.1, 0.1));
      chord(0.36, [n.C4, n.G4, n.C5, n.E5], 0.45, 0.06);
      boom(c, out, t0 + 0.36, 0.4);
      [0.85, 0.97].forEach((at) => brass(c, out, t0 + at, n.G5, 0.1, 0.08));
      chord(1.1, [n.C4, n.G4, n.C5, n.E5, n.G5, n.C6], 1.4, 0.055);
      boom(c, out, t0 + 1.1, 0.5);
      cymbal(c, out, t0 + 1.1, 0.1, 2);
      bells(1.15, [n.C6, n.D6, n.E6, n.G6, n.A6, n.C7, n.D7, n.E7], 0.05, 0.07);
      break;
    case 5:
      cymbal(c, out, t0, 0.07, 0.5, true);
      [0.5, 0.62, 0.74].forEach((at) => brass(c, out, t0 + at, n.G4, 0.1, 0.1));
      chord(0.86, [n.C4, n.G4, n.C5, n.E5], 0.45, 0.06);
      boom(c, out, t0 + 0.86, 0.4);
      [1.3, 1.42].forEach((at) => brass(c, out, t0 + at, n.A5, 0.1, 0.08));
      // The key change: the last chord lands a step up, in D.
      chord(1.55, [n.D4, n.A4, n.D5, n.Fs5, n.A5, n.D6], 1.6, 0.055);
      boom(c, out, t0 + 1.55, 0.5);
      boom(c, out, t0 + 1.7, 0.35);
      cymbal(c, out, t0 + 1.55, 0.11, 2.2);
      bells(1.6, [n.D6, n.E6, n.Fs6, n.A6, n.B6, n.D7, n.E7, n.D7, n.B6, n.A6, n.Fs6, n.D6], 0.05, 0.065);
      break;
    case 6:
      cymbal(c, out, t0, 0.08, 0.6, true);
      bells(0, [n.C6, n.E6, n.G6, n.C7], 0.12, 0.05);
      brass(c, out, t0 + 0.6, n.C5, 0.12, 0.09);
      brass(c, out, t0 + 0.72, n.E5, 0.12, 0.09);
      brass(c, out, t0 + 0.84, n.G5, 0.12, 0.09);
      chord(1.0, [n.C4, n.G4, n.C5, n.E5, n.C6], 0.5, 0.055);
      boom(c, out, t0 + 1.0, 0.45);
      cymbal(c, out, t0 + 1.0, 0.08, 1.2);
      brass(c, out, t0 + 1.55, n.G5, 0.12, 0.08);
      brass(c, out, t0 + 1.67, n.A5, 0.12, 0.08);
      brass(c, out, t0 + 1.79, n.B5, 0.12, 0.08);
      chord(1.95, [n.C4, n.G4, n.C5, n.E5, n.G5, n.C6, n.E6], 2.1, 0.05);
      pad(c, out, t0 + 1.95, [n.C4, n.E4, n.G4, n.C5], 2.4, 0.05);
      boom(c, out, t0 + 1.95, 0.55);
      boom(c, out, t0 + 2.1, 0.4);
      cymbal(c, out, t0 + 1.95, 0.12, 2.6);
      bells(2.05, [n.C7, n.B6, n.G6, n.E6, n.D6, n.C6, n.B5, n.G5, n.E7, n.C7, n.G6, n.E6, n.C6, n.G5, n.E5, n.C5], 0.06, 0.06);
      bell(c, out, t0 + 3.1, n.C7, 0.1, 1.6);
      break;
  }
}

/**
 * The split-pot cue — deliberately unlike any win sound: one bell note
 * that divides in two, the halves gliding apart (a fourth down and a fifth
 * up) and panning to opposite sides, over a soft chip shimmer. More
 * winners, more voices: each extra one adds a higher, quieter echo.
 */
export function playSplitPotSound(ways = 2): void {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const out = c.createGain();
  out.gain.value = 0.9;
  out.connect(speaker(c));
  // The single note before it divides.
  bell(c, out, now, NOTE.E5, 0.09, 0.5);
  const voices = Math.min(4, Math.max(2, ways));
  const targets = [NOTE.B4, NOTE.B5, NOTE.E6, NOTE.A5];
  const pans = [-0.7, 0.7, -0.35, 0.35];
  for (let i = 0; i < voices; i++) {
    const t = now + 0.16 + i * 0.07;
    const osc = c.createOscillator();
    const g = c.createGain();
    const pan = c.createStereoPanner();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(NOTE.E5, t);
    osc.frequency.exponentialRampToValueAtTime(targets[i]!, t + 0.22);
    pan.pan.setValueAtTime(0, t);
    pan.pan.linearRampToValueAtTime(pans[i]!, t + 0.3);
    const peak = 0.07 / (1 + i * 0.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    osc.connect(g).connect(pan).connect(out);
    osc.start(t);
    osc.stop(t + 0.8);
  }
  // Chips sliding away to each side.
  burst(c, now + 0.3, 0.06, 5200, 0.05);
  burst(c, now + 0.42, 0.06, 4600, 0.045);
  burst(c, now + 0.54, 0.05, 5600, 0.035);
}

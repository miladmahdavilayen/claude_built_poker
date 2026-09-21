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

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/**
 * Browsers refuse to start audio until a real user gesture has happened on
 * the page. Call this from a page-wide, one-time pointerdown/keydown
 * listener (see App.tsx) so the context is already unlocked by the time a
 * hand-start/deal sound needs to play — which may be triggered by another
 * player's click, not this viewer's own.
 */
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === 'suspended') void c.resume();
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
  src.connect(filter).connect(gain).connect(c.destination);
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
  osc.connect(gain).connect(c.destination);
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

/**
 * Checking a hand's fairness in the browser itself — not taking the
 * server's word for it. The same steps as the server's commit-reveal
 * (apps/server/src/rng/commitReveal.ts, FAIRNESS.md), done independently
 * in the player's own browser:
 *
 *  1. SHA-256 of the revealed server seed must equal the commitment shown
 *     on the table before the first card was dealt.
 *  2. Shuffling a fresh deck with HMAC-SHA256(server seed, every player's
 *     seed + ":" + hand number) — through the same counter-mode byte stream
 *     and unbiased Fisher-Yates as @pokerclause/rng — must give exactly the
 *     deck that was dealt.
 */

export interface FairnessRecord {
  handId: string;
  revealed: boolean;
  commitment: string;
  serverSeed?: string;
  clientSeeds?: string[];
  handNumber?: number;
  dealtDeck?: string[];
  message?: string;
}

export interface FairnessCheck {
  commitmentMatches: boolean;
  deckMatches: boolean;
  /** The deck this browser reproduced, top first. */
  derivedDeck: string[];
}

/**
 * A fresh deck in the engine's own canonical order (packages/engine's
 * fullDeck: ranks 2→A, each in suits s, h, d, c). Spelled out here because
 * importing the engine's code into the browser bundle pulls in server-only
 * parts; the cross-check test in the server suite keeps the two identical.
 */
function freshDeck(): string[] {
  const out: string[] = [];
  for (const r of '23456789TJQKA') for (const s of 'shdc') out.push(r + s);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// SHA-256 and HMAC-SHA256 (FIPS 180-4, RFC 2104), written out here rather
// than taken from the browser's Web Crypto: that only exists on https pages
// (and localhost), and the check has to work wherever the table is open.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(msg: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/** @pokerclause/rng's seededSource: block N = HMAC-SHA256(key = seed, 8-byte big-endian N). */
function byteStream(seed: string): () => number {
  const key = utf8(seed);
  let counter = 0n;
  let block: Uint8Array = new Uint8Array(0);
  let pos = 0;
  return () => {
    if (pos >= block.length) {
      const c = new Uint8Array(8);
      new DataView(c.buffer).setBigUint64(0, counter);
      counter += 1n;
      block = hmacSha256(key, c);
      pos = 0;
    }
    return block[pos++]!;
  };
}

/** @pokerclause/rng's nextIntFromByteStream: rejection sampling, never a biased modulo. */
function nextInt(maxExclusive: number, nextByte: () => number): number {
  if (maxExclusive === 1) return 0;
  let bits = 1;
  while (2 ** bits < maxExclusive) bits++;
  const bytes = Math.ceil(bits / 8);
  for (;;) {
    let v = 0;
    for (let i = 0; i < bytes; i++) v = v * 256 + nextByte();
    v %= 2 ** bits;
    if (v < maxExclusive) return v;
  }
}

// Async so a heavier check could move off the main thread later without changing callers.
// eslint-disable-next-line @typescript-eslint/require-await
export async function checkHand(r: Required<Pick<FairnessRecord, 'serverSeed' | 'clientSeeds' | 'handNumber' | 'dealtDeck' | 'commitment'>>): Promise<FairnessCheck> {
  const seed = hexToBytes(r.serverSeed);
  const commitment = bytesToHex(sha256(seed));
  const derivedSeed = bytesToHex(hmacSha256(seed, utf8(`${r.clientSeeds.join('')}:${String(r.handNumber)}`)));
  const next = byteStream(derivedSeed);
  const deck = freshDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = nextInt(i + 1, next);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return {
    commitmentMatches: commitment === r.commitment.toLowerCase(),
    deckMatches: deck.length === r.dealtDeck.length && deck.every((c, i) => c === r.dealtDeck[i]),
    derivedDeck: deck,
  };
}

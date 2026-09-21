import { createHmac } from 'node:crypto';
import { nextIntFromByteStream, type RandomSource } from './randomSource.js';

/**
 * Reproducible RandomSource derived from an opaque seed string via an
 * HMAC-SHA256 DRBG running in counter mode: block N of the stream is
 * HMAC-SHA256(key = seed, message = 64-bit big-endian counter N). Same
 * seed -> byte-identical stream, on any platform or Node version, since
 * HMAC-SHA256 is a fully specified standard algorithm (see tests/golden
 * for a committed vector).
 *
 * The seed is deliberately just a string so M3's commit-reveal scheme can
 * pass `HMAC(serverSeed, clientSeeds + ":" + handNumber)`-derived material
 * straight in without any refactor here.
 */
export function seededSource(seed: string): RandomSource {
  const key = Buffer.from(seed, 'utf8');
  let counter = 0n;
  let buffer = Buffer.alloc(0);
  let pos = 0;

  const refill = (): void => {
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(counter);
    counter += 1n;
    buffer = createHmac('sha256', key).update(counterBuf).digest();
    pos = 0;
  };

  const nextByte = (): number => {
    if (pos >= buffer.length) refill();
    const byte = buffer[pos];
    pos += 1;
    return byte!;
  };

  return {
    nextInt: (maxExclusive: number) => nextIntFromByteStream(maxExclusive, nextByte),
  };
}

import { randomBytes } from 'node:crypto';
import { nextIntFromByteStream, type RandomSource } from './randomSource.js';

const REFILL_SIZE = 4096;

/** Non-reproducible, cryptographically strong. For production shuffles. */
export function cryptoSource(): RandomSource {
  let buffer = Buffer.alloc(0);
  let pos = 0;

  const nextByte = (): number => {
    if (pos >= buffer.length) {
      buffer = randomBytes(REFILL_SIZE);
      pos = 0;
    }
    const byte = buffer[pos];
    pos += 1;
    return byte!;
  };

  return {
    nextInt: (maxExclusive: number) => nextIntFromByteStream(maxExclusive, nextByte),
  };
}

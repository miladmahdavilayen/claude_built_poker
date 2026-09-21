export interface RandomSource {
  /** Uniform integer in [0, maxExclusive). Must be unbiased. */
  nextInt(maxExclusive: number): number;
}

function bitsFor(rangeSize: number): number {
  // Number of bits needed to represent values in [0, rangeSize - 1].
  let bits = 1;
  let capacity = 2;
  while (capacity < rangeSize) {
    bits += 1;
    capacity *= 2;
  }
  return bits;
}

/**
 * Unbiased integer-in-range via rejection sampling over a byte stream.
 * Draws ceil(bits/8) bytes, keeps only the low `bits` bits (a power-of-two
 * modulus, exactly equivalent to a bitmask but done with arithmetic so it
 * stays correct beyond 32-bit ranges), and rejects + redraws fresh bytes
 * whenever the sampled value falls in the biased tail above maxExclusive.
 * Never uses `value % maxExclusive` directly, which would be modulo-biased.
 */
export function nextIntFromByteStream(maxExclusive: number, nextByte: () => number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error(`maxExclusive must be a positive integer, got ${String(maxExclusive)}`);
  }
  if (maxExclusive === 1) return 0;

  const bits = bitsFor(maxExclusive);
  const bytesNeeded = Math.ceil(bits / 8);
  const modulus = 2 ** bits;

  for (;;) {
    let value = 0;
    for (let i = 0; i < bytesNeeded; i++) {
      value = value * 256 + nextByte();
    }
    value %= modulus;
    if (value < maxExclusive) return value;
  }
}

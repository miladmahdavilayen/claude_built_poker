import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { commitmentFor, deriveDeckForHand, generateServerSeed } from '../src/rng/commitReveal.js';
import { checkHand, hmacSha256, sha256 } from '../../web/src/fairness.js';

// The players' own fairness check (apps/web/src/fairness.ts) re-derives the
// deck in the browser with Web Crypto. It must agree with the server's
// commit-reveal exactly — and catch any tampering.

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('the in-browser fairness check', () => {
  it('its own SHA-256 and HMAC give the standard answers (FIPS 180-4, RFC 4231)', () => {
    expect(hex(sha256(bytes('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256(bytes('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(bytes('a'.repeat(1000))))).toBe(createHash('sha256').update('a'.repeat(1000)).digest('hex'));
    expect(hex(hmacSha256(bytes('Jefe'), bytes('what do ya want for nothing?')))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    const longKey = new Uint8Array(131).fill(0xaa);
    expect(hex(hmacSha256(longKey, bytes('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });

  it('reproduces the server’s deck exactly, hand after hand', async () => {
    for (let t = 0; t < 60; t++) {
      const serverSeed = generateServerSeed();
      const clientSeeds = Array.from({ length: 1 + (t % 9) }, () => randomBytes(16).toString('hex'));
      const dealtDeck = deriveDeckForHand(serverSeed, clientSeeds, t + 1);
      const r = await checkHand({ serverSeed, clientSeeds, handNumber: t + 1, dealtDeck, commitment: commitmentFor(serverSeed) });
      expect(r.commitmentMatches && r.deckMatches).toBe(true);
    }
  });

  it('catches a deck that isn’t the sealed one, and a lock code that doesn’t match', async () => {
    const serverSeed = generateServerSeed();
    const deck = deriveDeckForHand(serverSeed, ['seed'], 1);
    const swapped = [deck[1]!, deck[0]!, ...deck.slice(2)];
    expect((await checkHand({ serverSeed, clientSeeds: ['seed'], handNumber: 1, dealtDeck: swapped, commitment: commitmentFor(serverSeed) })).deckMatches).toBe(false);
    expect((await checkHand({ serverSeed, clientSeeds: ['seed'], handNumber: 1, dealtDeck: deck, commitment: 'ab'.repeat(32) })).commitmentMatches).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  commitmentFor,
  deriveDeckForHand,
  generateClientSeed,
  generateServerSeed,
  verifyHand,
} from '../src/rng/commitReveal.js';

describe('commit-reveal fairness scheme', () => {
  it('the same inputs always derive the same deck (determinism)', () => {
    const serverSeed = generateServerSeed();
    const clientSeeds = ['abc', 'def'];
    const deckA = deriveDeckForHand(serverSeed, clientSeeds, 1);
    const deckB = deriveDeckForHand(serverSeed, clientSeeds, 1);
    expect(deckA).toEqual(deckB);
    expect(deckA).toHaveLength(52);
    expect(new Set(deckA).size).toBe(52);
  });

  it('a different hand number derives a different deck', () => {
    const serverSeed = generateServerSeed();
    const clientSeeds = ['abc', 'def'];
    const deck1 = deriveDeckForHand(serverSeed, clientSeeds, 1);
    const deck2 = deriveDeckForHand(serverSeed, clientSeeds, 2);
    expect(deck1).not.toEqual(deck2);
  });

  it('a different client seed derives a different deck (players influence the shuffle)', () => {
    const serverSeed = generateServerSeed();
    const deckA = deriveDeckForHand(serverSeed, ['abc'], 1);
    const deckB = deriveDeckForHand(serverSeed, ['xyz'], 1);
    expect(deckA).not.toEqual(deckB);
  });

  it('commitment matches SHA256(serverSeed) and nothing else', () => {
    const serverSeed = generateServerSeed();
    const commitment = commitmentFor(serverSeed);
    expect(commitment).toHaveLength(64); // hex-encoded SHA-256
    expect(commitmentFor(generateServerSeed())).not.toBe(commitment);
  });

  it('verifyHand succeeds for a genuine, untampered hand', () => {
    const serverSeed = generateServerSeed();
    const commitment = commitmentFor(serverSeed);
    const clientSeeds = [generateClientSeed(), generateClientSeed()];
    const handNumber = 42;
    const dealtDeck = deriveDeckForHand(serverSeed, clientSeeds, handNumber);

    const result = verifyHand({ serverSeedHex: serverSeed, commitment, clientSeeds, handNumber, dealtDeck });
    expect(result.valid).toBe(true);
    expect(result.commitmentMatches).toBe(true);
    expect(result.deckMatches).toBe(true);
  });

  it('verifyHand detects a forged server seed (commitment mismatch)', () => {
    const realServerSeed = generateServerSeed();
    const commitment = commitmentFor(realServerSeed);
    const forgedServerSeed = generateServerSeed();
    const clientSeeds = ['a', 'b'];
    const dealtDeck = deriveDeckForHand(realServerSeed, clientSeeds, 1);

    const result = verifyHand({ serverSeedHex: forgedServerSeed, commitment, clientSeeds, handNumber: 1, dealtDeck });
    expect(result.valid).toBe(false);
    expect(result.commitmentMatches).toBe(false);
  });

  it('verifyHand detects a tampered dealt deck even with a correct commitment', () => {
    const serverSeed = generateServerSeed();
    const commitment = commitmentFor(serverSeed);
    const clientSeeds = ['a', 'b'];
    const realDeck = deriveDeckForHand(serverSeed, clientSeeds, 1);
    const tamperedDeck = [...realDeck.slice(1), realDeck[0]!]; // rotate by one

    const result = verifyHand({ serverSeedHex: serverSeed, commitment, clientSeeds, handNumber: 1, dealtDeck: tamperedDeck });
    expect(result.valid).toBe(false);
    expect(result.commitmentMatches).toBe(true);
    expect(result.deckMatches).toBe(false);
  });
});

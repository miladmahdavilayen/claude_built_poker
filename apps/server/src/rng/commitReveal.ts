import { createHash, createHmac, randomBytes } from 'node:crypto';
import { freshDeck, seededSource, shuffle } from '@pokerclause/rng';
import type { Card } from '@pokerclause/engine';

/**
 * Provable-fairness commit-reveal scheme, per the project spec:
 *
 *  1. Server generates a 32-byte `serverSeed` before any card is dealt.
 *  2. `commitment = SHA256(serverSeed)` is broadcast and persisted first —
 *     this is the promise the server can't take back once players commit.
 *  3. Each player supplies a `clientSeed` (auto-generated, editable).
 *  4. Deck order = shuffle(freshDeck(), seededSource(HMAC-SHA256(serverSeed,
 *     concat(clientSeeds) + ":" + handNumber))). The inner HMAC output
 *     becomes the opaque seed string @pokerclause/rng's seededSource was
 *     specifically designed to accept (see that package's README) — no
 *     refactor needed to wire this in.
 *  5. After the hand, `serverSeed` is revealed. Anyone can now recompute
 *     the deck from {serverSeed, clientSeeds, handNumber} and check it
 *     against both the commitment and the cards actually dealt.
 */

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function commitmentFor(serverSeedHex: string): string {
  return createHash('sha256').update(Buffer.from(serverSeedHex, 'hex')).digest('hex');
}

function derivedSeedFor(serverSeedHex: string, clientSeeds: readonly string[], handNumber: number): string {
  const message = `${clientSeeds.join('')}:${String(handNumber)}`;
  return createHmac('sha256', Buffer.from(serverSeedHex, 'hex')).update(message).digest('hex');
}

export function deriveDeckForHand(serverSeedHex: string, clientSeeds: readonly string[], handNumber: number): Card[] {
  const rnd = seededSource(derivedSeedFor(serverSeedHex, clientSeeds, handNumber));
  return shuffle(freshDeck(), rnd);
}

export interface VerifyHandInput {
  serverSeedHex: string;
  commitment: string;
  clientSeeds: readonly string[];
  handNumber: number;
  dealtDeck: readonly Card[];
}

export interface VerifyHandResult {
  commitmentMatches: boolean;
  deckMatches: boolean;
  derivedDeck: Card[];
  valid: boolean;
}

/** Independently re-derives a hand's deck from the revealed values and checks it against what was actually dealt. */
export function verifyHand(input: VerifyHandInput): VerifyHandResult {
  const commitmentMatches = commitmentFor(input.serverSeedHex) === input.commitment;
  const derivedDeck = deriveDeckForHand(input.serverSeedHex, input.clientSeeds, input.handNumber);
  const deckMatches = derivedDeck.length === input.dealtDeck.length && derivedDeck.every((c, i) => c === input.dealtDeck[i]);
  return { commitmentMatches, deckMatches, derivedDeck, valid: commitmentMatches && deckMatches };
}

export function generateClientSeed(): string {
  return randomBytes(16).toString('hex');
}

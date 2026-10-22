import { createHash, randomBytes } from 'node:crypto';

/**
 * Owner-generated, one-time access keys for registering a new player.
 *
 * A key is 20 characters of Crockford base32 — 100 random bits from the
 * OS CSPRNG — shown as XXXXX-XXXXX-XXXXX-XXXXX: easy to read out or type,
 * and far beyond guessing (with the per-IP limits in front of it, a bot
 * would need on the order of 10^26 years). Only its SHA-256 digest is
 * stored; a fast hash is the right choice for a secret this random (there's
 * no small space to brute-force, unlike a password). Typing is forgiving:
 * case, dashes and spaces don't matter, and O/I/L read as 0/1/1.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const KEY_LENGTH = 20;

export function generateSignupKey(): string {
  // 32 divides 256 evenly, so `byte & 31` is uniform.
  const chars = [...randomBytes(KEY_LENGTH)].map((b) => ALPHABET[b & 31]!).join('');
  return chars.match(/.{5}/g)!.join('-');
}

/** The canonical form of whatever was typed, or null if it can't be a key at all. */
export function normalizeSignupKey(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replaceAll('O', '0')
    .replace(/[IL]/g, '1');
  return s.length === KEY_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

export function hashSignupKey(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

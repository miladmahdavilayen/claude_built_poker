import { describe, expect, it } from 'vitest';
import { generateSignupKey, hashSignupKey, normalizeSignupKey } from '../src/auth/signupKeys.js';
import { FailureLockout } from '../src/security/failureLockout.js';

describe('access keys', () => {
  it('are 20 random Crockford base32 characters in groups of five, never repeating', () => {
    const keys = new Set(Array.from({ length: 2000 }, () => generateSignupKey()));
    expect(keys.size).toBe(2000);
    for (const k of keys) expect(k).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  });

  it('forgive case, dashes, spaces, and O/I/L for 0/1/1 — and reject anything else', () => {
    const key = '0ABCD-1EFGH-JKMNP-QRSTV';
    const canonical = normalizeSignupKey(key);
    expect(canonical).toBe('0ABCD1EFGHJKMNPQRSTV');
    expect(normalizeSignupKey('oabcd iefgh jkmnp qrstv')).toBe(canonical);
    expect(normalizeSignupKey('0abcd-Lefgh-jkmnp-qrstv')).toBe(canonical);
    expect(normalizeSignupKey('pokerisfun')).toBeNull();
    expect(normalizeSignupKey('UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull(); // U isn't in the alphabet
    expect(hashSignupKey(canonical!)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('FailureLockout', () => {
  it('locks a client out after too many failures in the window, then lets it back in', () => {
    let t = 0;
    const lockout = new FailureLockout(3, 1000, 5000, 10, () => t);
    lockout.recordFailure('a');
    lockout.recordFailure('a');
    expect(lockout.retryAfterMs('a')).toBe(0);
    lockout.recordFailure('a');
    expect(lockout.retryAfterMs('a')).toBe(5000);
    expect(lockout.retryAfterMs('b')).toBe(0);
    t = 5001;
    expect(lockout.retryAfterMs('a')).toBe(0);
  });

  it('starts counting afresh once the window passes', () => {
    let t = 0;
    const lockout = new FailureLockout(2, 1000, 5000, 10, () => t);
    lockout.recordFailure('a');
    t = 1500;
    lockout.recordFailure('a');
    expect(lockout.retryAfterMs('a')).toBe(0);
  });

  it('never tracks more than its maximum number of clients', () => {
    const lockout = new FailureLockout(5, 1000, 5000, 3, () => 0);
    for (const c of ['a', 'b', 'c', 'd', 'e']) lockout.recordFailure(c);
    expect((lockout as unknown as { clients: Map<string, unknown> }).clients.size).toBe(3);
  });
});

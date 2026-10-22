import { FailureLockout } from './failureLockout.js';

/**
 * The guessable things on the landing page, each with its own lockout (see
 * FailureLockout). Env-overridable only so the e2e suite — every test from
 * one localhost IP — can lift them; see playwright.config.ts.
 */
const FAILURES = Number(process.env.AUTH_FAILURE_LIMIT ?? 0);
const FIFTEEN_MINUTES = 15 * 60_000;

/** Wrong access keys: 5 in 15 minutes locks the address out for 15 minutes. */
export const signupKeyLockout = new FailureLockout(FAILURES || 5, FIFTEEN_MINUTES, FIFTEEN_MINUTES);

/** Invite codes that match nothing: 10 in 15 minutes locks the address out for 15 minutes. */
export const inviteLockout = new FailureLockout(FAILURES || 10, FIFTEEN_MINUTES, FIFTEEN_MINUTES);

export function lockedOutReply(retryAfterMs: number): { code: string; message: string } {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return { code: 'TOO_MANY_ATTEMPTS', message: `Too many failed attempts. Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.` };
}

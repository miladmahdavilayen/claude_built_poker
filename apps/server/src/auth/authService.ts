import type { Store, UserRecord } from '../db/store.js';
import type { GoogleProfile } from './googleAuth.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { hashSignupKey, normalizeSignupKey } from './signupKeys.js';
import { issueAccessToken, issueRefreshToken } from './session.js';

export interface AuthResult {
  user: UserRecord;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/** Play money only — this has no cash value. A generous default so new players can sit at most tables immediately. */
export const STARTING_CHIP_GRANT = 500_000; // $5,000 — every amount is integer cents (see packages/shared/src/money.ts)

async function buildAuthResult(store: Store, user: UserRecord): Promise<AuthResult> {
  const accessToken = issueAccessToken(user);
  const refresh = await issueRefreshToken(store, user.id);
  return { user, accessToken, refreshToken: refresh.token, refreshTokenExpiresAt: refresh.expiresAt };
}

async function grantStartingChips(store: Store, userId: string): Promise<UserRecord> {
  const user = await store.adjustUserChips(userId, STARTING_CHIP_GRANT);
  await store.recordLedgerEntries([
    { userId, isHouse: false, amount: STARTING_CHIP_GRANT, reason: 'admin_adjust' },
    { userId: null, isHouse: true, amount: -STARTING_CHIP_GRANT, reason: 'admin_adjust' },
  ]);
  return user;
}

export async function signUpGuest(store: Store, displayName: string): Promise<AuthResult> {
  const created = await store.createGuestUser(displayName);
  const user = await grantStartingChips(store, created.id);
  return buildAuthResult(store, user);
}

/**
 * Creates an email/password account. Not exposed over HTTP for public
 * self-registration anymore — the only caller is ensureAdminAccount
 * (index.ts), which uses this so the admin/owner account gets the exact
 * same starting-chip grant every other account gets. See DECISIONS.md.
 */
export async function register(store: Store, email: string, password: string, displayName: string): Promise<AuthResult> {
  const existing = await store.findUserByEmail(email);
  if (existing) throw new AuthError('EMAIL_TAKEN', 'An account with that email already exists.');
  const passwordHash = await hashPassword(password);
  const created = await store.createAccount(email, passwordHash, displayName);
  const user = await grantStartingChips(store, created.id);
  return buildAuthResult(store, user);
}

/** Every new Google player's starting balance, granted once per person — ever. Play money only. */
export const WELCOME_BONUS = 100_000; // $1,000 in cents

/**
 * The key a welcome bonus is remembered by: the email lowercased, with any
 * `+tag` dropped from the local part, and for Gmail the dots too (Gmail
 * ignores both, so `J.Doe+poker@gmail.com` is the same inbox as
 * `jdoe@gmail.com`). Stops the obvious ways of registering "the same email"
 * twice; a genuinely different Google account is a different person as far
 * as we can tell.
 */
export function normalizeEmailKey(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at).split('+')[0]!;
  let domain = lower.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

/**
 * Who may register a new account: someone with an owner-generated access
 * key (see signupKeys.ts), or — only for the test-only routes — anyone.
 */
export type RegistrationGate = { signupKey: string | undefined } | 'open';

/**
 * Logs in an existing Google-linked account, or registers a new one —
 * Google accounts have no password, and there's no separate "register"
 * step: a valid, freshly-verified Google identity is the registration.
 * Registering consumes an owner-generated access key (one key, one
 * account — and only the key's Google email, if it's locked to one);
 * signing back into an existing account never needs one.
 *
 * A new account needs a verified email, and gets the WELCOME_BONUS — but
 * only the first time that email (or that Google account) ever registers.
 * The claim is kept in its own table that outlives the account, so
 * deleting an account and signing up again starts the new one at $0. See
 * DECISIONS.md.
 */
export async function loginOrRegisterWithGoogle(store: Store, profile: GoogleProfile, gate: RegistrationGate): Promise<AuthResult> {
  const existing = await store.findUserByGoogleId(profile.googleId);
  if (existing) return buildAuthResult(store, await store.recordGoogleLogin(existing.id, profile.avatarUrl));
  if (gate !== 'open' && !gate.signupKey) {
    throw new AuthError('SIGNUP_KEY_REQUIRED', 'This Google account isn’t registered yet. Enter your access key to sign up.');
  }
  if (!profile.email || !profile.emailVerified) {
    throw new AuthError('EMAIL_NOT_VERIFIED', 'Your Google account needs a verified email address to sign up.');
  }
  const emailTaken = await store.findUserByEmail(profile.email);
  if (emailTaken) throw new AuthError('EMAIL_TAKEN', 'An account with this email already exists.');
  // Consumed only once everything else checks out, so a refused sign-up
  // doesn't burn the player's key.
  let keyId: string | null = null;
  if (gate !== 'open') {
    const normalized = normalizeSignupKey(gate.signupKey!);
    keyId = normalized ? await store.consumeSignupKey(hashSignupKey(normalized), normalizeEmailKey(profile.email)) : null;
    if (!keyId) throw new AuthError('INVALID_SIGNUP_KEY', 'That access key isn’t valid for this Google account — it may have expired or already been used.');
  }
  const created = await store.createGoogleAccount({
    googleId: profile.googleId,
    email: profile.email,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
  });
  if (keyId) await store.attachSignupKeyUser(keyId, created.id);
  const firstTime = await store.claimWelcomeBonus(normalizeEmailKey(profile.email), profile.googleId, WELCOME_BONUS);
  if (!firstTime) return buildAuthResult(store, created);
  const funded = await store.adjustUserChips(created.id, WELCOME_BONUS);
  await store.recordLedgerEntries([
    { userId: created.id, isHouse: false, amount: WELCOME_BONUS, reason: 'welcome_bonus' },
    { userId: null, isHouse: true, amount: -WELCOME_BONUS, reason: 'welcome_bonus' },
  ]);
  return buildAuthResult(store, funded);
}

/**
 * Email/password login — kept ONLY for the admin/owner account (see
 * ensureAdminAccount in index.ts). There is no public registration path
 * for this: a human player signs in with Google, or plays as a guest
 * through an owner's invite link. See DECISIONS.md.
 */
export async function login(store: Store, email: string, password: string): Promise<AuthResult> {
  const user = await store.findUserByEmail(email);
  if (!user || !user.passwordHash) throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.');
  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.');
  return buildAuthResult(store, user);
}

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

import type { Store, UserRecord } from '../db/store.js';
import type { GoogleProfile } from './googleAuth.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { issueAccessToken, issueRefreshToken } from './session.js';

export interface AuthResult {
  user: UserRecord;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/** Play money only — this has no cash value. A generous default so new players can sit at most tables immediately. */
export const STARTING_CHIP_GRANT = 5000;

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

export async function register(store: Store, email: string, password: string, displayName: string): Promise<AuthResult> {
  const existing = await store.findUserByEmail(email);
  if (existing) throw new AuthError('EMAIL_TAKEN', 'An account with that email already exists.');
  const passwordHash = await hashPassword(password);
  const created = await store.createAccount(email, passwordHash, displayName);
  const user = await grantStartingChips(store, created.id);
  return buildAuthResult(store, user);
}

/**
 * Logs in an existing Google-linked account, or creates a new one — Google
 * accounts have no password. This is the "no account to remember" path:
 * a valid, freshly-verified Google identity is already stronger proof of
 * "this is a real, returning person" than most password flows, so there's
 * no separate "register" step the way email/password has one.
 */
export async function loginOrRegisterWithGoogle(store: Store, profile: GoogleProfile): Promise<AuthResult> {
  const existing = await store.findUserByGoogleId(profile.googleId);
  if (existing) return buildAuthResult(store, existing);
  if (profile.email) {
    const emailTaken = await store.findUserByEmail(profile.email);
    if (emailTaken) {
      throw new AuthError(
        'EMAIL_TAKEN',
        'An account with this email already exists. Log in with your password, then link Google from your account settings.',
      );
    }
  }
  const created = await store.createGoogleAccount(profile.googleId, profile.email, profile.displayName);
  const user = await grantStartingChips(store, created.id);
  return buildAuthResult(store, user);
}

/** Preserves the same user row (id, chips, hand history) — a guest becomes a Google-backed account in place. */
export async function upgradeGuestWithGoogle(store: Store, userId: string, profile: GoogleProfile): Promise<AuthResult> {
  const user = await store.findUserById(userId);
  if (!user) throw new AuthError('USER_NOT_FOUND', 'User not found.');
  if (!user.isGuest) throw new AuthError('NOT_A_GUEST', 'This account is not a guest account.');
  const existingGoogle = await store.findUserByGoogleId(profile.googleId);
  if (existingGoogle) throw new AuthError('GOOGLE_ACCOUNT_ALREADY_LINKED', 'This Google account is already linked to a different user.');
  if (profile.email) {
    const emailTaken = await store.findUserByEmail(profile.email);
    if (emailTaken && emailTaken.id !== userId) throw new AuthError('EMAIL_TAKEN', 'An account with this email already exists.');
  }
  const linked = await store.linkGoogleToGuest(userId, profile.googleId, profile.email);
  return buildAuthResult(store, linked);
}

export async function login(store: Store, email: string, password: string): Promise<AuthResult> {
  const user = await store.findUserByEmail(email);
  if (!user || !user.passwordHash) throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.');
  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.');
  return buildAuthResult(store, user);
}

/** Preserves the same user row (id, chips, hand history) — a guest becomes a full account in place. */
export async function upgradeGuest(store: Store, userId: string, email: string, password: string): Promise<AuthResult> {
  const user = await store.findUserById(userId);
  if (!user) throw new AuthError('USER_NOT_FOUND', 'User not found.');
  if (!user.isGuest) throw new AuthError('NOT_A_GUEST', 'This account is not a guest account.');
  const existing = await store.findUserByEmail(email);
  if (existing) throw new AuthError('EMAIL_TAKEN', 'An account with that email already exists.');
  const passwordHash = await hashPassword(password);
  const upgraded = await store.upgradeGuestToAccount(userId, email, passwordHash);
  return buildAuthResult(store, upgraded);
}

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Store, UserRecord } from '../db/store.js';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AccessTokenPayload {
  sub: string; // userId
  role: 'player' | 'admin';
  isGuest: boolean;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set.');
  return secret;
}

export function issueAccessToken(user: UserRecord): string {
  const payload: AccessTokenPayload = { sub: user.id, role: user.role, isGuest: user.isGuest };
  return jwt.sign(payload, jwtSecret(), { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, jwtSecret()) as AccessTokenPayload;
  } catch {
    return null;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a new random refresh token, stores its hash, and returns the raw token for the cookie. */
export async function issueRefreshToken(store: Store, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await store.createSession(userId, hashToken(token), expiresAt);
  return { token, expiresAt };
}

/** Rotates a refresh token: revokes the old one and issues a new one, only if the old one is still valid. */
export async function rotateRefreshToken(store: Store, oldToken: string): Promise<{ token: string; expiresAt: Date; userId: string } | null> {
  const oldHash = hashToken(oldToken);
  const session = await store.findSessionByTokenHash(oldHash);
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  await store.revokeSession(oldHash);
  const next = await issueRefreshToken(store, session.userId);
  return { ...next, userId: session.userId };
}

export async function revokeRefreshToken(store: Store, token: string): Promise<void> {
  await store.revokeSession(hashToken(token));
}

export const REFRESH_COOKIE_NAME = 'pokerclause_refresh';
export const REFRESH_COOKIE_MAX_AGE_SECONDS = REFRESH_TOKEN_TTL_MS / 1000;

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  STARTING_CHIP_GRANT,
  login,
  loginOrRegisterWithGoogle,
  register,
  normalizeEmailKey,
  signUpGuest,
  WELCOME_BONUS,
} from '../src/auth/authService.js';
import type { GoogleProfile } from '../src/auth/googleAuth.js';
import { verifyAccessToken } from '../src/auth/session.js';
import { MemoryStore } from '../src/db/memoryStore.js';

process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

describe('authService', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('guest signup issues a working access token immediately, with a starting chip grant', async () => {
    const result = await signUpGuest(store, 'Guesty');
    expect(result.user.isGuest).toBe(true);
    expect(result.user.chips).toBe(STARTING_CHIP_GRANT);
    const payload = verifyAccessToken(result.accessToken);
    expect(payload?.sub).toBe(result.user.id);
    expect(payload?.isGuest).toBe(true);
  });

  it('register then login round-trips correctly', async () => {
    await register(store, 'a@b.com', 'correcthorsebatterystaple', 'Alice');
    const result = await login(store, 'a@b.com', 'correcthorsebatterystaple');
    expect(result.user.email).toBe('a@b.com');
  });

  it('login rejects a wrong password without revealing which part was wrong', async () => {
    await register(store, 'a@b.com', 'correcthorsebatterystaple', 'Alice');
    await expect(login(store, 'a@b.com', 'wrong-password')).rejects.toThrow(AuthError);
  });

  it('login rejects an unknown email', async () => {
    await expect(login(store, 'nobody@nowhere.com', 'whatever')).rejects.toThrow(AuthError);
  });

  it('register rejects a duplicate email', async () => {
    await register(store, 'dup@example.com', 'password123', 'A');
    await expect(register(store, 'dup@example.com', 'password123', 'B')).rejects.toThrow(AuthError);
  });

  describe('Google sign-in', () => {
    const google = (googleId: string, email: string | null, displayName = 'Player', emailVerified = true): GoogleProfile => ({
      googleId,
      email,
      emailVerified,
      displayName,
      avatarUrl: 'https://example.com/photo.png',
    });

    it('registers a new account on first sign-in with the $1,000 welcome bonus, ledgered', async () => {
      const result = await loginOrRegisterWithGoogle(store, google('g-1', 'a@gmail.com', 'Ann'));
      expect(result.user.isGuest).toBe(false);
      expect(result.user.googleId).toBe('g-1');
      expect(result.user.email).toBe('a@gmail.com');
      expect(result.user.avatarUrl).toBe('https://example.com/photo.png');
      expect(result.user.lastLoginAt).not.toBeNull();
      expect(result.user.chips).toBe(WELCOME_BONUS);
      expect(WELCOME_BONUS).toBe(100_000);
      expect(await store.ledgerBalanceForUser(result.user.id)).toBe(WELCOME_BONUS);
      expect((await store.ledgerConservationCheck()).balanced).toBe(true);
    });

    it('logs back in via the same Google id on a return visit, without a second account or a second bonus', async () => {
      const first = await loginOrRegisterWithGoogle(store, google('g-2', 'b@gmail.com', 'Bob'));
      const second = await loginOrRegisterWithGoogle(store, google('g-2', 'b@gmail.com', 'Bob'));
      expect(second.user.id).toBe(first.user.id);
      expect(second.user.chips).toBe(WELCOME_BONUS);
    });

    it('never grants the bonus twice to the same email: delete the account, register again, start at $0', async () => {
      const first = await loginOrRegisterWithGoogle(store, google('g-3', 'c@gmail.com'));
      await store.adjustUserChips(first.user.id, -WELCOME_BONUS); // lost it all
      await store.deleteUser(first.user.id);
      const again = await loginOrRegisterWithGoogle(store, google('g-3', 'c@gmail.com'));
      expect(again.user.id).not.toBe(first.user.id);
      expect(again.user.chips).toBe(0);
    });

    it('treats Gmail dots, +tags and letter case as the same email for the bonus', async () => {
      const first = await loginOrRegisterWithGoogle(store, google('g-4', 'jane.doe@gmail.com'));
      await store.deleteUser(first.user.id);
      const again = await loginOrRegisterWithGoogle(store, google('g-4-new', 'JaneDoe+poker@googlemail.com'));
      expect(again.user.chips).toBe(0);
      expect(normalizeEmailKey('J.Doe+x@Gmail.com')).toBe('jdoe@gmail.com');
      expect(normalizeEmailKey('j.doe+x@company.com')).toBe('j.doe@company.com');
    });

    it('never grants the bonus twice to the same Google account, even under a changed email', async () => {
      const first = await loginOrRegisterWithGoogle(store, google('g-5', 'old@gmail.com'));
      await store.deleteUser(first.user.id);
      const again = await loginOrRegisterWithGoogle(store, google('g-5', 'new@gmail.com'));
      expect(again.user.chips).toBe(0);
    });

    it('refuses to register a Google account without a verified email', async () => {
      await expect(loginOrRegisterWithGoogle(store, google('g-6', 'x@gmail.com', 'X', false))).rejects.toThrow(AuthError);
      await expect(loginOrRegisterWithGoogle(store, google('g-7', null))).rejects.toThrow(AuthError);
    });

    it('refuses Google sign-in when the email already belongs to a different (password) account', async () => {
      await register(store, 'dup@example.com', 'password123', 'Dup');
      await expect(loginOrRegisterWithGoogle(store, google('g-8', 'dup@example.com'))).rejects.toThrow(AuthError);
    });
  });
});

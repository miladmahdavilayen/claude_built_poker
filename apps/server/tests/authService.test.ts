import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  STARTING_CHIP_GRANT,
  login,
  loginOrRegisterWithGoogle,
  register,
  signUpGuest,
  upgradeGuest,
  upgradeGuestWithGoogle,
} from '../src/auth/authService.js';
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

  it('upgrading a guest preserves their id and chip balance, and they can then log in with a password', async () => {
    const guest = await signUpGuest(store, 'TempName');
    await store.adjustUserChips(guest.user.id, 1000);
    const upgraded = await upgradeGuest(store, guest.user.id, 'temp@example.com', 'newpassword1');
    expect(upgraded.user.id).toBe(guest.user.id);
    expect(upgraded.user.chips).toBe(STARTING_CHIP_GRANT + 1000);
    expect(upgraded.user.isGuest).toBe(false);

    const relogin = await login(store, 'temp@example.com', 'newpassword1');
    expect(relogin.user.id).toBe(guest.user.id);
  });

  it('cannot upgrade an account that is not a guest', async () => {
    const result = await register(store, 'real@example.com', 'password123', 'Real');
    await expect(upgradeGuest(store, result.user.id, 'new@example.com', 'password123')).rejects.toThrow(AuthError);
  });

  describe('Google sign-in', () => {
    it('creates a new account on first Google sign-in, with a starting chip grant', async () => {
      const result = await loginOrRegisterWithGoogle(store, { googleId: 'g-1', email: 'a@gmail.com', displayName: 'Ann' });
      expect(result.user.isGuest).toBe(false);
      expect(result.user.googleId).toBe('g-1');
      expect(result.user.chips).toBe(STARTING_CHIP_GRANT);
    });

    it('logs back in via the same Google id on a return visit, without creating a second account', async () => {
      const first = await loginOrRegisterWithGoogle(store, { googleId: 'g-2', email: 'b@gmail.com', displayName: 'Bob' });
      const second = await loginOrRegisterWithGoogle(store, { googleId: 'g-2', email: 'b@gmail.com', displayName: 'Bob' });
      expect(second.user.id).toBe(first.user.id);
      expect(second.user.chips).toBe(STARTING_CHIP_GRANT); // no second grant on return login
    });

    it('refuses Google sign-in when the email already belongs to a different (password) account', async () => {
      await register(store, 'dup@example.com', 'password123', 'Dup');
      await expect(loginOrRegisterWithGoogle(store, { googleId: 'g-3', email: 'dup@example.com', displayName: 'Dup' })).rejects.toThrow(AuthError);
    });

    it('upgrading a guest via Google preserves id and chips, same as the email/password upgrade path', async () => {
      const guest = await signUpGuest(store, 'TempName');
      await store.adjustUserChips(guest.user.id, 1000);
      const upgraded = await upgradeGuestWithGoogle(store, guest.user.id, { googleId: 'g-4', email: 'temp@gmail.com', displayName: 'Temp' });
      expect(upgraded.user.id).toBe(guest.user.id);
      expect(upgraded.user.chips).toBe(STARTING_CHIP_GRANT + 1000);
      expect(upgraded.user.isGuest).toBe(false);
      expect(upgraded.user.googleId).toBe('g-4');
    });

    it('cannot upgrade a non-guest account via Google', async () => {
      const result = await register(store, 'real2@example.com', 'password123', 'Real2');
      await expect(
        upgradeGuestWithGoogle(store, result.user.id, { googleId: 'g-5', email: 'x@gmail.com', displayName: 'X' }),
      ).rejects.toThrow(AuthError);
    });

    it('refuses to link a Google account that is already linked to someone else', async () => {
      await loginOrRegisterWithGoogle(store, { googleId: 'g-shared', email: 'shared@gmail.com', displayName: 'Shared' });
      const guest = await signUpGuest(store, 'Guest2');
      await expect(
        upgradeGuestWithGoogle(store, guest.user.id, { googleId: 'g-shared', email: null, displayName: 'X' }),
      ).rejects.toThrow(AuthError);
    });
  });
});

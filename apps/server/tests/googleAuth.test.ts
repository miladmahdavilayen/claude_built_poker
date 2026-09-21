import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// google-auth-library makes a real network call inside verifyIdToken (to
// fetch Google's signing keys) — that's entirely google-auth-library's own
// responsibility to get right, not something this test suite should be
// exercising over the network. What THIS code owns is: passing the right
// audience, mapping a valid payload to our GoogleProfile shape, and
// failing closed (returning null, never throwing) for anything invalid —
// so that's what's mocked and tested here.
const verifyIdTokenMock = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: verifyIdTokenMock,
  })),
}));

describe('googleAuth', () => {
  const ORIGINAL_ENV = process.env.GOOGLE_CLIENT_ID;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    verifyIdTokenMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = ORIGINAL_ENV;
  });

  it('isGoogleSignInConfigured reflects whether GOOGLE_CLIENT_ID is set', async () => {
    const { isGoogleSignInConfigured } = await import('../src/auth/googleAuth.js');
    expect(isGoogleSignInConfigured()).toBe(true);
    delete process.env.GOOGLE_CLIENT_ID;
    expect(isGoogleSignInConfigured()).toBe(false);
  });

  it('maps a valid, verified token to a GoogleProfile', async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ sub: 'google-sub-123', email: 'alice@gmail.com', name: 'Alice' }),
    });
    const { verifyGoogleIdToken } = await import('../src/auth/googleAuth.js');
    const profile = await verifyGoogleIdToken('fake-token');
    expect(profile).toEqual({ googleId: 'google-sub-123', email: 'alice@gmail.com', displayName: 'Alice' });
  });

  it('falls back to the email local-part as displayName when Google gives no name', async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ sub: 'google-sub-456', email: 'bob@gmail.com' }),
    });
    const { verifyGoogleIdToken } = await import('../src/auth/googleAuth.js');
    const profile = await verifyGoogleIdToken('fake-token');
    expect(profile?.displayName).toBe('bob');
  });

  it('returns null (never throws) for a token whose signature/audience verification fails', async () => {
    verifyIdTokenMock.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));
    const { verifyGoogleIdToken } = await import('../src/auth/googleAuth.js');
    await expect(verifyGoogleIdToken('forged-token')).resolves.toBeNull();
  });

  it('returns null for a payload with no sub claim', async () => {
    verifyIdTokenMock.mockResolvedValue({ getPayload: () => ({ email: 'no-sub@gmail.com' }) });
    const { verifyGoogleIdToken } = await import('../src/auth/googleAuth.js');
    await expect(verifyGoogleIdToken('fake-token')).resolves.toBeNull();
  });

  it('passes our own GOOGLE_CLIENT_ID as the required audience — never someone else\'s', async () => {
    verifyIdTokenMock.mockResolvedValue({ getPayload: () => ({ sub: 's', email: null, name: 'X' }) });
    const { verifyGoogleIdToken } = await import('../src/auth/googleAuth.js');
    await verifyGoogleIdToken('fake-token');
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: 'fake-token', audience: 'test-client-id.apps.googleusercontent.com' });
  });
});

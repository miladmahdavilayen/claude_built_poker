import { OAuth2Client } from 'google-auth-library';

export interface GoogleProfile {
  googleId: string;
  email: string | null;
  displayName: string;
}

let client: OAuth2Client | null = null;
function getClient(clientId: string): OAuth2Client {
  client ??= new OAuth2Client(clientId);
  return client;
}

export function isGoogleSignInConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID;
}

/**
 * Verifies a Google "Sign In With Google" ID token (a JWT the browser gets
 * directly from Google's client-side library — see apps/web's
 * GoogleSignInButton) against Google's own signing keys, and checks the
 * `aud` claim matches our own client id so a token minted for some OTHER
 * app can't be replayed here. Returns null for anything invalid, expired,
 * or wrong-audience — this function never throws for a bad/malicious
 * token, only for genuine misconfiguration (missing GOOGLE_CLIENT_ID,
 * checked by the route via `isGoogleSignInConfigured` first).
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set.');
  try {
    const ticket = await getClient(clientId).verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub) return null;
    return {
      googleId: payload.sub,
      email: payload.email ?? null,
      displayName: payload.name ?? payload.email?.split('@')[0] ?? 'Player',
    };
  } catch {
    return null;
  }
}

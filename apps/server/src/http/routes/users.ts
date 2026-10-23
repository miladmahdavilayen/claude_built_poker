import { createHash, randomUUID } from 'node:crypto';
import { AcceptWaiverSchema, WAIVER_INTRO, WAIVER_TERMS, WAIVER_TITLE, WAIVER_VERSION } from '@pokerclause/shared';
import type { FastifyInstance } from 'fastify';
import { renderSignedWaiverPdf } from '../../reports/waiverPdf.js';
import { REFRESH_COOKIE_NAME } from '../../auth/session.js';
import type { Store } from '../../db/store.js';
import { requireAuth } from '../middleware.js';
import { normalizeEmailKey } from '../../auth/authService.js';
import { publicUser } from './auth.js';

/**
 * Self-service routes for a signed-in human's OWN account — what they
 * registered with, and deleting the account outright. Distinct from
 * admin.ts, which does the same kind of thing but for ANY user, gated to
 * the admin role instead of "this is your own session."
 */
export function registerUserRoutes(app: FastifyInstance, store: Store, closePracticeTableOf: (userId: string) => Promise<void>): void {
  app.get('/users/me/profile', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    return {
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      signInMethod: user.googleId ? 'google' : user.isGuest ? 'guest' : 'password',
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  });

  // The friendly-game waiver (see apps/web's Waiver page and
  // packages/shared's waiver.ts), agreed to with initials and a drawn
  // signature. Signing files a permanent copy (signed_waivers — no foreign
  // key, so it outlives the account): the PDF as signed, the signature, and
  // an authorization record with the PDF's SHA-256. Stored with the version
  // agreed to, so a reworded waiver (a WAIVER_VERSION bump) asks everyone
  // again. The body limit is raised for this one route — the signature
  // image is the only large thing any client ever sends.
  app.post('/users/me/waiver', { preHandler: requireAuth, bodyLimit: 512 * 1024 }, async (req, reply) => {
    const body = AcceptWaiverSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_WAIVER', message: 'Type your initials (letters only) and sign in the box.' });
    if (body.data.version !== WAIVER_VERSION) {
      return reply.code(409).send({ code: 'WAIVER_OUTDATED', message: 'The agreement was just updated — please reload the page and read it again.' });
    }
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.isGuest) return reply.code(400).send({ code: 'GUEST_ACCOUNT', message: 'Guests aren’t asked to agree to the waiver.' });

    const signaturePng = Buffer.from(body.data.signature.slice('data:image/png;base64,'.length), 'base64');
    // A real PNG, and not an empty canvas (a blank one compresses to well under this).
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!signaturePng.subarray(0, 8).equals(PNG_MAGIC) || signaturePng.length < 800) {
      return reply.code(400).send({ code: 'INVALID_SIGNATURE', message: 'Please sign in the box.' });
    }

    const id = randomUUID();
    const signedAt = new Date();
    const initials = body.data.initials.toUpperCase();
    const userAgent = (req.headers['user-agent'] ?? '').slice(0, 500) || null;
    const ipAddress = req.ip || null;
    const signatureSha256 = createHash('sha256').update(signaturePng).digest('hex');
    const pdf = await renderSignedWaiverPdf({
      id,
      version: WAIVER_VERSION,
      displayName: user.displayName,
      email: user.email,
      initials,
      signedAt,
      ipAddress,
      userAgent,
      device: body.data.device,
      signaturePng,
      signatureSha256,
    });
    const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
    // The authorization record: everything about the signing, plus the
    // fingerprints of the PDF and signature, so either being altered later
    // shows.
    const record = {
      documentId: id,
      document: `${WAIVER_TITLE} (version ${String(WAIVER_VERSION)})`,
      text: { intro: WAIVER_INTRO, terms: WAIVER_TERMS },
      signer: { userId: user.id, displayName: user.displayName, email: user.email, googleId: user.googleId },
      initials,
      signedAt: signedAt.toISOString(),
      ipAddress,
      userAgent,
      deviceReportedByBrowser: body.data.device,
      signatureSha256,
      pdfSha256,
      keptBy: 'The owner of PokerClause — permanently, including after the account is deleted.',
    };
    await store.saveSignedWaiver({
      id,
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      googleId: user.googleId,
      version: WAIVER_VERSION,
      initials,
      signedAt,
      ipAddress,
      userAgent,
      signaturePng: signaturePng.toString('base64'),
      pdf: pdf.toString('base64'),
      pdfSha256,
      record,
    });
    const updated = await store.acceptWaiver(user.id, WAIVER_VERSION, initials);
    return { user: publicUser(updated) };
  });

  // Guests already lose everything the moment they leave/reset/close a
  // table — there's nothing durable for them to delete here, and this
  // account IS the admin's own for exactly one user on the whole
  // deployment, whose loss would be far more disruptive than a normal
  // player's — so this is scoped to a signed-in, non-guest, non-admin
  // account only. Their practice table (if open) closes first, so its
  // stack is back in their balance — which is then kept (see schema.ts's
  // welcomeBonusClaims) and handed back if they register again: deleting
  // an account loses nothing but what was already lost at the tables, and
  // never earns a second welcome bonus. See DECISIONS.md.
  app.delete('/users/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = await store.findUserById(req.userId!);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.isGuest) return reply.code(400).send({ code: 'GUEST_ACCOUNT', message: 'Guest sessions have nothing to delete — just leave the table.' });
    if (user.role === 'admin') return reply.code(400).send({ code: 'CANNOT_DELETE_ADMIN', message: 'The admin account cannot be deleted this way.' });
    await closePracticeTableOf(user.id);
    if (user.googleId && user.email) {
      const refunded = await store.findUserById(user.id);
      await store.keepBalanceForReturn(normalizeEmailKey(user.email), user.googleId, refunded?.chips ?? user.chips);
    }
    await store.deleteUser(user.id);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}

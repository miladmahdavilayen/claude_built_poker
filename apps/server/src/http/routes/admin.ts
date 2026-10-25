import {
  AdminAdjustChipsSchema,
  AdminBulkDeleteUsersSchema,
  AdminSetChipsSchema,
  AdminUpdateUserSchema,
  CreateSignupKeySchema,
  formatMoney,
  MAX_BALANCE_CENTS,
  UpdateTableSettingsSchema,
  type UpdateTableSettingsIntent,
} from '@pokerclause/shared';
import { archiveAndDeleteUser } from '../../auth/accountDeletion.js';
import { normalizeEmailKey } from '../../auth/authService.js';
import { generateSignupKey, hashSignupKey, normalizeSignupKey } from '../../auth/signupKeys.js';
import type { GuestPlayerRecord, PlayerGameRecord, SignedWaiverSummary, SignupKeyRecord } from '../../db/store.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../../db/store.js';
import type { TableRegistry } from '../../game/tableRegistry.js';
import { requireAdmin } from '../middleware.js';

/** A signed waiver as listed under its player (the PDF and record are fetched separately, by id). */
function waiverDto(w: SignedWaiverSummary) {
  return {
    id: w.id,
    displayName: w.displayName,
    email: w.email,
    version: w.version,
    initials: w.initials,
    signedAt: w.signedAt.toISOString(),
    ipAddress: w.ipAddress,
    userAgent: w.userAgent,
    pdfSha256: w.pdfSha256,
  };
}

function gameDto(g: PlayerGameRecord) {
  return { ...g, startedAt: g.startedAt.toISOString(), endedAt: g.endedAt?.toISOString() ?? null };
}

/** A guest's record for the dashboard — never the hash of their browser's key. */
function guestDto(g: GuestPlayerRecord) {
  return {
    id: g.id,
    displayName: g.displayName,
    adminNickname: g.adminNickname,
    inviteKind: g.inviteKind,
    tableId: g.tableId,
    tableName: g.tableName,
    joinedAt: g.joinedAt.toISOString(),
    ipAddress: g.ipAddress,
    userAgent: g.userAgent,
    termsVersion: g.termsVersion,
    termsAcceptedAt: g.termsAcceptedAt.toISOString(),
  };
}

function keyDto(k: SignupKeyRecord) {
  return { id: k.id, hint: k.hint, label: k.label, email: k.email, createdAt: k.createdAt.toISOString(), expiresAt: k.expiresAt.toISOString(), usedAt: k.usedAt?.toISOString() ?? null };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  store: Store,
  registry: TableRegistry,
  closePracticeTableOf: (userId: string) => Promise<void>,
  terminateTable: (tableId: string) => Promise<boolean>,
  updateTableSettings: (tableId: string, patch: UpdateTableSettingsIntent) => { ok: true; deferred: boolean } | { ok: false; code: string; message: string } | null = () => null,
): void {
  app.get('/admin/tables', { preHandler: requireAdmin }, () => {
    return { tables: registry.list() };
  });

  app.get('/admin/users', { preHandler: requireAdmin }, async () => {
    const users = await store.listUsers();
    return {
      users: users.map((u) => ({
        accessKeyLabel: u.accessKeyLabel,
        id: u.id,
        displayName: u.displayName,
        email: u.email,
        isGuest: u.isGuest,
        role: u.role,
        chips: u.chips,
        hasGoogle: u.googleId !== null,
        createdAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        waiver: u.waiver ? { version: u.waiver.version, initials: u.waiver.initials, acceptedAt: u.waiver.acceptedAt.toISOString() } : null,
      })),
    };
  });

  /**
   * Full detail for one user — everything the list above has, plus their
   * net play result, recent ledger history, the access key they registered
   * with, every agreement they signed, and every game they played: the
   * dashboard's per-player view.
   */
  app.get('/admin/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const user = await store.findUserById(userId);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    const [netPlayResult, recentEntries, keys, waivers, games] = await Promise.all([
      store.ledgerPlayNetForUser(user.id),
      store.ledgerEntriesForUser(user.id, 50),
      store.listSignupKeys(),
      store.listSignedWaivers(),
      store.gameHistoryForUser(user.id),
    ]);
    const key = keys.find((k) => k.usedBy === user.id);
    return {
      accessKeyLabel: user.accessKeyLabel,
      accessKey: key ? keyDto(key) : null,
      signedWaivers: waivers.filter((w) => w.userId === user.id).map(waiverDto),
      games: games.map(gameDto),
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      isGuest: user.isGuest,
      role: user.role,
      chips: user.chips,
      hasGoogle: user.googleId !== null,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      waiver: user.waiver ? { version: user.waiver.version, initials: user.waiver.initials, acceptedAt: user.waiver.acceptedAt.toISOString() } : null,
      netPlayResult,
      recentEntries: recentEntries.map((e) => ({
        id: e.id,
        amount: e.amount,
        reason: e.reason,
        tableId: e.tableId,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  /** Currently just the display name — chip changes go through /admin/chips instead (a delta + reason, always ledgered, never a raw overwrite). */
  app.patch('/admin/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = AdminUpdateUserSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid payload.' });
    try {
      const updated = await store.updateDisplayName(userId, body.data.displayName);
      return { id: updated.id, displayName: updated.displayName };
    } catch {
      return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    }
  });

  /** Admin deleting another user's account — never the admin's own (use a different admin account for that, or the /users/me self-service route doesn't apply to admins either). */
  app.delete('/admin/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const user = await store.findUserById(userId);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (user.role === 'admin') return reply.code(400).send({ code: 'CANNOT_DELETE_ADMIN', message: 'The admin account cannot be deleted.' });
    await closePracticeTableOf(userId);
    await archiveAndDeleteUser(store, (await store.findUserById(userId)) ?? user, 'admin');
    return { ok: true };
  });

  /** Multi-select delete from the dashboard — the admin's own account (or any id that turns out not to exist) is silently skipped rather than failing the whole batch, so selecting-all-and-deleting never has to special-case the one row that can't go. */
  app.post('/admin/users/bulk-delete', { preHandler: requireAdmin }, async (req, reply) => {
    const body = AdminBulkDeleteUsersSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid payload.' });
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const userId of body.data.userIds) {
      const user = await store.findUserById(userId);
      if (!user || user.role === 'admin') {
        skipped.push(userId);
        continue;
      }
      await closePracticeTableOf(userId);
      await archiveAndDeleteUser(store, (await store.findUserById(userId)) ?? user, 'admin');
      deleted.push(userId);
    }
    return { ok: true, deleted, skipped };
  });

  /** Moves a balance by `delta` (ledgered against the house), refusing to leave it negative or above MAX_BALANCE_CENTS. */
  async function changeBalance(userId: string, delta: number): Promise<{ ok: true; chips: number } | { ok: false; status: number; code: string; message: string }> {
    const user = await store.findUserById(userId);
    if (!user) return { ok: false, status: 404, code: 'USER_NOT_FOUND', message: 'User not found.' };
    const next = user.chips + delta;
    if (next < 0 || next > MAX_BALANCE_CENTS) {
      return { ok: false, status: 400, code: 'BALANCE_OUT_OF_RANGE', message: `A balance must stay between $0 and ${formatMoney(MAX_BALANCE_CENTS)}.` };
    }
    if (delta === 0) return { ok: true, chips: user.chips };
    const updated = await store.adjustUserChips(userId, delta);
    await store.recordLedgerEntries([
      { userId, isHouse: false, amount: delta, reason: 'admin_adjust' },
      { userId: null, isHouse: true, amount: -delta, reason: 'admin_adjust' },
    ]);
    return { ok: true, chips: updated.chips };
  }

  app.post('/admin/chips', { preHandler: requireAdmin }, async (req, reply) => {
    const body = AdminAdjustChipsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid payload.' });
    const { userId, amount, reason } = body.data;
    const result = await changeBalance(userId, amount);
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message });
    return { ok: true, reason, chips: result.chips };
  });

  /** Sets a balance to an exact amount — the owner's "set my balance to $X". Ledgered as the difference, like any other adjustment. */
  app.post('/admin/chips/set', { preHandler: requireAdmin }, async (req, reply) => {
    const body = AdminSetChipsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: `Enter an amount between $0 and ${formatMoney(MAX_BALANCE_CENTS)}.` });
    const { userId, balance, reason } = body.data;
    const user = await store.findUserById(userId);
    if (!user) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    const result = await changeBalance(userId, balance - user.chips);
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message });
    return { ok: true, reason, chips: result.chips };
  });

  // Deleting a table from the lobby (swipe left) is terminating it: everyone
  // seated is cashed out and told, spectators are sent to the lobby, the
  // game's books close, and it stays gone — including after a restart (it's
  // marked closed, and index.ts only restores open tables).
  const terminate = async (req: FastifyRequest, reply: FastifyReply): Promise<{ ok: true } | FastifyReply> => {
    const { tableId } = req.params as { tableId: string };
    if (!(await terminateTable(tableId))) return reply.code(404).send({ code: 'TABLE_NOT_FOUND', message: 'Table not found.' });
    return { ok: true };
  };
  app.delete('/admin/tables/:tableId', { preHandler: requireAdmin }, terminate);

  // The lobby's "hold a table" settings editor — the same settings and rules
  // as the owner menu at the table (LiveTable.updateSettings), for any of
  // the owner's tables, public or private, without sitting down at it.
  app.get('/admin/tables/:tableId/settings', { preHandler: requireAdmin }, (req, reply) => {
    const { tableId } = req.params as { tableId: string };
    const table = registry.get(tableId);
    if (!table || table.isPractice) return reply.code(404).send({ code: 'TABLE_NOT_FOUND', message: 'Table not found.' });
    // Where the table is heading: anything queued for the next hand included.
    // A private table's invite code comes too, so the lobby can show its link.
    return { tableId, name: table.name, settings: table.targetSettings, inHand: table.handInProgress, inviteCode: table.settings.isPrivate ? table.inviteCode : null };
  });
  app.patch('/admin/tables/:tableId/settings', { preHandler: requireAdmin }, (req, reply) => {
    const { tableId } = req.params as { tableId: string };
    const body = UpdateTableSettingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Invalid table settings.' });
    const result = updateTableSettings(tableId, body.data);
    if (!result) return reply.code(404).send({ code: 'TABLE_NOT_FOUND', message: 'Table not found.' });
    if (!result.ok) return reply.code(400).send({ code: result.code, message: result.message });
    const table = registry.get(tableId)!;
    return {
      ok: true,
      deferred: result.deferred,
      name: table.name,
      settings: table.targetSettings,
      inviteCode: table.settings.isPrivate ? table.inviteCode : null,
    };
  });
  app.post('/admin/tables/:tableId/close', { preHandler: requireAdmin }, terminate);

  // --- Access keys: one per new player (see auth/signupKeys.ts). ---

  function keyStatus(k: SignupKeyRecord): 'active' | 'revoked' | 'expired' {
    if (k.revokedAt) return 'revoked';
    return k.expiresAt.getTime() <= Date.now() ? 'expired' : 'active';
  }

  // Keys not yet used — active, expired or revoked. A used key lives on
  // under the player it registered (see GET /admin/users/:userId, and the
  // deleted account's record if they've since deleted it).
  app.get('/admin/signup-keys', { preHandler: requireAdmin }, async () => {
    const keys = await store.listSignupKeys();
    return {
      keys: keys
        .filter((k) => !k.usedAt)
        .map((k) => ({
          id: k.id,
          hint: k.hint,
          label: k.label,
          email: k.email,
          status: keyStatus(k),
          createdAt: k.createdAt.toISOString(),
          expiresAt: k.expiresAt.toISOString(),
        })),
    };
  });

  /** The key itself is returned here, once — only its hash is stored, so it can't be shown again. */
  app.post('/admin/signup-keys', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateSignupKeySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'Give the key a name (who it’s for) and, optionally, their Google email.' });
    const key = generateSignupKey();
    const normalized = normalizeSignupKey(key)!;
    const record = await store.createSignupKey({
      keyHash: hashSignupKey(normalized),
      hint: normalized.slice(-4),
      label: body.data.label,
      email: body.data.email?.toLowerCase() ?? null,
      emailKey: body.data.email ? normalizeEmailKey(body.data.email) : null,
      createdBy: req.userId!,
      expiresAt: new Date(Date.now() + body.data.expiresInDays * 24 * 60 * 60 * 1000),
    });
    reply.code(201);
    return { key, id: record.id, expiresAt: record.expiresAt.toISOString() };
  });

  app.delete('/admin/signup-keys/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await store.revokeSignupKey(id))) return reply.code(404).send({ code: 'KEY_NOT_ACTIVE', message: 'That key was already used or revoked.' });
    return { ok: true };
  });

  // --- Guests: everyone who joined a table by an owner's invite, with
  // their acceptance of the guest terms — kept for good. ---

  app.get('/admin/guests', { preHandler: requireAdmin }, async () => {
    const guests = await store.listGuestPlayers();
    return { guests: guests.map(guestDto) };
  });

  app.get('/admin/guests/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const guest = await store.getGuestPlayer(id);
    if (!guest) return reply.code(404).send({ code: 'GUEST_NOT_FOUND', message: 'Guest not found.' });
    const games = await store.gameHistoryForUser(guest.id);
    return { ...guestDto(guest), games: games.map(gameDto) };
  });

  // --- Deleted accounts: everything about a registered player's account
  // as it was when it was deleted, for the owner only. ---

  app.get('/admin/deleted-users', { preHandler: requireAdmin }, async () => {
    const deleted = await store.listDeletedUsers();
    return {
      users: deleted.map((d) => ({
        id: d.id,
        displayName: d.displayName,
        email: d.email,
        accessKeyLabel: d.accessKeyLabel,
        balance: d.balance,
        createdAt: d.createdAt.toISOString(),
        deletedAt: d.deletedAt.toISOString(),
        deletedBy: d.deletedBy,
      })),
    };
  });

  app.get('/admin/deleted-users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = await store.getDeletedUser(id);
    if (!d) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: 'Deleted account not found.' });
    const [waivers, games] = await Promise.all([store.listSignedWaivers(), store.gameHistoryForUser(d.id)]);
    return {
      id: d.id,
      displayName: d.displayName,
      email: d.email,
      hasGoogle: d.googleId !== null,
      accessKeyLabel: d.accessKeyLabel,
      role: d.role,
      balance: d.balance,
      netPlayResult: d.netPlayResult,
      createdAt: d.createdAt.toISOString(),
      lastLoginAt: d.lastLoginAt?.toISOString() ?? null,
      deletedAt: d.deletedAt.toISOString(),
      deletedBy: d.deletedBy,
      avatarUrl: d.snapshot.avatarUrl,
      waiver: d.snapshot.waiver,
      accessKey: d.snapshot.accessKey,
      ledger: d.snapshot.ledger,
      signedWaivers: waivers.filter((w) => w.userId === d.id).map(waiverDto),
      games: games.map(gameDto),
    };
  });

  // --- A signed waiver's files (listed under its player above): every one
  // ever signed is kept forever, even after the account is deleted. ---

  /** The signed PDF — inline to view in the browser, or `?download=1` to save it. */
  app.get('/admin/waivers/:id/pdf', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const waiver = await store.getSignedWaiver(id);
    if (!waiver) return reply.code(404).send({ code: 'WAIVER_NOT_FOUND', message: 'Signed waiver not found.' });
    const download = (req.query as { download?: string }).download === '1';
    const name = `waiver-${waiver.displayName.replace(/[^A-Za-z0-9]+/g, '-')}-${waiver.signedAt.toISOString().slice(0, 10)}.pdf`;
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`)
      .send(Buffer.from(waiver.pdf, 'base64'));
  });

  /** The authorization record (JSON), with the PDF's and signature's SHA-256 — always a download. */
  app.get('/admin/waivers/:id/record', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const waiver = await store.getSignedWaiver(id);
    if (!waiver) return reply.code(404).send({ code: 'WAIVER_NOT_FOUND', message: 'Signed waiver not found.' });
    const name = `waiver-${waiver.displayName.replace(/[^A-Za-z0-9]+/g, '-')}-${waiver.signedAt.toISOString().slice(0, 10)}-record.json`;
    return reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(JSON.stringify(waiver.record, null, 2));
  });

  app.get('/admin/ledger/conservation', { preHandler: requireAdmin }, async () => {
    return store.ledgerConservationCheck();
  });
}

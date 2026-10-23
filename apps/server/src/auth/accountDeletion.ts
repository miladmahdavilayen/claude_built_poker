import type { DeletedUserSnapshot, Store, UserRecord } from '../db/store.js';

/** More than any real account's history — the whole ledger is kept, not a recent page of it. */
const ALL_LEDGER_ENTRIES = 1_000_000;

/**
 * Deletes a registered player's account — after filing everything about it
 * as it stands (see DeletedUserRecord): the balance, the access key they
 * registered with and the name the owner gave it, their waiver, and their
 * whole ledger history (whose rows lose their user id with the account).
 * Their signed waivers and game history stay where they are, found by the
 * same id. For the owner's eyes only, in the dashboard's "Deleted users";
 * it never stops the same person registering again, and the welcome-bonus
 * and kept-balance rules (welcomeBonusClaims) are untouched by it.
 *
 * `user` should be freshly read — after any practice table is closed, so
 * the balance filed is the one they actually left with.
 */
export async function archiveAndDeleteUser(store: Store, user: UserRecord, deletedBy: 'self' | 'admin'): Promise<void> {
  const [netPlayResult, ledger, keys] = await Promise.all([
    store.ledgerPlayNetForUser(user.id),
    store.ledgerEntriesForUser(user.id, ALL_LEDGER_ENTRIES),
    store.listSignupKeys(),
  ]);
  const key = keys.find((k) => k.usedBy === user.id) ?? null;
  const snapshot: DeletedUserSnapshot = {
    avatarUrl: user.avatarUrl,
    waiver: user.waiver ? { version: user.waiver.version, initials: user.waiver.initials, acceptedAt: user.waiver.acceptedAt.toISOString() } : null,
    accessKey: key
      ? { id: key.id, hint: key.hint, label: key.label, email: key.email, createdAt: key.createdAt.toISOString(), usedAt: key.usedAt?.toISOString() ?? null }
      : null,
    ledger: ledger.map((e) => ({ id: e.id, amount: e.amount, reason: e.reason, tableId: e.tableId, handId: e.handId, createdAt: e.createdAt.toISOString() })),
  };
  await store.archiveDeletedUser({
    id: user.id,
    email: user.email,
    googleId: user.googleId,
    displayName: user.displayName,
    accessKeyLabel: user.accessKeyLabel ?? key?.label ?? null,
    role: user.role,
    balance: user.chips,
    netPlayResult,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    deletedAt: new Date(),
    deletedBy,
    snapshot,
  });
  await store.deleteUser(user.id);
}

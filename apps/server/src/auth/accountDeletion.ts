import type { DeletedUserSnapshot, GuestPlayerRecord, Store, UserRecord } from '../db/store.js';

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
  // Any chips kept for them at tables they were invited to (see socketServer.ts's usesTableMoney).
  await store.deleteGuestPlayer(user.id);
}

/**
 * Deletes a guest the same way: out of the owner's Players, filed whole under
 * Deleted users — the invite they came by and their agreement to the guest
 * terms included, which the terms promise is kept. Their game history stays,
 * found by the same id; the chips they left at tables are gone. A used seat
 * invite still brings them back, as a guest on the list again.
 */
export async function archiveAndDeleteGuest(store: Store, guest: GuestPlayerRecord): Promise<void> {
  const live = await store.findUserById(guest.id);
  await store.archiveDeletedUser({
    id: guest.id,
    email: null,
    googleId: null,
    displayName: guest.displayName,
    accessKeyLabel: guest.adminNickname,
    role: 'player',
    balance: 0,
    netPlayResult: 0,
    createdAt: guest.joinedAt,
    lastLoginAt: null,
    deletedAt: new Date(),
    deletedBy: 'admin',
    snapshot: {
      avatarUrl: null,
      waiver: null,
      accessKey: null,
      guest: {
        adminNickname: guest.adminNickname,
        inviteKind: guest.inviteKind,
        tableName: guest.tableName,
        joinedAt: guest.joinedAt.toISOString(),
        ipAddress: guest.ipAddress,
        userAgent: guest.userAgent,
        termsVersion: guest.termsVersion,
        termsAcceptedAt: guest.termsAcceptedAt.toISOString(),
      },
      ledger: [],
    },
  });
  await store.deleteGuestPlayer(guest.id);
  if (live) await store.deleteUser(guest.id);
}

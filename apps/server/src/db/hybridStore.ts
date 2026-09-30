import { MemoryStore } from './memoryStore.js';
import type {
  ChatMessageRecord,
  HandRecordForVerification,
  LedgerEntryInput,
  LedgerEntryRecord,
  RecordHandInput,
  Store,
  TableRecord,
  UserRecord,
} from './store.js';

/**
 * Wraps a `real` store (DrizzleStore against Postgres, or MemoryStore for
 * local dev without one) so that a GUEST'S data never reaches it at all —
 * a guest's user row, session, and any ledger/hand-seat/chat rows they're
 * party to live only in this process's memory, for exactly as long as
 * their table lasts. Only a signed-in (Google) account is ever persisted.
 * See DECISIONS.md.
 *
 * The internal `guestStore` is a plain `MemoryStore` — it already
 * implements every guest-relevant operation correctly (creation,
 * sessions, chip balance, rename, delete), so this reuses it wholesale
 * instead of duplicating that logic, and only adds the routing/
 * anonymization decisions a guest-aware boundary actually needs on top.
 */
export class HybridStore implements Store {
  private readonly guestStore = new MemoryStore();

  constructor(private readonly real: Store) {}

  private async isGuestId(userId: string): Promise<boolean> {
    return (await this.guestStore.findUserById(userId)) !== null;
  }

  // --- Creation ---

  createGuestUser(displayName: string): Promise<UserRecord> {
    return this.guestStore.createGuestUser(displayName);
  }

  createAccount(email: string, passwordHash: string, displayName: string): Promise<UserRecord> {
    return this.real.createAccount(email, passwordHash, displayName);
  }

  createGoogleAccount(googleId: string, email: string | null, displayName: string): Promise<UserRecord> {
    return this.real.createGoogleAccount(googleId, email, displayName);
  }

  createGoogleAccountFromGuest(input: {
    id: string;
    googleId: string;
    email: string | null;
    displayName: string;
    chips: number;
    avatarSeed: string;
    clientSeed: string;
  }): Promise<UserRecord> {
    return this.real.createGoogleAccountFromGuest(input);
  }

  /** The guest→Google upgrade: migrates the guest's CURRENT (in-memory) identity into the real store at the same id, then discards the ephemeral record — it's genuinely persisted for the first time here, not "converted in place" the way the old single-store design worked. */
  async linkGoogleToGuest(userId: string, googleId: string, email: string | null): Promise<UserRecord> {
    const guest = await this.guestStore.findUserById(userId);
    if (!guest) throw new Error('USER_NOT_FOUND');
    const promoted = await this.real.createGoogleAccountFromGuest({
      id: guest.id,
      googleId,
      email,
      displayName: guest.displayName,
      chips: guest.chips,
      avatarSeed: guest.avatarSeed,
      clientSeed: guest.clientSeed,
    });
    await this.guestStore.deleteUser(userId);
    return promoted;
  }

  // --- Lookups ---

  async findUserById(id: string): Promise<UserRecord | null> {
    const guest = await this.guestStore.findUserById(id);
    if (guest) return guest;
    return this.real.findUserById(id);
  }

  findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.real.findUserByEmail(email); // guest signup never collects an email
  }

  findUserByGoogleId(googleId: string): Promise<UserRecord | null> {
    return this.real.findUserByGoogleId(googleId); // guests never have one
  }

  // --- Mutations that could target either store ---

  async adjustUserChips(userId: string, delta: number): Promise<UserRecord> {
    if (await this.isGuestId(userId)) return this.guestStore.adjustUserChips(userId, delta);
    return this.real.adjustUserChips(userId, delta);
  }

  setUserRole(userId: string, role: 'player' | 'admin'): Promise<void> {
    return this.real.setUserRole(userId, role); // never called for a guest
  }

  async updateDisplayName(userId: string, displayName: string): Promise<UserRecord> {
    if (await this.isGuestId(userId)) return this.guestStore.updateDisplayName(userId, displayName);
    return this.real.updateDisplayName(userId, displayName);
  }

  updatePasswordHash(userId: string, passwordHash: string): Promise<UserRecord> {
    return this.real.updatePasswordHash(userId, passwordHash); // admin-only, never a guest
  }

  /** Real (persisted) accounts only — a guest was never inserted here, so this naturally already excludes them; nothing to filter. */
  listUsers(): Promise<UserRecord[]> {
    return this.real.listUsers();
  }

  async deleteUser(userId: string): Promise<void> {
    if (await this.isGuestId(userId)) return this.guestStore.deleteUser(userId);
    return this.real.deleteUser(userId);
  }

  // --- Sessions ---

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    if (await this.isGuestId(userId)) return this.guestStore.createSession(userId, tokenHash, expiresAt);
    return this.real.createSession(userId, tokenHash, expiresAt);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null> {
    const guestSession = await this.guestStore.findSessionByTokenHash(tokenHash);
    if (guestSession) return guestSession;
    return this.real.findSessionByTokenHash(tokenHash);
  }

  async touchSession(tokenHash: string): Promise<void> {
    // Best-effort on both — the caller has no way to know in advance which
    // store actually holds this hash, and touching a hash neither store
    // recognizes is already a silent no-op on either implementation.
    await this.guestStore.touchSession(tokenHash);
    await this.real.touchSession(tokenHash);
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.guestStore.revokeSession(tokenHash);
    await this.real.revokeSession(tokenHash);
  }

  // --- Ledger: a guest's own entries are anonymized (userId: null),
  // never omitted — omitting them would break the OTHER (real) parties'
  // zero-sum conservation for a hand a guest also played in. Anonymous is
  // indistinguishable from the house's own existing null-userId rows, so
  // no guest identity is ever actually stored. ---

  private async anonymizeGuestUserId(userId: string | null): Promise<string | null> {
    if (userId === null) return null;
    return (await this.isGuestId(userId)) ? null : userId;
  }

  async recordLedgerEntries(entries: readonly LedgerEntryInput[]): Promise<void> {
    const resolved = await Promise.all(
      entries.map(async (e) => ({ ...e, userId: await this.anonymizeGuestUserId(e.userId) })),
    );
    return this.real.recordLedgerEntries(resolved);
  }

  async ledgerBalanceForUser(userId: string): Promise<number> {
    // A guest's ledger entries are never attributed to them in the real
    // store (see recordLedgerEntries above), so their live chip balance —
    // tracked directly on their in-memory record, not ledger-derived — is
    // the only meaningful answer here.
    const guest = await this.guestStore.findUserById(userId);
    if (guest) return guest.chips;
    return this.real.ledgerBalanceForUser(userId);
  }

  ledgerConservationCheck(): Promise<{ balanced: boolean; totalDelta: number }> {
    return this.real.ledgerConservationCheck(); // every persisted group still sums to zero regardless of anonymization
  }

  async ledgerEntriesForUser(userId: string, limit: number): Promise<LedgerEntryRecord[]> {
    if (await this.isGuestId(userId)) return []; // nothing is stored under their identity to return
    return this.real.ledgerEntriesForUser(userId, limit);
  }

  async ledgerPlayNetForUser(userId: string): Promise<number> {
    if (await this.isGuestId(userId)) return 0;
    return this.real.ledgerPlayNetForUser(userId);
  }

  // --- Tables: never keyed by a guest's identity (a guest can't create one) ---

  createTable(input: { name: string; config: Record<string, unknown>; inviteCode: string | null; createdBy: string | null }): Promise<TableRecord> {
    return this.real.createTable(input);
  }

  listTables(): Promise<TableRecord[]> {
    return this.real.listTables();
  }

  getTable(id: string): Promise<TableRecord | null> {
    return this.real.getTable(id);
  }

  closeTable(id: string): Promise<void> {
    return this.real.closeTable(id);
  }

  // --- Hands: anonymize any guest seat the same way ledger entries are ---

  async recordHand(input: RecordHandInput): Promise<void> {
    const seats = await Promise.all(
      input.seats.map(async (s) => ({ ...s, userId: await this.anonymizeGuestUserId(s.userId) })),
    );
    return this.real.recordHand({ ...input, seats });
  }

  getHandForVerification(handId: string): Promise<HandRecordForVerification | null> {
    return this.real.getHandForVerification(handId);
  }

  // --- Chat: persisted anonymized for a guest, but the return value is
  // enriched with their CURRENT live name so their own just-sent message
  // still shows correctly in the immediate broadcast — only a later
  // re-fetch of history shows it anonymized, same as any other message
  // from someone no longer in `users` (see schema.ts's onDelete: set null
  // on chatMessages.userId, which this exact shape already relied on). ---

  async recordChatMessage(tableId: string, userId: string | null, message: string): Promise<ChatMessageRecord> {
    if (userId === null) return this.real.recordChatMessage(tableId, null, message);
    const guest = await this.guestStore.findUserById(userId);
    if (!guest) return this.real.recordChatMessage(tableId, userId, message);
    const persisted = await this.real.recordChatMessage(tableId, null, message);
    return { ...persisted, userId, displayName: guest.displayName };
  }

  listRecentChat(tableId: string, limit: number): Promise<ChatMessageRecord[]> {
    return this.real.listRecentChat(tableId, limit);
  }
}

import { randomUUID } from 'node:crypto';
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
  GameReportRecord,
  GoogleAccountInput,
  SignedWaiverRecord,
  SignedWaiverSummary,
  SignupKeyRecord,
  GuestPlayerRecord,
  SeatInviteRecord,
  DeletedUserRecord,
  PlayerGameRecord,
} from './store.js';

/**
 * Wraps a `real` store (DrizzleStore against Postgres, or MemoryStore for
 * local dev without one) so that a GUEST'S data never reaches it at all —
 * a guest's user row, session, and any ledger/hand-seat/chat rows they're
 * party to live only in this process's memory, for exactly as long as
 * their table lasts. Only a signed-in (Google) account is ever persisted
 * as an account; a guest who joined by an invite is kept only as a record
 * (who they said they were, the invite, their acceptance of the guest
 * terms — see recordGuestPlayer). See DECISIONS.md.
 *
 * The internal `guestStore` is a plain `MemoryStore` — it already
 * implements every guest-relevant operation correctly (creation,
 * sessions, chip balance, rename, delete), so this reuses it wholesale
 * instead of duplicating that logic, and only adds the routing/
 * anonymization decisions a guest-aware boundary actually needs on top.
 */
export class HybridStore implements Store {
  private readonly guestStore = new MemoryStore();
  /**
   * Practice tables (see game/practiceTables.ts) — the table row, its
   * hands, chat and game reports — live only here, never in `real`, and
   * `deleteTable` wipes them. A practice table's id stays in
   * `purgedTables` after that, so a write still in flight when it closed
   * (a game report, a hand) is dropped instead of landing anywhere.
   */
  private readonly practiceStore = new MemoryStore();
  private readonly practiceTables = new Set<string>();
  private readonly purgedTables = new Set<string>();

  constructor(private readonly real: Store) {}

  private async isGuestId(userId: string): Promise<boolean> {
    return (await this.guestStore.findUserById(userId)) !== null;
  }

  // --- Creation ---

  createGuestUser(displayName: string, id?: string): Promise<UserRecord> {
    return this.guestStore.createGuestUser(displayName, id);
  }

  createAccount(email: string, passwordHash: string, displayName: string): Promise<UserRecord> {
    return this.real.createAccount(email, passwordHash, displayName);
  }

  createGoogleAccount(input: GoogleAccountInput): Promise<UserRecord> {
    return this.real.createGoogleAccount(input);
  }

  recordGoogleLogin(userId: string, avatarUrl: string | null): Promise<UserRecord> {
    return this.real.recordGoogleLogin(userId, avatarUrl); // guests never sign in with Google
  }

  // --- Access keys: owner-only, always persisted ---

  createSignupKey(input: { keyHash: string; hint: string; label: string; email: string | null; emailKey: string | null; createdBy: string; expiresAt: Date }): Promise<SignupKeyRecord> {
    return this.real.createSignupKey(input);
  }

  listSignupKeys(): Promise<SignupKeyRecord[]> {
    return this.real.listSignupKeys();
  }

  findUsableSignupKey(keyHash: string): Promise<SignupKeyRecord | null> {
    return this.real.findUsableSignupKey(keyHash);
  }

  consumeSignupKey(keyHash: string, emailKey: string): Promise<string | null> {
    return this.real.consumeSignupKey(keyHash, emailKey);
  }

  attachSignupKeyUser(id: string, userId: string): Promise<void> {
    return this.real.attachSignupKeyUser(id, userId);
  }

  revokeSignupKey(id: string): Promise<boolean> {
    return this.real.revokeSignupKey(id);
  }

  // --- Signed waivers: always persisted, kept forever ---

  saveSignedWaiver(waiver: SignedWaiverRecord): Promise<void> {
    return this.real.saveSignedWaiver(waiver);
  }

  listSignedWaivers(): Promise<SignedWaiverSummary[]> {
    return this.real.listSignedWaivers();
  }

  getSignedWaiver(id: string): Promise<SignedWaiverRecord | null> {
    return this.real.getSignedWaiver(id);
  }

  // --- Guest records and deleted accounts: always persisted, kept for good.
  // A guest's session stays in memory (guestStore); this is the record of them. ---

  // A practice table never has seat invites; every real table's are persisted.
  saveSeatInvite(invite: SeatInviteRecord): Promise<void> {
    return this.real.saveSeatInvite(invite);
  }

  listSeatInvites(tableId: string): Promise<SeatInviteRecord[]> {
    return this.real.listSeatInvites(tableId);
  }

  deleteSeatInvite(tokenHash: string): Promise<void> {
    return this.real.deleteSeatInvite(tokenHash);
  }

  recordGuestPlayer(guest: GuestPlayerRecord): Promise<void> {
    return this.real.recordGuestPlayer(guest);
  }

  listGuestPlayers(): Promise<GuestPlayerRecord[]> {
    return this.real.listGuestPlayers();
  }

  getGuestPlayer(id: string): Promise<GuestPlayerRecord | null> {
    return this.real.getGuestPlayer(id);
  }

  archiveDeletedUser(record: DeletedUserRecord): Promise<void> {
    return this.real.archiveDeletedUser(record);
  }

  listDeletedUsers(): Promise<DeletedUserRecord[]> {
    return this.real.listDeletedUsers();
  }

  getDeletedUser(id: string): Promise<DeletedUserRecord | null> {
    return this.real.getDeletedUser(id);
  }

  gameHistoryForUser(userId: string): Promise<PlayerGameRecord[]> {
    return this.real.gameHistoryForUser(userId);
  }

  acceptWaiver(userId: string, version: number, initials: string): Promise<UserRecord> {
    return this.real.acceptWaiver(userId, version, initials); // only Google players are asked
  }

  claimStartingBalance(emailKey: string, googleId: string, welcomeBonus: number): Promise<{ reason: 'welcome_bonus' | 'balance_restored'; amount: number }> {
    return this.real.claimStartingBalance(emailKey, googleId, welcomeBonus);
  }

  keepBalanceForReturn(emailKey: string, googleId: string, balance: number): Promise<void> {
    return this.real.keepBalanceForReturn(emailKey, googleId, balance); // only Google accounts, never a guest
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

  getSetting(key: string): Promise<string | null> {
    return this.real.getSetting(key);
  }

  setSetting(key: string, value: string): Promise<void> {
    return this.real.setSetting(key, value);
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
    // A practice table's buy-ins, cash-outs and hand results still move a
    // real player's balance, so they're ledgered like any other — just
    // without the table/hand ids, which point at records that are never
    // persisted (see practiceTables above).
    const resolved = await Promise.all(
      entries.map(async (e) => {
        const entry = { ...e, userId: await this.anonymizeGuestUserId(e.userId) };
        if (e.tableId && this.isPracticeOrPurged(e.tableId)) {
          delete entry.tableId;
          delete entry.handId;
        }
        return entry;
      }),
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

  // --- Tables: never keyed by a guest's identity (a guest can't create
  // one). A practice table lives in `practiceStore` instead of `real`. ---

  private isPracticeOrPurged(tableId: string): boolean {
    return this.practiceTables.has(tableId) || this.purgedTables.has(tableId);
  }

  async createTable(input: { name: string; config: Record<string, unknown>; inviteCode: string | null; createdBy: string | null; ephemeral?: boolean }): Promise<TableRecord> {
    if (!input.ephemeral) return this.real.createTable(input);
    const record = await this.practiceStore.createTable(input);
    this.practiceTables.add(record.id);
    return record;
  }

  listTables(): Promise<TableRecord[]> {
    return this.real.listTables();
  }

  getTable(id: string): Promise<TableRecord | null> {
    if (this.practiceTables.has(id)) return this.practiceStore.getTable(id);
    if (this.purgedTables.has(id)) return Promise.resolve(null);
    return this.real.getTable(id);
  }

  closeTable(id: string): Promise<void> {
    if (this.practiceTables.has(id)) return this.practiceStore.closeTable(id);
    if (this.purgedTables.has(id)) return Promise.resolve();
    return this.real.closeTable(id);
  }

  async deleteTable(id: string): Promise<void> {
    if (!this.isPracticeOrPurged(id)) return this.real.deleteTable(id);
    await this.practiceStore.deleteTable(id);
    this.practiceTables.delete(id);
    this.purgedTables.add(id);
  }

  updateTable(id: string, patch: { name: string; config: Record<string, unknown>; inviteCode: string | null }): Promise<void> {
    if (this.practiceTables.has(id)) return this.practiceStore.updateTable(id, patch);
    if (this.purgedTables.has(id)) return Promise.resolve();
    return this.real.updateTable(id, patch);
  }

  // --- Game reports: kept in the real store, except a practice table's.
  // Guests appear in them by display name only (no account row, no id) —
  // see DECISIONS.md. ---

  saveGameReport(record: GameReportRecord): Promise<void> {
    if (this.practiceTables.has(record.tableId)) return this.practiceStore.saveGameReport(record);
    if (this.purgedTables.has(record.tableId)) return Promise.resolve();
    return this.real.saveGameReport(record);
  }

  listGameReports(): Promise<Omit<GameReportRecord, 'reportYaml'>[]> {
    return this.real.listGameReports();
  }

  async getGameReport(id: string): Promise<GameReportRecord | null> {
    return (await this.practiceStore.getGameReport(id)) ?? this.real.getGameReport(id);
  }

  latestGameReportForTable(tableId: string): Promise<GameReportRecord | null> {
    if (this.practiceTables.has(tableId)) return this.practiceStore.latestGameReportForTable(tableId);
    if (this.purgedTables.has(tableId)) return Promise.resolve(null);
    return this.real.latestGameReportForTable(tableId);
  }

  // --- Hands: anonymize any guest seat the same way ledger entries are ---

  async recordHand(input: RecordHandInput): Promise<void> {
    if (this.practiceTables.has(input.tableId)) return this.practiceStore.recordHand(input);
    if (this.purgedTables.has(input.tableId)) return;
    const seats = await Promise.all(
      input.seats.map(async (s) => ({ ...s, userId: await this.anonymizeGuestUserId(s.userId) })),
    );
    return this.real.recordHand({ ...input, seats });
  }

  async getHandForVerification(handId: string): Promise<HandRecordForVerification | null> {
    return (await this.practiceStore.getHandForVerification(handId)) ?? this.real.getHandForVerification(handId);
  }

  // --- Chat: persisted anonymized for a guest, but the return value is
  // enriched with their CURRENT live name so their own just-sent message
  // still shows correctly in the immediate broadcast — only a later
  // re-fetch of history shows it anonymized, same as any other message
  // from someone no longer in `users` (see schema.ts's onDelete: set null
  // on chatMessages.userId, which this exact shape already relied on). ---

  async recordChatMessage(tableId: string, userId: string | null, message: string): Promise<ChatMessageRecord> {
    if (this.isPracticeOrPurged(tableId)) {
      // practiceStore has no users, so the sender's name comes from here.
      const sender = userId ? await this.findUserById(userId) : null;
      const record = this.practiceTables.has(tableId)
        ? await this.practiceStore.recordChatMessage(tableId, userId, message)
        : { id: randomUUID(), tableId, userId, displayName: null, message, createdAt: new Date() };
      return { ...record, displayName: sender?.displayName ?? null };
    }
    if (userId === null) return this.real.recordChatMessage(tableId, null, message);
    const guest = await this.guestStore.findUserById(userId);
    if (!guest) return this.real.recordChatMessage(tableId, userId, message);
    const persisted = await this.real.recordChatMessage(tableId, null, message);
    return { ...persisted, userId, displayName: guest.displayName };
  }

  async listRecentChat(tableId: string, limit: number): Promise<ChatMessageRecord[]> {
    if (!this.isPracticeOrPurged(tableId)) return this.real.listRecentChat(tableId, limit);
    const messages = await this.practiceStore.listRecentChat(tableId, limit);
    return Promise.all(
      messages.map(async (m) => ({ ...m, displayName: m.userId ? ((await this.findUserById(m.userId))?.displayName ?? null) : null })),
    );
  }
}

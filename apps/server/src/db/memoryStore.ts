import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ChatMessageRecord,
  HandRecordForVerification,
  LedgerEntryInput,
  RecordHandInput,
  Store,
  TableRecord,
  UserRecord,
} from './store.js';

interface LedgerRow extends LedgerEntryInput {
  id: string;
  createdAt: Date;
}

type HandRow = RecordHandInput;

/** In-memory Store: local dev/demo without Docker, and fast automated tests. Same interface as DrizzleStore. */
export class MemoryStore implements Store {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly usersByGoogleId = new Map<string, string>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: Date }>();
  private readonly ledger: LedgerRow[] = [];
  private readonly tables = new Map<string, TableRecord>();
  private readonly hands = new Map<string, HandRow>();
  private readonly chat: ChatMessageRecord[] = [];

  async createGuestUser(displayName: string): Promise<UserRecord> {
    const user: UserRecord = {
      id: randomUUID(),
      email: null,
      passwordHash: null,
      googleId: null,
      displayName,
      isGuest: true,
      role: 'player',
      avatarSeed: randomBytes(8).toString('hex'),
      clientSeed: randomBytes(16).toString('hex'),
      chips: 0,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }

  async createAccount(email: string, passwordHash: string, displayName: string): Promise<UserRecord> {
    if (this.usersByEmail.has(email)) throw new Error('EMAIL_TAKEN');
    const user: UserRecord = {
      id: randomUUID(),
      email,
      passwordHash,
      googleId: null,
      displayName,
      isGuest: false,
      role: 'player',
      avatarSeed: randomBytes(8).toString('hex'),
      clientSeed: randomBytes(16).toString('hex'),
      chips: 0,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(email, user.id);
    return Promise.resolve(user);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const id = this.usersByEmail.get(email);
    return Promise.resolve(id ? (this.users.get(id) ?? null) : null);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }

  async findUserByGoogleId(googleId: string): Promise<UserRecord | null> {
    const id = this.usersByGoogleId.get(googleId);
    return Promise.resolve(id ? (this.users.get(id) ?? null) : null);
  }

  async createGoogleAccount(googleId: string, email: string | null, displayName: string): Promise<UserRecord> {
    if (this.usersByGoogleId.has(googleId)) throw new Error('GOOGLE_ACCOUNT_ALREADY_LINKED');
    if (email && this.usersByEmail.has(email)) throw new Error('EMAIL_TAKEN');
    const user: UserRecord = {
      id: randomUUID(),
      email,
      passwordHash: null,
      googleId,
      displayName,
      isGuest: false,
      role: 'player',
      avatarSeed: randomBytes(8).toString('hex'),
      clientSeed: randomBytes(16).toString('hex'),
      chips: 0,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    this.usersByGoogleId.set(googleId, user.id);
    if (email) this.usersByEmail.set(email, user.id);
    return Promise.resolve(user);
  }

  async linkGoogleToGuest(userId: string, googleId: string, email: string | null): Promise<UserRecord> {
    const user = this.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    if (this.usersByGoogleId.has(googleId)) throw new Error('GOOGLE_ACCOUNT_ALREADY_LINKED');
    if (email && this.usersByEmail.has(email)) throw new Error('EMAIL_TAKEN');
    const updated: UserRecord = { ...user, googleId, email: email ?? user.email, isGuest: false };
    this.users.set(userId, updated);
    this.usersByGoogleId.set(googleId, userId);
    if (email) this.usersByEmail.set(email, userId);
    return Promise.resolve(updated);
  }

  async upgradeGuestToAccount(userId: string, email: string, passwordHash: string): Promise<UserRecord> {
    const user = this.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    if (this.usersByEmail.has(email)) throw new Error('EMAIL_TAKEN');
    const updated: UserRecord = { ...user, email, passwordHash, isGuest: false };
    this.users.set(userId, updated);
    this.usersByEmail.set(email, userId);
    return Promise.resolve(updated);
  }

  async adjustUserChips(userId: string, delta: number): Promise<UserRecord> {
    const user = this.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    const updated: UserRecord = { ...user, chips: user.chips + delta };
    this.users.set(userId, updated);
    return Promise.resolve(updated);
  }

  async setUserRole(userId: string, role: 'player' | 'admin'): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    this.users.set(userId, { ...user, role });
    return Promise.resolve();
  }

  async updateDisplayName(userId: string, displayName: string): Promise<UserRecord> {
    const user = this.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    const updated: UserRecord = { ...user, displayName };
    this.users.set(userId, updated);
    return Promise.resolve(updated);
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<UserRecord> {
    const user = this.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    const updated: UserRecord = { ...user, passwordHash };
    this.users.set(userId, updated);
    return Promise.resolve(updated);
  }

  async listUsers(): Promise<UserRecord[]> {
    return Promise.resolve([...this.users.values()]);
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    this.sessions.set(tokenHash, { userId, expiresAt });
    return Promise.resolve();
  }

  async findSessionByTokenHash(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null> {
    return Promise.resolve(this.sessions.get(tokenHash) ?? null);
  }

  async touchSession(_tokenHash: string): Promise<void> {
    return Promise.resolve();
  }

  async revokeSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
    return Promise.resolve();
  }

  async recordLedgerEntries(entries: readonly LedgerEntryInput[]): Promise<void> {
    const sum = entries.reduce((s, e) => s + e.amount, 0);
    if (sum !== 0) throw new Error(`unreachable: unbalanced ledger group (sum=${String(sum)})`);
    for (const e of entries) {
      this.ledger.push({ ...e, id: randomUUID(), createdAt: new Date() });
    }
    return Promise.resolve();
  }

  async ledgerBalanceForUser(userId: string): Promise<number> {
    return Promise.resolve(this.ledger.filter((e) => e.userId === userId).reduce((s, e) => s + e.amount, 0));
  }

  async ledgerConservationCheck(): Promise<{ balanced: boolean; totalDelta: number }> {
    const totalDelta = this.ledger.reduce((s, e) => s + e.amount, 0);
    return Promise.resolve({ balanced: totalDelta === 0, totalDelta });
  }

  async createTable(input: { name: string; config: Record<string, unknown>; inviteCode: string | null; createdBy: string | null }): Promise<TableRecord> {
    const table: TableRecord = {
      id: randomUUID(),
      name: input.name,
      config: input.config,
      status: 'open',
      inviteCode: input.inviteCode,
      createdBy: input.createdBy,
      createdAt: new Date(),
    };
    this.tables.set(table.id, table);
    return Promise.resolve(table);
  }

  async listTables(): Promise<TableRecord[]> {
    return Promise.resolve([...this.tables.values()].filter((t) => t.status === 'open'));
  }

  async getTable(id: string): Promise<TableRecord | null> {
    return Promise.resolve(this.tables.get(id) ?? null);
  }

  async closeTable(id: string): Promise<void> {
    const t = this.tables.get(id);
    if (t) this.tables.set(id, { ...t, status: 'closed' });
    return Promise.resolve();
  }

  async recordHand(input: RecordHandInput): Promise<void> {
    this.hands.set(input.id, { ...input });
    return Promise.resolve();
  }

  async getHandForVerification(handId: string): Promise<HandRecordForVerification | null> {
    const hand = this.hands.get(handId);
    if (!hand) return Promise.resolve(null);
    return Promise.resolve({
      id: hand.id,
      tableId: hand.tableId,
      handNumber: hand.handNumber,
      initialState: hand.initialState,
      actions: hand.actions,
      rngCommit: hand.rngCommit,
    });
  }

  async recordChatMessage(tableId: string, userId: string | null, message: string): Promise<ChatMessageRecord> {
    const user = userId ? this.users.get(userId) : null;
    const record: ChatMessageRecord = {
      id: randomUUID(),
      tableId,
      userId,
      displayName: user?.displayName ?? null,
      message,
      createdAt: new Date(),
    };
    this.chat.push(record);
    return Promise.resolve(record);
  }

  async listRecentChat(tableId: string, limit: number): Promise<ChatMessageRecord[]> {
    return Promise.resolve(
      this.chat
        .filter((c) => c.tableId === tableId)
        .slice(-limit),
    );
  }
}

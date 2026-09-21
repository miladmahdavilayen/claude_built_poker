import type { Card, TableState } from '@pokerclause/engine';

export interface UserRecord {
  id: string;
  email: string | null;
  passwordHash: string | null;
  /** Google's stable per-user `sub` claim. Null for guests and email/password accounts. */
  googleId: string | null;
  displayName: string;
  isGuest: boolean;
  role: 'player' | 'admin';
  avatarSeed: string;
  clientSeed: string;
  chips: number;
  createdAt: Date;
}

export interface TableRecord {
  id: string;
  name: string;
  config: Record<string, unknown>;
  status: 'open' | 'closed';
  inviteCode: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface LedgerEntryInput {
  userId: string | null;
  isHouse: boolean;
  amount: number;
  reason: 'buy_in' | 'cash_out' | 'pot_win' | 'rake' | 'admin_adjust';
  tableId?: string;
  handId?: string;
}

export interface HandSeatInput {
  seat: number;
  userId: string | null;
  startingStack: number;
  holeCards: readonly Card[];
  netResult: number;
  showedDown: boolean;
}

export interface HandActionInput {
  seq: number;
  street: string;
  seat: number;
  action: string;
  amount: number | null;
  potAfter: number;
  msToAct: number | null;
}

export interface HandResultInput {
  potIndex: number;
  winnerSeat: number;
  amount: number;
  handRankName: string | null;
  bestFiveCards: readonly Card[] | null;
}

export interface RngCommitInput {
  commitment: string;
  serverSeed: string | null;
  clientSeeds: readonly string[];
  nonce: number;
  deckOrder: readonly Card[] | null;
  revealedAt: Date | null;
}

export interface RecordHandInput {
  id: string;
  tableId: string;
  handNumber: number;
  buttonSeat: number;
  boardCards: readonly Card[];
  potTotal: number;
  rakeTaken: number;
  initialState: TableState;
  seats: readonly HandSeatInput[];
  actions: readonly HandActionInput[];
  results: readonly HandResultInput[];
  rngCommit: RngCommitInput;
  startedAt: Date;
  endedAt: Date;
}

export interface HandRecordForVerification {
  id: string;
  tableId: string;
  handNumber: number;
  initialState: TableState;
  actions: readonly HandActionInput[];
  rngCommit: RngCommitInput;
}

export interface ChatMessageRecord {
  id: string;
  tableId: string;
  userId: string | null;
  displayName: string | null;
  message: string;
  createdAt: Date;
}

/**
 * The persistence boundary. `MemoryStore` (memoryStore.ts) implements this
 * for local dev without Docker and for fast automated tests; `DrizzleStore`
 * (drizzleStore.ts) implements it for real, against Postgres — same
 * interface, so the game logic above never knows which one it's talking to.
 */
export interface Store {
  createGuestUser(displayName: string): Promise<UserRecord>;
  createAccount(email: string, passwordHash: string, displayName: string): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  findUserByGoogleId(googleId: string): Promise<UserRecord | null>;
  createGoogleAccount(googleId: string, email: string | null, displayName: string): Promise<UserRecord>;
  /** Links a Google identity onto an EXISTING guest account, converting it in place (same pattern as `upgradeGuestToAccount`). */
  linkGoogleToGuest(userId: string, googleId: string, email: string | null): Promise<UserRecord>;
  upgradeGuestToAccount(userId: string, email: string, passwordHash: string): Promise<UserRecord>;
  adjustUserChips(userId: string, delta: number): Promise<UserRecord>;
  setUserRole(userId: string, role: 'player' | 'admin'): Promise<void>;
  updateDisplayName(userId: string, displayName: string): Promise<UserRecord>;
  listUsers(): Promise<UserRecord[]>;

  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  touchSession(tokenHash: string): Promise<void>;
  revokeSession(tokenHash: string): Promise<void>;

  recordLedgerEntries(entries: readonly LedgerEntryInput[]): Promise<void>;
  ledgerBalanceForUser(userId: string): Promise<number>;
  ledgerConservationCheck(): Promise<{ balanced: boolean; totalDelta: number }>;

  createTable(input: { name: string; config: Record<string, unknown>; inviteCode: string | null; createdBy: string | null }): Promise<TableRecord>;
  listTables(): Promise<TableRecord[]>;
  getTable(id: string): Promise<TableRecord | null>;
  closeTable(id: string): Promise<void>;

  recordHand(input: RecordHandInput): Promise<void>;
  getHandForVerification(handId: string): Promise<HandRecordForVerification | null>;

  recordChatMessage(tableId: string, userId: string | null, message: string): Promise<ChatMessageRecord>;
  listRecentChat(tableId: string, limit: number): Promise<ChatMessageRecord[]>;
}

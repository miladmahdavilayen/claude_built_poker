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
  /** Google profile photo, refreshed on every Google sign-in. Null for guests and email/password accounts. */
  avatarUrl: string | null;
  createdAt: Date;
  /** Last Google sign-in. Null for an account that has never signed in with Google. */
  lastLoginAt: Date | null;
  /** The friendly-game waiver this player agreed to (see WAIVER_VERSION) — all three null until they agree. */
  waiver: { version: number; initials: string; acceptedAt: Date } | null;
}

/** What a verified Google sign-in tells us about a new account — see googleAuth.ts. */
export interface GoogleAccountInput {
  googleId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

/** An owner-generated, one-time access key (never the key itself — see auth/signupKeys.ts). */
export interface SignupKeyRecord {
  id: string;
  hint: string;
  label: string;
  email: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedBy: string | null;
  revokedAt: Date | null;
}

export type LedgerReason = 'buy_in' | 'cash_out' | 'pot_win' | 'rake' | 'admin_adjust' | 'welcome_bonus' | 'balance_restored';

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
  reason: LedgerReason;
  tableId?: string;
  handId?: string;
}

/** One user's own ledger row, for a profile page's transaction history — see `ledgerEntriesForUser`. */
export interface LedgerEntryRecord {
  id: string;
  amount: number;
  reason: LedgerReason;
  tableId: string | null;
  handId: string | null;
  createdAt: Date;
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

/** One player's line in a game's final standings — a row of `game_report_players`. Amounts in cents. */
export interface GameReportPlayerRecord {
  rank: number;
  playerName: string;
  /** The account's id for registered players; null for guests and computer players. */
  userId: string | null;
  playerType: 'registered' | 'guest' | 'bot';
  boughtIn: number;
  buyInCount: number;
  cashedOut: number;
  onTable: number;
  net: number;
  handsPlayed: number;
  handsWon: number;
}

/** The numbers a game is listed and compared by, in cents (see GameBook.summary). */
export interface GameReportSummary {
  gameNumber: number;
  /** The blinds of the game's most recent hand, e.g. "$1/$2". */
  stakes: string;
  playerCount: number;
  totalBoughtIn: number;
  totalCashedOut: number;
  stillOnTable: number;
  booksBalance: boolean;
  players: GameReportPlayerRecord[];
}

/**
 * One game's books at one table (see src/game/gameBook.ts): the full report
 * as readable YAML, plus structured columns and per-player rows to list,
 * sort and search by. Kept forever. `summary` is null only for a report
 * saved before those columns existed and not yet backfilled.
 */
export interface GameReportRecord {
  id: string;
  tableId: string;
  tableName: string;
  status: 'live' | 'final';
  handsPlayed: number;
  lastHandNumber: number | null;
  startedAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
  summary: GameReportSummary | null;
  reportYaml: string;
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
  createGoogleAccount(input: GoogleAccountInput): Promise<UserRecord>;
  /** Stamps a Google sign-in on an existing account: last sign-in time, and the current profile photo. */
  recordGoogleLogin(userId: string, avatarUrl: string | null): Promise<UserRecord>;
  /**
   * What a newly registered Google account starts with. The first time this
   * (normalized) email and Google account are ever seen: the welcome bonus,
   * recorded so it's never granted twice. After that: whatever balance the
   * person's deleted account was keeping for them (see keepBalanceForReturn),
   * handed over once — or 0 if there is none. Atomic: two registrations
   * racing can't both collect.
   */
  claimStartingBalance(emailKey: string, googleId: string, welcomeBonus: number): Promise<{ reason: 'welcome_bonus' | 'balance_restored'; amount: number }>;
  /** Keeps a deleting account's balance for when the same person registers again (replacing anything kept before). */
  keepBalanceForReturn(emailKey: string, googleId: string, balance: number): Promise<void>;
  createSignupKey(input: { keyHash: string; hint: string; label: string; email: string | null; emailKey: string | null; createdBy: string; expiresAt: Date }): Promise<SignupKeyRecord>;
  /** Newest first. */
  listSignupKeys(): Promise<SignupKeyRecord[]>;
  /** The key with this hash, if it can still be used (not used, revoked or expired). */
  findUsableSignupKey(keyHash: string): Promise<SignupKeyRecord | null>;
  /**
   * Atomically marks a usable key as used, if it's locked to no email or to
   * this one. Returns its id, or null (nothing changed) if it can't be
   * used — so two registrations racing for one key can't both win.
   */
  consumeSignupKey(keyHash: string, emailKey: string): Promise<string | null>;
  /** Records which account a consumed key registered. */
  attachSignupKeyUser(id: string, userId: string): Promise<void>;
  /** Revokes a key that hasn't been used. Returns false if there was nothing to revoke. */
  revokeSignupKey(id: string): Promise<boolean>;
  /** Records that this player agreed to the friendly-game waiver: which version, with what initials, now. */
  acceptWaiver(userId: string, version: number, initials: string): Promise<UserRecord>;
  /** Links a Google identity onto an EXISTING guest account, converting it in place. */
  linkGoogleToGuest(userId: string, googleId: string, email: string | null): Promise<UserRecord>;
  /**
   * Used only by HybridStore (hybridStore.ts) to migrate a guest's identity
   * INTO the real, persisted store on upgrade — inserts a new row with a
   * caller-specified `id` (the guest's existing, in-memory-only one)
   * instead of generating a fresh one, and carries over their current
   * chips/avatarSeed/clientSeed, so a guest who upgrades mid-session keeps
   * the exact same id (their live table seat doesn't need to know
   * anything changed) even though their data is only now actually being
   * persisted for the first time. See DECISIONS.md.
   */
  createGoogleAccountFromGuest(input: {
    id: string;
    googleId: string;
    email: string | null;
    displayName: string;
    chips: number;
    avatarSeed: string;
    clientSeed: string;
  }): Promise<UserRecord>;
  adjustUserChips(userId: string, delta: number): Promise<UserRecord>;
  setUserRole(userId: string, role: 'player' | 'admin'): Promise<void>;
  updateDisplayName(userId: string, displayName: string): Promise<UserRecord>;
  /** Used only by ensureAdminAccount (index.ts) to keep the owner's password in sync with ADMIN_PASSWORD on every boot — there's no "change my password" flow for a real account otherwise. */
  updatePasswordHash(userId: string, passwordHash: string): Promise<UserRecord>;
  listUsers(): Promise<UserRecord[]>;
  /** Permanently removes a user row. Every other table's foreign key to `users` is `onDelete: 'set null'` (sessions cascade instead) — hand history, chat, and past ledger entries survive with `userId: null`, exactly like a guest table wipe already leaves them. See DECISIONS.md. */
  deleteUser(userId: string): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  touchSession(tokenHash: string): Promise<void>;
  revokeSession(tokenHash: string): Promise<void>;

  recordLedgerEntries(entries: readonly LedgerEntryInput[]): Promise<void>;
  ledgerBalanceForUser(userId: string): Promise<number>;
  ledgerConservationCheck(): Promise<{ balanced: boolean; totalDelta: number }>;
  /** Most recent ledger rows for one user's own profile page, newest first. */
  ledgerEntriesForUser(userId: string, limit: number): Promise<LedgerEntryRecord[]>;
  /** Net result from actually PLAYING hands (sum of `reason: 'pot_win'` entries only) — excludes buy-ins/cash-outs/admin grants, so it reads as "winnings minus losses," not the account's raw balance. */
  ledgerPlayNetForUser(userId: string): Promise<number>;

  /**
   * `ephemeral` marks a practice table (see game/practiceTables.ts): its
   * records only ever exist for as long as the table does, and `deleteTable`
   * wipes them. HybridStore keeps such a table entirely in memory, so it
   * never reaches Postgres at all.
   */
  createTable(input: { name: string; config: Record<string, unknown>; inviteCode: string | null; createdBy: string | null; ephemeral?: boolean }): Promise<TableRecord>;
  /** Every table still open (not closed or deleted), oldest first — what the server restores on boot. */
  listTables(): Promise<TableRecord[]>;
  getTable(id: string): Promise<TableRecord | null>;
  closeTable(id: string): Promise<void>;
  /** Permanently deletes a table and everything recorded under it — hands, chat, game reports. Used for practice tables, never for a real one. */
  deleteTable(id: string): Promise<void>;
  /** Inserts or replaces a game's report (same id = same game, rewritten after every hand). */
  saveGameReport(record: GameReportRecord): Promise<void>;
  /** Every game report, most recently started first — without the YAML body. */
  listGameReports(): Promise<Omit<GameReportRecord, 'reportYaml'>[]>;
  getGameReport(id: string): Promise<GameReportRecord | null>;
  /** The most recently updated report for a table, if any. */
  latestGameReportForTable(tableId: string): Promise<GameReportRecord | null>;
  /** Persists an owner's mid-table changes (name, settings, privacy) — see LiveTable.updateSettings. */
  updateTable(id: string, patch: { name: string; config: Record<string, unknown>; inviteCode: string | null }): Promise<void>;

  recordHand(input: RecordHandInput): Promise<void>;
  getHandForVerification(handId: string): Promise<HandRecordForVerification | null>;

  recordChatMessage(tableId: string, userId: string | null, message: string): Promise<ChatMessageRecord>;
  listRecentChat(tableId: string, limit: number): Promise<ChatMessageRecord[]>;
}

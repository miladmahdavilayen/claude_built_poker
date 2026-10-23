import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type {
  ChatMessageRecord,
  HandRecordForVerification,
  LedgerEntryInput,
  LedgerEntryRecord,
  RecordHandInput,
  Store,
  TableRecord,
  UserRecord,
  GameReportPlayerRecord,
  GameReportRecord,
  GoogleAccountInput,
  SignedWaiverRecord,
  SignedWaiverSummary,
  SignupKeyRecord,
} from './store.js';

type GameReportRow = Omit<typeof schema.gameReports.$inferSelect, 'reportYaml'>;

/** A game_reports row (+ its game_report_players rows) as a record; summary is null on a row saved before migration 0005 and not yet backfilled. */
function toReportRecord(row: GameReportRow, players: GameReportPlayerRecord[]): Omit<GameReportRecord, 'reportYaml'> {
  const { gameNumber, stakes, playerCount, totalBoughtIn, totalCashedOut, stillOnTable, booksBalance, ...rest } = row;
  const summary =
    gameNumber === null || stakes === null || playerCount === null || totalBoughtIn === null || totalCashedOut === null || stillOnTable === null || booksBalance === null
      ? null
      : { gameNumber, stakes, playerCount, totalBoughtIn, totalCashedOut, stillOnTable, booksBalance, players };
  return { ...rest, summary };
}

function toUserRecord(row: typeof schema.users.$inferSelect): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    googleId: row.googleId,
    displayName: row.displayName,
    isGuest: row.isGuest,
    role: row.role,
    avatarSeed: row.avatarSeed,
    clientSeed: row.clientSeed,
    chips: row.chips,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    waiver:
      row.waiverVersion !== null && row.waiverInitials !== null && row.waiverAcceptedAt !== null
        ? { version: row.waiverVersion, initials: row.waiverInitials, acceptedAt: row.waiverAcceptedAt }
        : null,
  };
}

function toSignupKeyRecord(row: typeof schema.signupKeys.$inferSelect): SignupKeyRecord {
  return {
    id: row.id,
    hint: row.hint,
    label: row.label,
    email: row.email,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    usedBy: row.usedBy,
    revokedAt: row.revokedAt,
  };
}

/** A key that can still be used: not used, not revoked, not expired. */
const usableSignupKey = () =>
  and(isNull(schema.signupKeys.usedAt), isNull(schema.signupKeys.revokedAt), gt(schema.signupKeys.expiresAt, new Date()));

function toTableRecord(row: typeof schema.tables.$inferSelect): TableRecord {
  return {
    id: row.id,
    name: row.name,
    config: row.config as Record<string, unknown>,
    status: row.status,
    inviteCode: row.inviteCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** Real Postgres implementation of Store, via Drizzle. */
export class DrizzleStore implements Store {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async createGuestUser(displayName: string): Promise<UserRecord> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        displayName,
        isGuest: true,
        avatarSeed: randomBytes(8).toString('hex'),
        clientSeed: randomBytes(16).toString('hex'),
      })
      .returning();
    return toUserRecord(row!);
  }

  async createAccount(email: string, passwordHash: string, displayName: string): Promise<UserRecord> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        displayName,
        isGuest: false,
        avatarSeed: randomBytes(8).toString('hex'),
        clientSeed: randomBytes(16).toString('hex'),
      })
      .returning();
    return toUserRecord(row!);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    return row ? toUserRecord(row) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return row ? toUserRecord(row) : null;
  }

  async findUserByGoogleId(googleId: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.googleId, googleId)).limit(1);
    return row ? toUserRecord(row) : null;
  }

  async createGoogleAccount(input: GoogleAccountInput): Promise<UserRecord> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        email: input.email,
        googleId: input.googleId,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        isGuest: false,
        avatarSeed: randomBytes(8).toString('hex'),
        clientSeed: randomBytes(16).toString('hex'),
        lastLoginAt: new Date(),
      })
      .returning();
    return toUserRecord(row!);
  }

  async recordGoogleLogin(userId: string, avatarUrl: string | null): Promise<UserRecord> {
    const [row] = await this.db.update(schema.users).set({ avatarUrl, lastLoginAt: new Date() }).where(eq(schema.users.id, userId)).returning();
    if (!row) throw new Error('USER_NOT_FOUND');
    return toUserRecord(row);
  }

  async createSignupKey(input: { keyHash: string; hint: string; label: string; email: string | null; emailKey: string | null; createdBy: string; expiresAt: Date }): Promise<SignupKeyRecord> {
    const [row] = await this.db.insert(schema.signupKeys).values(input).returning();
    return toSignupKeyRecord(row!);
  }

  async listSignupKeys(): Promise<SignupKeyRecord[]> {
    const rows = await this.db.select().from(schema.signupKeys).orderBy(desc(schema.signupKeys.createdAt));
    return rows.map(toSignupKeyRecord);
  }

  async findUsableSignupKey(keyHash: string): Promise<SignupKeyRecord | null> {
    const [row] = await this.db.select().from(schema.signupKeys).where(and(eq(schema.signupKeys.keyHash, keyHash), usableSignupKey())).limit(1);
    return row ? toSignupKeyRecord(row) : null;
  }

  async consumeSignupKey(keyHash: string, emailKey: string): Promise<string | null> {
    // One UPDATE … WHERE usable: Postgres row locking means two
    // registrations racing for the same key can't both match.
    const [row] = await this.db
      .update(schema.signupKeys)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.signupKeys.keyHash, keyHash),
          usableSignupKey(),
          or(isNull(schema.signupKeys.emailKey), eq(schema.signupKeys.emailKey, emailKey)),
        ),
      )
      .returning({ id: schema.signupKeys.id });
    return row?.id ?? null;
  }

  async attachSignupKeyUser(id: string, userId: string): Promise<void> {
    await this.db.update(schema.signupKeys).set({ usedBy: userId }).where(eq(schema.signupKeys.id, id));
  }

  async revokeSignupKey(id: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.signupKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.signupKeys.id, id), isNull(schema.signupKeys.usedAt), isNull(schema.signupKeys.revokedAt)))
      .returning({ id: schema.signupKeys.id });
    return rows.length > 0;
  }

  async saveSignedWaiver(waiver: SignedWaiverRecord): Promise<void> {
    await this.db.insert(schema.signedWaivers).values(waiver);
  }

  async listSignedWaivers(): Promise<SignedWaiverSummary[]> {
    const w = schema.signedWaivers;
    return this.db
      .select({
        id: w.id,
        userId: w.userId,
        displayName: w.displayName,
        email: w.email,
        version: w.version,
        initials: w.initials,
        signedAt: w.signedAt,
        ipAddress: w.ipAddress,
        userAgent: w.userAgent,
        pdfSha256: w.pdfSha256,
      })
      .from(w)
      .orderBy(desc(w.signedAt));
  }

  async getSignedWaiver(id: string): Promise<SignedWaiverRecord | null> {
    const [row] = await this.db.select().from(schema.signedWaivers).where(eq(schema.signedWaivers.id, id)).limit(1);
    return row ? { ...row, record: row.record as Record<string, unknown> } : null;
  }

  async acceptWaiver(userId: string, version: number, initials: string): Promise<UserRecord> {
    const [row] = await this.db
      .update(schema.users)
      .set({ waiverVersion: version, waiverInitials: initials, waiverAcceptedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning();
    if (!row) throw new Error('USER_NOT_FOUND');
    return toUserRecord(row);
  }

  async claimStartingBalance(emailKey: string, googleId: string, welcomeBonus: number): Promise<{ reason: 'welcome_bonus' | 'balance_restored'; amount: number }> {
    // Either unique column (email key or Google id) already present means
    // this person has been here before: the insert is skipped, nothing
    // comes back, and they get what their deleted account kept instead.
    const inserted = await this.db
      .insert(schema.welcomeBonusClaims)
      .values({ emailKey, googleId, amount: welcomeBonus })
      .onConflictDoNothing()
      .returning({ emailKey: schema.welcomeBonusClaims.emailKey });
    if (inserted.length > 0) return { reason: 'welcome_bonus', amount: welcomeBonus };
    // Read-and-clear in one statement, so it's handed over exactly once.
    const kept = await this.db.execute<{ carried: number | null }>(sql`
      UPDATE welcome_bonus_claims c SET carried_balance = NULL
      FROM (SELECT email_key, carried_balance FROM welcome_bonus_claims
            WHERE (email_key = ${emailKey} OR google_id = ${googleId}) AND carried_balance IS NOT NULL FOR UPDATE) old
      WHERE c.email_key = old.email_key
      RETURNING old.carried_balance AS carried`);
    const amount = kept.rows.reduce((sum, r) => sum + Number(r.carried ?? 0), 0);
    return { reason: 'balance_restored', amount };
  }

  async keepBalanceForReturn(emailKey: string, googleId: string, balance: number): Promise<void> {
    const c = schema.welcomeBonusClaims;
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ emailKey: c.emailKey })
        .from(c)
        .where(or(eq(c.emailKey, emailKey), eq(c.googleId, googleId)))
        .for('update');
      if (rows.length === 0) {
        // An account from before the welcome bonus: no row yet. amount 0 — it never got one.
        await tx.insert(c).values({ emailKey, googleId, amount: 0, carriedBalance: balance });
        return;
      }
      for (const [i, row] of rows.entries()) {
        await tx.update(c).set({ carriedBalance: i === 0 ? balance : null }).where(eq(c.emailKey, row.emailKey));
      }
    });
  }

  async createGoogleAccountFromGuest(input: {
    id: string;
    googleId: string;
    email: string | null;
    displayName: string;
    chips: number;
    avatarSeed: string;
    clientSeed: string;
  }): Promise<UserRecord> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        id: input.id,
        email: input.email,
        googleId: input.googleId,
        displayName: input.displayName,
        isGuest: false,
        avatarSeed: input.avatarSeed,
        clientSeed: input.clientSeed,
        chips: input.chips,
      })
      .returning();
    return toUserRecord(row!);
  }

  async linkGoogleToGuest(userId: string, googleId: string, email: string | null): Promise<UserRecord> {
    const [row] = await this.db
      .update(schema.users)
      .set(email ? { googleId, email, isGuest: false } : { googleId, isGuest: false })
      .where(eq(schema.users.id, userId))
      .returning();
    if (!row) throw new Error('USER_NOT_FOUND');
    return toUserRecord(row);
  }

  async adjustUserChips(userId: string, delta: number): Promise<UserRecord> {
    const [row] = await this.db
      .update(schema.users)
      .set({ chips: sql`${schema.users.chips} + ${delta}` })
      .where(eq(schema.users.id, userId))
      .returning();
    if (!row) throw new Error('USER_NOT_FOUND');
    return toUserRecord(row);
  }

  async setUserRole(userId: string, role: 'player' | 'admin'): Promise<void> {
    await this.db.update(schema.users).set({ role }).where(eq(schema.users.id, userId));
  }

  async updateDisplayName(userId: string, displayName: string): Promise<UserRecord> {
    const [row] = await this.db.update(schema.users).set({ displayName }).where(eq(schema.users.id, userId)).returning();
    if (!row) throw new Error('USER_NOT_FOUND');
    return toUserRecord(row);
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<UserRecord> {
    const [row] = await this.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId)).returning();
    if (!row) throw new Error('USER_NOT_FOUND');
    return toUserRecord(row);
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = await this.db.select().from(schema.users);
    return rows.map(toUserRecord);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.delete(schema.users).where(eq(schema.users.id, userId));
  }

  async getSetting(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1);
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .insert(schema.appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } });
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.insert(schema.sessions).values({ tokenHash, userId, expiresAt });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null> {
    const [row] = await this.db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash)).limit(1);
    return row ? { userId: row.userId, expiresAt: row.expiresAt } : null;
  }

  async touchSession(tokenHash: string): Promise<void> {
    await this.db.update(schema.sessions).set({ lastSeenAt: new Date() }).where(eq(schema.sessions.tokenHash, tokenHash));
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
  }

  async recordLedgerEntries(entries: readonly LedgerEntryInput[]): Promise<void> {
    const sum = entries.reduce((s, e) => s + e.amount, 0);
    if (sum !== 0) throw new Error(`unreachable: unbalanced ledger group (sum=${String(sum)})`);
    const groupId = randomUUID();
    await this.db.insert(schema.chipLedger).values(
      entries.map((e) => ({
        groupId,
        userId: e.userId,
        isHouse: e.isHouse,
        amount: e.amount,
        reason: e.reason,
        tableId: e.tableId ?? null,
        handId: e.handId ?? null,
      })),
    );
  }

  async ledgerBalanceForUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${schema.chipLedger.amount}), 0)` })
      .from(schema.chipLedger)
      .where(eq(schema.chipLedger.userId, userId));
    return Number(row?.total ?? 0);
  }

  async ledgerConservationCheck(): Promise<{ balanced: boolean; totalDelta: number }> {
    const [row] = await this.db.select({ total: sql<string>`coalesce(sum(${schema.chipLedger.amount}), 0)` }).from(schema.chipLedger);
    const totalDelta = Number(row?.total ?? 0);
    return { balanced: totalDelta === 0, totalDelta };
  }

  async ledgerEntriesForUser(userId: string, limit: number): Promise<LedgerEntryRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.chipLedger)
      .where(eq(schema.chipLedger.userId, userId))
      .orderBy(desc(schema.chipLedger.createdAt))
      .limit(limit);
    return rows.map((r) => ({ id: r.id, amount: r.amount, reason: r.reason, tableId: r.tableId, handId: r.handId, createdAt: r.createdAt }));
  }

  async ledgerPlayNetForUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${schema.chipLedger.amount}), 0)` })
      .from(schema.chipLedger)
      .where(and(eq(schema.chipLedger.userId, userId), eq(schema.chipLedger.reason, 'pot_win')));
    return Number(row?.total ?? 0);
  }

  async createTable(input: { name: string; config: Record<string, unknown>; inviteCode: string | null; createdBy: string | null; ephemeral?: boolean }): Promise<TableRecord> {
    const [row] = await this.db
      .insert(schema.tables)
      .values({ name: input.name, config: input.config, inviteCode: input.inviteCode, createdBy: input.createdBy })
      .returning();
    return toTableRecord(row!);
  }

  async listTables(): Promise<TableRecord[]> {
    const rows = await this.db.select().from(schema.tables).where(eq(schema.tables.status, 'open')).orderBy(schema.tables.createdAt);
    return rows.map(toTableRecord);
  }

  async getTable(id: string): Promise<TableRecord | null> {
    const [row] = await this.db.select().from(schema.tables).where(eq(schema.tables.id, id)).limit(1);
    return row ? toTableRecord(row) : null;
  }

  async closeTable(id: string): Promise<void> {
    await this.db.update(schema.tables).set({ status: 'closed' }).where(eq(schema.tables.id, id));
  }

  async deleteTable(id: string): Promise<void> {
    // Hands (and their seats/actions/results/RNG commits) and chat cascade
    // from `tables`; game reports have no foreign key, so they go by hand.
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.gameReports).where(eq(schema.gameReports.tableId, id));
      await tx.delete(schema.tables).where(eq(schema.tables.id, id));
    });
  }

  async saveGameReport(record: GameReportRecord): Promise<void> {
    const { summary, ...rest } = record;
    const columns = {
      ...rest,
      gameNumber: summary?.gameNumber ?? null,
      stakes: summary?.stakes ?? null,
      playerCount: summary?.playerCount ?? null,
      totalBoughtIn: summary?.totalBoughtIn ?? null,
      totalCashedOut: summary?.totalCashedOut ?? null,
      stillOnTable: summary?.stillOnTable ?? null,
      booksBalance: summary?.booksBalance ?? null,
    };
    // Everything but the game's identity (id, table, start time) changes as it's played.
    const changing: Partial<typeof columns> = { ...columns };
    delete changing.id;
    delete changing.tableId;
    delete changing.startedAt;
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.gameReports).values(columns).onConflictDoUpdate({ target: schema.gameReports.id, set: changing });
      if (!summary) return;
      await tx.delete(schema.gameReportPlayers).where(eq(schema.gameReportPlayers.reportId, record.id));
      if (summary.players.length > 0) await tx.insert(schema.gameReportPlayers).values(summary.players.map((p) => ({ reportId: record.id, ...p })));
    });
  }

  async listGameReports(): Promise<Omit<GameReportRecord, 'reportYaml'>[]> {
    const t = schema.gameReports;
    const rows = await this.db
      .select({
        id: t.id,
        tableId: t.tableId,
        tableName: t.tableName,
        status: t.status,
        handsPlayed: t.handsPlayed,
        lastHandNumber: t.lastHandNumber,
        startedAt: t.startedAt,
        updatedAt: t.updatedAt,
        endedAt: t.endedAt,
        gameNumber: t.gameNumber,
        stakes: t.stakes,
        playerCount: t.playerCount,
        totalBoughtIn: t.totalBoughtIn,
        totalCashedOut: t.totalCashedOut,
        stillOnTable: t.stillOnTable,
        booksBalance: t.booksBalance,
      })
      .from(t)
      .orderBy(desc(t.startedAt));
    const players = await this.db.select().from(schema.gameReportPlayers).orderBy(schema.gameReportPlayers.reportId, schema.gameReportPlayers.rank);
    const byReport = new Map<string, GameReportPlayerRecord[]>();
    for (const { reportId, ...p } of players) {
      const list = byReport.get(reportId) ?? [];
      list.push(p);
      byReport.set(reportId, list);
    }
    return rows.map((row) => toReportRecord(row, byReport.get(row.id) ?? []));
  }

  async getGameReport(id: string): Promise<GameReportRecord | null> {
    const [row] = await this.db.select().from(schema.gameReports).where(eq(schema.gameReports.id, id)).limit(1);
    return row ? { ...toReportRecord(row, await this.reportPlayers(row.id)), reportYaml: row.reportYaml } : null;
  }

  async latestGameReportForTable(tableId: string): Promise<GameReportRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.gameReports)
      .where(eq(schema.gameReports.tableId, tableId))
      .orderBy(desc(schema.gameReports.updatedAt))
      .limit(1);
    return row ? { ...toReportRecord(row, await this.reportPlayers(row.id)), reportYaml: row.reportYaml } : null;
  }

  private async reportPlayers(reportId: string): Promise<GameReportPlayerRecord[]> {
    const rows = await this.db.select().from(schema.gameReportPlayers).where(eq(schema.gameReportPlayers.reportId, reportId)).orderBy(schema.gameReportPlayers.rank);
    return rows.map(({ reportId: _r, ...p }) => p);
  }

  async updateTable(id: string, patch: { name: string; config: Record<string, unknown>; inviteCode: string | null }): Promise<void> {
    await this.db.update(schema.tables).set({ name: patch.name, config: patch.config, inviteCode: patch.inviteCode }).where(eq(schema.tables.id, id));
  }

  async recordHand(input: RecordHandInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.hands).values({
        id: input.id,
        tableId: input.tableId,
        handNumber: input.handNumber,
        buttonSeat: input.buttonSeat,
        boardCards: [...input.boardCards],
        potTotal: input.potTotal,
        rakeTaken: input.rakeTaken,
        initialState: input.initialState,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      });
      const handId = input.id;

      if (input.seats.length > 0) {
        await tx.insert(schema.handSeats).values(
          input.seats.map((s) => ({
            handId,
            seat: s.seat,
            userId: s.userId,
            startingStack: s.startingStack,
            holeCards: [...s.holeCards],
            netResult: s.netResult,
            showedDown: s.showedDown,
          })),
        );
      }
      if (input.actions.length > 0) {
        await tx.insert(schema.handActions).values(
          input.actions.map((a) => ({
            handId,
            seq: a.seq,
            street: a.street,
            seat: a.seat,
            action: a.action,
            amount: a.amount,
            potAfter: a.potAfter,
            msToAct: a.msToAct,
          })),
        );
      }
      if (input.results.length > 0) {
        await tx.insert(schema.handResults).values(
          input.results.map((r) => ({
            handId,
            potIndex: r.potIndex,
            winnerSeat: r.winnerSeat,
            amount: r.amount,
            handRankName: r.handRankName,
            bestFiveCards: r.bestFiveCards ? [...r.bestFiveCards] : null,
          })),
        );
      }
      await tx.insert(schema.rngCommits).values({
        handId,
        commitment: input.rngCommit.commitment,
        serverSeed: input.rngCommit.serverSeed,
        clientSeeds: [...input.rngCommit.clientSeeds],
        nonce: input.rngCommit.nonce,
        deckOrder: input.rngCommit.deckOrder ? [...input.rngCommit.deckOrder] : null,
        revealedAt: input.rngCommit.revealedAt,
      });
    });
  }

  async getHandForVerification(handId: string): Promise<HandRecordForVerification | null> {
    const [handRow] = await this.db.select().from(schema.hands).where(eq(schema.hands.id, handId)).limit(1);
    if (!handRow) return null;
    const [commitRow] = await this.db.select().from(schema.rngCommits).where(eq(schema.rngCommits.handId, handId)).limit(1);
    if (!commitRow) return null;
    const actionRows = await this.db
      .select()
      .from(schema.handActions)
      .where(eq(schema.handActions.handId, handId))
      .orderBy(schema.handActions.seq);

    return {
      id: handRow.id,
      tableId: handRow.tableId,
      handNumber: handRow.handNumber,
      initialState: handRow.initialState as never,
      actions: actionRows.map((a) => ({
        seq: a.seq,
        street: a.street,
        seat: a.seat,
        action: a.action,
        amount: a.amount,
        potAfter: a.potAfter,
        msToAct: a.msToAct,
      })),
      rngCommit: {
        commitment: commitRow.commitment,
        serverSeed: commitRow.serverSeed,
        clientSeeds: commitRow.clientSeeds,
        nonce: commitRow.nonce,
        deckOrder: commitRow.deckOrder as HandRecordForVerification['rngCommit']['deckOrder'],
        revealedAt: commitRow.revealedAt,
      },
    };
  }

  async recordChatMessage(tableId: string, userId: string | null, message: string): Promise<ChatMessageRecord> {
    const [row] = await this.db.insert(schema.chatMessages).values({ tableId, userId, message }).returning();
    const user = userId ? await this.findUserById(userId) : null;
    return {
      id: row!.id,
      tableId: row!.tableId,
      userId: row!.userId,
      displayName: user?.displayName ?? null,
      message: row!.message,
      createdAt: row!.createdAt,
    };
  }

  async listRecentChat(tableId: string, limit: number): Promise<ChatMessageRecord[]> {
    const rows = await this.db
      .select({ msg: schema.chatMessages, displayName: schema.users.displayName })
      .from(schema.chatMessages)
      .leftJoin(schema.users, eq(schema.chatMessages.userId, schema.users.id))
      .where(and(eq(schema.chatMessages.tableId, tableId)))
      .orderBy(desc(schema.chatMessages.createdAt))
      .limit(limit);
    return rows
      .map((r) => ({
        id: r.msg.id,
        tableId: r.msg.tableId,
        userId: r.msg.userId,
        displayName: r.displayName ?? null,
        message: r.msg.message,
        createdAt: r.msg.createdAt,
      }))
      .reverse();
  }
}

import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type {
  ChatMessageRecord,
  HandRecordForVerification,
  LedgerEntryInput,
  RecordHandInput,
  Store,
  TableRecord,
  UserRecord,
} from './store.js';

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
    createdAt: row.createdAt,
  };
}

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

  async createGoogleAccount(googleId: string, email: string | null, displayName: string): Promise<UserRecord> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        email,
        googleId,
        displayName,
        isGuest: false,
        avatarSeed: randomBytes(8).toString('hex'),
        clientSeed: randomBytes(16).toString('hex'),
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

  async upgradeGuestToAccount(userId: string, email: string, passwordHash: string): Promise<UserRecord> {
    const [row] = await this.db
      .update(schema.users)
      .set({ email, passwordHash, isGuest: false })
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

  async listUsers(): Promise<UserRecord[]> {
    const rows = await this.db.select().from(schema.users);
    return rows.map(toUserRecord);
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

  async createTable(input: { name: string; config: Record<string, unknown>; inviteCode: string | null; createdBy: string | null }): Promise<TableRecord> {
    const [row] = await this.db
      .insert(schema.tables)
      .values({ name: input.name, config: input.config, inviteCode: input.inviteCode, createdBy: input.createdBy })
      .returning();
    return toTableRecord(row!);
  }

  async listTables(): Promise<TableRecord[]> {
    const rows = await this.db.select().from(schema.tables).where(eq(schema.tables.status, 'open'));
    return rows.map(toTableRecord);
  }

  async getTable(id: string): Promise<TableRecord | null> {
    const [row] = await this.db.select().from(schema.tables).where(eq(schema.tables.id, id)).limit(1);
    return row ? toTableRecord(row) : null;
  }

  async closeTable(id: string): Promise<void> {
    await this.db.update(schema.tables).set({ status: 'closed' }).where(eq(schema.tables.id, id));
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

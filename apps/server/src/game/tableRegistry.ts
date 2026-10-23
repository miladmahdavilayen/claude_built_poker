import { randomUUID } from 'node:crypto';
import type { GameEvent } from '@pokerclause/engine';
import type { TableSettings } from '@pokerclause/shared';
import type { Store, TableRecord } from '../db/store.js';
import { LiveTable, type BroadcastPayload, type VacatedSeat } from './liveTable.js';

export interface TableSummary {
  tableId: string;
  name: string;
  settings: TableSettings;
  seatsFilled: number;
  maxSeats: number;
  isPrivate: boolean;
  isPractice: boolean;
  ownerId: string | null;
}

export type BroadcastHandler = (tableId: string, perSeat: Map<number | null, BroadcastPayload>, rawEvents: readonly GameEvent[]) => void;
export type SeatsVacatedHandler = (tableId: string, vacated: readonly VacatedSeat[]) => void;

/**
 * Holds every live table in-process. Single-node by design (see project
 * DECISIONS — horizontal scaling is explicitly out of scope), so there is
 * no need for Redis-backed cross-process table locks: a table's state
 * only ever lives on this one event loop, and Node's single-threaded
 * execution already serializes every mutation to it.
 */
/** The invite a guest signs up through — see TableRegistry.describeInvite. */
export interface GuestInvite {
  kind: 'seat-invite' | 'open-link';
  tableId: string;
  tableName: string;
  adminNickname: string | null;
}

export class TableRegistry {
  private readonly tables = new Map<string, LiveTable>();

  constructor(
    private readonly store: Store,
    private readonly broadcastHandler: BroadcastHandler,
    private readonly seatsVacatedHandler: SeatsVacatedHandler = () => undefined,
  ) {}

  async createTable(name: string, settings: TableSettings, createdBy: string | null, inviteCode: string | null, isPractice = false): Promise<LiveTable> {
    const record = await this.store.createTable({ name, config: settings as unknown as Record<string, unknown>, inviteCode, createdBy, ephemeral: isPractice });
    return this.open(record.id, name, settings, createdBy, inviteCode, isPractice);
  }

  /**
   * Brings a table that was open when the server last stopped back to
   * life — same id, name, settings and invite code; its seats start empty
   * (everyone was cashed out at shutdown). See index.ts.
   */
  restore(record: TableRecord): LiveTable {
    return this.open(record.id, record.name, record.config as unknown as TableSettings, record.createdBy, record.inviteCode, false);
  }

  private open(id: string, name: string, settings: TableSettings, createdBy: string | null, inviteCode: string | null, isPractice: boolean): LiveTable {
    const table = new LiveTable(
      id,
      name,
      settings,
      this.store,
      {
        onBroadcast: this.broadcastHandler,
        onChipsSettled: () => Promise.resolve(),
        now: () => Date.now(),
        onSeatsVacated: this.seatsVacatedHandler,
      },
      inviteCode,
      createdBy,
      isPractice,
    );
    this.tables.set(id, table);
    return table;
  }

  get(tableId: string): LiveTable | null {
    return this.tables.get(tableId) ?? null;
  }

  list(): TableSummary[] {
    return [...this.tables.values()].map((t) => ({
      tableId: t.tableId,
      name: t.name,
      settings: t.settings,
      seatsFilled: t.seats.filter((s) => s.userId !== null).length,
      maxSeats: t.visibleSeatCount,
      isPrivate: t.settings.isPrivate,
      isPractice: t.isPractice,
      ownerId: t.ownerId,
    }));
  }

  /** The open-invite table this shareable code opens, if any. */
  tableForOpenCode(code: string): LiveTable | null {
    for (const t of this.tables.values()) {
      if (t.openSeating && t.inviteCode === code) return t;
    }
    return null;
  }

  /**
   * What a guest is signing up through: a live table's unused seat invite
   * (with the name the owner gave it), or an open-invite table's link —
   * null for anything else. See POST /auth/guest.
   */
  describeInvite(token: string): GuestInvite | null {
    const seat = this.tableForInvite(token);
    if (seat) return { kind: 'seat-invite', tableId: seat.tableId, tableName: seat.name, adminNickname: seat.seatAssignmentNickname(token) };
    const open = this.tableForOpenCode(token);
    if (open) return { kind: 'open-link', tableId: open.tableId, tableName: open.name, adminNickname: null };
    return null;
  }

  /** The table an unused invite code belongs to, if any — see GET /invites/:token. */
  tableForInvite(token: string): LiveTable | null {
    for (const t of this.tables.values()) {
      if (t.hasSeatAssignment(token)) return t;
    }
    return null;
  }

  /** The practice table this user owns, if one is open — a player has at most one at a time. */
  practiceTableOf(userId: string): LiveTable | null {
    for (const t of this.tables.values()) {
      if (t.isPractice && t.ownerId === userId) return t;
    }
    return null;
  }

  /**
   * Takes a table out of play. A practice table leaves nothing behind; a
   * real one is kept on record, marked closed — unless `keepOpen` (a
   * server shutdown), which leaves it open so the next boot restores it.
   */
  async close(tableId: string, keepOpen = false): Promise<void> {
    const table = this.tables.get(tableId);
    if (!table) return;
    table.dispose();
    this.tables.delete(tableId);
    if (table.isPractice) await this.store.deleteTable(tableId);
    else if (!keepOpen) await this.store.closeTable(tableId);
  }

  newTableId(): string {
    return randomUUID();
  }
}

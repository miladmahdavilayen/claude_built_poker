import { randomUUID } from 'node:crypto';
import type { GameEvent } from '@pokerclause/engine';
import type { TableSettings } from '@pokerclause/shared';
import type { Store } from '../db/store.js';
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
export class TableRegistry {
  private readonly tables = new Map<string, LiveTable>();

  constructor(
    private readonly store: Store,
    private readonly broadcastHandler: BroadcastHandler,
    private readonly seatsVacatedHandler: SeatsVacatedHandler = () => undefined,
  ) {}

  async createTable(name: string, settings: TableSettings, createdBy: string | null, inviteCode: string | null, isPractice = false): Promise<LiveTable> {
    const record = await this.store.createTable({ name, config: settings as unknown as Record<string, unknown>, inviteCode, createdBy, ephemeral: isPractice });
    const table = new LiveTable(
      record.id,
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
    this.tables.set(record.id, table);
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

  async close(tableId: string): Promise<void> {
    const table = this.tables.get(tableId);
    if (!table) return;
    table.dispose();
    this.tables.delete(tableId);
    // A practice table leaves nothing behind; a real one is kept, marked closed.
    if (table.isPractice) await this.store.deleteTable(tableId);
    else await this.store.closeTable(tableId);
  }

  newTableId(): string {
    return randomUUID();
  }
}

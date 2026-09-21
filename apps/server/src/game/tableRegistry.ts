import { randomUUID } from 'node:crypto';
import type { TableSettings } from '@pokerclause/shared';
import type { Store } from '../db/store.js';
import { LiveTable, type BroadcastPayload } from './liveTable.js';

export interface TableSummary {
  tableId: string;
  name: string;
  settings: TableSettings;
  seatsFilled: number;
  maxSeats: number;
  isPrivate: boolean;
}

export type BroadcastHandler = (tableId: string, perSeat: Map<number | null, BroadcastPayload>) => void;

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
  ) {}

  async createTable(name: string, settings: TableSettings, createdBy: string | null, inviteCode: string | null): Promise<LiveTable> {
    const record = await this.store.createTable({ name, config: settings as unknown as Record<string, unknown>, inviteCode, createdBy });
    const table = new LiveTable(
      record.id,
      name,
      settings,
      this.store,
      {
        onBroadcast: this.broadcastHandler,
        onChipsSettled: () => Promise.resolve(),
        now: () => Date.now(),
      },
      inviteCode,
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
      maxSeats: t.settings.maxSeats,
      isPrivate: t.settings.isPrivate,
    }));
  }

  async close(tableId: string): Promise<void> {
    const table = this.tables.get(tableId);
    if (!table) return;
    table.dispose();
    this.tables.delete(tableId);
    await this.store.closeTable(tableId);
  }

  /**
   * Call whenever a table's broadcast shows `phase === 'hand-complete'`:
   * gives the table a brief pause (for animation/UI), then starts the
   * next hand if enough players are still seated with chips. A no-op if
   * a hand is already running (e.g. it got restarted some other way) or
   * too few players remain — safe to call every time, not just once.
   */
  scheduleNextHandIfReady(tableId: string, delayMs = 3000): void {
    const table = this.tables.get(tableId);
    if (!table) return;
    setTimeout(() => {
      const t = this.tables.get(tableId);
      if (!t || !t.canStartHand()) return;
      t.prepareNextOrbit();
      t.startNextHand();
    }, delayMs);
  }

  newTableId(): string {
    return randomUUID();
  }
}

import type { ProjectedGameEvent, ProjectedTableState, UpdateTableSettingsIntent } from '@pokerclause/shared';
import { useEffect, useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ChatMessageRecord } from './types.js';

interface ServerError {
  code: string;
  message: string;
}

export type OwnerAck = { ok: true; deferred?: boolean; seatId?: number } | { ok: false; code: string; message: string };

interface StatePayload {
  state: ProjectedTableState;
  events: readonly ProjectedGameEvent[];
}

export interface TableSocketApi {
  state: ProjectedTableState | null;
  chat: ChatMessageRecord[];
  recentEvents: ProjectedGameEvent[];
  /**
   * The most recent batch of events from a single 'state' message, as a
   * fresh array reference every time one arrives (even back-to-back
   * identical-looking batches) — unlike `recentEvents` (a rolling,
   * deduplication-unfriendly accumulation), this is meant to be a
   * `useEffect` dependency that fires exactly once per incoming batch, for
   * one-shot UI reactions like the shuffle/deal animation.
   */
  latestEvents: readonly ProjectedGameEvent[];
  lastError: ServerError | null;
  /** Set once the server has closed this table (an owner's "Terminate table," or everyone human having left) — the reason string to show, or null if the table is still live. */
  tableClosedReason: string | null;
  /** Whether the viewer can self-serve seat themselves / add bots on the table they're currently joined to — true for the admin on any table, or for a signed-in non-guest human on the one table they created. Sent once per join-table (see socketServer.ts's canManageTable) since it never changes over the connection's lifetime. */
  canManageTable: boolean;
  /** Seat layout and table settings (the table menu) — the admin anywhere, or a table's creator except on a practice table. Sent with canManageTable. */
  canManageLayout: boolean;
  /** A signed-in player's own temporary table against computer players — see apps/server's practiceTables.ts. */
  isPractice: boolean;
  /** An open-invite table this viewer came to with its link: they pick their own seat (and can join the waitlist). Sent with canManageTable. */
  canTakeSeat: boolean;
  /** The table's recent chat has arrived (it follows the first state) — what came before it is history, not news. */
  chatHistoryLoaded: boolean;
  joinTable: (tableId: string, inviteCode?: string) => void;
  takeSeat: (tableId: string, seatId: number, buyIn: number, displayName?: string) => void;
  /** Resolves only once the server has actually cleared the seat — safe to navigate away (and tear down this socket) only after it resolves, not before. See DECISIONS.md. */
  leaveTable: () => Promise<void>;
  sitOut: () => void;
  sitIn: () => void;
  startHand: () => void;
  joinWaitlist: () => void;
  leaveWaitlist: () => void;
  /** Owner-only (admin role) — self-serve add-bot no longer exists. */
  addBot: (seatId: number, persona: string, buyIn: number) => void;
  removeBot: (seatId: number) => void;
  /** The owner moving a computer player to an empty seat (now, or after the hand it's in). */
  moveBot: (fromSeatId: number, toSeatId: number) => Promise<ChangeSeatAck>;
  submitAction: (handId: string, actionSeq: number, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amountTo?: number) => void;
  /** Voluntary post-fold-win card reveal — see `ProjectedTableState.revealEligibleSeatId`. */
  revealHand: (handId: string) => void;
  sendChat: (message: string) => void;
  /** Owner-only (admin role) — terminates this table for everyone. */
  terminateTable: () => Promise<void>;
  /** Owner-only (admin role) — empties every seat and refunds seated humans, but keeps the table itself alive. */
  resetTable: () => Promise<void>;
  /** Owner-only (admin role) — rebuys a specific seat's occupant. Self-serve rebuy no longer exists. */
  adminRebuy: (seatId: number, amount: number) => void;
  /** Owner-only (admin role) — generates a one-time, seat-and-amount-specific invite link. */
  assignSeat: (seatId: number, buyIn: number, nickname?: string) => Promise<{ ok: true; token: string } | { ok: false; code: string; message: string }>;
  /** Redeems an owner-generated invite link — the buy-in comes from the link itself. */
  redeemSeatAssignment: (token: string) => void;
  /** Owner-only, any time — blinds/ante/straddle changed mid-hand come back `deferred: true` (they apply from the next hand). Amounts in cents. */
  updateTableSettings: (patch: UpdateTableSettingsIntent) => Promise<OwnerAck>;
  /** Owner-only — restores a deleted seat or adds a new one (up to 9). */
  addSeat: () => Promise<OwnerAck>;
  /** Owner-only — takes the occupant off the table (seat stays). Mid-hand: folded on their turn, gone and refunded when the hand ends. */
  removePlayer: (seatId: number) => Promise<OwnerAck>;
  /** Owner-only — removes the seat itself (and its occupant, same timing as removePlayer). */
  deleteSeat: (seatId: number) => Promise<OwnerAck>;
  /** Owner-only — the private table's invite code, or null when it's public. */
  getInviteCode: () => Promise<string | null>;
  /** Moves your own seat to an empty one — or, with `quote`, only says when and at what cost (see LiveTable.moveSeat). */
  changeSeat: (seatId: number, quote?: boolean) => Promise<ChangeSeatAck>;
}

export type ChangeSeatAck = { ok: true; when: 'now' | 'after-hand'; owes: number } | { ok: false; code: string; message: string };

const NOT_CONNECTED: OwnerAck = { ok: false, code: 'NOT_CONNECTED', message: 'Not connected.' };

const MAX_RECENT_EVENTS = 60;

export function useTableSocket(socket: Socket | null): TableSocketApi {
  const [state, setState] = useState<ProjectedTableState | null>(null);
  const [chat, setChat] = useState<ChatMessageRecord[]>([]);
  const [recentEvents, setRecentEvents] = useState<ProjectedGameEvent[]>([]);
  const [latestEvents, setLatestEvents] = useState<readonly ProjectedGameEvent[]>([]);
  const [lastError, setLastError] = useState<ServerError | null>(null);
  const [tableClosedReason, setTableClosedReason] = useState<string | null>(null);
  const [canManageTable, setCanManageTable] = useState(false);
  const [canManageLayout, setCanManageLayout] = useState(false);
  const [isPractice, setIsPractice] = useState(false);
  const [canTakeSeat, setCanTakeSeat] = useState(false);
  const [chatHistoryLoaded, setChatHistoryLoaded] = useState(false);

  useEffect(() => {
    if (!socket) {
      setState(null);
      setChat([]);
      setRecentEvents([]);
      setLatestEvents([]);
      setTableClosedReason(null);
      setCanManageTable(false);
      setCanManageLayout(false);
      setIsPractice(false);
      setCanTakeSeat(false);
      setChatHistoryLoaded(false);
      return;
    }

    const onState = (payload: StatePayload): void => {
      setState(payload.state);
      if (payload.events.length > 0) {
        setRecentEvents((prev) => [...prev, ...payload.events].slice(-MAX_RECENT_EVENTS));
        setLatestEvents(payload.events);
      }
    };
    const onChatHistory = (messages: ChatMessageRecord[]): void => {
      setChat(messages);
      setChatHistoryLoaded(true);
    };
    const onChat = (message: ChatMessageRecord): void => setChat((prev) => [...prev, message].slice(-200));
    const onError = (err: ServerError): void => setLastError(err);
    const onTableClosed = (payload: { reason: string }): void => setTableClosedReason(payload.reason);
    const onTablePermissions = (payload: { canManageTable: boolean; canManageLayout: boolean; isPractice: boolean; canTakeSeat?: boolean }): void => {
      setCanTakeSeat(payload.canTakeSeat === true);
      setCanManageTable(payload.canManageTable);
      setCanManageLayout(payload.canManageLayout);
      setIsPractice(payload.isPractice);
    };

    socket.on('state', onState);
    socket.on('chat-history', onChatHistory);
    socket.on('chat', onChat);
    socket.on('error', onError);
    socket.on('table-closed', onTableClosed);
    socket.on('table-permissions', onTablePermissions);

    return () => {
      socket.off('state', onState);
      socket.off('chat-history', onChatHistory);
      socket.off('chat', onChat);
      socket.off('error', onError);
      socket.off('table-closed', onTableClosed);
      socket.off('table-permissions', onTablePermissions);
    };
  }, [socket]);

  return useMemo<TableSocketApi>(
    () => ({
      state,
      chat,
      recentEvents,
      latestEvents,
      lastError,
      tableClosedReason,
      canManageTable,
      canManageLayout,
      isPractice,
      canTakeSeat,
      chatHistoryLoaded,
      joinTable: (tableId, inviteCode) => socket?.emit('join-table', inviteCode ? { tableId, inviteCode } : { tableId }),
      takeSeat: (tableId, seatId, buyIn, displayName) =>
        socket?.emit('take-seat', displayName ? { tableId, seatId, buyIn, displayName } : { tableId, seatId, buyIn }),
      leaveTable: () => new Promise<void>((resolve) => (socket ? socket.emit('leave-table', () => resolve()) : resolve())),
      sitOut: () => socket?.emit('sit-out'),
      sitIn: () => socket?.emit('sit-in'),
      startHand: () => socket?.emit('start-hand'),
      joinWaitlist: () => socket?.emit('join-waitlist'),
      leaveWaitlist: () => socket?.emit('leave-waitlist'),
      addBot: (seatId, persona, buyIn) => socket?.emit('add-bot', { seatId, persona, buyIn }),
      removeBot: (seatId) => socket?.emit('remove-bot', { seatId }),
      moveBot: (fromSeatId, toSeatId) =>
        new Promise((resolve) =>
          socket
            ? socket.emit('move-bot', { fromSeatId, toSeatId }, (r: ChangeSeatAck) => resolve(r))
            : resolve({ ok: false, code: 'NOT_CONNECTED', message: 'Not connected.' }),
        ),
      submitAction: (handId, actionSeq, type, amountTo) =>
        socket?.emit('action', amountTo === undefined ? { handId, actionSeq, type } : { handId, actionSeq, type, amountTo }),
      revealHand: (handId) => socket?.emit('reveal-hand', { handId }),
      sendChat: (message) => socket?.emit('chat', { message }),
      terminateTable: () => new Promise<void>((resolve) => (socket ? socket.emit('terminate-table', () => resolve()) : resolve())),
      resetTable: () => new Promise<void>((resolve) => (socket ? socket.emit('reset-table', () => resolve()) : resolve())),
      adminRebuy: (seatId, amount) => socket?.emit('admin-rebuy', { seatId, amount }),
      assignSeat: (seatId, buyIn, nickname) =>
        new Promise((resolve) => {
          if (!socket) {
            resolve({ ok: false, code: 'NOT_CONNECTED', message: 'Not connected.' });
            return;
          }
          socket.emit(
            'assign-seat',
            nickname ? { seatId, buyIn, nickname } : { seatId, buyIn },
            (result: { ok: true; token: string } | { ok: false; code: string; message: string }) => resolve(result),
          );
        }),
      redeemSeatAssignment: (token) => socket?.emit('redeem-seat-assignment', { token }),
      updateTableSettings: (patch) =>
        new Promise((resolve) => (socket ? socket.emit('update-table-settings', patch, (r: OwnerAck) => resolve(r)) : resolve(NOT_CONNECTED))),
      addSeat: () => new Promise((resolve) => (socket ? socket.emit('add-seat', (r: OwnerAck) => resolve(r)) : resolve(NOT_CONNECTED))),
      removePlayer: (seatId) =>
        new Promise((resolve) => (socket ? socket.emit('remove-player', { seatId }, (r: OwnerAck) => resolve(r)) : resolve(NOT_CONNECTED))),
      deleteSeat: (seatId) =>
        new Promise((resolve) => (socket ? socket.emit('delete-seat', { seatId }, (r: OwnerAck) => resolve(r)) : resolve(NOT_CONNECTED))),
      changeSeat: (seatId, quote) =>
        new Promise((resolve) =>
          socket ? socket.emit('change-seat', quote ? { seatId, quote: true } : { seatId }, (r: ChangeSeatAck) => resolve(r)) : resolve({ ok: false, code: 'NOT_CONNECTED', message: 'Not connected.' }),
        ),
      getInviteCode: () =>
        new Promise((resolve) => (socket ? socket.emit('get-invite-code', (r: { inviteCode: string | null }) => resolve(r.inviteCode)) : resolve(null))),
    }),
    [socket, state, chat, recentEvents, latestEvents, lastError, tableClosedReason, canManageTable, canManageLayout, isPractice, canTakeSeat, chatHistoryLoaded],
  );
}

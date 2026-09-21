import type { ProjectedGameEvent, ProjectedTableState } from '@pokerclause/shared';
import { useEffect, useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ChatMessageRecord } from './types.js';

interface ServerError {
  code: string;
  message: string;
}

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
  submitAction: (handId: string, actionSeq: number, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amountTo?: number) => void;
  sendChat: (message: string) => void;
  /** Owner-only (admin role) — terminates this table for everyone. */
  terminateTable: () => Promise<void>;
  /** Owner-only (admin role) — empties every seat and refunds seated humans, but keeps the table itself alive. */
  resetTable: () => Promise<void>;
  /** Owner-only (admin role) — rebuys a specific seat's occupant. Self-serve rebuy no longer exists. */
  adminRebuy: (seatId: number, amount: number) => void;
  /** Owner-only (admin role) — generates a one-time, seat-and-amount-specific invite link. */
  assignSeat: (seatId: number, buyIn: number) => Promise<{ ok: true; token: string } | { ok: false; code: string; message: string }>;
  /** Redeems an owner-generated invite link — the buy-in comes from the link itself. */
  redeemSeatAssignment: (token: string) => void;
}

const MAX_RECENT_EVENTS = 60;

export function useTableSocket(socket: Socket | null): TableSocketApi {
  const [state, setState] = useState<ProjectedTableState | null>(null);
  const [chat, setChat] = useState<ChatMessageRecord[]>([]);
  const [recentEvents, setRecentEvents] = useState<ProjectedGameEvent[]>([]);
  const [latestEvents, setLatestEvents] = useState<readonly ProjectedGameEvent[]>([]);
  const [lastError, setLastError] = useState<ServerError | null>(null);
  const [tableClosedReason, setTableClosedReason] = useState<string | null>(null);

  useEffect(() => {
    if (!socket) {
      setState(null);
      setChat([]);
      setRecentEvents([]);
      setLatestEvents([]);
      setTableClosedReason(null);
      return;
    }

    const onState = (payload: StatePayload): void => {
      setState(payload.state);
      if (payload.events.length > 0) {
        setRecentEvents((prev) => [...prev, ...payload.events].slice(-MAX_RECENT_EVENTS));
        setLatestEvents(payload.events);
      }
    };
    const onChatHistory = (messages: ChatMessageRecord[]): void => setChat(messages);
    const onChat = (message: ChatMessageRecord): void => setChat((prev) => [...prev, message].slice(-200));
    const onError = (err: ServerError): void => setLastError(err);
    const onTableClosed = (payload: { reason: string }): void => setTableClosedReason(payload.reason);

    socket.on('state', onState);
    socket.on('chat-history', onChatHistory);
    socket.on('chat', onChat);
    socket.on('error', onError);
    socket.on('table-closed', onTableClosed);

    return () => {
      socket.off('state', onState);
      socket.off('chat-history', onChatHistory);
      socket.off('chat', onChat);
      socket.off('error', onError);
      socket.off('table-closed', onTableClosed);
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
      submitAction: (handId, actionSeq, type, amountTo) =>
        socket?.emit('action', amountTo === undefined ? { handId, actionSeq, type } : { handId, actionSeq, type, amountTo }),
      sendChat: (message) => socket?.emit('chat', { message }),
      terminateTable: () => new Promise<void>((resolve) => (socket ? socket.emit('terminate-table', () => resolve()) : resolve())),
      resetTable: () => new Promise<void>((resolve) => (socket ? socket.emit('reset-table', () => resolve()) : resolve())),
      adminRebuy: (seatId, amount) => socket?.emit('admin-rebuy', { seatId, amount }),
      assignSeat: (seatId, buyIn) =>
        new Promise((resolve) => {
          if (!socket) {
            resolve({ ok: false, code: 'NOT_CONNECTED', message: 'Not connected.' });
            return;
          }
          socket.emit('assign-seat', { seatId, buyIn }, (result: { ok: true; token: string } | { ok: false; code: string; message: string }) =>
            resolve(result),
          );
        }),
      redeemSeatAssignment: (token) => socket?.emit('redeem-seat-assignment', { token }),
    }),
    [socket, state, chat, recentEvents, latestEvents, lastError, tableClosedReason],
  );
}

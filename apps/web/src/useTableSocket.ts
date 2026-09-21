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
  lastError: ServerError | null;
  joinTable: (tableId: string, inviteCode?: string) => void;
  takeSeat: (tableId: string, seatId: number, buyIn: number) => void;
  leaveTable: () => void;
  sitOut: () => void;
  sitIn: () => void;
  rebuy: (amount: number) => void;
  joinWaitlist: () => void;
  leaveWaitlist: () => void;
  addBot: (seatId: number, persona: string, buyIn: number) => void;
  removeBot: (seatId: number) => void;
  submitAction: (handId: string, actionSeq: number, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amountTo?: number) => void;
  sendChat: (message: string) => void;
}

const MAX_RECENT_EVENTS = 60;

export function useTableSocket(socket: Socket | null): TableSocketApi {
  const [state, setState] = useState<ProjectedTableState | null>(null);
  const [chat, setChat] = useState<ChatMessageRecord[]>([]);
  const [recentEvents, setRecentEvents] = useState<ProjectedGameEvent[]>([]);
  const [lastError, setLastError] = useState<ServerError | null>(null);

  useEffect(() => {
    if (!socket) {
      setState(null);
      setChat([]);
      setRecentEvents([]);
      return;
    }

    const onState = (payload: StatePayload): void => {
      setState(payload.state);
      if (payload.events.length > 0) {
        setRecentEvents((prev) => [...prev, ...payload.events].slice(-MAX_RECENT_EVENTS));
      }
    };
    const onChatHistory = (messages: ChatMessageRecord[]): void => setChat(messages);
    const onChat = (message: ChatMessageRecord): void => setChat((prev) => [...prev, message].slice(-200));
    const onError = (err: ServerError): void => setLastError(err);

    socket.on('state', onState);
    socket.on('chat-history', onChatHistory);
    socket.on('chat', onChat);
    socket.on('error', onError);

    return () => {
      socket.off('state', onState);
      socket.off('chat-history', onChatHistory);
      socket.off('chat', onChat);
      socket.off('error', onError);
    };
  }, [socket]);

  return useMemo<TableSocketApi>(
    () => ({
      state,
      chat,
      recentEvents,
      lastError,
      joinTable: (tableId, inviteCode) => socket?.emit('join-table', inviteCode ? { tableId, inviteCode } : { tableId }),
      takeSeat: (tableId, seatId, buyIn) => socket?.emit('take-seat', { tableId, seatId, buyIn }),
      leaveTable: () => socket?.emit('leave-table'),
      sitOut: () => socket?.emit('sit-out'),
      sitIn: () => socket?.emit('sit-in'),
      rebuy: (amount) => socket?.emit('rebuy', { amount }),
      joinWaitlist: () => socket?.emit('join-waitlist'),
      leaveWaitlist: () => socket?.emit('leave-waitlist'),
      addBot: (seatId, persona, buyIn) => socket?.emit('add-bot', { seatId, persona, buyIn }),
      removeBot: (seatId) => socket?.emit('remove-bot', { seatId }),
      submitAction: (handId, actionSeq, type, amountTo) =>
        socket?.emit('action', amountTo === undefined ? { handId, actionSeq, type } : { handId, actionSeq, type, amountTo }),
      sendChat: (message) => socket?.emit('chat', { message }),
    }),
    [socket, state, chat, recentEvents, lastError],
  );
}

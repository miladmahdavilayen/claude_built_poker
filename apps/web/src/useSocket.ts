import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_BASE } from './api.js';

export function useSocket(accessToken: string | null): { socket: Socket | null; connected: boolean } {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!accessToken) {
      setSocket(null);
      return;
    }
    const s = io(API_BASE, { auth: { token: accessToken }, transports: ['websocket'] });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    setSocket(s);

    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [accessToken]);

  return { socket, connected };
}

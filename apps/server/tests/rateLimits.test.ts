import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '../src/auth/authService.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import { registerAuthRoutes } from '../src/http/routes/auth.js';
import { attachSocketServer } from '../src/socket/socketServer.js';

process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

describe('abuse limits', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('/auth/login allows a handful of tries per IP, then 429s — even for the right password', async () => {
    const store = new MemoryStore();
    await register(store, 'owner@example.com', 'correct-horse', 'Owner');
    app = Fastify();
    await app.register(cookie);
    await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
    registerAuthRoutes(app, store);

    const attempt = (password: string) =>
      app!.inject({ method: 'POST', url: '/auth/login', payload: { email: 'owner@example.com', password } });
    for (let i = 0; i < 4; i++) expect((await attempt('guess')).statusCode).toBe(401);
    expect((await attempt('correct-horse')).statusCode).toBe(200); // 5th try, still within the limit
    expect((await attempt('correct-horse')).statusCode).toBe(429);
  });

  it('caps concurrent sockets per IP', async () => {
    const prev = process.env.SOCKET_CONNECTIONS_PER_IP;
    process.env.SOCKET_CONNECTIONS_PER_IP = '2';
    const httpServer = createServer();
    const { io } = attachSocketServer(httpServer, { store: new MemoryStore(), corsOrigin: 'http://localhost:5173', adminUserId: '' });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const url = `http://localhost:${String((httpServer.address() as AddressInfo).port)}`;
    const open = (): Promise<{ socket: ClientSocket; ok: boolean }> =>
      new Promise((resolve) => {
        const socket = ioClient(url, { transports: ['websocket'], reconnection: false });
        socket.once('connect', () => resolve({ socket, ok: true }));
        socket.once('connect_error', () => resolve({ socket, ok: false }));
      });
    try {
      const a = await open();
      const b = await open();
      const c = await open();
      expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
      // Closing one frees a slot.
      a.socket.close();
      await new Promise((r) => setTimeout(r, 100));
      const d = await open();
      expect(d.ok).toBe(true);
      for (const s of [b, c, d]) s.socket.close();
    } finally {
      process.env.SOCKET_CONNECTIONS_PER_IP = prev;
      if (prev === undefined) delete process.env.SOCKET_CONNECTIONS_PER_IP;
      await io.close();
    }
  });
});

import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', () => ({ status: 'ok', uptimeSeconds: process.uptime() }));
}

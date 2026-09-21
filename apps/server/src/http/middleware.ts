import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    userRole?: 'player' | 'admin';
  }
}

function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return null;
}

export function attachAuthIfPresent(req: FastifyRequest): void {
  const token = extractBearerToken(req);
  if (!token) return;
  const payload = verifyAccessToken(token);
  if (payload) {
    req.userId = payload.sub;
    req.userRole = payload.role;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  attachAuthIfPresent(req);
  if (!req.userId) {
    await reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'Authentication required.' });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  attachAuthIfPresent(req);
  if (!req.userId || req.userRole !== 'admin') {
    await reply.code(403).send({ code: 'ADMIN_REQUIRED', message: 'Admin role required.' });
  }
}

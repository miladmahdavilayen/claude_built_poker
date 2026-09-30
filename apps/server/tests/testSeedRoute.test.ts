import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';
import { registerTestSeedRoutes } from '../src/http/routes/testSeed.js';

process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

describe('POST /test-only/seed-account: gated behind ALLOW_TEST_SEEDING, never present in a real deployment', () => {
  let app: FastifyInstance;
  const originalEnv = process.env.ALLOW_TEST_SEEDING;

  afterEach(async () => {
    process.env.ALLOW_TEST_SEEDING = originalEnv;
    await app.close();
  });

  it('does not exist at all when ALLOW_TEST_SEEDING is unset — a real deployment never sets it', async () => {
    delete process.env.ALLOW_TEST_SEEDING;
    const store = new MemoryStore();
    app = Fastify();
    registerTestSeedRoutes(app, store);
    const res = await app.inject({ method: 'POST', url: '/test-only/seed-account', payload: { displayName: 'Ann' } });
    expect(res.statusCode).toBe(404);
  });

  it('creates a real (non-guest) account when explicitly enabled', async () => {
    process.env.ALLOW_TEST_SEEDING = 'true';
    const store = new MemoryStore();
    app = Fastify();
    registerTestSeedRoutes(app, store);
    const res = await app.inject({ method: 'POST', url: '/test-only/seed-account', payload: { displayName: 'Ann' } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; displayName: string }>();
    expect(body.displayName).toBe('Ann');
    const user = await store.findUserById(body.id);
    expect(user?.isGuest).toBe(false);
  });
});

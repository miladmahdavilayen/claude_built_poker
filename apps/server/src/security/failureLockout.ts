/**
 * Counts failed attempts per client (IP) and locks a client out once it
 * has failed `maxFailures` times within `windowMs` — for things worth
 * guessing at, like access keys and invite codes. Successes don't count.
 * Sits behind the per-route request limits (index.ts / the routes): those
 * cap how fast anyone can ask at all; this stops a client that keeps
 * getting it wrong. Memory stays bounded: stale entries are dropped as
 * they're touched, and the map never holds more than `maxClients`.
 */
export class FailureLockout {
  private readonly clients = new Map<string, { failures: number; windowStart: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
    private readonly maxClients = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Milliseconds until this client may try again, or 0 if it may now. */
  retryAfterMs(client: string): number {
    const entry = this.clients.get(client);
    if (!entry) return 0;
    const t = this.now();
    if (entry.lockedUntil > t) return entry.lockedUntil - t;
    if (t - entry.windowStart > this.windowMs) this.clients.delete(client);
    return 0;
  }

  recordFailure(client: string): void {
    const t = this.now();
    let entry = this.clients.get(client);
    if (!entry || t - entry.windowStart > this.windowMs) {
      if (!entry && this.clients.size >= this.maxClients) this.evictOne(t);
      entry = { failures: 0, windowStart: t, lockedUntil: 0 };
      this.clients.set(client, entry);
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) entry.lockedUntil = t + this.lockMs;
  }

  /** Forgets every client — for tests. */
  reset(): void {
    this.clients.clear();
  }

  /** Drops the oldest entry — expired ones first, since Map iterates in insertion order. */
  private evictOne(t: number): void {
    for (const [key, e] of this.clients) {
      if (e.lockedUntil <= t) {
        this.clients.delete(key);
        return;
      }
    }
    const first = this.clients.keys().next();
    if (!first.done) this.clients.delete(first.value);
  }
}

import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memoryStore.js';

describe('MemoryStore', () => {
  it('creates a guest user with starting chips of 0 and unique seeds', async () => {
    const store = new MemoryStore();
    const a = await store.createGuestUser('Alice');
    const b = await store.createGuestUser('Bob');
    expect(a.isGuest).toBe(true);
    expect(a.chips).toBe(0);
    expect(a.clientSeed).not.toBe(b.clientSeed);
  });

  it('upgrades a guest to a full account, preserving id and chips', async () => {
    const store = new MemoryStore();
    const guest = await store.createGuestUser('Carol');
    await store.adjustUserChips(guest.id, 500);
    const upgraded = await store.upgradeGuestToAccount(guest.id, 'carol@example.com', 'hashed');
    expect(upgraded.id).toBe(guest.id);
    expect(upgraded.isGuest).toBe(false);
    expect(upgraded.chips).toBe(500);
    expect(await store.findUserByEmail('carol@example.com')).toMatchObject({ id: guest.id });
  });

  it('rejects a duplicate email', async () => {
    const store = new MemoryStore();
    await store.createAccount('dup@example.com', 'h1', 'D1');
    await expect(store.createAccount('dup@example.com', 'h2', 'D2')).rejects.toThrow('EMAIL_TAKEN');
  });

  it('the double-entry ledger always balances and rejects an unbalanced group', async () => {
    const store = new MemoryStore();
    const user = await store.createGuestUser('Dave');
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: 500, reason: 'buy_in' },
      { userId: null, isHouse: true, amount: -500, reason: 'buy_in' },
    ]);
    expect(await store.ledgerBalanceForUser(user.id)).toBe(500);
    const check = await store.ledgerConservationCheck();
    expect(check.balanced).toBe(true);
    expect(check.totalDelta).toBe(0);

    await expect(
      store.recordLedgerEntries([{ userId: user.id, isHouse: false, amount: 100, reason: 'pot_win' }]),
    ).rejects.toThrow();
  });

  it('sessions can be created, found, touched, and revoked', async () => {
    const store = new MemoryStore();
    const user = await store.createGuestUser('Eve');
    const tokenHash = 'abc123';
    const expiresAt = new Date(Date.now() + 60000);
    await store.createSession(user.id, tokenHash, expiresAt);
    expect(await store.findSessionByTokenHash(tokenHash)).toMatchObject({ userId: user.id });
    await store.revokeSession(tokenHash);
    expect(await store.findSessionByTokenHash(tokenHash)).toBeNull();
  });

  it('tables can be created, listed while open, and hidden once closed', async () => {
    const store = new MemoryStore();
    const table = await store.createTable({ name: 'Table 1', config: { maxSeats: 6 }, inviteCode: null, createdBy: null });
    expect(await store.listTables()).toHaveLength(1);
    await store.closeTable(table.id);
    expect(await store.listTables()).toHaveLength(0);
  });

  it('chat messages record the sender display name and list in order', async () => {
    const store = new MemoryStore();
    const table = await store.createTable({ name: 'T', config: {}, inviteCode: null, createdBy: null });
    const user = await store.createGuestUser('Frank');
    await store.recordChatMessage(table.id, user.id, 'gg');
    await store.recordChatMessage(table.id, null, 'system message');
    const recent = await store.listRecentChat(table.id, 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.displayName).toBe('Frank');
    expect(recent[1]!.displayName).toBeNull();
  });
});

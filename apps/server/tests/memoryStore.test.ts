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

  it('createGoogleAccountFromGuest inserts a real account at a caller-specified id, carrying over the guest’s current chips/seeds', async () => {
    const store = new MemoryStore();
    const guest = await store.createGuestUser('Carol');
    await store.adjustUserChips(guest.id, 500);
    const promoted = await store.createGoogleAccountFromGuest({
      id: guest.id,
      googleId: 'g-carol',
      email: 'carol@gmail.com',
      displayName: guest.displayName,
      chips: 500,
      avatarSeed: guest.avatarSeed,
      clientSeed: guest.clientSeed,
    });
    expect(promoted.id).toBe(guest.id);
    expect(promoted.isGuest).toBe(false);
    expect(promoted.chips).toBe(500);
    expect(promoted.avatarSeed).toBe(guest.avatarSeed);
    expect(await store.findUserByGoogleId('g-carol')).toMatchObject({ id: guest.id });
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

  it('ledgerPlayNetForUser sums only pot_win entries — buy-ins, cash-outs, and admin grants never count as "winnings"', async () => {
    const store = new MemoryStore();
    const user = await store.createGuestUser('Gina');
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: 5000, reason: 'admin_adjust' },
      { userId: null, isHouse: true, amount: -5000, reason: 'admin_adjust' },
    ]);
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: -200, reason: 'buy_in' },
      { userId: null, isHouse: true, amount: 200, reason: 'buy_in' },
    ]);
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: 350, reason: 'pot_win' },
      { userId: null, isHouse: true, amount: -350, reason: 'pot_win' },
    ]);
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: -120, reason: 'pot_win' }, // a losing hand's net-negative entry — see settleHand
      { userId: null, isHouse: true, amount: 120, reason: 'pot_win' },
    ]);

    expect(await store.ledgerPlayNetForUser(user.id)).toBe(230); // 350 - 120, ignoring the 5000 grant and the buy-in
    expect(await store.ledgerBalanceForUser(user.id)).toBe(5030); // 5000 - 200 + 350 - 120 — the real total balance, unlike the play-only figure above
  });

  it('ledgerEntriesForUser returns this user’s own rows, newest first, up to the limit', async () => {
    const store = new MemoryStore();
    const user = await store.createGuestUser('Hank');
    const other = await store.createGuestUser('Ivy');
    for (let i = 0; i < 3; i++) {
      await store.recordLedgerEntries([
        { userId: user.id, isHouse: false, amount: 10, reason: 'pot_win' },
        { userId: null, isHouse: true, amount: -10, reason: 'pot_win' },
      ]);
    }
    await store.recordLedgerEntries([
      { userId: other.id, isHouse: false, amount: 999, reason: 'pot_win' },
      { userId: null, isHouse: true, amount: -999, reason: 'pot_win' },
    ]);

    const entries = await store.ledgerEntriesForUser(user.id, 2);
    expect(entries).toHaveLength(2); // limited, and never leaks another user's rows
    expect(entries.every((e) => e.amount === 10)).toBe(true);
  });

  it('deleteUser removes the account but leaves past ledger/table/hand/chat references intact with userId nulled out, mirroring the real DB’s onDelete: set null FKs', async () => {
    const store = new MemoryStore();
    const user = await store.createGuestUser('Jack');
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: 100, reason: 'pot_win' },
      { userId: null, isHouse: true, amount: -100, reason: 'pot_win' },
    ]);
    const table = await store.createTable({ name: 'Jack’s Table', config: {}, inviteCode: null, createdBy: user.id });
    await store.recordChatMessage(table.id, user.id, 'hi');
    await store.createSession(user.id, 'sess-hash', new Date(Date.now() + 60000));

    await store.deleteUser(user.id);

    expect(await store.findUserById(user.id)).toBeNull();
    expect(await store.findSessionByTokenHash('sess-hash')).toBeNull();
    expect(await store.ledgerBalanceForUser(user.id)).toBe(0); // the row itself is gone from this user's own view...
    const conservation = await store.ledgerConservationCheck();
    expect(conservation.balanced).toBe(true); // ...but the ledger as a whole still balances — the entry survives with userId: null
    expect((await store.getTable(table.id))?.createdBy).toBeNull();
    const chat = await store.listRecentChat(table.id, 10);
    expect(chat).toHaveLength(1);
    expect(chat[0]!.userId).toBeNull();
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

import { beforeEach, describe, expect, it } from 'vitest';
import { HybridStore } from '../src/db/hybridStore.js';
import { MemoryStore } from '../src/db/memoryStore.js';

/**
 * `real` here is a plain MemoryStore standing in for DrizzleStore/Postgres
 * — what matters for these tests is only that a guest's data never
 * reaches it, which is equally observable (and much faster to test)
 * against either backend, since HybridStore treats `real` purely through
 * the shared `Store` interface.
 */
describe('HybridStore: a guest’s data never reaches the real (persisted) store', () => {
  let real: MemoryStore;
  let store: HybridStore;

  beforeEach(() => {
    real = new MemoryStore();
    store = new HybridStore(real);
  });

  it('a guest is never inserted into the real store at all', async () => {
    const guest = await store.createGuestUser('Gina');
    expect(await real.findUserById(guest.id)).toBeNull();
    expect(await real.listUsers()).toHaveLength(0);
    expect(await store.findUserById(guest.id)).toMatchObject({ id: guest.id, isGuest: true });
  });

  it('listUsers only ever returns real (persisted) accounts', async () => {
    await store.createGuestUser('Gina');
    const real1 = await store.createGoogleAccount({ googleId: 'g-1', email: 'a@gmail.com', displayName: 'Ann', avatarUrl: null });
    const users = await store.listUsers();
    expect(users.map((u) => u.id)).toEqual([real1.id]);
  });

  it('a guest’s chip balance is tracked entirely in memory, never via the real store', async () => {
    const guest = await store.createGuestUser('Gina');
    const updated = await store.adjustUserChips(guest.id, 500);
    expect(updated.chips).toBe(500);
    expect(await real.findUserById(guest.id)).toBeNull();
  });

  it('deleting a guest just drops the in-memory record — the real store was never touched', async () => {
    const guest = await store.createGuestUser('Gina');
    await store.deleteUser(guest.id);
    expect(await store.findUserById(guest.id)).toBeNull();
  });

  it('a guest’s session is tracked in memory, never in the real store', async () => {
    const guest = await store.createGuestUser('Gina');
    await store.createSession(guest.id, 'guest-token-hash', new Date(Date.now() + 60_000));
    expect(await store.findSessionByTokenHash('guest-token-hash')).toMatchObject({ userId: guest.id });
    expect(await real.findSessionByTokenHash('guest-token-hash')).toBeNull();

    await store.revokeSession('guest-token-hash');
    expect(await store.findSessionByTokenHash('guest-token-hash')).toBeNull();
  });

  it('a real account’s session goes through unaffected', async () => {
    const user = await store.createGoogleAccount({ googleId: 'g-2', email: 'b@gmail.com', displayName: 'Bob', avatarUrl: null });
    await store.createSession(user.id, 'real-token-hash', new Date(Date.now() + 60_000));
    expect(await real.findSessionByTokenHash('real-token-hash')).toMatchObject({ userId: user.id });
  });

  it('ledger entries anonymize a guest’s own side (userId: null) while a real co-player’s side, and the group’s zero-sum, are both preserved exactly', async () => {
    const guest = await store.createGuestUser('Gina');
    const real1 = await store.createGoogleAccount({ googleId: 'g-3', email: 'c@gmail.com', displayName: 'Cara', avatarUrl: null });

    // A hand where the guest lost 100 to the real player — a single group, same as settleHand's own batching.
    await store.recordLedgerEntries([
      { userId: guest.id, isHouse: false, amount: -100, reason: 'pot_win' },
      { userId: real1.id, isHouse: false, amount: 100, reason: 'pot_win' },
    ]);

    const conservation = await real.ledgerConservationCheck();
    expect(conservation.balanced).toBe(true); // the persisted group still sums to zero

    // The real player's own history/net result is completely unaffected by the guest's presence at the table.
    expect(await store.ledgerPlayNetForUser(real1.id)).toBe(100);
    const realEntries = await store.ledgerEntriesForUser(real1.id, 10);
    expect(realEntries).toHaveLength(1);
    expect(realEntries[0]!.amount).toBe(100);

    // Nothing is ever attributable back to the guest's own identity.
    expect(await store.ledgerEntriesForUser(guest.id, 10)).toEqual([]);
    expect(await store.ledgerPlayNetForUser(guest.id)).toBe(0);
  });

  it('recordHand anonymizes a guest’s seat the same way, leaving a real co-player’s seat untouched', async () => {
    const guest = await store.createGuestUser('Gina');
    const real1 = await store.createGoogleAccount({ googleId: 'g-4', email: 'd@gmail.com', displayName: 'Dee', avatarUrl: null });

    await store.recordHand({
      id: 'hand-1',
      tableId: 'table-1',
      handNumber: 1,
      buttonSeat: 0,
      boardCards: [],
      potTotal: 100,
      rakeTaken: 0,
      initialState: {} as never,
      seats: [
        { seat: 0, userId: guest.id, startingStack: 100, holeCards: [], netResult: -100, showedDown: false },
        { seat: 1, userId: real1.id, startingStack: 100, holeCards: [], netResult: 100, showedDown: false },
      ],
      actions: [],
      results: [],
      rngCommit: { commitment: 'c', serverSeed: null, clientSeeds: [], nonce: 1, deckOrder: null, revealedAt: null },
      startedAt: new Date(),
      endedAt: new Date(),
    });

    const verification = await real.getHandForVerification('hand-1');
    expect(verification).not.toBeNull(); // the hand itself is still fully recorded
  });

  it("a guest's chat message is enriched with their live name for the immediate broadcast, but persisted anonymized — a later history re-fetch shows it with no attached identity", async () => {
    const guest = await store.createGuestUser('Gina');
    const sent = await store.recordChatMessage('table-1', guest.id, 'gg everyone');
    expect(sent.displayName).toBe('Gina'); // the live broadcast still shows their name
    expect(sent.userId).toBe(guest.id); // from the caller's point of view, this message is still "theirs" right now

    const history = await real.listRecentChat('table-1', 10);
    expect(history).toHaveLength(1);
    expect(history[0]!.userId).toBeNull(); // never attributed to them once persisted
    expect(history[0]!.message).toBe('gg everyone'); // the message content itself isn't guest "identity" — it's kept, same as a deleted real user's old messages already are
  });

  it('a real account’s chat message is completely unaffected', async () => {
    const user = await store.createGoogleAccount({ googleId: 'g-5', email: 'e@gmail.com', displayName: 'Eli', avatarUrl: null });
    const sent = await store.recordChatMessage('table-1', user.id, 'nice hand');
    expect(sent.userId).toBe(user.id);
    const history = await real.listRecentChat('table-1', 10);
    expect(history[0]!.userId).toBe(user.id);
    expect(history[0]!.displayName).toBe('Eli');
  });

  it('upgrading a guest to Google migrates them into the real store at the SAME id, carrying over their current chips, and removes the ephemeral record', async () => {
    const guest = await store.createGuestUser('Gina');
    await store.adjustUserChips(guest.id, 750);

    const promoted = await store.linkGoogleToGuest(guest.id, 'g-6', 'gina@gmail.com');

    expect(promoted.id).toBe(guest.id); // same id — any live table seat referencing it keeps working
    expect(promoted.isGuest).toBe(false);
    expect(promoted.chips).toBe(750);

    // Now genuinely persisted...
    expect(await real.findUserById(guest.id)).toMatchObject({ id: guest.id, chips: 750, isGuest: false });
    expect((await store.listUsers()).map((u) => u.id)).toContain(guest.id);

    // ...and the ephemeral guest record is gone, so future ledger/hand
    // activity under this same id is no longer anonymized — it's a real
    // account now.
    await store.recordLedgerEntries([
      { userId: guest.id, isHouse: false, amount: 50, reason: 'pot_win' },
      { userId: null, isHouse: true, amount: -50, reason: 'pot_win' },
    ]);
    expect(await store.ledgerPlayNetForUser(guest.id)).toBe(50);
  });

  it('rejects upgrading an id that was never a guest in the first place', async () => {
    const user = await store.createGoogleAccount({ googleId: 'g-7', email: 'f@gmail.com', displayName: 'Fay', avatarUrl: null });
    await expect(store.linkGoogleToGuest(user.id, 'g-8', 'other@gmail.com')).rejects.toThrow('USER_NOT_FOUND');
  });
});

describe('HybridStore: a practice table never reaches the real (persisted) store', () => {
  let real: MemoryStore;
  let store: HybridStore;

  beforeEach(() => {
    real = new MemoryStore();
    store = new HybridStore(real);
  });

  it('keeps the table, its hands, chat and reports in memory only, wipes them on delete, and drops writes that arrive after', async () => {
    const user = await store.createGoogleAccount({ googleId: 'g-p', email: 'p@gmail.com', displayName: 'Pat', avatarUrl: null });
    const table = await store.createTable({ name: 'Practice', config: {}, inviteCode: null, createdBy: user.id, ephemeral: true });
    expect(await real.getTable(table.id)).toBeNull();
    expect(await store.getTable(table.id)).toMatchObject({ id: table.id });

    await store.recordChatMessage(table.id, user.id, 'hi');
    expect(await store.listRecentChat(table.id, 10)).toMatchObject([{ message: 'hi', displayName: 'Pat' }]);
    expect(await real.listRecentChat(table.id, 10)).toHaveLength(0);

    const report = {
      id: '00000000-0000-0000-0000-000000000001',
      tableId: table.id,
      tableName: 'Practice',
      status: 'live' as const,
      handsPlayed: 1,
      lastHandNumber: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
      endedAt: null,
      summary: null,
      reportYaml: 'x',
    };
    await store.saveGameReport(report);
    expect(await real.listGameReports()).toHaveLength(0);

    // Money still moves for real, but the ledger rows don't point at the table.
    await store.recordLedgerEntries([
      { userId: user.id, isHouse: false, amount: -500, reason: 'buy_in', tableId: table.id, handId: 'h' },
      { userId: null, isHouse: true, amount: 500, reason: 'buy_in', tableId: table.id, handId: 'h' },
    ]);
    const [entry] = await real.ledgerEntriesForUser(user.id, 10);
    expect(entry).toMatchObject({ amount: -500, tableId: null, handId: null });

    await store.deleteTable(table.id);
    expect(await store.getTable(table.id)).toBeNull();
    expect(await store.listRecentChat(table.id, 10)).toHaveLength(0);
    expect(await store.latestGameReportForTable(table.id)).toBeNull();

    // A write still in flight when the table closed lands nowhere.
    await store.saveGameReport({ ...report, handsPlayed: 2 });
    expect(await real.listGameReports()).toHaveLength(0);
    expect(await store.latestGameReportForTable(table.id)).toBeNull();
  });
});

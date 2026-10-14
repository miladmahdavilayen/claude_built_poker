import cookie from '@fastify/cookie';
import type { TableSettings } from '@pokerclause/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { issueAccessToken } from '../src/auth/session.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import { settle, type GameReport } from '../src/game/gameBook.js';
import { LiveTable, type VacatedSeat } from '../src/game/liveTable.js';
import { TableRegistry } from '../src/game/tableRegistry.js';
import { registerReportRoutes } from '../src/http/routes/reports.js';
import { backfillGameReportSummaries, finishInterruptedGameReports, INTERRUPTED_REASON, moneyToCents, summaryFromReport } from '../src/reports/backfill.js';
import { renderReportPdf } from '../src/reports/reportPdf.js';

process.env.JWT_SECRET ??= 'test-secret-do-not-use-in-prod';

const SETTINGS: TableSettings = {
  smallBlind: 10,
  bigBlind: 20,
  ante: 0,
  maxSeats: 6,
  straddleEnabled: false,
  minBuyIn: 500,
  maxBuyIn: 5000,
  actionSeconds: 25,
  timeBankSeconds: 60,
  runItTwiceEnabled: false,
  rakePercent: 0,
  rakeCap: 0,
  noFlopNoDrop: true,
  isPrivate: false,
  disableChatInHand: false,
};

const meta = (name: string, isGuest = false) => ({ displayName: name, isGuest, avatarSeed: 's', clientSeed: `c-${name}` });

/** Small deterministic PRNG — Math.random is banned repo-wide (see eslint.config.mjs). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function cents(s: string): number {
  const neg = s.startsWith('-');
  return (neg ? -1 : 1) * Math.round(Number(s.replace(/[+\-$,]/g, '')) * 100);
}

describe('settle(): who pays whom', () => {
  it('clears every debt with at most n−1 payments, biggest loser to biggest winner', () => {
    const payments = settle(
      new Map([
        ['Ann', 4500],
        ['Ben', 1500],
        ['Cat', -3000],
        ['Dan', -2000],
        ['Eve', -1000],
      ]),
    );
    expect(payments).toEqual([
      { from: 'Cat', to: 'Ann', amount: 3000 },
      { from: 'Dan', to: 'Ann', amount: 1500 },
      // Eve now owes more (1000) than Dan has left (500), so she pays next.
      { from: 'Eve', to: 'Ben', amount: 1000 },
      { from: 'Dan', to: 'Ben', amount: 500 },
    ]);
    expect(payments.length).toBeLessThanOrEqual(4);
  });

  it('pays nothing when nobody is up or down', () => {
    expect(settle(new Map([['Ann', 0]]))).toEqual([]);
  });
});

describe('Game book: accurate after every hand', () => {
  let store: MemoryStore;
  let table: LiveTable;
  let vacated: VacatedSeat[];

  beforeEach(() => {
    vi.useFakeTimers();
    store = new MemoryStore();
    vacated = [];
    table = new LiveTable('11111111-1111-1111-1111-111111111111', 'Dime Game', SETTINGS, store, {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
      onSeatsVacated: (_t, v) => vacated.push(...v),
    });
  });

  afterEach(() => {
    table.dispose();
    vi.useRealTimers();
  });

  /** `midHand` runs once something mid-hand is due: it's retried every action until it returns true (done). */
  async function playHand(rand: () => number, midHand?: () => boolean): Promise<void> {
    vi.advanceTimersByTime(10_000); // post-hand break
    table.prepareNextOrbit();
    table.startNextHand();
    expect(table.state.phase).toBe('in-hand');
    let midHandDone = false;
    for (let guard = 0; table.state.phase === 'in-hand' && guard < 400; guard++) {
      if (!midHandDone && midHand && guard >= 2) midHandDone = midHand();
      if (table.state.phase !== 'in-hand') break;
      const seatId = table.state.betting.actingSeat!;
      const live = table.seats[seatId]!;
      if (live.botPolicyName || live.pendingRemoval) {
        await vi.advanceTimersByTimeAsync(7000);
        continue;
      }
      const legal = table.projectionFor(seatId).legalActions!;
      const r = rand();
      if (r < 0.15 && legal.canFold && !legal.canCheck) table.applyPlayerAction(seatId, { seatId, type: 'fold' });
      else if (r < 0.35 && legal.canRaise) table.applyPlayerAction(seatId, { seatId, type: 'raise', amountTo: legal.minRaiseTo });
      else if (r < 0.35 && legal.canBet) table.applyPlayerAction(seatId, { seatId, type: 'bet', amountTo: legal.minBet });
      else if (legal.canCheck) table.applyPlayerAction(seatId, { seatId, type: 'check' });
      else table.applyPlayerAction(seatId, { seatId, type: 'call' });
    }
    expect(table.state.phase).toBe('hand-complete');
  }

  function report(): GameReport {
    return table.book.toReport();
  }

  it('books a simple game exactly: buy-ins, one hand, cash-outs, standings, settlement', async () => {
    table.takeSeat(0, 'ann', meta('Ann'), 1000);
    table.takeSeat(1, 'ben', meta('Ben', true), 1000);
    vi.advanceTimersByTime(10_000);
    table.startNextHand();
    // Whoever acts first folds: the other wins exactly the small blind they posted.
    const folder = table.state.betting.actingSeat!;
    table.applyPlayerAction(folder, { seatId: folder, type: 'fold' });
    const winner = folder === 0 ? 1 : 0;
    const r = report();
    expect(r.game.hands_played).toBe(1);
    expect(r.hands[0]!.results).toEqual({ [winner === 0 ? 'Ann' : 'Ben']: '+$0.10', [folder === 0 ? 'Ann' : 'Ben']: '-$0.10' });
    expect(r.hands[0]!.reconciled_with_table).toBe(true);
    expect(r.summary.books_balance).toBe(true);
    expect(r.summary.total_bought_in).toBe('$20');
    expect(r.standings[0]).toMatchObject({ rank: 1, player: winner === 0 ? 'Ann' : 'Ben', net_result: '+$0.10', hands_won: 1 });
    expect(r.standings.find((s) => s.player === 'Ben')?.type).toBe('guest');
    expect(r.settlements.payments).toEqual([{ from: folder === 0 ? 'Ann' : 'Ben', to: winner === 0 ? 'Ann' : 'Ben', amount: '$0.10' }]);

    // Saved after the hand, as readable YAML that parses back to the same report.
    await vi.runAllTimersAsync();
    const saved = await store.latestGameReportForTable(table.tableId);
    expect(saved?.status).toBe('live');
    expect(saved?.lastHandNumber).toBe(1);
    expect((parse(saved!.reportYaml) as GameReport).summary.books_balance).toBe(true);
    // ...with the structured summary the dashboard lists by: cents, ranked, account ids for registered players only.
    expect(saved?.summary).toMatchObject({ gameNumber: 1, stakes: '$0.10/$0.20', playerCount: 2, totalBoughtIn: 2000, totalCashedOut: 0, stillOnTable: 2000, booksBalance: true });
    expect(saved?.summary?.players.map((p) => [p.rank, p.playerName, p.userId, p.playerType, p.net])).toEqual([
      [1, winner === 0 ? 'Ann' : 'Ben', winner === 0 ? 'ann' : null, winner === 0 ? 'registered' : 'guest', 10],
      [2, folder === 0 ? 'Ann' : 'Ben', folder === 0 ? 'ann' : null, folder === 0 ? 'registered' : 'guest', -10],
    ]);

    // Closing the table cashes everyone out in the book and marks it final.
    await table.closeBook('table terminated by the owner');
    const final = (parse((await store.getGameReport(table.book.id))!.reportYaml) as GameReport);
    expect(final.game.status).toBe('final');
    expect(final.summary.still_on_table).toBe('$0');
    expect(final.summary.total_cashed_out).toBe('$20');
    expect(final.money_movements.filter((m) => m.type === 'cash-out')).toHaveLength(2);
  });

  it('stays exact through a long, messy game: mid-hand rebuys, joins, removals, leavers, a bot, blind changes', async () => {
    const rand = lcg(20261013);
    let boughtIn = 0;
    const buy = (seat: number, id: string, name: string, amount: number, guest = false): void => {
      table.takeSeat(seat, id, meta(name, guest), amount);
      boughtIn += amount;
    };
    buy(0, 'ann', 'Ann', 2000);
    buy(1, 'ben', 'Ben', 1500, true);
    buy(2, 'cat', 'Cat', 3000);
    table.addBot(3, 'calling-station', 2500);
    const botBuyIn = 2500;
    let cashedOut = 0;
    let leaversBooked = 0;

    for (let hand = 1; hand <= 40; hand++) {
      await playHand(rand, () => {
        const acting = table.state.betting.actingSeat;
        switch (hand % 8) {
          case 1: {
            // Rebuy for whoever is in the hand (pending) and whoever folded (immediate).
            for (const s of table.state.seats) {
              const live = table.seats[s.seatId]!;
              if (!live.userId || live.pendingRemoval) continue;
              const headroom = table.rebuyHeadroom(s.seatId);
              const amount = Math.min(300, headroom);
              if (amount > 0) {
                table.addChips(s.seatId, amount);
                boughtIn += amount;
              }
            }
            break;
          }
          case 2:
            if (table.state.seats[4]?.status === 'empty') buy(4, 'dan', 'Dan', 1200);
            break;
          case 3:
            table.updateSettings({ smallBlind: hand % 2 === 0 ? 10 : 25, bigBlind: hand % 2 === 0 ? 20 : 50 });
            break;
          case 4: {
            // Remove someone still in the hand (not the one acting, so the removal waits).
            const target = table.state.seats.find((s) => s.seatId !== acting && table.seats[s.seatId]?.userId && s.status === 'active');
            if (target) table.removeSeatOccupant(target.seatId, false);
            break;
          }
          case 5: {
            // A player who has already put chips in folds and walks away
            // mid-hand — that loss must still be booked for them.
            if (acting === null || !table.seats[acting]?.userId || table.seats[acting]?.pendingRemoval) return false;
            if ((table.state.seats[acting]?.committedThisHand ?? 0) === 0) return false;
            table.applyPlayerAction(acting, { seatId: acting, type: 'fold' });
            cashedOut += table.leaveSeat(acting)?.stack ?? 0;
            leaversBooked += 1;
            break;
          }
          default:
            break;
        }
        return true;
      });
      cashedOut += vacated.splice(0).reduce((sum, v) => sum + (v.userId ? v.refund : 0), 0);
      // Re-seat anyone who left, so the game keeps going.
      for (const [seat, id, name] of [
        [0, 'ann', 'Ann'],
        [1, 'ben', 'Ben'],
        [2, 'cat', 'Cat'],
      ] as const) {
        if (table.state.seats[seat]?.status === 'empty' && table.seatOfUser(id) === null) buy(seat, id, name, 1000);
      }
      // Busted players rebuy between hands.
      for (const s of table.state.seats) {
        if (table.seats[s.seatId]?.userId && s.stack === 0 && table.seats[s.seatId]!.pendingChips === 0) {
          table.addChips(s.seatId, 1000);
          boughtIn += 1000;
        }
      }

      const r = report();
      expect(r.hands[r.hands.length - 1]!.reconciled_with_table, `hand #${String(hand)} reconciled`).toBe(true);
      expect(r.summary.books_balance, `books balance after hand #${String(hand)}`).toBe(true);
      // Every hand's results sum to zero.
      const last = r.hands[r.hands.length - 1]!;
      expect(Object.values(last.results).reduce((sum, v) => sum + cents(v), 0)).toBe(0);
    }

    // Close the game: everyone is cashed out at exactly what the table refunds.
    const humansSeated = table.seats.filter((s) => s.userId).map((s) => s.seatId);
    const closingRefunds = humansSeated.reduce((sum, seatId) => sum + table.voidedHandRefund(seatId), 0);
    await table.closeBook('table terminated by the owner');
    cashedOut += closingRefunds;

    const r = report();
    expect(r.game.status).toBe('final');
    expect(r.summary.hands_reconciled_with_table).toBe('40 of 40');
    // The book's totals equal the money that actually moved, to the cent.
    const humanRows = r.standings.filter((s) => s.type !== 'computer (play chips)');
    expect(humanRows.reduce((sum, s) => sum + cents(s.bought_in), 0)).toBe(boughtIn);
    expect(humanRows.reduce((sum, s) => sum + cents(s.cashed_out), 0)).toBe(cashedOut);
    expect(cents(r.summary.total_bought_in)).toBe(boughtIn + botBuyIn);
    expect(r.summary.still_on_table).toBe('$0');
    // Everyone's results (bot included) sum to zero, and settlement pays out exactly the winners' winnings.
    expect(r.standings.reduce((sum, s) => sum + cents(s.net_result), 0)).toBe(0);
    const winnings = r.standings.filter((s) => cents(s.net_result) > 0 && s.type !== 'computer (play chips)').reduce((sum, s) => sum + cents(s.net_result), 0);
    const paidToHumans = r.settlements.payments.filter((p) => p.to !== 'Computer players').reduce((sum, p) => sum + cents(p.amount), 0);
    expect(paidToHumans).toBe(winnings);
    // Rankings are by net result.
    const nets = r.standings.map((s) => cents(s.net_result));
    expect([...nets].sort((a, b) => b - a)).toEqual(nets);
    expect(r.hands.map((h) => h.hand)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(leaversBooked, 'the scenario really exercised mid-hand leavers').toBeGreaterThanOrEqual(3);

    // The structured summary agrees with the report to the cent — and the
    // backfill's YAML parser recovers exactly the same numbers.
    const summary = table.book.summary();
    expect(summary.totalBoughtIn).toBe(boughtIn + botBuyIn);
    expect(summary.players.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    expect(summary.players.map((p) => p.playerName)).toEqual(r.standings.map((s) => s.player));
    const fromYaml = summaryFromReport(parse(table.book.toYaml()) as GameReport);
    expect(fromYaml).toEqual({ ...summary, players: summary.players.map((p) => ({ ...p, userId: null })) });

    // And it renders to a real PDF.
    const pdf = await renderReportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it('a reset ends the game (final report, hand voided, everything refunded) and the next buy-in starts a new one', async () => {
    table.takeSeat(0, 'ann', meta('Ann'), 1000);
    table.takeSeat(1, 'ben', meta('Ben'), 1000);
    await playHand(lcg(1));
    const firstId = table.book.id;
    vi.advanceTimersByTime(10_000);
    table.startNextHand();
    table.resetTable();
    await vi.runAllTimersAsync();

    const first = parse((await store.getGameReport(firstId))!.reportYaml) as GameReport;
    expect(first.game.status).toBe('final');
    expect(first.game.hands_voided?.[0]?.hand).toBe(2);
    expect(first.summary.total_cashed_out).toBe('$20'); // the voided hand's blinds came back too
    expect(first.summary.books_balance).toBe(true);

    expect(table.book.id).not.toBe(firstId);
    expect(table.book.gameNumber).toBe(2);
    table.takeSeat(0, 'ann', meta('Ann'), 700);
    expect(table.book.toReport().summary.total_bought_in).toBe('$7');
  });
});

describe('Report summaries for reports saved before they existed', () => {
  it('parses money back to cents', () => {
    expect(moneyToCents('$1,250.50')).toBe(125_050);
    expect(moneyToCents('+$0.10')).toBe(10);
    expect(moneyToCents('-$5')).toBe(-500);
    expect(moneyToCents('$0')).toBe(0);
    expect(() => moneyToCents('5 dollars')).toThrow();
  });

  it('backfills a summary from the stored YAML, once', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const table = new LiveTable('22222222-2222-2222-2222-222222222222', 'Old Game', SETTINGS, store, {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
    table.takeSeat(0, 'ann', meta('Ann'), 1000);
    table.takeSeat(1, 'ben', meta('Ben'), 1500);
    vi.advanceTimersByTime(10_000);
    table.startNextHand();
    const folder = table.state.betting.actingSeat!;
    table.applyPlayerAction(folder, { seatId: folder, type: 'fold' });
    await vi.runAllTimersAsync();
    const saved = (await store.getGameReport(table.book.id))!;
    await store.saveGameReport({ ...saved, summary: null }); // as if saved before migration 0005

    const logs: string[] = [];
    await backfillGameReportSummaries(store, (m) => logs.push(m));
    const [listed] = await store.listGameReports();
    expect(listed?.summary).toMatchObject({ totalBoughtIn: 2500, playerCount: 2, booksBalance: true });
    expect(listed?.summary?.players.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    expect(logs).toEqual(['Backfilled summaries for 1 game report(s).']);
    await backfillGameReportSummaries(store, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    table.dispose();
    vi.useRealTimers();
  });

  it('on boot, marks a game the server stopped under (still "live") final, with its numbers untouched', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const table = new LiveTable('33333333-3333-3333-3333-333333333333', 'Crashed Game', SETTINGS, store, {
      onBroadcast: () => undefined,
      onChipsSettled: async () => Promise.resolve(),
      now: () => Date.now(),
    });
    table.takeSeat(0, 'ann', meta('Ann'), 1000);
    table.takeSeat(1, 'ben', meta('Ben'), 1000);
    vi.advanceTimersByTime(10_000);
    table.startNextHand();
    const folder = table.state.betting.actingSeat!;
    table.applyPlayerAction(folder, { seatId: folder, type: 'fold' });
    await vi.runAllTimersAsync();
    table.dispose(); // the process "dies" here: no closeBook
    const before = (await store.getGameReport(table.book.id))!;
    expect(before.status).toBe('live');

    const logs: string[] = [];
    await finishInterruptedGameReports(store, (m) => logs.push(m));
    const after = (await store.getGameReport(table.book.id))!;
    expect(after.status).toBe('final');
    expect(after.endedAt).toEqual(before.updatedAt);
    expect(after.summary).toEqual(before.summary);
    const r = parse(after.reportYaml) as GameReport;
    expect(r.game.status).toBe('final');
    expect(r.game.ended_because).toBe(INTERRUPTED_REASON);
    expect(r.summary.still_on_table).toBe('$20');
    expect(logs).toEqual(['Marked 1 interrupted game report(s) final.']);
    await finishInterruptedGameReports(store, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('Report download routes', () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let registry: TableRegistry;

  beforeEach(async () => {
    store = new MemoryStore();
    registry = new TableRegistry(store, () => undefined);
    app = Fastify();
    await app.register(cookie);
    registerReportRoutes(app, store, registry);
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the live report as YAML or PDF to the admin only, named with the hand number and time', async () => {
    const admin = await store.createGuestUser('Owner');
    await store.setUserRole(admin.id, 'admin');
    const adminToken = issueAccessToken((await store.findUserById(admin.id))!);
    const player = await store.createGuestUser('Pat');
    const table = await registry.createTable('Friday Dime Game', SETTINGS, null, null);

    const before = await app.inject({ method: 'GET', url: `/admin/tables/${table.tableId}/report`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(before.statusCode).toBe(404);

    table.takeSeat(0, 'ann', meta('Ann'), 1000);
    table.takeSeat(1, 'ben', meta('Ben'), 1000);
    table.startNextHand();
    const folder = table.state.betting.actingSeat!;
    table.applyPlayerAction(folder, { seatId: folder, type: 'fold' });

    const denied = await app.inject({ method: 'GET', url: `/admin/tables/${table.tableId}/report`, headers: { authorization: `Bearer ${issueAccessToken(player)}` } });
    expect(denied.statusCode).toBe(403);

    const yamlRes = await app.inject({ method: 'GET', url: `/admin/tables/${table.tableId}/report?format=yaml`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(yamlRes.statusCode).toBe(200);
    expect(yamlRes.headers['content-type']).toContain('application/yaml');
    expect(yamlRes.headers['content-disposition']).toMatch(/attachment; filename="friday-dime-game_game-1_hand-1_\d{4}-\d{2}-\d{2}_\d{4}-UTC\.yaml"/);
    expect((parse(yamlRes.body) as GameReport).game.hands_played).toBe(1);

    const pdfRes = await app.inject({ method: 'GET', url: `/admin/tables/${table.tableId}/report?format=pdf`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const list = await app.inject({ method: 'GET', url: '/admin/reports', headers: { authorization: `Bearer ${adminToken}` } });
    const reports = list.json<{ reports: { id: string; tableName: string; handsPlayed: number }[] }>().reports;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ tableName: 'Friday Dime Game', handsPlayed: 1 });

    const bad = await app.inject({ method: 'GET', url: `/admin/reports/${reports[0]!.id}?format=docx`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(bad.statusCode).toBe(400);
    table.dispose();
  });
});

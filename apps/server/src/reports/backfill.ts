import { parse, stringify } from 'yaml';
import type { GameReportSummary, Store } from '../db/store.js';
import type { GameReport } from '../game/gameBook.js';

/** "$1,250.50", "+$5", "-$0.10" (formatMoney's output, optionally signed) back to integer cents. */
export function moneyToCents(text: string): number {
  const match = /^([+-]?)\$([\d,]+)(?:\.(\d{2}))?$/.exec(text.trim());
  if (!match) throw new Error(`Not a money amount: ${text}`);
  const cents = Number((match[2] ?? '0').replace(/,/g, '')) * 100 + Number(match[3] ?? '0');
  return match[1] === '-' ? -cents : cents;
}

/**
 * A stored report's structured summary, recovered from its YAML — for
 * reports saved before game_reports had summary columns (migration 0005).
 * Account ids were never in the YAML, so those rows' players have none.
 */
export function summaryFromReport(report: GameReport): GameReportSummary {
  const lastHand = report.hands[report.hands.length - 1];
  return {
    gameNumber: report.game.game_number_at_table,
    stakes: lastHand ? lastHand.blinds.replace(/ ante .*$/, '') : '',
    playerCount: report.summary.players,
    totalBoughtIn: moneyToCents(report.summary.total_bought_in),
    totalCashedOut: moneyToCents(report.summary.total_cashed_out),
    stillOnTable: moneyToCents(report.summary.still_on_table),
    booksBalance: report.summary.books_balance,
    players: report.standings.map((s) => ({
      rank: s.rank,
      playerName: s.player,
      userId: null,
      playerType: s.type.startsWith('computer') ? 'bot' : s.type === 'guest' ? 'guest' : 'registered',
      boughtIn: moneyToCents(s.bought_in),
      buyInCount: s.buy_in_count,
      cashedOut: moneyToCents(s.cashed_out),
      onTable: moneyToCents(s.on_table),
      net: moneyToCents(s.net_result),
      handsPlayed: s.hands_played,
      handsWon: s.hands_won,
    })),
  };
}

/** Fills in the summary columns of any report saved before they existed. Runs on boot; a no-op once done. */
export async function backfillGameReportSummaries(store: Store, log: (msg: string) => void): Promise<void> {
  const missing = (await store.listGameReports()).filter((r) => r.summary === null);
  for (const { id } of missing) {
    const record = await store.getGameReport(id);
    if (!record) continue;
    try {
      await store.saveGameReport({ ...record, summary: summaryFromReport(parse(record.reportYaml) as GameReport) });
    } catch (err) {
      log(`Could not backfill game report ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (missing.length > 0) log(`Backfilled summaries for ${String(missing.length)} game report(s).`);
}

export const INTERRUPTED_REASON = 'the server stopped before this game was closed (chips listed as on the table were not cashed out through the table)';

/**
 * At boot no table exists yet, so any report still marked live belongs to
 * a game the server stopped under without closing (a crash, or a restart
 * from before shutdowns closed tables properly). Marks each one final as
 * of its last update and says why, so it doesn't read "live" forever.
 * Its numbers are left exactly as they were.
 */
export async function finishInterruptedGameReports(store: Store, log: (msg: string) => void): Promise<void> {
  const live = (await store.listGameReports()).filter((r) => r.status === 'live');
  for (const { id } of live) {
    const record = await store.getGameReport(id);
    if (!record) continue;
    try {
      const report = parse(record.reportYaml) as GameReport;
      const game = { ...report.game };
      delete game.ended_because;
      delete game.ended_at;
      const endedAt = record.updatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const finished: GameReport = {
        ...report,
        game: { ...game, status: 'final', ended_because: INTERRUPTED_REASON, ended_at: endedAt },
        settlements: { ...report.settlements, basis: 'the results when the game stopped (chips still on the table count for their owners)' },
      };
      await store.saveGameReport({ ...record, status: 'final', endedAt: record.updatedAt, reportYaml: stringify(finished, { lineWidth: 0 }) });
    } catch (err) {
      log(`Could not finish interrupted game report ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (live.length > 0) log(`Marked ${String(live.length)} interrupted game report(s) final.`);
}

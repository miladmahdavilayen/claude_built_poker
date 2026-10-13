import type { FastifyInstance, FastifyReply } from 'fastify';
import { parse } from 'yaml';
import type { GameReportRecord, Store } from '../../db/store.js';
import type { GameReport } from '../../game/gameBook.js';
import type { TableRegistry } from '../../game/tableRegistry.js';
import { renderReportPdf } from '../../reports/reportPdf.js';
import { requireAdmin } from '../middleware.js';

type Format = 'yaml' | 'pdf';

function formatOf(query: unknown): Format | null {
  const f = (query as { format?: string } | undefined)?.format ?? 'yaml';
  return f === 'yaml' || f === 'pdf' ? f : null;
}

/** "friday-dime-game_game-1_hand-12_2026-10-13_2105-UTC.pdf" — the table, game, exact hand and time it's as of. */
export function reportFilename(report: GameReport, format: Format): string {
  const slug =
    report.game.table.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'table';
  const lastHand = report.hands[report.hands.length - 1];
  const at = (lastHand?.ended_at ?? report.game.report_generated_at).replace(/:\d{2}Z$/, '').replace('T', '_').replace(':', '');
  const hand = lastHand ? `hand-${String(lastHand.hand)}` : 'no-hands';
  return `${slug}_game-${String(report.game.game_number_at_table)}_${hand}_${at}-UTC${report.game.status === 'final' ? '_final' : ''}.${format}`;
}

async function send(reply: FastifyReply, report: GameReport, yamlText: string, format: Format): Promise<void> {
  const filename = reportFilename(report, format);
  void reply.header('Content-Disposition', `attachment; filename="${filename}"`).header('Cache-Control', 'no-store');
  if (format === 'yaml') {
    await reply.type('application/yaml; charset=utf-8').send(yamlText);
    return;
  }
  await reply.type('application/pdf').send(await renderReportPdf(report));
}

/**
 * Admin-only downloads of a game's books (see src/game/gameBook.ts), as
 * the stored YAML or a rendered PDF. A table that's still running is
 * reported from its live in-memory book, so a download mid-game is exact
 * up to the last completed hand (and any buy-ins/cash-outs since); a
 * finished game comes from its stored YAML, kept forever.
 */
export function registerReportRoutes(app: FastifyInstance, store: Store, registry: TableRegistry): void {
  app.get('/admin/reports', { preHandler: requireAdmin }, async () => {
    return { reports: await store.listGameReports() };
  });

  /** The report for a table's current game — or, between games (e.g. right after a reset), its most recent one. */
  app.get('/admin/tables/:tableId/report', { preHandler: requireAdmin }, async (req, reply) => {
    const format = formatOf(req.query);
    if (!format) return reply.code(400).send({ code: 'INVALID_FORMAT', message: 'format must be yaml or pdf.' });
    const { tableId } = req.params as { tableId: string };
    const live = registry.get(tableId);
    if (live && live.book.handsPlayed > 0) {
      const now = new Date();
      return send(reply, live.book.toReport(now), live.book.toYaml(now), format);
    }
    const stored = await store.latestGameReportForTable(tableId);
    if (!stored) return reply.code(404).send({ code: 'NO_REPORT', message: 'No hand has been played at this table yet.' });
    return sendStored(reply, stored, format);
  });

  app.get('/admin/reports/:reportId', { preHandler: requireAdmin }, async (req, reply) => {
    const format = formatOf(req.query);
    if (!format) return reply.code(400).send({ code: 'INVALID_FORMAT', message: 'format must be yaml or pdf.' });
    const { reportId } = req.params as { reportId: string };
    const stored = await store.getGameReport(reportId);
    if (!stored) return reply.code(404).send({ code: 'NO_REPORT', message: 'Report not found.' });
    const live = registry.get(stored.tableId);
    if (live && live.book.id === reportId) {
      const now = new Date();
      return send(reply, live.book.toReport(now), live.book.toYaml(now), format);
    }
    return sendStored(reply, stored, format);
  });

  function sendStored(reply: FastifyReply, stored: GameReportRecord, format: Format): Promise<void> {
    return send(reply, parse(stored.reportYaml) as GameReport, stored.reportYaml, format);
  }
}

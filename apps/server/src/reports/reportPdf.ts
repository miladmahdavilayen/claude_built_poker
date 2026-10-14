import PDFDocument from 'pdfkit';
import type { GameReport } from '../game/gameBook.js';

/**
 * Renders a game report (the same data as its YAML — see gameBook.ts's
 * toReport) as a readable PDF: who's up and down at a glance, who pays
 * whom, then every buy-in/cash-out and every hand for the record. Built
 * with pdfkit's standard Helvetica (no font files to ship); text stays
 * within its WinAnsi character set.
 */

const PAGE_MARGIN = 40;
const INK = '#1f2933';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const ACCENT = '#b7791f';
const GOOD = '#15803d';
const BAD = '#b91c1c';
const BAND = '#0b5d3b';

interface Column<T> {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
  value: (row: T) => string;
  color?: (row: T) => string;
}

/** "2026-10-13 00:30" — every time in the report is UTC, said once in the header rather than on every line. */
function when(isoString: string): string {
  return isoString.replace('T', ' ').replace(/:\d{2}Z$/, '').replace(/Z$/, '');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function netColor(net: string): string {
  if (net.startsWith('+')) return GOOD;
  if (net.startsWith('-')) return BAD;
  return INK;
}

export function renderReportPdf(report: GameReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: { Title: `Game report — ${report.game.table.name}`, Author: 'pokerclause', Subject: report.game.as_of },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;
  const bottom = (): number => doc.page.height - PAGE_MARGIN - 20;

  const ensureRoom = (height: number): void => {
    if (doc.y + height > bottom()) doc.addPage();
  };

  const sectionTitle = (title: string, subtitle?: string): void => {
    ensureRoom(60);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(title, left, doc.y);
    if (subtitle) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(subtitle, left, doc.y + 1, { width });
    doc.moveDown(0.4);
  };

  function table<T>(columns: Column<T>[], rows: readonly T[], emptyText: string): void {
    const fontSize = 8.5;
    const pad = 4;
    const drawHeader = (): void => {
      const y = doc.y;
      doc.rect(left, y, width, 16).fill('#f3f4f6');
      let x = left;
      doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(MUTED);
      for (const c of columns) {
        doc.text(c.header, x + pad, y + 4, { width: c.width - pad * 2, align: c.align ?? 'left', lineBreak: false });
        x += c.width;
      }
      doc.y = y + 18;
    };
    if (rows.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(fontSize).fillColor(MUTED).text(emptyText, left, doc.y);
      return;
    }
    ensureRoom(40);
    drawHeader();
    rows.forEach((row, i) => {
      doc.font('Helvetica').fontSize(fontSize);
      const heights = columns.map((c) => doc.heightOfString(c.value(row) || ' ', { width: c.width - pad * 2 }));
      const rowHeight = Math.max(...heights) + pad * 2;
      if (doc.y + rowHeight > bottom()) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(left, y, width, rowHeight).fill('#fafafa');
      let x = left;
      for (const c of columns) {
        doc
          .font('Helvetica')
          .fontSize(fontSize)
          .fillColor(c.color?.(row) ?? INK)
          .text(c.value(row), x + pad, y + pad, { width: c.width - pad * 2, align: c.align ?? 'left' });
        x += c.width;
      }
      doc.moveTo(left, y + rowHeight).lineTo(left + width, y + rowHeight).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.y = y + rowHeight;
    });
  }

  // ---- Header band ----
  const g = report.game;
  doc.rect(0, 0, doc.page.width, 92).fill(BAND);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text(g.table.name, left, 24, { width: width - 110 });
  doc.font('Helvetica').fontSize(10).fillColor('#d1fae5').text(`Game report  |  game #${String(g.game_number_at_table)} at this table`, left, 52);
  doc.font('Helvetica').fontSize(9).fillColor('#d1fae5').text(`${capitalize(g.as_of.replace(/\((.*)\)/, (_m, t: string) => `(${when(t)})`))}  |  all times UTC`, left, 67);
  const statusLabel = g.status === 'final' ? 'FINAL' : 'LIVE';
  doc.roundedRect(left + width - 90, 30, 90, 26, 6).fill(g.status === 'final' ? '#ffffff' : ACCENT);
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(g.status === 'final' ? BAND : '#ffffff')
    .text(statusLabel, left + width - 90, 37, { width: 90, align: 'center' });
  doc.y = 108;

  // ---- Game facts ----
  const facts: [string, string][] = [
    ['Started', when(g.started_at)],
    ['Ended', g.ended_at ? `${when(g.ended_at)}${g.ended_because ? ` (${g.ended_because})` : ''}` : 'still in progress'],
    ['Hands played', String(g.hands_played)],
    ['Players', `${String(report.summary.players)}${report.summary.computer_players > 0 ? ` + ${String(report.summary.computer_players)} computer` : ''}`],
  ];
  if (g.hands_voided?.length) facts.push(['Voided hands', g.hands_voided.map((v) => `#${String(v.hand)} (${v.reason})`).join('; ')]);
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, left, y, { width: 90 });
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(v, left + 90, y, { width: width - 90 });
    doc.moveDown(0.15);
  }

  // ---- Summary boxes ----
  doc.moveDown(0.6);
  const s = report.summary;
  const boxes: [string, string][] = [
    ['Total bought in', s.total_bought_in],
    ['Total cashed out', s.total_cashed_out],
    ['Still on table', s.still_on_table],
  ];
  const boxW = (width - 20) / 3;
  const boxY = doc.y;
  boxes.forEach(([label, value], i) => {
    const x = left + i * (boxW + 10);
    doc.roundedRect(x, boxY, boxW, 46, 6).lineWidth(1).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label, x + 10, boxY + 9, { width: boxW - 20 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(value, x + 10, boxY + 22, { width: boxW - 20 });
  });
  doc.y = boxY + 56;
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(s.books_balance ? GOOD : BAD)
    .text(s.books_balance ? 'Books balance' : 'Books DO NOT balance', left, doc.y, { continued: true })
    .font('Helvetica')
    .fillColor(MUTED)
    .text(`  —  ${s.balance_check}. Checked against the table's real chip stacks after every hand: ${s.hands_reconciled_with_table} hands matched.`);
  if (s.hands_not_reconciled?.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BAD).text(`Hands that did not match the table: ${s.hands_not_reconciled.map((n) => `#${String(n)}`).join(', ')}`);
  }

  // ---- Standings ----
  sectionTitle('Rankings and profit / loss', 'Net = cashed out + still on table - bought in. Players still seated count the chips in front of them.');
  type Standing = GameReport['standings'][number];
  table<Standing>(
    [
      { header: '#', width: 22, align: 'center', value: (r) => String(r.rank) },
      { header: 'Player', width: 120, value: (r) => `${r.player}${r.type !== 'registered' ? `\n${r.type}` : ''}` },
      { header: 'Bought in', width: 66, align: 'right', value: (r) => `${r.bought_in}${r.buy_in_count > 1 ? `\n(${String(r.buy_in_count)}x)` : ''}` },
      { header: 'Cashed out', width: 66, align: 'right', value: (r) => r.cashed_out },
      { header: 'On table', width: 62, align: 'right', value: (r) => r.on_table },
      { header: 'Net', width: 66, align: 'right', value: (r) => r.net_result, color: (r) => netColor(r.net_result) },
      { header: 'Hands', width: 40, align: 'right', value: (r) => String(r.hands_played) },
      { header: 'Won', width: 34, align: 'right', value: (r) => String(r.hands_won) },
      { header: 'Best pot', width: width - 476, align: 'right', value: (r) => r.biggest_pot_won },
    ],
    report.standings,
    'Nobody has bought in yet.',
  );

  // ---- Settlements ----
  sectionTitle('Settle up', `Based on ${report.settlements.basis}. ${capitalize(report.settlements.method)}.`);
  if (report.settlements.payments.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text('Nothing to settle — nobody is up or down.', left, doc.y);
  } else {
    for (const p of report.settlements.payments) {
      ensureRoom(18);
      const y = doc.y;
      doc.circle(left + 5, y + 5, 2.5).fill(ACCENT);
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(INK)
        .text(p.from, left + 14, y, { continued: true })
        .font('Helvetica')
        .text('  pays  ', { continued: true })
        .font('Helvetica-Bold')
        .text(p.to, { continued: true })
        .font('Helvetica')
        .text('   ', { continued: true })
        .font('Helvetica-Bold')
        .fillColor(ACCENT)
        .text(p.amount);
      doc.moveDown(0.25);
    }
  }
  if (report.settlements.note) doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(report.settlements.note, left, doc.y + 2, { width });

  // ---- Money movements ----
  sectionTitle('Money in and out', 'Every buy-in, rebuy and cash-out, in order.');
  type Movement = GameReport['money_movements'][number];
  table<Movement>(
    [
      { header: 'Time (UTC)', width: 92, value: (m) => when(m.at) },
      { header: 'After hand', width: 56, align: 'center', value: (m) => (m.after_hand === 0 ? 'start' : `#${String(m.after_hand)}`) },
      { header: 'Player', width: 100, value: (m) => m.player },
      { header: 'Type', width: 56, value: (m) => m.type },
      {
        header: 'Amount',
        width: 64,
        align: 'right',
        value: (m) => (m.amount === '$0' ? '$0' : m.type === 'cash-out' ? `-${m.amount}` : `+${m.amount}`),
        color: (m) => (m.amount === '$0' ? INK : m.type === 'cash-out' ? BAD : GOOD),
      },
      { header: 'Note', width: width - 368, value: (m) => m.note ?? '' },
    ],
    report.money_movements,
    'No money has moved yet.',
  );

  // Hand-by-hand detail stays in the YAML (the permanent record); the PDF
  // is the readable summary: buy-ins, rankings, settlements.
  doc.moveDown(1);
  ensureRoom(14);
  doc
    .font('Helvetica-Oblique')
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(`Hand-by-hand results for all ${String(g.hands_played)} hands are in the YAML version of this report.`, left, doc.y, { width });

  // ---- Footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits below the bottom margin; pdfkit adds a whole new
    // page for any text past it unless the margin is lifted while drawing.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - PAGE_MARGIN + 6;
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`${report.game.table.name}  |  generated ${when(report.game.report_generated_at)}  |  game id ${report.game.id}`, left, footerY, {
        width: width - 60,
        lineBreak: false,
      })
      .text(`Page ${String(i + 1)} of ${String(range.count)}`, left + width - 60, footerY, { width: 60, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }

  doc.end();
  return done;
}

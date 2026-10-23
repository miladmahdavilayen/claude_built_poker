import PDFDocument from 'pdfkit';
import { WAIVER_INTRO, WAIVER_TERMS, WAIVER_TITLE } from '@pokerclause/shared';

/**
 * The signed friendly-game waiver as a PDF, built the moment it's signed
 * and kept forever (see the signed_waivers table): the exact text that was
 * on screen (from @pokerclause/shared — the same source the page renders),
 * the player's initials and drawn signature, and the details of the
 * signing — when, from which IP address, on what device. Standard
 * Helvetica, like the game reports: no font files to ship.
 */

export interface SignedWaiverDetails {
  id: string;
  version: number;
  displayName: string;
  email: string | null;
  initials: string;
  signedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  /** What the browser reported about itself — labelled as reported in the document. */
  device: { platform?: string | undefined; language?: string | undefined; timeZone?: string | undefined; screen?: string | undefined; touch?: boolean | undefined };
  signaturePng: Buffer;
  signatureSha256: string;
}

const MARGIN = 50;
const INK = '#1f2933';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const BAND = '#0b5d3b';
const GOLD = '#b7791f';

/** "2026-10-23 18:05:12 UTC" */
function utc(d: Date): string {
  return `${d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
}

export function renderSignedWaiverPdf(w: SignedWaiverDetails): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    info: {
      Title: `${WAIVER_TITLE} — signed by ${w.displayName}`,
      Author: 'PokerClause',
      Subject: `Signed waiver ${w.id}`,
      CreationDate: w.signedAt,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const width = doc.page.width - MARGIN * 2;

  // Header band.
  doc.rect(0, 0, doc.page.width, 78).fill(BAND);
  doc.fillColor('#f2bd4d').font('Helvetica-Bold').fontSize(22).text('PokerClause', MARGIN, 24);
  doc.fillColor('#e8ecf1').font('Helvetica').fontSize(11).text(`${WAIVER_TITLE} — signed copy`, MARGIN, 50);
  doc.fillColor('#e8ecf1').fontSize(9).text(`Version ${String(w.version)}`, MARGIN, 52, { width, align: 'right' });

  // The agreement, word for word.
  doc.y = 104;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(WAIVER_TITLE, MARGIN, doc.y, { width });
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(11);
  for (const p of WAIVER_INTRO) {
    doc.fillColor(INK).text(p, { width, lineGap: 2 });
    doc.moveDown(0.5);
  }
  WAIVER_TERMS.forEach((term, i) => {
    doc.fillColor(INK).font('Helvetica-Bold').text(`${String(i + 1)}.  ${term.lead} `, MARGIN + 8, doc.y, { width: width - 8, continued: true, lineGap: 2 });
    doc.font('Helvetica').fillColor('#374151').text(term.text, { lineGap: 2 });
    doc.moveDown(0.45);
  });

  // Signature block.
  doc.moveDown(0.6);
  const top = doc.y;
  doc.moveTo(MARGIN, top).lineTo(MARGIN + width, top).strokeColor(RULE).lineWidth(1).stroke();
  doc.y = top + 14;
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(10).text('AGREED AND SIGNED', MARGIN, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.6);
  const row = (label: string, value: string): void => {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, MARGIN, doc.y, { width: 110 });
    doc.moveUp();
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(value, MARGIN + 115, doc.y, { width: width - 115 });
    doc.moveDown(0.35);
  };
  row('Name', w.displayName);
  row('Email', w.email ?? '—');
  row('Initials', w.initials);
  row('Signed', utc(w.signedAt));

  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Signature', MARGIN, doc.y);
  const boxTop = doc.y + 4;
  const boxH = 110;
  doc.roundedRect(MARGIN, boxTop, width, boxH, 6).lineWidth(1).strokeColor(RULE).stroke();
  doc.image(w.signaturePng, MARGIN + 10, boxTop + 8, { fit: [width - 20, boxH - 16], align: 'center', valign: 'center' });
  doc.y = boxTop + boxH + 16;

  // How and where it was signed.
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(10).text('SIGNING DETAILS', MARGIN, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.6);
  const d = w.device;
  row('IP address', w.ipAddress ?? '—');
  row('Browser / device', w.userAgent ?? '—');
  row(
    'Device (reported)',
    [d.platform, d.screen && `screen ${d.screen}`, d.touch === undefined ? null : d.touch ? 'touch screen' : 'no touch screen', d.language, d.timeZone].filter(Boolean).join(' · ') || '—',
  );
  row('Document ID', w.id);
  row('Signature SHA-256', w.signatureSha256);

  // Footer on the last page.
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  doc.text(
    'This signed agreement is kept by the owner of PokerClause, permanently — including after the player deletes their account. ' +
      'Its authorization record holds this PDF’s SHA-256 fingerprint, so any change to it can be detected.',
    MARGIN,
    doc.page.height - MARGIN - 24,
    { width, align: 'center' },
  );

  doc.end();
  return done;
}

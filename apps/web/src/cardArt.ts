// The drawn card faces the 3D table shows for the moment a card's artwork
// (public/cards) takes to load — as a plain canvas, with no 3D code, which
// table3d/textures.ts turns into the felt's textures.

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

const RANK_LABEL: Record<string, string> = { T: '10' };
const SUIT_RED: Record<string, boolean> = { h: true, d: true };
const RED = '#c4122f';
const BLACK = '#15151a';

/**
 * A suit symbol as a vector path — the same on every device (a font's ♥
 * can come out as an emoji on a phone), centred on (x, y), `size` tall,
 * upside down when `flip`.
 */
export function suitPath(ctx: CanvasRenderingContext2D, suit: string, x: number, y: number, size: number, flip = false): void {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.rotate(Math.PI);
  const u = size / 2;
  ctx.beginPath();
  switch (suit) {
    case 'h':
      ctx.moveTo(0, u * 0.95);
      ctx.bezierCurveTo(-u * 0.25, u * 0.62, -u * 1.02, u * 0.18, -u * 0.96, -u * 0.35);
      ctx.bezierCurveTo(-u * 0.9, -u * 0.95, -u * 0.18, -u * 1.02, 0, -u * 0.48);
      ctx.bezierCurveTo(u * 0.18, -u * 1.02, u * 0.9, -u * 0.95, u * 0.96, -u * 0.35);
      ctx.bezierCurveTo(u * 1.02, u * 0.18, u * 0.25, u * 0.62, 0, u * 0.95);
      break;
    case 'd':
      ctx.moveTo(0, -u);
      ctx.quadraticCurveTo(u * 0.32, -u * 0.38, u * 0.78, 0);
      ctx.quadraticCurveTo(u * 0.32, u * 0.38, 0, u);
      ctx.quadraticCurveTo(-u * 0.32, u * 0.38, -u * 0.78, 0);
      ctx.quadraticCurveTo(-u * 0.32, -u * 0.38, 0, -u);
      break;
    case 's':
      ctx.moveTo(0, -u);
      ctx.bezierCurveTo(u * 0.3, -u * 0.6, u * 1.0, -u * 0.25, u * 0.96, u * 0.22);
      ctx.bezierCurveTo(u * 0.92, u * 0.66, u * 0.38, u * 0.72, u * 0.1, u * 0.42);
      ctx.quadraticCurveTo(u * 0.16, u * 0.8, u * 0.42, u * 0.98);
      ctx.lineTo(-u * 0.42, u * 0.98);
      ctx.quadraticCurveTo(-u * 0.16, u * 0.8, -u * 0.1, u * 0.42);
      ctx.bezierCurveTo(-u * 0.38, u * 0.72, -u * 0.92, u * 0.66, -u * 0.96, u * 0.22);
      ctx.bezierCurveTo(-u * 1.0, -u * 0.25, -u * 0.3, -u * 0.6, 0, -u);
      break;
    default: {
      // Clubs: three leaves and a flared stem.
      const r = u * 0.43;
      ctx.arc(0, -u * 0.48, r, 0, Math.PI * 2);
      ctx.moveTo(-u * 0.5 + r, u * 0.06);
      ctx.arc(-u * 0.5, u * 0.06, r, 0, Math.PI * 2);
      ctx.moveTo(u * 0.5 + r, u * 0.06);
      ctx.arc(u * 0.5, u * 0.06, r, 0, Math.PI * 2);
      ctx.moveTo(-u * 0.1, 0);
      ctx.quadraticCurveTo(-u * 0.1, u * 0.75, -u * 0.45, u * 0.98);
      ctx.lineTo(u * 0.45, u * 0.98);
      ctx.quadraticCurveTo(u * 0.1, u * 0.75, u * 0.1, 0);
      ctx.closePath();
    }
  }
  ctx.fill();
  ctx.restore();
}

/** Pip positions (fractions of the card's width and height) for 2–10, the classic layouts. */
const PIPS: Record<string, readonly [number, number][]> = {
  '2': [[0.5, 0.2], [0.5, 0.8]],
  '3': [[0.5, 0.2], [0.5, 0.5], [0.5, 0.8]],
  '4': [[0.3, 0.2], [0.7, 0.2], [0.3, 0.8], [0.7, 0.8]],
  '5': [[0.3, 0.2], [0.7, 0.2], [0.5, 0.5], [0.3, 0.8], [0.7, 0.8]],
  '6': [[0.3, 0.2], [0.7, 0.2], [0.3, 0.5], [0.7, 0.5], [0.3, 0.8], [0.7, 0.8]],
  '7': [[0.3, 0.2], [0.7, 0.2], [0.5, 0.35], [0.3, 0.5], [0.7, 0.5], [0.3, 0.8], [0.7, 0.8]],
  '8': [[0.3, 0.2], [0.7, 0.2], [0.5, 0.35], [0.3, 0.5], [0.7, 0.5], [0.5, 0.65], [0.3, 0.8], [0.7, 0.8]],
  '9': [[0.3, 0.2], [0.7, 0.2], [0.3, 0.4], [0.7, 0.4], [0.5, 0.5], [0.3, 0.6], [0.7, 0.6], [0.3, 0.8], [0.7, 0.8]],
  T: [[0.3, 0.2], [0.7, 0.2], [0.5, 0.3], [0.3, 0.4], [0.7, 0.4], [0.3, 0.6], [0.7, 0.6], [0.5, 0.7], [0.3, 0.8], [0.7, 0.8]],
};

/** The card's white body: rounded corners (outside them is clear — the material cuts them away), a faint paper grain and a hairline edge. */
export function cardBlank(ctx: CanvasRenderingContext2D, w: number, h: number, radius: number): void {
  ctx.clearRect(0, 0, w, h);
  roundRect(ctx, 1, 1, w - 2, h - 2, radius);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#fffefb');
  g.addColorStop(1, '#f1eee6');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,30,20,0.28)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Draws a card's face on a fresh canvas. */
export function cardFaceCanvas(card: string): HTMLCanvasElement {
  const w = 360;
  const h = 502;
  const [c, ctx] = canvas(w, h);
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const label = RANK_LABEL[rank] ?? rank;
  const color = SUIT_RED[suit] ? RED : BLACK;
  cardBlank(ctx, w, h, 26);

  // The two corner indices, top left and (upside down) bottom right, as on any deck.
  const index = (turn: number): void => {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(turn);
    const sideways = Math.abs(Math.sin(turn)) > 0.5;
    const fw = sideways ? h : w;
    const fh = sideways ? w : h;
    ctx.translate(-fw / 2, -fh / 2);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${label.length > 1 ? 74 : 86}px Georgia, "Times New Roman", serif`;
    if (label.length > 1) {
      ctx.save();
      ctx.translate(50, 80);
      ctx.scale(0.74, 1);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(label, 50, 82);
    }
    suitPath(ctx, suit, 50, 114, 40);
    ctx.restore();
  };
  for (const turn of [0, Math.PI]) index(turn);

  ctx.fillStyle = color;
  if (rank === 'A') {
    suitPath(ctx, suit, w / 2, h / 2, suit === 's' ? 170 : 130);
  } else if (PIPS[rank]) {
    // The pips, inside the corner indices; the bottom half's stand upside down, as on a real card.
    const x0 = 122;
    const x1 = w - 122;
    const y0 = 146;
    const y1 = h - 146;
    for (const [fx, fy] of PIPS[rank]) {
      suitPath(ctx, suit, x0 + (x1 - x0) * ((fx - 0.3) / 0.4), y0 + (y1 - y0) * ((fy - 0.2) / 0.6), 54, fy > 0.55);
    }
  } else {
    // Court cards: a framed panel inside the four corner indices, the letter large with a crown and suits, mirrored top and bottom.
    const px = 122;
    const py = 142;
    const pw = w - px * 2;
    const ph = h - py * 2;
    const panel = ctx.createLinearGradient(0, py, 0, py + ph);
    panel.addColorStop(0, SUIT_RED[suit] ? '#fff1ea' : '#eef1fb');
    panel.addColorStop(0.5, '#fffaf0');
    panel.addColorStop(1, SUIT_RED[suit] ? '#fff1ea' : '#eef1fb');
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#c9a14a';
    ctx.stroke();
    roundRect(ctx, px + 9, py + 9, pw - 18, ph - 18, 8);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    for (const flip of [false, true]) {
      ctx.save();
      if (flip) {
        ctx.translate(w, h);
        ctx.rotate(Math.PI);
      }
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '700 88px Georgia, "Times New Roman", serif';
      ctx.fillText(label, w / 2, h / 2 - 12);
      suitPath(ctx, suit, w / 2 - 38, h / 2 - 92, 22);
      suitPath(ctx, suit, w / 2 + 38, h / 2 - 92, 22);
      // A small crown for the king and queen, a feather-like flourish for the jack.
      ctx.strokeStyle = '#c9a14a';
      ctx.lineWidth = 4;
      ctx.beginPath();
      if (rank === 'J') {
        ctx.moveTo(w / 2 - 20, h / 2 - 92);
        ctx.quadraticCurveTo(w / 2, h / 2 - 106, w / 2 + 20, h / 2 - 92);
      } else {
        ctx.moveTo(w / 2 - 16, h / 2 - 86);
        ctx.lineTo(w / 2 - 16, h / 2 - 100);
        ctx.lineTo(w / 2 - 8, h / 2 - 92);
        ctx.lineTo(w / 2, h / 2 - 104);
        ctx.lineTo(w / 2 + 8, h / 2 - 92);
        ctx.lineTo(w / 2 + 16, h / 2 - 100);
        ctx.lineTo(w / 2 + 16, h / 2 - 86);
        ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(201,161,74,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + 12, h / 2);
    ctx.lineTo(w - px - 12, h / 2);
    ctx.stroke();
  }
  return c;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

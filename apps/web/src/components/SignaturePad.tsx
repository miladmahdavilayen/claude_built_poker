import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface SignaturePadHandle {
  /** The signature as a PNG data URL (ink on transparent), or null if nothing real has been drawn. */
  toDataUrl(): string | null;
  clear(): void;
}

/**
 * The signature cropped to the ink, with a little margin — so it fills the
 * signature box on the signed PDF instead of sitting small in a wide, mostly
 * empty pad (and the image sent is smaller too).
 */
function croppedPng(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');
  const { width, height } = canvas;
  const alpha = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[(y * width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas.toDataURL('image/png');
  const pad = Math.round(Math.max(width, height) * 0.03);
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const w = Math.min(width, maxX + pad + 1) - x0;
  const h = Math.min(height, maxY + pad + 1) - y0;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')?.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  return out.toDataURL('image/png');
}

/** How much ink (in CSS px of stroke length) counts as a signature rather than a stray tap. */
const MIN_INK = 80;
const HEIGHT = 170;
const INK = '#14182a';

/**
 * Sign with a finger or a mouse. Strokes are smoothed (quadratic curves
 * through the midpoints of the sampled points) and thin slightly as the pen
 * speeds up, like real ink; the canvas draws at the screen's pixel density
 * so it stays crisp on a phone. `touch-action: none` keeps the page from
 * scrolling while signing. Tells the parent whether there's a usable
 * signature yet via `onChange`.
 */
export const SignaturePad = forwardRef<SignaturePadHandle, { onChange: (signed: boolean) => void; label: string }>(function SignaturePad(
  { onChange, label },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stroke = useRef<{ x: number; y: number; t: number; w: number }[] | null>(null);
  const ink = useRef(0);
  /** Anything on the canvas at all (a ref, so resizing doesn't depend on render state). */
  const drawn = useRef(false);
  const [empty, setEmpty] = useState(true);

  const context = (): CanvasRenderingContext2D | null => canvasRef.current?.getContext('2d') ?? null;

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = wrap.clientWidth;
    // Resizing wipes a canvas — keep what's been drawn.
    const previous = canvas.width > 0 && drawn.current ? canvas.toDataURL() : null;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.width = `${String(width)}px`;
    canvas.style.height = `${String(HEIGHT)}px`;
    const ctx = context();
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    if (previous) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, width, HEIGHT);
      img.src = previous;
    }
  }, []);

  useEffect(() => {
    resize();
    const observer = new ResizeObserver(() => resize());
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, [resize]);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = context();
    if (canvas && ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    ink.current = 0;
    drawn.current = false;
    setEmpty(true);
    onChange(false);
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      toDataUrl: () => (ink.current >= MIN_INK && canvasRef.current ? croppedPng(canvasRef.current) : null),
      clear,
    }),
    [clear],
  );

  const point = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    stroke.current = [{ ...p, t: performance.now(), w: 2.6 }];
    const ctx = context();
    if (ctx) {
      // A dot, in case this is a tap (the dot on an "i").
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    drawn.current = true;
    if (empty) setEmpty(false);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const pts = stroke.current;
    const ctx = context();
    if (!pts || !ctx) return;
    // Use every point the browser sampled, not just one per frame.
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    const r = e.currentTarget.getBoundingClientRect();
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const last = pts[pts.length - 1]!;
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      const t = performance.now();
      const dist = Math.hypot(x - last.x, y - last.y);
      if (dist < 0.8) continue;
      const speed = dist / Math.max(1, t - last.t);
      // Faster strokes are thinner; ease toward the target width so it never jumps.
      const target = Math.max(1.2, Math.min(3.4, 3.4 - speed * 1.1));
      const w = last.w + (target - last.w) * 0.35;
      pts.push({ x, y, t, w });
      ink.current += dist;
      if (pts.length >= 3) {
        const a = pts[pts.length - 3]!;
        const b = pts[pts.length - 2]!;
        const c = pts[pts.length - 1]!;
        ctx.beginPath();
        ctx.lineWidth = b.w;
        ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
        ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
        ctx.stroke();
      }
    }
    if (ink.current >= MIN_INK) onChange(true);
  };

  const onPointerUp = (): void => {
    const pts = stroke.current;
    const ctx = context();
    if (pts && ctx && pts.length >= 2) {
      const b = pts[pts.length - 2]!;
      const c = pts[pts.length - 1]!;
      ctx.beginPath();
      ctx.lineWidth = c.w;
      ctx.moveTo((b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    stroke.current = null;
    onChange(ink.current >= MIN_INK);
  };

  return (
    <div className="signature-pad">
      <div className="signature-pad-head">
        <span>{label}</span>
        <button type="button" className="signature-pad-clear" onClick={clear} disabled={empty}>
          Clear
        </button>
      </div>
      <div ref={wrapRef} className="signature-pad-surface">
        <canvas
          ref={canvasRef}
          className="signature-pad-canvas"
          aria-label="Signature pad — draw your signature"
          role="img"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {empty && <span className="signature-pad-hint">Sign here with your finger or mouse</span>}
        <span className="signature-pad-line" aria-hidden="true">
          ✕
        </span>
      </div>
    </div>
  );
});

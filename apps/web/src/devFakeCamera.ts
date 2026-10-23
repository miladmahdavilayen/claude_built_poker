let stream: MediaStream | null = null;

/**
 * Development only (Table.tsx's `?fakeCameras=1`, compiled out of production
 * builds): a stand-in camera feed — a soft moving gradient from a canvas —
 * so the table layout can be checked with every seat on camera, up to nine,
 * without nine people and nine webcams.
 */
export function fakeCameraStream(): MediaStream {
  if (stream) return stream;
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  let t = 0;
  const paint = (): void => {
    t += 1;
    const g = ctx.createLinearGradient(0, 0, 120, 160);
    g.addColorStop(0, `hsl(${String((t * 3) % 360)}, 40%, 35%)`);
    g.addColorStop(1, '#111');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 120, 160);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(60, 70, 26, 0, Math.PI * 2); // a "face" — what the layout must never cover with cards
    ctx.fill();
  };
  paint();
  setInterval(paint, 200);
  stream = canvas.captureStream(5);
  return stream;
}

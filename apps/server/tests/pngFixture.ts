import { deflateSync } from 'node:zlib';

/**
 * A real PNG for tests that need a drawn signature: `width`×`height`, with
 * a deterministic scribble of dark "ink" pixels on transparency — enough
 * detail that it doesn't compress down like an empty canvas would.
 */
export function signaturePngDataUrl(width = 300, height = 100): string {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let s = 12345;
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const ink = Math.abs(Math.sin(x / 7) * height * 0.4 + height / 2 - y) < 2 || s % 23 === 0;
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = 20;
      raw[o + 1] = 24;
      raw[o + 2] = 31;
      raw[o + 3] = ink ? 255 : 0;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

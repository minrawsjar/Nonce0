// Generates the extension icons: the ring of eight, at the four sizes Chrome
// asks for.
//
// Why draw them here instead of shipping a PNG from a design tool: this repo
// has no image dependency and does not need one. A PNG is a signature, three
// chunks and a CRC, and Node ships the only hard part (deflate) in core. The
// whole encoder below is shorter than the install line for a PNG library.
//
//   node extension/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const BG = [0x13, 0x10, 0x19]; // --color-bg
const FG = [0xa3, 0x96, 0xd9]; // --color-accent

// CRC-32, table built once. Required by every PNG chunk.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline, then the row's pixels.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const at = y * (1 + size * 4);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The mark: eight identical dots on a circle. Sampled 3x3 per pixel so the
// small sizes do not alias into mush — at 16px a dot is about two pixels
// across and nearest-neighbour would drop half of them entirely.
function ring(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const orbit = size * 0.31;
  const dot = Math.max(size * 0.085, 1.05);

  const centres = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    return [c + Math.cos(a) * orbit, c + Math.sin(a) * orbit];
  });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          if (centres.some(([cx, cy]) => (px - cx) ** 2 + (py - cy) ** 2 <= dot * dot)) hits++;
        }
      }
      const t = hits / 9;
      const at = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) buf[at + ch] = Math.round(BG[ch] + (FG[ch] - BG[ch]) * t);
      buf[at + 3] = 255;
    }
  }
  return buf;
}

mkdirSync(join(HERE, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(HERE, 'icons', `${size}.png`);
  writeFileSync(file, png(size, ring(size)));
  console.log(`icons/${size}.png`);
}

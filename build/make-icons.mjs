// make-icons.mjs — generate extension/icons/icon{16,32,48,128}.png.
//
// Chrome Web Store requires a 128px icon and uses 16/32/48 in the toolbar,
// tab strip and management page. Committing the GENERATOR as well as the PNGs
// means the mark can be changed in one place and re-rendered consistently,
// rather than someone hand-editing four files and letting them drift.
//
// The treatment is HirePilot's, deliberately: a rounded-square tile carrying
// the brand gradient (135deg #7868ff -> #ec5faa) with a white glyph, and the
// same 9/27 corner-radius ratio as the popup's `.brand-mark`.
//
// WHY A MONOGRAM. The first attempt was a needle and thread, which is the
// honest symbol for what this product does. Rendered and inspected at all
// four sizes, it failed: thin strokes disappear at 16px, and at 128px the
// needle's eye read as an arrowhead. A stitch zigzag was worse -- it read as
// a stock chart, which is the wrong signal entirely. A solid monogram is
// crisp at 16px, which is the size that actually matters in a browser
// toolbar, and the gradient tile is what carries the brand anyway. Same
// reason HirePilot's mark worked: it was a solid, simple shape.
//
// Usage: node build/make-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'icons');

const SIZES = [16, 32, 48, 128];
const SS = 8; // supersample factor; downsampled with a box filter for clean edges

// --accent-gradient, matching styles.css exactly.
const C0 = [0x78, 0x68, 0xff];
const C1 = [0xec, 0x5f, 0xaa];

/** Signed-distance helper: is (x, y) inside a rounded square of side `n`? */
function insideRoundedSquare(x, y, n, r) {
  const cx = Math.min(Math.max(x, r), n - r);
  const cy = Math.min(Math.max(y, r), n - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x <= n - r) || (y >= r && y <= n - r);
}

/**
 * The glyph, authored on a 24-unit grid so it matches the inline SVG in
 * popup.html. A capital T: crossbar plus stem, both as plain rectangles, so
 * there is no font dependency and no hinting surprises at small sizes.
 */
function insideGlyph(gx, gy) {
  const bar = gy >= 5.0 && gy <= 8.3 && gx >= 4.6 && gx <= 19.4;
  const stem = gx >= 10.35 && gx <= 13.65 && gy >= 5.0 && gy <= 19.4;
  return bar || stem;
}

/** Minimal PNG encoder: 8-bit RGBA, one IDAT, no filtering. */
function encodePng(width, height, rgba) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size) {
  const big = size * SS;
  const radius = (big * 9) / 27; // .brand-mark: 9px radius on a 27px tile
  const hi = Buffer.alloc(big * big * 4);

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const i = (y * big + x) * 4;
      if (!insideRoundedSquare(x + 0.5, y + 0.5, big, radius)) continue;

      // 135deg gradient: constant along the anti-diagonal.
      const t = (x + y) / (2 * (big - 1));
      let r = Math.round(C0[0] + (C1[0] - C0[0]) * t);
      let g = Math.round(C0[1] + (C1[1] - C0[1]) * t);
      let b = Math.round(C0[2] + (C1[2] - C0[2]) * t);

      const s = big / 24;
      if (insideGlyph((x + 0.5) / s, (y + 0.5) / s)) { r = 255; g = 255; b = 255; }

      hi[i] = r; hi[i + 1] = g; hi[i + 2] = b; hi[i + 3] = 255;
    }
  }

  // Box downsample, which also anti-aliases the corners and the glyph.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const j = (((y * SS) + dy) * big + (x * SS) + dx) * 4;
          const alpha = hi[j + 3];
          r += hi[j] * alpha; g += hi[j + 1] * alpha; b += hi[j + 2] * alpha; a += alpha;
        }
      }
      const i = (y * size + x) * 4;
      if (a === 0) continue;
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon${size}.png`);
  writeFileSync(file, render(size));
  console.log(`  wrote extension/icons/icon${size}.png`);
}

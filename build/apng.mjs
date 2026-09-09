// apng.mjs — assemble PNG frames into one animated PNG.
//
// WHY NOT A GIF, AND WHY NOT A VIDEO. A README needs an image that animates
// when GitHub renders the markdown. A committed .webm or .mp4 does not: GitHub
// only plays video uploaded through its own web UI, and `![](demo.mp4)` in a
// README renders as a broken image. GIF would work but needs LZW plus palette
// quantisation, which is a lot of code to write badly; APNG is just PNG with
// three extra chunk types, renders inline everywhere a PNG does, and keeps
// full colour. ffmpeg would have made this moot and is not installed.
//
// Written by hand rather than adding a dependency: this is one build-time
// asset script in a deliberately lean tree, and the format is small enough to
// implement correctly.
//
// Structure produced:
//   signature, IHDR, acTL, fcTL, IDAT,          <- frame 0
//   (fcTL, fdAT) per later frame, IEND

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Split a PNG into its chunks. Tolerates any encoder's chunk layout, which
 * matters because Chromium may emit several IDATs for one image and every one
 * of them has to be carried across.
 */
function readChunks(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const chunks = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

const idatOf = (chunks) => Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
const ihdrOf = (chunks) => chunks.find((c) => c.type === 'IHDR').data;

function fcTL(seq, width, height, delayMs) {
  const d = Buffer.alloc(26);
  d.writeUInt32BE(seq, 0);
  d.writeUInt32BE(width, 4);
  d.writeUInt32BE(height, 8);
  d.writeUInt32BE(0, 12);          // x offset
  d.writeUInt32BE(0, 16);          // y offset
  d.writeUInt16BE(delayMs, 20);    // delay numerator
  d.writeUInt16BE(1000, 22);       // denominator: milliseconds
  d.writeUInt8(0, 24);             // dispose: none
  d.writeUInt8(0, 25);             // blend: source (each frame is complete)
  return d;
}

/**
 * @param {Array<{png: Buffer, delayMs: number}>} frames
 * @param {number} [plays] 0 = loop forever
 * @returns {Buffer} an animated PNG
 */
export function buildApng(frames, { plays = 0 } = {}) {
  if (!frames.length) throw new Error('no frames');

  const parsed = frames.map((f) => ({ ...f, chunks: readChunks(f.png) }));
  const ihdr = ihdrOf(parsed[0].chunks);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);

  // EVERY FRAME MUST SHARE THE HEADER. Bit depth and colour type live in IHDR
  // and are not per-frame, so a frame encoded differently would decode as
  // garbage rather than fail loudly. Chromium is consistent in practice; this
  // refuses rather than shipping a corrupt file if it ever is not.
  for (const [i, frame] of parsed.entries()) {
    if (!ihdrOf(frame.chunks).equals(ihdr)) {
      throw new Error(`frame ${i} has a different IHDR than frame 0 — cannot animate these together`);
    }
  }

  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(parsed.length, 0);
  actl.writeUInt32BE(plays, 4);

  const out = [SIGNATURE, chunk('IHDR', ihdr), chunk('acTL', actl)];

  let seq = 0;
  parsed.forEach((frame, i) => {
    out.push(chunk('fcTL', fcTL(seq++, width, height, frame.delayMs)));
    const data = idatOf(frame.chunks);
    if (i === 0) {
      // Frame 0 is the still image a non-APNG decoder shows, so it is a plain
      // IDAT rather than an fdAT.
      out.push(chunk('IDAT', data));
    } else {
      const fdat = Buffer.alloc(4 + data.length);
      fdat.writeUInt32BE(seq++, 0);
      data.copy(fdat, 4);
      out.push(chunk('fdAT', fdat));
    }
  });

  out.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}

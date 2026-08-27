/**
 * Edge flood-fill knockout for /public/brand lockups.
 * Clears baked black/brown/white plates connected to the frame while keeping
 * interior crest artwork (gold, flags, figures).
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";

const ROOT = path.resolve("public/brand");
const FILES = fs
  .readdirSync(ROOT)
  .filter((f) => /^lockup-(usa|jester|lithuania|nigeria)-\d+\.png$/i.test(f));

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
  let off = 8;
  let w, h, bit, ct;
  const idats = [];
  while (off < buf.length - 8) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bit = data[8];
      ct = data[9];
    }
    if (type === "IDAT") idats.push(data);
    if (type === "IEND") break;
    off += 12 + len;
  }
  if (ct !== 6 || bit !== 8) throw new Error(`need 8-bit RGBA`);
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const bpp = 4;
  const stride = w * bpp + 1;
  const out = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(w * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const row = raw.subarray(y * stride + 1, y * stride + 1 + w * bpp);
    const cur = Buffer.alloc(w * bpp);
    for (let i = 0; i < w * bpp; i++) {
      const x = row[i];
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = (x + left) & 255;
      else if (f === 2) v = (x + up) & 255;
      else if (f === 3) v = (x + Math.floor((left + up) / 2)) & 255;
      else if (f === 4) v = (x + paeth(left, up, upLeft)) & 255;
      else v = x;
      cur[i] = v;
    }
    cur.copy(out, y * w * bpp);
    prev = cur;
  }
  return { w, h, pixels: out };
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const both = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(both));
  return Buffer.concat([len, both, crcBuf]);
}
function encodePng(w, h, pixels) {
  const bpp = 4;
  const raw = Buffer.alloc((w * bpp + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * bpp + 1)] = 0;
    pixels.copy(raw, y * (w * bpp + 1) + 1, y * w * bpp, (y + 1) * w * bpp);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Field-like: already clear, dark/mid leather plate, or near-white paper. */
function isField(r, g, b, a, name) {
  if (a < 12) return true;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const L = (r + g + b) / 3;
  const sat = max === 0 ? 0 : (max - min) / max;

  // Preserve saturated flag greens / gold / matrix green
  if (name.includes("jester") && g > r + 12 && g > b + 8 && g > 35) return false;
  if (sat > 0.5 && L > 55 && (r > 90 || g > 90 || b > 90)) return false; // gold/flag
  if (L > 140) return false; // bright metal / type

  // White / light gray paper or soft halo plate
  if (L >= 195 && sat < 0.28) return true;

  // Dark plates — aggressive enough to clear navy/brown leather tiles
  if (L < 95) return true;
  if (L < 115 && sat < 0.5) return true;
  return false;
}

function knockOut(pixels, w, h, name) {
  // Global plate clear: any field-like pixel goes transparent. Connectivity is
  // not required — leather tiles are often enclosed by gold dust rings.
  let cleared = 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const r = pixels[p],
      g = pixels[p + 1],
      b = pixels[p + 2],
      a = pixels[p + 3];
    if (a < 12) continue;
    if (!isField(r, g, b, a, name)) continue;
    pixels[p] = 0;
    pixels[p + 1] = 0;
    pixels[p + 2] = 0;
    pixels[p + 3] = 0;
    cleared++;
  }
  return cleared;
}

for (const file of FILES) {
  const full = path.join(ROOT, file);
  const { w, h, pixels } = decodePng(fs.readFileSync(full));
  const cleared = knockOut(pixels, w, h, file);
  fs.writeFileSync(full, encodePng(w, h, pixels));
  console.log(`${file}: cleared ${cleared} px`);
}

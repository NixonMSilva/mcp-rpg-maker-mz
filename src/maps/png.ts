import * as zlib from "node:zlib";

/**
 * Minimal PNG codec (no native dependencies).
 *
 * Decoder: every standard color type (gray, RGB, palette, gray+alpha, RGBA),
 * bit depths 1/2/4/8/16, tRNS transparency, all 5 filter types and Adam7
 * interlacing. Output is always 8-bit RGBA.
 * Encoder: 8-bit RGBA, adaptive per-row filter, zlib deflate.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** width * height * 4 bytes, non-premultiplied RGBA. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class PngError extends Error {}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isPng(buf: Uint8Array): boolean {
  return buf.length >= 8 && SIGNATURE.equals(Buffer.from(buf.buffer, buf.byteOffset, 8));
}

export function decodePng(input: Uint8Array): RgbaImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isPng(buf)) throw new PngError("not a PNG file (bad signature)");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new PngError(`truncated ${type} chunk`);
    pos += 12 + len;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") palette = new Uint8Array(body);
    else if (type === "tRNS") trns = new Uint8Array(body);
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || channels === undefined) throw new PngError(`unsupported PNG header (color type ${colorType})`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new PngError(`unsupported bit depth ${bitDepth}`);
  if (colorType === 3 && !palette) throw new PngError("palette image without PLTE chunk");
  if (width * height > 64 * 1024 * 1024) throw new PngError(`image too large (${width}x${height})`);
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    throw new PngError(`corrupt image data: ${(err as Error).message}`);
  }
  const out = new Uint8Array(width * height * 4);
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  let offset = 0;

  const passes: [number, number, number, number][] =
    interlace === 1
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ]
      : [[0, 0, 1, 1]];

  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = new Uint8Array(stride);
    for (let row = 0; row < ph; row++) {
      if (offset + 1 + stride > raw.length) throw new PngError("truncated image data");
      const filter = raw[offset]!;
      const line = new Uint8Array(raw.subarray(offset + 1, offset + 1 + stride));
      offset += 1 + stride;
      unfilter(filter, line, prev, bpp);
      for (let col = 0; col < pw; col++) {
        writePixel(out, ((y0 + row * dy) * width + x0 + col * dx) * 4, line, col, colorType, bitDepth, palette, trns);
      }
      prev = line;
    }
  }
  return { width, height, data: out };
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i]! + line[i - bpp]!) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i]! + prev[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) line[i] = (line[i]! + (((i >= bpp ? line[i - bpp]! : 0) + prev[i]!) >> 1)) & 0xff;
      return;
    case 4:
      for (let i = 0; i < n; i++) line[i] = (line[i]! + paeth(i >= bpp ? line[i - bpp]! : 0, prev[i]!, i >= bpp ? prev[i - bpp]! : 0)) & 0xff;
      return;
    default:
      throw new PngError(`invalid filter type ${filter}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function sample(line: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return line[index]!;
  if (bitDepth === 16) return line[index * 2]!; // high byte
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)]!;
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function writePixel(
  out: Uint8Array,
  o: number,
  line: Uint8Array,
  col: number,
  colorType: number,
  bitDepth: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): void {
  const ch = CHANNELS[colorType]!;
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;
  const raw16 = (i: number) => (bitDepth === 16 ? (line[i * 2]! << 8) | line[i * 2 + 1]! : sample(line, i, bitDepth));
  if (colorType === 3) {
    const idx = sample(line, col, bitDepth);
    out[o] = palette![idx * 3] ?? 0;
    out[o + 1] = palette![idx * 3 + 1] ?? 0;
    out[o + 2] = palette![idx * 3 + 2] ?? 0;
    out[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    return;
  }
  const base = col * ch;
  const v = (i: number) => Math.round(sample(line, base + i, bitDepth) * scale);
  if (colorType === 0 || colorType === 4) {
    const g = v(0);
    out[o] = out[o + 1] = out[o + 2] = g;
    if (colorType === 4) out[o + 3] = v(1);
    else out[o + 3] = trns && trns.length >= 2 && raw16(base) === ((trns[0]! << 8) | trns[1]!) ? 0 : 255;
    return;
  }
  out[o] = v(0);
  out[o + 1] = v(1);
  out[o + 2] = v(2);
  if (colorType === 6) out[o + 3] = v(3);
  else if (trns && trns.length >= 6) {
    const key = (k: number) => (trns[k * 2]! << 8) | trns[k * 2 + 1]!;
    const match = raw16(base) === key(0) && raw16(base + 1) === key(1) && raw16(base + 2) === key(2);
    out[o + 3] = match ? 0 : 255;
  } else out[o + 3] = 255;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + body.length);
  b.writeUInt32BE(body.length, 0);
  b.write(type, 4, "latin1");
  b.set(body, 8);
  b.writeUInt32BE(crc32(b, 4, 8 + body.length), 8 + body.length);
  return b;
}

/** Encode 8-bit RGBA. Picks the cheapest filter per row (sum of absolute differences heuristic). */
export function encodePng(img: RgbaImage, level = 6): Buffer {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestScore = Infinity;
    [0, 1, 2, 4].forEach((f, k) => {
      const outRow = cand[k]!;
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4]! : 0;
        const b = prev ? prev[i]! : 0;
        const c = prev && i >= 4 ? prev[i - 4]! : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : paeth(a, b, c);
        const v = (cur[i]! - pred) & 0xff;
        outRow[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    });
    raw[y * (stride + 1)] = [0, 1, 2, 4][best]!;
    raw.set(cand[best]!, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level })), chunk("IEND", new Uint8Array(0))]);
}

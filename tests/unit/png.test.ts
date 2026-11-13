import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng, PngError } from "../../src/maps/png.js";
import { FIXTURE_ROOT } from "../helpers/fixture.js";

function chunk(type: string, body: Buffer): Buffer {
  // Reuse the encoder's CRC through a round-trip-free path: compute it here.
  let c = 0xffffffff;
  for (const b of Buffer.concat([Buffer.from(type, "latin1"), body])) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

function rawPng(width: number, height: number, bitDepth: number, colorType: number, rows: Buffer[], extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("PNG codec", () => {
  it("round-trips RGBA through the encoder (all filter choices)", () => {
    const w = 37, h = 23;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919 + (i >> 5) * 31) & 0xff;
    const back = decodePng(encodePng({ width: w, height: h, data }));
    expect(back.width).toBe(w);
    expect(back.height).toBe(h);
    expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
  });

  it("decodes palette images with tRNS and low bit depths", () => {
    const plte = chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]));
    const trns = chunk("tRNS", Buffer.from([0, 128]));
    // 2-bit palette, 4 pixels per byte: indices 0,1,2,3
    const img = decodePng(rawPng(4, 1, 2, 3, [Buffer.from([0b00011011])], [plte, trns]));
    expect(Array.from(img.data)).toEqual([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255]);
  });

  it("decodes grayscale and RGB", () => {
    const g = decodePng(rawPng(2, 1, 8, 0, [Buffer.from([0, 200])]));
    expect(Array.from(g.data)).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
    const rgb = decodePng(rawPng(1, 1, 8, 2, [Buffer.from([1, 2, 3])]));
    expect(Array.from(rgb.data)).toEqual([1, 2, 3, 255]);
  });

  it("reads every fixture image and rejects non-PNG data", () => {
    for (const dir of ["tilesets", "characters"]) {
      for (const f of fs.readdirSync(path.join(FIXTURE_ROOT, "img", dir))) {
        const img = decodePng(fs.readFileSync(path.join(FIXTURE_ROOT, "img", dir, f)));
        expect(img.width * img.height * 4).toBe(img.data.length);
      }
    }
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(PngError);
  });
});

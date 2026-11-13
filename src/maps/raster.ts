import type { RgbaImage } from "./png.js";

/** RGBA color, alpha 0-255. */
export type Color = [number, number, number, number];

/** A mutable RGBA canvas with the few drawing operations the map renderer needs. */
export class Canvas implements RgbaImage {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Color = [0, 0, 0, 0],
  ) {
    this.data = new Uint8Array(width * height * 4);
    if (background[3] > 0) this.fillRect(0, 0, width, height, background);
  }

  /** Source-over blend of one pixel. */
  blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    const d = this.data;
    if (a >= 255) {
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
      return;
    }
    const sa = a / 255;
    const da = d[o + 3]! / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[o] = Math.round((r * sa + d[o]! * da * (1 - sa)) / oa);
    d[o + 1] = Math.round((g * sa + d[o + 1]! * da * (1 - sa)) / oa);
    d[o + 2] = Math.round((b * sa + d[o + 2]! * da * (1 - sa)) / oa);
    d[o + 3] = Math.round(oa * 255);
  }

  fillRect(x: number, y: number, w: number, h: number, c: Color): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w)), y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.blend(px, py, c[0], c[1], c[2], c[3]);
  }

  strokeRect(x: number, y: number, w: number, h: number, c: Color, t = 1): void {
    this.fillRect(x, y, w, t, c);
    this.fillRect(x, y + h - t, w, t, c);
    this.fillRect(x, y + t, t, h - 2 * t, c);
    this.fillRect(x + w - t, y + t, t, h - 2 * t, c);
  }

  /**
   * Draw a source rectangle into a destination rectangle (float edges are
   * rounded so adjacent pieces tile without gaps). Downscaling averages the
   * covered source pixels (premultiplied alpha); upscaling samples nearest.
   */
  drawImage(src: RgbaImage, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, opacity = 1): void {
    const x0 = Math.round(dx), y0 = Math.round(dy);
    const x1 = Math.round(dx + dw), y1 = Math.round(dy + dh);
    const tw = x1 - x0, th = y1 - y0;
    if (tw <= 0 || th <= 0 || sw <= 0 || sh <= 0) return;
    const fx = sw / tw, fy = sh / th;
    const s = src.data;
    for (let ty = 0; ty < th; ty++) {
      const py = y0 + ty;
      if (py < 0 || py >= this.height) continue;
      const syA = sy + ty * fy, syB = syA + fy;
      const ya = Math.floor(syA), yb = Math.max(ya + 1, Math.ceil(syB));
      for (let tx = 0; tx < tw; tx++) {
        const px = x0 + tx;
        if (px < 0 || px >= this.width) continue;
        const sxA = sx + tx * fx, sxB = sxA + fx;
        const xa = Math.floor(sxA), xb = Math.max(xa + 1, Math.ceil(sxB));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = ya; yy < yb; yy++) {
          if (yy < 0 || yy >= src.height) continue;
          for (let xx = xa; xx < xb; xx++) {
            if (xx < 0 || xx >= src.width) continue;
            const o = (yy * src.width + xx) * 4;
            const al = s[o + 3]!;
            r += s[o]! * al;
            g += s[o + 1]! * al;
            b += s[o + 2]! * al;
            a += al;
            n++;
          }
        }
        if (!n || a === 0) continue;
        this.blend(px, py, Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / n) * opacity));
      }
    }
  }

  /** Text in a 3x5 pixel font (digits, A-Z and a few symbols), scaled by an integer factor. */
  text(x: number, y: number, str: string, c: Color, scale = 1): void {
    let cx = Math.round(x);
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch];
      if (g) {
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 3; col++) {
            if (g[row]![col] === "#") this.fillRect(cx + col * scale, y + row * scale, scale, scale, c);
          }
        }
      }
      cx += 4 * scale;
    }
  }

  /** Text with a solid background box for legibility on busy tiles. */
  label(x: number, y: number, str: string, fg: Color, bg: Color, scale = 1): void {
    const w = textWidth(str, scale) + 2 * scale;
    this.fillRect(x, y, w, 7 * scale, bg);
    this.text(x + scale, y + scale, str, fg, scale);
  }
}

export function textWidth(str: string, scale = 1): number {
  return str.length ? (str.length * 4 - 1) * scale : 0;
}

const FONT: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  ",": ["...", "...", "...", ".#.", "#.."],
  "-": ["...", "...", "###", "...", "..."],
  ":": ["...", ".#.", "...", ".#.", "..."],
  "?": ["##.", "..#", ".#.", "...", ".#."],
  "!": [".#.", ".#.", ".#.", "...", ".#."],
  "#": ["#.#", "###", "#.#", "###", "#.#"],
  "/": ["..#", "..#", ".#.", "#..", "#.."],
  " ": ["...", "...", "...", "...", "..."],
};

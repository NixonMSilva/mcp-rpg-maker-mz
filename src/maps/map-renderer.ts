import { DIRS, type GridEvent, type MapGrid, type Point } from "./map-grid.js";
import type { TilesetInfo } from "./map-model.js";
import type { RgbaImage } from "./png.js";
import { Canvas, textWidth, type Color } from "./raster.js";
import { FLAG_STAR, isShadowingTile, isTableTile, SHEET_INDEX, tableEdgePieces, tilePieces, type TilePiece } from "./tiles.js";

/**
 * Renders a map region to an RGBA canvas the way the engine's tilemap
 * composes it: layers 0-3 with real autotile composition, layer-4 shadows,
 * counter ("table") edges, star tiles above characters, event sprites, plus
 * optional grid, axis labels and analysis overlays.
 */

export type ImageLoader = (folder: "tilesets" | "characters", name: string) => RgbaImage | null;

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  region: Region;
  /** Output pixels per tile. */
  cellSize: number;
  tileSize: number;
  grid: boolean;
  events: "sprites" | "markers" | "none";
  overlay: "none" | "passability" | "regions" | "reachable";
  /** BFS distances for the "reachable" overlay. */
  reach?: Int32Array;
  /** Explicit reachability origins (drawn as "O"); arrival points are already marked S/T. */
  reachOrigins?: Point[];
  start?: Point | null;
  entries?: Point[];
}

export interface RenderResult {
  canvas: Canvas;
  /** Pixel offset of map cell (region.x, region.y) inside the canvas. */
  originX: number;
  originY: number;
  missingImages: string[];
}

const MAGENTA: Color = [255, 0, 255, 255];
const TRIGGER_COLORS: Record<number, Color> = {
  0: [255, 214, 0, 255], // action button: yellow
  1: [255, 140, 0, 255], // player touch: orange
  2: [255, 140, 0, 255], // event touch: orange
  3: [235, 40, 40, 255], // autorun: red
  4: [170, 80, 255, 255], // parallel: purple
};
const INACTIVE: Color = [160, 160, 160, 255];

export const RENDER_LEGEND = {
  eventBox: "event box color = trigger of its active page: yellow action button, orange player/event touch, red autorun, purple parallel, gray no active page (initial state)",
  start: "green box + S = player start",
  entry: "cyan box + T = arrival cell of a Transfer Player into this map",
  passability: "overlay passability: red cells = blocked, red lines = walls between walkable cells",
  reachable: "overlay reachable: green = reachable from the origin (reachableFrom = white O box; default = every S/T arrival), red = walkable but unreachable, dark = blocked; red lines = walls",
  regions: "overlay regions: tinted cells labelled with their region id",
};

export function renderMap(grid: MapGrid, tileset: TilesetInfo | null, load: ImageLoader, o: RenderOptions): RenderResult {
  const { region: R, cellSize: cs, tileSize: ts } = o;
  const k = cs / ts;
  const fs = cs >= 28 ? 2 : 1;
  const maxRow = String(R.y + R.height - 1);
  const marginL = o.grid ? textWidth(maxRow, fs) + 4 * fs : 0;
  const marginT = o.grid ? 7 * fs + 2 * fs : 0;
  const canvas = new Canvas(marginL + R.width * cs, marginT + R.height * cs, [40, 40, 40, 255]);
  canvas.fillRect(marginL, marginT, R.width * cs, R.height * cs, [0, 0, 0, 255]);
  const missing = new Set<string>();
  const flags = tileset?.flags ?? [];

  const sheets = new Map<string, RgbaImage | null>();
  const sheet = (name: keyof typeof SHEET_INDEX): RgbaImage | null => {
    const file = tileset?.tilesetNames[SHEET_INDEX[name]] ?? "";
    if (!file) return null;
    if (!sheets.has(file)) {
      const img = load("tilesets", file);
      if (!img) missing.add(`img/tilesets/${file}.png`);
      sheets.set(file, img);
    }
    return sheets.get(file) ?? null;
  };
  const cellX = (x: number) => marginL + (x - R.x) * cs;
  const cellY = (y: number) => marginT + (y - R.y) * cs;

  const drawPieces = (pieces: TilePiece[], px: number, py: number) => {
    for (const p of pieces) {
      const img = sheet(p.sheet);
      const dx = px + p.dx * k, dy = py + p.dy * k;
      if (img) canvas.drawImage(img, p.sx, p.sy, p.w, p.h, dx, dy, p.w * k, p.h * k);
      else if (tileset?.tilesetNames[SHEET_INDEX[p.sheet]]) canvas.fillRect(dx, dy, p.w * k, p.h * k, MAGENTA);
    }
  };
  const isHigher = (id: number) => ((flags[id] ?? 0) & FLAG_STAR) !== 0;

  // Lower layer (+ collect star tiles for the upper layer).
  const upper: { x: number; y: number; ids: number[] }[] = [];
  for (let y = R.y; y < R.y + R.height; y++) {
    for (let x = R.x; x < R.x + R.width; x++) {
      const px = cellX(x), py = cellY(y);
      const ids = [0, 1, 2, 3].map((z) => grid.tileId(x, y, z));
      const up: number[] = [];
      const lower = (id: number) => (isHigher(id) ? up.push(id) : drawPieces(tilePieces(id, flags, ts), px, py));
      lower(ids[0]!);
      lower(ids[1]!);
      const shadow = grid.shadowBits(x, y);
      for (let i = 0; i < 4; i++) {
        if (shadow & (1 << i)) canvas.fillRect(px + (i % 2) * (cs / 2), py + Math.floor(i / 2) * (cs / 2), cs / 2, cs / 2, [0, 0, 0, 128]);
      }
      const above1 = y > 0 ? grid.tileId(x, y - 1, 1) : 0;
      if (isTableTile(above1, flags) && !isTableTile(ids[1]!, flags) && !isShadowingTile(ids[0]!)) drawPieces(tableEdgePieces(above1, ts), px, py);
      lower(ids[2]!);
      lower(ids[3]!);
      if (up.length) upper.push({ x, y, ids: up });
    }
  }

  const inRegion = (e: { x: number; y: number }) => e.x >= R.x && e.x < R.x + R.width && e.y >= R.y && e.y < R.y + R.height;
  const visible = grid.events.filter((e) => inRegion(e) || (e.x >= R.x && e.x < R.x + R.width && e.y >= R.y + R.height && e.y < R.y + R.height + 2));
  const sprite = (e: GridEvent) => {
    if (e.pageIndex === null) return;
    const px = cellX(e.x), py = cellY(e.y);
    if (e.tileId > 0) {
      drawPieces(tilePieces(e.tileId, flags, ts), px, py);
      return;
    }
    if (!e.characterName) return;
    const img = load("characters", e.characterName);
    if (!img) {
      missing.add(`img/characters/${e.characterName}.png`);
      canvas.fillRect(px + cs * 0.2, py + cs * 0.1, cs * 0.6, cs * 0.8, MAGENTA);
      return;
    }
    const sign = /^[!$]+/.exec(e.characterName)?.[0] ?? "";
    const big = sign.includes("$");
    const object = sign.includes("!");
    const pw = big ? img.width / 3 : img.width / 12;
    const ph = big ? img.height / 4 : img.height / 8;
    const bx = big ? 0 : (e.characterIndex % 4) * 3;
    const by = big ? 0 : Math.floor(e.characterIndex / 4) * 4;
    const sx = (bx + Math.min(2, Math.max(0, e.pattern))) * pw;
    const sy = (by + Math.max(0, (e.direction - 2) / 2)) * ph;
    const shiftY = object ? 0 : 6;
    const dw = pw * k, dh = ph * k;
    canvas.drawImage(img, sx, sy, pw, ph, px + cs / 2 - dw / 2, py + cs - shiftY * k - dh, dw, dh);
  };

  if (o.events === "sprites") {
    const byY = (a: GridEvent, b: GridEvent) => a.y - b.y || a.id - b.id;
    for (const e of visible.filter((v) => v.priority === 0).sort(byY)) sprite(e);
    for (const e of visible.filter((v) => v.priority === 1).sort(byY)) sprite(e);
  }
  for (const u of upper) for (const id of u.ids) drawPieces(tilePieces(id, flags, ts), cellX(u.x), cellY(u.y));
  if (o.events === "sprites") for (const e of visible.filter((v) => v.priority === 2).sort((a, b) => a.y - b.y)) sprite(e);

  // Overlays.
  const solid = (x: number, y: number) => grid.tileExits(x, y).length === 0;
  const wallLines = () => {
    const t = Math.max(2, Math.round(cs / 12));
    for (let y = R.y; y < R.y + R.height; y++) {
      for (let x = R.x; x < R.x + R.width; x++) {
        if (solid(x, y)) continue;
        for (const d of DIRS) {
          const n = grid.step(x, y, d);
          if (!n || solid(n.x, n.y) || grid.edgeOpen(x, y, d)) continue;
          const px = cellX(x), py = cellY(y);
          if (d === 2) canvas.fillRect(px, py + cs - t / 2, cs, t / 2, [230, 30, 30, 230]);
          else if (d === 8) canvas.fillRect(px, py, cs, t / 2, [230, 30, 30, 230]);
          else if (d === 4) canvas.fillRect(px, py, t / 2, cs, [230, 30, 30, 230]);
          else canvas.fillRect(px + cs - t / 2, py, t / 2, cs, [230, 30, 30, 230]);
        }
      }
    }
  };
  if (o.overlay === "passability" || o.overlay === "reachable") {
    for (let y = R.y; y < R.y + R.height; y++) {
      for (let x = R.x; x < R.x + R.width; x++) {
        let c: Color | null = null;
        if (solid(x, y)) c = o.overlay === "passability" ? [230, 30, 30, 110] : [0, 0, 0, 120];
        else if (o.overlay === "reachable" && o.reach) c = o.reach[grid.index(x, y)]! >= 0 ? [40, 220, 80, 80] : [230, 30, 30, 110];
        if (c) canvas.fillRect(cellX(x), cellY(y), cs, cs, c);
      }
    }
    wallLines();
  } else if (o.overlay === "regions") {
    for (let y = R.y; y < R.y + R.height; y++) {
      for (let x = R.x; x < R.x + R.width; x++) {
        const r = grid.regionId(x, y);
        if (!r) continue;
        canvas.fillRect(cellX(x), cellY(y), cs, cs, [...regionColor(r), 120] as Color);
        if (cs >= 12) canvas.label(cellX(x) + 1, cellY(y) + cs - 7 * fs - 1, String(r), [255, 255, 255, 255], [0, 0, 0, 160], fs);
      }
    }
  }

  if (o.grid) {
    for (let x = 0; x <= R.width; x++) canvas.fillRect(marginL + x * cs, marginT, 1, R.height * cs, (R.x + x) % 5 === 0 ? [0, 0, 0, 150] : [0, 0, 0, 70]);
    for (let y = 0; y <= R.height; y++) canvas.fillRect(marginL, marginT + y * cs, R.width * cs, 1, (R.y + y) % 5 === 0 ? [0, 0, 0, 150] : [0, 0, 0, 70]);
  }

  // Markers.
  const t = cs >= 24 ? 2 : 1;
  const box = (p: Point, c: Color, tag: string) => {
    if (!inRegion(p)) return;
    canvas.strokeRect(cellX(p.x), cellY(p.y), cs, cs, c, t);
    canvas.label(cellX(p.x) + t, cellY(p.y) + t, tag, [0, 0, 0, 255], c, fs);
  };
  if (o.events !== "none") {
    for (const e of grid.events) {
      if (!inRegion(e)) continue;
      const c = e.pageIndex === null || e.trigger === null ? INACTIVE : (TRIGGER_COLORS[e.trigger] ?? INACTIVE);
      canvas.strokeRect(cellX(e.x), cellY(e.y), cs, cs, c, t);
      canvas.label(cellX(e.x) + t, cellY(e.y) + t, String(e.id), [0, 0, 0, 255], c, fs);
    }
  }
  for (const en of o.entries ?? []) box(en, [0, 220, 255, 255], "T");
  if (o.start) box(o.start, [40, 230, 80, 255], "S");
  if (o.overlay === "reachable") for (const p of o.reachOrigins ?? []) box(p, [255, 255, 255, 255], "O");

  // Axis labels (drawn last: they also hide sprite overflow above the map).
  if (o.grid) {
    canvas.fillRect(0, 0, canvas.width, marginT, [40, 40, 40, 255]);
    canvas.fillRect(0, 0, marginL, canvas.height, [40, 40, 40, 255]);
    const labelEvery = (w: number) => [1, 2, 5, 10, 20].find((n) => n * cs >= w + 2 * fs) ?? 50;
    const stepX = labelEvery(textWidth(String(R.x + R.width - 1), fs));
    for (let x = R.x; x < R.x + R.width; x++) {
      if (x % stepX !== 0 && x !== R.x) continue;
      const s = String(x);
      canvas.text(cellX(x) + Math.max(0, (cs - textWidth(s, fs)) / 2), fs, s, [230, 230, 230, 255], fs);
    }
    const stepY = labelEvery(5 * fs);
    for (let y = R.y; y < R.y + R.height; y++) {
      if (y % stepY !== 0 && y !== R.y) continue;
      const s = String(y);
      canvas.text(marginL - 2 * fs - textWidth(s, fs), cellY(y) + Math.max(0, (cs - 5 * fs) / 2), s, [230, 230, 230, 255], fs);
    }
  }
  return { canvas, originX: marginL, originY: marginT, missingImages: [...missing] };
}

function regionColor(id: number): [number, number, number] {
  const h = (id * 137.508) % 360;
  const f = (n: number) => {
    const kk = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(kk, 4 - kk, 1)) * 0.8));
  };
  return [f(5), f(3), f(1)];
}

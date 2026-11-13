/**
 * RPG Maker MZ tile IDs, tileset flags and tile-sheet geometry.
 *
 * Tile ID ranges (native format):
 *   B 0-255, C 256-511, D 512-767, E 768-1023, A5 1536-1663,
 *   A1 2048-2815, A2 2816-4351, A3 4352-5887, A4 5888-8191.
 * Autotiles (A1-A4) are `base + kind * 48 + shape`. The shape picks which
 * quarter-tiles (half-tile squares) of the kind's block are drawn in each
 * corner. The shape tables below are DERIVED from the shape semantics
 * (which edges are open, which inner corners are cut), not copied; a local
 * test compares them with the engine tables when an MZ install is configured.
 */

export const TILE_ID_B = 0;
export const TILE_ID_C = 256;
export const TILE_ID_D = 512;
export const TILE_ID_E = 768;
export const TILE_ID_A5 = 1536;
export const TILE_ID_A1 = 2048;
export const TILE_ID_A2 = 2816;
export const TILE_ID_A3 = 4352;
export const TILE_ID_A4 = 5888;
export const TILE_ID_MAX = 8192;

/** tilesetNames index of each sheet. */
export const SHEET_INDEX = { A1: 0, A2: 1, A3: 2, A4: 3, A5: 4, B: 5, C: 6, D: 7, E: 8 } as const;
export type SheetName = keyof typeof SHEET_INDEX;

// Tileset flag bits (Tilesets.json `flags[tileId]`).
export const FLAG_PASS_DOWN = 0x01;
export const FLAG_PASS_LEFT = 0x02;
export const FLAG_PASS_RIGHT = 0x04;
export const FLAG_PASS_UP = 0x08;
export const FLAG_STAR = 0x10;
export const FLAG_LADDER = 0x20;
export const FLAG_BUSH = 0x40;
export const FLAG_COUNTER = 0x80;
export const FLAG_DAMAGE = 0x100;
export const FLAG_BOAT = 0x200;
export const FLAG_SHIP = 0x400;
export const FLAG_AIRSHIP = 0x800;

export const isVisibleTile = (id: number) => id > 0 && id < TILE_ID_MAX;
export const isAutotile = (id: number) => id >= TILE_ID_A1;
export const autotileKind = (id: number) => Math.floor((id - TILE_ID_A1) / 48);
export const autotileShape = (id: number) => (id - TILE_ID_A1) % 48;
export const isTileA1 = (id: number) => id >= TILE_ID_A1 && id < TILE_ID_A2;
export const isTileA2 = (id: number) => id >= TILE_ID_A2 && id < TILE_ID_A3;
export const isTileA3 = (id: number) => id >= TILE_ID_A3 && id < TILE_ID_A4;
export const isTileA4 = (id: number) => id >= TILE_ID_A4 && id < TILE_ID_MAX;
export const isTileA5 = (id: number) => id >= TILE_ID_A5 && id < TILE_ID_A1;
export const isShadowingTile = (id: number) => isTileA3(id) || isTileA4(id);
export const isWaterfallTile = (id: number) => id >= TILE_ID_A1 + 192 && id < TILE_ID_A2 && autotileKind(id) % 2 === 1;
export const isRoofTile = (id: number) => isTileA3(id) && autotileKind(id) % 16 < 8;
export const isWallTopTile = (id: number) => isTileA4(id) && autotileKind(id) % 16 < 8;
export const isWallSideTile = (id: number) => (isTileA3(id) || isTileA4(id)) && autotileKind(id) % 16 >= 8;
export const isTableTile = (id: number, flags: ArrayLike<number>) => isTileA2(id) && ((flags[id] ?? 0) & FLAG_COUNTER) !== 0;

export function sheetOf(id: number): SheetName | null {
  if (!isVisibleTile(id)) return null;
  if (id >= TILE_ID_A4) return "A4";
  if (id >= TILE_ID_A3) return "A3";
  if (id >= TILE_ID_A2) return "A2";
  if (id >= TILE_ID_A1) return "A1";
  if (id >= TILE_ID_A5) return id < TILE_ID_A5 + 128 ? "A5" : null;
  if (id < 1024) return (["B", "C", "D", "E"] as const)[Math.floor(id / 256)]!;
  return null;
}

/** Human-readable tile description, e.g. "A2 floor autotile kind 17, shape 46" or "B tile 133 (col 5, row 16)". */
export function describeTile(id: number): string {
  if (id === 0) return "empty";
  const sheet = sheetOf(id);
  if (!sheet) return `invalid tile id ${id}`;
  if (isAutotile(id)) {
    const kind = autotileKind(id);
    let what = "floor autotile";
    if (isTileA1(id)) what = isWaterfallTile(id) ? "waterfall autotile" : "water autotile";
    else if (isRoofTile(id)) what = "roof autotile";
    else if (isWallTopTile(id)) what = "wall-top autotile";
    else if (isWallSideTile(id)) what = "wall-side autotile";
    return `${sheet} ${what} kind ${kind}, shape ${autotileShape(id)}`;
  }
  const local = sheet === "A5" ? id - TILE_ID_A5 : id % 256;
  const col = (Math.floor(local / 128) % 2) * 8 + (local % 8);
  const row = Math.floor((local % 256) / 8) % 16;
  return `${sheet} tile ${local} (col ${col}, row ${row})`;
}

export interface FlagInfo {
  /** Passage bits as set in the tileset (true = blocked in that direction). */
  blocked: { down: boolean; left: boolean; right: boolean; up: boolean };
  star: boolean;
  ladder: boolean;
  bush: boolean;
  counter: boolean;
  damage: boolean;
  terrainTag: number;
}

export function decodeFlags(flag: number): FlagInfo {
  return {
    blocked: { down: (flag & FLAG_PASS_DOWN) !== 0, left: (flag & FLAG_PASS_LEFT) !== 0, right: (flag & FLAG_PASS_RIGHT) !== 0, up: (flag & FLAG_PASS_UP) !== 0 },
    star: (flag & FLAG_STAR) !== 0,
    ladder: (flag & FLAG_LADDER) !== 0,
    bush: (flag & FLAG_BUSH) !== 0,
    counter: (flag & FLAG_COUNTER) !== 0,
    damage: (flag & FLAG_DAMAGE) !== 0,
    terrainTag: flag >> 12,
  };
}

// ------------------------------------------------------------------ autotile shape tables (derived)

/** Quarter-tile coordinates [qx, qy] for the 4 corners (TL, TR, BL, BR) of a shape. */
export type QuarterTable = [number, number][][];

type Edge = "T" | "L" | "R" | "B";
type Corner = "TL" | "TR" | "BL" | "BR";

/** Floor shapes 0-46: [open edges, inner corners selected by the low bits in order]. Shape 47 is the single-tile preview. */
const FLOOR_SHAPE_GROUPS: [Edge[], Corner[], number][] = [
  [[], ["TL", "TR", "BR", "BL"], 16],
  [["L"], ["TR", "BR"], 4],
  [["T"], ["BR", "BL"], 4],
  [["R"], ["BL", "TL"], 4],
  [["B"], ["TL", "TR"], 4],
  [["L", "R"], [], 1],
  [["T", "B"], [], 1],
  [["T", "L"], ["BR"], 2],
  [["T", "R"], ["BL"], 2],
  [["B", "R"], ["TL"], 2],
  [["B", "L"], ["TR"], 2],
  [["T", "L", "R"], [], 1],
  [["T", "L", "B"], [], 1],
  [["L", "B", "R"], [], 1],
  [["T", "R", "B"], [], 1],
  [["T", "L", "R", "B"], [], 1],
];

function buildFloorTable(): QuarterTable {
  const table: QuarterTable = [];
  for (const [open, corners, count] of FLOOR_SHAPE_GROUPS) {
    for (let bits = 0; bits < count; bits++) {
      const o = new Set(open);
      const cut = new Set(corners.filter((_c, i) => (bits >> i) & 1));
      // Block layout (4x6 quarters): rows 0-1 = single tile + inner corners, rows 2-5 = the 2x2-tile frame.
      table.push([
        cut.has("TL") ? [2, 0] : [o.has("L") ? 0 : 2, o.has("T") ? 2 : 4],
        cut.has("TR") ? [3, 0] : [o.has("R") ? 3 : 1, o.has("T") ? 2 : 4],
        cut.has("BL") ? [2, 1] : [o.has("L") ? 0 : 2, o.has("B") ? 5 : 3],
        cut.has("BR") ? [3, 1] : [o.has("R") ? 3 : 1, o.has("B") ? 5 : 3],
      ]);
    }
  }
  table.push([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]);
  return table;
}

/** Wall/roof shapes 0-15: bit0 left open, bit1 top open, bit2 right open, bit3 bottom open (4x4 quarter block). */
function buildWallTable(): QuarterTable {
  const table: QuarterTable = [];
  for (let s = 0; s < 16; s++) {
    const L = s & 1, T = s & 2, R = s & 4, B = s & 8;
    table.push([
      [L ? 0 : 2, T ? 0 : 2],
      [R ? 3 : 1, T ? 0 : 2],
      [L ? 0 : 2, B ? 3 : 1],
      [R ? 3 : 1, B ? 3 : 1],
    ]);
  }
  return table;
}

/** Waterfall shapes 0-3: bit0 left open, bit1 right open (4x2 quarter block). */
function buildWaterfallTable(): QuarterTable {
  const table: QuarterTable = [];
  for (let s = 0; s < 4; s++) {
    const L = s & 1, R = s & 2;
    table.push([
      [L ? 0 : 2, 0],
      [R ? 3 : 1, 0],
      [L ? 0 : 2, 1],
      [R ? 3 : 1, 1],
    ]);
  }
  return table;
}

export const FLOOR_AUTOTILE_TABLE = buildFloorTable();
export const WALL_AUTOTILE_TABLE = buildWallTable();
export const WATERFALL_AUTOTILE_TABLE = buildWaterfallTable();

// ------------------------------------------------------------------ sheet geometry

/** A source rectangle on a tileset sheet and where it lands inside the destination cell (in source pixels). */
export interface TilePiece {
  sheet: SheetName;
  sx: number;
  sy: number;
  w: number;
  h: number;
  /** Offset inside the cell. */
  dx: number;
  dy: number;
}

/**
 * Pieces that draw `tileId` into one cell, following the engine's tilemap
 * rules (normal tiles, autotile quarter composition, counter-top "table"
 * tiles). `animationFrame` 0 is used for water.
 */
export function tilePieces(tileId: number, flags: ArrayLike<number>, tileSize: number, animationFrame = 0): TilePiece[] {
  if (!isVisibleTile(tileId)) return [];
  const sheet = sheetOf(tileId);
  if (!sheet) return [];
  if (!isAutotile(tileId)) {
    const sx = ((Math.floor(tileId / 128) % 2) * 8 + (tileId % 8)) * tileSize;
    const sy = (Math.floor((tileId % 256) / 8) % 16) * tileSize;
    return [{ sheet, sx, sy, w: tileSize, h: tileSize, dx: 0, dy: 0 }];
  }
  const kind = autotileKind(tileId);
  const shape = autotileShape(tileId);
  const tx = kind % 8;
  const ty = Math.floor(kind / 8);
  let bx = 0;
  let by = 0;
  let table = FLOOR_AUTOTILE_TABLE;
  let isTable = false;
  if (isTileA1(tileId)) {
    const water = [0, 1, 2, 1][animationFrame % 4]!;
    if (kind === 0) [bx, by] = [water * 2, 0];
    else if (kind === 1) [bx, by] = [water * 2, 3];
    else if (kind === 2) [bx, by] = [6, 0];
    else if (kind === 3) [bx, by] = [6, 3];
    else {
      bx = Math.floor(tx / 4) * 8;
      by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
      if (kind % 2 === 0) bx += water * 2;
      else {
        bx += 6;
        table = WATERFALL_AUTOTILE_TABLE;
        by += animationFrame % 3;
      }
    }
  } else if (isTileA2(tileId)) {
    bx = tx * 2;
    by = (ty - 2) * 3;
    isTable = isTableTile(tileId, flags);
  } else if (isTileA3(tileId)) {
    bx = tx * 2;
    by = (ty - 6) * 2;
    table = WALL_AUTOTILE_TABLE;
  } else {
    bx = tx * 2;
    by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
    if (ty % 2 === 1) table = WALL_AUTOTILE_TABLE;
  }
  const quarters = table[shape];
  if (!quarters) return [];
  const h1 = tileSize / 2;
  const out: TilePiece[] = [];
  quarters.forEach(([qsx, qsy], i) => {
    const sx = (bx * 2 + qsx) * h1;
    const sy = (by * 2 + qsy) * h1;
    const dx = (i % 2) * h1;
    const dy = Math.floor(i / 2) * h1;
    if (isTable && (qsy === 1 || qsy === 5)) {
      const qsx2 = qsy === 1 ? (4 - qsx) % 4 : qsx;
      out.push({ sheet, sx: (bx * 2 + qsx2) * h1, sy: (by * 2 + 3) * h1, w: h1, h: h1, dx, dy });
      out.push({ sheet, sx, sy, w: h1, h: h1 / 2, dx, dy: dy + h1 / 2 });
    } else out.push({ sheet, sx, sy, w: h1, h: h1, dx, dy });
  });
  return out;
}

/** The lower half-edge of a counter-top ("table") A2 tile drawn into the cell below it. */
export function tableEdgePieces(tileId: number, tileSize: number): TilePiece[] {
  if (!isTileA2(tileId)) return [];
  const kind = autotileKind(tileId);
  const quarters = FLOOR_AUTOTILE_TABLE[autotileShape(tileId)];
  if (!quarters) return [];
  const bx = (kind % 8) * 2;
  const by = (Math.floor(kind / 8) - 2) * 3;
  const h1 = tileSize / 2;
  return [0, 1].map((i) => {
    const [qsx, qsy] = quarters[2 + i]!;
    return { sheet: "A2" as const, sx: (bx * 2 + qsx) * h1, sy: (by * 2 + qsy) * h1 + h1 / 2, w: h1, h: h1 / 2, dx: i * h1, dy: 0 };
  });
}

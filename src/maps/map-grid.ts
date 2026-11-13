import {
  FLAG_BUSH,
  FLAG_COUNTER,
  FLAG_DAMAGE,
  FLAG_LADDER,
  FLAG_STAR,
} from "./tiles.js";

/**
 * Passability model of one map, mirroring the engine's rules:
 *
 *  - `checkPassage`: tiles at a cell are checked top layer first (tile events
 *    with "below characters" priority before the 4 tile layers). Star tiles
 *    are skipped; the first other tile decides (bit clear = passable).
 *  - A step from A to B in direction d needs `isPassable(A, d)` and
 *    `isPassable(B, reverse(d))`. Tile passage is therefore symmetric: the
 *    same two bits decide both directions.
 *  - Events with "same as characters" priority that are not "through" block
 *    the player. Moving events are blocked by any non-through event.
 *
 * Events are evaluated in an assumed game state (default: all switches and
 * self switches OFF, variables 0) to pick each event's active page.
 */

export type Dir = 2 | 4 | 6 | 8;
export const DIRS: readonly Dir[] = [2, 4, 6, 8];
export const DIR_NAME: Record<Dir, "down" | "left" | "right" | "up"> = { 2: "down", 4: "left", 6: "right", 8: "up" };
export const reverseDir = (d: Dir): Dir => (10 - d) as Dir;

export interface Point {
  x: number;
  y: number;
}

export interface GridEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  /** Active page index in the assumed state, or null (no page active: the event does not exist). */
  pageIndex: number | null;
  /** 0 below characters, 1 same as characters, 2 above characters. */
  priority: number;
  through: boolean;
  tileId: number;
  characterName: string;
  characterIndex: number;
  direction: number;
  pattern: number;
  /** 0 action button, 1 player touch, 2 event touch, 3 autorun, 4 parallel (null when no page is active). */
  trigger: number | null;
  /** True when the active page has commands besides the terminator. */
  hasCommands: boolean;
}

export interface MoveOptions {
  /** Who moves: the player (default) or a map event (blocked by any non-through event). */
  moverEventId?: number;
  /** Ignore events entirely (tiles only). */
  ignoreEvents?: boolean;
  /** Event ids that never block (e.g. NPCs that will have moved away). */
  ignoreEventIds?: readonly number[];
  /** Extra blocked cells (e.g. vehicles, the player for moving events). */
  blocked?: readonly Point[];
}

export interface MapGridInput {
  width: number;
  height: number;
  data: readonly number[];
  flags: ArrayLike<number>;
  /** scrollType: 0 none, 1 loop vertically, 2 loop horizontally, 3 both. */
  scrollType?: number;
  events?: readonly GridEvent[];
}

export class MapGrid {
  readonly width: number;
  readonly height: number;
  readonly loopX: boolean;
  readonly loopY: boolean;
  readonly events: readonly GridEvent[];
  private readonly data: readonly number[];
  private readonly flags: ArrayLike<number>;
  private readonly tileEventsAt = new Map<number, number[]>();
  private readonly eventsAt = new Map<number, GridEvent[]>();

  constructor(input: MapGridInput) {
    this.width = input.width;
    this.height = input.height;
    this.data = input.data;
    this.flags = input.flags;
    const st = input.scrollType ?? 0;
    this.loopY = st === 1 || st === 3;
    this.loopX = st === 2 || st === 3;
    this.events = input.events ?? [];
    for (const e of this.events) {
      if (e.pageIndex === null || !this.valid(e.x, e.y)) continue;
      const i = this.index(e.x, e.y);
      const list = this.eventsAt.get(i) ?? [];
      list.push(e);
      this.eventsAt.set(i, list);
      // Engine: tile events = tileId > 0 with "below characters" priority; they join the passage check unless through.
      if (e.tileId > 0 && e.priority === 0 && !e.through) {
        const t = this.tileEventsAt.get(i) ?? [];
        t.push(e.tileId);
        this.tileEventsAt.set(i, t);
      }
    }
  }

  valid(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  point(i: number): Point {
    return { x: i % this.width, y: Math.floor(i / this.width) };
  }

  tileId(x: number, y: number, z: number): number {
    return this.data[(z * this.height + y) * this.width + x] ?? 0;
  }

  flag(tileId: number): number {
    return this.flags[tileId] ?? 0;
  }

  /** Tile ids that take part in the passage check, top first (tile events, then layers 3..0). */
  passageTiles(x: number, y: number): number[] {
    return [...(this.tileEventsAt.get(this.index(x, y)) ?? []), this.tileId(x, y, 3), this.tileId(x, y, 2), this.tileId(x, y, 1), this.tileId(x, y, 0)];
  }

  checkPassage(x: number, y: number, bit: number): boolean {
    for (const t of this.passageTiles(x, y)) {
      const f = this.flag(t);
      if (f & FLAG_STAR) continue;
      return (f & bit) === 0;
    }
    return false;
  }

  /** Engine `Game_Map.isPassable`: can a character leave/enter this cell through side `d`? */
  isPassable(x: number, y: number, d: Dir): boolean {
    return this.checkPassage(x, y, (1 << (d / 2 - 1)) & 0x0f);
  }

  /** Neighbour cell in direction d (with map looping), or null outside the map. */
  step(x: number, y: number, d: Dir): Point | null {
    let x2 = x + (d === 6 ? 1 : d === 4 ? -1 : 0);
    let y2 = y + (d === 2 ? 1 : d === 8 ? -1 : 0);
    if (this.loopX) x2 = ((x2 % this.width) + this.width) % this.width;
    if (this.loopY) y2 = ((y2 % this.height) + this.height) % this.height;
    return this.valid(x2, y2) ? { x: x2, y: y2 } : null;
  }

  /** Tile-only passage between a cell and its neighbour (symmetric). */
  edgeOpen(x: number, y: number, d: Dir): boolean {
    const n = this.step(x, y, d);
    return !!n && this.isPassable(x, y, d) && this.isPassable(n.x, n.y, reverseDir(d));
  }

  /** Events at a cell whose active page exists. */
  eventsAtCell(x: number, y: number): GridEvent[] {
    return this.eventsAt.get(this.index(x, y)) ?? [];
  }

  /** Events that would block a mover entering this cell. */
  blockingEventsAt(x: number, y: number, opts: MoveOptions = {}): GridEvent[] {
    if (opts.ignoreEvents) return [];
    return this.eventsAtCell(x, y).filter((e) => {
      if (e.through || e.id === opts.moverEventId || opts.ignoreEventIds?.includes(e.id)) return false;
      return opts.moverEventId !== undefined ? true : e.priority === 1;
    });
  }

  /** Engine `canPass`: map passage both ways + no colliding character at the destination. */
  canMove(x: number, y: number, d: Dir, opts: MoveOptions = {}): Point | null {
    const n = this.step(x, y, d);
    if (!n) return null;
    if (!this.isPassable(x, y, d) || !this.isPassable(n.x, n.y, reverseDir(d))) return null;
    if (this.blockingEventsAt(n.x, n.y, opts).length) return null;
    if (opts.blocked?.some((p) => p.x === n.x && p.y === n.y)) return null;
    return n;
  }

  /** Engine `canPassDiagonally`: one of the two L-shaped routes must be open. */
  canMoveDiagonal(x: number, y: number, horz: 4 | 6, vert: 2 | 8, opts: MoveOptions = {}): Point | null {
    const a = this.canMove(x, y, vert, opts);
    const b = a && this.canMove(a.x, a.y, horz, opts);
    if (b) return b;
    const c = this.canMove(x, y, horz, opts);
    const e = c && this.canMove(c.x, c.y, vert, opts);
    return e || null;
  }

  /** Directions a character can leave this cell to (tile passage only). */
  tileExits(x: number, y: number): Dir[] {
    return DIRS.filter((d) => this.edgeOpen(x, y, d));
  }

  /** Breadth-first distances from the start cells (-1 = unreachable). */
  distances(starts: readonly Point[], opts: MoveOptions = {}): Int32Array {
    const dist = new Int32Array(this.width * this.height).fill(-1);
    const queue: number[] = [];
    for (const s of starts) {
      if (!this.valid(s.x, s.y)) continue;
      const i = this.index(s.x, s.y);
      if (dist[i] === -1) {
        dist[i] = 0;
        queue.push(i);
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const cur = queue[h]!;
      const { x, y } = this.point(cur);
      for (const d of DIRS) {
        const n = this.canMove(x, y, d, opts);
        if (!n) continue;
        const j = this.index(n.x, n.y);
        if (dist[j] !== -1) continue;
        dist[j] = dist[cur]! + 1;
        queue.push(j);
      }
    }
    return dist;
  }

  /** Shortest 4-directional path (directions to walk), or null when unreachable. */
  findPath(from: Point, to: Point, opts: MoveOptions = {}): Dir[] | null {
    if (!this.valid(from.x, from.y) || !this.valid(to.x, to.y)) return null;
    const target = this.index(to.x, to.y);
    const prev = new Int32Array(this.width * this.height).fill(-1);
    const via = new Uint8Array(this.width * this.height);
    const start = this.index(from.x, from.y);
    prev[start] = start;
    const queue = [start];
    for (let h = 0; h < queue.length && prev[target] === -1; h++) {
      const cur = queue[h]!;
      const { x, y } = this.point(cur);
      for (const d of DIRS) {
        const n = this.canMove(x, y, d, opts);
        if (!n) continue;
        const j = this.index(n.x, n.y);
        if (prev[j] !== -1) continue;
        prev[j] = cur;
        via[j] = d;
        queue.push(j);
      }
    }
    if (prev[target] === -1) return null;
    const path: Dir[] = [];
    for (let i = target; i !== start; i = prev[i]!) path.push(via[i] as Dir);
    return path.reverse();
  }

  /** Connected walkable areas (cells with at least one tile exit), largest first. */
  components(opts: MoveOptions = {}): { label: Int32Array; areas: { id: number; size: number; sample: Point; bounds: { x: number; y: number; width: number; height: number } }[] } {
    const label = new Int32Array(this.width * this.height).fill(-1);
    const areas: { id: number; size: number; sample: Point; bounds: { x: number; y: number; width: number; height: number } }[] = [];
    for (let i = 0; i < label.length; i++) {
      if (label[i] !== -1) continue;
      const p = this.point(i);
      if (!this.tileExits(p.x, p.y).length || this.blockingEventsAt(p.x, p.y, opts).length) continue;
      const dist = this.distances([p], opts);
      let size = 0;
      let x0 = p.x, y0 = p.y, x1 = p.x, y1 = p.y;
      dist.forEach((v, j) => {
        if (v < 0 || label[j] !== -1) return;
        label[j] = areas.length;
        size++;
        const q = this.point(j);
        x0 = Math.min(x0, q.x);
        y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x);
        y1 = Math.max(y1, q.y);
      });
      areas.push({ id: areas.length, size, sample: p, bounds: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } });
    }
    const order = areas.map((a) => a.id).sort((a, b) => areas[b]!.size - areas[a]!.size);
    const remap = new Map(order.map((old, i) => [old, i]));
    for (let i = 0; i < label.length; i++) if (label[i]! >= 0) label[i] = remap.get(label[i]!)!;
    return { label, areas: order.map((old, i) => ({ ...areas[old]!, id: i })) };
  }

  // ---------------------------------------------------------------- cell attributes

  private layersHave(x: number, y: number, bit: number): boolean {
    for (let z = 0; z < 4; z++) if (this.flag(this.tileId(x, y, z)) & bit) return true;
    return false;
  }

  isLadder(x: number, y: number): boolean {
    return this.valid(x, y) && this.layersHave(x, y, FLAG_LADDER);
  }

  isBush(x: number, y: number): boolean {
    return this.valid(x, y) && this.layersHave(x, y, FLAG_BUSH);
  }

  isCounter(x: number, y: number): boolean {
    return this.valid(x, y) && this.layersHave(x, y, FLAG_COUNTER);
  }

  isDamageFloor(x: number, y: number): boolean {
    return this.valid(x, y) && this.layersHave(x, y, FLAG_DAMAGE);
  }

  terrainTag(x: number, y: number): number {
    if (!this.valid(x, y)) return 0;
    for (let z = 3; z >= 0; z--) {
      const tag = this.flag(this.tileId(x, y, z)) >> 12;
      if (tag > 0) return tag;
    }
    return 0;
  }

  regionId(x: number, y: number): number {
    return this.valid(x, y) ? this.tileId(x, y, 5) : 0;
  }

  shadowBits(x: number, y: number): number {
    return this.valid(x, y) ? this.tileId(x, y, 4) & 0x0f : 0;
  }

  /**
   * Cells from which the player can trigger an event by facing it (action
   * button / touch): adjacent cells for "same as characters" priority (also
   * across one counter tile for the action button), the event's own cell
   * otherwise.
   */
  interactionCells(ev: GridEvent, trigger: number): Point[] {
    if (ev.priority !== 1) return [{ x: ev.x, y: ev.y }];
    const out: Point[] = [];
    for (const d of DIRS) {
      const n = this.step(ev.x, ev.y, d);
      if (!n) continue;
      out.push(n);
      if (trigger === 0 && this.isCounter(n.x, n.y)) {
        const n2 = this.step(n.x, n.y, d);
        if (n2) out.push(n2);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ ASCII grid

export interface AsciiOptions {
  region: { x: number; y: number; width: number; height: number };
  /** Reachability (from `distances`); open cells not reached are drawn as "o". */
  reach?: Int32Array;
  moveOptions?: MoveOptions;
  /** Extra cell markers, drawn over everything else (e.g. "S" start, "@" origin, "*" path). */
  markers?: { x: number; y: number; glyph: string }[];
}

export const ASCII_LEGEND: Record<string, string> = {
  ".": "walkable",
  o: "walkable but NOT reachable from the origin",
  "#": "blocked (no exit in any direction)",
  "|": "wall between two horizontally adjacent cells",
  "-": "wall between two vertically adjacent cells",
  "+": "wall corner (cosmetic)",
  E: "event the player cannot walk onto (priority 'same as characters' and not through, or its cell is impassable)",
  e: "event the player can walk onto (below/above characters or through)",
  H: "ladder",
  C: "counter (action button reaches across it)",
  "~": "damage floor",
  '"': "bush",
  S: "player start (System.json; reachability origin unless `from` is given)",
  T: "arrival cell of a Transfer Player into this map (reachability origin unless `from` is given)",
  "@": "origin of the reachability search (from)",
};

/**
 * Two characters per cell: the cell glyph, and between cells the wall
 * markers. Walls next to "#" cells are implied and not drawn.
 */
export function asciiGrid(grid: MapGrid, opts: AsciiOptions): string[] {
  const { x: rx, y: ry, width: rw, height: rh } = opts.region;
  const mo = opts.moveOptions ?? {};
  const solid = (x: number, y: number) => !grid.valid(x, y) || grid.tileExits(x, y).length === 0;
  const glyph = (x: number, y: number): string => {
    const marker = opts.markers?.filter((m) => m.x === x && m.y === y).pop();
    if (marker) return marker.glyph;
    const evs = grid.eventsAtCell(x, y);
    if (evs.length) return solid(x, y) || evs.some((e) => grid.blockingEventsAt(x, y, mo).includes(e)) ? "E" : "e";
    if (grid.isCounter(x, y)) return "C";
    if (solid(x, y)) return "#";
    if (grid.isLadder(x, y)) return "H";
    if (grid.isDamageFloor(x, y)) return "~";
    if (grid.isBush(x, y)) return '"';
    if (opts.reach && opts.reach[grid.index(x, y)]! < 0) return "o";
    return ".";
  };
  const hWall = (x: number, y: number) => {
    // wall between (x, y-1) and (x, y)
    if (solid(x, y - 1) || solid(x, y)) return false;
    return !grid.edgeOpen(x, y, 8);
  };
  const vWall = (x: number, y: number) => {
    // wall between (x-1, y) and (x, y)
    if (solid(x - 1, y) || solid(x, y)) return false;
    return !grid.edgeOpen(x, y, 4);
  };
  const labelW = String(ry + rh - 1).length;
  const pad = " ".repeat(labelW + 1);
  const lines: string[] = [];
  const maxCol = rx + rw - 1;
  const digits = String(maxCol).length;
  for (let k = digits - 1; k >= 0; k--) {
    let s = pad;
    for (let x = rx; x <= maxCol; x++) {
      const str = String(x);
      s += " " + (str.length > k ? str[str.length - 1 - k] : " ");
    }
    lines.push(s.trimEnd());
  }
  const edgeLine = (y: number) => {
    let s = pad;
    for (let x = rx; x <= maxCol + 1; x++) {
      const corner = (x > rx && hWall(x - 1, y)) || (x <= maxCol && hWall(x, y)) || vWall(x, y - 1) || vWall(x, y);
      s += corner ? "+" : " ";
      if (x <= maxCol) s += hWall(x, y) ? "-" : " ";
    }
    return s.trimEnd();
  };
  for (let y = ry; y < ry + rh; y++) {
    if (y > ry) {
      const e = edgeLine(y);
      if (e.trim()) lines.push(e);
      else lines.push("");
    }
    let s = String(y).padStart(labelW) + " ";
    for (let x = rx; x <= maxCol; x++) s += (x > rx && vWall(x, y) ? "|" : " ") + glyph(x, y);
    lines.push(s.trimEnd());
  }
  return lines;
}

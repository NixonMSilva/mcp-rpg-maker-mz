import { McpError, notFound } from "../project/errors.js";
import type { ProjectService } from "../project/project-service.js";
import { projectView, type DataView } from "../references/reference-resolver.js";
import { ASCII_LEGEND, asciiGrid, DIR_NAME, reverseDir, type Dir, type GridEvent, type MoveOptions, type Point } from "./map-grid.js";
import { entryPoints, loadMap, playerStart, tileSizeOf, vehicleCells, type AssumedState, type EntryPoint, type LoadedMap } from "./map-model.js";
import { renderMap, RENDER_LEGEND, type Region } from "./map-renderer.js";
import { decodePng, encodePng, type RgbaImage } from "./png.js";
import { decodeFlags, describeTile, sheetOf } from "./tiles.js";

/**
 * Map awareness for agents: layout images, passability grids, reachability,
 * paths and per-tile facts. Read-only.
 */

export interface PointOrEvent {
  x?: number;
  y?: number;
  eventId?: number;
}

export interface CommonMapArgs {
  mapId: number;
  assume?: AssumedState;
  ignoreEvents?: boolean;
}

const TRIGGERS = ["action_button", "player_touch", "event_touch", "autorun", "parallel"];
const PRIORITIES = ["below_characters", "same_as_characters", "above_characters"];
interface Origin {
  points: Point[];
  eventId?: number;
  /** True when given by the caller (from / reachableFrom). */
  explicit: boolean;
  source: string;
}

const MAX_GRID_CELLS = 120 * 120;
const MAX_IMAGE_PIXELS = 4096 * 4096;

export class MapService {
  private readonly images = new Map<string, { mtimeMs: number; size: number; img: RgbaImage | null; error?: string }>();

  constructor(private readonly project: ProjectService) {}

  private view(): DataView {
    return projectView(this.project);
  }

  load(mapId: number, assume: AssumedState = {}): LoadedMap {
    this.project.mapInfo(mapId);
    const m = loadMap(this.view(), mapId, assume);
    if (!m) throw notFound(`Map ${mapId} has no readable map file.`, { mapId });
    return m;
  }

  /** Decoded image from img/<folder>/<name>.png (cached by mtime/size), or null when missing/unreadable. */
  image(folder: "tilesets" | "characters", name: string): RgbaImage | null {
    const rel = `img/${folder}/${name}.png`;
    let stat: { mtimeMs: number; size: number } | null;
    try {
      stat = this.project.files.statFile(rel);
    } catch {
      return null; // path outside the project (bad name): treat as missing
    }
    if (!stat) return null;
    const cached = this.images.get(rel);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.img;
    const raw = this.project.files.readBytes(rel);
    let img: RgbaImage | null = null;
    let error: string | undefined;
    try {
      img = raw ? decodePng(raw.bytes) : null;
    } catch (err) {
      error = (err as Error).message;
    }
    this.images.set(rel, { ...stat, img, ...(error ? { error } : {}) });
    return img;
  }

  imageError(folder: string, name: string): string | undefined {
    return this.images.get(`img/${folder}/${name}.png`)?.error;
  }

  // ---------------------------------------------------------------- helpers

  private moveOptions(m: LoadedMap, a: { ignoreEvents?: boolean; ignoreEventIds?: number[] }, moverEventId?: number): MoveOptions {
    return {
      ...(a.ignoreEvents ? { ignoreEvents: true } : {}),
      ...(a.ignoreEventIds?.length ? { ignoreEventIds: a.ignoreEventIds } : {}),
      ...(moverEventId !== undefined ? { moverEventId } : {}),
      blocked: a.ignoreEvents ? [] : vehicleCells(this.view(), m.mapId),
    };
  }

  private resolvePoint(m: LoadedMap, p: PointOrEvent, label: string): Point & { eventId?: number } {
    if (p.eventId !== undefined) {
      const ev = m.map.events[p.eventId];
      if (!ev) throw notFound(`${label}: event ${p.eventId} does not exist on map ${m.mapId}.`, { mapId: m.mapId, eventId: p.eventId });
      return { x: ev.x, y: ev.y, eventId: ev.id };
    }
    if (typeof p.x !== "number" || typeof p.y !== "number") throw new McpError("INVALID_INPUT", `${label}: give {x, y} or {eventId}.`);
    if (!m.grid.valid(p.x, p.y)) throw new McpError("INVALID_INPUT", `${label}: (${p.x},${p.y}) is outside the ${m.map.width}x${m.map.height} map.`);
    return { x: p.x, y: p.y };
  }

  private region(m: LoadedMap, r?: Partial<Region>): Region {
    const x = Math.max(0, r?.x ?? 0);
    const y = Math.max(0, r?.y ?? 0);
    const width = Math.min(m.map.width - x, r?.width ?? m.map.width - x);
    const height = Math.min(m.map.height - y, r?.height ?? m.map.height - y);
    if (width <= 0 || height <= 0) throw new McpError("INVALID_INPUT", `region is outside the ${m.map.width}x${m.map.height} map.`);
    return { x, y, width, height };
  }

  /** Reachability origin: explicit `from`, else every known arrival (player start + Transfer Player destinations). */
  private origin(m: LoadedMap, from: PointOrEvent | undefined, entries: EntryPoint[]): Origin | null {
    if (from) {
      const p = this.resolvePoint(m, from, "from");
      return { points: [p], ...(p.eventId !== undefined ? { eventId: p.eventId } : {}), explicit: true, source: p.eventId !== undefined ? `event ${p.eventId} at (${p.x},${p.y})` : `(${p.x},${p.y})` };
    }
    const pts = entries.filter((en) => m.grid.valid(en.x, en.y));
    if (!pts.length) return null;
    return { points: pts.map((e) => ({ x: e.x, y: e.y })), explicit: false, source: pts.length === 1 ? `${pts[0]!.source} (${pts[0]!.x},${pts[0]!.y})` : `any of ${pts.length} arrival points (player start / Transfer Player destinations)` };
  }

  private describeEvent(m: LoadedMap, e: GridEvent, reach: Int32Array | null, mo: MoveOptions): Record<string, unknown> {
    const blocks = !e.through && e.pageIndex !== null && e.priority === 1;
    const out: Record<string, unknown> = {
      id: e.id,
      name: e.name,
      x: e.x,
      y: e.y,
      activePage: e.pageIndex === null ? null : e.pageIndex,
      ...(e.pageIndex === null ? { note: "no page is active in the assumed state (event absent)" } : {}),
      trigger: e.trigger === null ? null : (TRIGGERS[e.trigger] ?? e.trigger),
      priority: PRIORITIES[e.priority] ?? e.priority,
      through: e.through,
      blocksPlayer: blocks && !mo.ignoreEvents && !mo.ignoreEventIds?.includes(e.id),
    };
    if (reach && e.pageIndex !== null && e.trigger !== null && e.trigger <= 2 && e.hasCommands) {
      const cells = m.grid.interactionCells(e, e.trigger);
      out.playerCanTrigger = cells.some((c) => reach[m.grid.index(c.x, c.y)]! >= 0);
    }
    return out;
  }

  // ---------------------------------------------------------------- tools

  passability(a: CommonMapArgs & { from?: PointOrEvent; region?: Partial<Region>; include?: string[]; ignoreEventIds?: number[] }): { text: string[]; data: Record<string, unknown> } {
    const m = this.load(a.mapId, a.assume);
    const include = new Set(a.include?.length ? a.include : ["grid", "areas", "events"]);
    const region = this.region(m, a.region);
    const entries = entryPoints(this.view(), m.mapId);
    const origin = this.origin(m, a.from, entries);
    const mo = this.moveOptions(m, a, origin?.eventId);
    const reach = origin ? m.grid.distances(origin.points, mo) : null;
    const start = playerStart(this.view(), m.mapId);
    const data: Record<string, unknown> = {
      mapId: m.mapId,
      name: m.name,
      width: m.map.width,
      height: m.map.height,
      tileset: m.tileset ? { id: m.tileset.id, name: m.tileset.name } : null,
      region,
      assumedState: describeState(a.assume),
      playerStart: start,
      entryPoints: entries.slice(0, 30),
      origin: origin ? { points: origin.points.slice(0, 30), source: origin.source } : null,
    };
    if (reach) data.reachableCells = reach.reduce((n, v) => n + (v >= 0 ? 1 : 0), 0);
    if (m.problems.length) data.problems = m.problems;
    const text: string[] = [];
    if (include.has("grid") && region.width * region.height > MAX_GRID_CELLS) {
      if (a.region) throw new McpError("INVALID_INPUT", `The grid region is ${region.width}x${region.height}; pass a region of at most ${MAX_GRID_CELLS} cells (e.g. 120x120).`);
      data.gridOmitted = `The map is ${region.width}x${region.height}; the grid is limited to ${MAX_GRID_CELLS} cells. Pass a region (e.g. 60x40 around the area of interest).`;
      text.push(String(data.gridOmitted));
    } else if (include.has("grid")) {
      const markers: { x: number; y: number; glyph: string }[] = [];
      if (start) markers.push({ ...start, glyph: "S" });
      if (!origin?.explicit) for (const e of entries) if (!start || e.x !== start.x || e.y !== start.y) markers.push({ x: e.x, y: e.y, glyph: "T" });
      if (origin?.explicit && origin.eventId === undefined) markers.push({ ...origin.points[0]!, glyph: "@" });
      const lines = asciiGrid(m.grid, { region, ...(reach ? { reach } : {}), moveOptions: mo, markers });
      data.grid = lines;
      data.legend = ASCII_LEGEND;
      text.push("Grid (columns on top, rows on the left; 2 characters per cell):", ...lines);
    }
    if (include.has("areas")) {
      const { areas } = m.grid.components(mo);
      data.walkableAreas = areas.slice(0, 12).map((ar) => ({ ...ar, ...(reach ? { containsOrigin: reach[m.grid.index(ar.sample.x, ar.sample.y)]! >= 0 } : {}) }));
      if (areas.length > 12) data.walkableAreasOmitted = areas.length - 12;
    }
    if (include.has("events")) {
      data.events = m.grid.events.map((e) => this.describeEvent(m, e, reach, mo));
    }
    if (include.has("cells")) {
      const special: Record<string, Point[]> = { ladder: [], bush: [], counter: [], damage: [] };
      const terrain: Record<string, Point[]> = {};
      const regions: Record<string, Point[]> = {};
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          if (m.grid.isLadder(x, y)) special.ladder!.push({ x, y });
          if (m.grid.isBush(x, y)) special.bush!.push({ x, y });
          if (m.grid.isCounter(x, y)) special.counter!.push({ x, y });
          if (m.grid.isDamageFloor(x, y)) special.damage!.push({ x, y });
          const t = m.grid.terrainTag(x, y);
          if (t) (terrain[t] ??= []).push({ x, y });
          const r = m.grid.regionId(x, y);
          if (r) (regions[r] ??= []).push({ x, y });
        }
      }
      data.specialCells = { ...special, terrainTags: terrain, regions };
    }
    data.notes = [
      "Tile passage is symmetric in MZ: a wall between two cells blocks both directions.",
      "Events use the page active in the assumed state (default: all switches/self switches OFF, variables 0, no items). Use `assume` to test other states.",
    ];
    return { text, data };
  }

  tileInfo(a: CommonMapArgs & { positions: Point[]; from?: PointOrEvent }): Record<string, unknown> {
    const m = this.load(a.mapId, a.assume);
    const entries = entryPoints(this.view(), m.mapId);
    const origin = this.origin(m, a.from, entries);
    const mo = this.moveOptions(m, a, origin?.eventId);
    const reach = origin ? m.grid.distances(origin.points, mo) : null;
    const cells = a.positions.map((p) => {
      if (!m.grid.valid(p.x, p.y)) return { x: p.x, y: p.y, error: `outside the ${m.map.width}x${m.map.height} map` };
      const g = m.grid;
      const layers = [0, 1, 2, 3].map((z) => {
        const id = g.tileId(p.x, p.y, z);
        const f = g.flag(id);
        const fl = decodeFlags(f);
        return { z, tileId: id, sheet: sheetOf(id), description: describeTile(id), ...(id ? { flags: `0x${f.toString(16)}`, star: fl.star, blockedSides: Object.entries(fl.blocked).filter(([, v]) => v).map(([k]) => k) } : {}) };
      });
      const exits = g.tileExits(p.x, p.y).map((d) => DIR_NAME[d]);
      const evs = g.eventsAtCell(p.x, p.y);
      const blocking = g.blockingEventsAt(p.x, p.y, mo);
      const reasons: string[] = [];
      if (!exits.length) reasons.push("no tile exit (blocked/enclosed tile)");
      if (evs.length) reasons.push(`occupied by event ${evs.map((e) => e.id).join(", ")}`);
      if (reach && reach[g.index(p.x, p.y)]! < 0 && exits.length) reasons.push(`not reachable from ${origin!.source}`);
      return {
        x: p.x,
        y: p.y,
        layers,
        shadowBits: g.shadowBits(p.x, p.y),
        regionId: g.regionId(p.x, p.y),
        terrainTag: g.terrainTag(p.x, p.y),
        ladder: g.isLadder(p.x, p.y),
        bush: g.isBush(p.x, p.y),
        counter: g.isCounter(p.x, p.y),
        damageFloor: g.isDamageFloor(p.x, p.y),
        exits,
        events: evs.map((e) => ({ id: e.id, name: e.name, blocksPlayer: blocking.includes(e) })),
        ...(reach ? { reachable: reach[g.index(p.x, p.y)]! >= 0, distance: reach[g.index(p.x, p.y)]! >= 0 ? reach[g.index(p.x, p.y)] : null } : {}),
        free: reasons.length === 0,
        ...(reasons.length ? { notFreeBecause: reasons } : {}),
      };
    });
    return {
      mapId: m.mapId,
      name: m.name,
      origin: origin ? { points: origin.points.slice(0, 30), source: origin.source } : null,
      assumedState: describeState(a.assume),
      cells,
      ...(m.problems.length ? { problems: m.problems } : {}),
      note: "free = the cell has a tile exit, no event on it, and (when an origin is known) the player can reach it. Good spot for a new NPC/object.",
    };
  }

  findPath(a: CommonMapArgs & { from: PointOrEvent; to: PointOrEvent; adjacent?: boolean; ignoreEventIds?: number[] }): Record<string, unknown> {
    const m = this.load(a.mapId, a.assume);
    const from = this.resolvePoint(m, a.from, "from");
    const to = this.resolvePoint(m, a.to, "to");
    const mo = this.moveOptions(m, a, from.eventId);
    const adjacent = a.adjacent ?? to.eventId !== undefined;
    let path: Dir[] | null = null;
    let goal: Point = to;
    let face: Dir | null = null;
    if (adjacent) {
      const dist = m.grid.distances([from], mo);
      let best: { p: Point; d: Dir; dist: number } | null = null;
      for (const d of [2, 4, 6, 8] as Dir[]) {
        const n = m.grid.step(to.x, to.y, d);
        if (!n) continue;
        const v = dist[m.grid.index(n.x, n.y)]!;
        if (v >= 0 && (!best || v < best.dist)) best = { p: n, d: reverseDir(d), dist: v };
      }
      if (best) {
        goal = best.p;
        face = best.d;
        path = m.grid.findPath(from, goal, mo);
      }
    } else {
      path = m.grid.findPath(from, to, mo);
    }
    const mover = from.eventId !== undefined ? `event ${from.eventId}` : "player";
    if (!path) {
      return {
        mapId: m.mapId,
        found: false,
        from,
        to,
        mover,
        message: adjacent ? `No reachable cell next to (${to.x},${to.y}) from (${from.x},${from.y}).` : `(${to.x},${to.y}) is not reachable from (${from.x},${from.y}).`,
        hint: "Check get_map_passability with the same `from`; pass ignoreEvents or ignoreEventIds if blocking NPCs will have moved, or `assume` for another game state.",
      };
    }
    const commands: string[] = path.map((d) => `move_${DIR_NAME[d]}`);
    if (face) commands.push(`turn_${DIR_NAME[face]}`);
    const runs: string[] = [];
    for (let i = 0; i < path.length; ) {
      let j = i;
      while (j < path.length && path[j] === path[i]) j++;
      runs.push(`${DIR_NAME[path[i]!]} x${j - i}`);
      i = j;
    }
    // Mini grid around the path.
    const cells: Point[] = [from];
    let cur: Point = from;
    for (const d of path) {
      cur = m.grid.step(cur.x, cur.y, d)!;
      cells.push(cur);
    }
    const xs = [...cells.map((c) => c.x), to.x], ys = [...cells.map((c) => c.y), to.y];
    const region = this.region(m, { x: Math.max(0, Math.min(...xs) - 2), y: Math.max(0, Math.min(...ys) - 2), width: Math.max(...xs) - Math.min(...xs) + 5, height: Math.max(...ys) - Math.min(...ys) + 5 });
    const markers = [...cells.slice(1).map((c) => ({ ...c, glyph: "*" })), { ...from, glyph: "@" }];
    if (adjacent) markers.push({ ...to, glyph: "X" });
    const grid = region.width * region.height <= MAX_GRID_CELLS ? asciiGrid(m.grid, { region, moveOptions: mo, markers }) : undefined;
    return {
      mapId: m.mapId,
      found: true,
      mover,
      from,
      to,
      ...(adjacent ? { stopsAt: goal, facing: face ? DIR_NAME[face] : null } : {}),
      steps: path.length,
      summary: runs.join(", ") || "(already there)",
      commands,
      routeBlock: { type: "set_movement_route", character: from.eventId ?? -1, wait: true, skippable: false, repeat: false, commands },
      ...(grid ? { grid, gridLegend: "@ start, * path, X target; other glyphs as in get_map_passability" } : {}),
      note: "Assumes the cells stay free while walking (other moving NPCs and the player can still block the route). Set skippable: true if blocking is possible.",
    };
  }

  render(a: CommonMapArgs & { region?: Partial<Region>; scale?: number; grid?: boolean; events?: "sprites" | "markers" | "none"; overlay?: "none" | "passability" | "regions" | "reachable"; reachableFrom?: PointOrEvent }): { png: Buffer; summary: string[]; data: Record<string, unknown> } {
    const m = this.load(a.mapId, a.assume);
    const region = this.region(m, a.region);
    const ts = tileSizeOf(this.view());
    const scale = a.scale ?? Math.min(1, 1024 / (Math.max(region.width, region.height) * ts));
    const cellSize = Math.max(4, Math.round(ts * scale));
    if (region.width * cellSize * region.height * cellSize > MAX_IMAGE_PIXELS) {
      throw new McpError("INVALID_INPUT", `The image would be ${region.width * cellSize}x${region.height * cellSize} px. Lower \`scale\` or pass a smaller \`region\` (max ${MAX_IMAGE_PIXELS} pixels).`);
    }
    const entries = entryPoints(this.view(), m.mapId);
    const start = playerStart(this.view(), m.mapId);
    const overlay = a.overlay ?? "none";
    let reach: Int32Array | undefined;
    let origins: Point[] = [];
    if (overlay === "reachable") {
      const o = this.origin(m, a.reachableFrom, entries);
      if (!o) throw new McpError("INVALID_INPUT", "overlay \"reachable\" needs reachableFrom: this map has no player start and no Transfer Player arrives on it.");
      origins = o.explicit ? o.points : [];
      reach = m.grid.distances(o.points, this.moveOptions(m, a, o.eventId));
    }
    const r = renderMap(m.grid, m.tileset, (folder, name) => this.image(folder, name), {
      region,
      cellSize,
      tileSize: ts,
      grid: a.grid ?? true,
      events: a.events ?? "sprites",
      overlay,
      ...(reach ? { reach } : {}),
      reachOrigins: origins,
      start,
      entries: entries.filter((e) => !start || e.x !== start.x || e.y !== start.y),
    });
    const png = encodePng(r.canvas);
    const problems = [...m.problems, ...r.missingImages.map((f) => `Missing or unreadable image ${f}${this.imageErrorFor(f)} (drawn as magenta).`)];
    const legend = [RENDER_LEGEND.eventBox, RENDER_LEGEND.start, RENDER_LEGEND.entry];
    if (overlay !== "none") legend.push(RENDER_LEGEND[overlay]);
    const events = m.grid.events
      .filter((e) => e.x >= region.x && e.x < region.x + region.width && e.y >= region.y && e.y < region.y + region.height)
      .map((e) => `#${e.id} ${e.name} (${e.x},${e.y}) ${e.pageIndex === null ? "no active page" : `page ${e.pageIndex + 1}, ${TRIGGERS[e.trigger ?? 0] ?? e.trigger}, ${PRIORITIES[e.priority] ?? e.priority}${e.through ? ", through" : ""}`}`);
    const summary = [
      `Map ${m.mapId} [${m.name}] ${m.map.width}x${m.map.height}, tileset ${m.tileset ? `${m.tileset.id} [${m.tileset.name}]` : "unavailable"}.`,
      `Region x=${region.x}..${region.x + region.width - 1}, y=${region.y}..${region.y + region.height - 1}; ${cellSize}px per tile (scale ${(cellSize / ts).toFixed(3)}); image ${r.canvas.width}x${r.canvas.height}.`,
      ...(a.grid ?? true ? [`Axis labels: columns (x) along the top, rows (y) on the left; darker grid lines every 5 cells.`] : []),
      `Legend: ${legend.join("; ")}.`,
      ...(start ? [`Player start: (${start.x},${start.y}).`] : []),
      ...(entries.length ? [`Transfer arrivals: ${entries.slice(0, 10).map((e) => `(${e.x},${e.y}) from ${e.source}`).join("; ")}${entries.length > 10 ? ` … +${entries.length - 10}` : ""}.`] : []),
      `Events (${events.length}): ${events.slice(0, 60).join("; ") || "none"}${events.length > 60 ? ` … +${events.length - 60}` : ""}.`,
      ...(problems.length ? [`Problems: ${problems.join(" ")}`] : []),
      "Events are drawn in their initial state (all switches OFF) unless `assume` is given. For exact walkability use get_map_passability.",
    ];
    return {
      png,
      summary,
      data: { mapId: m.mapId, name: m.name, region, cellSize, imageWidth: r.canvas.width, imageHeight: r.canvas.height, originPixel: { x: r.originX, y: r.originY }, problems, bytes: png.length },
    };
  }

  private imageErrorFor(rel: string): string {
    const m = /^img\/(tilesets|characters)\/(.+)\.png$/.exec(rel);
    const err = m ? this.imageError(m[1]!, m[2]!) : undefined;
    return err ? ` [${err}]` : "";
  }
}

function describeState(s?: AssumedState): string {
  if (!s || (!s.switchesOn?.length && !s.selfSwitchesOn?.length && !Object.keys(s.variables ?? {}).length)) return "initial: all switches and self switches OFF, variables 0, no items";
  const parts: string[] = [];
  if (s.switchesOn?.length) parts.push(`switches ON: ${s.switchesOn.join(", ")}`);
  if (s.selfSwitchesOn?.length) parts.push(`self switches ON: ${s.selfSwitchesOn.join(", ")}`);
  if (s.variables && Object.keys(s.variables).length) parts.push(`variables: ${Object.entries(s.variables).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  return `${parts.join("; ")}; everything else OFF/0`;
}

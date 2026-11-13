import type { NativeMapEvent } from "../adapters/rpg-maker-mz/native-types.js";
import { walkBlocks } from "../eventing/ir/describe.js";
import { parseCommandList } from "../eventing/ir/parser.js";
import type { RouteCommandIR } from "../eventing/ir/blocks.js";
import type { EventBlock } from "../eventing/ir/types.js";
import { DIR_NAME, type Dir, type GridEvent, type MoveOptions, type Point } from "../maps/map-grid.js";
import { entryPoints, loadMap, readSystem, vehicleCells, type LoadedMap } from "../maps/map-model.js";
import type { DataView } from "../references/reference-resolver.js";
import { DiagnosticBag, type Diagnostic } from "./diagnostics.js";

/**
 * Map-aware checks (layout, passability, reachability). They run on the
 * staged project state and are skipped when Tilesets.json is unavailable.
 * Events are evaluated in the initial game state (all switches OFF), so
 * most of these checks are heuristic.
 */
export class MapCache {
  private readonly maps = new Map<number, LoadedMap | null>();
  private readonly entries = new Map<number, Point[]>();

  constructor(readonly view: DataView) {}

  get(mapId: number): LoadedMap | null {
    if (!this.maps.has(mapId)) {
      let m: LoadedMap | null = null;
      try {
        m = loadMap(this.view, mapId);
      } catch {
        m = null;
      }
      this.maps.set(mapId, m && m.tileset ? m : null);
    }
    return this.maps.get(mapId) ?? null;
  }

  entryPoints(mapId: number): Point[] {
    if (!this.entries.has(mapId)) this.entries.set(mapId, entryPoints(this.view, mapId));
    return this.entries.get(mapId)!;
  }
}

const mapLabel = (m: LoadedMap) => `Map ${m.mapId}${m.name ? ` [${m.name}]` : ""}`;

/** Transfer Player destinations that leave the player stuck or on top of an event. */
export function checkTransfers(blocks: readonly EventBlock[], location: string, maps: MapCache): Diagnostic[] {
  const bag = new DiagnosticBag();
  for (const v of walkBlocks(blocks)) {
    const b = v.block;
    if (b.type !== "transfer_player") continue;
    const l = b.location as { type: string; mapId?: number; x?: number; y?: number };
    if (l.type !== "direct" || typeof l.mapId !== "number" || typeof l.x !== "number" || typeof l.y !== "number") continue;
    const m = maps.get(l.mapId);
    if (!m || !m.grid.valid(l.x, l.y)) continue; // missing maps / out of bounds are reported by the reference checks
    const loc = `${location} / block ${v.id}`;
    if (m.grid.tileExits(l.x, l.y).length === 0) {
      bag.warning(
        "transfer.destination.blocked",
        `Transfer Player lands on (${l.x},${l.y}) of ${mapLabel(m)}, a cell the player cannot leave (impassable or enclosed tile). Check it with get_tile_info or render_map.`,
        loc,
        { mapId: l.mapId, x: l.x, y: l.y },
      );
      continue;
    }
    const blocking = m.grid.blockingEventsAt(l.x, l.y);
    if (blocking.length) {
      bag.heuristic(
        "info",
        "transfer.destination.occupied",
        `Transfer Player lands on event ${blocking.map((e) => `${e.id} [${e.name}]`).join(", ")} at (${l.x},${l.y}) of ${mapLabel(m)} (initial state); the player will overlap it.`,
        loc,
      );
    }
  }
  return bag.items;
}

type MoveStep = { dir: Dir } | { diag: [4 | 6, 2 | 8] } | { jump: Point } | "none" | "unknown";

function routeStep(c: RouteCommandIR): MoveStep {
  switch (c.command) {
    case "move_down":
      return { dir: 2 };
    case "move_left":
      return { dir: 4 };
    case "move_right":
      return { dir: 6 };
    case "move_up":
      return { dir: 8 };
    case "move_lower_left":
      return { diag: [4, 2] };
    case "move_lower_right":
      return { diag: [6, 2] };
    case "move_upper_left":
      return { diag: [4, 8] };
    case "move_upper_right":
      return { diag: [6, 8] };
    case "jump":
      return { jump: { x: Number(c.x) || 0, y: Number(c.y) || 0 } };
    case "move_random":
    case "move_toward_player":
    case "move_away_from_player":
    case "move_forward":
    case "move_backward":
    case "through_on":
    case "script":
    case "raw":
      return "unknown";
    default:
      return "none";
  }
}

interface SimState {
  /** Known current positions; key -1 = player, otherwise event id. Missing = unknown. */
  pos: Map<number, Point>;
  /** Characters whose position can no longer be tracked. */
  unknown: Set<number>;
}

/**
 * Simulate fixed movement routes of a map event page in list order and warn
 * when a step is blocked while the route waits for completion and cannot
 * skip (the event processing would hang). Only top-level routes are
 * simulated; routes inside branches mark the character's position unknown.
 */
export function checkMovementRoutes(blocks: readonly EventBlock[], location: string, map: LoadedMap, thisEventId: number, view: DataView): Diagnostic[] {
  const bag = new DiagnosticBag();
  const g = map.grid;
  const initial = new Map(g.events.map((e) => [e.id, e]));
  const st: SimState = { pos: new Map(), unknown: new Set() };
  const posOf = (who: number): Point | null => {
    if (st.unknown.has(who)) return null;
    const p = st.pos.get(who);
    if (p) return p;
    if (who === -1) return null; // the player's position is unknown until a transfer onto this map
    const e = initial.get(who);
    return e ? { x: e.x, y: e.y } : null;
  };
  const who = (character: unknown): number | null => {
    const c = Number(character);
    if (!Number.isInteger(c)) return null;
    return c === 0 ? thisEventId : c;
  };

  for (const v of walkBlocks(blocks)) {
    const b = v.block;
    if (v.depth > 0) {
      if (b.type === "set_movement_route" || b.type === "set_event_location") {
        const w = who(b.character);
        if (w !== null) st.unknown.add(w);
      }
      if (b.type === "transfer_player") st.unknown.add(-1);
      continue;
    }
    if (b.type === "transfer_player") {
      const l = b.location as { type: string; mapId?: number; x?: number; y?: number };
      if (l.type === "direct" && l.mapId === map.mapId && typeof l.x === "number" && typeof l.y === "number") {
        st.pos.set(-1, { x: l.x, y: l.y });
        st.unknown.delete(-1);
      } else st.unknown.add(-1);
      continue;
    }
    if (b.type === "set_event_location") {
      const w = who(b.character);
      const l = b.location as { type: string; x?: number; y?: number };
      if (w === null) continue;
      if (l.type === "direct" && typeof l.x === "number" && typeof l.y === "number") {
        st.pos.set(w, { x: l.x, y: l.y });
        st.unknown.delete(w);
      } else st.unknown.add(w);
      continue;
    }
    if (b.type !== "set_movement_route") continue;
    const w = who(b.character);
    if (w === null) continue;
    const start = posOf(w);
    const mover = w === -1 ? null : initial.get(w);
    if (!start || (w !== -1 && (!mover || mover.pageIndex === null || mover.through))) {
      st.unknown.add(w);
      continue;
    }
    const opts = moveOptionsFor(vehicleCells(view, map.mapId), w, st, initial);
    let cur: Point = start;
    let lost = false;
    const cmds = b.commands as RouteCommandIR[];
    for (let i = 0; i < cmds.length; i++) {
      const step = routeStep(cmds[i]!);
      if (step === "none") continue;
      if (step === "unknown") {
        lost = true;
        break;
      }
      let next: Point | null;
      if ("jump" in step) next = { x: cur.x + step.jump.x, y: cur.y + step.jump.y };
      else if ("dir" in step) next = g.canMove(cur.x, cur.y, step.dir, opts);
      else next = g.canMoveDiagonal(cur.x, cur.y, step.diag[0], step.diag[1], opts);
      if (!next) {
        if (b.wait === true && b.skippable !== true && b.repeat !== true) {
          const name = w === -1 ? "the player" : `event ${w}${mover ? ` [${mover.name}]` : ""}`;
          const dir = "dir" in step ? DIR_NAME[step.dir] : "diagonally";
          bag.heuristic(
            "warning",
            "route.blocked",
            `Set Movement Route: step ${i + 1} (${cmds[i]!.command}) of ${name} from (${cur.x},${cur.y}) is blocked moving ${dir} (initial game state). With wait=true and skippable=false the event processing hangs here. Use find_path to build the route, or set skippable=true.`,
            `${location} / block ${v.id}`,
            { from: cur, step: i + 1 },
          );
        }
        lost = true;
        break;
      }
      cur = next;
    }
    if (lost) st.unknown.add(w);
    else st.pos.set(w, cur);
  }
  return bag.items;
}

function moveOptionsFor(vehicles: Point[], w: number, st: SimState, initial: Map<number, GridEvent>): MoveOptions {
  // Events that moved no longer block their original cell; their new cells block instead.
  const moved = [...st.pos.keys(), ...st.unknown].filter((id) => id !== -1 && id !== w);
  const blocked: Point[] = [...vehicles];
  for (const id of moved) {
    const e = initial.get(id);
    const p = st.pos.get(id);
    if (!e || !p || e.through || e.pageIndex === null) continue;
    if (w === -1 && e.priority !== 1) continue;
    blocked.push(p);
  }
  const player = st.unknown.has(-1) ? null : st.pos.get(-1);
  const mover = initial.get(w);
  if (w !== -1 && player && mover?.priority === 1) blocked.push(player);
  return { ...(w !== -1 ? { moverEventId: w } : {}), ignoreEventIds: moved, blocked };
}

/** Action-button/touch events the player can never reach from any known arrival point (start or transfers). */
export function checkEventReachability(ev: NativeMapEvent, mapId: number, maps: MapCache, location: string): Diagnostic[] {
  const m = maps.get(mapId);
  if (!m) return [];
  const entries = maps.entryPoints(mapId).filter((p) => m.grid.valid(p.x, p.y));
  if (!entries.length) return [];
  const reach = reachCache.get(m) ?? m.grid.distances(entries, { ignoreEvents: true });
  reachCache.set(m, reach);
  const bag = new DiagnosticBag();
  ev.pages.forEach((p, i) => {
    if (!p || (p.trigger !== 0 && p.trigger !== 1)) return;
    if (!Array.isArray(p.list) || !p.list.some((c) => c && c.code !== 0)) return;
    const ge: GridEvent = { ...(m.grid.events.find((e) => e.id === ev.id) ?? ({} as GridEvent)), id: ev.id, x: ev.x, y: ev.y, priority: p.priorityType, trigger: p.trigger, pageIndex: i };
    const cells = m.grid.interactionCells(ge, p.trigger);
    if (cells.some((c) => reach[m.grid.index(c.x, c.y)]! >= 0)) return;
    bag.heuristic(
      "info",
      "event.unreachable",
      `Page ${i + 1} (${p.trigger === 0 ? "action button" : "player touch"}) at (${ev.x},${ev.y}) cannot be triggered: no cell the player can stand on to trigger it is reachable from the player start or any Transfer Player arrival on this map (tiles only, events ignored).`,
      `${location} / Page ${i + 1}`,
    );
  });
  return bag.items;
}

const reachCache = new WeakMap<LoadedMap, Int32Array>();

/** System start position: on the map, on a tile the player can leave. */
export function checkStartPosition(view: DataView, maps: MapCache): Diagnostic[] {
  const bag = new DiagnosticBag();
  const s = readSystem(view);
  if (typeof s.startMapId !== "number" || s.startMapId <= 0) return bag.items;
  const x = s.startX ?? 0;
  const y = s.startY ?? 0;
  const loc = "System / player start";
  const m = maps.get(s.startMapId);
  if (!m) return bag.items;
  if (!m.grid.valid(x, y)) {
    bag.warning("system.start.out_of_bounds", `Player start (${x},${y}) is outside ${mapLabel(m)} (${m.map.width}x${m.map.height}). The map was probably resized or swapped; set a new start position in the editor.`, loc);
  } else if (m.grid.tileExits(x, y).length === 0) {
    const autorun = m.grid.events.find((e) => e.pageIndex !== null && e.trigger === 3);
    const msg = `Player start (${x},${y}) on ${mapLabel(m)} is a cell the player cannot leave (impassable or enclosed tile).`;
    // A blank start map whose autorun event transfers the player away is a common, valid setup.
    if (autorun) bag.info("system.start.blocked", `${msg} The map has an autorun event (${autorun.id} [${autorun.name}]), so this is fine if it moves the player away.`, loc);
    else bag.warning("system.start.blocked", msg, loc);
  }
  return bag.items;
}

/** All map-aware checks for one map event: transfers and movement routes per page, then reachability. */
export function mapAwareEventChecks(ev: NativeMapEvent, mapId: number, maps: MapCache, location: string, parsedPages?: readonly (readonly EventBlock[])[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const m = maps.get(mapId);
  ev.pages.forEach((p, i) => {
    const blocks = parsedPages?.[i] ?? parseCommandList(p?.list ?? [], location).logic.blocks;
    const label = `${location} / Page ${i + 1}`;
    out.push(...checkTransfers(blocks, label, maps));
    if (m) out.push(...checkMovementRoutes(blocks, label, m, ev.id, maps.view));
  });
  out.push(...checkEventReachability(ev, mapId, maps, location));
  return out;
}

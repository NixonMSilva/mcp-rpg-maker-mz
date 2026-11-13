import type { NativeCommand, NativeEventPage, NativeMap, NativeMapEvent, NativeMapInfo, NativeCommonEvent } from "../adapters/rpg-maker-mz/native-types.js";
import { ProjectService } from "../project/project-service.js";
import type { DataView } from "../references/reference-resolver.js";
import { MapGrid, type GridEvent, type Point } from "./map-grid.js";

/**
 * Builds MapGrid instances from (possibly staged) project data and collects
 * map-level facts: active event pages in an assumed game state, the player
 * start, vehicle starts and transfer destinations into a map.
 */

export interface AssumedState {
  /** Switch ids assumed ON (all others OFF). */
  switchesOn?: number[];
  /** Self switches assumed ON, as "eventId:A" (for events of the map being analyzed). */
  selfSwitchesOn?: string[];
  /** Variable values (all others 0). */
  variables?: Record<string, number>;
}

export interface TilesetInfo {
  id: number;
  name: string;
  mode: number;
  tilesetNames: string[];
  flags: number[];
}

export interface LoadedMap {
  mapId: number;
  name: string;
  map: NativeMap;
  /** null when Tilesets.json or the map's tileset is missing (passability unknown). */
  tileset: TilesetInfo | null;
  grid: MapGrid;
  problems: string[];
}

interface SystemLike {
  startMapId?: number;
  startX?: number;
  startY?: number;
  partyMembers?: number[];
  boat?: { startMapId?: number; startX?: number; startY?: number };
  ship?: { startMapId?: number; startX?: number; startY?: number };
  airship?: { startMapId?: number; startX?: number; startY?: number };
  tileSize?: number;
}

export function pageMeetsState(page: NativeEventPage, eventId: number, state: AssumedState, partyMembers: readonly number[]): boolean {
  const c = page.conditions;
  if (!c) return true;
  const on = new Set(state.switchesOn ?? []);
  if (c.switch1Valid && !on.has(c.switch1Id)) return false;
  if (c.switch2Valid && !on.has(c.switch2Id)) return false;
  if (c.variableValid && (state.variables?.[String(c.variableId)] ?? 0) < c.variableValue) return false;
  if (c.selfSwitchValid && !(state.selfSwitchesOn ?? []).includes(`${eventId}:${c.selfSwitchCh}`)) return false;
  if (c.itemValid) return false; // inventory is assumed empty
  if (c.actorValid && !partyMembers.includes(c.actorId)) return false;
  return true;
}

/** Engine page selection: the LAST page whose conditions are met. */
export function activePageIndex(ev: NativeMapEvent, state: AssumedState, partyMembers: readonly number[] = []): number | null {
  if (!Array.isArray(ev.pages)) return null;
  for (let i = ev.pages.length - 1; i >= 0; i--) {
    const p = ev.pages[i];
    if (p && pageMeetsState(p, ev.id, state, partyMembers)) return i;
  }
  return null;
}

export function toGridEvent(ev: NativeMapEvent, pageIndex: number | null): GridEvent {
  const p = pageIndex === null ? undefined : ev.pages[pageIndex];
  const list = (p?.list ?? []) as NativeCommand[];
  return {
    id: ev.id,
    name: ev.name,
    x: ev.x,
    y: ev.y,
    pageIndex,
    priority: p?.priorityType ?? 1,
    through: p ? p.through === true : true,
    tileId: p?.image?.tileId ?? 0,
    characterName: p?.image?.characterName ?? "",
    characterIndex: p?.image?.characterIndex ?? 0,
    direction: p?.image?.direction ?? 2,
    pattern: p?.image?.pattern ?? 1,
    trigger: p ? p.trigger : null,
    hasCommands: list.some((c) => c && c.code !== 0),
  };
}

export function readTileset(view: DataView, tilesetId: number): TilesetInfo | null {
  const all = view.json("data/Tilesets.json");
  if (!Array.isArray(all)) return null;
  const t = all[tilesetId] as Record<string, unknown> | null | undefined;
  if (!t || !Array.isArray(t.flags)) return null;
  return {
    id: tilesetId,
    name: String(t.name ?? ""),
    mode: typeof t.mode === "number" ? t.mode : 1,
    tilesetNames: Array.isArray(t.tilesetNames) ? (t.tilesetNames as unknown[]).map((n) => (typeof n === "string" ? n : "")) : [],
    flags: t.flags as number[],
  };
}

export function readSystem(view: DataView): SystemLike {
  const s = view.json("data/System.json");
  return s && typeof s === "object" ? (s as SystemLike) : {};
}

export function mapName(view: DataView, mapId: number): string {
  const infos = view.json("data/MapInfos.json") as (NativeMapInfo | null)[] | undefined;
  return (Array.isArray(infos) ? infos[mapId]?.name : undefined) ?? "";
}

/** Load a map and build its passability grid. Returns null when the map file does not exist. */
export function loadMap(view: DataView, mapId: number, state: AssumedState = {}): LoadedMap | null {
  const map = view.json(`data/${ProjectService.mapFileName(mapId)}`) as NativeMap | undefined;
  if (!map || typeof map !== "object" || !Array.isArray(map.data) || !Array.isArray(map.events)) return null;
  const problems: string[] = [];
  const tileset = readTileset(view, map.tilesetId);
  if (!tileset) problems.push(`Tileset ${map.tilesetId} is not available (data/Tilesets.json missing or no such tileset): passability is unknown, every tile counts as blocked.`);
  const expected = map.width * map.height * 6;
  if (map.data.length < expected) problems.push(`Map data has ${map.data.length} entries; expected ${expected} (width x height x 6 layers).`);
  const party = readSystem(view).partyMembers ?? [];
  const events = map.events.filter((e): e is NativeMapEvent => !!e && typeof e === "object").map((e) => toGridEvent(e, activePageIndex(e, state, party)));
  const grid = new MapGrid({ width: map.width, height: map.height, data: map.data, flags: tileset?.flags ?? [], scrollType: typeof map.scrollType === "number" ? map.scrollType : 0, events });
  return { mapId, name: mapName(view, mapId), map, tileset, grid, problems };
}

/** Player start if it is on this map. */
export function playerStart(view: DataView, mapId: number): Point | null {
  const s = readSystem(view);
  return s.startMapId === mapId && typeof s.startX === "number" && typeof s.startY === "number" ? { x: s.startX, y: s.startY } : null;
}

/** Boat/ship start cells on this map (they block the player like characters). Airships do not block. */
export function vehicleCells(view: DataView, mapId: number): (Point & { vehicle: string })[] {
  const s = readSystem(view);
  const out: (Point & { vehicle: string })[] = [];
  for (const v of ["boat", "ship"] as const) {
    const st = s[v];
    if (st && st.startMapId === mapId && typeof st.startX === "number" && typeof st.startY === "number") out.push({ x: st.startX, y: st.startY, vehicle: v });
  }
  return out;
}

export interface EntryPoint extends Point {
  source: string;
}

const TRANSFER_PLAYER = 201;

function scanTransfers(list: unknown, mapId: number, source: string, out: EntryPoint[]): void {
  if (!Array.isArray(list)) return;
  for (const c of list as NativeCommand[]) {
    if (!c || c.code !== TRANSFER_PLAYER || !Array.isArray(c.parameters)) continue;
    const [mode, m, x, y] = c.parameters as number[];
    if (mode === 0 && m === mapId && typeof x === "number" && typeof y === "number") out.push({ x, y, source });
  }
}

/**
 * Where the player can arrive on a map: the System start position and every
 * direct Transfer Player into it (map events, common events, troops).
 * Transfers through variables are not resolvable statically.
 */
export function entryPoints(view: DataView, mapId: number): EntryPoint[] {
  const out: EntryPoint[] = [];
  const start = playerStart(view, mapId);
  if (start) out.push({ ...start, source: "System player start" });
  const infos = view.json("data/MapInfos.json") as (NativeMapInfo | null)[] | undefined;
  for (const info of Array.isArray(infos) ? infos : []) {
    if (!info) continue;
    const m = view.json(`data/${ProjectService.mapFileName(info.id)}`) as NativeMap | undefined;
    if (!m || !Array.isArray(m.events)) continue;
    for (const ev of m.events) {
      if (!ev || !Array.isArray(ev.pages)) continue;
      ev.pages.forEach((p, i) => scanTransfers(p?.list, mapId, `Map ${info.id} / Event ${ev.id} [${ev.name}] / Page ${i + 1}`, out));
    }
  }
  const ces = view.json("data/CommonEvents.json") as (NativeCommonEvent | null)[] | undefined;
  for (const ce of Array.isArray(ces) ? ces : []) if (ce) scanTransfers(ce.list, mapId, `Common Event ${ce.id} [${ce.name}]`, out);
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.x},${e.y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function tileSizeOf(view: DataView): number {
  const t = readSystem(view).tileSize;
  return typeof t === "number" && t > 0 ? t : 48;
}

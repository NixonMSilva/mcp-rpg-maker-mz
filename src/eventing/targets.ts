import type {
  NativeCommand,
  NativeCommonEvent,
  NativeEventPage,
  NativeMap,
  NativeMapEvent,
  NativeTroop,
} from "../adapters/rpg-maker-mz/native-types.js";
import { invalidInput, McpError, notFound } from "../project/errors.js";
import { ProjectService } from "../project/project-service.js";

/**
 * A "list target" identifies one native event command list:
 *  - a map event page   { mapId, eventId, pageIndex }
 *  - a common event     { commonEventId }
 *  - a troop battle page { troopId, pageIndex }
 *
 * Page indexes are ZERO-based everywhere in this API; descriptions also show
 * the one-based page number used by the editor ("Page 1" = pageIndex 0).
 */
export type ListTarget =
  | { kind: "map_event_page"; mapId: number; eventId: number; pageIndex: number }
  | { kind: "common_event"; commonEventId: number }
  | { kind: "troop_page"; troopId: number; pageIndex: number };

export function parseListTarget(o: Record<string, unknown>): ListTarget {
  const n = (k: string) => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v)) throw invalidInput(`${k} must be an integer.`);
    return v;
  };
  if (o.commonEventId !== undefined) return { kind: "common_event", commonEventId: n("commonEventId") };
  if (o.troopId !== undefined) return { kind: "troop_page", troopId: n("troopId"), pageIndex: n("pageIndex") };
  if (o.mapId !== undefined) return { kind: "map_event_page", mapId: n("mapId"), eventId: n("eventId"), pageIndex: n("pageIndex") };
  throw invalidInput("Identify the command list with {mapId, eventId, pageIndex}, {commonEventId} or {troopId, pageIndex}.");
}

export function targetLabel(t: ListTarget): string {
  switch (t.kind) {
    case "map_event_page":
      return `Map ${t.mapId} / Event ${t.eventId} / Page ${t.pageIndex + 1} (pageIndex ${t.pageIndex})`;
    case "common_event":
      return `Common Event ${t.commonEventId}`;
    case "troop_page":
      return `Troop ${t.troopId} / Page ${t.pageIndex + 1} (pageIndex ${t.pageIndex})`;
  }
}

export function targetFile(t: ListTarget): string {
  switch (t.kind) {
    case "map_event_page":
      return `data/${ProjectService.mapFileName(t.mapId)}`;
    case "common_event":
      return "data/CommonEvents.json";
    case "troop_page":
      return "data/Troops.json";
  }
}

/** The object that owns the list (page / common event / troop page) inside parsed file data. */
export interface ListOwner {
  owner: { list: NativeCommand[]; [k: string]: unknown };
  /** For map pages: the event and page. */
  event?: NativeMapEvent;
  page?: NativeEventPage;
}

export function locateList(fileData: unknown, t: ListTarget): ListOwner {
  switch (t.kind) {
    case "map_event_page": {
      const map = fileData as NativeMap;
      const ev = findMapEvent(map, t.mapId, t.eventId);
      const page = ev.pages[t.pageIndex];
      if (!page) throw notFound(`Event ${t.eventId} on map ${t.mapId} has no pageIndex ${t.pageIndex} (it has ${ev.pages.length} page(s); indexes are zero-based).`);
      ensureList(page, targetLabel(t));
      return { owner: page as unknown as ListOwner["owner"], event: ev, page };
    }
    case "common_event": {
      const arr = fileData as (NativeCommonEvent | null)[];
      const ce = arr[t.commonEventId];
      if (!ce || t.commonEventId < 1) throw notFound(`Common event ${t.commonEventId} does not exist.`);
      ensureList(ce, targetLabel(t));
      return { owner: ce as unknown as ListOwner["owner"] };
    }
    case "troop_page": {
      const arr = fileData as (NativeTroop | null)[];
      const tr = arr[t.troopId];
      if (!tr || t.troopId < 1) throw notFound(`Troop ${t.troopId} does not exist.`);
      const page = tr.pages?.[t.pageIndex];
      if (!page) throw notFound(`Troop ${t.troopId} has no pageIndex ${t.pageIndex}.`);
      ensureList(page, targetLabel(t));
      return { owner: page as unknown as ListOwner["owner"] };
    }
  }
}

function ensureList(o: { list?: unknown }, label: string): void {
  if (!Array.isArray(o.list)) throw new McpError("MALFORMED_DATA", `${label} has no command list array.`);
}

export function findMapEvent(map: NativeMap, mapId: number, eventId: number): NativeMapEvent {
  if (!Array.isArray(map.events)) throw new McpError("MALFORMED_DATA", `Map ${mapId} has no events array.`);
  const ev = map.events[eventId];
  if (!ev || eventId < 1) throw notFound(`Event ${eventId} does not exist on map ${mapId}.`, { mapId, eventId });
  if (ev.id !== eventId) {
    throw new McpError("MALFORMED_DATA", `Map ${mapId} events[${eventId}] has id ${ev.id}; the events array is inconsistent.`);
  }
  if (!Array.isArray(ev.pages)) throw new McpError("MALFORMED_DATA", `Event ${eventId} on map ${mapId} has no pages array.`);
  return ev;
}

import type { NativeMap, NativeMapInfo } from "../adapters/rpg-maker-mz/native-types.js";
import { SYSTEM_LISTS, type SystemListKind } from "../database/database-catalog.js";
import type { ProjectService } from "../project/project-service.js";
import { REF_DATABASE_FILE, type NameResolver, type RefKind } from "./ref-types.js";

/**
 * Resolves display names for references using the project's own data
 * (System.json lists, database files, MapInfos, and optionally the events of
 * one map). Missing files simply yield no name.
 */
export class ProjectNames implements NameResolver {
  private readonly cache = new Map<string, (string | undefined)[]>();
  private mapEvents: Map<number, string> | null = null;

  constructor(
    private readonly project: ProjectService,
    private readonly mapId?: number,
  ) {}

  forMap(mapId: number): ProjectNames {
    return new ProjectNames(this.project, mapId);
  }

  name(kind: RefKind, id: number | string): string | undefined {
    if (typeof id !== "number") return undefined;
    const list = this.list(kind);
    if (list) {
      const n = list[id];
      return n ? n : undefined;
    }
    if (kind === "event" && this.mapId !== undefined) {
      return this.events().get(id);
    }
    return undefined;
  }

  private events(): Map<number, string> {
    if (!this.mapEvents) {
      this.mapEvents = new Map();
      try {
        const map = this.project.readMap(this.mapId!).data as NativeMap;
        for (const e of map.events) if (e) this.mapEvents.set(e.id, e.name);
      } catch {
        /* map unreadable: no names */
      }
    }
    return this.mapEvents;
  }

  private list(kind: RefKind): (string | undefined)[] | null {
    const cached = this.cache.get(kind);
    if (cached) return cached;
    let out: (string | undefined)[] | null = null;
    try {
      if (kind === "switch" || kind === "variable") {
        const arr = this.project.system().data[kind === "switch" ? "switches" : "variables"];
        out = Array.isArray(arr) ? arr.map((x) => (typeof x === "string" ? x : undefined)) : [];
      } else if (kind in SYSTEM_LISTS) {
        const arr = this.project.system().data[SYSTEM_LISTS[kind as SystemListKind]];
        out = Array.isArray(arr) ? arr.map((x) => (typeof x === "string" ? x : undefined)) : [];
      } else if (kind === "map") {
        const infos = this.project.mapInfos().data as (NativeMapInfo | null)[];
        out = infos.map((m) => m?.name);
      } else {
        const file = REF_DATABASE_FILE[kind];
        if (file && this.project.hasDataFile(file)) {
          const data = this.project.readData<({ name?: string } | null)[]>(file).data;
          out = Array.isArray(data) ? data.map((r) => (r && typeof r.name === "string" ? r.name : undefined)) : [];
        }
      }
    } catch {
      out = [];
    }
    if (out) this.cache.set(kind, out);
    return out;
  }
}

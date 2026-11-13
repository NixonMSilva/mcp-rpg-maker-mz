import { parsePluginHeader, type PluginHeader } from "../adapters/rpg-maker-mz/plugin-header.js";
import { parsePluginsJs, type PluginEntry } from "../adapters/rpg-maker-mz/plugins-js.js";
import type { NativeMap, NativeMapInfo } from "../adapters/rpg-maker-mz/native-types.js";
import { SYSTEM_LISTS, type SystemListKind } from "../database/database-catalog.js";
import { ProjectService } from "../project/project-service.js";
import type { DataView } from "../references/reference-resolver.js";
import { REF_DATABASE_FILE, type Ref } from "../references/ref-types.js";

/**
 * Checks whether references point at existing entities (EVENT_SPEC §10.2,
 * DATABASE_SPEC §10.2). Distinguishes:
 *   ok            target exists
 *   blank         target slot exists but is an unnamed/blank record (suspicious)
 *   invalid       target definitely does not exist / out of range
 *   unresolvable  required project data is missing or not understood
 */
export type RefStatus = "ok" | "blank" | "invalid" | "unresolvable";

export interface RefCheck {
  status: RefStatus;
  message?: string;
  name?: string;
}

export interface PluginSource {
  plugins(): PluginEntry[] | null;
}

export class ReferenceChecker {
  private plugins: PluginEntry[] | null | undefined;
  private readonly headers = new Map<string, PluginHeader | null>();

  constructor(
    private readonly view: DataView,
    private readonly pluginsJsText?: () => string | null,
    private readonly pluginSource?: (name: string) => string | null,
  ) {}

  static forProject(project: ProjectService, view: DataView): ReferenceChecker {
    return new ReferenceChecker(
      view,
      () => (project.files.exists("js/plugins.js") ? project.files.readText("js/plugins.js").text : null),
      (name) => {
        try {
          return project.pluginSource(name);
        } catch {
          return null;
        }
      },
    );
  }

  /** Inferred command schemas from a plugin's annotation header (null when unavailable). */
  pluginHeader(name: string): PluginHeader | null {
    if (!this.headers.has(name)) {
      const src = this.pluginSource?.(name) ?? null;
      this.headers.set(name, src ? parsePluginHeader(src) : null);
    }
    return this.headers.get(name) ?? null;
  }

  private system(): Record<string, unknown> | undefined {
    return this.view.json("data/System.json") as Record<string, unknown> | undefined;
  }

  check(ref: Ref, ctx: { mapId?: number } = {}): RefCheck {
    const { kind, id } = ref;
    if (kind === "label") return { status: "ok" };
    if (kind === "self_switch") {
      return ["A", "B", "C", "D"].includes(String(id)) ? { status: "ok" } : { status: "invalid", message: `Self switch ${String(id)} must be A, B, C or D.` };
    }
    if (kind === "plugin") return this.checkPlugin(String(id));
    if (typeof id !== "number" || !Number.isInteger(id)) return { status: "unresolvable", message: `Non-numeric ${kind} reference ${JSON.stringify(id)}.` };

    if (kind === "switch" || kind === "variable") {
      const sys = this.system();
      const arr = sys?.[kind === "switch" ? "switches" : "variables"];
      if (!Array.isArray(arr)) return { status: "unresolvable", message: "System.json switch/variable lists are unavailable." };
      if (id < 1 || id >= arr.length) return { status: "invalid", message: `${kind === "switch" ? "Switch" : "Variable"} ${id} is outside the project's range (1..${arr.length - 1}).` };
      return { status: "ok", name: typeof arr[id] === "string" ? (arr[id] as string) : "" };
    }
    if (kind in SYSTEM_LISTS) {
      const arr = this.system()?.[SYSTEM_LISTS[kind as SystemListKind]];
      if (!Array.isArray(arr)) return { status: "unresolvable", message: `System.json ${SYSTEM_LISTS[kind as SystemListKind]} is unavailable.` };
      if (id < 1 || id >= arr.length) return { status: "invalid", message: `${kind} ${id} is outside System.json ${SYSTEM_LISTS[kind as SystemListKind]} (1..${arr.length - 1}).` };
      return { status: "ok", name: String(arr[id] ?? "") };
    }
    if (kind === "map") return this.checkMap(id, ref.context);
    if (kind === "event") {
      const mapId = ref.mapId ?? ctx.mapId;
      if (mapId === undefined) return { status: "unresolvable", message: `Event ${id} reference has no map context (e.g. inside a common event; resolved at runtime).` };
      const map = this.view.json(`data/${ProjectService.mapFileName(mapId)}`) as NativeMap | undefined;
      if (!map || !Array.isArray(map.events)) return { status: "unresolvable", message: `Map ${mapId} data is unavailable.` };
      const ev = map.events[id];
      return ev ? { status: "ok", name: ev.name } : { status: "invalid", message: `Event ${id} does not exist on map ${mapId}.` };
    }
    const file = REF_DATABASE_FILE[kind];
    if (file) {
      const data = this.view.json(`data/${file}`);
      if (!Array.isArray(data)) return { status: "unresolvable", message: `data/${file} is missing or malformed.` };
      if (id < 1 || id >= data.length || !data[id]) return { status: "invalid", message: `${kind} ${id} does not exist (data/${file} has IDs 1..${data.length - 1}).` };
      const rec = data[id] as { name?: unknown };
      const name = typeof rec.name === "string" ? rec.name : "";
      if (name === "" && kind !== "common_event") return { status: "blank", message: `${kind} ${id} is an unnamed (blank) record.`, name };
      return { status: "ok", name };
    }
    return { status: "unresolvable", message: `References of kind ${kind} are not validated.` };
  }

  private checkMap(id: number, context?: Record<string, unknown>): RefCheck {
    const infos = this.view.json("data/MapInfos.json") as (NativeMapInfo | null)[] | undefined;
    if (!Array.isArray(infos)) return { status: "unresolvable", message: "MapInfos.json is unavailable." };
    const info = infos[id];
    if (!info) return { status: "invalid", message: `Map ${id} does not exist in MapInfos.json.` };
    const map = this.view.json(`data/${ProjectService.mapFileName(id)}`) as NativeMap | undefined;
    if (!map) return { status: "invalid", message: `Map ${id} is registered but ${ProjectService.mapFileName(id)} is missing.` };
    if (context && typeof context.x === "number" && typeof context.y === "number") {
      const { x, y } = context as { x: number; y: number };
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
        return { status: "invalid", message: `Coordinates (${x},${y}) are outside map ${id} [${info.name}] (${map.width}x${map.height}).` };
      }
    }
    return { status: "ok", name: info.name };
  }

  private checkPlugin(name: string): RefCheck {
    if (this.plugins === undefined) {
      try {
        const text = this.pluginsJsText?.() ?? null;
        this.plugins = text === null ? null : parsePluginsJs(text);
      } catch {
        this.plugins = null;
      }
    }
    if (this.plugins === null) return { status: "unresolvable", message: "js/plugins.js is missing or unreadable." };
    const p = this.plugins.find((x) => x.name === name);
    if (!p) return { status: "invalid", message: `Plugin "${name}" is not installed in js/plugins.js; the command will do nothing.` };
    if (!p.status) return { status: "blank", message: `Plugin "${name}" is installed but disabled.` };
    return { status: "ok", name };
  }
}

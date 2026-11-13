import type { NativeCommonEvent, NativeEventPage, NativeMap, NativeMapInfo, NativeTroop } from "../adapters/rpg-maker-mz/native-types.js";
import { CATEGORIES, recordRefs, type DatabaseCategory } from "../database/database-catalog.js";
import { walkBlocks, blockRefs } from "../eventing/ir/describe.js";
import { parseCommandList } from "../eventing/ir/parser.js";
import type { EventBlock, RawCommandBlock } from "../eventing/ir/types.js";
import { leafByType } from "../eventing/ir/blocks.js";
import { McpError } from "../project/errors.js";
import { ProjectService } from "../project/project-service.js";
import type { Ref, RefKind } from "./ref-types.js";

/**
 * Shared reference resolver (DATABASE_SPEC §9). Builds an index of every
 * known reference in the project: event pages, common events, troop pages
 * (via the Event IR) and database records (via the database catalog), plus
 * best-effort inferred references found in scripts, message text codes and
 * note tags. Used by eventing and database tools alike.
 */

export interface SourceLocation {
  file: string;
  /** Human-readable location. */
  label: string;
  category?: DatabaseCategory;
  recordId?: number;
  mapId?: number;
  eventId?: number;
  pageIndex?: number;
  commonEventId?: number;
  troopId?: number;
  blockId?: string;
}

export interface IndexedRef {
  ref: Ref;
  source: SourceLocation;
  confidence: "high" | "low";
}

/** Read-only access to (possibly staged) project data. */
export interface DataView {
  json(relPath: string): unknown | undefined;
}

export function projectView(project: ProjectService): DataView {
  return {
    json(rel: string) {
      try {
        return project.files.readJson(rel).data;
      } catch (err) {
        if (err instanceof McpError && err.code === "FILE_NOT_FOUND") return undefined;
        throw err;
      }
    },
  };
}

const SCRIPT_PATTERNS: { re: RegExp; kind: RefKind | ((m: RegExpExecArray) => RefKind | null) }[] = [
  { re: /\$gameSwitches\.(?:value|setValue)\(\s*(\d+)/g, kind: "switch" },
  { re: /\$gameVariables\.(?:value|setValue)\(\s*(\d+)/g, kind: "variable" },
  { re: /\$gameActors\.actor\(\s*(\d+)/g, kind: "actor" },
  {
    re: /\$data(Items|Weapons|Armors|Skills|States|Actors|Classes|Enemies|Troops|CommonEvents|Animations)\[\s*(\d+)\s*\]/g,
    kind: (m) =>
      (({
        Items: "item",
        Weapons: "weapon",
        Armors: "armor",
        Skills: "skill",
        States: "state",
        Actors: "actor",
        Classes: "class",
        Enemies: "enemy",
        Troops: "troop",
        CommonEvents: "common_event",
        Animations: "animation",
      }) as Record<string, RefKind>)[m[1]!] ?? null,
  },
  { re: /\$gameTemp\.reserveCommonEvent\(\s*(\d+)/g, kind: "common_event" },
];

/** Inferred refs in JavaScript text (low confidence; scripts are never executed). */
export function scriptRefs(text: string): Ref[] {
  const out: Ref[] = [];
  for (const p of SCRIPT_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const kind = typeof p.kind === "function" ? p.kind(m) : p.kind;
      const id = Number(typeof p.kind === "function" ? m[2] : m[1]);
      if (kind && Number.isInteger(id)) out.push({ kind, id, role: "use", origin: "inferred", via: "script text" });
    }
  }
  return out;
}

/** Native message text codes: \V[n] (variable), \N[n] (actor name). */
export function textCodeRefs(text: string): Ref[] {
  const out: Ref[] = [];
  const re = /\\([VN])\[(\d+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind: RefKind = m[1]!.toUpperCase() === "V" ? "variable" : "actor";
    out.push({ kind, id: Number(m[2]), role: "read", origin: "native", via: `text code \\${m[1]}[${m[2]}]` });
  }
  return out;
}

function textOf(b: EventBlock): string[] {
  if (b.type === "show_text" || b.type === "show_scrolling_text") return b.lines as string[];
  if (b.type === "show_choices") return (b.choices as { text: string }[]).map((c) => c.text);
  return [];
}

function blockScriptTexts(b: EventBlock): string[] {
  if (b.type === "raw_command") {
    return (b as RawCommandBlock).commands.filter((c) => c.code === 355 || c.code === 655).map((c) => String(c.parameters[0]));
  }
  if (b.type === "conditional") {
    const c = b.condition as { type: string; script?: string };
    return c.type === "script" && c.script ? [c.script] : [];
  }
  return leafByType(b.type)?.scripts?.(b) ?? [];
}

/** All references (native + inferred) of a command list. */
export function listRefs(list: unknown, location: string): { ref: Ref; blockId: string; confidence: "high" | "low" }[] {
  const parsed = parseCommandList(list, location);
  const out: { ref: Ref; blockId: string; confidence: "high" | "low" }[] = [];
  for (const v of walkBlocks(parsed.logic.blocks)) {
    for (const r of blockRefs(v.block)) {
      if (r.origin === "unknown") continue;
      out.push({ ref: { origin: "native", ...r }, blockId: v.id, confidence: r.origin === "inferred" ? "low" : "high" });
    }
    for (const t of textOf(v.block)) for (const r of textCodeRefs(t)) out.push({ ref: r, blockId: v.id, confidence: "high" });
    for (const s of blockScriptTexts(v.block)) for (const r of scriptRefs(s)) out.push({ ref: r, blockId: v.id, confidence: "low" });
  }
  return out;
}

export function pageConditionRefs(page: NativeEventPage): Ref[] {
  const c = page.conditions;
  const out: Ref[] = [];
  if (!c) return out;
  if (c.switch1Valid) out.push({ kind: "switch", id: c.switch1Id, role: "read", origin: "native", via: "page condition switch1" });
  if (c.switch2Valid) out.push({ kind: "switch", id: c.switch2Id, role: "read", origin: "native", via: "page condition switch2" });
  if (c.variableValid) out.push({ kind: "variable", id: c.variableId, role: "read", origin: "native", via: "page condition variable" });
  if (c.selfSwitchValid) out.push({ kind: "self_switch", id: c.selfSwitchCh, role: "read", origin: "native", via: "page condition self switch" });
  if (c.itemValid) out.push({ kind: "item", id: c.itemId, role: "read", origin: "native", via: "page condition item" });
  if (c.actorValid) out.push({ kind: "actor", id: c.actorId, role: "read", origin: "native", via: "page condition actor" });
  return out;
}

export class ReferenceIndex {
  readonly entries: IndexedRef[] = [];
  /** Sources that may contain references this server cannot resolve (plugin data, notes...). */
  readonly opaqueSources: string[] = [];

  static build(view: DataView): ReferenceIndex {
    const idx = new ReferenceIndex();
    idx.indexMaps(view);
    idx.indexCommonEvents(view);
    idx.indexTroops(view);
    idx.indexDatabase(view);
    return idx;
  }

  private add(ref: Ref, source: SourceLocation, confidence: "high" | "low" = "high"): void {
    this.entries.push({ ref, source, confidence });
  }

  private indexMaps(view: DataView): void {
    const infos = view.json("data/MapInfos.json") as (NativeMapInfo | null)[] | undefined;
    if (!Array.isArray(infos)) return;
    for (const info of infos) {
      if (!info) continue;
      const file = `data/${ProjectService.mapFileName(info.id)}`;
      const map = view.json(file) as NativeMap | undefined;
      if (!map || !Array.isArray(map.events)) continue;
      for (const ev of map.events) {
        if (!ev || !Array.isArray(ev.pages)) continue;
        ev.pages.forEach((page, pageIndex) => {
          const base: SourceLocation = {
            file,
            label: `Map ${info.id} [${info.name}] / Event ${ev.id} [${ev.name}] / Page ${pageIndex + 1}`,
            mapId: info.id,
            eventId: ev.id,
            pageIndex,
          };
          for (const r of pageConditionRefs(page)) this.add(this.scope(r, info.id, ev.id), base);
          for (const { ref, blockId, confidence } of listRefs(page.list, base.label)) {
            this.add(this.scope(ref, info.id, ev.id), { ...base, label: `${base.label} / block ${blockId}`, blockId }, confidence);
          }
        });
        if (typeof ev.note === "string" && /<[^>]+>/.test(ev.note)) this.opaqueSources.push(`Map ${info.id} / Event ${ev.id} note tags`);
      }
    }
  }

  /** Event and self-switch refs from map events are scoped to their map (and event). */
  private scope(r: Ref, mapId: number, eventId: number): Ref {
    if (r.kind === "event") return { ...r, mapId: r.mapId ?? mapId };
    if (r.kind === "self_switch") return { ...r, mapId, context: { eventId } };
    return r;
  }

  private indexCommonEvents(view: DataView): void {
    const ces = view.json("data/CommonEvents.json") as (NativeCommonEvent | null)[] | undefined;
    if (!Array.isArray(ces)) return;
    for (const ce of ces) {
      if (!ce) continue;
      const base: SourceLocation = { file: "data/CommonEvents.json", label: `Common Event ${ce.id} [${ce.name}]`, category: "common_event", recordId: ce.id, commonEventId: ce.id };
      for (const r of recordRefs("common_event", ce as unknown as Record<string, unknown>)) this.add(r, { ...base, label: `${base.label} / ${r.via}` });
      for (const { ref, blockId, confidence } of listRefs(ce.list, base.label)) {
        this.add(ref, { ...base, label: `${base.label} / block ${blockId}`, blockId }, confidence);
      }
    }
  }

  private indexTroops(view: DataView): void {
    const troops = view.json("data/Troops.json") as (NativeTroop | null)[] | undefined;
    if (!Array.isArray(troops)) return;
    for (const t of troops) {
      if (!t || !Array.isArray(t.pages)) continue;
      t.pages.forEach((p, pageIndex) => {
        const base: SourceLocation = { file: "data/Troops.json", label: `Troop ${t.id} [${t.name}] / Page ${pageIndex + 1}`, category: "troop", recordId: t.id, troopId: t.id, pageIndex };
        for (const { ref, blockId, confidence } of listRefs(p.list, base.label)) {
          this.add(ref, { ...base, label: `${base.label} / block ${blockId}`, blockId }, confidence);
        }
      });
    }
  }

  private indexDatabase(view: DataView): void {
    for (const def of CATEGORIES) {
      if (def.category === "common_event") continue; // indexed with its command list
      const file = `data/${def.file}`;
      const data = view.json(file);
      if (data === undefined) continue;
      const records: unknown[] = def.singleton ? [data] : Array.isArray(data) ? data : [];
      records.forEach((r, i) => {
        if (!r || typeof r !== "object") return;
        const rec = r as Record<string, unknown>;
        const id = def.singleton ? 0 : typeof rec.id === "number" ? rec.id : i;
        const label = def.singleton ? def.label : `${def.label} ${id} [${String(rec.name ?? "")}]`;
        for (const ref of recordRefs(def.category, rec)) {
          this.add(ref, { file, label: `${label} / ${ref.via}`, category: def.category, recordId: id });
        }
        if (typeof rec.note === "string" && /<[^>]+>/.test(rec.note)) this.opaqueSources.push(`${label} note tags`);
      });
    }
  }

  /** All indexed references to an entity. For "event" refs pass mapId; for self switches pass mapId + eventId. */
  find(kind: RefKind, id: number | string, opts: { mapId?: number; eventId?: number } = {}): IndexedRef[] {
    return this.entries.filter((e) => {
      if (e.ref.kind !== kind || e.ref.id !== id) return false;
      if (opts.mapId !== undefined && (kind === "event" || kind === "self_switch") && e.ref.mapId !== opts.mapId) return false;
      if (opts.eventId !== undefined && kind === "self_switch" && (e.ref.context as { eventId?: number } | undefined)?.eventId !== opts.eventId) return false;
      return true;
    });
  }
}

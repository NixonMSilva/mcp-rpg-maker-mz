import type { NativeCommonEvent, NativeMap, NativeMapEvent, NativeTroop } from "../adapters/rpg-maker-mz/native-types.js";
import { CATEGORIES, CATEGORY_REF_KIND } from "../database/database-catalog.js";
import { validateRecord } from "../database/database-service.js";
import { deepEqual } from "../project/json-diff.js";
import type { ProjectService } from "../project/project-service.js";
import type { Workspace, WorkspaceValidator } from "../project/transaction-manager.js";
import { ReferenceIndex, type DataView } from "../references/reference-resolver.js";
import { DiagnosticBag, type Diagnostic } from "./diagnostics.js";
import { validateCommandList, validatePageSettings } from "./event-validator.js";
import { analyzeBlocks, analyzeCommonEventCycles, analyzeEvent } from "./flow-analysis.js";
import { ReferenceChecker } from "./reference-validator.js";
import { parseCommandList } from "../eventing/ir/parser.js";

/**
 * Validators run by TransactionManager.stage() against the complete staged
 * project state (DATABASE_SPEC §13: "Batch operations must validate the
 * complete resulting project state before committing"). Only records/events
 * that differ from the base revision are re-validated, plus reverse
 * reference checks for anything deleted or blanked.
 */

export function stagedView(ws: Workspace): DataView {
  return { json: (rel: string) => ws.peek(rel) };
}

const MAP_FILE = /^data\/Map(\d{3,})\.json$/;

export function eventValidator(project: ProjectService): WorkspaceValidator {
  return (ws: Workspace, changed: string[]): Diagnostic[] => {
    const bag = new DiagnosticBag();
    const view = stagedView(ws);
    const checker = ReferenceChecker.forProject(project, view);
    let removedEvents: { mapId: number; eventId: number; name: string }[] = [];

    for (const rel of changed) {
      const m = MAP_FILE.exec(rel);
      if (m) {
        const mapId = Number(m[1]);
        const base = ws.baseSnapshot(rel)?.data as NativeMap | undefined;
        const staged = ws.peek(rel) as NativeMap;
        const n = Math.max(base?.events.length ?? 0, staged.events.length);
        for (let id = 1; id < n; id++) {
          const before = base?.events[id] ?? null;
          const after = staged.events[id] ?? null;
          if (deepEqual(before, after)) continue;
          if (after === null) {
            if (before) removedEvents.push({ mapId, eventId: id, name: before.name });
            continue;
          }
          bag.merge(validateEvent(after, mapId, staged, checker));
        }
        continue;
      }
      if (rel === "data/CommonEvents.json") {
        const base = ws.baseSnapshot(rel)?.data as (NativeCommonEvent | null)[] | undefined;
        const staged = ws.peek(rel) as (NativeCommonEvent | null)[];
        let anyListChanged = false;
        staged.forEach((ce, id) => {
          if (!ce || deepEqual(base?.[id]?.list, ce.list)) return;
          anyListChanged = true;
          const label = `Common Event ${id} [${ce.name}]`;
          const parsed = parseCommandList(ce.list, label);
          bag.merge(validateCommandList(ce.list, { location: label, owner: "common_event" }, checker, parsed));
          bag.merge(analyzeBlocks(parsed.logic.blocks, label, { trigger: ce.trigger === 1 ? 3 : undefined }));
        });
        if (anyListChanged) bag.merge(analyzeCommonEventCycles(staged));
        continue;
      }
      if (rel === "data/Troops.json") {
        const base = ws.baseSnapshot(rel)?.data as (NativeTroop | null)[] | undefined;
        const staged = ws.peek(rel) as (NativeTroop | null)[];
        staged.forEach((t, id) => {
          if (!t || deepEqual(base?.[id]?.pages, t.pages)) return;
          t.pages.forEach((p, i) => {
            const label = `Troop ${id} [${t.name}] / Page ${i + 1}`;
            bag.merge(validateCommandList(p.list, { location: label, owner: "troop_page" }, checker));
          });
        });
      }
    }

    if (removedEvents.length) {
      const idx = ReferenceIndex.build(view);
      for (const r of removedEvents) {
        const refs = idx.find("event", r.eventId, { mapId: r.mapId }).filter((h) => !(h.source.mapId === r.mapId && h.source.eventId === r.eventId));
        for (const h of refs) {
          bag.error("ref.event.deleted", `Event ${r.eventId} [${r.name}] on map ${r.mapId} is being deleted but is still referenced here.`, h.source.label);
        }
      }
      removedEvents = [];
    }
    return bag.items;
  };
}

export function validateEvent(ev: NativeMapEvent, mapId: number, map: NativeMap, checker: ReferenceChecker): Diagnostic[] {
  const bag = new DiagnosticBag();
  const loc = `Map ${mapId} / Event ${ev.id} [${ev.name}]`;
  if (!Array.isArray(ev.pages) || ev.pages.length === 0) {
    bag.error("event.pages.empty", "An event needs at least one page.", loc);
    return bag.items;
  }
  if (ev.x < 0 || ev.y < 0 || ev.x >= map.width || ev.y >= map.height) bag.error("event.position.out_of_bounds", `Position (${ev.x},${ev.y}) is outside the ${map.width}x${map.height} map.`, loc);
  ev.pages.forEach((p, i) => {
    const label = `${loc} / Page ${i + 1}`;
    bag.merge(validatePageSettings(p, label, checker, mapId));
    const parsed = parseCommandList(p.list, label);
    bag.merge(validateCommandList(p.list, { location: label, mapId, owner: "map_event_page" }, checker, parsed));
    bag.merge(analyzeBlocks(parsed.logic.blocks, label, { trigger: p.trigger }));
  });
  bag.merge(analyzeEvent(ev, loc));
  return bag.items;
}

export function databaseValidator(project: ProjectService): WorkspaceValidator {
  return (ws: Workspace, changed: string[]): Diagnostic[] => {
    const bag = new DiagnosticBag();
    const view = stagedView(ws);
    const checker = ReferenceChecker.forProject(project, view);
    let index: ReferenceIndex | null = null;
    for (const def of CATEGORIES) {
      const rel = `data/${def.file}`;
      if (!changed.includes(rel)) continue;
      const base = ws.baseSnapshot(rel)?.data;
      const staged = ws.peek(rel);
      if (def.singleton) {
        bag.merge(validateRecord(def, staged as Record<string, unknown>, def.label, checker));
        continue;
      }
      if (!Array.isArray(staged)) {
        bag.error("db.file.malformed", `${rel} is no longer an array.`);
        continue;
      }
      const baseArr = Array.isArray(base) ? base : [];
      if (staged[0] !== null && baseArr[0] === null) bag.error("db.index0", `${rel}[0] must stay null.`);
      const n = Math.max(baseArr.length, staged.length);
      for (let id = 1; id < n; id++) {
        const before = baseArr[id] as Record<string, unknown> | null | undefined;
        const after = staged[id] as Record<string, unknown> | null | undefined;
        if (deepEqual(before, after)) continue;
        if (after && typeof after === "object") {
          if (after.id !== id) bag.error("db.record.id_mismatch", `${def.label} at index ${id} has id ${String(after.id)}.`, `${def.label} ${id}`);
          // Common event lists are validated by the event validator; the record fields are validated here.
          bag.merge(validateRecord(def, after, `${def.label} ${id} [${String(after.name ?? "")}]`, checker));
        }
        const wasNamed = before && typeof before === "object" && before.name !== "";
        const nowGone = after === undefined || after === null || (typeof after === "object" && after.name === "" && wasNamed);
        const kind = CATEGORY_REF_KIND[def.category];
        if (wasNamed && nowGone && kind) {
          index ??= ReferenceIndex.build(view);
          const refs = index.find(kind, id).filter((r) => !(r.source.category === def.category && r.source.recordId === id));
          for (const r of refs.slice(0, 50)) {
            const msg = `${def.label} ${id} [${String(before.name)}] is being ${after ? "blanked" : "removed"} but is referenced here.`;
            if (after) bag.warning("ref.dangling", msg, r.source.label);
            else if (r.confidence === "high") bag.error("ref.dangling", msg, r.source.label);
            else bag.warning("ref.dangling_inferred", `${msg} (inferred from script text)`, r.source.label);
          }
        }
      }
    }
    return bag.items;
  };
}

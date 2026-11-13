import { CommonEventTrigger, Trigger } from "../adapters/rpg-maker-mz/enum-catalog.js";
import {
  defaultEventPage,
  type NativeCommand,
  type NativeCommonEvent,
  type NativeEventPage,
  type NativeMap,
  type NativeMapEvent,
  type NativeMapInfo,
  type NativeTroop,
} from "../adapters/rpg-maker-mz/native-types.js";
import { invalidInput, McpError, notFound } from "../project/errors.js";
import { ProjectService } from "../project/project-service.js";
import { lineDiff } from "../project/text-diff.js";
import type { Workspace } from "../project/transaction-manager.js";
import { ProjectNames } from "../references/project-names.js";
import { listRefs, pageConditionRefs, projectView } from "../references/reference-resolver.js";
import type { NameResolver, Ref } from "../references/ref-types.js";
import { analyzeBlocks, analyzeEvent } from "../validation/flow-analysis.js";
import { validateCommandList, validatePageSettings } from "../validation/event-validator.js";
import { ReferenceChecker } from "../validation/reference-validator.js";
import type { Diagnostic } from "../validation/diagnostics.js";
import {
  appendBlocks,
  assertRevision,
  insertBlocks,
  listRevision,
  moveBlock,
  removeBlock,
  replaceBlock,
  replaceLogic,
  type InsertPosition,
} from "./block-service.js";
import { describeBlock, describeLogic, walkBlocks } from "./ir/describe.js";
import { DEFAULT_NORMALIZE_CONTEXT, type NormalizeContext } from "./ir/input.js";
import { collectScripts, normalizeBlock, normalizeBlocks } from "./ir/normalize.js";
import { parseCommandList } from "./ir/parser.js";
import type { EventBlock } from "./ir/types.js";
import { applyPageSettingsPatch, describePageSettings, pageSettingsView } from "./page-model.js";
import { findMapEvent, locateList, targetFile, targetLabel, type ListTarget } from "./targets.js";

/**
 * Eventing service: read-only inspection plus edit operations that act on
 * a transaction Workspace (never directly on disk).
 */
export class EventService {
  constructor(private readonly project: ProjectService) {}

  names(mapId?: number): ProjectNames {
    const n = new ProjectNames(this.project);
    return mapId === undefined ? n : n.forMap(mapId);
  }

  private namesFor(t: ListTarget): NameResolver {
    return t.kind === "map_event_page" ? this.names(t.mapId) : this.names();
  }

  // ================================================================ discovery

  listMaps(filter: { nameContains?: string; parentId?: number } = {}): Record<string, unknown>[] {
    const infos = this.project.mapInfos().data;
    const q = filter.nameContains?.toLowerCase();
    return infos
      .filter((m): m is NativeMapInfo => !!m)
      .filter((m) => (q ? m.name.toLowerCase().includes(q) : true))
      .filter((m) => (filter.parentId !== undefined ? m.parentId === filter.parentId : true))
      .sort((a, b) => a.order - b.order)
      .map((m) => ({ mapId: m.id, name: m.name, parentId: m.parentId, order: m.order, file: `data/${ProjectService.mapFileName(m.id)}`, fileExists: this.project.hasDataFile(ProjectService.mapFileName(m.id)) }));
  }

  mapSummary(mapId: number): Record<string, unknown> {
    const info = this.project.mapInfo(mapId);
    const snap = this.project.readMap(mapId);
    const map = snap.data;
    const events = map.events.filter((e): e is NativeMapEvent => !!e);
    return {
      mapId,
      name: info.name,
      displayName: map.displayName,
      width: map.width,
      height: map.height,
      tilesetId: map.tilesetId,
      parentId: info.parentId,
      note: map.note,
      eventCount: events.length,
      maxEventId: map.events.length - 1,
      revision: snap.revision,
      events: events.map((e) => this.eventSummary(e)),
    };
  }

  eventSummary(e: NativeMapEvent): Record<string, unknown> {
    return {
      eventId: e.id,
      name: e.name,
      x: e.x,
      y: e.y,
      pageCount: e.pages.length,
      triggers: e.pages.map((p) => Trigger.key(p.trigger)),
      graphic: e.pages[0] ? (e.pages[0].image.characterName ? `${e.pages[0].image.characterName}#${e.pages[0].image.characterIndex}` : e.pages[0].image.tileId ? `tile ${e.pages[0].image.tileId}` : "") : "",
    };
  }

  listMapEvents(mapId: number, opts: { offset?: number; limit?: number; nameContains?: string } = {}): Record<string, unknown> {
    const map = this.project.readMap(mapId).data;
    const q = opts.nameContains?.toLowerCase();
    const all = map.events.filter((e): e is NativeMapEvent => !!e).filter((e) => (q ? e.name.toLowerCase().includes(q) : true));
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    return { mapId, total: all.length, offset, events: all.slice(offset, offset + limit).map((e) => this.eventSummary(e)) };
  }

  getMapEvent(mapId: number, eventId: number): Record<string, unknown> {
    const snap = this.project.readMap(mapId);
    const ev = findMapEvent(snap.data, mapId, eventId);
    const n = this.names(mapId);
    return {
      mapId,
      eventId,
      name: ev.name,
      note: ev.note,
      x: ev.x,
      y: ev.y,
      fileRevision: snap.revision,
      pages: ev.pages.map((p, i) => ({
        ...pageSettingsView(p, i, n),
        commandCount: p.list.length,
        logicRevision: listRevision(p.list),
        preview: describeLogic(parseCommandList(p.list).logic.blocks, n, { maxLines: 6 }),
      })),
    };
  }

  getCommonEvent(commonEventId: number, detailed: boolean): Record<string, unknown> {
    const ces = this.project.commonEvents().data;
    const ce = ces[commonEventId];
    if (!ce) throw notFound(`Common event ${commonEventId} does not exist (IDs 1..${ces.length - 1}).`);
    const parsed = parseCommandList(ce.list, `Common Event ${commonEventId}`);
    const n = this.names();
    const out: Record<string, unknown> = {
      commonEventId,
      name: ce.name,
      trigger: CommonEventTrigger.key(ce.trigger),
      switchId: ce.switchId,
      switchName: n.name("switch", ce.switchId) ?? "",
      revision: listRevision(ce.list),
      complete: parsed.rawBlockCount === 0,
      description: describeLogic(parsed.logic.blocks, n, { maxLines: detailed ? 2000 : 300 }),
    };
    if (detailed) out.logic = parsed.logic;
    return out;
  }

  listCommonEvents(opts: { nameContains?: string; offset?: number; limit?: number }): Record<string, unknown> {
    const q = opts.nameContains?.toLowerCase();
    const all = this.project
      .commonEvents()
      .data.filter((c): c is NativeCommonEvent => !!c)
      .filter((c) => (q ? c.name.toLowerCase().includes(q) : true));
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    return {
      total: all.length,
      offset,
      commonEvents: all.slice(offset, offset + limit).map((c) => ({ commonEventId: c.id, name: c.name, trigger: CommonEventTrigger.key(c.trigger), commandCount: c.list.length })),
    };
  }

  listPlugins(enabledOnly: boolean): Record<string, unknown>[] {
    return this.project
      .plugins()
      .filter((p) => (enabledOnly ? p.status : true))
      .map((p) => ({ name: p.name, enabled: p.status, description: p.description, parameters: p.parameters }));
  }

  // ================================================================ pages & logic

  private readList(t: ListTarget): { list: NativeCommand[]; owner: ReturnType<typeof locateList>; fileRevision: string } {
    const snap = this.project.files.readJson(targetFile(t));
    if (t.kind === "map_event_page") this.project.mapInfo(t.mapId);
    const owner = locateList(snap.data, t);
    return { list: owner.owner.list, owner, fileRevision: snap.revision };
  }

  getEventLogic(t: ListTarget): Record<string, unknown> {
    const { list, fileRevision } = this.readList(t);
    const parsed = parseCommandList(list, targetLabel(t));
    return {
      target: targetLabel(t),
      revision: listRevision(list),
      fileRevision,
      complete: parsed.rawBlockCount === 0,
      rawBlockCount: parsed.rawBlockCount,
      note:
        parsed.rawBlockCount > 0
          ? "raw_command blocks are opaque native commands the IR does not model; they are preserved exactly by all edits."
          : "Every command is represented semantically.",
      logic: parsed.logic,
      // Source map: block id → native command index range [start, end) in the list.
      nativeRanges: Object.fromEntries([...parsed.blocks.values()].map((b) => [b.id, [b.start, b.end]])),
      diagnostics: parsed.diagnostics,
    };
  }

  getEventPage(t: ListTarget, detailed: boolean): Record<string, unknown> {
    const { list, owner, fileRevision } = this.readList(t);
    const n = this.namesFor(t);
    const parsed = parseCommandList(list, targetLabel(t));
    const out: Record<string, unknown> = { target: targetLabel(t), revision: listRevision(list), fileRevision, complete: parsed.rawBlockCount === 0 };
    if (owner.page) out.settings = pageSettingsView(owner.page, (t as { pageIndex: number }).pageIndex, n);
    if (t.kind === "troop_page") out.settings = { span: (owner.owner as unknown as { span: number }).span, conditions: (owner.owner as unknown as { conditions: unknown }).conditions };
    out.description = describeLogic(parsed.logic.blocks, n, { maxLines: detailed ? 3000 : 400 });
    if (detailed) out.logic = parsed.logic;
    return out;
  }

  describeEventPage(t: ListTarget): string {
    const { list, owner } = this.readList(t);
    const n = this.namesFor(t);
    const parsed = parseCommandList(list, targetLabel(t));
    const lines: string[] = [targetLabel(t)];
    if (owner.event) lines.push(`Event: ${owner.event.name} at (${owner.event.x},${owner.event.y}), ${owner.event.pages.length} page(s)`);
    if (owner.page) lines.push(...describePageSettings(owner.page, (t as { pageIndex: number }).pageIndex, n));
    lines.push(`Logic (revision ${listRevision(list)}${parsed.rawBlockCount ? `, ${parsed.rawBlockCount} opaque block(s)` : ""}):`);
    lines.push(...describeLogic(parsed.logic.blocks, n, { maxLines: 600 }).map((l) => `  ${l}`));
    return lines.join("\n");
  }

  describeEvent(mapId: number, eventId: number): string {
    const map = this.project.readMap(mapId).data;
    const ev = findMapEvent(map, mapId, eventId);
    const out: string[] = [`Map ${mapId} / Event ${eventId} "${ev.name}" at (${ev.x},${ev.y}) — ${ev.pages.length} page(s). The highest-numbered page whose conditions are met is active.`];
    ev.pages.forEach((_p, i) => {
      out.push("");
      out.push(this.describeEventPage({ kind: "map_event_page", mapId, eventId, pageIndex: i }).split("\n").slice(1).join("\n"));
    });
    return out.join("\n");
  }

  getEventPageNative(t: ListTarget): Record<string, unknown> {
    const { owner, fileRevision } = this.readList(t);
    return { target: targetLabel(t), fileRevision, native: owner.owner };
  }

  // ================================================================ search & trace

  *allLists(filter: { mapId?: number; eventId?: number; includeCommonEvents?: boolean; includeTroops?: boolean } = {}): Generator<{ target: ListTarget; list: NativeCommand[]; label: string }> {
    const infos = this.project.mapInfos().data;
    for (const info of infos) {
      if (!info || (filter.mapId !== undefined && info.id !== filter.mapId)) continue;
      let map: NativeMap;
      try {
        map = this.project.readMap(info.id).data;
      } catch {
        continue;
      }
      for (const ev of map.events) {
        if (!ev || (filter.eventId !== undefined && ev.id !== filter.eventId)) continue;
        for (let i = 0; i < ev.pages.length; i++) {
          const target: ListTarget = { kind: "map_event_page", mapId: info.id, eventId: ev.id, pageIndex: i };
          yield { target, list: ev.pages[i]!.list, label: `Map ${info.id} [${info.name}] / Event ${ev.id} [${ev.name}] / Page ${i + 1}` };
        }
      }
    }
    if (filter.mapId === undefined && filter.includeCommonEvents !== false && this.project.hasDataFile("CommonEvents.json")) {
      for (const ce of this.project.commonEvents().data) {
        if (ce) yield { target: { kind: "common_event", commonEventId: ce.id }, list: ce.list, label: `Common Event ${ce.id} [${ce.name}]` };
      }
    }
    if (filter.mapId === undefined && filter.includeTroops !== false && this.project.hasDataFile("Troops.json")) {
      for (const tr of this.project.troops().data) {
        if (!tr) continue;
        for (let i = 0; i < tr.pages.length; i++) {
          yield { target: { kind: "troop_page", troopId: tr.id, pageIndex: i }, list: tr.pages[i]!.list, label: `Troop ${tr.id} [${tr.name}] / Page ${i + 1}` };
        }
      }
    }
  }

  searchEventCommands(q: {
    text?: string;
    blockType?: string;
    refKind?: Ref["kind"];
    refId?: number | string;
    mapId?: number;
    eventId?: number;
    includeCommonEvents?: boolean;
    includeTroops?: boolean;
    limit?: number;
  }): Record<string, unknown> {
    const limit = q.limit ?? 50;
    const text = q.text?.toLowerCase();
    const results: Record<string, unknown>[] = [];
    let scanned = 0;
    let truncated = false;
    for (const { target, list, label } of this.allLists(q)) {
      scanned++;
      const n = target.kind === "map_event_page" ? this.names(target.mapId) : this.names();
      const parsed = parseCommandList(list, label);
      const refsByBlock = new Map<string, Ref[]>();
      if (q.refKind) {
        for (const r of listRefs(list, label)) {
          const arr = refsByBlock.get(r.blockId) ?? [];
          arr.push(r.ref);
          refsByBlock.set(r.blockId, arr);
        }
      }
      for (const v of walkBlocks(parsed.logic.blocks)) {
        if (q.blockType && v.block.type !== q.blockType) continue;
        const desc = describeBlock(v.block, n);
        if (text && !desc.toLowerCase().includes(text) && !JSON.stringify(v.block).toLowerCase().includes(text)) continue;
        if (q.refKind && !(refsByBlock.get(v.id) ?? []).some((r) => r.kind === q.refKind && (q.refId === undefined || r.id === q.refId))) continue;
        if (results.length >= limit) {
          truncated = true;
          break;
        }
        results.push({ location: label, target, blockId: v.id, type: v.block.type, description: desc });
      }
      if (truncated) break;
    }
    return { count: results.length, truncated, listsScanned: scanned, results };
  }

  traceDependencies(t: ListTarget, followCommonEvents: boolean): Record<string, unknown> {
    const { list, owner } = this.readList(t);
    const view = projectView(this.project);
    const checker = ReferenceChecker.forProject(this.project, view);
    const n = this.namesFor(t);
    const mapId = t.kind === "map_event_page" ? t.mapId : undefined;
    const seenCe = new Set<number>();
    type Row = { kind: string; id: number | string; role?: string; name?: string; status: string; origin: string; via: string[]; confidence: string };
    const rows = new Map<string, Row>();
    const add = (ref: Ref, via: string, confidence: string) => {
      const key = `${ref.kind}:${String(ref.id)}:${ref.role ?? ""}`;
      const existing = rows.get(key);
      if (existing) {
        if (existing.via.length < 8) existing.via.push(via);
        return;
      }
      const c = checker.check(ref, { mapId });
      rows.set(key, {
        kind: ref.kind,
        id: ref.id,
        ...(ref.role ? { role: ref.role } : {}),
        name: c.name ?? n.name(ref.kind, ref.id) ?? "",
        status: c.status,
        origin: ref.origin ?? "native",
        via: [via],
        confidence,
      });
    };
    if (owner.page) for (const r of pageConditionRefs(owner.page)) add(r, `page condition (${r.via})`, "high");
    const walkList = (l: unknown, label: string, depth: number) => {
      for (const { ref, blockId, confidence } of listRefs(l, label)) {
        add(ref, `${label} block ${blockId}`, confidence);
        if (followCommonEvents && ref.kind === "common_event" && typeof ref.id === "number" && !seenCe.has(ref.id) && depth < 10) {
          seenCe.add(ref.id);
          const ce = this.project.commonEvents().data[ref.id];
          if (ce) walkList(ce.list, `Common Event ${ce.id}`, depth + 1);
        }
      }
    };
    walkList(list, targetLabel(t), 0);
    const byKind: Record<string, Row[]> = {};
    for (const r of rows.values()) (byKind[r.kind] ??= []).push(r);
    for (const arr of Object.values(byKind)) arr.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    return {
      target: targetLabel(t),
      followedCommonEvents: [...seenCe],
      dependencies: byKind,
      note: "status: ok | blank (unnamed record) | invalid (missing) | unresolvable (missing data or runtime-only context). origin 'inferred' rows come from script text and are low confidence.",
    };
  }

  // ================================================================ validation (read-only)

  validateList(t: ListTarget): Diagnostic[] {
    const { list, owner } = this.readList(t);
    const view = projectView(this.project);
    const checker = ReferenceChecker.forProject(this.project, view);
    const label = targetLabel(t);
    const parsed = parseCommandList(list, label);
    const diags = validateCommandList(list, { location: label, owner: t.kind, ...(t.kind === "map_event_page" ? { mapId: t.mapId } : {}) }, checker, parsed);
    if (owner.page && t.kind === "map_event_page") diags.push(...validatePageSettings(owner.page, label, checker, t.mapId));
    diags.push(...analyzeBlocks(parsed.logic.blocks, label, owner.page ? { trigger: owner.page.trigger } : {}));
    return diags;
  }

  validateProposedLogic(t: ListTarget, logicInput: unknown, ctx: NormalizeContext): Diagnostic[] {
    const { list } = this.readList(t);
    const blocks = normalizeBlocks(logicInput, "blocks", { ...ctx, existingScripts: collectScripts(parseCommandList(list).logic.blocks) });
    const replaced = replaceLogic(list, blocks).list;
    const view = projectView(this.project);
    const checker = ReferenceChecker.forProject(this.project, view);
    const label = `${targetLabel(t)} (proposed)`;
    const diags = validateCommandList(replaced, { location: label, owner: t.kind, ...(t.kind === "map_event_page" ? { mapId: t.mapId } : {}) }, checker);
    diags.push(...analyzeBlocks(parseCommandList(replaced).logic.blocks, label));
    return diags;
  }

  validateMap(mapId: number): Diagnostic[] {
    const map = this.project.readMap(mapId).data;
    const out: Diagnostic[] = [];
    const seen = new Map<string, number>();
    for (const ev of map.events) {
      if (!ev) continue;
      const loc = `Map ${mapId} / Event ${ev.id} [${ev.name}]`;
      if (ev.x < 0 || ev.y < 0 || ev.x >= map.width || ev.y >= map.height) out.push({ severity: "error", code: "event.position.out_of_bounds", message: `Event is at (${ev.x},${ev.y}), outside the ${map.width}x${map.height} map.`, location: loc });
      const key = `${ev.x},${ev.y}`;
      if (seen.has(key)) out.push({ severity: "info", code: "event.position.shared", message: `Shares tile (${key}) with event ${seen.get(key)}.`, location: loc });
      else seen.set(key, ev.id);
      for (let i = 0; i < ev.pages.length; i++) out.push(...this.validateList({ kind: "map_event_page", mapId, eventId: ev.id, pageIndex: i }));
      out.push(...analyzeEvent(ev, loc));
    }
    return out;
  }

  // ================================================================ edit operations (workspace)

  private wsList(ws: Workspace, t: ListTarget): { list: NativeCommand[]; owner: ReturnType<typeof locateList> } {
    if (t.kind === "map_event_page") this.project.mapInfo(t.mapId);
    const data = ws.json(targetFile(t));
    const owner = locateList(data, t);
    return { list: owner.owner.list, owner };
  }

  /** Normalization context for a list: scripts already present may be re-submitted without authorization. */
  private ctxFor(list: NativeCommand[], allowScript: boolean): NormalizeContext {
    return { allowScript, existingScripts: collectScripts(parseCommandList(list).logic.blocks) };
  }

  private recordLogicDiff(ws: Workspace, t: ListTarget, before: NativeCommand[], after: NativeCommand[]): void {
    const n = this.namesFor(t);
    const a = describeLogic(parseCommandList(before).logic.blocks, n, { showIds: false });
    const b = describeLogic(parseCommandList(after).logic.blocks, n, { showIds: false });
    ws.semanticDiff.push(`--- ${targetLabel(t)} (logic)`);
    ws.semanticDiff.push(...lineDiff(a, b));
  }

  private setList(ws: Workspace, t: ListTarget, before: NativeCommand[], after: NativeCommand[], summary: string): void {
    const { owner } = this.wsList(ws, t);
    owner.owner.list = after;
    ws.operations.push(`${targetLabel(t)}: ${summary}`);
    this.recordLogicDiff(ws, t, before, after);
  }

  editLogic(
    ws: Workspace,
    t: ListTarget,
    op:
      | { op: "append"; blocks: unknown }
      | { op: "insert"; position: InsertPosition; blocks: unknown; revision?: string }
      | { op: "replace"; blockId: string; block: unknown; revision?: string }
      | { op: "remove"; blockId: string; revision?: string }
      | { op: "move"; blockId: string; position: InsertPosition; revision?: string }
      | { op: "replace_all"; logic: unknown; revision?: string },
    allowScript = false,
  ): string {
    const { list } = this.wsList(ws, t);
    const label = targetLabel(t);
    const ctx = this.ctxFor(list, allowScript);
    // Revisions are checked against the list as it was when this change set started.
    const base = this.baseList(ws, t);
    const checkRev = (rev: string | undefined) => {
      const key = `rev:${label}`;
      if (!ws.scratch.has(key)) {
        assertRevision(base, rev, label);
        ws.scratch.set(key, true);
      } else if (rev !== undefined && rev !== listRevision(base)) {
        assertRevision(base, rev, label);
      }
    };
    let r;
    switch (op.op) {
      case "append":
        r = appendBlocks(list, normalizeBlocks(op.blocks, "blocks", ctx));
        break;
      case "insert":
        checkRev(op.revision);
        r = insertBlocks(list, normalizeBlocks(op.blocks, "blocks", ctx), op.position);
        break;
      case "replace":
        checkRev(op.revision);
        r = replaceBlock(list, op.blockId, normalizeBlock(op.block, "block", ctx));
        break;
      case "remove":
        checkRev(op.revision);
        r = removeBlock(list, op.blockId);
        break;
      case "move":
        checkRev(op.revision);
        r = moveBlock(list, op.blockId, op.position);
        break;
      case "replace_all": {
        checkRev(op.revision);
        const blocks = normalizeLogicInput(op.logic, ctx);
        r = replaceLogic(list, blocks);
        break;
      }
    }
    this.setList(ws, t, list, r.list, r.summary);
    return r.summary;
  }

  private baseList(ws: Workspace, t: ListTarget): NativeCommand[] {
    const base = ws.baseSnapshot(targetFile(t));
    if (!base) throw notFound(`${targetFile(t)} does not exist.`);
    return locateList(base.data, t).owner.list;
  }

  createMapEvent(
    ws: Workspace,
    mapId: number,
    def: { name?: string; x: number; y: number; note?: string; pages?: unknown[] },
    allowScript = false,
  ): number {
    this.project.mapInfo(mapId);
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    if (!Number.isInteger(def.x) || !Number.isInteger(def.y) || def.x < 0 || def.y < 0 || def.x >= map.width || def.y >= map.height) {
      throw invalidInput(`Event position (${def.x},${def.y}) is outside map ${mapId} (${map.width}x${map.height}).`);
    }
    // Editor convention: the lowest free event ID (null slot) is used; otherwise append.
    let id = map.events.findIndex((e, i) => i > 0 && e === null);
    if (id < 1) id = Math.max(map.events.length, 1);
    while (map.events.length < id) map.events.push(null);
    const occupied = map.events.find((e) => e && e.x === def.x && e.y === def.y);
    if (occupied) ws.diagnostics.warning("event.position.shared", `New event shares tile (${def.x},${def.y}) with event ${occupied.id} [${occupied.name}].`, `Map ${mapId}`);
    const pagesIn = def.pages && def.pages.length ? def.pages : [{}];
    const pages = pagesIn.map((p, i) => this.buildPage(p, `pages[${i}]`, { allowScript, existingScripts: new Set() }));
    const ev: NativeMapEvent = { id, name: def.name ?? `EV${String(id).padStart(3, "0")}`, note: def.note ?? "", pages, x: def.x, y: def.y };
    map.events[id] = ev;
    ws.operations.push(`Map ${mapId}: created event ${id} "${ev.name}" at (${def.x},${def.y}) with ${pages.length} page(s)`);
    ws.semanticDiff.push(`+++ Map ${mapId} / Event ${id} (new)`);
    pages.forEach((p, i) => ws.semanticDiff.push(...describePageSettings(p, i, this.names(mapId)).map((l) => `+ ${l}`), ...describeLogic(parseCommandList(p.list).logic.blocks, this.names(mapId), { showIds: false }).map((l) => `+     ${l}`)));
    return id;
  }

  /** Build a native page from {settings?, logic?/blocks?}. */
  buildPage(def: unknown, path: string, ctx: NormalizeContext): NativeEventPage {
    const page = defaultEventPage();
    if (def === undefined || def === null) return page;
    if (typeof def !== "object" || Array.isArray(def)) throw invalidInput(`${path}: expected {settings?, blocks?}.`);
    const o = def as Record<string, unknown>;
    const unknownKeys = Object.keys(o).filter((k) => !["settings", "blocks", "logic"].includes(k));
    if (unknownKeys.length) throw invalidInput(`${path}: unknown field(s) ${unknownKeys.join(", ")} (expected settings, blocks).`);
    if (o.settings !== undefined) applyPageSettingsPatch(page, o.settings, `${path}.settings`, ctx);
    const logic = o.blocks ?? o.logic;
    if (logic !== undefined) page.list = replaceLogic(page.list, normalizeLogicInput(logic, ctx)).list;
    return page;
  }

  updateMapEvent(ws: Workspace, mapId: number, eventId: number, patch: { name?: string; note?: string; x?: number; y?: number }): string {
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    const ev = findMapEvent(map, mapId, eventId);
    const changes: string[] = [];
    if (patch.name !== undefined) {
      changes.push(`name "${ev.name}" → "${patch.name}"`);
      ev.name = patch.name;
    }
    if (patch.note !== undefined) {
      changes.push("note updated");
      ev.note = patch.note;
    }
    if (patch.x !== undefined || patch.y !== undefined) {
      const x = patch.x ?? ev.x;
      const y = patch.y ?? ev.y;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= map.width || y >= map.height) throw invalidInput(`Position (${x},${y}) is outside map ${mapId} (${map.width}x${map.height}).`);
      changes.push(`position (${ev.x},${ev.y}) → (${x},${y})`);
      ev.x = x;
      ev.y = y;
    }
    if (!changes.length) throw invalidInput("Nothing to update: provide name, note, x or y.");
    const s = `Map ${mapId} / Event ${eventId}: ${changes.join(", ")}`;
    ws.operations.push(s);
    ws.semanticDiff.push(s);
    return s;
  }

  deleteMapEvent(ws: Workspace, mapId: number, eventId: number): string {
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    const ev = findMapEvent(map, mapId, eventId);
    // Never renumber or compact: the slot simply becomes null.
    map.events[eventId] = null;
    ws.destructive = true;
    const s = `Map ${mapId}: DELETED event ${eventId} "${ev.name}" (${ev.pages.length} page(s)) at (${ev.x},${ev.y})`;
    ws.operations.push(s);
    ws.semanticDiff.push(`--- ${s}`);
    return s;
  }

  createEventPage(ws: Workspace, mapId: number, eventId: number, def: unknown, insertAt: number | undefined, allowScript = false): number {
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    const ev = findMapEvent(map, mapId, eventId);
    const at = insertAt ?? ev.pages.length;
    if (!Number.isInteger(at) || at < 0 || at > ev.pages.length) throw invalidInput(`insertAt must be 0..${ev.pages.length}.`);
    const page = this.buildPage(def, "page", { allowScript, existingScripts: new Set() });
    ev.pages.splice(at, 0, page);
    const s = `Map ${mapId} / Event ${eventId}: added page at pageIndex ${at} (Page ${at + 1}); event now has ${ev.pages.length} page(s)`;
    ws.operations.push(s);
    ws.semanticDiff.push(`+++ ${s}`, ...describePageSettings(page, at, this.names(mapId)).map((l) => `+ ${l}`), ...describeLogic(parseCommandList(page.list).logic.blocks, this.names(mapId), { showIds: false }).map((l) => `+     ${l}`));
    return at;
  }

  cloneEventPage(ws: Workspace, mapId: number, eventId: number, pageIndex: number, dest?: { eventId?: number; insertAt?: number }): number {
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    const src = findMapEvent(map, mapId, eventId);
    const page = src.pages[pageIndex];
    if (!page) throw notFound(`Event ${eventId} has no pageIndex ${pageIndex}.`);
    const target = dest?.eventId !== undefined ? findMapEvent(map, mapId, dest.eventId) : src;
    const at = dest?.insertAt ?? target.pages.length;
    if (!Number.isInteger(at) || at < 0 || at > target.pages.length) throw invalidInput(`insertAt must be 0..${target.pages.length}.`);
    target.pages.splice(at, 0, structuredClone(page));
    const s = `Map ${mapId}: cloned Event ${eventId} page ${pageIndex + 1} → Event ${target.id} pageIndex ${at}`;
    ws.operations.push(s);
    ws.semanticDiff.push(`+++ ${s}`);
    return at;
  }

  deleteEventPage(ws: Workspace, mapId: number, eventId: number, pageIndex: number): string {
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    const ev = findMapEvent(map, mapId, eventId);
    if (!ev.pages[pageIndex]) throw notFound(`Event ${eventId} has no pageIndex ${pageIndex}.`);
    if (ev.pages.length === 1) throw invalidInput("An event must keep at least one page (the editor does not allow zero pages). Delete the event instead.");
    const removed = ev.pages.splice(pageIndex, 1)[0]!;
    ws.destructive = true;
    const s = `Map ${mapId} / Event ${eventId}: DELETED page ${pageIndex + 1} (${removed.list.length} commands); later pages shift down by one`;
    ws.operations.push(s);
    ws.semanticDiff.push(`--- ${s}`);
    return s;
  }

  reorderEventPages(ws: Workspace, mapId: number, eventId: number, order: number[]): string {
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    const ev = findMapEvent(map, mapId, eventId);
    const n = ev.pages.length;
    const sorted = [...order].sort((a, b) => a - b);
    if (order.length !== n || sorted.some((v, i) => v !== i)) {
      throw invalidInput(`order must be a permutation of 0..${n - 1} (current pageIndexes listed in their new order).`);
    }
    ev.pages = order.map((i) => ev.pages[i]!);
    const s = `Map ${mapId} / Event ${eventId}: pages reordered to [${order.join(", ")}] (page priority changes: later pages win)`;
    ws.operations.push(s);
    ws.semanticDiff.push(s);
    return s;
  }

  updatePageSettings(ws: Workspace, mapId: number, eventId: number, pageIndex: number, patch: unknown, allowScript = false): string {
    const map = ws.json<NativeMap>(`data/${ProjectService.mapFileName(mapId)}`);
    const ev = findMapEvent(map, mapId, eventId);
    const page = ev.pages[pageIndex];
    if (!page) throw notFound(`Event ${eventId} has no pageIndex ${pageIndex}.`);
    const n = this.names(mapId);
    const before = describePageSettings(page, pageIndex, n);
    const changes = applyPageSettingsPatch(page, patch, "settings", { allowScript, existingScripts: new Set() });
    const after = describePageSettings(page, pageIndex, n);
    const s = `Map ${mapId} / Event ${eventId} / Page ${pageIndex + 1}: ${changes.join("; ")}`;
    ws.operations.push(s);
    ws.semanticDiff.push(`--- ${targetLabel({ kind: "map_event_page", mapId, eventId, pageIndex })} (settings)`, ...lineDiff(before, after));
    return s;
  }

  updateCommonEvent(ws: Workspace, commonEventId: number, patch: { name?: string; trigger?: unknown; switchId?: number }): string {
    const ces = ws.json<(NativeCommonEvent | null)[]>("data/CommonEvents.json");
    const ce = ces[commonEventId];
    if (!ce) throw notFound(`Common event ${commonEventId} does not exist.`);
    const changes: string[] = [];
    if (patch.name !== undefined) {
      changes.push(`name → "${patch.name}"`);
      ce.name = patch.name;
    }
    if (patch.trigger !== undefined) {
      ce.trigger = CommonEventTrigger.parse(patch.trigger, "trigger");
      changes.push(`trigger → ${CommonEventTrigger.label(ce.trigger)}`);
    }
    if (patch.switchId !== undefined) {
      if (!Number.isInteger(patch.switchId) || patch.switchId < 1) throw invalidInput("switchId must be a positive integer.");
      ce.switchId = patch.switchId;
      changes.push(`switchId → ${patch.switchId}`);
    }
    if (!changes.length) throw invalidInput("Nothing to update: provide name, trigger or switchId.");
    const s = `Common Event ${commonEventId}: ${changes.join(", ")}`;
    ws.operations.push(s);
    ws.semanticDiff.push(s);
    return s;
  }
}

function normalizeLogicInput(logic: unknown, ctx: NormalizeContext): EventBlock[] {
  if (Array.isArray(logic)) return normalizeBlocks(logic, "logic", ctx);
  if (logic && typeof logic === "object" && Array.isArray((logic as { blocks?: unknown }).blocks)) {
    const v = (logic as { irVersion?: unknown }).irVersion;
    if (v !== undefined && v !== 1) throw invalidInput(`logic.irVersion ${JSON.stringify(v)} is not supported (expected 1).`);
    return normalizeBlocks((logic as { blocks: unknown }).blocks, "logic.blocks", ctx);
  }
  throw invalidInput('logic must be an array of blocks or {"irVersion":1,"blocks":[...]}.');
}

export { DEFAULT_NORMALIZE_CONTEXT, McpError };
export type { NativeTroop };

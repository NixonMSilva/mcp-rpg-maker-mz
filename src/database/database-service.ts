import { MzEnum, ParamId, traitDef, effectDef } from "../adapters/rpg-maker-mz/enum-catalog.js";
import { invalidInput, McpError, notFound } from "../project/errors.js";
import { deepEqual, jsonDiff } from "../project/json-diff.js";
import type { ProjectService } from "../project/project-service.js";
import type { Workspace } from "../project/transaction-manager.js";
import { ProjectNames } from "../references/project-names.js";
import { projectView, ReferenceIndex, type DataView } from "../references/reference-resolver.js";
import type { NameResolver, RefKind } from "../references/ref-types.js";
import { DiagnosticBag, type Diagnostic } from "../validation/diagnostics.js";
import { reportRef } from "../validation/event-validator.js";
import { ReferenceChecker } from "../validation/reference-validator.js";
import {
  CATEGORIES,
  CATEGORY_REF_KIND,
  categoryDef,
  dataIdRefKind,
  recordRefs,
  type CategoryDef,
  type CollectionEntryField,
  type CollectionSpec,
  type DatabaseCategory,
  type FieldSpec,
} from "./database-catalog.js";
import { parseNoteTags, removeNoteTag, setNoteTag } from "./note-tags.js";
import { collectionRevision, DATA_ID_ENUMS, describeEffect, describeTrait, entryFingerprint, getPath, recordSummary, recordView, setPath } from "./record-views.js";

/**
 * Database service (DATABASE_SPEC §5-§8): discovery, normalized views,
 * search, and typed edit operations that act on a transaction Workspace.
 *
 * Invariants: arrays are never compacted or renumbered; index-0 nulls and
 * unknown fields are preserved; updates use patch semantics.
 */
export class DatabaseService {
  constructor(private readonly project: ProjectService) {}

  names(): NameResolver {
    return new ProjectNames(this.project);
  }

  def(category: string): CategoryDef {
    const d = categoryDef(category);
    if (!d) throw invalidInput(`Unknown database category ${JSON.stringify(category)}. Categories: ${CATEGORIES.map((c) => c.category).join(", ")}.`);
    return d;
  }

  private filePath(def: CategoryDef): string {
    return `data/${def.file}`;
  }

  private readArray(def: CategoryDef): unknown[] {
    if (def.singleton) throw invalidInput(`${def.category} is a singleton (no record IDs).`);
    if (!this.project.hasDataFile(def.file)) throw new McpError("FILE_NOT_FOUND", `data/${def.file} is not present in this project.`);
    const data = this.project.readData(def.file).data;
    if (!Array.isArray(data)) throw new McpError("MALFORMED_DATA", `data/${def.file} is not an array.`);
    return data;
  }

  // ================================================================ discovery

  listCategories(): Record<string, unknown>[] {
    return CATEGORIES.map((def) => {
      const available = this.project.hasDataFile(def.file);
      const out: Record<string, unknown> = { category: def.category, label: def.label, file: `data/${def.file}`, available };
      if (!available) return out;
      try {
        const data = this.project.readData(def.file).data;
        if (def.singleton) out.singleton = true;
        else if (Array.isArray(data)) {
          out.maxId = data.length - 1;
          out.recordCount = data.filter((r) => r !== null).length - 0;
          out.namedRecordCount = data.filter((r) => r && typeof (r as { name?: unknown }).name === "string" && (r as { name: string }).name !== "").length;
        } else out.malformed = true;
      } catch (err) {
        out.error = (err as Error).message;
      }
      return out;
    });
  }

  listRecords(category: string, opts: { offset?: number; limit?: number; nameContains?: string; includeBlank?: boolean } = {}): Record<string, unknown> {
    const def = this.def(category);
    const arr = this.readArray(def);
    const n = this.names();
    const q = opts.nameContains?.toLowerCase();
    const rows: Record<string, unknown>[] = [];
    arr.forEach((r, i) => {
      if (!r || typeof r !== "object") return;
      const rec = r as Record<string, unknown>;
      const name = String(rec.name ?? "");
      if (!opts.includeBlank && name === "") return;
      if (q && !name.toLowerCase().includes(q)) return;
      rows.push(recordSummary(def, { ...rec, id: rec.id ?? i }, n));
    });
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    return { category, total: rows.length, maxId: arr.length - 1, offset, records: rows.slice(offset, offset + limit) };
  }

  getRecordNative(category: string, id: number): Record<string, unknown> {
    const def = this.def(category);
    if (def.singleton) return this.project.readData<Record<string, unknown>>(def.file).data;
    const arr = this.readArray(def);
    const r = arr[id];
    if (!r || id < 1) throw notFound(`${def.label} ${id} does not exist (IDs 1..${arr.length - 1}).`);
    return r as Record<string, unknown>;
  }

  getRecord(category: string, id: number | undefined, detailed: boolean): Record<string, unknown> {
    const def = this.def(category);
    if (def.singleton) return this.systemView(detailed);
    if (id === undefined) throw invalidInput("id is required.");
    const rec = this.getRecordNative(category, id);
    return { category, ...recordView(def, rec, this.names(), detailed) };
  }

  private systemView(detailed: boolean): Record<string, unknown> {
    const def = this.def("system");
    const sys = this.project.system().data;
    const view = recordView(def, sys, this.names(), detailed);
    const lists: Record<string, unknown> = {};
    for (const k of ["elements", "skillTypes", "weaponTypes", "armorTypes", "equipTypes"]) {
      const arr = sys[k];
      if (Array.isArray(arr)) lists[k] = arr.map((v, i) => ({ id: i, name: v })).slice(1);
    }
    const sw = Array.isArray(sys.switches) ? (sys.switches as string[]) : [];
    const vars = Array.isArray(sys.variables) ? (sys.variables as string[]) : [];
    return {
      category: "system",
      ...view,
      lists,
      switches: { count: sw.length - 1, named: sw.filter((s, i) => i > 0 && s).length, note: "Use list_switches / list_variables for names and usage." },
      variables: { count: vars.length - 1, named: vars.filter((s, i) => i > 0 && s).length },
      terms: detailed ? sys.terms : "(use detailed=true)",
      patchablePaths: [
        ...def.fields.map((f) => f.path),
        "switches.<id>",
        "variables.<id>",
        "elements.<id>",
        "skillTypes.<id>",
        "weaponTypes.<id>",
        "armorTypes.<id>",
        "equipTypes.<id>",
        "terms.basic.<index>",
        "terms.commands.<index>",
        "terms.params.<index>",
        "terms.messages.<key>",
        "boat|ship|airship.{characterName,characterIndex,startMapId,startX,startY,bgm}",
        "sounds.<index>",
      ],
    };
  }

  search(q: { text: string; categories?: string[]; fields?: ("name" | "note" | "description" | "meta")[]; limit?: number }): Record<string, unknown> {
    const text = q.text.toLowerCase();
    const fields = q.fields ?? ["name", "note", "description"];
    const cats = (q.categories?.length ? q.categories : CATEGORIES.filter((c) => !c.singleton).map((c) => c.category)).map((c) => this.def(c));
    const limit = q.limit ?? 50;
    const results: Record<string, unknown>[] = [];
    let truncated = false;
    for (const def of cats) {
      if (def.singleton || !this.project.hasDataFile(def.file)) continue;
      const arr = this.readArray(def);
      for (const r of arr) {
        if (!r || typeof r !== "object") continue;
        const rec = r as Record<string, unknown>;
        const matched: string[] = [];
        for (const f of fields) {
          if (f === "meta") {
            const tags = typeof rec.note === "string" ? parseNoteTags(rec.note) : [];
            if (tags.some((t) => t.name.toLowerCase().includes(text) || String(t.value).toLowerCase().includes(text))) matched.push("meta");
          } else if (typeof rec[f] === "string" && (rec[f] as string).toLowerCase().includes(text)) matched.push(f);
        }
        if (!matched.length) continue;
        if (results.length >= limit) {
          truncated = true;
          break;
        }
        results.push({ category: def.category, id: rec.id, name: rec.name, matched });
      }
      if (truncated) break;
    }
    return { count: results.length, truncated, results };
  }

  /** Resolve by ID (validate) or by name (exact matches first, then partial). */
  resolveReference(category: string, by: { id?: number; name?: string }): Record<string, unknown> {
    const def = this.def(category);
    const arr = this.readArray(def);
    if (by.id !== undefined) {
      const r = arr[by.id] as Record<string, unknown> | null | undefined;
      if (!r || by.id < 1) return { category, id: by.id, status: "invalid", message: `${def.label} ${by.id} does not exist.` };
      return { category, id: by.id, name: r.name, status: r.name === "" ? "blank" : "ok", method: "id" };
    }
    if (!by.name) throw invalidInput("Provide id or name.");
    const needle = by.name.toLowerCase();
    const exact: Record<string, unknown>[] = [];
    const partial: Record<string, unknown>[] = [];
    arr.forEach((r) => {
      if (!r || typeof r !== "object") return;
      const rec = r as { id: number; name: string };
      const nm = String(rec.name ?? "");
      if (!nm) return;
      if (nm.toLowerCase() === needle) exact.push({ id: rec.id, name: nm });
      else if (nm.toLowerCase().includes(needle)) partial.push({ id: rec.id, name: nm });
    });
    const status = exact.length === 1 ? "resolved" : exact.length > 1 ? "ambiguous" : partial.length ? "candidates" : "not_found";
    return {
      category,
      query: by.name,
      status,
      ...(exact.length === 1 ? { id: exact[0]!.id, name: exact[0]!.name, method: "exact name" } : {}),
      exactMatches: exact,
      partialMatches: partial.slice(0, 20),
      advice: status === "resolved" ? undefined : "Ask the user to choose when the match is ambiguous or only partial.",
    };
  }

  compareRecords(category: string, a: number, b: number): Record<string, unknown> {
    const ra = this.getRecordNative(category, a);
    const rb = this.getRecordNative(category, b);
    const { changes, truncated } = jsonDiff({ ...ra, id: undefined }, { ...rb, id: undefined }, 300);
    return { category, a: { id: a, name: ra.name }, b: { id: b, name: rb.name }, differences: changes.map((c) => ({ path: c.path, kind: c.kind, [`#${a}`]: c.before, [`#${b}`]: c.after })), truncated };
  }

  findReferences(category: string, id: number): Record<string, unknown> {
    const kind = CATEGORY_REF_KIND[this.def(category).category];
    if (!kind) throw invalidInput(`References to ${category} records are not indexed.`);
    return this.findRefsOfKind(kind, id);
  }

  findRefsOfKind(kind: RefKind, id: number | string, opts: { mapId?: number; eventId?: number } = {}): Record<string, unknown> {
    const idx = ReferenceIndex.build(projectView(this.project));
    const hits = idx.find(kind, id, opts);
    const targetName = this.names().name(kind, id) ?? (kind === "event" && opts.mapId !== undefined ? new ProjectNames(this.project, opts.mapId).name("event", id) : undefined) ?? "";
    return {
      target: { kind, id, name: targetName },
      count: hits.length,
      references: hits.slice(0, 500).map((h) => ({
        location: h.source.label,
        file: h.source.file,
        targetKind: h.ref.kind,
        targetId: h.ref.id,
        targetName,
        origin: h.ref.origin ?? "native",
        method: h.ref.origin === "inferred" ? "pattern match in script text" : h.ref.via?.startsWith("text code") ? "message text code" : "native field/command parameter",
        confidence: h.confidence,
        role: h.ref.role,
        ...(h.source.blockId ? { blockId: h.source.blockId } : {}),
      })),
      truncated: hits.length > 500,
      caveat:
        "Script commands, note tags and plugin parameters can reference IDs in ways that cannot be resolved; inferred matches are low confidence and an empty result does not prove the record is unused.",
    };
  }

  /** Switch/variable listing with usage counts, for picking IDs without conflicts. */
  listSwitchesOrVariables(kind: "switch" | "variable", opts: { offset?: number; limit?: number; onlyFree?: boolean; nameContains?: string }): Record<string, unknown> {
    const sys = this.project.system().data;
    const arr = (Array.isArray(sys[kind === "switch" ? "switches" : "variables"]) ? sys[kind === "switch" ? "switches" : "variables"] : []) as string[];
    const idx = ReferenceIndex.build(projectView(this.project));
    const usage = new Map<number, number>();
    for (const e of idx.entries) if (e.ref.kind === kind && typeof e.ref.id === "number") usage.set(e.ref.id, (usage.get(e.ref.id) ?? 0) + 1);
    const q = opts.nameContains?.toLowerCase();
    const rows: Record<string, unknown>[] = [];
    for (let i = 1; i < arr.length; i++) {
      const name = arr[i] ?? "";
      const uses = usage.get(i) ?? 0;
      if (opts.onlyFree && (name !== "" || uses > 0)) continue;
      if (q && !name.toLowerCase().includes(q)) continue;
      rows.push({ id: i, name, references: uses });
    }
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 200;
    return {
      kind,
      maxId: arr.length - 1,
      total: rows.length,
      offset,
      entries: rows.slice(offset, offset + limit),
      note: opts.onlyFree ? "Free = unnamed and not referenced by any event, common event or troop (scripts/plugins may still use it; inferred script uses are counted)." : undefined,
    };
  }

  // ================================================================ edits

  private wsArray(ws: Workspace, def: CategoryDef): unknown[] {
    const arr = ws.json<unknown[]>(this.filePath(def));
    if (!Array.isArray(arr)) throw new McpError("MALFORMED_DATA", `data/${def.file} is not an array.`);
    return arr;
  }

  private wsRecord(ws: Workspace, def: CategoryDef, id: number): Record<string, unknown> {
    if (def.singleton) return ws.json<Record<string, unknown>>(this.filePath(def));
    const arr = this.wsArray(ws, def);
    const r = arr[id];
    if (!r || id < 1) throw notFound(`${def.label} ${id} does not exist (IDs 1..${arr.length - 1}).`);
    return r as Record<string, unknown>;
  }

  /** Apply a field patch (patch semantics). Returns change descriptions. */
  private applyPatch(def: CategoryDef, rec: Record<string, unknown>, patch: Record<string, unknown>, path: string): string[] {
    const flat = flattenPatch(def, patch);
    const changes: string[] = [];
    for (const [key, value] of Object.entries(flat)) {
      if (def.collections.some((c) => c.key === key)) {
        throw invalidInput(`${path}.${key} is a collection; use database_edit_collection (add/update/move/remove) instead of replacing it.`);
      }
      if (def.category === "system") {
        const s = this.applySystemPath(rec, key, value, path);
        if (s) {
          changes.push(s);
          continue;
        }
      }
      const spec = def.fields.find((f) => f.path === key);
      if (!spec) {
        // Unmodeled (e.g. plugin-added) top-level field that already exists: allow same-type replacement.
        // System.json is allowlist-only (editor-managed fields such as versionId must not be patched).
        if (def.category !== "system" && !key.includes(".") && key in rec && key !== "id" && isPrimitiveSameType(rec[key], value)) {
          const before = rec[key];
          rec[key] = value;
          changes.push(`${key}: ${JSON.stringify(before)} → ${JSON.stringify(value)} (unmodeled field)`);
          continue;
        }
        throw invalidInput(`${path}.${key}: not a patchable ${def.category} field. Patchable: ${def.fields.map((f) => f.path).join(", ")}.`);
      }
      const v = coerceField(spec, value, `${path}.${key}`);
      const before = getPath(rec, spec.path);
      if (before === undefined && spec.path.includes(".")) throw invalidInput(`${path}.${key}: the native record has no ${spec.path.split(".")[0]} object.`);
      setPath(rec, spec.path, v);
      if (!deepEqual(before, v)) changes.push(`${spec.path}: ${JSON.stringify(before)} → ${JSON.stringify(v)}`);
    }
    return changes;
  }

  private applySystemPath(sys: Record<string, unknown>, key: string, value: unknown, path: string): string | null {
    const m = /^(switches|variables|elements|skillTypes|weaponTypes|armorTypes|equipTypes)\.(\d+)$/.exec(key);
    if (m) {
      const arr = sys[m[1]!];
      const i = Number(m[2]);
      if (!Array.isArray(arr) || i < 1 || i >= arr.length) throw invalidInput(`${path}.${key}: index out of range (1..${Array.isArray(arr) ? arr.length - 1 : 0}). Resizing lists is not supported; use the editor's "Change Maximum".`);
      if (typeof value !== "string") throw invalidInput(`${path}.${key}: string name required.`);
      const before = arr[i];
      arr[i] = value;
      return `${key}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`;
    }
    const t = /^terms\.(basic|commands|params)\.(\d+)$/.exec(key);
    if (t) {
      const arr = (sys.terms as Record<string, unknown[]> | undefined)?.[t[1]!];
      const i = Number(t[2]);
      if (!Array.isArray(arr) || i < 0 || i >= arr.length) throw invalidInput(`${path}.${key}: index out of range.`);
      if (typeof value !== "string" && value !== null) throw invalidInput(`${path}.${key}: string required.`);
      const before = arr[i];
      arr[i] = value;
      return `${key}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`;
    }
    const tm = /^terms\.messages\.([A-Za-z0-9_]+)$/.exec(key);
    if (tm) {
      const msgs = (sys.terms as Record<string, Record<string, unknown>> | undefined)?.messages;
      if (!msgs || !(tm[1]! in msgs)) throw invalidInput(`${path}.${key}: unknown message key.`);
      if (typeof value !== "string") throw invalidInput(`${path}.${key}: string required.`);
      const before = msgs[tm[1]!];
      msgs[tm[1]!] = value;
      return `${key}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`;
    }
    const s = /^sounds\.(\d+)$/.exec(key);
    if (s) {
      const arr = sys.sounds;
      const i = Number(s[1]);
      if (!Array.isArray(arr) || i < 0 || i >= arr.length) throw invalidInput(`${path}.${key}: index out of range.`);
      arr[i] = coerceField({ path: key, type: "audio", description: "" }, value, `${path}.${key}`);
      return `${key} updated`;
    }
    const v = /^(boat|ship|airship)\.(characterName|characterIndex|startMapId|startX|startY|bgm)$/.exec(key);
    if (v) {
      const veh = sys[v[1]!] as Record<string, unknown> | undefined;
      if (!veh) throw invalidInput(`${path}.${key}: vehicle data missing.`);
      const type = v[2] === "characterName" ? "string" : v[2] === "bgm" ? "audio" : "int";
      const val = coerceField({ path: key, type, description: "", ...(type === "int" ? { min: 0 } : {}) }, value, `${path}.${key}`);
      const before = veh[v[2]!];
      veh[v[2]!] = val;
      return `${key}: ${JSON.stringify(before)} → ${JSON.stringify(val)}`;
    }
    return null;
  }

  updateRecord(ws: Workspace, category: string, id: number | undefined, patch: unknown): string {
    const def = this.def(category);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalidInput("patch must be an object of field paths to values.");
    const rec = this.wsRecord(ws, def, id ?? 0);
    const changes = this.applyPatch(def, rec, patch as Record<string, unknown>, "patch");
    if (!changes.length) throw invalidInput("The patch does not change anything.");
    const label = def.singleton ? def.label : `${def.label} ${id} [${String(rec.name)}]`;
    ws.operations.push(`${label}: updated ${changes.length} field(s)`);
    ws.semanticDiff.push(`--- ${label}`, ...changes.map((c) => `  ${c}`));
    return `${label}: ${changes.join("; ")}`;
  }

  setNote(ws: Workspace, category: string, id: number, op: { op: "replace"; note: string } | { op: "set_tag"; tag: string; value?: string | true } | { op: "remove_tag"; tag: string }): string {
    const def = this.def(category);
    const rec = this.wsRecord(ws, def, id);
    if (typeof rec.note !== "string") throw invalidInput(`${def.label} records have no note field.`);
    const before = rec.note;
    let after: string;
    let desc: string;
    if (op.op === "replace") {
      after = op.note;
      desc = "note replaced";
    } else if (op.op === "set_tag") {
      try {
        after = setNoteTag(before, op.tag, op.value ?? true);
      } catch (err) {
        throw invalidInput((err as Error).message);
      }
      desc = `tag <${op.tag}${op.value === undefined || op.value === true ? "" : `: ${op.value}`}> set`;
    } else {
      const r = removeNoteTag(before, op.tag);
      if (!r.removed) throw notFound(`Tag <${op.tag}> is not present in the note.`);
      after = r.note;
      desc = `tag <${op.tag}> removed (${r.removed} occurrence(s))`;
    }
    rec.note = after;
    const label = `${def.label} ${id} [${String(rec.name)}]`;
    ws.operations.push(`${label}: ${desc}`);
    ws.semanticDiff.push(`--- ${label} note`, `- ${JSON.stringify(before)}`, `+ ${JSON.stringify(after)}`);
    return `${label}: ${desc}`;
  }

  /** Allocate an ID following native conventions: append (max+1) unless a usable slot is requested explicitly. */
  private allocate(ws: Workspace, def: CategoryDef, requested: number | undefined, overwriteBlank: boolean): number {
    const arr = this.wsArray(ws, def);
    if (requested === undefined) return arr.length;
    if (!Number.isInteger(requested) || requested < 1) throw invalidInput("id must be a positive integer.");
    if (requested >= arr.length) {
      if (requested > arr.length) throw invalidInput(`id ${requested} would leave gaps (max is ${arr.length - 1}); omit id to append as ${arr.length}.`);
      return requested;
    }
    const cur = arr[requested] as Record<string, unknown> | null;
    if (cur === null) return requested;
    if (cur.name !== "") throw invalidInput(`${def.label} ${requested} is in use ("${String(cur.name)}"). Records are never overwritten; omit id to append.`);
    if (!overwriteBlank) throw invalidInput(`${def.label} ${requested} is an unnamed blank slot. Pass overwriteBlank=true to reuse it (references to it are checked during validation).`);
    const kind = CATEGORY_REF_KIND[def.category];
    if (kind) {
      const refs = ReferenceIndex.build(projectView(this.project)).find(kind, requested).filter((r) => r.confidence === "high");
      if (refs.length) throw invalidInput(`${def.label} ${requested} is blank but referenced by ${refs.length} location(s) (e.g. ${refs[0]!.source.label}); choose another slot.`);
    }
    return requested;
  }

  private placeRecord(ws: Workspace, def: CategoryDef, id: number, rec: Record<string, unknown>): void {
    const arr = this.wsArray(ws, def);
    if (id === arr.length) arr.push(rec);
    else arr[id] = rec;
  }

  private blankRecord(ws: Workspace, def: CategoryDef, id: number): Record<string, unknown> {
    let body: Record<string, unknown>;
    if (def.blank) body = def.blank();
    else if (def.category === "class") body = this.blankClass(ws);
    else if (def.category === "animation") {
      body = { displayType: 0, alignBottom: false, effectName: "", flashTimings: [], name: "", offsetX: 0, offsetY: 0, rotation: { x: 0, y: 0, z: 0 }, scale: 100, soundTimings: [], speed: 100 };
    } else throw new McpError("UNSUPPORTED", `Creating ${def.label} records is not supported.`);
    return { id, ...body };
  }

  private blankClass(ws: Workspace): Record<string, unknown> {
    const arr = this.wsArray(ws, this.def("class"));
    const base = arr.find((r, i) => i > 0 && r && Array.isArray((r as { params?: unknown }).params)) as { params: number[][]; expParams: number[] } | undefined;
    const params = base ? structuredClone(base.params) : [linearCurve(450, 5000), linearCurve(90, 900), linearCurve(16, 250), linearCurve(16, 250), linearCurve(16, 250), linearCurve(16, 250), linearCurve(32, 400), linearCurve(32, 400)];
    return {
      expParams: base ? [...base.expParams] : [30, 20, 30, 30],
      traits: [
        { code: 23, dataId: 0, value: 1 },
        { code: 22, dataId: 0, value: 0.95 },
        { code: 22, dataId: 1, value: 0.05 },
        { code: 22, dataId: 2, value: 0.04 },
        { code: 41, dataId: 1, value: 0 },
        { code: 51, dataId: 1, value: 0 },
        { code: 52, dataId: 1, value: 0 },
      ],
      learnings: [],
      name: "",
      note: "",
      params,
    };
  }

  createRecord(
    ws: Workspace,
    category: string,
    input: { name: string; fields?: Record<string, unknown>; collections?: Record<string, unknown[]>; noteTags?: Record<string, string | true>; id?: number; overwriteBlank?: boolean },
  ): number {
    const def = this.def(category);
    if (def.singleton || def.category === "map_info" || def.category === "tileset") throw new McpError("UNSUPPORTED", `Creating ${def.label} records is not supported (use the editor).`);
    if (typeof input.name !== "string" || input.name.trim() === "") throw invalidInput("name is required for new records.");
    const id = this.allocate(ws, def, input.id, input.overwriteBlank === true);
    const rec = this.blankRecord(ws, def, id);
    rec.name = input.name;
    const changes: string[] = [`name = ${JSON.stringify(input.name)}`];
    if (input.fields) changes.push(...this.applyPatch(def, rec, input.fields, "fields"));
    if (input.collections) {
      for (const [key, entries] of Object.entries(input.collections)) {
        const spec = def.collections.find((c) => c.key === key);
        if (!spec) throw invalidInput(`collections.${key}: ${def.label} has no such collection (${def.collections.map((c) => c.key).join(", ") || "none"}).`);
        if (!Array.isArray(entries)) throw invalidInput(`collections.${key} must be an array.`);
        if (spec.fixedLength !== undefined && entries.length !== spec.fixedLength) throw invalidInput(`collections.${key} must have exactly ${spec.fixedLength} entries.`);
        rec[key] = entries.map((e, i) => this.normalizeEntry(spec, e, `collections.${key}[${i}]`, undefined));
        changes.push(`${key}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
      }
    }
    if (input.noteTags) {
      let note = String(rec.note ?? "");
      for (const [tag, value] of Object.entries(input.noteTags)) note = setNoteTag(note, tag, value);
      rec.note = note;
      changes.push(`note tags: ${Object.keys(input.noteTags).join(", ")}`);
    }
    this.placeRecord(ws, def, id, rec);
    const label = `${def.label} ${id} [${input.name}]`;
    ws.operations.push(`Created ${label}`);
    ws.semanticDiff.push(`+++ ${label} (new, ID ${id})`, ...changes.map((c) => `  ${c}`));
    return id;
  }

  duplicateRecord(ws: Workspace, category: string, sourceId: number, opts: { name?: string; id?: number; overwriteBlank?: boolean }): number {
    const def = this.def(category);
    if (def.singleton || def.category === "map_info") throw new McpError("UNSUPPORTED", `${def.label} cannot be duplicated.`);
    const src = this.wsRecord(ws, def, sourceId);
    const id = this.allocate(ws, def, opts.id, opts.overwriteBlank === true);
    // Deep clone: no shared mutable nested objects. References (class, skills, states...) are copied as IDs, not duplicated.
    const copy = structuredClone(src);
    copy.id = id;
    copy.name = opts.name ?? `${String(src.name)} (copy)`;
    this.placeRecord(ws, def, id, copy);
    const label = `${def.label} ${id} [${String(copy.name)}]`;
    ws.operations.push(`Duplicated ${def.label} ${sourceId} → ${label}`);
    ws.semanticDiff.push(`+++ ${label} (copy of ${sourceId}; referenced records are shared, not duplicated)`);
    return id;
  }

  deleteRecord(ws: Workspace, category: string, id: number, mode: "clear" | "truncate_last"): string {
    const def = this.def(category);
    if (def.singleton || def.category === "map_info") throw new McpError("UNSUPPORTED", `${def.label} records cannot be deleted here.`);
    const arr = this.wsArray(ws, def);
    const rec = this.wsRecord(ws, def, id);
    const kind = CATEGORY_REF_KIND[def.category];
    const refs = kind ? ReferenceIndex.build(projectView(this.project)).find(kind, id) : [];
    if (mode === "truncate_last") {
      if (id !== arr.length - 1) throw invalidInput(`truncate_last only removes the highest ID (${arr.length - 1}); use mode "clear" for other records. IDs are never renumbered.`);
      arr.pop();
    } else {
      arr[id] = this.blankRecord(ws, def, id);
    }
    ws.destructive = true;
    const label = `${def.label} ${id} [${String(rec.name)}]`;
    const s = `${mode === "clear" ? "Cleared (blanked)" : "Removed last record"} ${label}`;
    ws.operations.push(s);
    ws.semanticDiff.push(`--- ${s}`);
    if (refs.length) {
      ws.semanticDiff.push(`  ${refs.length} known reference(s) to this record:`, ...refs.slice(0, 30).map((r) => `    ${r.source.label} (${r.confidence} confidence)`));
      ws.diagnostics.warning("db.delete.referenced", `${label} is referenced ${refs.length} time(s); those references will point to a blank or missing record.`, label, {
        references: refs.slice(0, 50).map((r) => r.source.label),
      });
    }
    return s;
  }

  // ---------------------------------------------------------------- collections

  private normalizeEntry(spec: CollectionSpec, input: unknown, path: string, existing: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidInput(`${path}: expected an object.`);
    const o = input as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !spec.entry.some((f) => f.key === k));
    if (unknown.length) throw invalidInput(`${path}: unknown field(s) ${unknown.join(", ")}. Fields: ${spec.entry.map((f) => f.key).join(", ")}.`);
    // Start from the existing entry (update keeps key order and unknown keys) or defaults in native key order.
    const base: Record<string, unknown> = existing ? structuredClone(existing) : {};
    if (!existing) for (const f of nativeKeyOrder(spec)) base[f] = spec.defaults[f];
    const codeVal = o.code !== undefined ? coerceEntryField(spec.entry.find((f) => f.key === "code")!, o.code, `${path}.code`) : base.code;
    for (const f of spec.entry) {
      if (o[f.key] === undefined) continue;
      if (f.key === "dataId" && (spec.key === "traits" || spec.key === "effects")) {
        base.dataId = coerceDataId(spec.key, codeVal as number, o.dataId, `${path}.dataId`, this.names());
        continue;
      }
      base[f.key] = f.key === "code" ? codeVal : coerceEntryField(f, o[f.key], `${path}.${f.key}`);
    }
    for (const f of spec.entry) {
      if (base[f.key] === undefined) throw invalidInput(`${path}.${f.key} is required.`);
    }
    return base;
  }

  editCollection(
    ws: Workspace,
    category: string,
    id: number,
    key: string,
    ops: unknown[],
    expectedRevision: string | undefined,
  ): string {
    const def = this.def(category);
    const spec = def.collections.find((c) => c.key === key);
    if (!spec) throw invalidInput(`${def.label} has no collection "${key}" (${def.collections.map((c) => c.key).join(", ") || "none"}).`);
    const rec = this.wsRecord(ws, def, id);
    let arr = rec[key];
    if (!Array.isArray(arr)) throw new McpError("MALFORMED_DATA", `${def.label} ${id}.${key} is not an array.`);
    // Stale detection against the collection as read by the agent.
    const baseSnap = ws.baseSnapshot(this.filePath(def));
    const baseRec = def.singleton ? baseSnap?.data : (baseSnap?.data as unknown[] | undefined)?.[id];
    const baseArr = (baseRec as Record<string, unknown> | undefined)?.[key];
    const needsRevision = ops.some((o) => (o as { op?: string })?.op !== "add");
    if (needsRevision || expectedRevision !== undefined) {
      if (expectedRevision === undefined) throw invalidInput(`expectedRevision is required for update/move/remove (read it from database_get_record collections.${key}.revision).`);
      const rev = collectionRevision(baseArr);
      if (rev !== expectedRevision) {
        throw new McpError("STALE_REVISION", `${def.label} ${id}.${key} changed since revision ${expectedRevision} (now ${rev}). Re-read the record before editing.`);
      }
    }
    const n = this.names();
    const before = arr.map((e) => entryLabel(spec, e as Record<string, unknown>, n));
    arr = [...arr];
    const summaries: string[] = [];
    ops.forEach((raw, i) => {
      const p = `ops[${i}]`;
      if (!raw || typeof raw !== "object") throw invalidInput(`${p}: expected an object.`);
      const op = raw as { op?: string; index?: number; from?: number; to?: number; entry?: unknown; fingerprint?: string };
      const list = arr as unknown[];
      const checkIndex = (idx: unknown, label: string, max = list.length - 1) => {
        if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > max) throw invalidInput(`${p}.${label} must be 0..${max}.`);
        return idx;
      };
      const checkFp = (idx: number) => {
        if (op.fingerprint !== undefined && entryFingerprint(list[idx]) !== op.fingerprint) {
          throw new McpError("STALE_REVISION", `${p}: entry ${idx} fingerprint mismatch (expected ${op.fingerprint}, found ${entryFingerprint(list[idx])}).`);
        }
      };
      switch (op.op) {
        case "add": {
          if (spec.fixedLength !== undefined) throw invalidInput(`${p}: ${key} has a fixed length of ${spec.fixedLength}; use "update".`);
          const entry = this.normalizeEntry(spec, op.entry, `${p}.entry`, undefined);
          const at = op.index === undefined ? list.length : checkIndex(op.index, "index", list.length);
          list.splice(at, 0, entry);
          summaries.push(`add at ${at}: ${entryLabel(spec, entry, n)}`);
          break;
        }
        case "update": {
          const idx = checkIndex(op.index, "index");
          checkFp(idx);
          const entry = this.normalizeEntry(spec, op.entry, `${p}.entry`, list[idx] as Record<string, unknown>);
          list[idx] = entry;
          summaries.push(`update ${idx}: ${entryLabel(spec, entry, n)}`);
          break;
        }
        case "remove": {
          if (spec.fixedLength !== undefined) throw invalidInput(`${p}: ${key} has a fixed length of ${spec.fixedLength}; set kind to 0 (none) with "update" instead.`);
          const idx = checkIndex(op.index, "index");
          checkFp(idx);
          const [removed] = list.splice(idx, 1);
          summaries.push(`remove ${idx}: ${entryLabel(spec, removed as Record<string, unknown>, n)}`);
          break;
        }
        case "move": {
          const from = checkIndex(op.from, "from");
          const to = checkIndex(op.to, "to");
          const [moved] = list.splice(from, 1);
          list.splice(to, 0, moved);
          summaries.push(`move ${from} → ${to}`);
          break;
        }
        default:
          throw invalidInput(`${p}.op must be add, update, remove or move.`);
      }
    });
    rec[key] = arr;
    const label = `${def.label} ${id} [${String(rec.name ?? "")}].${key}`;
    const after = (arr as Record<string, unknown>[]).map((e) => entryLabel(spec, e, n));
    ws.operations.push(`${label}: ${summaries.join("; ")}`);
    ws.semanticDiff.push(`--- ${label}`, ...before.map((l) => `- ${l}`), `+++`, ...after.map((l) => `+ ${l}`));
    return `${label}: ${summaries.join("; ")}`;
  }

  setClassCurve(ws: Workspace, classId: number, param: unknown, curve: { level1: number; level99: number; shape?: "linear" | "ease_in" | "ease_out" } | { values: number[] }): string {
    const def = this.def("class");
    const rec = this.wsRecord(ws, def, classId);
    const pid = ParamId.parse(param, "param");
    const params = rec.params as number[][];
    if (!Array.isArray(params) || !Array.isArray(params[pid])) throw new McpError("MALFORMED_DATA", `Class ${classId} params[${pid}] is missing.`);
    const old = params[pid]!;
    let next: number[];
    if ("values" in curve) {
      if (!Array.isArray(curve.values) || curve.values.length !== old.length || !curve.values.every((v) => Number.isInteger(v) && v >= 0)) {
        throw invalidInput(`values must be ${old.length} non-negative integers (index = level).`);
      }
      next = [...curve.values];
    } else {
      const { level1, level99 } = curve;
      if (!Number.isInteger(level1) || !Number.isInteger(level99) || level1 < 0 || level99 < 0) throw invalidInput("level1 and level99 must be non-negative integers.");
      next = old.map((v, lv) => {
        if (lv === 0) return v; // index 0 is not a level; keep the native value
        const t = (lv - 1) / 98;
        const s = curve.shape === "ease_in" ? t * t : curve.shape === "ease_out" ? 1 - (1 - t) * (1 - t) : t;
        return Math.round(level1 + (level99 - level1) * s);
      });
    }
    params[pid] = next;
    const s = `Class ${classId} [${String(rec.name)}] ${ParamId.label(pid)} curve: L1 ${old[1]}→${next[1]}, L50 ${old[50]}→${next[50]}, L99 ${old[99]}→${next[99]}`;
    ws.operations.push(s);
    ws.semanticDiff.push(s);
    return s;
  }

  // ================================================================ validation

  validateCategory(category: string, ids?: number[], view?: DataView): Diagnostic[] {
    const def = this.def(category);
    const v = view ?? projectView(this.project);
    const checker = ReferenceChecker.forProject(this.project, v);
    const data = v.json(this.filePath(def));
    if (data === undefined) return [{ severity: "info", code: "db.file.missing", message: `data/${def.file} is not present.` }];
    if (def.singleton) return validateRecord(def, data as Record<string, unknown>, def.label, checker);
    if (!Array.isArray(data)) return [{ severity: "error", code: "db.file.malformed", message: `data/${def.file} is not an array.` }];
    const bag = new DiagnosticBag();
    if (data[0] !== null) bag.warning("db.index0", `data/${def.file}[0] is not null (the engine expects index 0 to be unused).`);
    const names = new Map<string, number[]>();
    const targets = ids ?? data.map((_r, i) => i).filter((i) => i > 0);
    for (const i of targets) {
      const r = data[i];
      if (r === undefined) {
        bag.error("db.record.missing", `${def.label} ${i} does not exist.`);
        continue;
      }
      if (r === null) {
        bag.warning("db.record.null", `${def.label} ${i} is a null slot; the editor normally stores a blank record.`, `${def.label} ${i}`);
        continue;
      }
      if (typeof r !== "object") {
        bag.error("db.record.malformed", `${def.label} ${i} is not an object.`, `${def.label} ${i}`);
        continue;
      }
      const rec = r as Record<string, unknown>;
      if (rec.id !== i) bag.error("db.record.id_mismatch", `${def.label} at index ${i} has id ${String(rec.id)}; IDs must equal their array index.`, `${def.label} ${i}`);
      bag.merge(validateRecord(def, rec, `${def.label} ${i} [${String(rec.name ?? "")}]`, checker));
      if (typeof rec.name === "string" && rec.name !== "") {
        const arr = names.get(rec.name) ?? [];
        arr.push(i);
        names.set(rec.name, arr);
      }
    }
    if (!ids) {
      for (const [nm, list] of names) {
        if (list.length > 1) bag.heuristic("info", "db.design.duplicate_name", `${list.length} ${def.label.toLowerCase()} share the name "${nm}": IDs ${list.join(", ")}.`, def.label);
      }
    }
    return bag.items;
  }
}

// ---------------------------------------------------------------- helpers

function linearCurve(l1: number, l99: number): number[] {
  return Array.from({ length: 100 }, (_v, lv) => (lv === 0 ? 0 : Math.round(l1 + ((l99 - l1) * (lv - 1)) / 98)));
}

function isPrimitiveSameType(a: unknown, b: unknown): boolean {
  return (typeof a === "string" || typeof a === "number" || typeof a === "boolean") && typeof a === typeof b;
}

/** Flatten {damage: {formula}} into {"damage.formula"} when the dotted path is a known field. */
function flattenPatch(def: CategoryDef, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && def.fields.some((f) => f.path.startsWith(`${k}.`)) && !def.fields.some((f) => f.path === k)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out[`${k}.${k2}`] = v2;
    } else out[k] = v;
  }
  return out;
}

export function coerceField(spec: FieldSpec, value: unknown, path: string): unknown {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") throw invalidInput(`${path}: string required.`);
      return value;
    case "bool":
      if (typeof value !== "boolean") throw invalidInput(`${path}: boolean required.`);
      return value;
    case "int":
    case "number": {
      let v = value;
      if (spec.enum) v = spec.enum.parse(value, path);
      if (typeof v !== "number" || !Number.isFinite(v) || (spec.type === "int" && !Number.isInteger(v))) throw invalidInput(`${path}: ${spec.type === "int" ? "integer" : "number"} required.`);
      if (spec.special && v in spec.special) return v;
      if (spec.min !== undefined && v < spec.min) throw invalidInput(`${path}: must be >= ${spec.min}.`);
      if (spec.max !== undefined && v > spec.max) throw invalidInput(`${path}: must be <= ${spec.max}.`);
      return v;
    }
    case "intArray":
      if (!Array.isArray(value) || !value.every((x) => Number.isInteger(x))) throw invalidInput(`${path}: array of integers required.`);
      if (spec.length !== undefined && value.length !== spec.length) throw invalidInput(`${path}: exactly ${spec.length} values required.`);
      return [...value];
    case "stringArray":
      if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) throw invalidInput(`${path}: array of strings required.`);
      if (spec.length !== undefined && value.length !== spec.length) throw invalidInput(`${path}: exactly ${spec.length} values required.`);
      return [...value];
    case "audio": {
      if (!value || typeof value !== "object") throw invalidInput(`${path}: {name, volume, pitch, pan} required.`);
      const a = value as Record<string, unknown>;
      if (typeof a.name !== "string") throw invalidInput(`${path}.name: string required.`);
      const num = (k: string, d: number, min: number, max: number) => {
        const x = a[k] ?? d;
        if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) throw invalidInput(`${path}.${k}: integer ${min}..${max} required.`);
        return x;
      };
      return { name: a.name, pan: num("pan", 0, -100, 100), pitch: num("pitch", 100, 50, 150), volume: num("volume", 90, 0, 100) };
    }
    case "json":
      return structuredClone(value);
  }
}

function coerceEntryField(f: CollectionEntryField, value: unknown, path: string): unknown {
  if (f.type === "json") return structuredClone(value);
  if (f.type === "string") {
    if (typeof value !== "string") throw invalidInput(`${path}: string required.`);
    return value;
  }
  if (f.type === "bool") {
    if (typeof value !== "boolean") throw invalidInput(`${path}: boolean required.`);
    return value;
  }
  let v = value;
  if (f.enum) v = f.enum.parse(value, path);
  if (typeof v !== "number" || !Number.isFinite(v) || (f.type === "int" && !Number.isInteger(v))) throw invalidInput(`${path}: ${f.type === "int" ? "integer" : "number"} required.`);
  if (f.min !== undefined && v < f.min) throw invalidInput(`${path}: must be >= ${f.min}.`);
  if (f.max !== undefined && v > f.max) throw invalidInput(`${path}: must be <= ${f.max}.`);
  return v;
}

/** dataId for traits/effects: accepts numbers, enum labels (params, flags...), or exact record/list names. */
function coerceDataId(collection: string, code: number, value: unknown, path: string, n: NameResolver): number {
  const kind = collection === "traits" ? traitDef(code)?.dataId : effectDef(code)?.dataId;
  if (kind === undefined) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    throw invalidInput(`${path}: integer required.`);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  const en: MzEnum | undefined = DATA_ID_ENUMS[kind];
  if (en) return en.parse(value, path);
  const rk = dataIdRefKind(kind);
  if (rk && typeof value === "string") {
    const matches: number[] = [];
    for (let i = 1; i < 10000; i++) {
      const nm = n.name(rk, i);
      if (nm === undefined && i > 2000) break;
      if (nm && nm.toLowerCase() === value.toLowerCase()) matches.push(i);
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw invalidInput(`${path}: "${value}" is ambiguous (${rk} IDs ${matches.join(", ")}); pass the numeric ID.`);
    throw invalidInput(`${path}: no ${rk} named "${value}"; pass the numeric ID.`);
  }
  if (kind === "none") return 0;
  throw invalidInput(`${path}: non-negative integer required.`);
}

function nativeKeyOrder(spec: CollectionSpec): string[] {
  const orders: Record<string, string[]> = {
    traits: ["code", "dataId", "value"],
    effects: ["code", "dataId", "value1", "value2"],
    learnings: ["level", "note", "skillId"],
    actions: ["conditionParam1", "conditionParam2", "conditionType", "rating", "skillId"],
    dropItems: ["dataId", "denominator", "kind"],
    members: ["enemyId", "x", "y", "hidden"],
    flashTimings: ["frame", "duration", "color"],
    soundTimings: ["frame", "se"],
  };
  return orders[spec.key] ?? spec.entry.map((f) => f.key);
}

function entryLabel(spec: CollectionSpec, e: Record<string, unknown>, n: NameResolver): string {
  if (spec.key === "traits") return describeTrait(e as never, n);
  if (spec.key === "effects") return describeEffect(e as never, n);
  return JSON.stringify(e);
}

/** Record-level validation: field types/enums/ranges, collections and references. */
export function validateRecord(def: CategoryDef, rec: Record<string, unknown>, label: string, checker: ReferenceChecker): Diagnostic[] {
  const bag = new DiagnosticBag();
  for (const spec of def.fields) {
    const v = getPath(rec, spec.path);
    if (v === undefined) {
      if (spec.path === "releaseByDamage") continue; // optional in older data
      if (def.category !== "system" && def.category !== "map_info") bag.warning("db.field.missing", `${spec.path} is missing.`, label);
      continue;
    }
    try {
      coerceField(spec, v, spec.path);
    } catch (err) {
      bag.error("db.field.invalid", (err as Error).message, label);
    }
  }
  for (const c of def.collections) {
    const arr = rec[c.key];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      bag.error("db.collection.invalid", `${c.key} must be an array.`, label);
      continue;
    }
    if (c.fixedLength !== undefined && arr.length !== c.fixedLength) bag.warning("db.collection.length", `${c.key} has ${arr.length} entries; the editor expects ${c.fixedLength}.`, label);
    arr.forEach((e, i) => {
      if (!e || typeof e !== "object") {
        bag.error("db.collection.entry", `${c.key}[${i}] is not an object.`, label);
        return;
      }
      const entry = e as Record<string, unknown>;
      for (const f of c.entry) {
        if (entry[f.key] === undefined) {
          bag.error("db.collection.entry", `${c.key}[${i}].${f.key} is missing.`, label);
          continue;
        }
        try {
          coerceEntryField(f, entry[f.key], `${c.key}[${i}].${f.key}`);
        } catch (err) {
          bag.error("db.collection.entry", (err as Error).message, label);
        }
      }
      if (c.key === "traits" || c.key === "effects") {
        const d = c.key === "traits" ? traitDef(entry.code as number)?.dataId : effectDef(entry.code as number)?.dataId;
        const en = d ? DATA_ID_ENUMS[d] : undefined;
        if (en && !en.has(entry.dataId)) bag.error("db.collection.dataId", `${c.key}[${i}].dataId ${String(entry.dataId)} is not a valid ${en.name} (${en.options()}).`, label);
      }
    });
  }
  // Design diagnostics (advisory).
  if (def.category === "skill" || def.category === "item") {
    const dmg = rec.damage as { type?: number; formula?: string } | undefined;
    if (dmg && dmg.type !== 0 && (dmg.formula ?? "").trim() === "0") bag.heuristic("warning", "db.design.zero_formula", "Damage type is set but the formula is \"0\".", label);
    if (dmg && dmg.type !== 0 && (dmg.formula ?? "").trim() === "") bag.error("db.formula.empty", "Damage formula is empty.", label);
  }
  if (def.category === "skill" && typeof rec.mpCost === "number" && rec.mpCost > 999) bag.heuristic("info", "db.design.high_cost", `MP cost ${rec.mpCost} is unusually high.`, label);
  if ((def.category === "weapon" || def.category === "armor" || def.category === "item") && typeof rec.price === "number" && rec.price > 9_999_999) bag.heuristic("warning", "db.design.price", `Price ${rec.price} is unusually high.`, label);
  if (def.category === "enemy" && Array.isArray(rec.actions) && rec.actions.length === 0) bag.heuristic("warning", "db.design.no_actions", "Enemy has no action patterns (it will do nothing).", label);
  if (def.category === "enemy" && Array.isArray(rec.dropItems)) {
    (rec.dropItems as { kind?: number; dataId?: number }[]).forEach((d, i) => {
      if (d && d.kind !== 0 && (typeof d.dataId !== "number" || d.dataId < 1)) bag.error("db.enemy.drop", `dropItems[${i}] has kind ${String(d.kind)} but no item ID.`, label);
    });
  }
  if (def.category === "actor" && typeof rec.initialLevel === "number" && typeof rec.maxLevel === "number" && rec.initialLevel > rec.maxLevel) bag.error("db.actor.levels", "initialLevel exceeds maxLevel.", label);
  if (def.category === "state" && typeof rec.minTurns === "number" && typeof rec.maxTurns === "number" && rec.minTurns > rec.maxTurns) bag.warning("db.state.turns", "minTurns exceeds maxTurns.", label);

  for (const ref of recordRefs(def.category, rec)) reportRef(bag, checker, ref, {}, `${label} / ${ref.via ?? ""}`);
  return bag.items;
}

export { CATEGORIES, type DatabaseCategory };

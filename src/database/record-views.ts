import {
  CollapseType,
  EFFECTS,
  MzEnum,
  ParamId,
  PartyAbility,
  SParamId,
  SlotType,
  SpecialFlag,
  XParamId,
  effectDef,
  traitDef,
  type DataIdKind,
} from "../adapters/rpg-maker-mz/enum-catalog.js";
import { hashBytes } from "../project/file-manager.js";
import type { NameResolver, RefKind } from "../references/ref-types.js";
import { dataIdRefKind, type CategoryDef, type CollectionSpec, type FieldSpec } from "./database-catalog.js";
import { parseNoteTags } from "./note-tags.js";

/**
 * Normalized (agent-facing) views of native database records
 * (DATABASE_SPEC §4.2/§4.3). Enum values are shown as {value, label};
 * references carry the resolved name. The native record stays the source of
 * truth and is included in detailed mode.
 */

export function getPath(o: Record<string, unknown>, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function setPath(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (next === null || typeof next !== "object") {
      throw new Error(`Cannot set ${path}: ${k} is not an object in the native record.`);
    }
    cur = next as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

export function collectionRevision(arr: unknown): string {
  return hashBytes(JSON.stringify(arr ?? null));
}

export function entryFingerprint(entry: unknown): string {
  return hashBytes(JSON.stringify(entry)).slice(0, 8);
}

export const DATA_ID_ENUMS: Partial<Record<DataIdKind, MzEnum>> = {
  param: ParamId,
  xparam: XParamId,
  sparam: SParamId,
  specialFlag: SpecialFlag,
  collapseType: CollapseType,
  partyAbility: PartyAbility,
  slotType: SlotType,
};

function fieldValueView(spec: FieldSpec, v: unknown, n: NameResolver): unknown {
  if (spec.enum) return spec.enum.symbolic(v);
  if (spec.ref && typeof v === "number") {
    if (spec.special && v in spec.special) return { value: v, label: spec.special[v] };
    return { value: v, name: n.name(spec.ref, v) ?? "" };
  }
  return v;
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

function dataIdLabel(kind: DataIdKind, id: number, n: NameResolver): string {
  const en = DATA_ID_ENUMS[kind];
  if (en) return en.label(id);
  const rk = dataIdRefKind(kind);
  if (rk) {
    const nm = n.name(rk, id);
    return `${rk} ${id}${nm ? ` [${nm}]` : ""}`;
  }
  return String(id);
}

export function describeTrait(t: { code: number; dataId: number; value: number }, n: NameResolver): string {
  const d = traitDef(t.code);
  if (!d) return `Unknown trait ${t.code} (dataId ${t.dataId}, value ${t.value})`;
  const target = d.dataId === "none" ? "" : ` ${dataIdLabel(d.dataId, t.dataId, n)}`;
  switch (d.value) {
    case "rate":
      return `${d.label}:${target} × ${pct(t.value)}`;
    case "add":
      return `${d.label}:${target} ${t.value >= 0 ? "+" : ""}${pct(t.value)}`;
    case "chance":
      return `${d.label}:${target} ${pct(t.value)}`;
    case "number":
      return `${d.label}: ${t.value >= 0 ? "+" : ""}${t.value}`;
    default:
      return `${d.label}:${target}`;
  }
}

export function describeEffect(e: { code: number; dataId: number; value1: number; value2: number }, n: NameResolver): string {
  const d = effectDef(e.code);
  if (!d) return `Unknown effect ${e.code} (dataId ${e.dataId}, ${e.value1}, ${e.value2})`;
  switch (e.code) {
    case 11:
    case 12:
      return `${d.label}: ${pct(e.value1)} + ${e.value2}`;
    case 13:
      return `${d.label}: ${e.value1}`;
    case 21:
    case 22:
      return `${d.label}: ${e.dataId === 0 && e.code === 21 ? "Normal Attack" : dataIdLabel("state", e.dataId, n)} ${pct(e.value1)}`;
    case 31:
    case 32:
      return `${d.label}: ${ParamId.label(e.dataId)} ${e.value1} turn(s)`;
    case 33:
    case 34:
      return `${d.label}: ${ParamId.label(e.dataId)}`;
    case 41:
      return `${d.label}: Escape`;
    case 42:
      return `${d.label}: ${ParamId.label(e.dataId)} +${e.value1}`;
    case 43:
      return `${d.label}: ${dataIdLabel("skill", e.dataId, n)}`;
    case 44:
      return `${d.label}: ${dataIdLabel("commonEvent", e.dataId, n)}`;
  }
  return d.label;
}

function collectionEntryView(spec: CollectionSpec, entry: Record<string, unknown>, index: number, n: NameResolver): Record<string, unknown> {
  const out: Record<string, unknown> = { index, fingerprint: entryFingerprint(entry) };
  for (const f of spec.entry) {
    const v = entry[f.key];
    if (f.enum) out[f.key] = f.enum.symbolic(v);
    else if (f.ref && typeof v === "number") out[f.key] = { value: v, name: n.name(f.ref, v) ?? "" };
    else out[f.key] = v;
  }
  if (spec.key === "traits") out.description = describeTrait(entry as never, n);
  if (spec.key === "effects") out.description = describeEffect(entry as never, n);
  if (spec.key === "dropItems") {
    const kinds: Record<number, RefKind> = { 1: "item", 2: "weapon", 3: "armor" };
    const k = kinds[entry.kind as number];
    out.description = k ? `${k} ${entry.dataId}${n.name(k, entry.dataId as number) ? ` [${n.name(k, entry.dataId as number)}]` : ""} (1/${entry.denominator})` : "(none)";
  }
  // Preserve unmodeled entry keys in the view.
  for (const k of Object.keys(entry)) if (!(k in out)) out[k] = entry[k];
  return out;
}

export function recordView(def: CategoryDef, rec: Record<string, unknown>, n: NameResolver, detailed: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!def.singleton) {
    out.id = rec.id;
    out.name = rec.name;
  }
  const fields: Record<string, unknown> = {};
  for (const spec of def.fields) {
    const v = getPath(rec, spec.path);
    if (v === undefined) continue;
    fields[spec.path] = fieldValueView(spec, v, n);
  }
  out.fields = fields;
  const collections: Record<string, unknown> = {};
  for (const c of def.collections) {
    const arr = rec[c.key];
    if (!Array.isArray(arr)) continue;
    collections[c.key] = {
      revision: collectionRevision(arr),
      entries: arr.map((e, i) => (e && typeof e === "object" ? collectionEntryView(c, e as Record<string, unknown>, i, n) : { index: i, native: e })),
    };
  }
  if (Object.keys(collections).length) out.collections = collections;
  if (typeof rec.note === "string") {
    const tags = parseNoteTags(rec.note);
    if (tags.length) out.noteTags = tags.map((t) => ({ name: t.name, value: t.value }));
  }
  const known = new Set(["id", ...def.fields.map((f) => f.path.split(".")[0]!), ...def.collections.map((c) => c.key)]);
  const unmodeled = Object.keys(rec).filter((k) => !known.has(k));
  if (unmodeled.length) out.unmodeledFields = unmodeled;
  Object.assign(out, categoryExtras(def, rec, n));
  if (detailed) out.native = rec;
  return out;
}

function categoryExtras(def: CategoryDef, rec: Record<string, unknown>, n: NameResolver): Record<string, unknown> {
  if (def.category === "class" && Array.isArray(rec.params)) {
    const levels = [1, 10, 25, 50, 75, 99];
    return {
      parameterCurves: (rec.params as number[][]).map((curve, i) => ({
        param: ParamId.label(i),
        ...Object.fromEntries(levels.map((l) => [`L${l}`, Array.isArray(curve) ? curve[l] : undefined])),
      })),
      parameterCurvesNote: "params[paramId][level] (index 0 unused by the engine). Use database_set_class_curve to regenerate a curve instead of editing 100 numbers.",
    };
  }
  if (def.category === "actor" && Array.isArray(rec.equips)) {
    const traits = Array.isArray(rec.traits) ? (rec.traits as { code: number; dataId: number }[]) : [];
    const dual = traits.some((t) => t.code === 55 && t.dataId === 1);
    return {
      equipment: (rec.equips as number[]).map((id, slot) => {
        const kind: RefKind = slot === 0 || (slot === 1 && dual) ? "weapon" : "armor";
        return { slot, slotType: n.name("equip_type", slot + 1) ?? `slot ${slot}`, kind, id, name: id ? (n.name(kind, id) ?? "") : "(none)" };
      }),
    };
  }
  return {};
}

export interface SummaryFieldDef {
  [category: string]: string[];
}

const SUMMARY_FIELDS: Record<string, string[]> = {
  actor: ["classId", "initialLevel"],
  class: [],
  skill: ["stypeId", "mpCost", "tpCost", "scope", "damage.type"],
  item: ["itypeId", "price", "scope", "consumable"],
  weapon: ["wtypeId", "price", "params"],
  armor: ["atypeId", "etypeId", "price", "params"],
  enemy: ["params", "exp", "gold"],
  troop: [],
  state: ["restriction", "priority", "autoRemovalTiming"],
  animation: ["effectName"],
  tileset: ["mode"],
  common_event: ["trigger"],
  map_info: ["parentId", "order"],
};

export function recordSummary(def: CategoryDef, rec: Record<string, unknown>, n: NameResolver): Record<string, unknown> {
  const out: Record<string, unknown> = { id: rec.id, name: rec.name };
  for (const path of SUMMARY_FIELDS[def.category] ?? []) {
    const spec = def.fields.find((f) => f.path === path);
    const v = getPath(rec, path);
    if (v === undefined) continue;
    if (spec?.enum) out[path] = spec.enum.label(v);
    else if (spec?.ref && typeof v === "number") out[path] = spec.special?.[v] ?? `${v}${n.name(spec.ref, v) ? ` [${n.name(spec.ref, v)}]` : ""}`;
    else out[path] = v;
  }
  if (def.category === "troop" && Array.isArray(rec.members)) out.members = (rec.members as { enemyId: number }[]).map((m) => `${m.enemyId}${n.name("enemy", m.enemyId) ? ` [${n.name("enemy", m.enemyId)}]` : ""}`);
  if (def.category === "class" && Array.isArray(rec.learnings)) out.learnings = (rec.learnings as unknown[]).length;
  return out;
}

export { EFFECTS };

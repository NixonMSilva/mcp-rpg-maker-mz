import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNoteTags, removeNoteTag, setNoteTag } from "../../src/database/note-tags.js";
import { expandTemplate } from "../../src/database/templates.js";
import { McpError } from "../../src/project/errors.js";
import { readJson, readText, session } from "../helpers/fixture.js";

type Rec = Record<string, unknown> & { id: number; name: string };
const items = (root: string) => readJson(root, "data/Items.json") as (Rec | null)[];

describe("database read model", () => {
  it("loads every available category with counts", () => {
    const s = session();
    const cats = s.db.listCategories();
    const byName = Object.fromEntries(cats.map((c) => [c.category, c]));
    for (const c of ["actor", "class", "skill", "item", "weapon", "armor", "enemy", "troop", "state", "animation", "common_event", "system", "map_info", "tileset"]) {
      expect(byName[c]!.available, c).toBe(true);
    }
    expect(byName.skill!.maxId).toBe(12);
  });

  it("returns normalized records with enum labels, reference names, collection revisions and note tags", () => {
    const s = session();
    const skill = s.db.getRecord("skill", 1, false);
    expect((skill.fields as Record<string, unknown>).scope).toEqual({ value: 1, label: "1 Enemy" });
    const effects = (skill.collections as Record<string, { revision: string; entries: { description: string; fingerprint: string }[] }>).effects!;
    expect(effects.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(effects.entries[0]!.description).toContain("Add State");
    const cls = s.db.getRecord("class", 1, false);
    expect(cls.parameterCurves).toHaveLength(8);
    const actor = s.db.getRecord("actor", 1, true);
    expect((actor.equipment as { kind: string }[])[0]!.kind).toBe("weapon");
    expect(actor.native).toBeDefined();
  });

  it("searches and resolves references by name (exact, partial, ambiguous)", () => {
    const s = session();
    const r = s.db.resolveReference("item", { name: "potion" });
    expect(r.status).toBe("resolved");
    expect(r.id).toBe(7);
    const partial = s.db.resolveReference("item", { name: "pot" });
    expect(["candidates", "resolved", "ambiguous"]).toContain(partial.status);
    expect(s.db.resolveReference("item", { id: 9999 }).status).toBe("invalid");
    const found = s.db.search({ text: "potion", categories: ["item"] });
    expect(found.count).toBeGreaterThan(0);
  });

  it("finds references from events and other records", () => {
    const s = session();
    const refs = s.db.findReferences("item", 7);
    const labels = (refs.references as { location: string }[]).map((r) => r.location).join("\n");
    expect(labels).toContain("Event 7 [Chest]");
    expect(labels).toContain("Event 2 [Guard]");
    const sw = s.db.findRefsOfKind("switch", 2);
    // Page condition on the chest + inferred script reference ($gameSwitches.setValue(2, ...)).
    const refList = sw.references as { location: string; confidence: string }[];
    expect(refList.some((r) => r.location.includes("Chest"))).toBe(true);
    expect(refList.some((r) => r.confidence === "low")).toBe(true);
  });
});

describe("database authoring", () => {
  it("creates records with the next ID and preserves index-0 null and other records", () => {
    const s = session();
    const before = items(s.root);
    const ws = s.tx.workspace();
    const id = s.db.createRecord(ws, "item", { name: "Bronze Key", fields: { itypeId: "Key Item", consumable: false, price: 0, scope: "None", occasion: "Never" } });
    expect(id).toBe(before.length);
    const cs = s.tx.stage(ws, "create");
    expect(cs.diagnosticSummary.errors).toBe(0);
    s.tx.apply(cs.id, { acknowledgeWarnings: true });
    const after = items(s.root);
    expect(after[0]).toBeNull();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[id]).toMatchObject({ id, name: "Bronze Key", itypeId: 2, consumable: false, scope: 0, occasion: 3 });
    // Native key order of a blank editor record is kept.
    expect(Object.keys(after[id]!)[0]).toBe("id");
  });

  it("creates from templates and validates references in effects", () => {
    const s = session();
    const ws = s.tx.workspace();
    const t = expandTemplate("state_skill", { stateId: 999 });
    s.db.createRecord(ws, "skill", { name: "Doom", fields: t.fields, collections: t.collections });
    const cs = s.tx.stage(ws, "bad state");
    expect(cs.diagnostics.some((d) => d.code === "ref.state.invalid")).toBe(true);
  });

  it("patches selected fields only, accepting labels and nested paths", () => {
    const s = session();
    const raw = readText(s.root, "data/Skills.json").split("\n");
    const ws = s.tx.workspace();
    s.db.updateRecord(ws, "skill", 10, { mpCost: 12, scope: "All Enemies", damage: { formula: "a.mat * 3 - b.mdf" } });
    s.tx.apply(s.tx.stage(ws, "patch").id, { acknowledgeWarnings: true });
    const after = readText(s.root, "data/Skills.json").split("\n");
    expect(after.filter((l, i) => l !== raw[i])).toHaveLength(1); // only the record's line changed
    const rec = (readJson(s.root, "data/Skills.json") as Rec[])[10]!;
    expect(rec).toMatchObject({ mpCost: 12, scope: 2, damage: { formula: "a.mat * 3 - b.mdf" } });
  });

  it("rejects invalid enums, out-of-range values, collections in patches and unknown fields", () => {
    const s = session();
    const ws = s.tx.workspace();
    expect(() => s.db.updateRecord(ws, "skill", 10, { scope: "Everybody Everywhere" })).toThrow(/Invalid patch\.scope/);
    expect(() => s.db.updateRecord(ws, "skill", 10, { successRate: 150 })).toThrow(/<= 100/);
    expect(() => s.db.updateRecord(ws, "skill", 10, { effects: [] })).toThrow(/database_edit_collection/);
    expect(() => s.db.updateRecord(ws, "skill", 10, { bogus: 1 })).toThrow(/not a patchable/);
  });

  it("preserves unknown (plugin) fields while editing, and allows same-type updates to them", () => {
    const s = session();
    const file = path.join(s.root, "data", "Weapons.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Rec[];
    data[1]!.pluginData = { tier: 3 };
    data[1]!.customRank = "S";
    fs.writeFileSync(file, "[\n" + data.map((r) => JSON.stringify(r)).join(",\n") + "\n]");
    s.project.files.invalidate();
    const ws = s.tx.workspace();
    s.db.updateRecord(ws, "weapon", 1, { price: 999, customRank: "A" });
    s.tx.apply(s.tx.stage(ws, "patch").id, { acknowledgeWarnings: true });
    const w = (readJson(s.root, "data/Weapons.json") as Rec[])[1]!;
    expect(w).toMatchObject({ price: 999, pluginData: { tier: 3 }, customRank: "A" });
    expect(s.db.getRecord("weapon", 1, false).unmodeledFields).toEqual(["pluginData", "customRank"]);
  });

  it("duplicates records without sharing nested objects or duplicating references", () => {
    const s = session();
    const ws = s.tx.workspace();
    const id = s.db.duplicateRecord(ws, "enemy", 1, { name: "Goblin Chief" });
    const arr = ws.json<Rec[]>("data/Enemies.json");
    expect(arr[id]!.traits).toEqual(arr[1]!.traits);
    expect(arr[id]!.traits).not.toBe(arr[1]!.traits);
    (arr[id]!.traits as unknown[]).push({ code: 14, dataId: 4, value: 0 });
    expect((arr[1]!.traits as unknown[]).length).toBe((arr[id]!.traits as unknown[]).length - 1);
    expect(arr[id]!.actions).toEqual(arr[1]!.actions); // same skill IDs
  });

  it("edits traits and effects with labels, fingerprints and stale detection", () => {
    const s = session();
    const view = s.db.getRecord("armor", 1, false);
    const rev = (view.collections as Record<string, { revision: string; entries: { fingerprint: string }[] }>).traits!;
    const ws = s.tx.workspace();
    s.db.editCollection(ws, "armor", 1, "traits", [
      { op: "add", entry: { code: "State Resist", dataId: "Poison" } },
      { op: "add", entry: { code: "Ex-Parameter", dataId: "Evasion Rate", value: 0.1 } },
      { op: "update", index: 0, entry: { value: 0.05 }, fingerprint: rev.entries[0]!.fingerprint },
      { op: "move", from: 2, to: 0 },
    ], rev.revision);
    s.tx.apply(s.tx.stage(ws, "traits").id, { acknowledgeWarnings: true });
    const a = (readJson(s.root, "data/Armors.json") as Rec[])[1]!;
    expect(a.traits).toEqual([
      { code: 22, dataId: 1, value: 0.1 },
      { code: 22, dataId: 1, value: 0.05 },
      { code: 14, dataId: 4, value: 0 },
    ]);
    // Old revision is now stale.
    expect(() => s.db.editCollection(s.tx.workspace(), "armor", 1, "traits", [{ op: "remove", index: 0 }], rev.revision)).toThrow(/changed since revision/);
    expect(() => s.db.editCollection(s.tx.workspace(), "armor", 1, "traits", [{ op: "remove", index: 0 }], undefined)).toThrow(/expectedRevision is required/);

    const ws2 = s.tx.workspace();
    s.db.editCollection(ws2, "item", 7, "effects", [{ op: "add", entry: { code: "Remove State", dataId: "Poison", value1: 1 } }], undefined);
    expect(ws2.json<Rec[]>("data/Items.json")[7]!.effects).toContainEqual({ code: 22, dataId: 4, value1: 1, value2: 0 });
    expect(() => s.db.editCollection(s.tx.workspace(), "armor", 1, "traits", [{ op: "add", entry: { code: "Parameter", dataId: "Speed", value: 1 } }], undefined)).toThrow(/Invalid/);
  });

  it("edits enemy actions and fixed-length drops", () => {
    const s = session();
    const e = s.db.getRecord("enemy", 1, false);
    const cols = e.collections as Record<string, { revision: string }>;
    const ws = s.tx.workspace();
    s.db.editCollection(ws, "enemy", 1, "actions", [{ op: "add", entry: { skillId: 10, rating: 4, conditionType: "HP", conditionParam1: 0, conditionParam2: 0.5 } }], undefined);
    s.db.editCollection(ws, "enemy", 1, "dropItems", [{ op: "update", index: 0, entry: { kind: "Item", dataId: 7, denominator: 4 } }], cols.dropItems!.revision);
    expect(() => s.db.editCollection(s.tx.workspace(), "enemy", 1, "dropItems", [{ op: "add", entry: { kind: 1, dataId: 1, denominator: 1 } }], undefined)).toThrow(/fixed length/);
    s.tx.apply(s.tx.stage(ws, "enemy").id, { acknowledgeWarnings: true });
    const en = (readJson(s.root, "data/Enemies.json") as Rec[])[1]!;
    expect((en.actions as unknown[]).at(-1)).toEqual({ conditionParam1: 0, conditionParam2: 0.5, conditionType: 2, rating: 4, skillId: 10 });
    expect((en.dropItems as unknown[])[0]).toEqual({ dataId: 7, denominator: 4, kind: 1 });
  });

  it("accepts empty drop slots with dataId 0 but rejects real drops without an ID (seen in official sample data)", () => {
    const s = session();
    const file = path.join(s.root, "data", "Enemies.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Rec[];
    data[1]!.dropItems = [{ dataId: 0, denominator: 1, kind: 0 }, { dataId: 0, denominator: 1, kind: 1 }, { dataId: 1, denominator: 1, kind: 0 }];
    fs.writeFileSync(file, "[\n" + data.map((r) => JSON.stringify(r)).join(",\n") + "\n]");
    s.project.files.invalidate();
    const errors = s.db.validateCategory("enemy", [1]).filter((d) => d.severity === "error");
    expect(errors.map((d) => d.code)).toEqual(["db.enemy.drop"]);
    expect(errors[0]!.message).toContain("dropItems[1]");
  });

  it("edits troop members", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.db.editCollection(ws, "troop", 1, "members", [{ op: "add", entry: { enemyId: 2 } }], undefined);
    expect(ws.json<Rec[]>("data/Troops.json")[1]!.members).toContainEqual({ enemyId: 2, x: 408, y: 436, hidden: false });
  });

  it("reports references before deletion and blocks dangling references when truncating", () => {
    const s = session();
    const arr = items(s.root);
    // Clearing a referenced record: warning (references now point to a blank record).
    let ws = s.tx.workspace();
    s.db.deleteRecord(ws, "item", 7, "clear");
    let cs = s.tx.stage(ws, "clear");
    expect(cs.destructive).toBe(true);
    expect(cs.semanticDiff.join("\n")).toContain("known reference");
    expect(cs.diagnostics.some((d) => d.code === "ref.dangling" && d.severity === "warning")).toBe(true);
    // Truncating a non-last record is refused (IDs never renumber).
    expect(() => s.db.deleteRecord(s.tx.workspace(), "item", 1, "truncate_last")).toThrow(/highest ID/);
    // Truncating the last record works and keeps every other slot.
    ws = s.tx.workspace();
    s.db.deleteRecord(ws, "item", arr.length - 1, "truncate_last");
    cs = s.tx.stage(ws, "truncate");
    s.tx.apply(cs.id, { confirm: cs.id, acknowledgeWarnings: true });
    expect(items(s.root)).toEqual(arr.slice(0, -1));
  });

  it("edits note tags without disturbing other text", () => {
    expect(parseNoteTags("<Boss>\n<Cost: 5>\nfree text <Other:x>")).toEqual([
      { name: "Boss", value: true, index: 0, raw: "<Boss>" },
      { name: "Cost", value: " 5", index: 7, raw: "<Cost: 5>" },
      { name: "Other", value: "x", index: 27, raw: "<Other:x>" },
    ]);
    expect(setNoteTag("<Cost: 5>\nkeep me", "Cost", "9")).toBe("<Cost: 9>\nkeep me");
    expect(setNoteTag("<Cost:5>", "Cost", "9")).toBe("<Cost:9>");
    expect(setNoteTag("line", "New", true)).toBe("line\n<New>");
    expect(removeNoteTag("a\n<X: 1>\nb", "X")).toEqual({ note: "a\nb", removed: 1 });
    expect(removeNoteTag("a\n<X>", "X")).toEqual({ note: "a", removed: 1 });
    expect(removeNoteTag("pre <X> post", "X")).toEqual({ note: "pre  post", removed: 1 });

    const s = session();
    const ws = s.tx.workspace();
    s.db.setNote(ws, "item", 7, { op: "set_tag", tag: "Rarity", value: "common" });
    expect(ws.json<Rec[]>("data/Items.json")[7]!.note).toContain("<Rarity: common>");
  });

  it("updates system settings, switch names and terms through an allowlist", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.db.updateRecord(ws, "system", undefined, { gameTitle: "New Title", "switches.5": "Bridge Built", "terms.messages.levelUp": "%1 leveled up!" });
    expect(() => s.db.updateRecord(s.tx.workspace(), "system", undefined, { "switches.999": "x" })).toThrow(/out of range/);
    expect(() => s.db.updateRecord(s.tx.workspace(), "system", undefined, { versionId: 1 })).toThrow(McpError);
    s.tx.apply(s.tx.stage(ws, "system").id, { acknowledgeWarnings: true });
    const sys = readJson(s.root, "data/System.json") as Record<string, unknown>;
    expect(sys.gameTitle).toBe("New Title");
    expect((sys.switches as string[])[5]).toBe("Bridge Built");
  });

  it("validates categories and reports malformed records without crashing", () => {
    const s = session();
    const file = path.join(s.root, "data", "States.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
    data[3] = { id: 99, name: "Broken", restriction: "nope" };
    data[4] = 42;
    fs.writeFileSync(file, "[\n" + data.map((r) => JSON.stringify(r)).join(",\n") + "\n]");
    s.project.files.invalidate();
    const diags = s.db.validateCategory("state");
    const codes = diags.map((d) => d.code);
    expect(codes).toContain("db.record.id_mismatch");
    expect(codes).toContain("db.record.malformed");
    expect(codes).toContain("db.field.invalid");
  });

  it("lists free switches and variables (unnamed and unreferenced)", () => {
    const s = session();
    const free = s.db.listSwitchesOrVariables("switch", { onlyFree: true });
    const ids = (free.entries as { id: number }[]).map((e) => e.id);
    expect(ids).not.toContain(1); // named
    expect(ids).not.toContain(2); // named + referenced
    expect(ids.length).toBeGreaterThan(5);
  });
});

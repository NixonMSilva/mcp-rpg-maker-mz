import { describe, expect, it } from "vitest";
import type { NativeMap } from "../../src/adapters/rpg-maker-mz/native-types.js";
import { listRevision } from "../../src/eventing/block-service.js";
import { parseCommandList } from "../../src/eventing/ir/parser.js";
import type { EventBlock } from "../../src/eventing/ir/types.js";
import type { ListTarget } from "../../src/eventing/targets.js";
import { MAP2, readJson, readText, session } from "../helpers/fixture.js";

const page = (eventId: number, pageIndex = 0): ListTarget => ({ kind: "map_event_page", mapId: 2, eventId, pageIndex });

function mapOf(root: string): NativeMap {
  return readJson(root, MAP2) as NativeMap;
}

describe("event authoring", () => {
  it("creates a multi-page NPC with dialogue, choices, switches, variables and nested branches", () => {
    const s = session();
    const ws = s.tx.workspace();
    const id = s.events.createMapEvent(ws, 2, {
      name: "Quest Giver",
      x: 10,
      y: 10,
      pages: [
        {
          settings: { image: { characterName: "People1", characterIndex: 3, direction: "left" }, priority: "same", trigger: "action_button" },
          blocks: [
            { type: "show_text", speakerName: "Ann", text: "Will you help me?" },
            {
              type: "show_choices",
              choices: [
                { text: "Yes", blocks: [{ type: "control_variables", variableId: 1, operation: "set", operand: 1 }, { type: "control_switches", switchId: 2, value: "on" }] },
                { text: "No", blocks: [{ type: "conditional", condition: { type: "switch", switchId: 1, value: "on" }, then: [{ type: "show_text", text: "Maybe later." }], else: [] }] },
              ],
              cancel: 1,
            },
          ],
        },
        { settings: { conditions: { variable: { variableId: 1, atLeast: 1 } }, image: { characterName: "People1", characterIndex: 3 }, priority: "same" }, blocks: [{ type: "show_text", text: "Thanks!" }] },
      ],
    });
    expect(id).toBe(10); // lowest free slot, as the editor does
    const cs = s.tx.stage(ws, "create npc");
    expect(cs.diagnosticSummary.errors).toBe(0);
    expect(cs.files.map((f) => f.relPath)).toEqual([MAP2]);
    expect(cs.semanticDiff.join("\n")).toContain("Will you help me?");
    const r = s.tx.apply(cs.id, { acknowledgeWarnings: true });
    expect(r.transactionId).toMatch(/^tx_/);

    const map = mapOf(s.root);
    const ev = map.events[10]!;
    expect(ev).toMatchObject({ id: 10, name: "Quest Giver", x: 10, y: 10 });
    expect(Object.keys(ev)).toEqual(["id", "name", "note", "pages", "x", "y"]);
    expect(ev.pages).toHaveLength(2);
    expect(ev.pages[0]!.image).toEqual({ tileId: 0, characterName: "People1", direction: 4, pattern: 0, characterIndex: 3 });
    expect(ev.pages[1]!.conditions).toMatchObject({ variableValid: true, variableId: 1, variableValue: 1 });
    // Other events untouched, other slots preserved.
    expect(map.events[11]!.name).toBe("AfterGap");
    expect(map.events[0]).toBeNull();
  });

  it("edits a page with minimal native patches (unrelated and unknown commands keep their exact objects)", () => {
    const s = session();
    const before = mapOf(s.root);
    const target = page(8); // contains unknown/unsupported commands
    const logic = s.events.getEventLogic(target);
    const ws = s.tx.workspace();
    s.events.editLogic(ws, target, { op: "insert", position: { after: "2" }, blocks: [{ type: "wait", frames: 15 }], revision: logic.revision as string });
    const cs = s.tx.stage(ws, "insert");
    s.tx.apply(cs.id, { acknowledgeWarnings: true });
    const after = mapOf(s.root).events[8]!.pages[0]!.list;
    const orig = before.events[8]!.pages[0]!.list;
    expect(after).toEqual([...orig.slice(0, 4), { code: 230, indent: 0, parameters: [15] }, ...orig.slice(4)]);
    // Every other event is byte-identical.
    const txt = readText(s.root, MAP2);
    for (const e of before.events) if (e && e.id !== 8) expect(txt).toContain(JSON.stringify(e));
  });

  it("inserts into branches, creates a missing else branch, replaces, moves and removes blocks", () => {
    const s = session();
    const t = page(4); // loop { input; if v2==42 {break}; v3 += 1 }
    const rev = () => listRevision(s.events.getEventLogic(t).logic && (s.project.readMap(2).data.events[4]!.pages[0]!.list));
    let ws = s.tx.workspace();
    s.events.editLogic(ws, t, { op: "insert", position: { parentId: "0/body/1", branch: "else" }, blocks: [{ type: "show_text", text: "Try again" }], revision: rev() });
    s.events.editLogic(ws, t, { op: "replace", blockId: "0/body/0", block: { type: "input_number", variableId: 2, digits: 4 } });
    s.events.editLogic(ws, t, { op: "move", blockId: "0/body/2", position: { parentId: "", index: 0 } });
    let cs = s.tx.stage(ws, "branch edits");
    expect(cs.diagnosticSummary.errors).toBe(0);
    s.tx.apply(cs.id, { acknowledgeWarnings: true });

    let list = s.project.readMap(2).data.events[4]!.pages[0]!.list;
    expect(list.map((c) => [c.code, c.indent])).toEqual([
      [122, 0], // moved out of the loop: indent rebased 1 → 0
      [112, 0],
      [103, 1],
      [111, 1],
      [113, 2],
      [0, 2],
      [411, 1], // created else branch
      [101, 2],
      [401, 2],
      [0, 2],
      [412, 1],
      [0, 1],
      [413, 0],
      [0, 0],
    ]);
    expect(list[2]!.parameters).toEqual([2, 4]);

    ws = s.tx.workspace();
    s.events.editLogic(ws, t, { op: "remove", blockId: "1/body/1", revision: listRevision(list) });
    cs = s.tx.stage(ws, "remove");
    s.tx.apply(cs.id, { acknowledgeWarnings: true });
    list = s.project.readMap(2).data.events[4]!.pages[0]!.list;
    expect(list.map((c) => c.code)).toEqual([122, 112, 103, 0, 413, 0]);
  });

  it("rejects stale revisions and missing revisions for path-based edits", () => {
    const s = session();
    const ws = s.tx.workspace();
    expect(() => s.events.editLogic(ws, page(2), { op: "remove", blockId: "0", revision: "deadbeefdeadbeef" })).toThrow(/changed since revision/);
    expect(() => s.events.editLogic(s.tx.workspace(), page(2), { op: "remove", blockId: "0" })).toThrow(/revision.*required/);
    expect(() => s.events.editLogic(s.tx.workspace(), page(2), { op: "remove", blockId: "7/then/0", revision: listRevision(s.project.readMap(2).data.events[2]!.pages[0]!.list) })).toThrow(/does not exist/);
  });

  it("updates page settings, clones/reorders/deletes pages and requires confirmation for destructive changes", () => {
    const s = session();
    let ws = s.tx.workspace();
    s.events.updatePageSettings(ws, 2, 7, 0, { trigger: "player_touch", priority: "below", conditions: { switch1: 1, item: null }, movement: { type: "custom", speed: 4, route: { repeat: true, commands: ["move_random", { command: "wait", frames: 30 }] } } });
    s.events.cloneEventPage(ws, 2, 7, 0, { insertAt: 3 });
    s.events.reorderEventPages(ws, 2, 7, [1, 0, 2, 3]);
    let cs = s.tx.stage(ws, "settings");
    s.tx.apply(cs.id, { acknowledgeWarnings: true });
    let ev = s.project.readMap(2).data.events[7]!;
    expect(ev.pages).toHaveLength(4);
    expect(ev.pages[1]).toMatchObject({ trigger: 1, priorityType: 0, moveType: 3, moveSpeed: 4 });
    expect(ev.pages[1]!.conditions).toMatchObject({ switch1Valid: true, switch1Id: 1, itemValid: false });
    expect(ev.pages[1]!.moveRoute).toEqual({ list: [{ code: 9, indent: null }, { code: 15, parameters: [30], indent: null }, { code: 0, parameters: [] }], repeat: true, skippable: false, wait: false });

    ws = s.tx.workspace();
    s.events.deleteEventPage(ws, 2, 7, 3);
    cs = s.tx.stage(ws, "delete page");
    expect(cs.destructive).toBe(true);
    expect(() => s.tx.apply(cs.id, { acknowledgeWarnings: true })).toThrow(/destructive/);
    s.tx.apply(cs.id, { acknowledgeWarnings: true, confirm: cs.id });
    ev = s.project.readMap(2).data.events[7]!;
    expect(ev.pages).toHaveLength(3);
  });

  it("blocks writes with structural or reference errors", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.events.editLogic(ws, page(1), { op: "append", blocks: [{ type: "call_common_event", commonEventId: 999 }, { type: "transfer_player", mapId: 1, x: 500, y: 1 }] });
    const cs = s.tx.stage(ws, "bad refs");
    const codes = cs.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
    expect(codes).toContain("ref.common_event.invalid");
    expect(codes).toContain("ref.map.invalid");
    expect(() => s.tx.apply(cs.id)).toThrow(/validation error/);
  });

  it("warns about blank references, missing labels and endless autorun pages", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.events.createMapEvent(ws, 2, { x: 1, y: 1, pages: [{ settings: { trigger: "autorun" }, blocks: [{ type: "show_text", text: "loop forever" }, { type: "jump_to_label", name: "nowhere" }] }] });
    const cs = s.tx.stage(ws, "warnings");
    const codes = cs.diagnostics.map((d) => d.code);
    expect(codes).toContain("event.label.missing");
    expect(codes).toContain("flow.autorun.never_ends");
    expect(() => s.tx.apply(cs.id)).toThrow(/acknowledgeWarnings/);
  });

  it("refuses to delete an event that other events still reference", () => {
    const s = session();
    // Event 5 references itself only (character 0); add a reference to event 4 from event 1.
    let ws = s.tx.workspace();
    s.events.editLogic(ws, page(1), { op: "append", blocks: [{ type: "set_event_location", character: 4, location: { type: "direct", x: 1, y: 1 } }] });
    s.tx.apply(s.tx.stage(ws, "ref").id, { acknowledgeWarnings: true });
    ws = s.tx.workspace();
    s.events.deleteMapEvent(ws, 2, 4);
    const cs = s.tx.stage(ws, "delete");
    expect(cs.diagnostics.some((d) => d.code === "ref.event.deleted")).toBe(true);
    expect(cs.diagnosticSummary.errors).toBeGreaterThan(0);
  });

  it("edits common events and troop battle pages with the same tools", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.events.editLogic(ws, { kind: "common_event", commonEventId: 1 }, { op: "append", blocks: [{ type: "show_text", text: "Healed!" }] });
    s.events.editLogic(ws, { kind: "troop_page", troopId: 1, pageIndex: 0 }, { op: "append", blocks: [{ type: "show_text", text: "Battle start" }] });
    const cs = s.tx.stage(ws, "ce + troop");
    expect(cs.files.map((f) => f.relPath).sort()).toEqual(["data/CommonEvents.json", "data/Troops.json"]);
    // The fixture's deliberate common event cycle (2 ↔ 3) is reported as a heuristic.
    expect(cs.diagnostics.some((d) => d.code === "flow.common_event.cycle" && d.heuristic)).toBe(true);
    s.tx.apply(cs.id, { acknowledgeWarnings: true });
    const ce = (readJson(s.root, "data/CommonEvents.json") as { list: { code: number }[] }[])[1]!;
    expect(ce.list.map((c) => c.code)).toEqual([250, 314, 101, 401, 0]);
  });

  it("replace_event_logic preserves raw blocks that are re-submitted", () => {
    const s = session();
    const t = page(8);
    const logic = s.events.getEventLogic(t);
    const blocks = (logic.logic as { blocks: EventBlock[] }).blocks;
    const ws = s.tx.workspace();
    s.events.editLogic(ws, t, { op: "replace_all", logic: { irVersion: 1, blocks: [...blocks, { type: "wait", frames: 1 }] }, revision: logic.revision as string });
    s.tx.apply(s.tx.stage(ws, "rewrite").id, { acknowledgeWarnings: true });
    const list = s.project.readMap(2).data.events[8]!.pages[0]!.list;
    expect(list.slice(0, 3)).toEqual([
      { code: 231, indent: 0, parameters: [1, "Picture", 0, 0, 0, 0, 100, 100, 255, 0] },
      { code: 999, indent: 0, parameters: ["plugin-ish"], extraKey: { keep: true } },
      { code: 999, indent: 1, parameters: ["nested child of unknown"] },
    ]);
    expect(parseCommandList(list).logic.blocks.at(-1)!.type).toBe("wait");
  });

  it("builds events from templates (treasure chest, quest NPC)", async () => {
    const { buildEventFromTemplate } = await import("../../src/eventing/templates/event-templates.js");
    const s = session();
    const ws = s.tx.workspace();
    const chest = buildEventFromTemplate("treasure_chest", { reward: { kind: "item", id: 1, amount: 2 }, message: "Got 2 Potions!" });
    const quest = buildEventFromTemplate("quest_npc", {
      variableId: 5,
      characterName: "People1",
      stages: [{ text: "Bring me a potion." }, { text: "Thanks!", requireItem: { itemId: 1, notMetText: "Still waiting." }, rewards: [{ kind: "gold", amount: 100 }] }, { text: "Have a nice day." }],
    });
    const c = s.events.createMapEvent(ws, 2, { name: chest.name, x: 2, y: 2, pages: chest.pages });
    const q = s.events.createMapEvent(ws, 2, { name: quest.name, x: 4, y: 2, pages: quest.pages });
    const cs = s.tx.stage(ws, "templates");
    expect(cs.diagnosticSummary.errors).toBe(0);
    s.tx.apply(cs.id, { acknowledgeWarnings: true });
    const map = s.project.readMap(2).data;
    expect(map.events[c]!.pages[1]!.conditions).toMatchObject({ selfSwitchValid: true, selfSwitchCh: "A" });
    expect(map.events[q]!.pages.map((p) => [p.conditions.variableValid, p.conditions.variableValue])).toEqual([
      [false, 0],
      [true, 1],
      [true, 2],
    ]);
    expect(quest.summary).toContain("variable 5");
  });
});

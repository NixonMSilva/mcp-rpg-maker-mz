import { describe, expect, it } from "vitest";
import type { NativeMap } from "../../src/adapters/rpg-maker-mz/native-types.js";
import { compileList } from "../../src/eventing/ir/compiler.js";
import { describeLogic } from "../../src/eventing/ir/describe.js";
import { parseCommandList } from "../../src/eventing/ir/parser.js";
import type { EventBlock } from "../../src/eventing/ir/types.js";
import { NO_NAMES } from "../../src/references/ref-types.js";
import { FIXTURE_ROOT, readJson } from "../helpers/fixture.js";

const map = readJson(FIXTURE_ROOT, "data/Map002.json") as NativeMap;
const list = (eventId: number, page = 0) => map.events[eventId]!.pages[page]!.list;

describe("native → IR parser (fixture events)", () => {
  it("round-trips every fixture page exactly", () => {
    for (const ev of map.events) {
      if (!ev) continue;
      ev.pages.forEach((p, i) => {
        const parsed = parseCommandList(p.list, `ev${ev.id}p${i}`);
        expect(compileList(parsed.logic.blocks).commands, `event ${ev.id} page ${i}`).toEqual(p.list);
      });
    }
  });

  it("parses simple dialogue with speaker name and text codes", () => {
    const { logic, rawBlockCount } = parseCommandList(list(1));
    expect(rawBlockCount).toBe(0);
    expect(logic.blocks).toEqual([
      { type: "show_text", faceName: "Actor1", faceIndex: 0, background: "window", position: "bottom", speakerName: "Reid", lines: ["Hello there!", "Nice weather, \\V[1]."], id: "0" },
    ]);
  });

  it("parses nested conditionals with else branches and assigns path ids", () => {
    const { logic, blocks } = parseCommandList(list(2));
    const top = logic.blocks[0]!;
    expect(top.type).toBe("conditional");
    expect(top.condition).toEqual({ type: "switch", switchId: 1, value: "on" });
    const inner = (top.else as EventBlock[])[0]!;
    expect(inner.id).toBe("0/else/0");
    expect(inner.condition).toEqual({ type: "item", itemId: 7 });
    expect((inner.then as EventBlock[]).map((b) => b.type)).toEqual(["change_items", "control_switches"]);
    expect(blocks.get("0/else/0/then/1")).toMatchObject({ type: "control_switches", indent: 2 });
  });

  it("parses choices with a cancel branch and shop goods", () => {
    const { logic, rawBlockCount } = parseCommandList(list(3));
    expect(rawBlockCount).toBe(0);
    const ch = logic.blocks[1]!;
    expect(ch).toMatchObject({ type: "show_choices", cancel: "branch", default: 0, position: "right", background: "window" });
    expect((ch.choices as { text: string }[]).map((c) => c.text)).toEqual(["Buy", "Sell", "Leave"]);
    expect((ch.cancelBlocks as EventBlock[])[0]!.type).toBe("play_se");
    const shop = (ch.choices as { blocks: EventBlock[] }[])[0]!.blocks[0]!;
    expect(shop).toMatchObject({
      type: "shop_processing",
      goods: [
        { goodsType: "item", id: 1, price: null },
        { goodsType: "item", id: 2, price: null },
        { goodsType: "weapon", id: 1, price: 150 },
      ],
    });
  });

  it("parses loops, movement routes, plugin commands and scripts", () => {
    expect(parseCommandList(list(4)).logic.blocks[0]!.type).toBe("loop");
    const mover = parseCommandList(list(5)).logic.blocks;
    expect(mover[0]).toMatchObject({ type: "set_movement_route", character: 0, wait: true });
    expect((mover[0]!.commands as { command: string }[]).map((c) => c.command)).toEqual(["play_se", "jump", "wait", "turn_up"]);
    const caller = parseCommandList(list(6)).logic.blocks;
    expect(caller.map((b) => b.type)).toEqual(["call_common_event", "plugin_command", "script", "comment"]);
    expect(caller[2]!.lines).toEqual(["const v = $gameVariables.value(3);", "$gameSwitches.setValue(2, v > 10);"]);
  });

  it("keeps unknown and unsupported commands as opaque raw blocks, exactly", () => {
    const parsed = parseCommandList(list(8));
    const types = parsed.logic.blocks.map((b) => b.type);
    expect(types).toEqual(["raw_command", "raw_command", "plugin_command_mv", "show_text"]);
    const unknown = parsed.logic.blocks[1]!;
    expect(unknown.commands).toEqual([
      { code: 999, indent: 0, parameters: ["plugin-ish"], extraKey: { keep: true } },
      { code: 999, indent: 1, parameters: ["nested child of unknown"] },
    ]);
    // MV-style 4-parameter Show Text is semantic but keeps its native shape.
    expect(parsed.logic.blocks[3]).not.toHaveProperty("speakerName");
    expect(compileList(parsed.logic.blocks).commands).toEqual(list(8));
    expect(describeLogic(parsed.logic.blocks, NO_NAMES).join("\n")).toContain("[opaque native] Show Picture");
  });

  it("handles malformed lists without losing data", () => {
    const noTerminator = [{ code: 101, indent: 0, parameters: ["", 0, 0, 2, ""] }, { code: 401, indent: 0, parameters: ["hi"] }];
    const p1 = parseCommandList(noTerminator);
    expect(p1.diagnostics.some((d) => d.code === "structure.missing_terminator")).toBe(true);
    expect(p1.logic.blocks[0]!.type).toBe("show_text");

    const broken = [
      { code: 111, indent: 0, parameters: [0, 1, 0] },
      { code: 101, indent: 1, parameters: ["", 0, 0, 2, ""] },
      { code: 0, indent: 1, parameters: [] },
      // missing 412
      { code: 0, indent: 0, parameters: [] },
    ];
    const p2 = parseCommandList(broken);
    expect(p2.logic.blocks[0]!.type).toBe("raw_command");
    expect(compileList(p2.logic.blocks).commands).toEqual(broken);

    const orphan = [{ code: 411, indent: 0, parameters: [] }, { code: 0, indent: 0, parameters: [] }];
    const p3 = parseCommandList(orphan);
    expect(p3.logic.blocks[0]).toMatchObject({ type: "raw_command" });
    expect(p3.diagnostics.some((d) => d.code === "structure.orphan_subordinate")).toBe(true);

    expect(parseCommandList("nope").diagnostics[0]!.code).toBe("structure.not_a_list");
  });

  it("falls back to native conditions for unrecognized shapes without losing the branch", () => {
    const l = [
      { code: 111, indent: 0, parameters: [4, 1, 0, 0] }, // in-party with an extra param
      { code: 230, indent: 1, parameters: [5] },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];
    const p = parseCommandList(l);
    expect(p.logic.blocks[0]).toMatchObject({ type: "conditional", condition: { type: "native", parameters: [4, 1, 0, 0] } });
    expect((p.logic.blocks[0]!.then as EventBlock[])[0]!.type).toBe("wait");
    expect(compileList(p.logic.blocks).commands).toEqual(l);
  });
});

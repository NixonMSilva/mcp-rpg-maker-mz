import { describe, expect, it } from "vitest";
import { allLeafDefs } from "../../src/eventing/ir/blocks.js";
import { compileBlock, compileList } from "../../src/eventing/ir/compiler.js";
import { DEFAULT_NORMALIZE_CONTEXT, type NormalizeContext } from "../../src/eventing/ir/input.js";
import { normalizeBlock, normalizeBlocks, supportedBlockTypes } from "../../src/eventing/ir/normalize.js";
import { parseCommandList } from "../../src/eventing/ir/parser.js";
import type { EventBlock } from "../../src/eventing/ir/types.js";
import { McpError } from "../../src/project/errors.js";

const SCRIPT_OK: NormalizeContext = { allowScript: true, existingScripts: new Set() };

/** One representative agent input per supported block type. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  show_text: { type: "show_text", faceName: "Actor1", faceIndex: 2, background: "dim", position: "top", speakerName: "Reid", text: "Hello\nWorld" },
  show_scrolling_text: { type: "show_scrolling_text", speed: 3, noFastForward: true, lines: ["A", "B"] },
  input_number: { type: "input_number", variableId: 4, digits: 3 },
  select_item: { type: "select_item", variableId: 5, itemType: "key_item" },
  comment: { type: "comment", text: "note 1\nnote 2" },
  break_loop: { type: "break_loop" },
  exit_event_processing: { type: "exit_event_processing" },
  label: { type: "label", name: "start" },
  jump_to_label: { type: "jump_to_label", name: "start" },
  call_common_event: { type: "call_common_event", commonEventId: 1 },
  control_switches: { type: "control_switches", startId: 3, endId: 5, value: "off" },
  control_variables: { type: "control_variables", variableId: 2, operation: "add", operand: { type: "random", min: 1, max: 6 } },
  control_self_switch: { type: "control_self_switch", selfSwitch: "B", value: "on" },
  change_gold: { type: "change_gold", operation: "decrease", operand: { type: "variable", variableId: 3 } },
  change_items: { type: "change_items", itemId: 1, operation: "increase", operand: 3 },
  change_weapons: { type: "change_weapons", weaponId: 2, operation: "decrease", operand: 1, includeEquipment: true },
  change_armors: { type: "change_armors", armorId: 2, operation: "increase", operand: 1 },
  change_party_member: { type: "change_party_member", actorId: 2, operation: "add", initialize: true },
  change_hp: { type: "change_hp", actor: 0, operation: "decrease", operand: 10, allowDeath: true },
  change_mp: { type: "change_mp", actor: { type: "variable", variableId: 7 }, operation: "increase", operand: 5 },
  change_tp: { type: "change_tp", actor: 1, operation: "increase", operand: 5 },
  change_exp: { type: "change_exp", actor: 1, operation: "increase", operand: 100, showLevelUp: true },
  change_level: { type: "change_level", actor: 1, operation: "increase", operand: 1 },
  change_state: { type: "change_state", actor: 1, operation: "remove", stateId: 4 },
  change_skill: { type: "change_skill", actor: 1, operation: "learn", skillId: 10 },
  recover_all: { type: "recover_all", actor: 0 },
  change_name: { type: "change_name", actorId: 1, name: "Hero" },
  change_nickname: { type: "change_nickname", actorId: 1, nickname: "the Brave" },
  change_profile: { type: "change_profile", actorId: 1, profile: "A hero." },
  change_class: { type: "change_class", actorId: 1, classId: 2, keepExp: true },
  change_save_access: { type: "change_save_access", value: "disable" },
  change_menu_access: { type: "change_menu_access", value: "enable" },
  change_encounter: { type: "change_encounter", value: "disable" },
  change_formation_access: { type: "change_formation_access", value: "enable" },
  change_transparency: { type: "change_transparency", transparent: true },
  change_player_followers: { type: "change_player_followers", visible: false },
  gather_followers: { type: "gather_followers" },
  get_on_off_vehicle: { type: "get_on_off_vehicle" },
  erase_event: { type: "erase_event" },
  fadeout_screen: { type: "fadeout_screen" },
  fadein_screen: { type: "fadein_screen" },
  save_bgm: { type: "save_bgm" },
  resume_bgm: { type: "resume_bgm" },
  stop_se: { type: "stop_se" },
  open_menu_screen: { type: "open_menu_screen" },
  open_save_screen: { type: "open_save_screen" },
  game_over: { type: "game_over" },
  return_to_title: { type: "return_to_title" },
  transfer_player: { type: "transfer_player", mapId: 1, x: 3, y: 4, direction: "up", fade: "white" },
  set_event_location: { type: "set_event_location", character: "this_event", location: { type: "exchange", eventId: 3 }, direction: "retain" },
  set_movement_route: {
    type: "set_movement_route",
    character: "player",
    repeat: false,
    skippable: true,
    wait: true,
    commands: ["move_down", { command: "jump", x: 1, y: -1 }, { command: "play_se", se: { name: "Jump1" } }, { command: "switch_on", switchId: 2 }, { command: "raw", code: 99, parameters: [1] }],
  },
  play_animation: { type: "play_animation", character: -1, animationId: 1, wait: true },
  show_balloon: { type: "show_balloon", character: 0, balloonId: "Heart", wait: false },
  tint_screen: { type: "tint_screen", tone: [0, 0, 0, 68], duration: 30, wait: true },
  flash_screen: { type: "flash_screen", color: [255, 255, 255, 170], duration: 20, wait: false },
  shake_screen: { type: "shake_screen", power: 5, speed: 5, duration: 60, wait: true },
  wait: { type: "wait", frames: 60 },
  erase_picture: { type: "erase_picture", pictureId: 1 },
  play_bgm: { type: "play_bgm", name: "Town1", volume: 80 },
  play_bgs: { type: "play_bgs", audio: { name: "Rain" } },
  play_me: { type: "play_me", name: "Fanfare1" },
  play_se: { type: "play_se", name: "Item1", pitch: 120 },
  fadeout_audio: { type: "fadeout_audio", channel: "bgs", seconds: 2 },
  shop_processing: { type: "shop_processing", goods: [{ goodsType: "item", id: 1 }, { goodsType: "weapon", id: 2, price: 99 }], purchaseOnly: true },
  script: { type: "script", script: "console.log(1);\nconsole.log(2);" },
  plugin_command: { type: "plugin_command", pluginName: "TestPlugin", commandName: "DoThing", args: { power: 5, opts: { a: 1 } } },
  plugin_command_mv: { type: "plugin_command_mv", command: "Foo bar" },
  conditional: {
    type: "conditional",
    condition: { type: "variable", variableId: 2, comparison: ">=", operand: 10 },
    then: [{ type: "show_text", text: "big" }],
    else: [{ type: "conditional", condition: { type: "self_switch", selfSwitch: "A", value: "off" }, then: [] }],
  },
  loop: { type: "loop", body: [{ type: "wait", frames: 1 }, { type: "break_loop" }] },
  show_choices: {
    type: "show_choices",
    choices: [{ text: "Yes", blocks: [{ type: "wait", frames: 1 }] }, "No"],
    cancel: "branch",
    default: "none",
    position: "middle",
    background: "transparent",
    cancelBlocks: [{ type: "exit_event_processing" }],
  },
  battle_processing: { type: "battle_processing", troop: 1, canEscape: true, canLose: true, win: [{ type: "change_gold", operand: 5 }], escape: [], lose: [{ type: "game_over" }] },
  raw_command: { type: "raw_command", commands: [{ code: 231, indent: 0, parameters: [1, "Pic", 0, 0, 0, 0, 100, 100, 255, 0] }] },
};

/** Remove ids and the parser's informational raw-block `reason`. */
function stripIds(blocks: EventBlock[]): unknown {
  return JSON.parse(JSON.stringify(blocks, (k, v) => (k === "id" || k === "reason" ? undefined : v)));
}

describe("Event IR block schemas", () => {
  it("has a sample for every supported block type", () => {
    const missing = supportedBlockTypes().filter((t) => !(t in SAMPLES));
    expect(missing).toEqual([]);
    expect(allLeafDefs().length).toBeGreaterThan(60);
  });

  for (const [type, sample] of Object.entries(SAMPLES)) {
    it(`${type}: normalize → compile → parse → compile is stable`, () => {
      const block = normalizeBlock(sample, "b", SCRIPT_OK);
      expect(block.type).toBe(type);
      const list = compileList([block]).commands;
      expect(list[list.length - 1]).toEqual({ code: 0, indent: 0, parameters: [] });
      const parsed = parseCommandList(list);
      expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      if (type !== "raw_command") expect(parsed.rawBlockCount).toBe(0);
      expect(stripIds(parsed.logic.blocks)).toEqual(stripIds([block]));
      expect(compileList(parsed.logic.blocks).commands).toEqual(list);
    });
  }

  it("rejects unknown block types and fields with the JSON path", () => {
    expect(() => normalizeBlocks([{ type: "teleport" }], "blocks", DEFAULT_NORMALIZE_CONTEXT)).toThrow(/blocks\[0\]\.type: unknown block type "teleport"/);
    expect(() => normalizeBlock({ type: "wait", frames: 10, framez: 3 }, "b", DEFAULT_NORMALIZE_CONTEXT)).toThrow(/unknown field\(s\) "framez"/);
    expect(() => normalizeBlock({ type: "control_switches", switchId: 1, value: "maybe" }, "b", DEFAULT_NORMALIZE_CONTEXT)).toThrow(/Invalid b\.value/);
    expect(() => normalizeBlock({ type: "conditional", condition: { type: "switch", switchId: 0 }, then: [] }, "b", DEFAULT_NORMALIZE_CONTEXT)).toThrow(/must be >= 1/);
    expect(() => normalizeBlock({ type: "show_choices", choices: ["a"], cancel: 3 }, "b", DEFAULT_NORMALIZE_CONTEXT)).toThrow(/cancel/);
    expect(() => normalizeBlock({ type: "battle_processing", troop: 1, win: [{ type: "wait", frames: 1 }] }, "b", DEFAULT_NORMALIZE_CONTEXT)).toThrow(/battle branches/);
  });

  it("accepts labels or native values for enums", () => {
    const a = normalizeBlock({ type: "show_text", background: 1, position: "Middle", text: "x" }, "b", DEFAULT_NORMALIZE_CONTEXT);
    expect([a.background, a.position]).toEqual(["dim", "middle"]);
    const t = normalizeBlock({ type: "transfer_player", location: { type: "direct", mapId: 2, x: 1, y: 1 }, direction: 8, fade: 2 }, "b", DEFAULT_NORMALIZE_CONTEXT);
    expect(compileBlock(t, 0)[0]!.parameters).toEqual([0, 2, 1, 1, 8, 2]);
  });

  it("requires explicit authorization for every form of script", () => {
    const scripts = [
      { type: "script", script: "x()" },
      { type: "conditional", condition: { type: "script", script: "x()" }, then: [] },
      { type: "control_variables", variableId: 1, operand: { type: "script", script: "x()" } },
      { type: "set_movement_route", commands: [{ command: "script", script: "x()" }] },
      { type: "raw_command", commands: [{ code: 355, indent: 0, parameters: ["x()"] }] },
    ];
    for (const s of scripts) {
      expect(() => normalizeBlock(s, "b", DEFAULT_NORMALIZE_CONTEXT), JSON.stringify(s)).toThrow(/explicit user authorization/);
      expect(() => normalizeBlock(s, "b", SCRIPT_OK)).not.toThrow();
    }
    // Re-submitting a script that already exists on the page needs no authorization.
    expect(() => normalizeBlock({ type: "script", script: "x()" }, "b", { allowScript: false, existingScripts: new Set(["x()"]) })).not.toThrow();
  });

  it("stores plugin arguments as strings like the editor", () => {
    const b = normalizeBlock(SAMPLES.plugin_command!, "b", DEFAULT_NORMALIZE_CONTEXT);
    expect(b.args).toEqual({ power: "5", opts: '{"a":1}' });
    expect(b.displayLines).toEqual(["power = 5", 'opts = {"a":1}']);
    expect(b.commandText).toBe("DoThing");
  });
});

describe("compiler structure", () => {
  it("emits correct indentation, terminators and branch markers for nested containers", () => {
    const block = normalizeBlock(
      {
        type: "conditional",
        condition: { type: "switch", switchId: 1, value: "on" },
        then: [
          {
            type: "show_choices",
            choices: [{ text: "A", blocks: [{ type: "loop", body: [{ type: "break_loop" }] }] }, { text: "B", blocks: [] }],
            cancel: 1,
          },
        ],
        else: [],
      },
      "b",
      DEFAULT_NORMALIZE_CONTEXT,
    );
    const { commands, sourceMap } = compileList([block]);
    expect(commands.map((c) => [c.code, c.indent])).toEqual([
      [111, 0],
      [102, 1],
      [402, 1],
      [112, 2],
      [113, 3],
      [0, 3],
      [413, 2],
      [0, 2],
      [402, 1],
      [0, 2],
      [404, 1],
      [0, 1],
      [411, 0],
      [0, 1],
      [412, 0],
      [0, 0],
    ]);
    expect(commands[1]!.parameters).toEqual([["A", "B"], 1, 0, 2, 0]);
    // Source map: block id → native range.
    const root = sourceMap.find((s) => s.id === "0")!;
    expect([root.start, root.end]).toEqual([0, 15]);
    const loop = sourceMap.find((s) => s.id === "0/then/0/choice:0/0")!;
    expect([loop.start, loop.end]).toEqual([3, 7]);
  });

  it("emits battle branches only when escape or lose is enabled", () => {
    const plain = compileBlock(normalizeBlock({ type: "battle_processing", troop: 2 }, "b", DEFAULT_NORMALIZE_CONTEXT), 0);
    expect(plain.map((c) => c.code)).toEqual([301]);
    const branched = compileBlock(normalizeBlock({ type: "battle_processing", troop: 2, canLose: true }, "b", DEFAULT_NORMALIZE_CONTEXT), 0);
    expect(branched.map((c) => c.code)).toEqual([301, 601, 0, 603, 0, 604]);
  });

  it("rebases raw command indents and keeps their extra keys", () => {
    const raw = normalizeBlock({ type: "raw_command", commands: [{ code: 999, indent: 0, parameters: [1], extra: { a: 1 } }, { code: 999, indent: 1, parameters: [] }] }, "b", DEFAULT_NORMALIZE_CONTEXT);
    expect(compileBlock(raw, 2)).toEqual([
      { code: 999, indent: 2, parameters: [1], extra: { a: 1 } },
      { code: 999, indent: 3, parameters: [] },
    ]);
  });
});

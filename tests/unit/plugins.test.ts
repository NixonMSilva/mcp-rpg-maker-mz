import { describe, expect, it } from "vitest";
import { parsePluginHeader } from "../../src/adapters/rpg-maker-mz/plugin-header.js";
import { session } from "../helpers/fixture.js";

describe("plugin annotation headers (inferred schemas)", () => {
  it("parses commands and args, ignoring plugin params and other languages", () => {
    const src = `/*:
 * @target MZ
 * @plugindesc Demo
 * @param Speed
 * @text Speed param
 * @type number
 *
 * @command Open
 * @text Open Door
 * @desc Opens it
 * @arg doorId
 * @text Door
 * @type number
 * @default 1
 *
 * @command Close
 */
/*:ja
 * @command 日本語
 */`;
    expect(parsePluginHeader(src)).toEqual({
      target: "MZ",
      plugindesc: "Demo",
      confidence: "inferred",
      commands: [
        { name: "Open", text: "Open Door", desc: "Opens it", args: [{ name: "doorId", text: "Door", type: "number", default: "1" }] },
        { name: "Close", args: [] },
      ],
    });
    expect(parsePluginHeader("no header")).toBeNull();
  });

  it("warns about plugin commands the header does not declare and about missing plugins", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.events.editLogic(ws, { kind: "map_event_page", mapId: 2, eventId: 1, pageIndex: 0 }, {
      op: "append",
      blocks: [
        { type: "plugin_command", pluginName: "TestPlugin", commandName: "DoThing", args: { power: "1", bogus: "x" } },
        { type: "plugin_command", pluginName: "TestPlugin", commandName: "Invented" },
        { type: "plugin_command", pluginName: "NotInstalled", commandName: "X" },
        { type: "plugin_command", pluginName: "DisabledPlugin", commandName: "X" },
      ],
    });
    const cs = s.tx.stage(ws, "plugins");
    const byCode = (code: string) => cs.diagnostics.filter((d) => d.code === code);
    expect(byCode("plugin.command.unknown")).toHaveLength(1);
    expect(byCode("plugin.args.unknown")[0]!.message).toContain("bogus");
    expect(byCode("ref.plugin.missing")[0]!.message).toContain("NotInstalled");
    expect(byCode("ref.plugin.blank")[0]!.message).toContain("disabled");
  });
});

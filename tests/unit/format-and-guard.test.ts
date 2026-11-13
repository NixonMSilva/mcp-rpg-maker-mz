import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginsJs } from "../../src/adapters/rpg-maker-mz/plugins-js.js";
import { McpError } from "../../src/project/errors.js";
import { detectJsonStyle, parseJsonText, serializeJson } from "../../src/project/mz-json-format.js";
import { PathGuard } from "../../src/project/path-guard.js";
import { FIXTURE_ROOT, tempProject } from "../helpers/fixture.js";

describe("MZ JSON layouts", () => {
  const cases: [string, string][] = [
    ["record-array", '[\nnull,\n{"id":1,"name":"A"},\n{"id":2,"name":"B"}\n]'],
    ["empty record-array", "[\n]"],
    ["map", '{\n"displayName":"","width":2,\n"data":[0,0],\n"events":[\nnull,\n{"id":1}\n]\n}'],
    ["map without events", '{\n"a":1,\n"data":[],\n"events":[\n]\n}'],
    ["compact", '{"a":1,"b":[1,2]}'],
    ["crlf record-array", '[\r\nnull,\r\n{"id":1}\r\n]'],
    ["pretty 2", '{\n  "a": 1,\n  "b": [\n    1\n  ]\n}'],
    ["bom + trailing newline", '\ufeff[\nnull,\n{"id":1}\n]\n'],
  ];
  for (const [label, text] of cases) {
    it(`round-trips ${label} byte-for-byte`, () => {
      const data = parseJsonText(text);
      expect(serializeJson(data, detectJsonStyle(text, data))).toBe(text);
    });
  }

  it("keeps the layout when data changes", () => {
    const text = '[\nnull,\n{"id":1,"name":"A"}\n]';
    const data = parseJsonText(text) as { id: number; name: string }[];
    const style = detectJsonStyle(text, data);
    data[1]!.name = "Z";
    data.push({ id: 2, name: "B" });
    expect(serializeJson(data, style)).toBe('[\nnull,\n{"id":1,"name":"Z"},\n{"id":2,"name":"B"}\n]');
  });

  it("round-trips every fixture data file exactly", () => {
    for (const f of fs.readdirSync(path.join(FIXTURE_ROOT, "data"))) {
      const text = fs.readFileSync(path.join(FIXTURE_ROOT, "data", f), "utf8");
      const data = parseJsonText(text);
      expect(serializeJson(data, detectJsonStyle(text, data)), f).toBe(text);
    }
  });
});

describe("PathGuard", () => {
  const guard = new PathGuard(FIXTURE_ROOT);
  it("resolves project-relative paths", () => {
    expect(guard.resolve("data/System.json")).toBe(path.join(FIXTURE_ROOT, "data", "System.json"));
    expect(guard.resolve("data\\System.json")).toBe(path.join(FIXTURE_ROOT, "data", "System.json"));
  });
  for (const bad of ["../outside.json", "data/../../x", "/etc/passwd", "C:\\Windows\\win.ini", "\\\\server\\share", "a\0b"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => guard.resolve(bad)).toThrow(McpError);
    });
  }
  it("rejects symlink/junction escapes", () => {
    const root = tempProject();
    const outside = path.join(root, "..", `outside_${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.json"), "{}");
    try {
      fs.symlinkSync(outside, path.join(root, "data", "escape"), "junction");
    } catch {
      return; // symlinks unavailable in this environment
    }
    const g = new PathGuard(root);
    expect(() => g.resolve("data/escape/secret.json")).toThrow(/symlink escape/);
  });
});

describe("plugins.js parser", () => {
  it("parses the editor format without executing it", () => {
    const text = fs.readFileSync(path.join(FIXTURE_ROOT, "js", "plugins.js"), "utf8");
    const plugins = parsePluginsJs(text);
    expect(plugins.map((p) => [p.name, p.status])).toEqual([
      ["TestPlugin", true],
      ["DisabledPlugin", false],
    ]);
  });
  it("rejects non-data content with an actionable error", () => {
    expect(() => parsePluginsJs("var $plugins = [ evil() ];")).toThrow(/never executed/);
    expect(() => parsePluginsJs("nothing here")).toThrow(/\$plugins/);
  });
});

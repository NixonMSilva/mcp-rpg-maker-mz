import { describe, expect, it } from "vitest";
import { compileList } from "../../src/eventing/ir/compiler.js";
import { parseCommandList } from "../../src/eventing/ir/parser.js";
import { detectJsonStyle, parseJsonText, serializeJson } from "../../src/project/mz-json-format.js";
import { corpusJsonFiles, corpusLists, realDataDirs } from "../helpers/real-projects.js";

const dirs = realDataDirs();

describe.skipIf(dirs.length === 0)("round-trip against real MZ data (read-only corpus)", () => {
  it("re-serializes every JSON file byte-for-byte in its detected layout", () => {
    let n = 0;
    for (const { file, text } of corpusJsonFiles(dirs)) {
      let data: unknown;
      try {
        data = parseJsonText(text);
      } catch {
        continue;
      }
      const style = detectJsonStyle(text, data);
      expect(serializeJson(data, style), file).toBe(text);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });

  it("parses and recompiles every command list losslessly", () => {
    let lists = 0;
    let commands = 0;
    let raw = 0;
    const rawReasons = new Map<string, number>();
    for (const { source, list } of corpusLists(dirs)) {
      const parsed = parseCommandList(list, source);
      const compiled = compileList(parsed.logic.blocks).commands;
      const expected = parsed.trailingStart === null ? list : list.slice(0, parsed.trailingStart);
      expect(compiled, source).toEqual(expected);
      lists++;
      commands += list.length;
      raw += parsed.rawBlockCount;
      collectRawReasons(parsed.logic.blocks, rawReasons);
    }
    // Coverage report (visible with --reporter=verbose); semantic coverage must stay high.
    console.log(`corpus: ${lists} lists, ${commands} commands, ${raw} raw blocks`, Object.fromEntries(rawReasons));
    expect(lists).toBeGreaterThan(0);
  });
});

function collectRawReasons(blocks: { type: string; reason?: unknown; [k: string]: unknown }[], out: Map<string, number>): void {
  for (const b of blocks) {
    if (b.type === "raw_command") {
      const r = String(b.reason ?? "?");
      out.set(r, (out.get(r) ?? 0) + 1);
    }
    for (const key of ["then", "else", "body", "cancelBlocks", "win", "escape", "lose"]) {
      if (Array.isArray(b[key])) collectRawReasons(b[key] as never, out);
    }
    if (Array.isArray(b.choices)) for (const c of b.choices as { blocks: never }[]) collectRawReasons(c.blocks, out);
  }
}

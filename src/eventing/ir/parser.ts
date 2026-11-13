import { CMD, CONTINUATIONS, commandName, isKnownCode, isSubordinateCode } from "../../adapters/rpg-maker-mz/command-catalog.js";
import type { NativeCommand } from "../../adapters/rpg-maker-mz/native-types.js";
import { deepEqual } from "../../project/json-diff.js";
import { DiagnosticBag, type Diagnostic } from "../../validation/diagnostics.js";
import { leafByCode } from "./blocks.js";
import { compileBlock } from "./compiler.js";
import { decodeCondition } from "./conditions.js";
import { CONTAINER_CODES, containerBranches, decodeBattleParams, decodeChoicesParams } from "./containers.js";
import { IR_VERSION, joinId, type EventBlock, type EventLogic, type RawCommandBlock, type RawNativeCommand } from "./types.js";

/**
 * Native command list → Event IR (EVENT_SPEC §9).
 *
 * Every decoded block is verified by recompiling it and comparing with the
 * source commands (deep equality, including unknown keys). Anything that
 * would not round-trip exactly becomes a `raw_command` block holding the
 * original commands, so parse → compile is lossless for any input.
 *
 * The result also carries an index of block ranges and branch slots, used by
 * the block editing service to apply minimal native patches.
 */

export interface ParsedBlockInfo {
  id: string;
  type: string;
  parentId: string;
  branch: string;
  index: number;
  indent: number;
  /** Inclusive native start index. */
  start: number;
  /** Exclusive native end index. */
  end: number;
}

export interface BranchInfo {
  parentId: string;
  branch: string;
  indent: number;
  /** Native index where the branch's first block starts (== terminator when empty). */
  start: number;
  /** Native index of the branch terminator ({code:0} at `indent`); for the root, the list's final terminator. */
  terminator: number;
  /** Whether the terminator command actually exists (false for malformed lists). */
  hasTerminator: boolean;
  blockIds: string[];
}

export interface ParseResult {
  logic: EventLogic;
  blocks: Map<string, ParsedBlockInfo>;
  branches: Map<string, BranchInfo>;
  diagnostics: Diagnostic[];
  /** Number of raw_command blocks (0 means the semantic view is complete). */
  rawBlockCount: number;
  /** Number of native commands in the list. */
  nativeLength: number;
  /** Index of the first command after the final terminator (malformed lists only), else null. */
  trailingStart: number | null;
}

export function branchKey(parentId: string, branch: string): string {
  return `${parentId}|${branch}`;
}

function isCommand(c: unknown): c is NativeCommand {
  return (
    c !== null &&
    typeof c === "object" &&
    typeof (c as NativeCommand).code === "number" &&
    typeof (c as NativeCommand).indent === "number" &&
    Array.isArray((c as NativeCommand).parameters)
  );
}

class Parser {
  readonly blocks = new Map<string, ParsedBlockInfo>();
  readonly branches = new Map<string, BranchInfo>();
  readonly diags = new DiagnosticBag();


  constructor(
    private readonly list: readonly unknown[],
    private readonly location: string,
  ) {}

  /** Parse a branch body starting at `start` at `indent`. Returns blocks and the terminator index. */
  body(start: number, indent: number, parentId: string, branch: string): { blocks: EventBlock[]; terminator: number; ok: boolean } {
    const out: EventBlock[] = [];
    const ids: string[] = [];
    let i = start;
    let ok = true;
    let hasTerminator = false;
    for (;;) {
      if (i >= this.list.length) {
        ok = parentId === "" ? ok : false;
        this.diags.error(
          "structure.missing_terminator",
          parentId === "" ? "Command list does not end with a {code:0, indent:0} terminator." : `Branch "${branch}" of block ${parentId} is missing its {code:0} terminator.`,
          this.location,
        );
        break;
      }
      const c = this.list[i];
      if (isCommand(c) && c.code === CMD.END && c.indent === indent) {
        hasTerminator = true;
        break;
      }
      if (isCommand(c) && c.indent < indent) {
        ok = false;
        this.diags.error("structure.branch_unterminated", `Branch "${branch}" of block ${parentId || "(root)"} ends without a terminator at native index ${i}.`, this.location);
        break;
      }
      const id = joinId(parentId, branch, out.length);
      const { block, end } = this.blockAt(i, indent, id);
      this.blocks.set(id, { id, type: block.type, parentId, branch, index: out.length, indent, start: i, end });
      block.id = id;
      out.push(block);
      ids.push(id);
      i = end;
    }
    this.branches.set(branchKey(parentId, branch), { parentId, branch, indent, start, terminator: i, hasTerminator, blockIds: ids });
    return { blocks: out, terminator: i, ok };
  }

  /** Generic opaque region: the command plus following deeper commands and same-indent subordinate codes. */
  rawRegionEnd(i: number, indent: number): number {
    let j = i + 1;
    while (j < this.list.length) {
      const c = this.list[j];
      if (!isCommand(c)) {
        j++;
        continue;
      }
      if (c.indent > indent || (c.indent === indent && isSubordinateCode(c.code))) j++;
      else break;
    }
    return j;
  }

  makeRaw(start: number, end: number, indent: number, reason: string): RawCommandBlock {

    const commands: RawNativeCommand[] = [];
    for (let k = start; k < end; k++) {
      const c = this.list[k];
      if (!isCommand(c)) {
        // Preserve even malformed entries exactly; report them.
        this.diags.error("structure.malformed_command", `Native command at index ${k} is malformed: ${JSON.stringify(c)?.slice(0, 120)}`, this.location);
        commands.push({ code: -1, indent: 0, parameters: [], malformed: structuredClone(c) } as RawNativeCommand);
        continue;
      }
      const o: Record<string, unknown> = {};
      for (const key of Object.keys(c)) o[key] = key === "indent" ? c.indent - indent : structuredClone(c[key]);
      commands.push(o as RawNativeCommand);
    }
    return { type: "raw_command", commands, reason };
  }

  verify(block: EventBlock, start: number, end: number, indent: number): boolean {
    let compiled: NativeCommand[];
    try {
      compiled = compileBlock(block, indent);
    } catch {
      return false;
    }
    if (compiled.length !== end - start) return false;
    for (let k = 0; k < compiled.length; k++) if (!deepEqual(compiled[k], this.list[start + k])) return false;
    return true;
  }

  blockAt(i: number, indent: number, id: string): { block: EventBlock; end: number } {
    const c = this.list[i];
    if (!isCommand(c)) {
      return { block: this.makeRaw(i, i + 1, indent, "malformed native command"), end: i + 1 };
    }
    if (c.indent !== indent) {
      const end = this.rawRegionEnd(i, indent);
      this.diags.warning("structure.unexpected_indent", `Command ${c.code} at native index ${i} has indent ${c.indent}, expected ${indent}; kept as raw.`, this.location);
      return { block: this.makeRaw(i, end, indent, `unexpected indent ${c.indent} (expected ${indent})`), end };
    }
    if (isSubordinateCode(c.code)) {
      const end = this.rawRegionEnd(i, indent);
      this.diags.warning("structure.orphan_subordinate", `${commandName(c.code)} (${c.code}) at native index ${i} has no owning command; kept as raw.`, this.location);
      return { block: this.makeRaw(i, end, indent, `orphaned ${commandName(c.code)}`), end };
    }

    const containerType = CONTAINER_CODES[c.code];
    if (containerType) {
      const r = this.container(containerType, c, i, indent, id);
      if (r && this.verify(r.block, i, r.end, indent)) return r;
      const end = r?.end ?? this.rawRegionEnd(i, indent);
      // Discard child index entries registered for the failed container.
      this.forgetChildren(id);
      return { block: this.makeRaw(i, end, indent, r ? `${commandName(c.code)} with non-standard native shape` : `malformed ${commandName(c.code)} structure`), end };
    }

    const def = leafByCode(c.code);
    if (def) {
      let end = i + 1;
      const lines: unknown[][] = [];
      const cont = def.continuation ?? CONTINUATIONS[c.code];
      if (cont !== undefined) {
        while (end < this.list.length) {
          const l = this.list[end];
          if (isCommand(l) && l.code === cont && l.indent === indent) {
            lines.push(l.parameters);
            end++;
          } else break;
        }
      }
      const block = def.decode(c.code, c.parameters, lines);
      if (block && this.verify(block, i, end, indent)) return { block, end };
      const rawEnd = this.rawRegionEnd(i, indent);
      return { block: this.makeRaw(i, rawEnd, indent, `${commandName(c.code)} with unrecognized parameter shape`), end: rawEnd };
    }

    const end = this.rawRegionEnd(i, indent);
    const reason = isKnownCode(c.code) ? `${commandName(c.code)} is not modeled by the IR yet` : `unknown command code ${c.code} (plugin or newer engine)`;
    return { block: this.makeRaw(i, end, indent, reason), end };
  }

  forgetChildren(id: string): void {
    const prefix = `${id}/`;
    for (const k of [...this.blocks.keys()]) if (k.startsWith(prefix)) this.blocks.delete(k);
    for (const [k, b] of [...this.branches]) if (b.parentId === id || b.parentId.startsWith(prefix)) this.branches.delete(k);
  }

  at(k: number, code: number, indent: number): boolean {
    const c = this.list[k];
    return isCommand(c) && c.code === code && c.indent === indent;
  }

  container(type: string, c: NativeCommand, i: number, n: number, id: string): { block: EventBlock; end: number } | null {
    switch (type) {
      case "conditional": {
        const then = this.body(i + 1, n + 1, id, "then");
        if (!then.ok || !this.at(then.terminator, CMD.END, n + 1)) return null;
        let k = then.terminator + 1;
        const block: EventBlock = { type, condition: decodeCondition(c.parameters), then: then.blocks };
        if (this.at(k, CMD.ELSE, n)) {
          const els = this.body(k + 1, n + 1, id, "else");
          if (!els.ok || !this.at(els.terminator, CMD.END, n + 1)) return null;
          block.else = els.blocks;
          k = els.terminator + 1;
        }
        if (!this.at(k, CMD.BRANCH_END, n)) return null;
        return { block, end: k + 1 };
      }
      case "loop": {
        if (c.parameters.length !== 0) return null;
        const body = this.body(i + 1, n + 1, id, "body");
        if (!body.ok || !this.at(body.terminator, CMD.END, n + 1) || !this.at(body.terminator + 1, CMD.REPEAT_ABOVE, n)) return null;
        return { block: { type, body: body.blocks }, end: body.terminator + 2 };
      }
      case "show_choices": {
        const p = decodeChoicesParams(c.parameters);
        if (!p) return null;
        let k = i + 1;
        const choices: { text: string; blocks: EventBlock[] }[] = [];
        while (this.at(k, CMD.WHEN_CHOICE, n)) {
          const params = (this.list[k] as NativeCommand).parameters;
          const idx = choices.length;
          const body = this.body(k + 1, n + 1, id, `choice:${idx}`);
          if (!body.ok || !this.at(body.terminator, CMD.END, n + 1)) return null;
          choices.push({ text: typeof params[1] === "string" ? params[1] : "", blocks: body.blocks });
          k = body.terminator + 1;
        }
        if (choices.length !== p.choices.length) return null;
        // Choice labels live in the 102 header; the 402 copies must match (verified by recompilation).
        choices.forEach((ch, idx) => (ch.text = p.choices[idx]!));
        const block: EventBlock = { type, choices, cancel: p.cancel, default: p.default, position: p.position, background: p.background };
        if (this.at(k, CMD.WHEN_CANCEL, n)) {
          const body = this.body(k + 1, n + 1, id, "cancel");
          if (!body.ok || !this.at(body.terminator, CMD.END, n + 1)) return null;
          block.cancelBlocks = body.blocks;
          k = body.terminator + 1;
        }
        if (!this.at(k, CMD.CHOICES_END, n)) return null;
        return { block, end: k + 1 };
      }
      case "battle_processing": {
        const p = decodeBattleParams(c.parameters);
        if (!p) return null;
        const block: EventBlock = { type, troop: p.troop, canEscape: p.canEscape, canLose: p.canLose };
        let k = i + 1;
        if (!this.at(k, CMD.IF_WIN, n)) return { block, end: k };
        const win = this.body(k + 1, n + 1, id, "win");
        if (!win.ok || !this.at(win.terminator, CMD.END, n + 1)) return null;
        block.win = win.blocks;
        k = win.terminator + 1;
        if (this.at(k, CMD.IF_ESCAPE, n)) {
          const b = this.body(k + 1, n + 1, id, "escape");
          if (!b.ok || !this.at(b.terminator, CMD.END, n + 1)) return null;
          block.escape = b.blocks;
          k = b.terminator + 1;
        }
        if (this.at(k, CMD.IF_LOSE, n)) {
          const b = this.body(k + 1, n + 1, id, "lose");
          if (!b.ok || !this.at(b.terminator, CMD.END, n + 1)) return null;
          block.lose = b.blocks;
          k = b.terminator + 1;
        }
        if (!this.at(k, CMD.BATTLE_END, n)) return null;
        return { block, end: k + 1 };
      }
    }
    return null;
  }
}

/** Parse a complete native command list (page, common event or troop page). */
export function parseCommandList(list: unknown, location = ""): ParseResult {
  const diags = new DiagnosticBag();
  if (!Array.isArray(list)) {
    diags.error("structure.not_a_list", "Command list is not an array.", location);
    return {
      logic: { irVersion: IR_VERSION, blocks: [] },
      blocks: new Map(),
      branches: new Map(),
      diagnostics: diags.items,
      rawBlockCount: 0,
      nativeLength: 0,
      trailingStart: null,
    };
  }
  const p = new Parser(list, location);
  const root = p.body(0, 0, "", "");
  let trailingStart: number | null = null;
  if (root.terminator < list.length - 1) {
    // Commands after the final terminator are never executed by the engine; they are preserved verbatim by edits.
    trailingStart = root.terminator + 1;
    p.diags.warning(
      "structure.trailing_commands",
      `${list.length - 1 - root.terminator} command(s) follow the final terminator (never executed); they are preserved verbatim.`,
      location,
    );
  }
  return {
    logic: { irVersion: IR_VERSION, blocks: root.blocks },
    blocks: p.blocks,
    branches: p.branches,
    diagnostics: p.diags.items,
    rawBlockCount: countRaw(root.blocks),
    nativeLength: list.length,
    trailingStart,
  };
}

function countRaw(blocks: readonly EventBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "raw_command") n++;
    for (const br of containerBranches(b)) n += countRaw(br.blocks);
  }
  return n;
}

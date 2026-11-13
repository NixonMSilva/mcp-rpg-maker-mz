import { CMD } from "../../adapters/rpg-maker-mz/command-catalog.js";
import type { NativeCommand } from "../../adapters/rpg-maker-mz/native-types.js";
import { invalidInput } from "../../project/errors.js";
import { leafByType } from "./blocks.js";
import { encodeCondition, type Condition } from "./conditions.js";
import { encodeBattleParams, encodeChoicesParams, isContainerType } from "./containers.js";
import { joinId, type EventBlock, type RawCommandBlock } from "./types.js";

/**
 * IR → native command compiler (EVENT_SPEC §8).
 *
 * Produces commands with correct indentation, branch terminators and
 * continuation lines, plus a source map from block ids to the generated
 * native index ranges. Unsupported or malformed IR is rejected; nothing is
 * silently dropped.
 */

export interface SourceMapEntry {
  id: string;
  type: string;
  /** Inclusive start index in the generated list. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

export interface CompileResult {
  commands: NativeCommand[];
  sourceMap: SourceMapEntry[];
}

function cmd(code: number, indent: number, parameters: unknown[]): NativeCommand {
  return { code, indent, parameters };
}

class Emitter {
  readonly out: NativeCommand[] = [];
  readonly map: SourceMapEntry[] = [];

  blocks(blocks: readonly EventBlock[], indent: number, parentId: string, branch: string): void {
    blocks.forEach((b, i) => this.block(b, indent, joinId(parentId, branch, i)));
  }

  /** Emit a branch body at `indent` followed by its terminator. */
  branchBody(blocks: readonly EventBlock[], indent: number, parentId: string, branch: string): void {
    this.blocks(blocks, indent, parentId, branch);
    this.out.push(cmd(CMD.END, indent, []));
  }

  block(b: EventBlock, indent: number, id: string): void {
    const start = this.out.length;
    if (!b || typeof b !== "object" || typeof b.type !== "string") throw invalidInput(`Block ${id}: missing "type".`);
    if (b.type === "raw_command") {
      this.raw(b as RawCommandBlock, indent, id);
    } else if (isContainerType(b.type)) {
      this.container(b, indent, id);
    } else {
      const def = leafByType(b.type);
      if (!def) throw invalidInput(`Block ${id}: unsupported block type ${JSON.stringify(b.type)}.`);
      const enc = def.encode(b);
      this.out.push(cmd(enc.code, indent, enc.params));
      if (enc.lines && enc.lines.length > 0) {
        if (def.continuation === undefined) throw invalidInput(`Block ${id}: ${b.type} produced continuation lines but has no continuation code.`);
        for (const l of enc.lines) this.out.push(cmd(def.continuation, indent, l));
      }
    }
    this.map.push({ id, type: b.type, start, end: this.out.length });
  }

  raw(b: RawCommandBlock, indent: number, id: string): void {
    if (!Array.isArray(b.commands) || b.commands.length === 0) throw invalidInput(`Block ${id}: raw_command needs a non-empty "commands" array.`);
    for (const c of b.commands) {
      // Rebuild with the same key order as the original native object; only indent is rebased.
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(c)) o[k] = k === "indent" ? indent + c.indent : structuredClone(c[k]);
      this.out.push(o as NativeCommand);
    }
  }

  container(b: EventBlock, n: number, id: string): void {
    switch (b.type) {
      case "conditional": {
        this.out.push(cmd(CMD.CONDITIONAL_BRANCH, n, encodeCondition(b.condition as Condition)));
        this.branchBody(b.then as EventBlock[], n + 1, id, "then");
        if (b.else !== undefined) {
          this.out.push(cmd(CMD.ELSE, n, []));
          this.branchBody(b.else as EventBlock[], n + 1, id, "else");
        }
        this.out.push(cmd(CMD.BRANCH_END, n, []));
        return;
      }
      case "loop": {
        this.out.push(cmd(CMD.LOOP, n, []));
        this.branchBody(b.body as EventBlock[], n + 1, id, "body");
        this.out.push(cmd(CMD.REPEAT_ABOVE, n, []));
        return;
      }
      case "show_choices": {
        this.out.push(cmd(CMD.SHOW_CHOICES, n, encodeChoicesParams(b)));
        (b.choices as { text: string; blocks: EventBlock[] }[]).forEach((c, i) => {
          this.out.push(cmd(CMD.WHEN_CHOICE, n, [i, c.text]));
          this.branchBody(c.blocks, n + 1, id, `choice:${i}`);
        });
        if (b.cancelBlocks !== undefined) {
          // The editor always writes [6, null] for "When Cancel" (6 = cancel slot index from MV's 6-choice layout).
          this.out.push(cmd(CMD.WHEN_CANCEL, n, [6, null]));
          this.branchBody(b.cancelBlocks as EventBlock[], n + 1, id, "cancel");
        }
        this.out.push(cmd(CMD.CHOICES_END, n, []));
        return;
      }
      case "battle_processing": {
        this.out.push(cmd(CMD.BATTLE_PROCESSING, n, encodeBattleParams(b)));
        if (b.win !== undefined) {
          this.out.push(cmd(CMD.IF_WIN, n, []));
          this.branchBody(b.win as EventBlock[], n + 1, id, "win");
          if (b.escape !== undefined) {
            this.out.push(cmd(CMD.IF_ESCAPE, n, []));
            this.branchBody(b.escape as EventBlock[], n + 1, id, "escape");
          }
          if (b.lose !== undefined) {
            this.out.push(cmd(CMD.IF_LOSE, n, []));
            this.branchBody(b.lose as EventBlock[], n + 1, id, "lose");
          }
          this.out.push(cmd(CMD.BATTLE_END, n, []));
        }
        return;
      }
    }
  }
}

/** Compile blocks at a base indent, without a terminator (used for splicing into existing lists). */
export function compileBlocks(blocks: readonly EventBlock[], indent = 0, parentId = "", branch = ""): CompileResult {
  const e = new Emitter();
  e.blocks(blocks, indent, parentId, branch);
  return { commands: e.out, sourceMap: e.map };
}

/** Compile a complete page/common-event list, including the final { code: 0, indent: 0 } terminator. */
export function compileList(blocks: readonly EventBlock[]): CompileResult {
  const e = new Emitter();
  e.branchBody(blocks, 0, "", "");
  return { commands: e.out, sourceMap: e.map };
}

/** Compile one block at an indent. */
export function compileBlock(b: EventBlock, indent: number, id = "0"): NativeCommand[] {
  const e = new Emitter();
  e.block(b, indent, id);
  return e.out;
}

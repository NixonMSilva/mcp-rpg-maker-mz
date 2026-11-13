import { commandName } from "../../adapters/rpg-maker-mz/command-catalog.js";
import type { NameResolver, Ref } from "../../references/ref-types.js";
import { leafByType } from "./blocks.js";
import { containerBranches, containerRefs, describeBranchHeader, describeContainerHeader, isContainerType } from "./containers.js";
import { joinId, type EventBlock, type RawCommandBlock } from "./types.js";

/**
 * Human/LLM-readable rendering of event logic, similar to the editor's
 * command list view, with block ids for follow-up edits.
 *
 *   [0] Show Text [Actor1(0), window, bottom]: "Hello"
 *   [1] If: Switch 12 [Gate Open] is ON
 *       Then:
 *         [1/then/0] Control Self Switch: A = ON
 *       Else:
 *         [1/else/0] ...
 */

export interface DescribeOptions {
  showIds?: boolean;
  /** Stop after this many lines (a "… truncated" marker is appended). */
  maxLines?: number;
}

export function describeBlock(b: EventBlock, n: NameResolver): string {
  if (b.type === "raw_command") {
    const r = b as RawCommandBlock;
    const head = r.commands[0];
    const codes = [...new Set(r.commands.map((c) => c.code))];
    const name = head ? commandName(head.code) : "(empty)";
    return `[opaque native] ${name}${head ? ` (code ${head.code})` : ""} ${head ? JSON.stringify(head.parameters).slice(0, 120) : ""}${r.commands.length > 1 ? ` +${r.commands.length - 1} line(s) [codes ${codes.join(",")}]` : ""}${r.reason ? ` — ${r.reason}` : ""}`;
  }
  if (isContainerType(b.type)) return describeContainerHeader(b, n);
  const def = leafByType(b.type);
  return def ? def.describe(b, n) : `Unknown block ${b.type}`;
}

export function describeLogic(blocks: readonly EventBlock[], n: NameResolver, opts: DescribeOptions = {}): string[] {
  const lines: string[] = [];
  const max = opts.maxLines ?? Infinity;
  let truncated = false;
  const emit = (s: string) => {
    if (lines.length >= max) {
      truncated = true;
      return;
    }
    lines.push(s);
  };
  const walk = (bs: readonly EventBlock[], depth: number, parentId: string, branch: string) => {
    bs.forEach((b, i) => {
      if (truncated) return;
      const id = b.id ?? joinId(parentId, branch, i);
      const pad = "  ".repeat(depth);
      emit(`${pad}${opts.showIds === false ? "" : `[${id}] `}${describeBlock(b, n)}`);
      if (isContainerType(b.type)) {
        for (const br of containerBranches(b)) {
          emit(`${pad}  ${describeBranchHeader(b, br.name)}:`);
          if (br.blocks.length === 0) emit(`${pad}    (empty)`);
          walk(br.blocks, depth + 2, id, br.name);
        }
      }
    });
  };
  walk(blocks, 0, "", "");
  if (blocks.length === 0) lines.push("(no commands)");
  if (truncated) lines.push(`… truncated after ${max} lines; request a narrower scope or detailed IR.`);
  return lines;
}

export interface BlockVisit {
  block: EventBlock;
  id: string;
  depth: number;
  parentId: string;
  branch: string;
}

export function* walkBlocks(blocks: readonly EventBlock[], parentId = "", branch = "", depth = 0): Generator<BlockVisit> {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const id = b.id ?? joinId(parentId, branch, i);
    yield { block: b, id, depth, parentId, branch };
    if (isContainerType(b.type)) {
      for (const br of containerBranches(b)) yield* walkBlocks(br.blocks, id, br.name, depth + 1);
    }
  }
}

/** References made directly by one block (not including nested blocks). */
export function blockRefs(b: EventBlock): Ref[] {
  if (b.type === "raw_command") return rawRefs(b as RawCommandBlock);
  if (isContainerType(b.type)) return containerRefs(b);
  return leafByType(b.type)?.refs?.(b) ?? [];
}

function rawRefs(b: RawCommandBlock): Ref[] {
  const out: Ref[] = [];
  for (const c of b.commands) {
    if (c.code === 357 && typeof c.parameters[0] === "string") {
      out.push({ kind: "plugin", id: c.parameters[0], role: "use", origin: "plugin", via: "plugin command (raw)" });
    }
  }
  return out;
}

/** All references in a block tree, each tagged with the block id it came from. */
export function logicRefs(blocks: readonly EventBlock[]): (Ref & { blockId: string })[] {
  const out: (Ref & { blockId: string })[] = [];
  for (const v of walkBlocks(blocks)) for (const r of blockRefs(v.block)) out.push({ ...r, blockId: v.id });
  return out;
}

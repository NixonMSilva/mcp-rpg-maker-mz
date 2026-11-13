import { CMD } from "../adapters/rpg-maker-mz/command-catalog.js";
import type { NativeCommand } from "../adapters/rpg-maker-mz/native-types.js";
import { hashBytes } from "../project/file-manager.js";
import { invalidInput, McpError, notFound } from "../project/errors.js";
import { compileBlock, compileBlocks, compileList } from "./ir/compiler.js";
import { branchKey, parseCommandList, type BranchInfo, type ParseResult } from "./ir/parser.js";
import { isValidBlockId, type EventBlock } from "./ir/types.js";

/**
 * Minimal native patches for block edits (EVENT_SPEC §6.4, §12.4).
 *
 * Edits splice compiled commands into the existing native list at the range
 * of the addressed block/branch; every other command keeps its exact native
 * object (key order, unknown fields, plugin data). Block ids come from
 * `get_event_logic` and are validated against the list revision.
 */

/** Revision token of a command list (content hash). */
export function listRevision(list: unknown): string {
  return hashBytes(JSON.stringify(list));
}

export function assertRevision(list: unknown, expected: string | undefined, label: string): void {
  if (expected === undefined) {
    throw invalidInput(`A "revision" is required for path-based edits of ${label}. Read it with get_event_logic (it changes whenever the list changes).`);
  }
  const actual = listRevision(list);
  if (actual !== expected) {
    throw new McpError(
      "STALE_REVISION",
      `${label} changed since revision ${expected} (current ${actual}). Block ids may have shifted; call get_event_logic again.`,
      { expected, actual },
    );
  }
}

export type InsertPosition =
  | { before: string }
  | { after: string }
  | { parentId?: string; branch?: string; index?: number };

function branchOf(parsed: ParseResult, parentId: string, branch: string): BranchInfo | undefined {
  return parsed.branches.get(branchKey(parentId, branch));
}

function blockInfo(parsed: ParseResult, id: string) {
  if (!isValidBlockId(id)) throw invalidInput(`Malformed block id ${JSON.stringify(id)} (expected e.g. "3", "3/then/0", "5/choice:1/2").`);
  const info = parsed.blocks.get(id);
  if (!info) throw notFound(`Block ${id} does not exist in this list (it may be inside an opaque raw block, or ids are stale).`);
  return info;
}

/** Resolve an insertion position to (native index, indent, description). */
function resolvePosition(parsed: ParseResult, list: NativeCommand[], pos: InsertPosition): { index: number; indent: number; label: string; createElse?: { at: number; indent: number } } {
  if ("before" in pos && pos.before !== undefined) {
    const b = blockInfo(parsed, pos.before);
    return { index: b.start, indent: b.indent, label: `before ${b.id}` };
  }
  if ("after" in pos && pos.after !== undefined) {
    const b = blockInfo(parsed, pos.after);
    return { index: b.end, indent: b.indent, label: `after ${b.id}` };
  }
  const p = pos as { parentId?: string; branch?: string; index?: number };
  const parentId = p.parentId ?? "";
  const branch = parentId === "" ? "" : (p.branch ?? "");
  if (parentId !== "" && !branch) throw invalidInput(`position.branch is required when parentId is given (e.g. "then", "else", "body", "choice:0", "cancel", "win").`);
  const br = branchOf(parsed, parentId, branch);
  if (!br) {
    const parent = parentId ? parsed.blocks.get(parentId) : undefined;
    if (parent && parent.type === "conditional" && branch === "else") {
      // Create the else branch: insert 411 + body + terminator before the 412 that closes the conditional.
      const endIdx = parent.end - 1;
      if (list[endIdx]?.code !== CMD.BRANCH_END) throw new McpError("MALFORMED_DATA", `Conditional ${parentId} does not end with code 412.`);
      return { index: endIdx, indent: parent.indent + 1, label: `new else branch of ${parentId}`, createElse: { at: endIdx, indent: parent.indent } };
    }
    throw notFound(
      parentId
        ? `Block ${parentId} has no branch "${branch}". Existing branches: ${[...parsed.branches.values()].filter((b) => b.parentId === parentId).map((b) => b.branch).join(", ") || "(none)"}.`
        : "Root branch not found.",
    );
  }
  const count = br.blockIds.length;
  const index = p.index ?? count;
  if (!Number.isInteger(index) || index < 0 || index > count) throw invalidInput(`position.index must be 0..${count} for branch "${branch || "(root)"}" of ${parentId || "the page"}.`);
  const nativeIndex = index < count ? parsed.blocks.get(br.blockIds[index]!)!.start : br.terminator;
  return { index: nativeIndex, indent: br.indent, label: `${parentId ? `${parentId}/${branch}` : "root"} index ${index}` };
}

export interface ListEditResult {
  list: NativeCommand[];
  summary: string;
}

export function insertBlocks(list: NativeCommand[], blocks: EventBlock[], pos: InsertPosition): ListEditResult {
  const parsed = parseCommandList(list);
  assertNoStructuralErrors(parsed);
  const r = resolvePosition(parsed, list, pos);
  const compiled = compileBlocks(blocks, r.indent).commands;
  const insert = r.createElse
    ? [{ code: CMD.ELSE, indent: r.createElse.indent, parameters: [] }, ...compiled, { code: CMD.END, indent: r.createElse.indent + 1, parameters: [] }]
    : compiled;
  const out = [...list.slice(0, r.index), ...insert, ...list.slice(r.index)];
  return { list: out, summary: `Inserted ${blocks.length} block(s) (${compiled.length} native commands) ${r.label}` };
}

export function appendBlocks(list: NativeCommand[], blocks: EventBlock[]): ListEditResult {
  return insertBlocks(list, blocks, { parentId: "" });
}

export function removeBlock(list: NativeCommand[], id: string): ListEditResult {
  const parsed = parseCommandList(list);
  const b = blockInfo(parsed, id);
  const out = [...list.slice(0, b.start), ...list.slice(b.end)];
  return { list: out, summary: `Removed block ${id} (${b.type}, ${b.end - b.start} native commands)` };
}

export function replaceBlock(list: NativeCommand[], id: string, block: EventBlock): ListEditResult {
  const parsed = parseCommandList(list);
  const b = blockInfo(parsed, id);
  const compiled = compileBlock(block, b.indent, id);
  const out = [...list.slice(0, b.start), ...compiled, ...list.slice(b.end)];
  return { list: out, summary: `Replaced block ${id} (${b.type} → ${block.type})` };
}

export function moveBlock(list: NativeCommand[], id: string, pos: InsertPosition): ListEditResult {
  const parsed = parseCommandList(list);
  assertNoStructuralErrors(parsed);
  const b = blockInfo(parsed, id);
  const targetRef = "before" in pos ? pos.before : "after" in pos ? pos.after : (pos as { parentId?: string }).parentId;
  if (targetRef && (targetRef === id || targetRef.startsWith(`${id}/`))) {
    throw invalidInput(`Cannot move block ${id} relative to itself or into its own branches.`);
  }
  const r = resolvePosition(parsed, list, pos);
  if (r.createElse) throw invalidInput("Moving into a not-yet-existing else branch is not supported; insert a block there first.");
  if (r.index > b.start && r.index < b.end) throw invalidInput(`Cannot move block ${id} into itself.`);
  const delta = r.indent - b.indent;
  const slice = list.slice(b.start, b.end).map((c) => rebaseIndent(c, delta));
  const without = [...list.slice(0, b.start), ...list.slice(b.end)];
  const at = r.index > b.start ? r.index - (b.end - b.start) : r.index;
  const out = [...without.slice(0, at), ...slice, ...without.slice(at)];
  return { list: out, summary: `Moved block ${id} (${b.type}) ${r.label}` };
}

/** Replace the complete logic, preserving any commands after the final terminator verbatim. */
export function replaceLogic(list: NativeCommand[], blocks: EventBlock[]): ListEditResult {
  const parsed = parseCommandList(list);
  const compiled = compileList(blocks).commands;
  const trailing = parsed.trailingStart !== null ? list.slice(parsed.trailingStart) : [];
  return { list: [...compiled, ...trailing], summary: `Replaced the complete logic (${blocks.length} top-level block(s), ${compiled.length} native commands)` };
}

function rebaseIndent(c: NativeCommand, delta: number): NativeCommand {
  if (delta === 0) return c;
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(c)) o[k] = k === "indent" ? c.indent + delta : c[k];
  return o as NativeCommand;
}

function assertNoStructuralErrors(parsed: ParseResult): void {
  const errs = parsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    throw new McpError(
      "MALFORMED_DATA",
      `The existing command list is structurally invalid (${errs.map((e) => e.message).join("; ")}). Positional edits are refused; use replace_event_logic to rewrite it intentionally.`,
    );
  }
}

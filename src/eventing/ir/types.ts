/**
 * Event Intermediate Representation (EVENT_SPEC §5.3), version 1.
 *
 * The IR is a tree of semantic blocks. Every block parsed from a page gets an
 * `id` that is its path inside the logic tree, e.g. "3", "3/then/0",
 * "5/choice:1/2". Ids are stable for a given page revision; edits must pass
 * that revision so stale paths are rejected.
 *
 * Branch names: conditional → "then" | "else"; loop → "body";
 * show_choices → "choice:<n>" | "cancel"; battle_processing → "win" |
 * "escape" | "lose".
 *
 * Commands the IR does not model are kept as `raw_command` blocks holding the
 * exact native commands (indent relative to the block).
 */

export const IR_VERSION = 1 as const;

export interface EventLogic {
  irVersion: typeof IR_VERSION;
  blocks: EventBlock[];
}

/** Generic block shape. Concrete fields are documented in docs/EVENT_IR.md and enforced by block definitions. */
export interface EventBlock {
  type: string;
  id?: string;
  [field: string]: unknown;
}

export interface RawNativeCommand {
  code: number;
  /** Indent relative to the raw block's own indent. */
  indent: number;
  parameters: unknown[];
  [extra: string]: unknown;
}

export interface RawCommandBlock extends EventBlock {
  type: "raw_command";
  commands: RawNativeCommand[];
  /** Why the commands are opaque (unknown code, unrecognized parameter shape, malformed structure...). */
  reason?: string;
}

/** Branch slot inside a container block. */
export interface BranchRef {
  /** Owning container id, or "" for the page root. */
  parentId: string;
  branch: string;
}

export function joinId(parentId: string, branch: string, index: number): string {
  return parentId === "" ? String(index) : `${parentId}/${branch}/${index}`;
}

/** Parse a block id into (parent id, branch, index). */
export function splitId(id: string): { parentId: string; branch: string; index: number } {
  const parts = id.split("/");
  if (parts.length === 1) {
    const index = Number(parts[0]);
    return { parentId: "", branch: "", index };
  }
  if (parts.length % 2 === 0) throw new Error(`Malformed block id: ${id}`);
  const index = Number(parts[parts.length - 1]);
  const branch = parts[parts.length - 2]!;
  const parentId = parts.slice(0, -2).join("/");
  return { parentId, branch, index };
}

export function isValidBlockId(id: string): boolean {
  return /^\d+(\/(then|else|body|cancel|win|escape|lose|choice:\d+)\/\d+)*$/.test(id);
}

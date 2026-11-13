import { CMD } from "../../adapters/rpg-maker-mz/command-catalog.js";
import { invalidInput } from "../../project/errors.js";
import { allLeafDefs, leafByType } from "./blocks.js";
import { conditionScripts, type Condition } from "./conditions.js";
import { containerBranches, containerScripts, isContainerType, normalizeContainer } from "./containers.js";
import { asObj, requireScriptAuthorization, type NormalizeContext } from "./input.js";
import { IR_VERSION, type EventBlock, type EventLogic, type RawCommandBlock, type RawNativeCommand } from "./types.js";

/**
 * Agent input → canonical IR. Accepts labels or native values for enums,
 * shorthand forms (e.g. `text` instead of `lines`) and fills editor
 * defaults. Unknown block types or fields are rejected with the JSON path of
 * the problem. Incoming `id` fields are ignored (ids are positional).
 */
export function normalizeBlocks(input: unknown, path: string, ctx: NormalizeContext): EventBlock[] {
  if (!Array.isArray(input)) throw invalidInput(`${path}: expected an array of blocks.`);
  return input.map((b, i) => normalizeBlock(b, `${path}[${i}]`, ctx));
}

/** Input-only aliases accepted in addition to a block's canonical fields. */
const INPUT_ALIASES: Record<string, string[]> = {
  show_text: ["text"],
  show_scrolling_text: ["text"],
  comment: ["text"],
  script: ["script", "text"],
  control_switches: ["switchId"],
  control_variables: ["variableId"],
  transfer_player: ["mapId", "x", "y", "mapVariableId", "xVariableId", "yVariableId"],
  play_bgm: ["audio"],
  play_bgs: ["audio"],
  play_me: ["audio"],
  play_se: ["audio"],
};

const CONTAINER_FIELDS: Record<string, string[]> = {
  conditional: ["condition", "then", "else"],
  loop: ["body"],
  show_choices: ["choices", "cancel", "default", "position", "background", "cancelBlocks"],
  battle_processing: ["troop", "canEscape", "canLose", "win", "escape", "lose"],
  raw_command: ["commands", "reason"],
};

function checkKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, type: string): void {
  const extra = Object.keys(o).filter((k) => k !== "type" && k !== "id" && !allowed.includes(k));
  if (extra.length) {
    throw invalidInput(`${path}: unknown field(s) ${extra.map((k) => JSON.stringify(k)).join(", ")} for ${type}. Allowed: ${allowed.join(", ") || "(none)"}.`);
  }
}

export function normalizeBlock(input: unknown, path: string, ctx: NormalizeContext): EventBlock {
  const o = asObj(input, path);
  const type = o.type;
  if (typeof type !== "string") throw invalidInput(`${path}.type: required string.`);
  if (type === "raw_command") {
    checkKeys(o, CONTAINER_FIELDS.raw_command!, path, type);
    return normalizeRaw(o, path, ctx);
  }
  if (isContainerType(type)) {
    checkKeys(o, CONTAINER_FIELDS[type]!, path, type);
    return normalizeContainer(type, o, path, ctx, (v, p) => normalizeBlocks(v, p, ctx));
  }
  const def = leafByType(type);
  if (!def) {
    throw invalidInput(`${path}.type: unknown block type ${JSON.stringify(type)}. Supported: ${supportedBlockTypes().join(", ")}.`);
  }
  const out = def.normalize(o, path, ctx);
  checkKeys(o, [...Object.keys(out), ...(INPUT_ALIASES[type] ?? []), ...optionalFields(type)], path, type);
  return out;
}

/** Optional fields a block may carry even when normalization omits them. */
function optionalFields(type: string): string[] {
  if (type === "set_movement_route") return ["noDisplayLines", "routeEnd"];
  if (type === "show_text") return ["speakerName"];
  if (type === "change_weapons" || type === "change_armors") return ["includeEquipment"];
  return [];
}

export function normalizeLogic(input: unknown, path: string, ctx: NormalizeContext): EventLogic {
  if (Array.isArray(input)) return { irVersion: IR_VERSION, blocks: normalizeBlocks(input, path, ctx) };
  const o = asObj(input, path);
  if (o.irVersion !== undefined && o.irVersion !== IR_VERSION) {
    throw invalidInput(`${path}.irVersion: unsupported IR version ${JSON.stringify(o.irVersion)} (this server speaks ${IR_VERSION}).`);
  }
  return { irVersion: IR_VERSION, blocks: normalizeBlocks(o.blocks, `${path}.blocks`, ctx) };
}

export function supportedBlockTypes(): string[] {
  return ["conditional", "loop", "show_choices", "battle_processing", ...allLeafDefs().map((d) => d.type), "raw_command"];
}

function normalizeRaw(o: Record<string, unknown>, path: string, ctx: NormalizeContext): RawCommandBlock {
  if (!Array.isArray(o.commands) || o.commands.length === 0) throw invalidInput(`${path}.commands: non-empty array of {code, indent, parameters} required.`);
  const commands = o.commands.map((c, i) => {
    const cp = `${path}.commands[${i}]`;
    const x = asObj(c, cp);
    if (typeof x.code !== "number" || !Number.isInteger(x.code) || x.code < 0) throw invalidInput(`${cp}.code: non-negative integer required.`);
    const indent = x.indent === undefined ? 0 : x.indent;
    if (typeof indent !== "number" || !Number.isInteger(indent) || indent < 0) throw invalidInput(`${cp}.indent: non-negative integer (relative to the block) required.`);
    if (!Array.isArray(x.parameters)) throw invalidInput(`${cp}.parameters: array required.`);
    const out: Record<string, unknown> = {};
    // Keep native key order (code, indent, parameters) then any extra keys.
    out.code = x.code;
    out.indent = indent;
    out.parameters = structuredClone(x.parameters);
    for (const k of Object.keys(x)) if (!(k in out)) out[k] = structuredClone(x[k]);
    return out as RawNativeCommand;
  });
  if (commands[0]!.indent !== 0) throw invalidInput(`${path}.commands[0].indent must be 0 (indents are relative to the block).`);
  for (const s of rawScripts(commands)) requireScriptAuthorization(s, ctx, `${path}.commands`);
  const out: RawCommandBlock = { type: "raw_command", commands };
  if (typeof o.reason === "string") out.reason = o.reason;
  return out;
}

/** Script-bearing content inside raw native commands (script commands, script conditions/operands, route scripts). */
export function rawScripts(commands: readonly { code: number; parameters: unknown[] }[]): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (current) out.push(current.join("\n"));
    current = null;
  };
  for (const c of commands) {
    if (c.code === CMD.SCRIPT) {
      flush();
      current = [String(c.parameters[0])];
      continue;
    }
    if (c.code === CMD.SCRIPT_LINE && current) {
      current.push(String(c.parameters[0]));
      continue;
    }
    flush();
    if (c.code === CMD.CONDITIONAL_BRANCH && c.parameters[0] === 12) out.push(String(c.parameters[1]));
    if (c.code === CMD.CONTROL_VARIABLES && c.parameters[3] === 4) out.push(String(c.parameters[4]));
    if (c.code === CMD.SET_MOVEMENT_ROUTE) {
      const r = c.parameters[1] as { list?: { code: number; parameters?: unknown[] }[] } | undefined;
      for (const rc of r?.list ?? []) if (rc.code === 45) out.push(String(rc.parameters?.[0]));
    }
  }
  flush();
  return out;
}

/** All script texts within a block tree (used to let agents re-submit scripts that already exist). */
export function collectScripts(blocks: readonly EventBlock[], out = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (b.type === "raw_command") for (const s of rawScripts((b as RawCommandBlock).commands)) out.add(s);
    else if (isContainerType(b.type)) {
      for (const s of containerScripts(b)) out.add(s);
      for (const br of containerBranches(b)) collectScripts(br.blocks, out);
    } else {
      for (const s of leafByType(b.type)?.scripts?.(b) ?? []) out.add(s);
    }
  }
  return out;
}

export { conditionScripts };
export type { Condition };

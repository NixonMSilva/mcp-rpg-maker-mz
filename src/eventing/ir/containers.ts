import { CMD } from "../../adapters/rpg-maker-mz/command-catalog.js";
import { ChoicePosition, MessageBackground } from "../../adapters/rpg-maker-mz/enum-catalog.js";
import { invalidInput } from "../../project/errors.js";
import type { NameResolver, Ref } from "../../references/ref-types.js";
import { named, quote } from "./blocks.js";
import { conditionRefs, conditionScripts, describeCondition, normalizeCondition, type Condition } from "./conditions.js";
import { asObj, bool, enumKey, int, str, type NormalizeContext, type Obj } from "./input.js";
import type { EventBlock } from "./types.js";

/**
 * Container blocks (blocks with nested branches). Their native framing is
 * handled by the parser/compiler; this module defines the IR shape,
 * normalization, description and references.
 *
 *  conditional        { condition, then: Block[], else?: Block[] }   (else present ⇔ "Create Else Branch")
 *  loop               { body: Block[] }
 *  show_choices       { choices: {text, blocks}[], cancel: "disallow"|"branch"|<choice index>,
 *                       default: "none"|<choice index>, position, background, cancelBlocks?: Block[] }
 *  battle_processing  { troop: {type:"direct",troopId}|{type:"variable",variableId}|{type:"random_encounter"},
 *                       canEscape, canLose, win?: Block[], escape?: Block[], lose?: Block[] }
 */

export const CONTAINER_TYPES = ["conditional", "loop", "show_choices", "battle_processing"] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number];

export function isContainerType(t: string): t is ContainerType {
  return (CONTAINER_TYPES as readonly string[]).includes(t);
}

export const CONTAINER_CODES: Readonly<Record<number, ContainerType>> = {
  [CMD.CONDITIONAL_BRANCH]: "conditional",
  [CMD.LOOP]: "loop",
  [CMD.SHOW_CHOICES]: "show_choices",
  [CMD.BATTLE_PROCESSING]: "battle_processing",
};

export interface Branch {
  name: string;
  blocks: EventBlock[];
}

/** Ordered branches of a container block (only branches that exist). */
export function containerBranches(b: EventBlock): Branch[] {
  switch (b.type) {
    case "conditional": {
      const out: Branch[] = [{ name: "then", blocks: b.then as EventBlock[] }];
      if (b.else !== undefined) out.push({ name: "else", blocks: b.else as EventBlock[] });
      return out;
    }
    case "loop":
      return [{ name: "body", blocks: b.body as EventBlock[] }];
    case "show_choices": {
      const out: Branch[] = (b.choices as { blocks: EventBlock[] }[]).map((c, i) => ({ name: `choice:${i}`, blocks: c.blocks }));
      if (b.cancelBlocks !== undefined) out.push({ name: "cancel", blocks: b.cancelBlocks as EventBlock[] });
      return out;
    }
    case "battle_processing": {
      const out: Branch[] = [];
      if (b.win !== undefined) out.push({ name: "win", blocks: b.win as EventBlock[] });
      if (b.escape !== undefined) out.push({ name: "escape", blocks: b.escape as EventBlock[] });
      if (b.lose !== undefined) out.push({ name: "lose", blocks: b.lose as EventBlock[] });
      return out;
    }
  }
  return [];
}

/** Get the (mutable) block array for a named branch, or undefined if the branch does not exist. */
export function branchBlocks(b: EventBlock, name: string): EventBlock[] | undefined {
  return containerBranches(b).find((x) => x.name === name)?.blocks;
}

export type BlockListNormalizer = (v: unknown, path: string) => EventBlock[];

function blocksOf(o: Obj, key: string, path: string, norm: BlockListNormalizer, required: boolean): EventBlock[] | undefined {
  const v = o[key];
  if (v === undefined) return required ? [] : undefined;
  return norm(v, `${path}.${key}`);
}

export function normalizeContainer(type: ContainerType, o: Obj, path: string, ctx: NormalizeContext, norm: BlockListNormalizer): EventBlock {
  switch (type) {
    case "conditional": {
      const b: EventBlock = { type, condition: normalizeCondition(o.condition, `${path}.condition`, ctx), then: blocksOf(o, "then", path, norm, true) };
      const els = blocksOf(o, "else", path, norm, false);
      if (els !== undefined) b.else = els;
      return b;
    }
    case "loop":
      return { type, body: blocksOf(o, "body", path, norm, true) };
    case "show_choices": {
      if (!Array.isArray(o.choices) || o.choices.length === 0) throw invalidInput(`${path}.choices: at least one choice is required.`);
      const choices = o.choices.map((c, i) => {
        const cp = `${path}.choices[${i}]`;
        if (typeof c === "string") return { text: c, blocks: [] as EventBlock[] };
        const co = asObj(c, cp);
        return { text: str(co, "text", cp), blocks: blocksOf(co, "blocks", cp, norm, true)! };
      });
      const n = choices.length;
      let cancel: string | number;
      const rc = o.cancel ?? (o.cancelBlocks !== undefined ? "branch" : n - 1);
      if (rc === "disallow" || rc === "branch") cancel = rc;
      else if (typeof rc === "number" && Number.isInteger(rc) && rc >= 0 && rc < n) cancel = rc;
      else throw invalidInput(`${path}.cancel must be "disallow", "branch" or a choice index 0..${n - 1}.`);
      let def: string | number;
      const rd = o.default ?? 0;
      if (rd === "none") def = "none";
      else if (typeof rd === "number" && Number.isInteger(rd) && rd >= 0 && rd < n) def = rd;
      else throw invalidInput(`${path}.default must be "none" or a choice index 0..${n - 1}.`);
      const b: EventBlock = {
        type,
        choices,
        cancel,
        default: def,
        position: ChoicePosition.key(enumKey(o, "position", path, ChoicePosition, 2)),
        background: MessageBackground.key(enumKey(o, "background", path, MessageBackground, 0)),
      };
      if (cancel === "branch") b.cancelBlocks = blocksOf(o, "cancelBlocks", path, norm, true);
      else if (o.cancelBlocks !== undefined) throw invalidInput(`${path}.cancelBlocks is only allowed when cancel is "branch".`);
      return b;
    }
    case "battle_processing": {
      const tp = `${path}.troop`;
      const t = typeof o.troop === "number" ? { type: "direct", troopId: o.troop } : asObj(o.troop, tp);
      let troop: Obj;
      if (t.type === "variable") troop = { type: "variable", variableId: int(t, "variableId", tp, { min: 1 }) };
      else if (t.type === "random_encounter") troop = { type: "random_encounter" };
      else troop = { type: "direct", troopId: int(t, "troopId", tp, { min: 1 }) };
      const canEscape = bool(o, "canEscape", path, false);
      const canLose = bool(o, "canLose", path, false);
      const b: EventBlock = { type, troop, canEscape, canLose };
      if (canEscape || canLose) {
        b.win = blocksOf(o, "win", path, norm, true);
        if (canEscape) b.escape = blocksOf(o, "escape", path, norm, true);
        if (canLose) b.lose = blocksOf(o, "lose", path, norm, true);
      } else {
        for (const k of ["win", "escape", "lose"]) {
          const v = o[k];
          if (Array.isArray(v) && v.length > 0) throw invalidInput(`${path}.${k}: battle branches exist only when canEscape or canLose is true.`);
        }
      }
      if (!canEscape && o.escape !== undefined && Array.isArray(o.escape) && o.escape.length) throw invalidInput(`${path}.escape requires canEscape=true.`);
      if (!canLose && o.lose !== undefined && Array.isArray(o.lose) && o.lose.length) throw invalidInput(`${path}.lose requires canLose=true.`);
      return b;
    }
  }
}

// ---- native encodings of container headers ----

export function encodeChoicesParams(b: EventBlock): unknown[] {
  const choices = b.choices as { text: string }[];
  const cancel = b.cancel === "disallow" ? -1 : b.cancel === "branch" ? -2 : (b.cancel as number);
  const def = b.default === "none" ? -1 : (b.default as number);
  return [choices.map((c) => c.text), cancel, def, ChoicePosition.parse(b.position), MessageBackground.parse(b.background)];
}

export function decodeChoicesParams(p: unknown[]): { choices: string[]; cancel: string | number; default: string | number; position: string; background: string } | null {
  if (p.length !== 5 || !Array.isArray(p[0]) || !p[0].every((x) => typeof x === "string")) return null;
  const n = p[0].length;
  const [_, c, d, pos, bg] = p;
  if (typeof c !== "number" || typeof d !== "number" || !ChoicePosition.has(pos) || !MessageBackground.has(bg)) return null;
  let cancel: string | number;
  if (c === -1) cancel = "disallow";
  else if (c === -2) cancel = "branch";
  else if (Number.isInteger(c) && c >= 0 && c < n) cancel = c;
  else return null;
  let def: string | number;
  if (d === -1) def = "none";
  else if (Number.isInteger(d) && d >= 0 && d < n) def = d;
  else return null;
  return { choices: p[0] as string[], cancel, default: def, position: ChoicePosition.key(pos), background: MessageBackground.key(bg) };
}

export function encodeBattleParams(b: EventBlock): unknown[] {
  const t = b.troop as Obj;
  const head = t.type === "direct" ? [0, t.troopId] : t.type === "variable" ? [1, t.variableId] : [2, 0];
  return [...head, b.canEscape, b.canLose];
}

export function decodeBattleParams(p: unknown[]): { troop: Obj; canEscape: boolean; canLose: boolean } | null {
  if (p.length !== 4 || typeof p[1] !== "number" || typeof p[2] !== "boolean" || typeof p[3] !== "boolean") return null;
  let troop: Obj;
  if (p[0] === 0) troop = { type: "direct", troopId: p[1] };
  else if (p[0] === 1) troop = { type: "variable", variableId: p[1] };
  else if (p[0] === 2 && p[1] === 0) troop = { type: "random_encounter" };
  else return null;
  return { troop, canEscape: p[2], canLose: p[3] };
}

// ---- describe / refs ----

export function describeContainerHeader(b: EventBlock, n: NameResolver): string {
  switch (b.type) {
    case "conditional":
      return `If: ${describeCondition(b.condition as Condition, n)}`;
    case "loop":
      return "Loop";
    case "show_choices": {
      const choices = (b.choices as { text: string }[]).map((c) => quote(c.text, 40)).join(", ");
      return `Show Choices: [${choices}] (cancel: ${b.cancel}, default: ${b.default}, ${b.position}, ${b.background})`;
    }
    case "battle_processing": {
      const t = b.troop as Obj;
      const troop =
        t.type === "direct" ? named("troop", t.troopId as number, n) : t.type === "variable" ? `Troop in ${named("variable", t.variableId as number, n)}` : "Same as Random Encounters";
      const flags = [b.canEscape ? "can escape" : "", b.canLose ? "can lose" : ""].filter(Boolean).join(", ");
      return `Battle Processing: ${troop}${flags ? ` (${flags})` : ""}`;
    }
  }
  return b.type;
}

export function describeBranchHeader(b: EventBlock, branch: string): string {
  if (b.type === "conditional") return branch === "then" ? "Then" : "Else";
  if (b.type === "loop") return "Body";
  if (b.type === "show_choices") {
    if (branch === "cancel") return "When Cancel";
    const i = Number(branch.split(":")[1]);
    return `When ${quote((b.choices as { text: string }[])[i]?.text ?? "?", 60)}`;
  }
  if (b.type === "battle_processing") return branch === "win" ? "If Win" : branch === "escape" ? "If Escape" : "If Lose";
  return branch;
}

export function containerRefs(b: EventBlock): Ref[] {
  if (b.type === "conditional") return conditionRefs(b.condition as Condition);
  if (b.type === "battle_processing") {
    const t = b.troop as Obj;
    if (t.type === "direct") return [{ kind: "troop", id: t.troopId as number, role: "use" }];
    if (t.type === "variable") return [{ kind: "variable", id: t.variableId as number, role: "read" }];
  }
  return [];
}

export function containerScripts(b: EventBlock): string[] {
  return b.type === "conditional" ? conditionScripts(b.condition as Condition) : [];
}

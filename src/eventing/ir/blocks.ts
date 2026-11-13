import { CMD, ROUTE_COMMANDS, routeCommandByCode, routeCommandByName } from "../../adapters/rpg-maker-mz/command-catalog.js";
import {
  AddRemove,
  BalloonId,
  ChoicePosition,
  Direction,
  DirectionOrRetain,
  FadeType,
  IncreaseDecrease,
  ItemChoiceType,
  MessageBackground,
  MessagePosition,
  MzEnum,
  OnOff,
  SelfSwitchCh,
  ShopGoodsType,
  VariableOperation,
  characterLabel,
  parseCharacter,
} from "../../adapters/rpg-maker-mz/enum-catalog.js";
import { invalidInput } from "../../project/errors.js";
import type { NameResolver, Ref, RefKind } from "../../references/ref-types.js";
import {
  asObj,
  audio,
  bool,
  enumKey,
  has,
  int,
  num,
  requireScriptAuthorization,
  str,
  textLines,
  type NormalizeContext,
  type Obj,
} from "./input.js";
import type { EventBlock } from "./types.js";

/**
 * Leaf block definitions: one entry per supported native command (or
 * command + continuation lines). Each definition documents its fields and
 * provides:
 *   decode    native params (+ continuation line params) → IR block, or null
 *             when the parameter shape is not recognized (→ raw_command)
 *   encode    IR block → native params (+ continuation line params)
 *   normalize agent input → canonical IR block (labels → values, defaults)
 *   describe  one-line human summary
 *   refs      references to project entities
 *
 * The parser verifies encode(decode(x)) === x for every block; anything that
 * does not round-trip exactly is kept as raw_command instead.
 */

export interface Encoded {
  code: number;
  params: unknown[];
  /** Parameters of continuation lines (each line becomes one native command with the def's continuation code). */
  lines?: unknown[][];
}

export interface LeafDef {
  type: string;
  /** Native codes this definition decodes. */
  codes: number[];
  /** Continuation line code, if the command has continuation lines. */
  continuation?: number;
  /** Field documentation (agent-facing). */
  doc: string;
  decode(code: number, params: unknown[], lines: unknown[][]): EventBlock | null;
  encode(b: EventBlock): Encoded;
  normalize(o: Obj, path: string, ctx: NormalizeContext): EventBlock;
  describe(b: EventBlock, n: NameResolver): string;
  refs?(b: EventBlock): Ref[];
  /** Script texts contained in the block (for authorization checks). */
  scripts?(b: EventBlock): string[];
}

// ------------------------------------------------------------------ helpers

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isObjV = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export function named(kind: RefKind, id: number | string, n: NameResolver, label?: string): string {
  const base = `${label ?? kindLabel(kind)} ${id}`;
  const nm = n.name(kind, id);
  return nm ? `${base} [${nm}]` : base;
}

function kindLabel(kind: RefKind): string {
  const map: Partial<Record<RefKind, string>> = {
    switch: "Switch",
    variable: "Variable",
    self_switch: "Self Switch",
    item: "Item",
    weapon: "Weapon",
    armor: "Armor",
    actor: "Actor",
    class: "Class",
    skill: "Skill",
    state: "State",
    enemy: "Enemy",
    troop: "Troop",
    animation: "Animation",
    common_event: "Common Event",
    map: "Map",
    event: "Event",
  };
  return map[kind] ?? kind;
}

function charName(id: number, n: NameResolver): string {
  if (id <= 0) return characterLabel(id);
  const nm = n.name("event", id);
  return nm ? `Event ${id} [${nm}]` : `Event ${id}`;
}

function charRefs(id: number): Ref[] {
  return id > 0 ? [{ kind: "event", id, role: "use" }] : [];
}

function quote(s: string, max = 60): string {
  const t = s.length > max ? `${s.slice(0, max)}…` : s;
  return JSON.stringify(t);
}

function range(start: number, end: number): string {
  return start === end ? String(start) : `${start}..${end}`;
}

function enumFrom<V extends number | string>(en: MzEnum<V>, v: unknown): string | null {
  return en.has(v) ? en.key(v) : null;
}

// ---- operands ----------------------------------------------------------

/** [operandType, operand] used by gold/items/HP...: 0 = constant, 1 = variable. */
export type Operand = { type: "constant"; value: number } | { type: "variable"; variableId: number };

function decodeOperand(type: unknown, value: unknown): Operand | null {
  if (type === 0 && isInt(value)) return { type: "constant", value };
  if (type === 1 && isInt(value)) return { type: "variable", variableId: value };
  return null;
}

function encodeOperand(o: Operand): [number, number] {
  return o.type === "constant" ? [0, o.value] : [1, o.variableId];
}

export function normalizeOperand(v: unknown, path: string): Operand {
  if (isInt(v)) return { type: "constant", value: v };
  const o = asObj(v, path);
  if (o.type === "constant" || (o.type === undefined && has(o, "value"))) return { type: "constant", value: int(o, "value", path) };
  if (o.type === "variable" || (o.type === undefined && has(o, "variableId"))) return { type: "variable", variableId: int(o, "variableId", path, { min: 1 }) };
  throw invalidInput(`${path}: operand must be an integer, {type:"constant", value} or {type:"variable", variableId}.`);
}

function describeOperand(o: Operand, n: NameResolver): string {
  return o.type === "constant" ? String(o.value) : named("variable", o.variableId, n);
}

function operandRefs(o: Operand): Ref[] {
  return o.type === "variable" ? [{ kind: "variable", id: o.variableId, role: "read" }] : [];
}

// ---- actor targets (iterateActorEx) ---------------------------------------

export type ActorTarget = { type: "fixed"; actorId: number } | { type: "variable"; variableId: number };

function decodeActorTarget(d: unknown, id: unknown): ActorTarget | null {
  if (d === 0 && isInt(id)) return { type: "fixed", actorId: id };
  if (d === 1 && isInt(id)) return { type: "variable", variableId: id };
  return null;
}

function encodeActorTarget(t: ActorTarget): [number, number] {
  return t.type === "fixed" ? [0, t.actorId] : [1, t.variableId];
}

function normalizeActorTarget(v: unknown, path: string): ActorTarget {
  if (isInt(v)) return { type: "fixed", actorId: v };
  if (isStr(v) && /^(entire_?party|party|all)$/i.test(v)) return { type: "fixed", actorId: 0 };
  const o = asObj(v, path);
  if (o.type === "variable" || (o.type === undefined && has(o, "variableId"))) return { type: "variable", variableId: int(o, "variableId", path, { min: 1 }) };
  return { type: "fixed", actorId: int(o, "actorId", path, { min: 0 }) };
}

function describeActorTarget(t: ActorTarget, n: NameResolver): string {
  if (t.type === "variable") return `Actor in ${named("variable", t.variableId, n)}`;
  return t.actorId === 0 ? "Entire Party" : named("actor", t.actorId, n);
}

function actorTargetRefs(t: ActorTarget): Ref[] {
  if (t.type === "variable") return [{ kind: "variable", id: t.variableId, role: "read" }];
  return t.actorId > 0 ? [{ kind: "actor", id: t.actorId, role: "use" }] : [];
}

// ---- audio -----------------------------------------------------------------

function isAudio(v: unknown): v is { name: string; volume: number; pitch: number; pan: number } {
  return isObjV(v) && isStr(v.name) && isNum(v.volume) && isNum(v.pitch) && isNum(v.pan);
}

function describeAudio(a: Obj): string {
  const name = String(a.name ?? "") || "(None)";
  return `${name} (${a.volume}, ${a.pitch}, ${a.pan})`;
}

// ------------------------------------------------------------------ registry

const defs: LeafDef[] = [];
function def(d: LeafDef): void {
  defs.push(d);
}

/** Commands with no parameters. */
function noParam(type: string, code: number, label: string): void {
  def({
    type,
    codes: [code],
    doc: "{} (no fields)",
    decode: (_c, p) => (p.length === 0 ? { type } : null),
    encode: () => ({ code, params: [] }),
    normalize: () => ({ type }),
    describe: () => label,
  });
}

// ------------------------------------------------------------- dialogue

def({
  type: "show_text",
  codes: [CMD.SHOW_TEXT],
  continuation: CMD.TEXT_LINE,
  doc: '{ faceName?: string="", faceIndex?: 0-7=0, background?: "window"|"dim"|"transparent"="window", position?: "top"|"middle"|"bottom"="bottom", speakerName?: string="", text: string | lines: string[] }',
  decode(_c, p, lines) {
    if (p.length < 4 || p.length > 5) return null;
    const [face, idx, bg, pos, speaker] = p;
    const bgK = enumFrom(MessageBackground, bg);
    const posK = enumFrom(MessagePosition, pos);
    if (!isStr(face) || !isInt(idx) || !bgK || !posK) return null;
    if (p.length === 5 && !isStr(speaker)) return null;
    if (!lines.every((l) => l.length === 1 && isStr(l[0]))) return null;
    const b: EventBlock = { type: "show_text", faceName: face, faceIndex: idx, background: bgK, position: posK };
    if (p.length === 5) b.speakerName = speaker;
    b.lines = lines.map((l) => l[0] as string);
    return b;
  },
  encode(b) {
    const params: unknown[] = [b.faceName, b.faceIndex, MessageBackground.parse(b.background), MessagePosition.parse(b.position)];
    if (b.speakerName !== undefined) params.push(b.speakerName);
    return { code: CMD.SHOW_TEXT, params, lines: (b.lines as string[]).map((l) => [l]) };
  },
  normalize(o, path) {
    return {
      type: "show_text",
      faceName: str(o, "faceName", path, ""),
      faceIndex: int(o, "faceIndex", path, { min: 0, max: 7, def: 0 }),
      background: MessageBackground.key(enumKey(o, "background", path, MessageBackground, 0)),
      position: MessagePosition.key(enumKey(o, "position", path, MessagePosition, 2)),
      speakerName: str(o, "speakerName", path, ""),
      lines: textLines(o, path),
    };
  },
  describe(b) {
    const face = b.faceName ? `${b.faceName}(${b.faceIndex})` : "no face";
    const speaker = b.speakerName ? `, speaker ${quote(String(b.speakerName))}` : "";
    return `Show Text [${face}, ${b.background}, ${b.position}${speaker}]: ${(b.lines as string[]).map((l) => quote(l, 80)).join(" / ")}`;
  },
});

def({
  type: "show_scrolling_text",
  codes: [CMD.SHOW_SCROLLING_TEXT],
  continuation: CMD.SCROLLING_TEXT_LINE,
  doc: "{ speed?: 1-8=2, noFastForward?: boolean=false, text | lines }",
  decode(_c, p, lines) {
    if (p.length !== 2 || !isInt(p[0]) || !isBool(p[1])) return null;
    if (!lines.every((l) => l.length === 1 && isStr(l[0]))) return null;
    return { type: "show_scrolling_text", speed: p[0], noFastForward: p[1], lines: lines.map((l) => l[0] as string) };
  },
  encode: (b) => ({ code: CMD.SHOW_SCROLLING_TEXT, params: [b.speed, b.noFastForward], lines: (b.lines as string[]).map((l) => [l]) }),
  normalize: (o, path) => ({
    type: "show_scrolling_text",
    speed: int(o, "speed", path, { min: 1, max: 8, def: 2 }),
    noFastForward: bool(o, "noFastForward", path, false),
    lines: textLines(o, path),
  }),
  describe: (b) => `Show Scrolling Text [speed ${b.speed}${b.noFastForward ? ", no fast forward" : ""}]: ${(b.lines as string[]).map((l) => quote(l)).join(" / ")}`,
});

def({
  type: "input_number",
  codes: [CMD.INPUT_NUMBER],
  doc: "{ variableId: number, digits: 1-8 }",
  decode: (_c, p) => (p.length === 2 && isInt(p[0]) && isInt(p[1]) ? { type: "input_number", variableId: p[0], digits: p[1] } : null),
  encode: (b) => ({ code: CMD.INPUT_NUMBER, params: [b.variableId, b.digits] }),
  normalize: (o, path) => ({ type: "input_number", variableId: int(o, "variableId", path, { min: 1 }), digits: int(o, "digits", path, { min: 1, max: 8, def: 1 }) }),
  describe: (b, n) => `Input Number: ${named("variable", b.variableId as number, n)}, ${b.digits} digit(s)`,
  refs: (b) => [{ kind: "variable", id: b.variableId as number, role: "write" }],
});

def({
  type: "select_item",
  codes: [CMD.SELECT_ITEM],
  doc: '{ variableId: number, itemType?: "regular_item"|"key_item"|"hidden_item_a"|"hidden_item_b"="key_item" }',
  decode(_c, p) {
    if (p.length !== 2 || !isInt(p[0])) return null;
    const k = enumFrom(ItemChoiceType, p[1]);
    return k ? { type: "select_item", variableId: p[0], itemType: k } : null;
  },
  encode: (b) => ({ code: CMD.SELECT_ITEM, params: [b.variableId, ItemChoiceType.parse(b.itemType)] }),
  normalize: (o, path) => ({
    type: "select_item",
    variableId: int(o, "variableId", path, { min: 1 }),
    itemType: ItemChoiceType.key(enumKey(o, "itemType", path, ItemChoiceType, 2)),
  }),
  describe: (b, n) => `Select Item: ${named("variable", b.variableId as number, n)}, ${b.itemType}`,
  refs: (b) => [{ kind: "variable", id: b.variableId as number, role: "write" }],
});

// ------------------------------------------------------------- flow control

def({
  type: "comment",
  codes: [CMD.COMMENT],
  continuation: CMD.COMMENT_LINE,
  doc: "{ text | lines }",
  decode(_c, p, lines) {
    if (p.length !== 1 || !isStr(p[0]) || !lines.every((l) => l.length === 1 && isStr(l[0]))) return null;
    return { type: "comment", lines: [p[0], ...lines.map((l) => l[0] as string)] };
  },
  encode(b) {
    const ls = b.lines as string[];
    return { code: CMD.COMMENT, params: [ls[0] ?? ""], lines: ls.slice(1).map((l) => [l]) };
  },
  normalize: (o, path) => ({ type: "comment", lines: textLines(o, path) }),
  describe: (b) => `Comment: ${(b.lines as string[]).map((l) => quote(l)).join(" / ")}`,
});

noParam("break_loop", CMD.BREAK_LOOP, "Break Loop");
noParam("exit_event_processing", CMD.EXIT_EVENT_PROCESSING, "Exit Event Processing");

def({
  type: "label",
  codes: [CMD.LABEL],
  doc: "{ name: string }",
  decode: (_c, p) => (p.length === 1 && isStr(p[0]) ? { type: "label", name: p[0] } : null),
  encode: (b) => ({ code: CMD.LABEL, params: [b.name] }),
  normalize: (o, path) => ({ type: "label", name: str(o, "name", path) }),
  describe: (b) => `Label: ${quote(String(b.name))}`,
});

def({
  type: "jump_to_label",
  codes: [CMD.JUMP_TO_LABEL],
  doc: "{ name: string }",
  decode: (_c, p) => (p.length === 1 && isStr(p[0]) ? { type: "jump_to_label", name: p[0] } : null),
  encode: (b) => ({ code: CMD.JUMP_TO_LABEL, params: [b.name] }),
  normalize: (o, path) => ({ type: "jump_to_label", name: str(o, "name", path) }),
  describe: (b) => `Jump to Label: ${quote(String(b.name))}`,
  refs: (b) => [{ kind: "label", id: String(b.name), role: "use" }],
});

def({
  type: "call_common_event",
  codes: [CMD.COMMON_EVENT],
  doc: "{ commonEventId: number }",
  decode: (_c, p) => (p.length === 1 && isInt(p[0]) ? { type: "call_common_event", commonEventId: p[0] } : null),
  encode: (b) => ({ code: CMD.COMMON_EVENT, params: [b.commonEventId] }),
  normalize: (o, path) => ({ type: "call_common_event", commonEventId: int(o, "commonEventId", path, { min: 1 }) }),
  describe: (b, n) => `Common Event: ${named("common_event", b.commonEventId as number, n)}`,
  refs: (b) => [{ kind: "common_event", id: b.commonEventId as number, role: "call" }],
});

// ------------------------------------------------------------- game state

def({
  type: "control_switches",
  codes: [CMD.CONTROL_SWITCHES],
  doc: '{ switchId: number | startId+endId: number, value: "on"|"off" }',
  decode(_c, p) {
    if (p.length !== 3 || !isInt(p[0]) || !isInt(p[1])) return null;
    const v = enumFrom(OnOff, p[2]);
    return v ? { type: "control_switches", startId: p[0], endId: p[1], value: v } : null;
  },
  encode: (b) => ({ code: CMD.CONTROL_SWITCHES, params: [b.startId, b.endId, OnOff.parse(b.value)] }),
  normalize(o, path) {
    const start = has(o, "switchId") ? int(o, "switchId", path, { min: 1 }) : int(o, "startId", path, { min: 1 });
    const end = has(o, "endId") ? int(o, "endId", path, { min: start }) : start;
    return { type: "control_switches", startId: start, endId: end, value: OnOff.key(enumKey(o, "value", path, OnOff)) };
  },
  describe(b, n) {
    const target = b.startId === b.endId ? named("switch", b.startId as number, n) : `Switches ${range(b.startId as number, b.endId as number)}`;
    return `Control Switches: ${target} = ${String(b.value).toUpperCase()}`;
  },
  refs(b) {
    const out: Ref[] = [];
    for (let i = b.startId as number; i <= (b.endId as number) && out.length < 1000; i++) out.push({ kind: "switch", id: i, role: "write" });
    return out;
  },
});

const GameDataSource = new MzEnum("source", [
  { value: 0, label: "item" },
  { value: 1, label: "weapon" },
  { value: 2, label: "armor" },
  { value: 3, label: "actor" },
  { value: 4, label: "enemy" },
  { value: 5, label: "character" },
  { value: 6, label: "party" },
  { value: 7, label: "other" },
  { value: 8, label: "last" },
]);

type VarOperand =
  | { type: "constant"; value: number }
  | { type: "variable"; variableId: number }
  | { type: "random"; min: number; max: number }
  | { type: "game_data"; source: string; param1: number; param2: number }
  | { type: "script"; script: string };

def({
  type: "control_variables",
  codes: [CMD.CONTROL_VARIABLES],
  doc: '{ variableId | startId+endId, operation: "set"|"add"|"sub"|"mul"|"div"|"mod", operand: number | {type:"constant",value} | {type:"variable",variableId} | {type:"random",min,max} | {type:"game_data",source:"item"|"weapon"|"armor"|"actor"|"enemy"|"character"|"party"|"other"|"last",param1,param2} | {type:"script",script} }',
  decode(_c, p) {
    if (p.length < 5 || !isInt(p[0]) || !isInt(p[1])) return null;
    const op = enumFrom(VariableOperation, p[2]);
    if (!op) return null;
    let operand: VarOperand | null = null;
    switch (p[3]) {
      case 0:
        if (p.length === 5 && isNum(p[4])) operand = { type: "constant", value: p[4] };
        break;
      case 1:
        if (p.length === 5 && isInt(p[4])) operand = { type: "variable", variableId: p[4] };
        break;
      case 2:
        if (p.length === 6 && isInt(p[4]) && isInt(p[5])) operand = { type: "random", min: p[4], max: p[5] };
        break;
      case 3:
        if (p.length === 7 && GameDataSource.has(p[4]) && isInt(p[5]) && isInt(p[6]))
          operand = { type: "game_data", source: GameDataSource.key(p[4]), param1: p[5], param2: p[6] };
        break;
      case 4:
        if (p.length === 5 && isStr(p[4])) operand = { type: "script", script: p[4] };
        break;
    }
    return operand ? { type: "control_variables", startId: p[0], endId: p[1], operation: op, operand } : null;
  },
  encode(b) {
    const o = b.operand as VarOperand;
    const head = [b.startId, b.endId, VariableOperation.parse(b.operation)];
    switch (o.type) {
      case "constant":
        return { code: CMD.CONTROL_VARIABLES, params: [...head, 0, o.value] };
      case "variable":
        return { code: CMD.CONTROL_VARIABLES, params: [...head, 1, o.variableId] };
      case "random":
        return { code: CMD.CONTROL_VARIABLES, params: [...head, 2, o.min, o.max] };
      case "game_data":
        return { code: CMD.CONTROL_VARIABLES, params: [...head, 3, GameDataSource.parse(o.source), o.param1, o.param2] };
      case "script":
        return { code: CMD.CONTROL_VARIABLES, params: [...head, 4, o.script] };
    }
  },
  normalize(o, path, ctx) {
    const start = has(o, "variableId") ? int(o, "variableId", path, { min: 1 }) : int(o, "startId", path, { min: 1 });
    const end = has(o, "endId") ? int(o, "endId", path, { min: start }) : start;
    const operation = VariableOperation.key(enumKey(o, "operation", path, VariableOperation, 0));
    const raw = o.operand;
    const p = `${path}.operand`;
    let operand: VarOperand;
    if (isNum(raw)) operand = { type: "constant", value: raw };
    else {
      const x = asObj(raw, p);
      switch (x.type) {
        case "constant":
          operand = { type: "constant", value: num(x, "value", p) };
          break;
        case "variable":
          operand = { type: "variable", variableId: int(x, "variableId", p, { min: 1 }) };
          break;
        case "random": {
          const min = int(x, "min", p);
          operand = { type: "random", min, max: int(x, "max", p, { min }) };
          break;
        }
        case "game_data":
          operand = {
            type: "game_data",
            source: GameDataSource.key(enumKey(x, "source", p, GameDataSource)),
            param1: int(x, "param1", p, { def: 0 }),
            param2: int(x, "param2", p, { def: 0 }),
          };
          break;
        case "script": {
          const script = str(x, "script", p);
          requireScriptAuthorization(script, ctx, p);
          operand = { type: "script", script };
          break;
        }
        default:
          throw invalidInput(`${p}.type must be constant|variable|random|game_data|script.`);
      }
    }
    return { type: "control_variables", startId: start, endId: end, operation, operand };
  },
  describe(b, n) {
    const target = b.startId === b.endId ? named("variable", b.startId as number, n) : `Variables ${range(b.startId as number, b.endId as number)}`;
    const opSym: Record<string, string> = { set: "=", add: "+=", sub: "-=", mul: "*=", div: "/=", mod: "%=" };
    const o = b.operand as VarOperand;
    let rhs: string;
    switch (o.type) {
      case "constant":
        rhs = String(o.value);
        break;
      case "variable":
        rhs = named("variable", o.variableId, n);
        break;
      case "random":
        rhs = `Random ${o.min}..${o.max}`;
        break;
      case "game_data":
        rhs = describeGameData(o, n);
        break;
      case "script":
        rhs = `Script ${quote(o.script)}`;
        break;
    }
    return `Control Variables: ${target} ${opSym[String(b.operation)] ?? b.operation} ${rhs}`;
  },
  refs(b) {
    const out: Ref[] = [];
    for (let i = b.startId as number; i <= (b.endId as number) && out.length < 1000; i++) out.push({ kind: "variable", id: i, role: "write" });
    const o = b.operand as VarOperand;
    if (o.type === "variable") out.push({ kind: "variable", id: o.variableId, role: "read" });
    if (o.type === "game_data") {
      const k: Record<string, RefKind> = { item: "item", weapon: "weapon", armor: "armor", actor: "actor" };
      const kind = k[o.source];
      if (kind) out.push({ kind, id: o.param1, role: "read" });
      if (o.source === "character" && o.param1 > 0) out.push({ kind: "event", id: o.param1, role: "read" });
    }
    if (o.type === "script") out.push({ kind: "variable", id: "(script)", role: "read", origin: "unknown", via: "script operand (opaque)" });
    return out;
  },
  scripts: (b) => ((b.operand as VarOperand).type === "script" ? [(b.operand as { script: string }).script] : []),
});

function describeGameData(o: { source: string; param1: number; param2: number }, n: NameResolver): string {
  const actorParams = ["Level", "EXP", "HP", "MP", "Max HP", "Max MP", "Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck", "TP"];
  const enemyParams = ["HP", "MP", "Max HP", "Max MP", "Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck", "TP"];
  const charParams = ["Map X", "Map Y", "Direction", "Screen X", "Screen Y"];
  const other = ["Map ID", "Party Members", "Gold", "Steps", "Play Time", "Timer", "Save Count", "Battle Count", "Win Count", "Escape Count"];
  const last = ["Last Used Skill ID", "Last Used Item ID", "Last Actor ID to Act", "Last Enemy Index to Act", "Last Target Actor ID", "Last Target Enemy Index"];
  switch (o.source) {
    case "item":
      return `Count of ${named("item", o.param1, n)}`;
    case "weapon":
      return `Count of ${named("weapon", o.param1, n)}`;
    case "armor":
      return `Count of ${named("armor", o.param1, n)}`;
    case "actor":
      return `${actorParams[o.param2] ?? `param ${o.param2}`} of ${named("actor", o.param1, n)}`;
    case "enemy":
      return `${enemyParams[o.param2] ?? `param ${o.param2}`} of Enemy #${o.param1 + 1}`;
    case "character":
      return `${charParams[o.param2] ?? `param ${o.param2}`} of ${charName(o.param1, n)}`;
    case "party":
      return `Actor ID of party member #${o.param1 + 1}`;
    case "other":
      return other[o.param1] ?? `Other ${o.param1}`;
    case "last":
      return last[o.param1] ?? `Last ${o.param1}`;
  }
  return `Game data ${o.source}`;
}

def({
  type: "control_self_switch",
  codes: [CMD.CONTROL_SELF_SWITCH],
  doc: '{ selfSwitch: "A"|"B"|"C"|"D", value: "on"|"off" }',
  decode(_c, p) {
    if (p.length !== 2 || !SelfSwitchCh.has(p[0])) return null;
    const v = enumFrom(OnOff, p[1]);
    return v ? { type: "control_self_switch", selfSwitch: p[0], value: v } : null;
  },
  encode: (b) => ({ code: CMD.CONTROL_SELF_SWITCH, params: [b.selfSwitch, OnOff.parse(b.value)] }),
  normalize: (o, path) => ({
    type: "control_self_switch",
    selfSwitch: enumKey(o, "selfSwitch", path, SelfSwitchCh),
    value: OnOff.key(enumKey(o, "value", path, OnOff)),
  }),
  describe: (b) => `Control Self Switch: ${b.selfSwitch} = ${String(b.value).toUpperCase()}`,
  refs: (b) => [{ kind: "self_switch", id: String(b.selfSwitch), role: "write" }],
});

def({
  type: "change_gold",
  codes: [CMD.CHANGE_GOLD],
  doc: '{ operation: "increase"|"decrease", operand: number | {type:"variable",variableId} }',
  decode(_c, p) {
    if (p.length !== 3) return null;
    const op = enumFrom(IncreaseDecrease, p[0]);
    const operand = decodeOperand(p[1], p[2]);
    return op && operand ? { type: "change_gold", operation: op, operand } : null;
  },
  encode: (b) => ({ code: CMD.CHANGE_GOLD, params: [IncreaseDecrease.parse(b.operation), ...encodeOperand(b.operand as Operand)] }),
  normalize: (o, path) => ({
    type: "change_gold",
    operation: IncreaseDecrease.key(enumKey(o, "operation", path, IncreaseDecrease, 0)),
    operand: normalizeOperand(o.operand, `${path}.operand`),
  }),
  describe: (b, n) => `Change Gold: ${b.operation === "increase" ? "+" : "-"} ${describeOperand(b.operand as Operand, n)}`,
  refs: (b) => operandRefs(b.operand as Operand),
});

function itemLike(type: string, code: number, idField: string, kind: RefKind, label: string, withEquip: boolean): void {
  def({
    type,
    codes: [code],
    doc: `{ ${idField}: number, operation: "increase"|"decrease", operand: number | {type:"variable",variableId}${withEquip ? ", includeEquipment?: boolean=false" : ""} }`,
    decode(_c, p) {
      if (!(p.length === 4 || (withEquip && p.length === 5)) || !isInt(p[0])) return null;
      const op = enumFrom(IncreaseDecrease, p[1]);
      const operand = decodeOperand(p[2], p[3]);
      if (!op || !operand) return null;
      const b: EventBlock = { type, [idField]: p[0], operation: op, operand };
      if (p.length === 5) {
        if (!isBool(p[4])) return null;
        b.includeEquipment = p[4];
      }
      return b;
    },
    encode(b) {
      const params: unknown[] = [b[idField], IncreaseDecrease.parse(b.operation), ...encodeOperand(b.operand as Operand)];
      if (withEquip && b.includeEquipment !== undefined) params.push(b.includeEquipment);
      return { code, params };
    },
    normalize(o, path) {
      const b: EventBlock = {
        type,
        [idField]: int(o, idField, path, { min: 1 }),
        operation: IncreaseDecrease.key(enumKey(o, "operation", path, IncreaseDecrease, 0)),
        operand: normalizeOperand(o.operand ?? 1, `${path}.operand`),
      };
      if (withEquip) b.includeEquipment = bool(o, "includeEquipment", path, false);
      return b;
    },
    describe: (b, n) =>
      `${label}: ${named(kind, b[idField] as number, n)} ${b.operation === "increase" ? "+" : "-"} ${describeOperand(b.operand as Operand, n)}${b.includeEquipment ? " (include equipment)" : ""}`,
    refs: (b) => [{ kind, id: b[idField] as number, role: "use" }, ...operandRefs(b.operand as Operand)],
  });
}
itemLike("change_items", CMD.CHANGE_ITEMS, "itemId", "item", "Change Items", false);
itemLike("change_weapons", CMD.CHANGE_WEAPONS, "weaponId", "weapon", "Change Weapons", true);
itemLike("change_armors", CMD.CHANGE_ARMORS, "armorId", "armor", "Change Armors", true);

def({
  type: "change_party_member",
  codes: [CMD.CHANGE_PARTY_MEMBER],
  doc: '{ actorId: number, operation: "add"|"remove", initialize?: boolean=false }',
  decode(_c, p) {
    if (p.length !== 3 || !isInt(p[0]) || !isBool(p[2])) return null;
    const op = enumFrom(AddRemove, p[1]);
    return op ? { type: "change_party_member", actorId: p[0], operation: op, initialize: p[2] } : null;
  },
  encode: (b) => ({ code: CMD.CHANGE_PARTY_MEMBER, params: [b.actorId, AddRemove.parse(b.operation), b.initialize] }),
  normalize: (o, path) => ({
    type: "change_party_member",
    actorId: int(o, "actorId", path, { min: 1 }),
    operation: AddRemove.key(enumKey(o, "operation", path, AddRemove)),
    initialize: bool(o, "initialize", path, false),
  }),
  describe: (b, n) => `Change Party Member: ${b.operation === "add" ? "Add" : "Remove"} ${named("actor", b.actorId as number, n)}${b.initialize ? " (initialize)" : ""}`,
  refs: (b) => [{ kind: "actor", id: b.actorId as number, role: "use" }],
});

/** Change HP / MP / TP / EXP / Level: [designation, id, op, operandType, operand, (flag)]. */
function actorValue(type: string, code: number, label: string, flag?: string): void {
  def({
    type,
    codes: [code],
    doc: `{ actor: actorId(0=entire party) | {type:"variable",variableId}, operation: "increase"|"decrease", operand: number | {type:"variable",variableId}${flag ? `, ${flag}?: boolean=false` : ""} }`,
    decode(_c, p) {
      if (p.length !== (flag ? 6 : 5)) return null;
      const actor = decodeActorTarget(p[0], p[1]);
      const op = enumFrom(IncreaseDecrease, p[2]);
      const operand = decodeOperand(p[3], p[4]);
      if (!actor || !op || !operand) return null;
      const b: EventBlock = { type, actor, operation: op, operand };
      if (flag) {
        if (!isBool(p[5])) return null;
        b[flag] = p[5];
      }
      return b;
    },
    encode(b) {
      const params: unknown[] = [...encodeActorTarget(b.actor as ActorTarget), IncreaseDecrease.parse(b.operation), ...encodeOperand(b.operand as Operand)];
      if (flag) params.push(b[flag]);
      return { code, params };
    },
    normalize(o, path) {
      const b: EventBlock = {
        type,
        actor: normalizeActorTarget(o.actor ?? 0, `${path}.actor`),
        operation: IncreaseDecrease.key(enumKey(o, "operation", path, IncreaseDecrease, 0)),
        operand: normalizeOperand(o.operand, `${path}.operand`),
      };
      if (flag) b[flag] = bool(o, flag, path, false);
      return b;
    },
    describe: (b, n) =>
      `${label}: ${describeActorTarget(b.actor as ActorTarget, n)} ${b.operation === "increase" ? "+" : "-"} ${describeOperand(b.operand as Operand, n)}${flag && b[flag] ? ` (${flag})` : ""}`,
    refs: (b) => [...actorTargetRefs(b.actor as ActorTarget), ...operandRefs(b.operand as Operand)],
  });
}
actorValue("change_hp", CMD.CHANGE_HP, "Change HP", "allowDeath");
actorValue("change_mp", CMD.CHANGE_MP, "Change MP");
actorValue("change_tp", CMD.CHANGE_TP, "Change TP");
actorValue("change_exp", CMD.CHANGE_EXP, "Change EXP", "showLevelUp");
actorValue("change_level", CMD.CHANGE_LEVEL, "Change Level", "showLevelUp");

def({
  type: "change_state",
  codes: [CMD.CHANGE_STATE],
  doc: '{ actor: actorId(0=entire party) | {type:"variable",variableId}, operation: "add"|"remove", stateId: number }',
  decode(_c, p) {
    if (p.length !== 4 || !isInt(p[3])) return null;
    const actor = decodeActorTarget(p[0], p[1]);
    const op = enumFrom(AddRemove, p[2]);
    return actor && op ? { type: "change_state", actor, operation: op, stateId: p[3] } : null;
  },
  encode: (b) => ({ code: CMD.CHANGE_STATE, params: [...encodeActorTarget(b.actor as ActorTarget), AddRemove.parse(b.operation), b.stateId] }),
  normalize: (o, path) => ({
    type: "change_state",
    actor: normalizeActorTarget(o.actor ?? 0, `${path}.actor`),
    operation: AddRemove.key(enumKey(o, "operation", path, AddRemove)),
    stateId: int(o, "stateId", path, { min: 1 }),
  }),
  describe: (b, n) => `Change State: ${describeActorTarget(b.actor as ActorTarget, n)} ${b.operation === "add" ? "+" : "-"} ${named("state", b.stateId as number, n)}`,
  refs: (b) => [...actorTargetRefs(b.actor as ActorTarget), { kind: "state", id: b.stateId as number, role: "use" }],
});

def({
  type: "change_skill",
  codes: [CMD.CHANGE_SKILL],
  doc: '{ actor: actorId(0=entire party) | {type:"variable",variableId}, operation: "learn"|"forget", skillId: number }',
  decode(_c, p) {
    if (p.length !== 4 || !isInt(p[3]) || (p[2] !== 0 && p[2] !== 1)) return null;
    const actor = decodeActorTarget(p[0], p[1]);
    return actor ? { type: "change_skill", actor, operation: p[2] === 0 ? "learn" : "forget", skillId: p[3] } : null;
  },
  encode: (b) => ({ code: CMD.CHANGE_SKILL, params: [...encodeActorTarget(b.actor as ActorTarget), b.operation === "learn" ? 0 : 1, b.skillId] }),
  normalize(o, path) {
    const op = str(o, "operation", path, "learn").toLowerCase();
    if (op !== "learn" && op !== "forget") throw invalidInput(`${path}.operation must be "learn" or "forget".`);
    return { type: "change_skill", actor: normalizeActorTarget(o.actor ?? 0, `${path}.actor`), operation: op, skillId: int(o, "skillId", path, { min: 1 }) };
  },
  describe: (b, n) => `Change Skill: ${describeActorTarget(b.actor as ActorTarget, n)} ${b.operation === "learn" ? "+" : "-"} ${named("skill", b.skillId as number, n)}`,
  refs: (b) => [...actorTargetRefs(b.actor as ActorTarget), { kind: "skill", id: b.skillId as number, role: "use" }],
});

def({
  type: "recover_all",
  codes: [CMD.RECOVER_ALL],
  doc: '{ actor: actorId(0=entire party) | {type:"variable",variableId} }',
  decode(_c, p) {
    if (p.length !== 2) return null;
    const actor = decodeActorTarget(p[0], p[1]);
    return actor ? { type: "recover_all", actor } : null;
  },
  encode: (b) => ({ code: CMD.RECOVER_ALL, params: encodeActorTarget(b.actor as ActorTarget) }),
  normalize: (o, path) => ({ type: "recover_all", actor: normalizeActorTarget(o.actor ?? 0, `${path}.actor`) }),
  describe: (b, n) => `Recover All: ${describeActorTarget(b.actor as ActorTarget, n)}`,
  refs: (b) => actorTargetRefs(b.actor as ActorTarget),
});

function actorText(type: string, code: number, field: string, label: string): void {
  def({
    type,
    codes: [code],
    doc: `{ actorId: number, ${field}: string }`,
    decode: (_c, p) => (p.length === 2 && isInt(p[0]) && isStr(p[1]) ? { type, actorId: p[0], [field]: p[1] } : null),
    encode: (b) => ({ code, params: [b.actorId, b[field]] }),
    normalize: (o, path) => ({ type, actorId: int(o, "actorId", path, { min: 1 }), [field]: str(o, field, path) }),
    describe: (b, n) => `${label}: ${named("actor", b.actorId as number, n)} → ${quote(String(b[field]))}`,
    refs: (b) => [{ kind: "actor", id: b.actorId as number, role: "use" }],
  });
}
actorText("change_name", CMD.CHANGE_NAME, "name", "Change Name");
actorText("change_nickname", CMD.CHANGE_NICKNAME, "nickname", "Change Nickname");
actorText("change_profile", CMD.CHANGE_PROFILE, "profile", "Change Profile");

def({
  type: "change_class",
  codes: [CMD.CHANGE_CLASS],
  doc: "{ actorId: number, classId: number, keepExp?: boolean=false }",
  decode: (_c, p) =>
    p.length === 3 && isInt(p[0]) && isInt(p[1]) && isBool(p[2]) ? { type: "change_class", actorId: p[0], classId: p[1], keepExp: p[2] } : null,
  encode: (b) => ({ code: CMD.CHANGE_CLASS, params: [b.actorId, b.classId, b.keepExp] }),
  normalize: (o, path) => ({
    type: "change_class",
    actorId: int(o, "actorId", path, { min: 1 }),
    classId: int(o, "classId", path, { min: 1 }),
    keepExp: bool(o, "keepExp", path, false),
  }),
  describe: (b, n) => `Change Class: ${named("actor", b.actorId as number, n)} → ${named("class", b.classId as number, n)}${b.keepExp ? " (keep EXP)" : ""}`,
  refs: (b) => [
    { kind: "actor", id: b.actorId as number, role: "use" },
    { kind: "class", id: b.classId as number, role: "use" },
  ],
});

// ------------------------------------------------------------- toggles

const DisableEnable = new MzEnum("value", [
  { value: 0, label: "disable", aliases: ["disabled", "off", "false"] },
  { value: 1, label: "enable", aliases: ["enabled", "on", "true"] },
]);
function toggle(type: string, code: number, label: string): void {
  def({
    type,
    codes: [code],
    doc: '{ value: "enable"|"disable" }',
    decode: (_c, p) => (p.length === 1 && DisableEnable.has(p[0]) ? { type, value: DisableEnable.key(p[0]) } : null),
    encode: (b) => ({ code, params: [DisableEnable.parse(b.value)] }),
    normalize: (o, path) => ({ type, value: DisableEnable.key(enumKey(o, "value", path, DisableEnable)) }),
    describe: (b) => `${label}: ${b.value === "enable" ? "Enable" : "Disable"}`,
  });
}
toggle("change_save_access", CMD.CHANGE_SAVE_ACCESS, "Change Save Access");
toggle("change_menu_access", CMD.CHANGE_MENU_ACCESS, "Change Menu Access");
toggle("change_encounter", CMD.CHANGE_ENCOUNTER, "Change Encounter");
toggle("change_formation_access", CMD.CHANGE_FORMATION_ACCESS, "Change Formation Access");

def({
  type: "change_transparency",
  codes: [CMD.CHANGE_TRANSPARENCY],
  doc: "{ transparent: boolean }",
  decode: (_c, p) => (p.length === 1 && (p[0] === 0 || p[0] === 1) ? { type: "change_transparency", transparent: p[0] === 0 } : null),
  encode: (b) => ({ code: CMD.CHANGE_TRANSPARENCY, params: [b.transparent ? 0 : 1] }),
  normalize: (o, path) => ({ type: "change_transparency", transparent: bool(o, "transparent", path) }),
  describe: (b) => `Change Transparency: ${b.transparent ? "ON" : "OFF"}`,
});

def({
  type: "change_player_followers",
  codes: [CMD.CHANGE_PLAYER_FOLLOWERS],
  doc: "{ visible: boolean }",
  decode: (_c, p) => (p.length === 1 && (p[0] === 0 || p[0] === 1) ? { type: "change_player_followers", visible: p[0] === 0 } : null),
  encode: (b) => ({ code: CMD.CHANGE_PLAYER_FOLLOWERS, params: [b.visible ? 0 : 1] }),
  normalize: (o, path) => ({ type: "change_player_followers", visible: bool(o, "visible", path) }),
  describe: (b) => `Change Player Followers: ${b.visible ? "ON" : "OFF"}`,
});

noParam("gather_followers", CMD.GATHER_FOLLOWERS, "Gather Followers");
noParam("get_on_off_vehicle", CMD.GET_ON_OFF_VEHICLE, "Get on/off Vehicle");
noParam("erase_event", CMD.ERASE_EVENT, "Erase Event");
noParam("fadeout_screen", CMD.FADEOUT_SCREEN, "Fadeout Screen");
noParam("fadein_screen", CMD.FADEIN_SCREEN, "Fadein Screen");
noParam("save_bgm", CMD.SAVE_BGM, "Save BGM");
noParam("resume_bgm", CMD.RESUME_BGM, "Resume BGM");
noParam("stop_se", CMD.STOP_SE, "Stop SE");
noParam("open_menu_screen", CMD.OPEN_MENU_SCREEN, "Open Menu Screen");
noParam("open_save_screen", CMD.OPEN_SAVE_SCREEN, "Open Save Screen");
noParam("game_over", CMD.GAME_OVER, "Game Over");
noParam("return_to_title", CMD.RETURN_TO_TITLE, "Return to Title Screen");

// ------------------------------------------------------------- world

type Location =
  | { type: "direct"; mapId: number; x: number; y: number }
  | { type: "variables"; mapVariableId: number; xVariableId: number; yVariableId: number };

def({
  type: "transfer_player",
  codes: [CMD.TRANSFER_PLAYER],
  doc: '{ location: {type:"direct",mapId,x,y} | {type:"variables",mapVariableId,xVariableId,yVariableId} (or mapId/x/y at top level), direction?: "retain"|"down"|"left"|"right"|"up"="retain", fade?: "black"|"white"|"none"="black" }',
  decode(_c, p) {
    if (p.length !== 6 || !isInt(p[1]) || !isInt(p[2]) || !isInt(p[3])) return null;
    const dir = enumFrom(DirectionOrRetain, p[4]);
    const fade = enumFrom(FadeType, p[5]);
    if (!dir || !fade) return null;
    let location: Location;
    if (p[0] === 0) location = { type: "direct", mapId: p[1], x: p[2], y: p[3] };
    else if (p[0] === 1) location = { type: "variables", mapVariableId: p[1], xVariableId: p[2], yVariableId: p[3] };
    else return null;
    return { type: "transfer_player", location, direction: dir, fade };
  },
  encode(b) {
    const l = b.location as Location;
    const head = l.type === "direct" ? [0, l.mapId, l.x, l.y] : [1, l.mapVariableId, l.xVariableId, l.yVariableId];
    return { code: CMD.TRANSFER_PLAYER, params: [...head, DirectionOrRetain.parse(b.direction), FadeType.parse(b.fade)] };
  },
  normalize(o, path) {
    const src = o.location !== undefined ? asObj(o.location, `${path}.location`) : o;
    const lp = o.location !== undefined ? `${path}.location` : path;
    let location: Location;
    if (src.type === "variables" || has(src, "mapVariableId")) {
      location = {
        type: "variables",
        mapVariableId: int(src, "mapVariableId", lp, { min: 1 }),
        xVariableId: int(src, "xVariableId", lp, { min: 1 }),
        yVariableId: int(src, "yVariableId", lp, { min: 1 }),
      };
    } else {
      location = { type: "direct", mapId: int(src, "mapId", lp, { min: 1 }), x: int(src, "x", lp, { min: 0 }), y: int(src, "y", lp, { min: 0 }) };
    }
    return {
      type: "transfer_player",
      location,
      direction: DirectionOrRetain.key(enumKey(o, "direction", path, DirectionOrRetain, 0)),
      fade: FadeType.key(enumKey(o, "fade", path, FadeType, 0)),
    };
  },
  describe(b, n) {
    const l = b.location as Location;
    const where =
      l.type === "direct"
        ? `${named("map", l.mapId, n)} (${l.x},${l.y})`
        : `{${named("variable", l.mapVariableId, n)}} ({${named("variable", l.xVariableId, n)}},{${named("variable", l.yVariableId, n)}})`;
    return `Transfer Player: ${where}, direction ${b.direction}, fade ${b.fade}`;
  },
  refs(b) {
    const l = b.location as Location;
    if (l.type === "direct") return [{ kind: "map", id: l.mapId, role: "use", context: { x: l.x, y: l.y } }];
    return [
      { kind: "variable", id: l.mapVariableId, role: "read" },
      { kind: "variable", id: l.xVariableId, role: "read" },
      { kind: "variable", id: l.yVariableId, role: "read" },
    ];
  },
});

type EventLocation =
  | { type: "direct"; x: number; y: number }
  | { type: "variables"; xVariableId: number; yVariableId: number }
  | { type: "exchange"; eventId: number };

def({
  type: "set_event_location",
  codes: [CMD.SET_EVENT_LOCATION],
  doc: '{ character: -1|"player"|0|"this_event"|eventId, location: {type:"direct",x,y} | {type:"variables",xVariableId,yVariableId} | {type:"exchange",eventId}, direction?: "retain"|"down"|"left"|"right"|"up"="retain" }',
  decode(_c, p) {
    if (p.length !== 5 || !isInt(p[0]) || !isInt(p[2]) || !isInt(p[3])) return null;
    const dir = enumFrom(DirectionOrRetain, p[4]);
    if (!dir) return null;
    let location: EventLocation;
    if (p[1] === 0) location = { type: "direct", x: p[2], y: p[3] };
    else if (p[1] === 1) location = { type: "variables", xVariableId: p[2], yVariableId: p[3] };
    else if (p[1] === 2 && p[3] === 0) location = { type: "exchange", eventId: p[2] };
    else return null;
    return { type: "set_event_location", character: p[0], location, direction: dir };
  },
  encode(b) {
    const l = b.location as EventLocation;
    const mid = l.type === "direct" ? [0, l.x, l.y] : l.type === "variables" ? [1, l.xVariableId, l.yVariableId] : [2, l.eventId, 0];
    return { code: CMD.SET_EVENT_LOCATION, params: [b.character, ...mid, DirectionOrRetain.parse(b.direction)] };
  },
  normalize(o, path) {
    const lp = `${path}.location`;
    const src = asObj(o.location, lp);
    let location: EventLocation;
    if (src.type === "variables") location = { type: "variables", xVariableId: int(src, "xVariableId", lp, { min: 1 }), yVariableId: int(src, "yVariableId", lp, { min: 1 }) };
    else if (src.type === "exchange") location = { type: "exchange", eventId: parseCharacter(src.eventId, `${lp}.eventId`) };
    else location = { type: "direct", x: int(src, "x", lp, { min: 0 }), y: int(src, "y", lp, { min: 0 }) };
    return {
      type: "set_event_location",
      character: parseCharacter(o.character ?? 0, `${path}.character`),
      location,
      direction: DirectionOrRetain.key(enumKey(o, "direction", path, DirectionOrRetain, 0)),
    };
  },
  describe(b, n) {
    const l = b.location as EventLocation;
    const where =
      l.type === "direct"
        ? `(${l.x},${l.y})`
        : l.type === "variables"
          ? `({${named("variable", l.xVariableId, n)}},{${named("variable", l.yVariableId, n)}})`
          : `exchange with ${charName(l.eventId, n)}`;
    return `Set Event Location: ${charName(b.character as number, n)} → ${where}, direction ${b.direction}`;
  },
  refs(b) {
    const l = b.location as EventLocation;
    const out = charRefs(b.character as number);
    if (l.type === "variables") out.push({ kind: "variable", id: l.xVariableId, role: "read" }, { kind: "variable", id: l.yVariableId, role: "read" });
    if (l.type === "exchange") out.push(...charRefs(l.eventId));
    return out;
  },
});

// ---- movement route ----

export interface RouteCommandIR {
  command: string;
  [param: string]: unknown;
}

function decodeRouteCommand(rc: unknown): RouteCommandIR | null {
  if (!isObjV(rc) || !isInt(rc.code)) return null;
  const extraKeys = Object.keys(rc).filter((k) => k !== "code" && k !== "parameters" && k !== "indent");
  if (extraKeys.length) return null;
  const d = routeCommandByCode(rc.code);
  const params = rc.parameters;
  const out: RouteCommandIR = { command: d && d.code !== 0 ? d.name : "raw" };
  if (!d || d.code === 0) {
    out.code = rc.code;
    if (params !== undefined) out.parameters = params;
  } else if (d.params.length === 0) {
    if (params !== undefined) {
      if (!Array.isArray(params) || params.length !== 0) return null;
      out.emptyParameters = true; // keeps an explicit "parameters": [] for exact round-trip
    }
  } else {
    if (!Array.isArray(params) || params.length !== d.params.length) return null;
    d.params.forEach((name, i) => (out[name] = params[i]));
  }
  if ("indent" in rc && rc.indent !== null) out.indent = rc.indent;
  if (!("indent" in rc)) out.noIndentKey = true;
  return out;
}

function encodeRouteCommand(c: RouteCommandIR): Record<string, unknown> {
  const d = c.command === "raw" ? undefined : routeCommandByName(c.command);
  const out: Record<string, unknown> = { code: d ? d.code : c.code };
  if (d) {
    if (d.params.length > 0) out.parameters = d.params.map((p) => c[p]);
    else if (c.emptyParameters) out.parameters = [];
  } else if (c.parameters !== undefined) out.parameters = c.parameters;
  if (!c.noIndentKey) out.indent = c.indent ?? null;
  return out;
}

function normalizeRouteCommand(v: unknown, path: string, ctx: NormalizeContext): RouteCommandIR {
  if (isStr(v)) v = { command: v };
  const o = asObj(v, path);
  const name = str(o, "command", path);
  if (name === "raw") {
    const code = int(o, "code", path, { min: 0 });
    const out: RouteCommandIR = { command: "raw", code };
    if (o.parameters !== undefined) {
      if (!Array.isArray(o.parameters)) throw invalidInput(`${path}.parameters must be an array.`);
      out.parameters = structuredClone(o.parameters);
    }
    return out;
  }
  const d = routeCommandByName(name);
  if (!d || d.code === 0) {
    throw invalidInput(`${path}.command: unknown route command ${JSON.stringify(name)}. Known: ${ROUTE_COMMANDS.filter((r) => r.code !== 0).map((r) => r.name).join(", ")}, raw.`);
  }
  const out: RouteCommandIR = { command: d.name };
  for (const p of d.params) {
    if (p === "se") out.se = audio(o.se, `${path}.se`);
    else if (p === "script" || p === "characterName") out[p] = str(o, p, path);
    else out[p] = int(o, p, path);
  }
  if (d.name === "script") requireScriptAuthorization(String(out.script), ctx, `${path}.script`);
  // Fidelity markers emitted by the parser (keep exact native shape when IR is re-submitted).
  if (typeof o.indent === "number") out.indent = o.indent;
  if (o.noIndentKey === true) out.noIndentKey = true;
  if (o.emptyParameters === true) out.emptyParameters = true;
  return out;
}

export function describeRouteCommand(c: RouteCommandIR): string {
  if (c.command === "raw") return `raw(${String(c.code)}${c.parameters ? ` ${JSON.stringify(c.parameters)}` : ""})`;
  const d = routeCommandByName(c.command);
  if (!d || d.params.length === 0) return c.command;
  if (c.command === "play_se") return `play_se ${describeAudio(c.se as Obj)}`;
  return `${c.command}(${d.params.map((p) => JSON.stringify(c[p])).join(", ")})`;
}

def({
  type: "set_movement_route",
  codes: [CMD.SET_MOVEMENT_ROUTE],
  continuation: CMD.MOVE_ROUTE_LINE,
  doc: '{ character: -1|"player"|0|"this_event"|eventId, repeat?: boolean=false, skippable?: boolean=false, wait?: boolean=true, commands: (string | {command: <route command name>, ...params})[] }',
  decode(_c, p, lines) {
    if (p.length !== 2 || !isInt(p[0]) || !isObjV(p[1])) return null;
    const r = p[1];
    if (!Array.isArray(r.list) || !isBool(r.repeat) || !isBool(r.skippable) || !isBool(r.wait)) return null;
    if (Object.keys(r).some((k) => !["list", "repeat", "skippable", "wait"].includes(k))) return null;
    const last = r.list[r.list.length - 1];
    if (!isObjV(last) || last.code !== 0) return null;
    const commands: RouteCommandIR[] = [];
    for (const rc of r.list.slice(0, -1)) {
      const c = decodeRouteCommand(rc);
      if (!c) return null;
      commands.push(c);
    }
    // The editor writes one 505 display line per route command; some tools omit them (the engine ignores them).
    const noDisplayLines = lines.length === 0 && commands.length > 0;
    if (!noDisplayLines && lines.length !== commands.length) return null;
    const b: EventBlock = { type: "set_movement_route", character: p[0], repeat: r.repeat, skippable: r.skippable, wait: r.wait, commands };
    if (noDisplayLines) b.noDisplayLines = true;
    // Preserve a non-standard end marker exactly (e.g. {"code":0,"parameters":[]}).
    if (Object.keys(last).length !== 1) b.routeEnd = structuredClone(last);
    return b;
  },
  encode(b) {
    const list = (b.commands as RouteCommandIR[]).map(encodeRouteCommand);
    const route = { list: [...list, b.routeEnd !== undefined ? structuredClone(b.routeEnd) : { code: 0 }], repeat: b.repeat, skippable: b.skippable, wait: b.wait };
    return { code: CMD.SET_MOVEMENT_ROUTE, params: [b.character, route], lines: b.noDisplayLines ? [] : list.map((c) => [structuredClone(c)]) };
  },
  normalize(o, path, ctx) {
    if (!Array.isArray(o.commands)) throw invalidInput(`${path}.commands: expected an array of route commands.`);
    return {
      type: "set_movement_route",
      character: parseCharacter(o.character ?? 0, `${path}.character`),
      repeat: bool(o, "repeat", path, false),
      skippable: bool(o, "skippable", path, false),
      wait: bool(o, "wait", path, true),
      commands: o.commands.map((c, i) => normalizeRouteCommand(c, `${path}.commands[${i}]`, ctx)),
      ...(o.noDisplayLines === true ? { noDisplayLines: true } : {}),
      ...(o.routeEnd !== undefined ? { routeEnd: structuredClone(o.routeEnd) } : {}),
    };
  },
  describe(b, n) {
    const flags = [b.repeat ? "repeat" : "", b.skippable ? "skippable" : "", b.wait ? "wait" : ""].filter(Boolean).join(", ");
    const cmds = (b.commands as RouteCommandIR[]).map(describeRouteCommand);
    const shown = cmds.length > 12 ? [...cmds.slice(0, 12), `… +${cmds.length - 12} more`] : cmds;
    return `Set Movement Route: ${charName(b.character as number, n)}${flags ? ` (${flags})` : ""}: ${shown.join(", ") || "(empty)"}`;
  },
  refs(b) {
    const out = charRefs(b.character as number);
    for (const c of b.commands as RouteCommandIR[]) {
      if (c.command === "switch_on" || c.command === "switch_off") out.push({ kind: "switch", id: c.switchId as number, role: "write" });
    }
    return out;
  },
  scripts: (b) => (b.commands as RouteCommandIR[]).filter((c) => c.command === "script").map((c) => String(c.script)),
});

function charAnim(type: string, code: number, field: string, kind: RefKind | null, label: string, en?: MzEnum): void {
  def({
    type,
    codes: [code],
    doc: `{ character: -1|"player"|0|"this_event"|eventId, ${field}: number, wait?: boolean=false }`,
    decode: (_c, p) => (p.length === 3 && isInt(p[0]) && isInt(p[1]) && isBool(p[2]) ? { type, character: p[0], [field]: p[1], wait: p[2] } : null),
    encode: (b) => ({ code, params: [b.character, b[field], b.wait] }),
    normalize: (o, path) => ({
      type,
      character: parseCharacter(o.character ?? 0, `${path}.character`),
      [field]: en ? enumKey(o, field, path, en) : int(o, field, path, { min: 1 }),
      wait: bool(o, "wait", path, false),
    }),
    describe: (b, n) => {
      const what = kind ? named(kind, b[field] as number, n) : en ? en.label(b[field]) : String(b[field]);
      return `${label}: ${charName(b.character as number, n)}, ${what}${b.wait ? " (wait)" : ""}`;
    },
    refs: (b) => [...charRefs(b.character as number), ...(kind ? [{ kind, id: b[field] as number, role: "use" as const }] : [])],
  });
}
charAnim("play_animation", CMD.SHOW_ANIMATION, "animationId", "animation", "Show Animation");
charAnim("show_balloon", CMD.SHOW_BALLOON_ICON, "balloonId", null, "Show Balloon Icon", BalloonId);

function colorEffect(type: string, code: number, field: string, label: string): void {
  def({
    type,
    codes: [code],
    doc: `{ ${field}: [number, number, number, number], duration: frames, wait?: boolean=true }`,
    decode(_c, p) {
      if (p.length !== 3 || !Array.isArray(p[0]) || p[0].length !== 4 || !p[0].every(isNum) || !isInt(p[1]) || !isBool(p[2])) return null;
      return { type, [field]: [...p[0]], duration: p[1], wait: p[2] };
    },
    encode: (b) => ({ code, params: [[...(b[field] as number[])], b.duration, b.wait] }),
    normalize(o, path) {
      const v = o[field];
      if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) throw invalidInput(`${path}.${field}: expected [r, g, b, ${field === "tone" ? "gray" : "intensity"}].`);
      return { type, [field]: [...v], duration: int(o, "duration", path, { min: 1, def: 60 }), wait: bool(o, "wait", path, true) };
    },
    describe: (b) => `${label}: ${JSON.stringify(b[field])}, ${b.duration} frames${b.wait ? " (wait)" : ""}`,
  });
}
colorEffect("tint_screen", CMD.TINT_SCREEN, "tone", "Tint Screen");
colorEffect("flash_screen", CMD.FLASH_SCREEN, "color", "Flash Screen");

def({
  type: "shake_screen",
  codes: [CMD.SHAKE_SCREEN],
  doc: "{ power: 1-9, speed: 1-9, duration: frames, wait?: boolean=true }",
  decode: (_c, p) =>
    p.length === 4 && isInt(p[0]) && isInt(p[1]) && isInt(p[2]) && isBool(p[3])
      ? { type: "shake_screen", power: p[0], speed: p[1], duration: p[2], wait: p[3] }
      : null,
  encode: (b) => ({ code: CMD.SHAKE_SCREEN, params: [b.power, b.speed, b.duration, b.wait] }),
  normalize: (o, path) => ({
    type: "shake_screen",
    power: int(o, "power", path, { min: 1, max: 9, def: 5 }),
    speed: int(o, "speed", path, { min: 1, max: 9, def: 5 }),
    duration: int(o, "duration", path, { min: 1, def: 60 }),
    wait: bool(o, "wait", path, true),
  }),
  describe: (b) => `Shake Screen: power ${b.power}, speed ${b.speed}, ${b.duration} frames${b.wait ? " (wait)" : ""}`,
});

def({
  type: "wait",
  codes: [CMD.WAIT],
  doc: "{ frames: number (60 = 1 second) }",
  decode: (_c, p) => (p.length === 1 && isInt(p[0]) ? { type: "wait", frames: p[0] } : null),
  encode: (b) => ({ code: CMD.WAIT, params: [b.frames] }),
  normalize: (o, path) => ({ type: "wait", frames: int(o, "frames", path, { min: 1, max: 999 }) }),
  describe: (b) => `Wait: ${b.frames} frames`,
});

def({
  type: "erase_picture",
  codes: [CMD.ERASE_PICTURE],
  doc: "{ pictureId: number }",
  decode: (_c, p) => (p.length === 1 && isInt(p[0]) ? { type: "erase_picture", pictureId: p[0] } : null),
  encode: (b) => ({ code: CMD.ERASE_PICTURE, params: [b.pictureId] }),
  normalize: (o, path) => ({ type: "erase_picture", pictureId: int(o, "pictureId", path, { min: 1, max: 100 }) }),
  describe: (b) => `Erase Picture: #${b.pictureId}`,
});

// ---- audio ----

function playAudio(type: string, code: number, label: string): void {
  def({
    type,
    codes: [code],
    doc: "{ name: string (file name without extension, \"\" = stop), volume?: 0-100=90, pitch?: 50-150=100, pan?: -100..100=0 }",
    decode(_c, p) {
      if (p.length !== 1 || !isAudio(p[0])) return null;
      const a = p[0] as Obj;
      if (Object.keys(a).some((k) => !["name", "volume", "pitch", "pan"].includes(k))) return null;
      return { type, name: a.name, volume: a.volume, pitch: a.pitch, pan: a.pan };
    },
    encode: (b) => ({ code, params: [{ name: b.name, volume: b.volume, pitch: b.pitch, pan: b.pan }] }),
    normalize: (o, path) => ({ type, ...audio(o.audio ?? o, path) }),
    describe: (b) => `${label}: ${describeAudio(b)}`,
  });
}
playAudio("play_bgm", CMD.PLAY_BGM, "Play BGM");
playAudio("play_bgs", CMD.PLAY_BGS, "Play BGS");
playAudio("play_me", CMD.PLAY_ME, "Play ME");
playAudio("play_se", CMD.PLAY_SE, "Play SE");

def({
  type: "fadeout_audio",
  codes: [CMD.FADEOUT_BGM, CMD.FADEOUT_BGS],
  doc: '{ channel: "bgm"|"bgs", seconds: number }',
  decode: (c, p) => (p.length === 1 && isInt(p[0]) ? { type: "fadeout_audio", channel: c === CMD.FADEOUT_BGM ? "bgm" : "bgs", seconds: p[0] } : null),
  encode: (b) => ({ code: b.channel === "bgs" ? CMD.FADEOUT_BGS : CMD.FADEOUT_BGM, params: [b.seconds] }),
  normalize(o, path) {
    const ch = str(o, "channel", path, "bgm").toLowerCase();
    if (ch !== "bgm" && ch !== "bgs") throw invalidInput(`${path}.channel must be "bgm" or "bgs".`);
    return { type: "fadeout_audio", channel: ch, seconds: int(o, "seconds", path, { min: 1, max: 60 }) };
  },
  describe: (b) => `Fadeout ${String(b.channel).toUpperCase()}: ${b.seconds} sec`,
});

// ---- shop ----

interface ShopGood {
  goodsType: string;
  id: number;
  price: number | null;
}

function decodeGood(p: unknown[]): ShopGood | null {
  if (p.length !== 4 || !ShopGoodsType.has(p[0]) || !isInt(p[1]) || !isInt(p[3])) return null;
  if (p[2] === 0 && p[3] === 0) return { goodsType: ShopGoodsType.key(p[0]), id: p[1], price: null };
  if (p[2] === 1) return { goodsType: ShopGoodsType.key(p[0]), id: p[1], price: p[3] };
  return null;
}

function encodeGood(g: ShopGood): unknown[] {
  return [ShopGoodsType.parse(g.goodsType), g.id, g.price === null ? 0 : 1, g.price ?? 0];
}

def({
  type: "shop_processing",
  codes: [CMD.SHOP_PROCESSING],
  continuation: CMD.SHOP_ITEM,
  doc: '{ goods: {goodsType: "item"|"weapon"|"armor", id: number, price?: number|null (null = database price)}[], purchaseOnly?: boolean=false }',
  decode(_c, p, lines) {
    if (p.length !== 5 || !isBool(p[4])) return null;
    const first = decodeGood(p.slice(0, 4));
    const rest = lines.map(decodeGood);
    if (!first || rest.some((g) => !g)) return null;
    return { type: "shop_processing", goods: [first, ...(rest as ShopGood[])], purchaseOnly: p[4] };
  },
  encode(b) {
    const goods = b.goods as ShopGood[];
    return { code: CMD.SHOP_PROCESSING, params: [...encodeGood(goods[0]!), b.purchaseOnly], lines: goods.slice(1).map(encodeGood) };
  },
  normalize(o, path) {
    if (!Array.isArray(o.goods) || o.goods.length === 0) throw invalidInput(`${path}.goods: at least one entry is required.`);
    const goods = o.goods.map((g, i) => {
      const gp = `${path}.goods[${i}]`;
      const x = asObj(g, gp);
      return {
        goodsType: ShopGoodsType.key(enumKey(x, "goodsType", gp, ShopGoodsType, 0)),
        id: int(x, "id", gp, { min: 1 }),
        price: x.price === undefined || x.price === null ? null : int(x, "price", gp, { min: 0 }),
      };
    });
    return { type: "shop_processing", goods, purchaseOnly: bool(o, "purchaseOnly", path, false) };
  },
  describe: (b, n) =>
    `Shop Processing${b.purchaseOnly ? " (purchase only)" : ""}: ${(b.goods as ShopGood[])
      .map((g) => `${named(g.goodsType as RefKind, g.id, n)}${g.price === null ? "" : ` @${g.price}`}`)
      .join(", ")}`,
  refs: (b) => (b.goods as ShopGood[]).map((g) => ({ kind: g.goodsType as RefKind, id: g.id, role: "use" as const })),
});

// ---- scripting & plugins ----

def({
  type: "script",
  codes: [CMD.SCRIPT],
  continuation: CMD.SCRIPT_LINE,
  doc: "{ script: string | lines: string[] }  (requires allowScript=true unless the script already exists on the page)",
  decode(_c, p, lines) {
    if (p.length !== 1 || !isStr(p[0]) || !lines.every((l) => l.length === 1 && isStr(l[0]))) return null;
    return { type: "script", lines: [p[0], ...lines.map((l) => l[0] as string)] };
  },
  encode(b) {
    const ls = b.lines as string[];
    return { code: CMD.SCRIPT, params: [ls[0] ?? ""], lines: ls.slice(1).map((l) => [l]) };
  },
  normalize(o, path, ctx) {
    const lines = typeof o.script === "string" ? o.script.split(/\r?\n/) : textLines(o, path);
    requireScriptAuthorization(lines.join("\n"), ctx, path);
    return { type: "script", lines };
  },
  describe: (b) => {
    const ls = b.lines as string[];
    return `Script (${ls.length} line${ls.length === 1 ? "" : "s"}, opaque): ${quote(ls.join(" ⏎ "), 100)}`;
  },
  scripts: (b) => [(b.lines as string[]).join("\n")],
});

def({
  type: "plugin_command",
  codes: [CMD.PLUGIN_COMMAND],
  continuation: CMD.PLUGIN_COMMAND_LINE,
  doc: "{ pluginName: string, commandName: string, commandText?: string, args?: Record<string, string>, displayLines?: string[] }  (args are stored as strings, exactly as the editor does)",
  decode(_c, p, lines) {
    if (p.length !== 4 || !isStr(p[0]) || !isStr(p[1]) || !isStr(p[2]) || !isObjV(p[3])) return null;
    if (!lines.every((l) => l.length === 1 && isStr(l[0]))) return null;
    return {
      type: "plugin_command",
      pluginName: p[0],
      commandName: p[1],
      commandText: p[2],
      args: structuredClone(p[3]),
      displayLines: lines.map((l) => l[0] as string),
    };
  },
  encode: (b) => ({
    code: CMD.PLUGIN_COMMAND,
    params: [b.pluginName, b.commandName, b.commandText, structuredClone(b.args)],
    lines: (b.displayLines as string[]).map((l) => [l]),
  }),
  normalize(o, path) {
    const args = o.args === undefined ? {} : asObj(o.args, `${path}.args`);
    const strArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      // The editor stores every plugin argument as a string (structs/arrays as JSON strings).
      strArgs[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    const commandName = str(o, "commandName", path);
    let displayLines: string[];
    if (o.displayLines !== undefined) {
      if (!Array.isArray(o.displayLines) || !o.displayLines.every(isStr)) throw invalidInput(`${path}.displayLines must be string[].`);
      displayLines = [...o.displayLines];
    } else {
      displayLines = Object.entries(strArgs).map(([k, v]) => `${k} = ${String(v)}`);
    }
    return {
      type: "plugin_command",
      pluginName: str(o, "pluginName", path),
      commandName,
      commandText: str(o, "commandText", path, commandName),
      args: strArgs,
      displayLines,
    };
  },
  describe: (b) => {
    const args = Object.entries((b.args as Obj) ?? {})
      .map(([k, v]) => `${k}=${quote(String(v), 40)}`)
      .join(", ");
    return `Plugin Command: ${b.pluginName} › ${b.commandText || b.commandName}${args ? ` (${args})` : ""}`;
  },
  refs: (b) => [{ kind: "plugin", id: String(b.pluginName), role: "use", origin: "plugin", via: `command ${String(b.commandName)}` }],
});

def({
  type: "plugin_command_mv",
  codes: [CMD.PLUGIN_COMMAND_MV],
  doc: "{ command: string }  (deprecated MV-style plugin command text)",
  decode: (_c, p) => (p.length === 1 && isStr(p[0]) ? { type: "plugin_command_mv", command: p[0] } : null),
  encode: (b) => ({ code: CMD.PLUGIN_COMMAND_MV, params: [b.command] }),
  normalize: (o, path) => ({ type: "plugin_command_mv", command: str(o, "command", path) }),
  describe: (b) => `Plugin Command (MV): ${quote(String(b.command), 80)}`,
});

// ------------------------------------------------------------------ lookup

const byType = new Map<string, LeafDef>();
const byCode = new Map<number, LeafDef>();
for (const d of defs) {
  if (byType.has(d.type)) throw new Error(`Duplicate block type ${d.type}`);
  byType.set(d.type, d);
  for (const c of d.codes) {
    if (byCode.has(c)) throw new Error(`Duplicate block code ${c}`);
    byCode.set(c, d);
  }
}

export function leafByType(type: string): LeafDef | undefined {
  return byType.get(type);
}

export function leafByCode(code: number): LeafDef | undefined {
  return byCode.get(code);
}

export function allLeafDefs(): readonly LeafDef[] {
  return defs;
}

export { charName, charRefs, describeAudio, quote };

// ------------------------------------------------------------------ page move routes

export interface MoveRouteIR {
  repeat: boolean;
  skippable: boolean;
  wait: boolean;
  commands: RouteCommandIR[];
  /** Non-standard end marker, preserved exactly. */
  routeEnd?: unknown;
}

/** Decode a native move route object (page custom route); null if it cannot be represented losslessly. */
export function decodeMoveRoute(r: unknown): MoveRouteIR | null {
  if (!isObjV(r) || !Array.isArray(r.list) || !isBool(r.repeat) || !isBool(r.skippable) || !isBool(r.wait)) return null;
  if (Object.keys(r).some((k) => !["list", "repeat", "skippable", "wait"].includes(k))) return null;
  const last = r.list[r.list.length - 1];
  if (!isObjV(last) || last.code !== 0) return null;
  const commands: RouteCommandIR[] = [];
  for (const rc of r.list.slice(0, -1)) {
    const c = decodeRouteCommand(rc);
    if (!c) return null;
    commands.push(c);
  }
  const out: MoveRouteIR = { repeat: r.repeat, skippable: r.skippable, wait: r.wait, commands };
  if (Object.keys(last).length !== 1) out.routeEnd = structuredClone(last);
  return out;
}

/** Page move routes end with {"code":0,"parameters":[]} in editor output. */
export function encodeMoveRoute(ir: MoveRouteIR, defaultEnd: Record<string, unknown> = { code: 0, parameters: [] }): Record<string, unknown> {
  return {
    list: [...ir.commands.map(encodeRouteCommand), ir.routeEnd !== undefined ? structuredClone(ir.routeEnd) : structuredClone(defaultEnd)],
    repeat: ir.repeat,
    skippable: ir.skippable,
    wait: ir.wait,
  };
}

export function normalizeMoveRoute(v: unknown, path: string, ctx: NormalizeContext, defaults: { repeat: boolean; skippable: boolean; wait: boolean }): MoveRouteIR {
  const o = asObj(v, path);
  if (!Array.isArray(o.commands)) throw invalidInput(`${path}.commands: expected an array of route commands.`);
  return {
    repeat: bool(o, "repeat", path, defaults.repeat),
    skippable: bool(o, "skippable", path, defaults.skippable),
    wait: bool(o, "wait", path, defaults.wait),
    commands: o.commands.map((c, i) => normalizeRouteCommand(c, `${path}.commands[${i}]`, ctx)),
  };
}

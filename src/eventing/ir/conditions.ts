import { Comparison, Direction, GoldComparison, OnOff, SelfSwitchCh, Vehicle, parseCharacter } from "../../adapters/rpg-maker-mz/enum-catalog.js";
import { deepEqual } from "../../project/json-diff.js";
import { invalidInput } from "../../project/errors.js";
import type { NameResolver, Ref } from "../../references/ref-types.js";
import { charName, charRefs, named, normalizeOperand, quote, type Operand } from "./blocks.js";
import { asObj, bool, enumKey, int, requireScriptAuthorization, str, type NormalizeContext } from "./input.js";

/**
 * Conditional Branch (code 111) conditions. Native layout per
 * Game_Interpreter.command111 (params[0] selects the condition type):
 *
 *   0 switch      [0, switchId, 0=ON|1=OFF]
 *   1 variable    [1, variableId, operandType(0 const|1 var), operand, comparison(0..5)]
 *   2 self switch [2, "A".."D", 0=ON|1=OFF]
 *   3 timer       [3, seconds, 0 (>=) | 1 (<=)]
 *   4 actor       [4, actorId, check(0..6), value]   (value unused for "in party")
 *   5 enemy       [5, enemyIndex, 0 appeared | 1 state, stateId]
 *   6 character   [6, characterId, direction]
 *   7 gold        [7, amount, 0 (>=) | 1 (<=) | 2 (<)]
 *   8 item        [8, itemId]
 *   9 weapon      [9, weaponId, includeEquipment]
 *  10 armor       [10, armorId, includeEquipment]
 *  11 button      [11, buttonName, 0 pressed | 1 triggered | 2 repeated]
 *  12 script      [12, jsExpression]
 *  13 vehicle     [13, vehicleId]
 *
 * Shapes that do not round-trip exactly are kept as
 * { type: "native", parameters } so the surrounding branch stays semantic.
 */
export type Condition = { type: string; [k: string]: unknown };

const ACTOR_CHECKS = ["in_party", "name", "class", "skill", "weapon", "armor", "state"] as const;
const BUTTON_MODES = ["pressed", "triggered", "repeated"] as const;
const BUTTONS = ["ok", "cancel", "shift", "down", "left", "right", "up", "pageup", "pagedown"];

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function decodeRaw(p: unknown[]): Condition | null {
  const t = p[0];
  switch (t) {
    case 0:
      if (p.length === 3 && isInt(p[1]) && OnOff.has(p[2])) return { type: "switch", switchId: p[1], value: OnOff.key(p[2]) };
      return null;
    case 1:
      if (p.length === 5 && isInt(p[1]) && (p[2] === 0 || p[2] === 1) && isInt(p[3]) && Comparison.has(p[4])) {
        const operand: Operand = p[2] === 0 ? { type: "constant", value: p[3] } : { type: "variable", variableId: p[3] };
        return { type: "variable", variableId: p[1], comparison: Comparison.key(p[4]), operand };
      }
      return null;
    case 2:
      if (p.length === 3 && SelfSwitchCh.has(p[1]) && OnOff.has(p[2])) return { type: "self_switch", selfSwitch: p[1], value: OnOff.key(p[2]) };
      return null;
    case 3:
      if (p.length === 3 && isInt(p[1]) && (p[2] === 0 || p[2] === 1)) return { type: "timer", comparison: p[2] === 0 ? ">=" : "<=", seconds: p[1] };
      return null;
    case 4: {
      if (!isInt(p[1]) || !isInt(p[2]) || p[2] < 0 || p[2] > 6) return null;
      const check = ACTOR_CHECKS[p[2]]!;
      if (check === "in_party") return p.length === 3 ? { type: "actor", actorId: p[1], check } : null;
      if (p.length !== 4) return null;
      if (check === "name") return typeof p[3] === "string" ? { type: "actor", actorId: p[1], check, value: p[3] } : null;
      return isInt(p[3]) ? { type: "actor", actorId: p[1], check, value: p[3] } : null;
    }
    case 5:
      if (isInt(p[1]) && p[2] === 0 && p.length === 3) return { type: "enemy", enemyIndex: p[1], check: "appeared" };
      if (isInt(p[1]) && p[2] === 1 && p.length === 4 && isInt(p[3])) return { type: "enemy", enemyIndex: p[1], check: "state", stateId: p[3] };
      return null;
    case 6:
      if (p.length === 3 && isInt(p[1]) && Direction.has(p[2])) return { type: "character", character: p[1], direction: Direction.key(p[2]) };
      return null;
    case 7:
      if (p.length === 3 && isInt(p[1]) && GoldComparison.has(p[2])) return { type: "gold", comparison: GoldComparison.key(p[2]), amount: p[1] };
      return null;
    case 8:
      if (p.length === 2 && isInt(p[1])) return { type: "item", itemId: p[1] };
      return null;
    case 9:
    case 10:
      if (p.length === 3 && isInt(p[1]) && typeof p[2] === "boolean") {
        return t === 9 ? { type: "weapon", weaponId: p[1], includeEquipment: p[2] } : { type: "armor", armorId: p[1], includeEquipment: p[2] };
      }
      return null;
    case 11:
      if (typeof p[1] !== "string") return null;
      if (p.length === 2) return { type: "button", button: p[1] };
      if (p.length === 3 && isInt(p[2]) && p[2] >= 0 && p[2] <= 2) return { type: "button", button: p[1], mode: BUTTON_MODES[p[2]] };
      return null;
    case 12:
      if (p.length === 2 && typeof p[1] === "string") return { type: "script", script: p[1] };
      return null;
    case 13:
      if (p.length === 2 && Vehicle.has(p[1])) return { type: "vehicle", vehicle: Vehicle.key(p[1]) };
      return null;
  }
  return null;
}

export function encodeCondition(c: Condition): unknown[] {
  switch (c.type) {
    case "switch":
      return [0, c.switchId, OnOff.parse(c.value)];
    case "variable": {
      const o = c.operand as Operand;
      return [1, c.variableId, o.type === "constant" ? 0 : 1, o.type === "constant" ? o.value : o.variableId, Comparison.parse(c.comparison)];
    }
    case "self_switch":
      return [2, c.selfSwitch, OnOff.parse(c.value)];
    case "timer":
      return [3, c.seconds, c.comparison === ">=" ? 0 : 1];
    case "actor": {
      const idx = ACTOR_CHECKS.indexOf(c.check as (typeof ACTOR_CHECKS)[number]);
      return c.check === "in_party" ? [4, c.actorId, idx] : [4, c.actorId, idx, c.value];
    }
    case "enemy":
      return c.check === "appeared" ? [5, c.enemyIndex, 0] : [5, c.enemyIndex, 1, c.stateId];
    case "character":
      return [6, c.character, Direction.parse(c.direction)];
    case "gold":
      return [7, c.amount, GoldComparison.parse(c.comparison)];
    case "item":
      return [8, c.itemId];
    case "weapon":
      return [9, c.weaponId, c.includeEquipment];
    case "armor":
      return [10, c.armorId, c.includeEquipment];
    case "button":
      return c.mode === undefined ? [11, c.button] : [11, c.button, BUTTON_MODES.indexOf(c.mode as (typeof BUTTON_MODES)[number])];
    case "script":
      return [12, c.script];
    case "vehicle":
      return [13, Vehicle.parse(c.vehicle)];
    case "native":
      return structuredClone(c.parameters as unknown[]);
  }
  throw invalidInput(`Unknown condition type ${JSON.stringify(c.type)}.`);
}

/** Decode native 111 parameters; falls back to {type:"native"} when the shape does not round-trip exactly. */
export function decodeCondition(params: unknown[]): Condition {
  const c = decodeRaw(params);
  if (c && deepEqual(encodeCondition(c), params)) return c;
  return { type: "native", parameters: structuredClone(params) };
}

export function normalizeCondition(v: unknown, path: string, ctx: NormalizeContext): Condition {
  const o = asObj(v, path);
  const t = str(o, "type", path);
  switch (t) {
    case "switch":
      return { type: t, switchId: int(o, "switchId", path, { min: 1 }), value: OnOff.key(enumKey(o, "value", path, OnOff, 0)) };
    case "variable": {
      const operand = o.operand !== undefined ? normalizeOperand(o.operand, `${path}.operand`) : { type: "constant" as const, value: int(o, "value", path) };
      return { type: t, variableId: int(o, "variableId", path, { min: 1 }), comparison: Comparison.key(enumKey(o, "comparison", path, Comparison, 0)), operand };
    }
    case "self_switch":
      return { type: t, selfSwitch: enumKey(o, "selfSwitch", path, SelfSwitchCh), value: OnOff.key(enumKey(o, "value", path, OnOff, 0)) };
    case "timer": {
      const cmp = str(o, "comparison", path, ">=");
      if (cmp !== ">=" && cmp !== "<=") throw invalidInput(`${path}.comparison must be ">=" or "<=".`);
      return { type: t, comparison: cmp, seconds: int(o, "seconds", path, { min: 0 }) };
    }
    case "actor": {
      const check = str(o, "check", path, "in_party");
      if (!(ACTOR_CHECKS as readonly string[]).includes(check)) throw invalidInput(`${path}.check must be one of ${ACTOR_CHECKS.join(", ")}.`);
      const out: Condition = { type: t, actorId: int(o, "actorId", path, { min: 1 }), check };
      if (check === "name") out.value = str(o, "value", path);
      else if (check !== "in_party") out.value = int(o, "value", path, { min: 1 });
      return out;
    }
    case "enemy": {
      const check = str(o, "check", path, "appeared");
      if (check === "appeared") return { type: t, enemyIndex: int(o, "enemyIndex", path, { min: 0, max: 7 }), check };
      if (check === "state") return { type: t, enemyIndex: int(o, "enemyIndex", path, { min: 0, max: 7 }), check, stateId: int(o, "stateId", path, { min: 1 }) };
      throw invalidInput(`${path}.check must be "appeared" or "state".`);
    }
    case "character":
      return { type: t, character: parseCharacter(o.character ?? 0, `${path}.character`), direction: Direction.key(enumKey(o, "direction", path, Direction)) };
    case "gold":
      return { type: t, comparison: GoldComparison.key(enumKey(o, "comparison", path, GoldComparison, 0)), amount: int(o, "amount", path, { min: 0 }) };
    case "item":
      return { type: t, itemId: int(o, "itemId", path, { min: 1 }) };
    case "weapon":
      return { type: t, weaponId: int(o, "weaponId", path, { min: 1 }), includeEquipment: bool(o, "includeEquipment", path, false) };
    case "armor":
      return { type: t, armorId: int(o, "armorId", path, { min: 1 }), includeEquipment: bool(o, "includeEquipment", path, false) };
    case "button": {
      const button = str(o, "button", path);
      if (!BUTTONS.includes(button)) throw invalidInput(`${path}.button must be one of ${BUTTONS.join(", ")}.`);
      const mode = str(o, "mode", path, "pressed");
      if (!(BUTTON_MODES as readonly string[]).includes(mode)) throw invalidInput(`${path}.mode must be one of ${BUTTON_MODES.join(", ")}.`);
      return { type: t, button, mode };
    }
    case "script": {
      const script = str(o, "script", path);
      requireScriptAuthorization(script, ctx, `${path}.script`);
      return { type: t, script };
    }
    case "vehicle":
      return { type: t, vehicle: Vehicle.key(enumKey(o, "vehicle", path, Vehicle)) };
    case "native": {
      if (!Array.isArray(o.parameters) || o.parameters.length === 0) throw invalidInput(`${path}.parameters must be a non-empty array.`);
      if (o.parameters[0] === 12) requireScriptAuthorization(String(o.parameters[1]), ctx, `${path}.parameters`);
      return { type: t, parameters: structuredClone(o.parameters) };
    }
  }
  throw invalidInput(
    `${path}.type: unknown condition ${JSON.stringify(t)}. Use switch, variable, self_switch, timer, actor, enemy, character, gold, item, weapon, armor, button, script, vehicle or native.`,
  );
}

export function describeCondition(c: Condition, n: NameResolver): string {
  switch (c.type) {
    case "switch":
      return `${named("switch", c.switchId as number, n)} is ${String(c.value).toUpperCase()}`;
    case "variable": {
      const o = c.operand as Operand;
      return `${named("variable", c.variableId as number, n)} ${c.comparison} ${o.type === "constant" ? o.value : named("variable", o.variableId, n)}`;
    }
    case "self_switch":
      return `Self Switch ${c.selfSwitch} is ${String(c.value).toUpperCase()}`;
    case "timer":
      return `Timer ${c.comparison} ${c.seconds} sec`;
    case "actor": {
      const a = named("actor", c.actorId as number, n);
      switch (c.check) {
        case "in_party":
          return `${a} is in the party`;
        case "name":
          return `${a}'s name is ${quote(String(c.value))}`;
        case "class":
          return `${a} is ${named("class", c.value as number, n)}`;
        case "skill":
          return `${a} has learned ${named("skill", c.value as number, n)}`;
        case "weapon":
          return `${a} has equipped ${named("weapon", c.value as number, n)}`;
        case "armor":
          return `${a} has equipped ${named("armor", c.value as number, n)}`;
        case "state":
          return `${a} is affected by ${named("state", c.value as number, n)}`;
      }
      return `${a} ${String(c.check)}`;
    }
    case "enemy":
      return c.check === "appeared" ? `Enemy #${(c.enemyIndex as number) + 1} has appeared` : `Enemy #${(c.enemyIndex as number) + 1} is affected by ${named("state", c.stateId as number, n)}`;
    case "character":
      return `${charName(c.character as number, n)} is facing ${c.direction}`;
    case "gold":
      return `Gold ${c.comparison} ${c.amount}`;
    case "item":
      return `Party has ${named("item", c.itemId as number, n)}`;
    case "weapon":
      return `Party has ${named("weapon", c.weaponId as number, n)}${c.includeEquipment ? " (include equipment)" : ""}`;
    case "armor":
      return `Party has ${named("armor", c.armorId as number, n)}${c.includeEquipment ? " (include equipment)" : ""}`;
    case "button":
      return `Button [${c.button}] is ${c.mode ?? "pressed"}`;
    case "script":
      return `Script: ${quote(String(c.script), 100)}`;
    case "vehicle":
      return `Player is riding the ${c.vehicle}`;
    case "native":
      return `Native condition ${JSON.stringify(c.parameters)}`;
  }
  return `Condition ${c.type}`;
}

export function conditionRefs(c: Condition): Ref[] {
  switch (c.type) {
    case "switch":
      return [{ kind: "switch", id: c.switchId as number, role: "read" }];
    case "variable": {
      const o = c.operand as Operand;
      const out: Ref[] = [{ kind: "variable", id: c.variableId as number, role: "read" }];
      if (o.type === "variable") out.push({ kind: "variable", id: o.variableId, role: "read" });
      return out;
    }
    case "self_switch":
      return [{ kind: "self_switch", id: String(c.selfSwitch), role: "read" }];
    case "actor": {
      const out: Ref[] = [{ kind: "actor", id: c.actorId as number, role: "read" }];
      const k = { class: "class", skill: "skill", weapon: "weapon", armor: "armor", state: "state" } as const;
      const kind = k[c.check as keyof typeof k];
      if (kind) out.push({ kind, id: c.value as number, role: "read" });
      return out;
    }
    case "enemy":
      return c.check === "state" ? [{ kind: "state", id: c.stateId as number, role: "read" }] : [];
    case "character":
      return charRefs(c.character as number);
    case "item":
      return [{ kind: "item", id: c.itemId as number, role: "read" }];
    case "weapon":
      return [{ kind: "weapon", id: c.weaponId as number, role: "read" }];
    case "armor":
      return [{ kind: "armor", id: c.armorId as number, role: "read" }];
    case "native": {
      const p = c.parameters as unknown[];
      if (p[0] === 0 && typeof p[1] === "number") return [{ kind: "switch", id: p[1], role: "read", origin: "inferred" }];
      if (p[0] === 1 && typeof p[1] === "number") return [{ kind: "variable", id: p[1], role: "read", origin: "inferred" }];
      return [];
    }
  }
  return [];
}

export function conditionScripts(c: Condition): string[] {
  if (c.type === "script") return [String(c.script)];
  if (c.type === "native" && (c.parameters as unknown[])[0] === 12) return [String((c.parameters as unknown[])[1])];
  return [];
}

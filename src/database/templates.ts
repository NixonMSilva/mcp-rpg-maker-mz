import { invalidInput } from "../project/errors.js";
import type { DatabaseCategory } from "./database-catalog.js";

/**
 * Record templates (DATABASE_SPEC §12). A template expands to the regular
 * create-record input (fields + collections + note tags), so the result goes
 * through the same validation and preview as any other record. Templates are
 * convenient starting points, not design rules; every value can be
 * overridden with explicit `fields`.
 */

export interface TemplateResult {
  category: DatabaseCategory;
  fields: Record<string, unknown>;
  collections: Record<string, unknown[]>;
}

type P = Record<string, unknown>;

const num = (p: P, k: string, d: number): number => {
  const v = p[k];
  if (v === undefined) return d;
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalidInput(`templateParams.${k} must be a number.`);
  return v;
};
const str = (p: P, k: string, d: string): string => {
  const v = p[k];
  if (v === undefined) return d;
  if (typeof v !== "string") throw invalidInput(`templateParams.${k} must be a string.`);
  return v;
};
const ints = (p: P, k: string): number[] => {
  const v = p[k];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) throw invalidInput(`templateParams.${k} must be an array of IDs.`);
  return v as number[];
};

function params8(p: P): number[] {
  const keys = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"];
  return keys.map((k) => num(p, k, 0));
}

export const TEMPLATES: Record<string, { category: DatabaseCategory; description: string; params: string; build: (p: P) => TemplateResult }> = {
  consumable_item: {
    category: "item",
    description: "Consumable recovery item usable from the menu and in battle (e.g. Potion).",
    params: "hpRate? (0-1), hpFlat?, mpRate?, mpFlat?, price?=50, scope?=7 (1 Ally)",
    build: (p) => {
      const effects: unknown[] = [];
      const hpRate = num(p, "hpRate", 0);
      const hpFlat = num(p, "hpFlat", 0);
      const mpRate = num(p, "mpRate", 0);
      const mpFlat = num(p, "mpFlat", 0);
      if (hpRate || hpFlat) effects.push({ code: 11, dataId: 0, value1: hpRate, value2: hpFlat });
      if (mpRate || mpFlat) effects.push({ code: 12, dataId: 0, value1: mpRate, value2: mpFlat });
      if (!effects.length) effects.push({ code: 11, dataId: 0, value1: 0, value2: 500 });
      return {
        category: "item",
        fields: { itypeId: 1, consumable: true, price: num(p, "price", 50), scope: num(p, "scope", 7), occasion: 0, hitType: 0, animationId: num(p, "animationId", 0) },
        collections: { effects },
      };
    },
  },
  key_item: {
    category: "item",
    description: "Key item: not consumable, cannot be used, cannot be sold (price 0).",
    params: "(none)",
    build: () => ({ category: "item", fields: { itypeId: 2, consumable: false, price: 0, scope: 0, occasion: 3 }, collections: { effects: [] } }),
  },
  revival_item: {
    category: "item",
    description: "Revives a knocked-out ally (removes state 1) and restores HP.",
    params: "hpRate?=0.5, price?=500",
    build: (p) => ({
      category: "item",
      fields: { itypeId: 1, consumable: true, price: num(p, "price", 500), scope: 9, occasion: 0, animationId: num(p, "animationId", 0) },
      collections: {
        effects: [
          { code: 22, dataId: 1, value1: 1, value2: 0 },
          { code: 11, dataId: 0, value1: num(p, "hpRate", 0.5), value2: 0 },
        ],
      },
    }),
  },
  status_removal_item: {
    category: "item",
    description: "Removes the given states from one ally.",
    params: "stateIds: number[], price?=100",
    build: (p) => {
      const ids = ints(p, "stateIds");
      if (!ids.length) throw invalidInput("templateParams.stateIds is required.");
      return {
        category: "item",
        fields: { itypeId: 1, consumable: true, price: num(p, "price", 100), scope: 7, occasion: 0, animationId: num(p, "animationId", 0) },
        collections: { effects: ids.map((id) => ({ code: 22, dataId: id, value1: 1, value2: 0 })) },
      };
    },
  },
  healing_skill: {
    category: "skill",
    description: "Magical HP recovery skill for one ally.",
    params: "mpCost?=5, formula?=\"200 + a.mat\", scope?=7, stypeId?=1",
    build: (p) => ({
      category: "skill",
      fields: {
        stypeId: num(p, "stypeId", 1),
        mpCost: num(p, "mpCost", 5),
        scope: num(p, "scope", 7),
        occasion: 0,
        hitType: 0,
        animationId: num(p, "animationId", 0),
        "damage.type": 3,
        "damage.elementId": 0,
        "damage.formula": str(p, "formula", "200 + a.mat"),
        "damage.variance": 20,
        "damage.critical": false,
        message1: str(p, "message1", "%1 casts %2!"),
      },
      collections: { effects: [] },
    }),
  },
  damage_skill: {
    category: "skill",
    description: "Damage skill against enemies (magical by default).",
    params: "mpCost?=5, formula?=\"100 + a.mat * 2 - b.mdf * 2\", elementId?=0, scope?=1, hitType?=2, stypeId?=1",
    build: (p) => ({
      category: "skill",
      fields: {
        stypeId: num(p, "stypeId", 1),
        mpCost: num(p, "mpCost", 5),
        scope: num(p, "scope", 1),
        occasion: 1,
        hitType: num(p, "hitType", 2),
        animationId: num(p, "animationId", 0),
        "damage.type": 1,
        "damage.elementId": num(p, "elementId", 0),
        "damage.formula": str(p, "formula", "100 + a.mat * 2 - b.mdf * 2"),
        "damage.variance": 20,
        "damage.critical": false,
        message1: str(p, "message1", "%1 casts %2!"),
      },
      collections: { effects: [] },
    }),
  },
  state_skill: {
    category: "skill",
    description: "Skill that inflicts a state (no damage).",
    params: "stateId: number, chance?=1 (0-1), mpCost?=5, scope?=1",
    build: (p) => {
      const stateId = num(p, "stateId", 0);
      if (!stateId) throw invalidInput("templateParams.stateId is required.");
      return {
        category: "skill",
        fields: { stypeId: num(p, "stypeId", 1), mpCost: num(p, "mpCost", 5), scope: num(p, "scope", 1), occasion: 1, hitType: 2, "damage.type": 0, "damage.formula": "0", message1: str(p, "message1", "%1 casts %2!") },
        collections: { effects: [{ code: 21, dataId: stateId, value1: num(p, "chance", 1), value2: 0 }] },
      };
    },
  },
  weapon: {
    category: "weapon",
    description: "Weapon with parameter bonuses (keeps the editor's default Attack Element Physical + Hit Rate traits).",
    params: "wtypeId: number, atk?, def?, mat?, mdf?, agi?, luk?, mhp?, mmp?, price?=500, animationId?=0",
    build: (p) => ({
      category: "weapon",
      fields: { wtypeId: num(p, "wtypeId", 1), etypeId: 1, price: num(p, "price", 500), animationId: num(p, "animationId", 0), params: params8(p) },
      collections: {
        traits: [
          { code: 31, dataId: 1, value: 0 },
          { code: 22, dataId: 0, value: 0 },
        ],
      },
    }),
  },
  armor: {
    category: "armor",
    description: "Armor for an equipment slot with parameter bonuses.",
    params: "atypeId: number, etypeId?=4 (Body; 2 Shield, 3 Head, 5 Accessory per default System), def?, mdf?, ..., price?=300",
    build: (p) => ({
      category: "armor",
      fields: { atypeId: num(p, "atypeId", 1), etypeId: num(p, "etypeId", 4), price: num(p, "price", 300), params: params8(p) },
      collections: { traits: [{ code: 22, dataId: 1, value: 0 }] },
    }),
  },
  basic_enemy: {
    category: "enemy",
    description: "Enemy with parameters, rewards, drops and attack actions.",
    params: "battlerName?, mhp?=100, atk?=10, ... exp?=10, gold?=5, skillIds?=[1], drops?: {kind:1|2|3, dataId, denominator}[] (max 3)",
    build: (p) => {
      const skills = ints(p, "skillIds");
      const drops = Array.isArray(p.drops) ? (p.drops as Record<string, unknown>[]) : [];
      if (drops.length > 3) throw invalidInput("templateParams.drops: at most 3 drop entries.");
      const dropItems = [0, 1, 2].map((i) => {
        const d = drops[i];
        return d ? { dataId: num(d, "dataId", 1), denominator: num(d, "denominator", 1), kind: num(d, "kind", 1) } : { dataId: 1, denominator: 1, kind: 0 };
      });
      const prm = params8(p).map((v, i) => (v || [100, 0, 10, 10, 10, 10, 10, 10][i]!));
      return {
        category: "enemy",
        fields: { battlerName: str(p, "battlerName", ""), params: prm, exp: num(p, "exp", 10), gold: num(p, "gold", 5) },
        collections: {
          actions: (skills.length ? skills : [1]).map((s) => ({ skillId: s, rating: 5, conditionType: 0, conditionParam1: 0, conditionParam2: 0 })),
          dropItems,
          traits: [
            { code: 22, dataId: 0, value: 0.95 },
            { code: 22, dataId: 1, value: 0.05 },
            { code: 31, dataId: 1, value: 0 },
          ],
        },
      };
    },
  },
  actor: {
    category: "actor",
    description: "Actor with class, initial level and equipment.",
    params: "classId: number, initialLevel?=1, maxLevel?=99, equips?: number[5], characterName?, characterIndex?, faceName?, faceIndex?, battlerName?",
    build: (p) => {
      const eq = ints(p, "equips");
      return {
        category: "actor",
        fields: {
          classId: num(p, "classId", 1),
          initialLevel: num(p, "initialLevel", 1),
          maxLevel: num(p, "maxLevel", 99),
          equips: eq.length ? eq : [0, 0, 0, 0, 0],
          characterName: str(p, "characterName", ""),
          characterIndex: num(p, "characterIndex", 0),
          faceName: str(p, "faceName", ""),
          faceIndex: num(p, "faceIndex", 0),
          battlerName: str(p, "battlerName", ""),
        },
        collections: {},
      };
    },
  },
  state: {
    category: "state",
    description: "Battle state with turn-based removal and optional traits.",
    params: "restriction?=0, minTurns?=3, maxTurns?=5, autoRemovalTiming?=2 (Turn End), removeByDamage?, chanceByDamage?=100, iconIndex?",
    build: (p) => ({
      category: "state",
      fields: {
        restriction: num(p, "restriction", 0),
        autoRemovalTiming: num(p, "autoRemovalTiming", 2),
        minTurns: num(p, "minTurns", 3),
        maxTurns: num(p, "maxTurns", 5),
        removeAtBattleEnd: p.removeAtBattleEnd === undefined ? true : Boolean(p.removeAtBattleEnd),
        removeByDamage: Boolean(p.removeByDamage ?? false),
        chanceByDamage: num(p, "chanceByDamage", 100),
        iconIndex: num(p, "iconIndex", 0),
      },
      collections: {},
    }),
  },
};

export function expandTemplate(name: string, params: P = {}): TemplateResult {
  const t = TEMPLATES[name];
  if (!t) throw invalidInput(`Unknown template ${JSON.stringify(name)}. Templates: ${Object.keys(TEMPLATES).join(", ")}.`);
  return t.build(params);
}

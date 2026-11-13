import {
  AutoRemovalTiming,
  CommonEventTrigger,
  DamageType,
  DropKind,
  EnemyActionCondition,
  HitType,
  ItemType,
  MzEnum,
  Occasion,
  Restriction,
  Scope,
  StateMotion,
  TRAITS,
  EFFECTS,
  effectDef,
  traitDef,
  type DataIdKind,
} from "../adapters/rpg-maker-mz/enum-catalog.js";
import type { Ref, RefKind } from "../references/ref-types.js";

/**
 * Database category catalog (DATABASE_SPEC §3, §4, §6).
 *
 * Field specs were written against real MZ 1.10.0 records (newdata, sample
 * and user projects). Native JSON stays the source of truth: specs describe
 * which properties may be patched and how they are validated; properties not
 * listed are preserved untouched.
 */

export type DatabaseCategory =
  | "actor"
  | "class"
  | "skill"
  | "item"
  | "weapon"
  | "armor"
  | "enemy"
  | "troop"
  | "state"
  | "animation"
  | "tileset"
  | "common_event"
  | "system"
  | "map_info";

/** Kinds of lists stored in System.json and indexed by ID (1-based, index 0 unused). */
export type SystemListKind = "element" | "skill_type" | "weapon_type" | "armor_type" | "equip_type";

export const SYSTEM_LISTS: Record<SystemListKind, string> = {
  element: "elements",
  skill_type: "skillTypes",
  weapon_type: "weaponTypes",
  armor_type: "armorTypes",
  equip_type: "equipTypes",
};

export interface FieldSpec {
  /** Native property path, dotted for nested objects (e.g. "damage.formula"). */
  path: string;
  type: "string" | "int" | "number" | "bool" | "intArray" | "stringArray" | "audio" | "json";
  min?: number;
  max?: number;
  /** Required array length for array fields. */
  length?: number;
  enum?: MzEnum;
  /** Reference target, validated against the project. */
  ref?: RefKind;
  /** Special values allowed in addition to valid references (e.g. -1 = "Normal Attack"). */
  special?: Record<number, string>;
  description: string;
}

export interface CollectionEntryField {
  key: string;
  type: "int" | "number" | "string" | "bool" | "json";
  min?: number;
  max?: number;
  enum?: MzEnum;
  ref?: RefKind;
  description: string;
}

export interface CollectionSpec {
  /** Native property holding the array. */
  key: string;
  label: string;
  entry: CollectionEntryField[];
  /** Editor-mandated fixed length (entries may only be updated). */
  fixedLength?: number;
  /** Default entry used to fill omitted fields on add. */
  defaults: Record<string, unknown>;
}

export interface CategoryDef {
  category: DatabaseCategory;
  file: string;
  label: string;
  singleton?: boolean;
  fields: FieldSpec[];
  collections: CollectionSpec[];
  /** Blank record written by the editor for a new slot (without id). */
  blank?: () => Record<string, unknown>;
}

// ---------------------------------------------------------------- shared collections

const TRAIT_CODE = new MzEnum(
  "trait code",
  TRAITS.map((t) => ({ value: t.code, label: t.label, aliases: t.aliases })),
);
const EFFECT_CODE = new MzEnum(
  "effect code",
  EFFECTS.map((e) => ({ value: e.code, label: e.label, aliases: e.aliases })),
);

export const TRAITS_COLLECTION: CollectionSpec = {
  key: "traits",
  label: "Traits",
  entry: [
    { key: "code", type: "int", enum: TRAIT_CODE, description: "Trait type (label or code), e.g. \"State Resist\" / 14" },
    { key: "dataId", type: "int", min: 0, description: "Meaning depends on code (element, state, param, skill, type, flag...)" },
    { key: "value", type: "number", description: "Rate/value; meaning depends on code (rates are 0-1 floats, e.g. 1.5 = 150%)" },
  ],
  defaults: { dataId: 0, value: 0 },
};

export const EFFECTS_COLLECTION: CollectionSpec = {
  key: "effects",
  label: "Effects",
  entry: [
    { key: "code", type: "int", enum: EFFECT_CODE, description: "Effect type (label or code), e.g. \"Add State\" / 21" },
    { key: "dataId", type: "int", min: 0, description: "State/param/skill/common event ID depending on code (Add State 0 = Normal Attack)" },
    { key: "value1", type: "number", description: "Rate/chance (0-1) or amount, depending on code" },
    { key: "value2", type: "number", description: "Flat amount (Recover HP/MP), otherwise 0" },
  ],
  defaults: { dataId: 0, value1: 0, value2: 0 },
};

// ---------------------------------------------------------------- field helpers

const f = (path: string, type: FieldSpec["type"], description: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ path, type, description, ...extra });
const name = f("name", "string", "Display name");
const note = f("note", "string", "Note field (free text; plugins read <tags> from it)");
const description = f("description", "string", "Help text shown in menus");
const icon = f("iconIndex", "int", "Icon index in IconSet", { min: 0 });
const params8 = f("params", "intArray", "Parameter bonuses [MHP, MMP, ATK, DEF, MAT, MDF, AGI, LUK]", { length: 8 });
const price = f("price", "int", "Price in gold", { min: 0 });
const animationId = f("animationId", "int", "Animation (0 = none, -1 = Normal Attack)", { ref: "animation", special: { 0: "None", [-1]: "Normal Attack" } });

const usableItemFields: FieldSpec[] = [
  f("scope", "int", "Scope", { enum: Scope }),
  f("occasion", "int", "Occasion", { enum: Occasion }),
  f("speed", "int", "Speed modifier", { min: -2000, max: 2000 }),
  f("successRate", "int", "Success rate %", { min: 0, max: 100 }),
  f("repeats", "int", "Repeat count", { min: 1, max: 9 }),
  f("tpGain", "int", "TP gained by the user", { min: 0, max: 100 }),
  f("hitType", "int", "Hit type", { enum: HitType }),
  animationId,
  f("damage.type", "int", "Damage type", { enum: DamageType }),
  f("damage.elementId", "int", "Element (-1 = Normal Attack, 0 = None)", { ref: "element", special: { 0: "None", [-1]: "Normal Attack" } }),
  f("damage.formula", "string", "Damage formula (JavaScript expression evaluated by the battle system; never executed by this server)"),
  f("damage.variance", "int", "Damage variance %", { min: 0, max: 100 }),
  f("damage.critical", "bool", "Critical hits enabled"),
];

// ---------------------------------------------------------------- categories

export const CATEGORIES: readonly CategoryDef[] = [
  {
    category: "actor",
    file: "Actors.json",
    label: "Actors",
    fields: [
      name,
      f("nickname", "string", "Nickname"),
      f("profile", "string", "Profile text"),
      f("classId", "int", "Class", { ref: "class" }),
      f("initialLevel", "int", "Initial level", { min: 1, max: 99 }),
      f("maxLevel", "int", "Max level", { min: 1, max: 99 }),
      f("characterName", "string", "Walking character image (img/characters)"),
      f("characterIndex", "int", "Character index in sheet", { min: 0, max: 7 }),
      f("faceName", "string", "Face image (img/faces)"),
      f("faceIndex", "int", "Face index in sheet", { min: 0, max: 7 }),
      f("battlerName", "string", "Side-view battler image (img/sv_actors)"),
      f("equips", "intArray", "Initial equipment by slot (System equipTypes order; 0 = empty). Slot 0 is a weapon, other slots armors (slot 1 is a weapon with Dual Wield)"),
      note,
    ],
    collections: [TRAITS_COLLECTION],
    blank: () => ({
      battlerName: "",
      characterIndex: 0,
      characterName: "",
      classId: 1,
      equips: [0, 0, 0, 0, 0],
      faceIndex: 0,
      faceName: "",
      traits: [],
      initialLevel: 1,
      maxLevel: 99,
      name: "",
      nickname: "",
      note: "",
      profile: "",
    }),
  },
  {
    category: "class",
    file: "Classes.json",
    label: "Classes",
    fields: [name, f("expParams", "intArray", "EXP curve [base, extra, accelerationA, accelerationB]", { length: 4 }), note],
    collections: [
      TRAITS_COLLECTION,
      {
        key: "learnings",
        label: "Skills to learn",
        entry: [
          { key: "level", type: "int", min: 1, max: 99, description: "Level at which the skill is learned" },
          { key: "skillId", type: "int", min: 1, ref: "skill", description: "Skill ID" },
          { key: "note", type: "string", description: "Note" },
        ],
        defaults: { level: 1, note: "" },
      },
    ],
  },
  {
    category: "skill",
    file: "Skills.json",
    label: "Skills",
    fields: [
      name,
      description,
      icon,
      f("stypeId", "int", "Skill type (System skillTypes; 0 = none)", { ref: "skill_type", special: { 0: "None" } }),
      f("mpCost", "int", "MP cost", { min: 0, max: 9999 }),
      f("tpCost", "int", "TP cost", { min: 0, max: 100 }),
      f("message1", "string", "Battle message line 1 (%1 = user)"),
      f("message2", "string", "Battle message line 2"),
      f("requiredWtypeId1", "int", "Required weapon type 1 (0 = none)", { ref: "weapon_type", special: { 0: "None" } }),
      f("requiredWtypeId2", "int", "Required weapon type 2 (0 = none)", { ref: "weapon_type", special: { 0: "None" } }),
      ...usableItemFields,
      note,
    ],
    collections: [EFFECTS_COLLECTION],
    blank: () => ({
      animationId: 0,
      damage: { critical: false, elementId: 0, formula: "0", type: 0, variance: 20 },
      description: "",
      effects: [],
      hitType: 0,
      iconIndex: 0,
      message1: "",
      message2: "",
      mpCost: 0,
      name: "",
      note: "",
      occasion: 0,
      repeats: 1,
      requiredWtypeId1: 0,
      requiredWtypeId2: 0,
      scope: 1,
      speed: 0,
      stypeId: 1,
      successRate: 100,
      tpCost: 0,
      tpGain: 0,
      messageType: 1,
    }),
  },
  {
    category: "item",
    file: "Items.json",
    label: "Items",
    fields: [
      name,
      description,
      icon,
      f("itypeId", "int", "Item type", { enum: ItemType }),
      price,
      f("consumable", "bool", "Consumed on use"),
      ...usableItemFields,
      note,
    ],
    collections: [EFFECTS_COLLECTION],
    blank: () => ({
      animationId: 0,
      consumable: true,
      damage: { critical: false, elementId: 0, formula: "0", type: 0, variance: 20 },
      description: "",
      effects: [],
      hitType: 0,
      iconIndex: 0,
      itypeId: 1,
      name: "",
      note: "",
      occasion: 0,
      price: 0,
      repeats: 1,
      scope: 7,
      speed: 0,
      successRate: 100,
      tpGain: 0,
    }),
  },
  {
    category: "weapon",
    file: "Weapons.json",
    label: "Weapons",
    fields: [
      name,
      description,
      icon,
      f("wtypeId", "int", "Weapon type (System weaponTypes; 0 = none)", { ref: "weapon_type", special: { 0: "None" } }),
      f("etypeId", "int", "Equipment type (normally 1 = Weapon)", { ref: "equip_type" }),
      price,
      animationId,
      params8,
      note,
    ],
    collections: [TRAITS_COLLECTION],
    blank: () => ({
      animationId: 0,
      description: "",
      etypeId: 1,
      traits: [
        { code: 31, dataId: 1, value: 0 },
        { code: 22, dataId: 0, value: 0 },
      ],
      iconIndex: 0,
      name: "",
      note: "",
      params: [0, 0, 0, 0, 0, 0, 0, 0],
      price: 0,
      wtypeId: 0,
    }),
  },
  {
    category: "armor",
    file: "Armors.json",
    label: "Armors",
    fields: [
      name,
      description,
      icon,
      f("atypeId", "int", "Armor type (System armorTypes; 0 = none)", { ref: "armor_type", special: { 0: "None" } }),
      f("etypeId", "int", "Equipment slot type (System equipTypes, e.g. 2 = Shield)", { ref: "equip_type" }),
      price,
      params8,
      note,
    ],
    collections: [TRAITS_COLLECTION],
    blank: () => ({
      atypeId: 0,
      description: "",
      etypeId: 2,
      traits: [{ code: 22, dataId: 1, value: 0 }],
      iconIndex: 0,
      name: "",
      note: "",
      params: [0, 0, 0, 0, 0, 0, 0, 0],
      price: 0,
    }),
  },
  {
    category: "enemy",
    file: "Enemies.json",
    label: "Enemies",
    fields: [
      name,
      f("battlerName", "string", "Battler image (img/enemies or img/sv_enemies)"),
      f("battlerHue", "int", "Battler hue shift", { min: 0, max: 360 }),
      f("params", "intArray", "Parameters [MHP, MMP, ATK, DEF, MAT, MDF, AGI, LUK]", { length: 8 }),
      f("exp", "int", "EXP reward", { min: 0 }),
      f("gold", "int", "Gold reward", { min: 0 }),
      note,
    ],
    collections: [
      TRAITS_COLLECTION,
      {
        key: "actions",
        label: "Action patterns",
        entry: [
          { key: "skillId", type: "int", min: 1, ref: "skill", description: "Skill used" },
          { key: "rating", type: "int", min: 1, max: 9, description: "Rating (1-9)" },
          { key: "conditionType", type: "int", enum: EnemyActionCondition, description: "Condition type" },
          { key: "conditionParam1", type: "number", description: "Condition parameter 1 (turn a / HP-MP rate 0-1 / state ID / level / switch ID)" },
          { key: "conditionParam2", type: "number", description: "Condition parameter 2 (turn b / HP-MP rate 0-1)" },
        ],
        defaults: { rating: 5, conditionType: 0, conditionParam1: 0, conditionParam2: 0 },
      },
      {
        key: "dropItems",
        label: "Drop items",
        fixedLength: 3,
        entry: [
          { key: "kind", type: "int", enum: DropKind, description: "0 none, 1 item, 2 weapon, 3 armor" },
          // 0 is valid when kind is 0 (none); real drops are checked by the reference validator.
          { key: "dataId", type: "int", min: 0, description: "Item/weapon/armor ID (per kind; ignored when kind is 0)" },
          { key: "denominator", type: "int", min: 1, max: 1000, description: "Drop probability 1/denominator" },
        ],
        defaults: { kind: 0, dataId: 1, denominator: 1 },
      },
    ],
    blank: () => ({
      actions: [{ conditionParam1: 0, conditionParam2: 0, conditionType: 0, rating: 5, skillId: 1 }],
      battlerHue: 0,
      battlerName: "",
      dropItems: [
        { dataId: 1, denominator: 1, kind: 0 },
        { dataId: 1, denominator: 1, kind: 0 },
        { dataId: 1, denominator: 1, kind: 0 },
      ],
      exp: 0,
      traits: [
        { code: 22, dataId: 0, value: 0.95 },
        { code: 22, dataId: 1, value: 0.05 },
        { code: 31, dataId: 1, value: 0 },
      ],
      gold: 0,
      name: "",
      note: "",
      params: [100, 0, 10, 10, 10, 10, 10, 10],
    }),
  },
  {
    category: "troop",
    file: "Troops.json",
    label: "Troops",
    fields: [name],
    collections: [
      {
        key: "members",
        label: "Members",
        entry: [
          { key: "enemyId", type: "int", min: 1, ref: "enemy", description: "Enemy ID" },
          { key: "x", type: "int", description: "Screen X" },
          { key: "y", type: "int", description: "Screen Y" },
          { key: "hidden", type: "bool", description: "Appear halfway" },
        ],
        defaults: { x: 408, y: 436, hidden: false },
      },
    ],
    blank: () => ({
      members: [],
      name: "",
      pages: [
        {
          conditions: {
            actorHp: 50,
            actorId: 1,
            actorValid: false,
            enemyHp: 50,
            enemyIndex: 0,
            enemyValid: false,
            switchId: 1,
            switchValid: false,
            turnA: 0,
            turnB: 0,
            turnEnding: false,
            turnValid: false,
          },
          list: [{ code: 0, indent: 0, parameters: [] }],
          span: 0,
        },
      ],
    }),
  },
  {
    category: "state",
    file: "States.json",
    label: "States",
    fields: [
      name,
      icon,
      f("restriction", "int", "Restriction", { enum: Restriction }),
      f("priority", "int", "Display priority", { min: 0, max: 100 }),
      f("motion", "int", "SV motion", { enum: StateMotion }),
      f("overlay", "int", "SV overlay (0 none, 1-10)", { min: 0, max: 10 }),
      f("removeAtBattleEnd", "bool", "Remove at battle end"),
      f("removeByRestriction", "bool", "Remove by restriction"),
      f("autoRemovalTiming", "int", "Auto-removal timing", { enum: AutoRemovalTiming }),
      f("minTurns", "int", "Duration min turns", { min: 0, max: 9999 }),
      f("maxTurns", "int", "Duration max turns", { min: 0, max: 9999 }),
      f("removeByDamage", "bool", "Remove by damage"),
      f("chanceByDamage", "int", "Removal chance by damage %", { min: 0, max: 100 }),
      f("removeByWalking", "bool", "Remove by walking"),
      f("stepsToRemove", "int", "Steps to remove", { min: 0, max: 9999 }),
      f("releaseByDamage", "bool", "Release by damage (MZ 1.x field; present only in newer data)"),
      f("message1", "string", "Message when an actor is inflicted (%1 = name)"),
      f("message2", "string", "Message when an enemy is inflicted"),
      f("message3", "string", "Message while the state persists"),
      f("message4", "string", "Message when the state is removed"),
      note,
    ],
    collections: [TRAITS_COLLECTION],
    blank: () => ({
      autoRemovalTiming: 0,
      chanceByDamage: 100,
      traits: [],
      iconIndex: 0,
      maxTurns: 1,
      message1: "",
      message2: "",
      message3: "",
      message4: "",
      minTurns: 1,
      motion: 0,
      name: "",
      note: "",
      overlay: 0,
      priority: 50,
      removeAtBattleEnd: false,
      removeByDamage: false,
      removeByRestriction: false,
      removeByWalking: false,
      restriction: 0,
      stepsToRemove: 100,
      messageType: 1,
    }),
  },
  {
    category: "animation",
    file: "Animations.json",
    label: "Animations",
    fields: [
      name,
      f("effectName", "string", "Effekseer effect file (effects/)"),
      f("displayType", "int", "0 = for each target, 1 = for all targets (center), 2 = screen center", { min: 0, max: 2 }),
      f("offsetX", "int", "Offset X"),
      f("offsetY", "int", "Offset Y"),
      f("scale", "int", "Scale %", { min: 0 }),
      f("speed", "int", "Speed %", { min: 0 }),
      f("rotation.x", "number", "Rotation X"),
      f("rotation.y", "number", "Rotation Y"),
      f("rotation.z", "number", "Rotation Z"),
    ],
    collections: [
      {
        key: "flashTimings",
        label: "Flash timings",
        entry: [
          { key: "frame", type: "int", min: 0, description: "Frame" },
          { key: "duration", type: "int", min: 1, description: "Duration (frames)" },
          { key: "color", type: "json", description: "[r, g, b, intensity]" },
        ],
        defaults: { frame: 0, duration: 30, color: [255, 255, 255, 255] },
      },
      {
        key: "soundTimings",
        label: "Sound timings",
        entry: [
          { key: "frame", type: "int", min: 0, description: "Frame" },
          { key: "se", type: "json", description: "{name, pan, pitch, volume}" },
        ],
        defaults: { frame: 0 },
      },
    ],
  },
  {
    category: "tileset",
    file: "Tilesets.json",
    label: "Tilesets",
    fields: [name, f("mode", "int", "0 = world type, 1 = area type", { min: 0, max: 1 }), f("tilesetNames", "stringArray", "Tileset images [A1..A5, B..E]", { length: 9 }), note],
    collections: [],
  },
  {
    category: "common_event",
    file: "CommonEvents.json",
    label: "Common Events",
    fields: [name, f("trigger", "int", "Trigger", { enum: CommonEventTrigger }), f("switchId", "int", "Condition switch (used when trigger is Autorun/Parallel)", { ref: "switch" })],
    collections: [],
    blank: () => ({ list: [{ code: 0, indent: 0, parameters: [] }], name: "", switchId: 1, trigger: 0 }),
  },
  {
    category: "system",
    file: "System.json",
    label: "System",
    singleton: true,
    fields: [
      f("gameTitle", "string", "Game title"),
      f("currencyUnit", "string", "Currency unit"),
      f("startMapId", "int", "Player start map", { ref: "map" }),
      f("startX", "int", "Player start X", { min: 0 }),
      f("startY", "int", "Player start Y", { min: 0 }),
      f("partyMembers", "intArray", "Starting party actor IDs"),
      f("title1Name", "string", "Title background (img/titles1)"),
      f("title2Name", "string", "Title frame (img/titles2)"),
      f("titleBgm", "audio", "Title BGM"),
      f("battleBgm", "audio", "Battle BGM"),
      f("victoryMe", "audio", "Victory ME"),
      f("defeatMe", "audio", "Defeat ME"),
      f("gameoverMe", "audio", "Game over ME"),
      f("windowTone", "intArray", "Window color [r, g, b, 0]", { length: 4 }),
      f("optDrawTitle", "bool", "Draw game title on title screen"),
      f("optFollowers", "bool", "Show party followers"),
      f("optSideView", "bool", "Side-view battle"),
      f("optTransparent", "bool", "Start transparent"),
      f("optDisplayTp", "bool", "Display TP in battle"),
      f("optFloorDeath", "bool", "Knockout by floor damage"),
      f("optSlipDeath", "bool", "Knockout by slip damage"),
      f("optExtraExp", "bool", "EXP for reserve members"),
      f("optKeyItemsNumber", "bool", "Show key item numbers"),
      f("optAutosave", "bool", "Enable autosave"),
      f("battleSystem", "int", "0 = Turn-based, 1 = Time progress (active), 2 = Time progress (wait)", { min: 0, max: 2 }),
    ],
    collections: [],
  },
  {
    category: "map_info",
    file: "MapInfos.json",
    label: "Map Infos",
    fields: [name, f("parentId", "int", "Parent map in the tree (0 = root)", { min: 0, ref: "map", special: { 0: "(root)" } }), f("order", "int", "Tree order", { min: 0 }), f("expanded", "bool", "Expanded in the editor tree")],
    collections: [],
  },
];

const BY_CATEGORY = new Map(CATEGORIES.map((c) => [c.category, c]));

export function categoryDef(category: string): CategoryDef | undefined {
  return BY_CATEGORY.get(category as DatabaseCategory);
}

export const CATEGORY_NAMES = CATEGORIES.map((c) => c.category);

/** Map reference kinds to database categories. */
export const REF_KIND_CATEGORY: Partial<Record<RefKind, DatabaseCategory>> = {
  actor: "actor",
  class: "class",
  skill: "skill",
  item: "item",
  weapon: "weapon",
  armor: "armor",
  enemy: "enemy",
  troop: "troop",
  state: "state",
  animation: "animation",
  tileset: "tileset",
  common_event: "common_event",
  map: "map_info",
};

export const CATEGORY_REF_KIND: Partial<Record<DatabaseCategory, RefKind>> = Object.fromEntries(
  Object.entries(REF_KIND_CATEGORY).map(([k, v]) => [v, k as RefKind]),
) as Partial<Record<DatabaseCategory, RefKind>>;

// ---------------------------------------------------------------- record references

/** Translate a trait/effect dataId kind into a reference kind (if it refers to a project entity). */
export function dataIdRefKind(kind: DataIdKind): RefKind | null {
  switch (kind) {
    case "element":
      return "element";
    case "state":
      return "state";
    case "skill":
      return "skill";
    case "skillType":
      return "skill_type";
    case "weaponType":
      return "weapon_type";
    case "armorType":
      return "armor_type";
    case "equipType":
      return "equip_type";
    case "commonEvent":
      return "common_event";
    default:
      return null;
  }
}

function traitRefs(traits: unknown, via: string): Ref[] {
  const out: Ref[] = [];
  if (!Array.isArray(traits)) return out;
  traits.forEach((t, i) => {
    if (!t || typeof t !== "object") return;
    const tr = t as { code: number; dataId: number };
    const d = traitDef(tr.code);
    const kind = d ? dataIdRefKind(d.dataId) : null;
    if (kind && typeof tr.dataId === "number") {
      // Attack Element / Element Rate dataId 0 is unusual but not a "Normal Attack" sentinel.
      out.push({ kind, id: tr.dataId, role: "use", via: `${via}[${i}] ${d?.label}` });
    }
  });
  return out;
}

function effectRefs(effects: unknown, via: string): Ref[] {
  const out: Ref[] = [];
  if (!Array.isArray(effects)) return out;
  effects.forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const ef = e as { code: number; dataId: number };
    const d = effectDef(ef.code);
    const kind = d ? dataIdRefKind(d.dataId) : null;
    if (!kind || typeof ef.dataId !== "number") return;
    if (kind === "state" && ef.dataId === 0) return; // 0 = "Normal Attack" states
    out.push({ kind, id: ef.dataId, role: kind === "common_event" ? "call" : "use", via: `${via}[${i}] ${d?.label}` });
  });
  return out;
}

const DROP_KIND_REF: Record<number, RefKind> = { 1: "item", 2: "weapon", 3: "armor" };

/**
 * Native references from one database record (not including event command
 * lists, which the reference resolver parses with the Event IR).
 */
export function recordRefs(category: DatabaseCategory, r: Record<string, unknown>): Ref[] {
  const out: Ref[] = [];
  const add = (kind: RefKind, id: unknown, via: string, special: number[] = [0]) => {
    if (typeof id === "number" && !special.includes(id)) out.push({ kind, id, role: "use", via });
  };
  switch (category) {
    case "actor": {
      add("class", r.classId, "classId");
      const traits = Array.isArray(r.traits) ? (r.traits as { code: number; dataId: number }[]) : [];
      const dualWield = traits.some((t) => t.code === 55 && t.dataId === 1);
      if (Array.isArray(r.equips)) {
        (r.equips as unknown[]).forEach((id, slot) => add(slot === 0 || (slot === 1 && dualWield) ? "weapon" : "armor", id, `equips[${slot}]`));
      }
      out.push(...traitRefs(r.traits, "traits"));
      break;
    }
    case "class":
      if (Array.isArray(r.learnings)) (r.learnings as { skillId: number }[]).forEach((l, i) => add("skill", l?.skillId, `learnings[${i}]`));
      out.push(...traitRefs(r.traits, "traits"));
      break;
    case "skill":
    case "item": {
      add("animation", r.animationId, "animationId", [0, -1]);
      const dmg = r.damage as { elementId?: number } | undefined;
      add("element", dmg?.elementId, "damage.elementId", [0, -1]);
      if (category === "skill") {
        add("skill_type", r.stypeId, "stypeId");
        add("weapon_type", r.requiredWtypeId1, "requiredWtypeId1");
        add("weapon_type", r.requiredWtypeId2, "requiredWtypeId2");
      }
      out.push(...effectRefs(r.effects, "effects"));
      break;
    }
    case "weapon":
      add("weapon_type", r.wtypeId, "wtypeId");
      add("equip_type", r.etypeId, "etypeId");
      add("animation", r.animationId, "animationId", [0, -1]);
      out.push(...traitRefs(r.traits, "traits"));
      break;
    case "armor":
      add("armor_type", r.atypeId, "atypeId");
      add("equip_type", r.etypeId, "etypeId");
      out.push(...traitRefs(r.traits, "traits"));
      break;
    case "enemy":
      if (Array.isArray(r.actions)) {
        (r.actions as { skillId: number; conditionType: number; conditionParam1: number }[]).forEach((a, i) => {
          add("skill", a?.skillId, `actions[${i}].skillId`);
          if (a?.conditionType === 4) add("state", a.conditionParam1, `actions[${i}] state condition`);
          if (a?.conditionType === 6) add("switch", a.conditionParam1, `actions[${i}] switch condition`);
        });
      }
      if (Array.isArray(r.dropItems)) {
        (r.dropItems as { kind: number; dataId: number }[]).forEach((d, i) => {
          const kind = DROP_KIND_REF[d?.kind];
          if (kind) add(kind, d.dataId, `dropItems[${i}]`);
        });
      }
      out.push(...traitRefs(r.traits, "traits"));
      break;
    case "troop":
      if (Array.isArray(r.members)) (r.members as { enemyId: number }[]).forEach((m, i) => add("enemy", m?.enemyId, `members[${i}]`));
      if (Array.isArray(r.pages)) {
        (r.pages as { conditions?: Record<string, unknown> }[]).forEach((p, i) => {
          const c = p?.conditions;
          if (c?.switchValid) add("switch", c.switchId, `pages[${i}].conditions.switchId`);
          if (c?.actorValid) add("actor", c.actorId, `pages[${i}].conditions.actorId`);
        });
      }
      break;
    case "state":
      out.push(...traitRefs(r.traits, "traits"));
      break;
    case "common_event":
      if (r.trigger !== 0) add("switch", r.switchId, "switchId");
      break;
    case "system": {
      if (Array.isArray(r.partyMembers)) (r.partyMembers as number[]).forEach((id, i) => add("actor", id, `partyMembers[${i}]`));
      add("map", r.startMapId, "startMapId");
      for (const v of ["boat", "ship", "airship"]) {
        const veh = r[v] as { startMapId?: number } | undefined;
        add("map", veh?.startMapId, `${v}.startMapId`);
      }
      if (Array.isArray(r.testBattlers)) (r.testBattlers as { actorId: number }[]).forEach((b, i) => add("actor", b?.actorId, `testBattlers[${i}]`));
      add("troop", r.testTroopId, "testTroopId");
      break;
    }
    case "map_info":
      add("map", r.parentId, "parentId");
      break;
    default:
      break;
  }
  for (const ref of out) ref.origin = "native";
  return out;
}

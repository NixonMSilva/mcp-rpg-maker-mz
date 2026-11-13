import { invalidInput } from "../../project/errors.js";

/**
 * Centralized RPG Maker MZ enumerations (DATABASE_SPEC §4.3, EVENT_SPEC §7).
 *
 * Values were taken from the MZ 1.10.0 engine source (rmmz_objects.js:
 * Game_Interpreter, Game_Action, Game_BattlerBase, Game_Character,
 * Game_Event, Game_Enemy) and checked against editor-written JSON.
 *
 * Each enum maps native numeric (or string) values to a primary label plus
 * accepted aliases. Parsing accepts the native value, the label or an alias
 * (case/space/underscore-insensitive) and rejects anything else; unknown
 * labels are never guessed.
 */

export interface EnumEntry<V extends number | string = number> {
  value: V;
  label: string;
  aliases?: string[];
}

export function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, "").replace(/[()']/g, "");
}

export class MzEnum<V extends number | string = number> {
  private readonly byValue = new Map<V, EnumEntry<V>>();
  private readonly byLabel = new Map<string, V>();

  constructor(
    readonly name: string,
    readonly entries: readonly EnumEntry<V>[],
  ) {
    for (const e of entries) {
      this.byValue.set(e.value, e);
      for (const l of [e.label, ...(e.aliases ?? [])]) this.byLabel.set(normalizeLabel(l), e.value);
    }
  }

  has(value: unknown): value is V {
    return this.byValue.has(value as V);
  }

  label(value: unknown): string {
    const e = this.byValue.get(value as V);
    return e ? e.label : `Unknown (${String(value)})`;
  }

  /** snake_case key of the label, used for enum values inside the Event IR (e.g. "action_button"). */
  key(value: unknown): string {
    const e = this.byValue.get(value as V);
    if (!e) return String(value);
    if (/^[<>=!]+$/.test(e.label)) return e.label;
    return e.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  /** Readable form `{ value, label }` used in normalized output. */
  symbolic(value: unknown): { value: unknown; label: string } {
    return { value, label: this.label(value) };
  }

  /** Accept a native value or an unambiguous label/alias; throw INVALID_INPUT otherwise. */
  parse(input: unknown, field = this.name): V {
    if (input !== null && typeof input === "object" && "value" in (input as object)) {
      return this.parse((input as { value: unknown }).value, field);
    }
    if (this.byValue.has(input as V)) return input as V;
    if (typeof input === "string") {
      const v = this.byLabel.get(normalizeLabel(input));
      if (v !== undefined) return v;
      // Numeric strings for numeric enums.
      if (/^-?\d+$/.test(input.trim())) {
        const n = Number(input) as V;
        if (this.byValue.has(n)) return n;
      }
    }
    throw invalidInput(
      `Invalid ${field}: ${JSON.stringify(input)}. Expected one of: ${this.entries
        .map((e) => `${JSON.stringify(e.value)} (${e.label})`)
        .join(", ")}.`,
    );
  }

  options(): string {
    return this.entries.map((e) => `${e.value}=${e.label}`).join(", ");
  }
}

const e = <V extends number | string>(value: V, label: string, ...aliases: string[]): EnumEntry<V> =>
  aliases.length ? { value, label, aliases } : { value, label };

// ---------------------------------------------------------------- event pages
export const Trigger = new MzEnum("trigger", [
  e(0, "Action Button", "action", "button"),
  e(1, "Player Touch", "player_touch"),
  e(2, "Event Touch", "event_touch"),
  e(3, "Autorun", "auto"),
  e(4, "Parallel", "parallel_process"),
]);

export const PriorityType = new MzEnum("priorityType", [
  e(0, "Below characters", "below"),
  e(1, "Same as characters", "same", "same_as_characters"),
  e(2, "Above characters", "above"),
]);

export const MoveType = new MzEnum("moveType", [
  e(0, "Fixed"),
  e(1, "Random"),
  e(2, "Approach"),
  e(3, "Custom"),
]);

export const MoveSpeed = new MzEnum("moveSpeed", [
  e(1, "1: x8 Slower", "x8 slower"),
  e(2, "2: x4 Slower", "x4 slower"),
  e(3, "3: x2 Slower", "x2 slower"),
  e(4, "4: Normal", "normal"),
  e(5, "5: x2 Faster", "x2 faster"),
  e(6, "6: x4 Faster", "x4 faster"),
]);

export const MoveFrequency = new MzEnum("moveFrequency", [
  e(1, "1: Lowest", "lowest"),
  e(2, "2: Lower", "lower"),
  e(3, "3: Normal", "normal"),
  e(4, "4: Higher", "higher"),
  e(5, "5: Highest", "highest"),
]);

export const Direction = new MzEnum("direction", [
  e(2, "Down"),
  e(4, "Left"),
  e(6, "Right"),
  e(8, "Up"),
]);

/** Direction parameter where 0 means "retain" (Transfer Player, Set Event Location). */
export const DirectionOrRetain = new MzEnum("direction", [
  e(0, "Retain", "keep", "none"),
  e(2, "Down"),
  e(4, "Left"),
  e(6, "Right"),
  e(8, "Up"),
]);

export const SelfSwitchCh = new MzEnum<string>("selfSwitch", [e("A", "A"), e("B", "B"), e("C", "C"), e("D", "D")]);

export const CommonEventTrigger = new MzEnum("commonEventTrigger", [
  e(0, "None"),
  e(1, "Autorun"),
  e(2, "Parallel"),
]);

export const TroopPageSpan = new MzEnum("span", [e(0, "Battle"), e(1, "Turn"), e(2, "Moment")]);

// ----------------------------------------------------------- event commands
export const MessageBackground = new MzEnum("background", [
  e(0, "Window"),
  e(1, "Dim"),
  e(2, "Transparent"),
]);

export const MessagePosition = new MzEnum("position", [e(0, "Top"), e(1, "Middle"), e(2, "Bottom")]);

export const ChoicePosition = new MzEnum("position", [e(0, "Left"), e(1, "Middle"), e(2, "Right")]);

export const OnOff = new MzEnum("value", [e(0, "ON", "true", "on"), e(1, "OFF", "false", "off")]);

export const VariableOperation = new MzEnum("operation", [
  e(0, "Set", "="),
  e(1, "Add", "+="),
  e(2, "Sub", "-=", "subtract"),
  e(3, "Mul", "*=", "multiply"),
  e(4, "Div", "/=", "divide"),
  e(5, "Mod", "%=", "modulo"),
]);

export const Comparison = new MzEnum("comparison", [
  e(0, "==", "equal", "eq"),
  e(1, ">=", "greater_or_equal", "gte", "ge"),
  e(2, "<=", "less_or_equal", "lte", "le"),
  e(3, ">", "greater", "gt"),
  e(4, "<", "less", "lt"),
  e(5, "!=", "not_equal", "ne"),
]);

export const GoldComparison = new MzEnum("comparison", [e(0, ">="), e(1, "<="), e(2, "<")]);

export const IncreaseDecrease = new MzEnum("operation", [
  e(0, "Increase", "+", "add", "gain"),
  e(1, "Decrease", "-", "remove", "lose"),
]);

export const AddRemove = new MzEnum("operation", [e(0, "Add"), e(1, "Remove")]);

export const OperandType = new MzEnum("operandType", [e(0, "Constant"), e(1, "Variable")]);

export const FadeType = new MzEnum("fade", [e(0, "Black"), e(1, "White"), e(2, "None")]);

export const Vehicle = new MzEnum("vehicle", [e(0, "Boat"), e(1, "Ship"), e(2, "Airship")]);

export const ItemChoiceType = new MzEnum("itemType", [
  e(1, "Regular Item", "regular", "item"),
  e(2, "Key Item", "key"),
  e(3, "Hidden Item A", "hidden_a"),
  e(4, "Hidden Item B", "hidden_b"),
]);

export const BalloonId = new MzEnum("balloonId", [
  e(1, "Exclamation"),
  e(2, "Question"),
  e(3, "Music Note"),
  e(4, "Heart"),
  e(5, "Anger"),
  e(6, "Sweat"),
  e(7, "Frustration", "cobweb"),
  e(8, "Silence"),
  e(9, "Light Bulb"),
  e(10, "Zzz"),
  e(11, "User-defined 1"),
  e(12, "User-defined 2"),
  e(13, "User-defined 3"),
  e(14, "User-defined 4"),
  e(15, "User-defined 5"),
]);

export const ShopGoodsType = new MzEnum("goodsType", [e(0, "Item"), e(1, "Weapon"), e(2, "Armor")]);

/** Event character reference used by many commands: -1 player, 0 this event, >0 map event ID. */
export function characterLabel(id: number): string {
  if (id === -1) return "Player";
  if (id === 0) return "This Event";
  return `Event ${id}`;
}

export function parseCharacter(input: unknown, field = "character"): number {
  if (typeof input === "number" && Number.isInteger(input) && input >= -1) return input;
  if (typeof input === "string") {
    const n = normalizeLabel(input);
    if (n === "player") return -1;
    if (n === "thisevent" || n === "self" || n === "this") return 0;
    const m = /^(?:event)?(\d+)$/.exec(n);
    if (m) return Number(m[1]);
  }
  throw invalidInput(`Invalid ${field}: ${JSON.stringify(input)}. Use -1/"player", 0/"this_event", or a map event ID.`);
}

// --------------------------------------------------------------- database
export const ParamId = new MzEnum("paramId", [
  e(0, "Max HP", "mhp", "hp"),
  e(1, "Max MP", "mmp", "mp"),
  e(2, "Attack", "atk"),
  e(3, "Defense", "def"),
  e(4, "M.Attack", "mat", "magic attack"),
  e(5, "M.Defense", "mdf", "magic defense"),
  e(6, "Agility", "agi"),
  e(7, "Luck", "luk"),
]);

export const XParamId = new MzEnum("xparamId", [
  e(0, "Hit Rate", "hit"),
  e(1, "Evasion Rate", "eva"),
  e(2, "Critical Rate", "cri"),
  e(3, "Critical Evasion", "cev"),
  e(4, "Magic Evasion", "mev"),
  e(5, "Magic Reflection", "mrf"),
  e(6, "Counter Attack", "cnt"),
  e(7, "HP Regeneration", "hrg"),
  e(8, "MP Regeneration", "mrg"),
  e(9, "TP Regeneration", "trg"),
]);

export const SParamId = new MzEnum("sparamId", [
  e(0, "Target Rate", "tgr"),
  e(1, "Guard Effect", "grd"),
  e(2, "Recovery Effect", "rec"),
  e(3, "Pharmacology", "pha"),
  e(4, "MP Cost Rate", "mcr"),
  e(5, "TP Charge Rate", "tcr"),
  e(6, "Physical Damage", "pdr"),
  e(7, "Magic Damage", "mdr"),
  e(8, "Floor Damage", "fdr"),
  e(9, "Experience", "exr"),
]);

export const Scope = new MzEnum("scope", [
  e(0, "None"),
  e(1, "1 Enemy", "one enemy"),
  e(2, "All Enemies"),
  e(3, "1 Random Enemy", "one random enemy"),
  e(4, "2 Random Enemies"),
  e(5, "3 Random Enemies"),
  e(6, "4 Random Enemies"),
  e(7, "1 Ally", "one ally"),
  e(8, "All Allies"),
  e(9, "1 Ally (Dead)", "one ally dead"),
  e(10, "All Allies (Dead)", "all allies dead"),
  e(11, "The User", "user", "self"),
  e(12, "1 Ally (Unconditional)", "one ally unconditional"),
  e(13, "All Allies (Unconditional)", "all allies unconditional"),
  e(14, "Enemies & Allies", "everyone", "all"),
]);

export const Occasion = new MzEnum("occasion", [
  e(0, "Always"),
  e(1, "Battle Screen", "battle"),
  e(2, "Menu Screen", "menu"),
  e(3, "Never"),
]);

export const HitType = new MzEnum("hitType", [
  e(0, "Certain Hit", "certain"),
  e(1, "Physical Attack", "physical"),
  e(2, "Magical Attack", "magical"),
]);

export const DamageType = new MzEnum("damageType", [
  e(0, "None"),
  e(1, "HP Damage"),
  e(2, "MP Damage"),
  e(3, "HP Recover", "hp recovery"),
  e(4, "MP Recover", "mp recovery"),
  e(5, "HP Drain"),
  e(6, "MP Drain"),
]);

export const ItemType = new MzEnum("itypeId", [
  e(1, "Regular Item", "regular"),
  e(2, "Key Item", "key"),
  e(3, "Hidden Item A", "hidden_a"),
  e(4, "Hidden Item B", "hidden_b"),
]);

export const Restriction = new MzEnum("restriction", [
  e(0, "None"),
  e(1, "Attack an enemy", "attack enemy"),
  e(2, "Attack anyone"),
  e(3, "Attack an ally", "attack ally"),
  e(4, "Cannot move"),
]);

export const AutoRemovalTiming = new MzEnum("autoRemovalTiming", [
  e(0, "None"),
  e(1, "Action End"),
  e(2, "Turn End"),
]);

export const StateMotion = new MzEnum("motion", [e(0, "Normal"), e(1, "Abnormal"), e(2, "Sleep"), e(3, "Dead")]);

export const EnemyActionCondition = new MzEnum("conditionType", [
  e(0, "Always"),
  e(1, "Turn"),
  e(2, "HP"),
  e(3, "MP"),
  e(4, "State"),
  e(5, "Party Level"),
  e(6, "Switch"),
]);

export const DropKind = new MzEnum("kind", [e(0, "None"), e(1, "Item"), e(2, "Weapon"), e(3, "Armor")]);

export const SpecialFlag = new MzEnum("flagId", [
  e(0, "Auto Battle"),
  e(1, "Guard"),
  e(2, "Substitute"),
  e(3, "Preserve TP"),
]);

export const CollapseType = new MzEnum("collapseType", [
  e(0, "Normal"),
  e(1, "Boss"),
  e(2, "Instant"),
  e(3, "No Disappear"),
]);

export const PartyAbility = new MzEnum("partyAbility", [
  e(0, "Encounter Half"),
  e(1, "Encounter None"),
  e(2, "Cancel Surprise"),
  e(3, "Raise Preemptive"),
  e(4, "Gold Double"),
  e(5, "Drop Item Double"),
]);

export const SlotType = new MzEnum("slotType", [e(0, "Normal"), e(1, "Dual Wield")]);

/** How a trait's dataId is interpreted, used for labels and reference resolution. */
export type DataIdKind =
  | "element"
  | "param"
  | "xparam"
  | "sparam"
  | "state"
  | "skill"
  | "skillType"
  | "weaponType"
  | "armorType"
  | "equipType"
  | "slotType"
  | "specialFlag"
  | "collapseType"
  | "partyAbility"
  | "commonEvent"
  | "none";

export interface TraitDef {
  code: number;
  label: string;
  aliases: string[];
  dataId: DataIdKind;
  /** Meaning of `value`. */
  value: "rate" | "add" | "chance" | "number" | "none";
}

export const TRAITS: readonly TraitDef[] = [
  { code: 11, label: "Element Rate", aliases: ["element_rate"], dataId: "element", value: "rate" },
  { code: 12, label: "Debuff Rate", aliases: ["debuff_rate"], dataId: "param", value: "rate" },
  { code: 13, label: "State Rate", aliases: ["state_rate"], dataId: "state", value: "rate" },
  { code: 14, label: "State Resist", aliases: ["state_resist"], dataId: "state", value: "none" },
  { code: 21, label: "Parameter", aliases: ["param"], dataId: "param", value: "rate" },
  { code: 22, label: "Ex-Parameter", aliases: ["xparam", "ex_param"], dataId: "xparam", value: "add" },
  { code: 23, label: "Sp-Parameter", aliases: ["sparam", "sp_param"], dataId: "sparam", value: "rate" },
  { code: 31, label: "Attack Element", aliases: ["attack_element"], dataId: "element", value: "none" },
  { code: 32, label: "Attack State", aliases: ["attack_state"], dataId: "state", value: "chance" },
  { code: 33, label: "Attack Speed", aliases: ["attack_speed"], dataId: "none", value: "number" },
  { code: 34, label: "Attack Times+", aliases: ["attack_times"], dataId: "none", value: "number" },
  { code: 35, label: "Attack Skill", aliases: ["attack_skill"], dataId: "skill", value: "none" },
  { code: 41, label: "Add Skill Type", aliases: ["stype_add", "add_skill_type"], dataId: "skillType", value: "none" },
  { code: 42, label: "Seal Skill Type", aliases: ["stype_seal", "seal_skill_type"], dataId: "skillType", value: "none" },
  { code: 43, label: "Add Skill", aliases: ["skill_add", "add_skill"], dataId: "skill", value: "none" },
  { code: 44, label: "Seal Skill", aliases: ["skill_seal", "seal_skill"], dataId: "skill", value: "none" },
  { code: 51, label: "Equip Weapon", aliases: ["equip_wtype", "equip_weapon"], dataId: "weaponType", value: "none" },
  { code: 52, label: "Equip Armor", aliases: ["equip_atype", "equip_armor"], dataId: "armorType", value: "none" },
  { code: 53, label: "Lock Equip", aliases: ["equip_lock", "lock_equip"], dataId: "equipType", value: "none" },
  { code: 54, label: "Seal Equip", aliases: ["equip_seal", "seal_equip"], dataId: "equipType", value: "none" },
  { code: 55, label: "Slot Type", aliases: ["slot_type"], dataId: "slotType", value: "none" },
  { code: 61, label: "Action Times+", aliases: ["action_plus", "action_times"], dataId: "none", value: "chance" },
  { code: 62, label: "Special Flag", aliases: ["special_flag"], dataId: "specialFlag", value: "none" },
  { code: 63, label: "Collapse Effect", aliases: ["collapse_type", "collapse_effect"], dataId: "collapseType", value: "none" },
  { code: 64, label: "Party Ability", aliases: ["party_ability"], dataId: "partyAbility", value: "none" },
];

export const TraitCode = new MzEnum(
  "trait code",
  TRAITS.map((t) => ({ value: t.code, label: t.label, aliases: t.aliases })),
);

export interface EffectDef {
  code: number;
  label: string;
  aliases: string[];
  dataId: DataIdKind;
  value1: string;
  value2: string;
}

export const EFFECTS: readonly EffectDef[] = [
  { code: 11, label: "Recover HP", aliases: ["recover_hp"], dataId: "none", value1: "rate (0-1)", value2: "flat amount" },
  { code: 12, label: "Recover MP", aliases: ["recover_mp"], dataId: "none", value1: "rate (0-1)", value2: "flat amount" },
  { code: 13, label: "Gain TP", aliases: ["gain_tp"], dataId: "none", value1: "amount", value2: "unused" },
  { code: 21, label: "Add State", aliases: ["add_state"], dataId: "state", value1: "chance (0-1)", value2: "unused" },
  { code: 22, label: "Remove State", aliases: ["remove_state"], dataId: "state", value1: "chance (0-1)", value2: "unused" },
  { code: 31, label: "Add Buff", aliases: ["add_buff"], dataId: "param", value1: "turns", value2: "unused" },
  { code: 32, label: "Add Debuff", aliases: ["add_debuff"], dataId: "param", value1: "turns", value2: "unused" },
  { code: 33, label: "Remove Buff", aliases: ["remove_buff"], dataId: "param", value1: "unused", value2: "unused" },
  { code: 34, label: "Remove Debuff", aliases: ["remove_debuff"], dataId: "param", value1: "unused", value2: "unused" },
  { code: 41, label: "Special Effect", aliases: ["special", "escape"], dataId: "none", value1: "unused", value2: "unused" },
  { code: 42, label: "Grow", aliases: ["grow"], dataId: "param", value1: "amount", value2: "unused" },
  { code: 43, label: "Learn Skill", aliases: ["learn_skill"], dataId: "skill", value1: "unused", value2: "unused" },
  { code: 44, label: "Common Event", aliases: ["common_event"], dataId: "commonEvent", value1: "unused", value2: "unused" },
];

export const EffectCode = new MzEnum(
  "effect code",
  EFFECTS.map((x) => ({ value: x.code, label: x.label, aliases: x.aliases })),
);

export function traitDef(code: number): TraitDef | undefined {
  return TRAITS.find((t) => t.code === code);
}

export function effectDef(code: number): EffectDef | undefined {
  return EFFECTS.find((x) => x.code === code);
}

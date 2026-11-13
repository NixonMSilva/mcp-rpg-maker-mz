/**
 * Reference model shared by eventing, database and validation
 * (DATABASE_SPEC §9). A reference points from a source location to a target
 * entity (database record, switch, variable, map, ...).
 */
export type RefKind =
  | "switch"
  | "variable"
  | "self_switch"
  | "item"
  | "weapon"
  | "armor"
  | "actor"
  | "class"
  | "skill"
  | "state"
  | "enemy"
  | "troop"
  | "animation"
  | "tileset"
  | "common_event"
  | "map"
  | "event"
  | "element"
  | "skill_type"
  | "weapon_type"
  | "armor_type"
  | "equip_type"
  | "plugin"
  | "label";

export type RefRole = "read" | "write" | "call" | "use";

export type RefOrigin = "native" | "plugin" | "inferred" | "unknown";

export interface Ref {
  kind: RefKind;
  id: number | string;
  role?: RefRole;
  /** For "event"/"self_switch" refs: the map the event lives on (undefined = current map). */
  mapId?: number;
  /** Extra context (e.g. transfer coordinates). */
  context?: Record<string, unknown>;
  origin?: RefOrigin;
  /** Human description of how the reference was found. */
  via?: string;
}

/** Map a reference kind to its database file (for kinds backed by a database file). */
export const REF_DATABASE_FILE: Partial<Record<RefKind, string>> = {
  item: "Items.json",
  weapon: "Weapons.json",
  armor: "Armors.json",
  actor: "Actors.json",
  class: "Classes.json",
  skill: "Skills.json",
  state: "States.json",
  enemy: "Enemies.json",
  troop: "Troops.json",
  animation: "Animations.json",
  tileset: "Tilesets.json",
  common_event: "CommonEvents.json",
};

/** Resolves display names for references, used by describers. */
export interface NameResolver {
  name(kind: RefKind, id: number | string): string | undefined;
}

export const NO_NAMES: NameResolver = { name: () => undefined };

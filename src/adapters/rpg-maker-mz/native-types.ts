/**
 * Native RPG Maker MZ JSON structures, typed from real editor output
 * (MZ 1.10.0 newdata, sample projects and user projects). Index signatures
 * keep plugin-added or future fields: the native JSON is the source of truth.
 */

export interface NativeCommand {
  code: number;
  indent: number;
  parameters: unknown[];
  [extra: string]: unknown;
}

export interface NativeAudio {
  name: string;
  volume: number;
  pitch: number;
  pan: number;
  [extra: string]: unknown;
}

export interface NativeMoveCommand {
  code: number;
  parameters?: unknown[];
  indent?: number | null;
  [extra: string]: unknown;
}

export interface NativeMoveRoute {
  list: NativeMoveCommand[];
  repeat: boolean;
  skippable: boolean;
  wait: boolean;
  [extra: string]: unknown;
}

export interface NativePageConditions {
  actorId: number;
  actorValid: boolean;
  itemId: number;
  itemValid: boolean;
  selfSwitchCh: string;
  selfSwitchValid: boolean;
  switch1Id: number;
  switch1Valid: boolean;
  switch2Id: number;
  switch2Valid: boolean;
  variableId: number;
  variableValid: boolean;
  variableValue: number;
  [extra: string]: unknown;
}

export interface NativePageImage {
  tileId: number;
  characterName: string;
  direction: number;
  pattern: number;
  characterIndex: number;
  [extra: string]: unknown;
}

export interface NativeEventPage {
  conditions: NativePageConditions;
  directionFix: boolean;
  image: NativePageImage;
  list: NativeCommand[];
  moveFrequency: number;
  moveRoute: NativeMoveRoute;
  moveSpeed: number;
  moveType: number;
  priorityType: number;
  stepAnime: boolean;
  through: boolean;
  trigger: number;
  walkAnime: boolean;
  [extra: string]: unknown;
}

export interface NativeMapEvent {
  id: number;
  name: string;
  note: string;
  pages: NativeEventPage[];
  x: number;
  y: number;
  [extra: string]: unknown;
}

export interface NativeMap {
  displayName: string;
  width: number;
  height: number;
  tilesetId: number;
  note: string;
  data: number[];
  events: (NativeMapEvent | null)[];
  [extra: string]: unknown;
}

export interface NativeMapInfo {
  id: number;
  expanded: boolean;
  name: string;
  order: number;
  parentId: number;
  scrollX: number;
  scrollY: number;
  [extra: string]: unknown;
}

export interface NativeCommonEvent {
  id: number;
  list: NativeCommand[];
  name: string;
  switchId: number;
  trigger: number;
  [extra: string]: unknown;
}

export interface NativeTroopPageConditions {
  actorHp: number;
  actorId: number;
  actorValid: boolean;
  enemyHp: number;
  enemyIndex: number;
  enemyValid: boolean;
  switchId: number;
  switchValid: boolean;
  turnA: number;
  turnB: number;
  turnEnding: boolean;
  turnValid: boolean;
  [extra: string]: unknown;
}

export interface NativeTroopPage {
  conditions: NativeTroopPageConditions;
  list: NativeCommand[];
  span: number;
  [extra: string]: unknown;
}

export interface NativeTroop {
  id: number;
  members: { enemyId: number; x: number; y: number; hidden: boolean; [extra: string]: unknown }[];
  name: string;
  pages: NativeTroopPage[];
  [extra: string]: unknown;
}

export type NativeRecord = { id: number; name?: string; note?: string; [extra: string]: unknown };

export function isRecordObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Editor defaults for a new event page, as written by MZ 1.10.0. */
export function defaultEventPage(): NativeEventPage {
  return {
    conditions: {
      actorId: 1,
      actorValid: false,
      itemId: 1,
      itemValid: false,
      selfSwitchCh: "A",
      selfSwitchValid: false,
      switch1Id: 1,
      switch1Valid: false,
      switch2Id: 1,
      switch2Valid: false,
      variableId: 1,
      variableValid: false,
      variableValue: 0,
    },
    directionFix: false,
    image: { tileId: 0, characterName: "", direction: 2, pattern: 0, characterIndex: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 0,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true,
  };
}

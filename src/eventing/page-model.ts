import {
  Direction,
  MoveFrequency,
  MoveSpeed,
  MoveType,
  PriorityType,
  SelfSwitchCh,
  Trigger,
} from "../adapters/rpg-maker-mz/enum-catalog.js";
import type { NativeEventPage } from "../adapters/rpg-maker-mz/native-types.js";
import { invalidInput } from "../project/errors.js";
import { named } from "./ir/blocks.js";
import { decodeMoveRoute, describeRouteCommand, encodeMoveRoute, normalizeMoveRoute } from "./ir/blocks.js";
import { asObj, bool, int, rejectUnknownKeys, str, type NormalizeContext, type Obj } from "./ir/input.js";
import type { NameResolver } from "../references/ref-types.js";

/**
 * Event page settings: native ↔ readable view, and patch application
 * (EVENT_SPEC §7). Patches only touch the fields they name; native fields
 * not modeled here are preserved. Disabling a condition only clears its
 * "Valid" flag (the stored ID is kept, as the editor does).
 */

export function pageSettingsView(page: NativeEventPage, pageIndex: number, n: NameResolver): Obj {
  const c = page.conditions;
  const route = decodeMoveRoute(page.moveRoute);
  return {
    pageIndex,
    pageNumber: pageIndex + 1,
    conditions: {
      switch1: c.switch1Valid ? { switchId: c.switch1Id, name: n.name("switch", c.switch1Id) ?? "" } : null,
      switch2: c.switch2Valid ? { switchId: c.switch2Id, name: n.name("switch", c.switch2Id) ?? "" } : null,
      variable: c.variableValid ? { variableId: c.variableId, atLeast: c.variableValue, name: n.name("variable", c.variableId) ?? "" } : null,
      selfSwitch: c.selfSwitchValid ? c.selfSwitchCh : null,
      item: c.itemValid ? { itemId: c.itemId, name: n.name("item", c.itemId) ?? "" } : null,
      actor: c.actorValid ? { actorId: c.actorId, name: n.name("actor", c.actorId) ?? "" } : null,
    },
    image: {
      characterName: page.image.characterName,
      characterIndex: page.image.characterIndex,
      direction: Direction.key(page.image.direction),
      pattern: page.image.pattern,
      tileId: page.image.tileId,
    },
    movement: {
      type: MoveType.key(page.moveType),
      speed: MoveSpeed.symbolic(page.moveSpeed),
      frequency: MoveFrequency.symbolic(page.moveFrequency),
      route: route ?? { native: page.moveRoute, note: "route kept in native form (non-standard shape)" },
    },
    walkAnime: page.walkAnime,
    stepAnime: page.stepAnime,
    directionFix: page.directionFix,
    through: page.through,
    priority: PriorityType.key(page.priorityType),
    trigger: Trigger.key(page.trigger),
  };
}

export function describePageSettings(page: NativeEventPage, pageIndex: number, n: NameResolver): string[] {
  const c = page.conditions;
  const conds: string[] = [];
  if (c.switch1Valid) conds.push(`${named("switch", c.switch1Id, n)} is ON`);
  if (c.switch2Valid) conds.push(`${named("switch", c.switch2Id, n)} is ON`);
  if (c.variableValid) conds.push(`${named("variable", c.variableId, n)} >= ${c.variableValue}`);
  if (c.selfSwitchValid) conds.push(`Self Switch ${c.selfSwitchCh} is ON`);
  if (c.itemValid) conds.push(`Party has ${named("item", c.itemId, n)}`);
  if (c.actorValid) conds.push(`${named("actor", c.actorId, n)} is in the party`);
  const img = page.image;
  const graphic =
    img.tileId > 0
      ? `Tile ${img.tileId}`
      : img.characterName
        ? `${img.characterName} #${img.characterIndex}, facing ${Direction.key(img.direction)}, pattern ${img.pattern}`
        : "(none)";
  const flags = [page.walkAnime && "walking anim", page.stepAnime && "stepping anim", page.directionFix && "direction fix", page.through && "through"].filter(Boolean);
  const lines = [
    `Page ${pageIndex + 1} (pageIndex ${pageIndex})`,
    `  Conditions: ${conds.length ? conds.join("; ") : "(none)"}`,
    `  Graphic: ${graphic}`,
    `  Trigger: ${Trigger.label(page.trigger)}; Priority: ${PriorityType.label(page.priorityType)}`,
    `  Movement: ${MoveType.label(page.moveType)} (speed ${MoveSpeed.label(page.moveSpeed)}, frequency ${MoveFrequency.label(page.moveFrequency)})`,
    `  Options: ${flags.length ? flags.join(", ") : "(none)"}`,
  ];
  if (page.moveType === 3) {
    const r = decodeMoveRoute(page.moveRoute);
    lines.push(`  Custom route: ${r ? r.commands.map(describeRouteCommand).join(", ") || "(empty)" : "(non-standard native route)"}${r?.repeat ? " [repeat]" : ""}`);
  }
  return lines;
}

const SETTINGS_KEYS = ["conditions", "image", "movement", "walkAnime", "stepAnime", "directionFix", "through", "priority", "trigger"];

/** Apply a settings patch to a native page in place. */
export function applyPageSettingsPatch(page: NativeEventPage, patch: unknown, path: string, ctx: NormalizeContext): string[] {
  const p = asObj(patch, path);
  rejectUnknownKeys(p, SETTINGS_KEYS, path);
  const changes: string[] = [];

  if (p.conditions !== undefined) {
    const cp = `${path}.conditions`;
    const c = asObj(p.conditions, cp);
    rejectUnknownKeys(c, ["switch1", "switch2", "variable", "selfSwitch", "item", "actor"], cp);
    const nc = page.conditions;
    const idCond = (key: "switch1" | "switch2" | "item" | "actor", idField: "switch1Id" | "switch2Id" | "itemId" | "actorId", validField: "switch1Valid" | "switch2Valid" | "itemValid" | "actorValid", inner: string) => {
      const v = c[key];
      if (v === undefined) return;
      if (v === null || v === false) {
        nc[validField] = false;
        changes.push(`condition ${key} disabled`);
        return;
      }
      const id = typeof v === "number" ? v : int(asObj(v, `${cp}.${key}`), inner, `${cp}.${key}`, { min: 1 });
      if (!Number.isInteger(id) || id < 1) throw invalidInput(`${cp}.${key}: positive integer ID required.`);
      nc[idField] = id;
      nc[validField] = true;
      changes.push(`condition ${key} = ${id}`);
    };
    idCond("switch1", "switch1Id", "switch1Valid", "switchId");
    idCond("switch2", "switch2Id", "switch2Valid", "switchId");
    idCond("item", "itemId", "itemValid", "itemId");
    idCond("actor", "actorId", "actorValid", "actorId");
    if (c.variable !== undefined) {
      if (c.variable === null || c.variable === false) {
        nc.variableValid = false;
        changes.push("condition variable disabled");
      } else {
        const vo = asObj(c.variable, `${cp}.variable`);
        nc.variableId = int(vo, "variableId", `${cp}.variable`, { min: 1 });
        nc.variableValue = int(vo, "atLeast", `${cp}.variable`, { def: 0 });
        nc.variableValid = true;
        changes.push(`condition variable ${nc.variableId} >= ${nc.variableValue}`);
      }
    }
    if (c.selfSwitch !== undefined) {
      if (c.selfSwitch === null || c.selfSwitch === false) {
        nc.selfSwitchValid = false;
        changes.push("condition selfSwitch disabled");
      } else {
        nc.selfSwitchCh = SelfSwitchCh.parse(c.selfSwitch, `${cp}.selfSwitch`);
        nc.selfSwitchValid = true;
        changes.push(`condition self switch ${nc.selfSwitchCh}`);
      }
    }
  }

  if (p.image !== undefined) {
    const ip = `${path}.image`;
    const im = asObj(p.image, ip);
    rejectUnknownKeys(im, ["characterName", "characterIndex", "direction", "pattern", "tileId"], ip);
    if (im.characterName !== undefined) page.image.characterName = str(im, "characterName", ip);
    if (im.characterIndex !== undefined) page.image.characterIndex = int(im, "characterIndex", ip, { min: 0, max: 7 });
    if (im.direction !== undefined) page.image.direction = Direction.parse(im.direction, `${ip}.direction`);
    if (im.pattern !== undefined) page.image.pattern = int(im, "pattern", ip, { min: 0, max: 2 });
    if (im.tileId !== undefined) page.image.tileId = int(im, "tileId", ip, { min: 0 });
    if (im.characterName !== undefined && im.characterName !== "" && im.tileId === undefined) page.image.tileId = 0;
    changes.push(`image ${JSON.stringify(im)}`);
  }

  if (p.movement !== undefined) {
    const mp = `${path}.movement`;
    const m = asObj(p.movement, mp);
    rejectUnknownKeys(m, ["type", "speed", "frequency", "route"], mp);
    if (m.type !== undefined) page.moveType = MoveType.parse(m.type, `${mp}.type`);
    if (m.speed !== undefined) page.moveSpeed = MoveSpeed.parse(m.speed, `${mp}.speed`);
    if (m.frequency !== undefined) page.moveFrequency = MoveFrequency.parse(m.frequency, `${mp}.frequency`);
    if (m.route !== undefined) {
      const ir = normalizeMoveRoute(m.route, `${mp}.route`, ctx, { repeat: true, skippable: false, wait: false });
      page.moveRoute = encodeMoveRoute(ir) as unknown as NativeEventPage["moveRoute"];
    }
    changes.push(`movement ${JSON.stringify(m).slice(0, 200)}`);
  }

  for (const k of ["walkAnime", "stepAnime", "directionFix", "through"] as const) {
    if (p[k] !== undefined) {
      page[k] = bool(p, k, path);
      changes.push(`${k} = ${page[k]}`);
    }
  }
  if (p.priority !== undefined) {
    page.priorityType = PriorityType.parse(p.priority, `${path}.priority`);
    changes.push(`priority = ${PriorityType.label(page.priorityType)}`);
  }
  if (p.trigger !== undefined) {
    page.trigger = Trigger.parse(p.trigger, `${path}.trigger`);
    changes.push(`trigger = ${Trigger.label(page.trigger)}`);
  }
  return changes;
}

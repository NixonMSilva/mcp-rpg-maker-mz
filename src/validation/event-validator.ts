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
import { describeBlock, walkBlocks, blockRefs } from "../eventing/ir/describe.js";
import { parseCommandList, type ParseResult } from "../eventing/ir/parser.js";
import type { EventBlock } from "../eventing/ir/types.js";
import { pageConditionRefs, textCodeRefs } from "../references/reference-resolver.js";
import { NO_NAMES, type Ref } from "../references/ref-types.js";
import { DiagnosticBag, type Diagnostic } from "./diagnostics.js";
import type { ReferenceChecker } from "./reference-validator.js";

/**
 * Structural and reference validation of event command lists and event page
 * settings (EVENT_SPEC §10.1, §10.2).
 */

export interface ListContext {
  /** Location label used in diagnostics. */
  location: string;
  /** Map providing event context (undefined for common events / troops). */
  mapId?: number;
  /** "map" pages can use self switches; common events only when called from a map event. */
  owner: "map_event_page" | "common_event" | "troop_page";
}

const MAX_TEXT_LINES = 4;
const MAX_CHOICES = 6;

export function validateCommandList(list: unknown, ctx: ListContext, checker: ReferenceChecker, parsed?: ParseResult): Diagnostic[] {
  const bag = new DiagnosticBag();
  const p = parsed ?? parseCommandList(list, ctx.location);
  bag.merge(p.diagnostics);
  const labels = new Set<string>();
  for (const v of walkBlocks(p.logic.blocks)) if (v.block.type === "label") labels.add(String(v.block.name));

  const loc = (id: string) => `${ctx.location} / block ${id}`;
  const loopDepth = new Map<string, number>();

  for (const v of walkBlocks(p.logic.blocks)) {
    const b = v.block;
    const depthInLoop = (loopDepth.get(v.parentId) ?? 0) + 0;
    // Track whether a block is inside a loop (any ancestor is a loop).
    const inLoop = depthInLoop > 0;
    if (b.type === "loop") loopDepth.set(v.id, depthInLoop + 1);
    else if (isContainer(b)) loopDepth.set(v.id, depthInLoop);

    switch (b.type) {
      case "show_text": {
        const lines = b.lines as string[];
        if (lines.length > MAX_TEXT_LINES) bag.warning("event.text.too_many_lines", `Show Text has ${lines.length} lines; the message window shows ${MAX_TEXT_LINES} at a time (the editor allows ${MAX_TEXT_LINES} per command). Split it into several Show Text blocks.`, loc(v.id));
        if (lines.length === 0) bag.warning("event.text.empty", "Show Text has no text lines.", loc(v.id));
        break;
      }
      case "show_choices": {
        const n = (b.choices as unknown[]).length;
        if (n > MAX_CHOICES) bag.warning("event.choices.too_many", `Show Choices has ${n} choices; the MZ editor supports up to ${MAX_CHOICES}.`, loc(v.id));
        break;
      }
      case "jump_to_label":
        if (!labels.has(String(b.name))) bag.warning("event.label.missing", `Jump to Label "${String(b.name)}" has no matching Label in this list; the jump does nothing.`, loc(v.id));
        break;
      case "break_loop":
        if (!inLoop) bag.warning("event.loop.break_outside", "Break Loop outside of a Loop skips to the next Repeat Above found later in the list (or ends processing).", loc(v.id));
        break;
      case "control_self_switch":
        if (ctx.owner === "troop_page") bag.warning("event.self_switch.in_battle", "Control Self Switch has no effect in troop battle events (there is no map event).", loc(v.id));
        else if (ctx.owner === "common_event") bag.info("event.self_switch.common_event", "Control Self Switch in a common event affects the calling map event only (nothing if run as autorun/parallel).", loc(v.id));
        break;
      case "plugin_command": {
        const header = checker.pluginHeader(String(b.pluginName));
        if (header && header.commands.length) {
          const cmd = header.commands.find((c) => c.name === b.commandName);
          if (!cmd) {
            bag.warning(
              "plugin.command.unknown",
              `Plugin "${String(b.pluginName)}" does not declare a command "${String(b.commandName)}" in its header (declared: ${header.commands.map((c) => c.name).join(", ")}). Inferred from annotations.`,
              loc(v.id),
            );
          } else {
            const known = new Set(cmd.args.map((a) => a.name));
            const extra = Object.keys((b.args as Record<string, unknown>) ?? {}).filter((k) => !known.has(k));
            if (extra.length && known.size) bag.info("plugin.args.unknown", `Arguments not declared by ${String(b.pluginName)}/${String(b.commandName)}: ${extra.join(", ")} (inferred from annotations).`, loc(v.id));
          }
        }
        break;
      }
      case "script":
        bag.info("event.script.opaque", "Script block is opaque JavaScript; it is preserved but not validated.", loc(v.id));
        break;
      case "raw_command":
        bag.info("event.raw.opaque", `Opaque native command(s): ${describeBlock(b, NO_NAMES).slice(0, 160)}`, loc(v.id));
        break;
    }

    const refs: Ref[] = [...blockRefs(b)];
    if (b.type === "show_text" || b.type === "show_scrolling_text") for (const l of b.lines as string[]) refs.push(...textCodeRefs(l));
    for (const r of refs) reportRef(bag, checker, r, ctx, loc(v.id));
  }
  return bag.items;
}

function isContainer(b: EventBlock): boolean {
  return b.type === "conditional" || b.type === "show_choices" || b.type === "battle_processing";
}

export function reportRef(bag: DiagnosticBag, checker: ReferenceChecker, r: Ref, ctx: { mapId?: number }, location: string): void {
  if (r.origin === "unknown") return;
  if (r.kind === "self_switch" || r.kind === "label") {
    const c = checker.check(r, ctx);
    if (c.status === "invalid") bag.error(`ref.${r.kind}.invalid`, c.message ?? "Invalid reference.", location);
    return;
  }
  const c = checker.check(r, ctx);
  const what = `${r.kind} ${String(r.id)}${r.via ? ` (${r.via})` : ""}`;
  switch (c.status) {
    case "invalid":
      if (r.origin === "inferred") bag.warning(`ref.${r.kind}.invalid_inferred`, `Possible reference to missing ${what}: ${c.message}`, location);
      else if (r.kind === "plugin") bag.warning("ref.plugin.missing", c.message ?? `Missing plugin ${String(r.id)}.`, location);
      else bag.error(`ref.${r.kind}.invalid`, c.message ?? `Invalid reference to ${what}.`, location);
      break;
    case "blank":
      bag.warning(`ref.${r.kind}.blank`, c.message ?? `Reference to blank ${what}.`, location);
      break;
    case "unresolvable":
      if (r.kind !== "event") bag.info(`ref.${r.kind}.unresolvable`, c.message ?? `Cannot resolve ${what}.`, location);
      break;
    default:
      break;
  }
}

/** Validate native page settings (enums and condition references). */
export function validatePageSettings(page: NativeEventPage, location: string, checker: ReferenceChecker, mapId: number): Diagnostic[] {
  const bag = new DiagnosticBag();
  const req = <T>(v: T, ok: boolean, code: string, msg: string) => {
    if (!ok) bag.error(code, msg, location);
    return v;
  };
  if (!page || typeof page !== "object") {
    bag.error("page.malformed", "Event page is not an object.", location);
    return bag.items;
  }
  req(page.trigger, Trigger.has(page.trigger), "page.trigger.invalid", `Invalid trigger ${JSON.stringify(page.trigger)} (${Trigger.options()}).`);
  req(page.priorityType, PriorityType.has(page.priorityType), "page.priority.invalid", `Invalid priorityType ${JSON.stringify(page.priorityType)} (${PriorityType.options()}).`);
  req(page.moveType, MoveType.has(page.moveType), "page.moveType.invalid", `Invalid moveType ${JSON.stringify(page.moveType)} (${MoveType.options()}).`);
  req(page.moveSpeed, MoveSpeed.has(page.moveSpeed), "page.moveSpeed.invalid", `Invalid moveSpeed ${JSON.stringify(page.moveSpeed)} (${MoveSpeed.options()}).`);
  req(page.moveFrequency, MoveFrequency.has(page.moveFrequency), "page.moveFrequency.invalid", `Invalid moveFrequency ${JSON.stringify(page.moveFrequency)} (${MoveFrequency.options()}).`);
  for (const k of ["walkAnime", "stepAnime", "directionFix", "through"] as const) {
    req(page[k], typeof page[k] === "boolean", `page.${k}.invalid`, `${k} must be a boolean.`);
  }
  const img = page.image;
  if (!img || typeof img !== "object") bag.error("page.image.malformed", "Page image is missing.", location);
  else {
    req(img.direction, Direction.has(img.direction), "page.image.direction.invalid", `Invalid image direction ${JSON.stringify(img.direction)} (2,4,6,8).`);
    req(img.pattern, Number.isInteger(img.pattern) && img.pattern >= 0 && img.pattern <= 2, "page.image.pattern.invalid", "image.pattern must be 0, 1 or 2.");
    req(img.characterIndex, Number.isInteger(img.characterIndex) && img.characterIndex >= 0 && img.characterIndex <= 7, "page.image.characterIndex.invalid", "image.characterIndex must be 0..7.");
    if (img.tileId !== 0 && img.characterName !== "") bag.warning("page.image.both", "Page image has both a tileId and a characterName; the tile is used.", location);
  }
  const c = page.conditions;
  if (!c || typeof c !== "object") bag.error("page.conditions.malformed", "Page conditions are missing.", location);
  else {
    if (c.selfSwitchValid && !SelfSwitchCh.has(c.selfSwitchCh)) bag.error("page.conditions.selfSwitch.invalid", `Invalid self switch ${JSON.stringify(c.selfSwitchCh)}.`, location);
    for (const r of pageConditionRefs(page)) reportRef(bag, checker, r, { mapId }, `${location} / conditions`);
  }
  if (page.moveType === 3 && (!page.moveRoute || !Array.isArray(page.moveRoute.list))) bag.error("page.moveRoute.missing", "Custom movement requires a moveRoute.", location);
  return bag.items;
}

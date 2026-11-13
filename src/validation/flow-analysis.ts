import type { NativeCommonEvent, NativeEventPage, NativeMapEvent } from "../adapters/rpg-maker-mz/native-types.js";
import type { Condition } from "../eventing/ir/conditions.js";
import { containerBranches, isContainerType } from "../eventing/ir/containers.js";
import { walkBlocks } from "../eventing/ir/describe.js";
import { parseCommandList } from "../eventing/ir/parser.js";
import type { EventBlock } from "../eventing/ir/types.js";
import { DiagnosticBag, type Diagnostic } from "./diagnostics.js";

/**
 * Best-effort logic analysis (EVENT_SPEC §10.3). Every finding is a
 * heuristic (marked `heuristic: true`), never a proof, and nothing is
 * rewritten automatically.
 */

const TERMINAL = new Set(["exit_event_processing", "jump_to_label", "break_loop"]);

/** Analyze one command list's blocks. */
export function analyzeBlocks(blocks: readonly EventBlock[], location: string, opts: { trigger?: number } = {}): Diagnostic[] {
  const bag = new DiagnosticBag();
  const loc = (id: string) => `${location} / block ${id}`;

  // 1. Unreachable blocks after a terminal command in the same branch.
  const scanBranch = (bs: readonly EventBlock[], parentId: string, branch: string, known: Map<string, boolean>) => {
    let terminatedBy: string | null = null;
    bs.forEach((b, i) => {
      const id = b.id ?? (parentId === "" ? String(i) : `${parentId}/${branch}/${i}`);
      if (terminatedBy && b.type !== "label") {
        bag.heuristic("warning", "flow.unreachable", `Block appears unreachable: it follows ${terminatedBy} in the same branch.`, loc(id));
        terminatedBy = null; // report only the first unreachable block per run
      }
      if (TERMINAL.has(b.type)) terminatedBy = `${b.type} (${id})`;
      if (b.type === "label") terminatedBy = null;

      if (b.type === "conditional") {
        const c = b.condition as Condition;
        const key = conditionKey(c);
        if (key) {
          const prior = known.get(key.key);
          if (prior !== undefined) {
            const always = prior === key.truth;
            bag.heuristic(
              "warning",
              always ? "flow.condition.redundant" : "flow.condition.contradicted",
              always
                ? `Condition repeats an enclosing condition (${key.key} already ${key.truth ? "true" : "false"} here); the else branch is unreachable.`
                : `Condition is contradicted by an enclosing condition (${key.key} is ${prior ? "true" : "false"} here); the then branch is unreachable.`,
              loc(id),
            );
          }
        }
        for (const br of containerBranches(b)) {
          const next = new Map(known);
          if (key) next.set(key.key, br.name === "then" ? key.truth : !key.truth);
          scanBranch(br.blocks, id, br.name, next);
        }
        return;
      }
      if (isContainerType(b.type)) for (const br of containerBranches(b)) scanBranch(br.blocks, id, br.name, known);
    });
  };
  scanBranch(blocks, "", "", new Map());

  // 2. Loops without an apparent exit.
  for (const v of walkBlocks(blocks)) {
    if (v.block.type !== "loop") continue;
    const inner = [...walkBlocks(v.block.body as EventBlock[], v.id, "body")];
    const exits = inner.some((x) => ["break_loop", "exit_event_processing", "jump_to_label", "transfer_player", "game_over", "return_to_title", "erase_event"].includes(x.block.type));
    const opaque = inner.some((x) => x.block.type === "script" || x.block.type === "raw_command" || x.block.type === "plugin_command");
    if (!exits) {
      bag.heuristic(opaque ? "info" : "warning", "flow.loop.no_exit", `Loop has no Break Loop / Exit / Jump inside${opaque ? " (it contains opaque script/plugin commands that might exit)" : ""}; it may run forever.`, loc(v.id));
    }
    const waits = inner.some((x) => ["wait", "show_text", "show_choices", "input_number", "select_item", "set_movement_route", "play_animation", "show_balloon"].includes(x.block.type));
    if (!waits && !exits) bag.heuristic("warning", "flow.loop.busy", "Loop contains no wait or message; it will spin every frame.", loc(v.id));
  }

  // 3. Autorun pages that never change their own activation state.
  if (opts.trigger === 3) {
    const all = [...walkBlocks(blocks)].map((v) => v.block.type);
    const changesState = all.some((t) =>
      ["control_self_switch", "control_switches", "control_variables", "erase_event", "transfer_player", "change_items", "change_party_member", "script", "plugin_command", "raw_command", "call_common_event", "game_over", "return_to_title"].includes(t),
    );
    if (!changesState) {
      bag.heuristic("warning", "flow.autorun.never_ends", "Autorun page never changes a switch/self switch/variable or erases itself; it will repeat forever and block the player.", location);
    }
  }
  return bag.items;
}

function conditionKey(c: Condition): { key: string; truth: boolean } | null {
  if (c.type === "switch") return { key: `Switch ${c.switchId}`, truth: c.value === "on" };
  if (c.type === "self_switch") return { key: `Self Switch ${c.selfSwitch}`, truth: c.value === "on" };
  return null;
}

/** Conditions of a page reduced to a comparable set. */
function pageConditionSet(p: NativeEventPage): Map<string, unknown> {
  const c = p.conditions;
  const s = new Map<string, unknown>();
  if (!c) return s;
  if (c.switch1Valid) s.set(`switch:${c.switch1Id}`, true);
  if (c.switch2Valid) s.set(`switch:${c.switch2Id}`, true);
  if (c.variableValid) s.set(`variable:${c.variableId}`, c.variableValue);
  if (c.selfSwitchValid) s.set(`self:${c.selfSwitchCh}`, true);
  if (c.itemValid) s.set(`item:${c.itemId}`, true);
  if (c.actorValid) s.set(`actor:${c.actorId}`, true);
  return s;
}

/** True when every condition of `later` is implied by `earlier`'s conditions (so `later` is active whenever `earlier` is). */
function impliedBy(later: Map<string, unknown>, earlier: Map<string, unknown>): boolean {
  for (const [k, v] of later) {
    if (!earlier.has(k)) return false;
    if (k.startsWith("variable:") && (earlier.get(k) as number) < (v as number)) return false;
  }
  return true;
}

/** Event-level analysis: shadowed pages and self switches set but never read. */
export function analyzeEvent(ev: NativeMapEvent, location: string): Diagnostic[] {
  const bag = new DiagnosticBag();
  const sets = ev.pages.map(pageConditionSet);
  // The engine activates the highest-numbered page whose conditions are met.
  ev.pages.forEach((_p, i) => {
    for (let j = i + 1; j < ev.pages.length; j++) {
      if (impliedBy(sets[j]!, sets[i]!)) {
        bag.heuristic(
          "warning",
          "flow.page.shadowed",
          `Page ${i + 1} can never be active: page ${j + 1} has ${sets[j]!.size === 0 ? "no conditions" : "conditions that are always met when page " + (i + 1) + "'s are"}, and later pages take priority.`,
          `${location} / Page ${i + 1}`,
        );
        break;
      }
    }
  });

  const selfSet = new Set<string>();
  const selfRead = new Set<string>();
  ev.pages.forEach((p) => {
    if (p.conditions?.selfSwitchValid) selfRead.add(p.conditions.selfSwitchCh);
    const parsed = parseCommandList(p.list, location);
    for (const v of walkBlocks(parsed.logic.blocks)) {
      const b = v.block;
      if (b.type === "control_self_switch" && b.value === "on") selfSet.add(String(b.selfSwitch));
      if (b.type === "conditional" && (b.condition as Condition).type === "self_switch") selfRead.add(String((b.condition as Condition).selfSwitch));
    }
  });
  for (const s of selfSet) {
    if (!selfRead.has(s)) {
      bag.heuristic("info", "flow.self_switch.unused", `Self switch ${s} is turned ON but no page condition or branch of this event reads it.`, location);
    }
  }
  return bag.items;
}

/** Map-level switch usage: switches written but never read anywhere in the analyzed scope. */
export function analyzeSwitchUsage(
  writes: Map<number, string[]>,
  reads: Set<number>,
  scopeLabel: string,
): Diagnostic[] {
  const bag = new DiagnosticBag();
  for (const [id, where] of writes) {
    if (!reads.has(id)) {
      bag.heuristic("info", "flow.switch.unread", `Switch ${id} is set but never read within ${scopeLabel} (it may be read elsewhere, by plugins or scripts).`, where[0]);
    }
  }
  return bag.items;
}

/** Detect common event call cycles (A → B → … → A). */
export function analyzeCommonEventCycles(ces: (NativeCommonEvent | null)[]): Diagnostic[] {
  const bag = new DiagnosticBag();
  const graph = new Map<number, number[]>();
  for (const ce of ces) {
    if (!ce) continue;
    const calls: number[] = [];
    for (const v of walkBlocks(parseCommandList(ce.list, `Common Event ${ce.id}`).logic.blocks)) {
      if (v.block.type === "call_common_event") calls.push(v.block.commonEventId as number);
    }
    graph.set(ce.id, calls);
  }
  const reported = new Set<string>();
  const visit = (start: number, node: number, path: number[]) => {
    for (const next of graph.get(node) ?? []) {
      if (next === start) {
        const cycle = [...path, next];
        const key = [...cycle].sort((a, b) => a - b).join(",");
        if (!reported.has(key)) {
          reported.add(key);
          bag.heuristic("warning", "flow.common_event.cycle", `Common event call cycle: ${cycle.join(" → ")} (the engine aborts after 100 nested calls).`, `Common Event ${start}`);
        }
      } else if (!path.includes(next) && path.length < 50) {
        visit(start, next, [...path, next]);
      }
    }
  };
  for (const id of graph.keys()) visit(id, id, [id]);
  return bag.items;
}

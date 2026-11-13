import { z } from "zod";
import { expandTemplate } from "../database/templates.js";
import type { InsertPosition } from "../eventing/block-service.js";
import { buildEventFromTemplate } from "../eventing/templates/event-templates.js";
import { invalidInput } from "../project/errors.js";
import type { Workspace } from "../project/transaction-manager.js";
import type { ListTarget } from "../eventing/targets.js";
import type { ProjectSession } from "./context.js";

/**
 * Registry of write operations. Each operation is defined once (zod schema +
 * workspace handler) and exposed both as an individual MCP tool and as a
 * step of the batch tools (preview_event_changes / database_preview_changes),
 * so every mutation flows through the same transaction + validation path.
 */

export interface OpContext {
  session: ProjectSession;
  ws: Workspace;
  allowScript: boolean;
}

export interface OperationDef {
  domain: "event" | "database";
  /** Always requires preview + explicit confirmation. */
  destructive?: boolean;
  description: string;
  shape: z.ZodRawShape;
  run(ctx: OpContext, args: Record<string, unknown>): unknown;
}

// ---------------------------------------------------------------- shared schema pieces

const id = (d: string) => z.number().int().describe(d);
const mapId = id("Map ID (from list_maps)");
const eventId = id("Map event ID");
const pageIndex = id("ZERO-based page index (Page 1 in the editor = pageIndex 0)");
const revision = z.string().describe("Revision token of the command list from get_event_logic / get_event_page (rejects stale block ids)");
const blocks = z.array(z.record(z.string(), z.unknown())).describe("Event IR blocks (see resource rpgmz://docs/event-ir or get_event_ir_reference)");
const block = z.record(z.string(), z.unknown()).describe("One Event IR block");

/** A command list: map event page, common event, or troop battle page. */
const targetShape = {
  mapId: z.number().int().optional().describe("Map ID (map event page target)"),
  eventId: z.number().int().optional().describe("Map event ID (map event page target)"),
  pageIndex: z.number().int().optional().describe("ZERO-based page index (map event or troop page)"),
  commonEventId: z.number().int().optional().describe("Common event ID (common event target)"),
  troopId: z.number().int().optional().describe("Troop ID (troop battle page target)"),
};

export function targetFrom(args: Record<string, unknown>): ListTarget {
  if (args.commonEventId !== undefined) return { kind: "common_event", commonEventId: args.commonEventId as number };
  if (args.troopId !== undefined) {
    if (args.pageIndex === undefined) throw invalidInput("pageIndex is required for troop pages.");
    return { kind: "troop_page", troopId: args.troopId as number, pageIndex: args.pageIndex as number };
  }
  if (args.mapId !== undefined && args.eventId !== undefined && args.pageIndex !== undefined) {
    return { kind: "map_event_page", mapId: args.mapId as number, eventId: args.eventId as number, pageIndex: args.pageIndex as number };
  }
  throw invalidInput("Identify the command list with {mapId, eventId, pageIndex}, {commonEventId} or {troopId, pageIndex}.");
}

const position = z
  .object({
    before: z.string().optional().describe("Insert before this block id"),
    after: z.string().optional().describe("Insert after this block id"),
    parentId: z.string().optional().describe('Container block id ("" or omitted = page root)'),
    branch: z.string().optional().describe('Branch of the container: "then" | "else" | "body" | "choice:<n>" | "cancel" | "win" | "escape" | "lose"'),
    index: z.number().int().optional().describe("Index within the branch (default: end)"),
  })
  .describe('Where to insert: {before:id} | {after:id} | {parentId, branch, index}. Inserting into the "else" branch of a conditional without one creates it.');

function toPosition(p: unknown): InsertPosition {
  const o = (p ?? {}) as Record<string, unknown>;
  if (typeof o.before === "string") return { before: o.before };
  if (typeof o.after === "string") return { after: o.after };
  const out: { parentId?: string; branch?: string; index?: number } = {};
  if (typeof o.parentId === "string") out.parentId = o.parentId;
  if (typeof o.branch === "string") out.branch = o.branch;
  if (typeof o.index === "number") out.index = o.index;
  return out;
}

const pageDef = z
  .object({
    settings: z.record(z.string(), z.unknown()).optional().describe("Page settings patch (see update_event_page_settings)"),
    blocks: z.array(z.record(z.string(), z.unknown())).optional().describe("Initial logic as Event IR blocks"),
  })
  .describe("Event page definition: {settings?, blocks?}");

const category = z
  .enum(["actor", "class", "skill", "item", "weapon", "armor", "enemy", "troop", "state", "animation", "tileset", "common_event", "system", "map_info"])
  .describe("Database category");

// ---------------------------------------------------------------- registry

export const OPERATIONS: Record<string, OperationDef> = {
  // ---------------- event & page management
  create_map_event: {
    domain: "event",
    description:
      "Create a map event with a new ID (lowest free slot, as the editor does) and one or more pages. Each page: {settings?, blocks?}. Defaults match a blank editor page (action button, below characters, no graphic).",
    shape: {
      mapId,
      name: z.string().optional().describe('Event name (default "EVxxx")'),
      x: z.number().int().describe("Tile X"),
      y: z.number().int().describe("Tile Y"),
      note: z.string().optional(),
      pages: z.array(pageDef).optional().describe("Pages in order (pageIndex 0 first); default one blank page"),
    },
    run: ({ session, ws, allowScript }, a) => {
      const newId = session.events.createMapEvent(ws, a.mapId as number, { name: a.name as string | undefined, x: a.x as number, y: a.y as number, note: a.note as string | undefined, pages: a.pages as unknown[] | undefined }, allowScript);
      return { mapId: a.mapId, eventId: newId };
    },
  },
  update_map_event: {
    domain: "event",
    description: "Update event metadata: name, note, x, y. Pages are edited with the page/logic tools.",
    shape: { mapId, eventId, name: z.string().optional(), note: z.string().optional(), x: z.number().int().optional(), y: z.number().int().optional() },
    run: ({ session, ws }, a) => session.events.updateMapEvent(ws, a.mapId as number, a.eventId as number, { name: a.name as string | undefined, note: a.note as string | undefined, x: a.x as number | undefined, y: a.y as number | undefined }),
  },
  delete_map_event: {
    domain: "event",
    destructive: true,
    description: "DESTRUCTIVE: delete a map event (its slot becomes null; other event IDs never change). Always preview-only; apply with apply_changes + confirm.",
    shape: { mapId, eventId },
    run: ({ session, ws }, a) => session.events.deleteMapEvent(ws, a.mapId as number, a.eventId as number),
  },
  create_event_page: {
    domain: "event",
    description: "Add a page to an event (appended by default). Remember: the engine activates the highest-numbered page whose conditions are met.",
    shape: { mapId, eventId, page: pageDef.optional(), insertAt: z.number().int().optional().describe("ZERO-based index to insert at (default: end)") },
    run: ({ session, ws, allowScript }, a) => ({
      pageIndex: session.events.createEventPage(ws, a.mapId as number, a.eventId as number, a.page, a.insertAt as number | undefined, allowScript),
    }),
  },
  clone_event_page: {
    domain: "event",
    description: "Clone a page (deep copy) into the same event or another event on the same map.",
    shape: { mapId, eventId, pageIndex, destEventId: z.number().int().optional(), insertAt: z.number().int().optional() },
    run: ({ session, ws }, a) => ({
      pageIndex: session.events.cloneEventPage(ws, a.mapId as number, a.eventId as number, a.pageIndex as number, {
        ...(a.destEventId !== undefined ? { eventId: a.destEventId as number } : {}),
        ...(a.insertAt !== undefined ? { insertAt: a.insertAt as number } : {}),
      }),
    }),
  },
  delete_event_page: {
    domain: "event",
    destructive: true,
    description: "DESTRUCTIVE: delete one page (later pages shift down). Preview-only; apply with apply_changes + confirm.",
    shape: { mapId, eventId, pageIndex },
    run: ({ session, ws }, a) => session.events.deleteEventPage(ws, a.mapId as number, a.eventId as number, a.pageIndex as number),
  },
  update_event_page_settings: {
    domain: "event",
    description:
      'Patch page settings. Fields: conditions {switch1|switch2: switchId|null, variable: {variableId, atLeast}|null, selfSwitch: "A".."D"|null, item: itemId|null, actor: actorId|null}; image {characterName, characterIndex 0-7, direction down|left|right|up, pattern 0-2, tileId}; movement {type fixed|random|approach|custom, speed 1-6, frequency 1-5, route {repeat, skippable, wait, commands}}; walkAnime, stepAnime, directionFix, through (booleans); priority below|same|above; trigger action_button|player_touch|event_touch|autorun|parallel. null disables a condition.',
    shape: { mapId, eventId, pageIndex, settings: z.record(z.string(), z.unknown()).describe("Settings patch") },
    run: ({ session, ws, allowScript }, a) => session.events.updatePageSettings(ws, a.mapId as number, a.eventId as number, a.pageIndex as number, a.settings, allowScript),
  },
  reorder_event_pages: {
    domain: "event",
    description: "Reorder pages: `order` lists current pageIndexes in their new order (a permutation). Changes which page wins when several are active.",
    shape: { mapId, eventId, order: z.array(z.number().int()) },
    run: ({ session, ws }, a) => session.events.reorderEventPages(ws, a.mapId as number, a.eventId as number, a.order as number[]),
  },
  update_common_event: {
    domain: "event",
    description: "Update a common event's name, trigger (none|autorun|parallel) or condition switchId. Its command list is edited with the logic tools ({commonEventId}).",
    shape: { commonEventId: id("Common event ID"), name: z.string().optional(), trigger: z.union([z.string(), z.number()]).optional(), switchId: z.number().int().optional() },
    run: ({ session, ws }, a) => session.events.updateCommonEvent(ws, a.commonEventId as number, { name: a.name as string | undefined, trigger: a.trigger, switchId: a.switchId as number | undefined }),
  },
  create_event_from_template: {
    domain: "event",
    description:
      "Create a complete event from a template: npc (dialogue), treasure_chest, door (transfer), quest_npc (multi-stage via a variable), switch_lever, cutscene_trigger. Use list_event_templates for parameters. The result is previewed like any other change.",
    shape: { mapId, template: z.string(), x: z.number().int(), y: z.number().int(), name: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() },
    run: ({ session, ws, allowScript }, a) => {
      const def = buildEventFromTemplate(a.template as string, (a.params ?? {}) as Record<string, unknown>);
      const newId = session.events.createMapEvent(ws, a.mapId as number, { name: (a.name as string | undefined) ?? def.name, x: a.x as number, y: a.y as number, pages: def.pages }, allowScript);
      ws.semanticDiff.push(`  (template ${String(a.template)}: ${def.summary})`);
      return { mapId: a.mapId, eventId: newId, template: a.template, explanation: def.summary };
    },
  },

  // ---------------- logic editing
  append_event_blocks: {
    domain: "event",
    description: "Append Event IR blocks at the end of a command list (map page, common event or troop page). No revision needed.",
    shape: { ...targetShape, blocks },
    run: ({ session, ws, allowScript }, a) => session.events.editLogic(ws, targetFrom(a), { op: "append", blocks: a.blocks }, allowScript),
  },
  insert_event_blocks: {
    domain: "event",
    description: "Insert blocks at a position (before/after a block id, or into a branch of a container). Requires the list revision.",
    shape: { ...targetShape, revision, position, blocks },
    run: ({ session, ws, allowScript }, a) =>
      session.events.editLogic(ws, targetFrom(a), { op: "insert", position: toPosition(a.position), blocks: a.blocks, revision: a.revision as string }, allowScript),
  },
  replace_event_block: {
    domain: "event",
    description: "Replace one block (including all of its nested branches) by id. Requires the list revision.",
    shape: { ...targetShape, revision, blockId: z.string(), block },
    run: ({ session, ws, allowScript }, a) =>
      session.events.editLogic(ws, targetFrom(a), { op: "replace", blockId: a.blockId as string, block: a.block, revision: a.revision as string }, allowScript),
  },
  remove_event_block: {
    domain: "event",
    description: "Remove one block (and its nested branches) by id. Requires the list revision.",
    shape: { ...targetShape, revision, blockId: z.string() },
    run: ({ session, ws }, a) => session.events.editLogic(ws, targetFrom(a), { op: "remove", blockId: a.blockId as string, revision: a.revision as string }),
  },
  move_event_block: {
    domain: "event",
    description: "Move a block (with its branches) to another position in the same list; indentation is adjusted. Requires the list revision.",
    shape: { ...targetShape, revision, blockId: z.string(), position },
    run: ({ session, ws }, a) => session.events.editLogic(ws, targetFrom(a), { op: "move", blockId: a.blockId as string, position: toPosition(a.position), revision: a.revision as string }),
  },
  replace_event_logic: {
    domain: "event",
    description:
      "Replace the complete logic of a list with new IR ({irVersion:1, blocks} or a block array). Prefer minimal edits unless a rewrite was requested. Keep raw_command blocks you received to preserve unsupported commands. Requires the list revision.",
    shape: { ...targetShape, revision, logic: z.union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown())]) },
    run: ({ session, ws, allowScript }, a) => session.events.editLogic(ws, targetFrom(a), { op: "replace_all", logic: a.logic, revision: a.revision as string }, allowScript),
  },

  // ---------------- database
  database_create_record: {
    domain: "database",
    description:
      "Create a database record with the next ID (max+1). Optionally start from a template (database_list_templates) and override `fields` (patch paths, e.g. \"damage.formula\"), `collections` (traits/effects/learnings/actions/dropItems/members) and `noteTags`. Returns the new ID.",
    shape: {
      category,
      name: z.string(),
      template: z.string().optional(),
      templateParams: z.record(z.string(), z.unknown()).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      collections: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
      noteTags: z.record(z.string(), z.union([z.string(), z.literal(true)])).optional(),
      id: z.number().int().optional().describe("Only to reuse a null slot or (with overwriteBlank) an unreferenced blank slot"),
      overwriteBlank: z.boolean().optional(),
    },
    run: ({ session, ws }, a) => {
      let fields = (a.fields ?? {}) as Record<string, unknown>;
      let collections = (a.collections ?? {}) as Record<string, unknown[]>;
      if (a.template) {
        const t = expandTemplate(a.template as string, (a.templateParams ?? {}) as Record<string, unknown>);
        if (t.category !== a.category) throw invalidInput(`Template ${String(a.template)} creates ${t.category} records, not ${String(a.category)}.`);
        fields = { ...t.fields, ...fields };
        collections = { ...t.collections, ...collections };
      }
      const newId = session.db.createRecord(ws, a.category as string, {
        name: a.name as string,
        fields,
        collections,
        ...(a.noteTags ? { noteTags: a.noteTags as Record<string, string | true> } : {}),
        ...(a.id !== undefined ? { id: a.id as number } : {}),
        ...(a.overwriteBlank !== undefined ? { overwriteBlank: a.overwriteBlank as boolean } : {}),
      });
      return { category: a.category, id: newId };
    },
  },
  database_update_record: {
    domain: "database",
    description:
      'Patch selected fields of a record (patch semantics; other fields untouched). Keys are field paths ("mpCost", "damage.formula" or {"damage": {"formula": ...}}); enums accept labels ("scope": "All Enemies"). For system use id 0 or omit id; system also accepts "switches.<id>", "variables.<id>", "terms.messages.<key>", etc.',
    shape: { category, id: z.number().int().optional(), patch: z.record(z.string(), z.unknown()) },
    run: ({ session, ws }, a) => session.db.updateRecord(ws, a.category as string, a.id as number | undefined, a.patch),
  },
  database_duplicate_record: {
    domain: "database",
    description: "Duplicate a record (deep copy, new ID = max+1). Referenced records (class, skills, states, equipment...) are NOT duplicated; the copy references the same IDs.",
    shape: { category, id: z.number().int(), name: z.string().optional() },
    run: ({ session, ws }, a) => ({ category: a.category, id: session.db.duplicateRecord(ws, a.category as string, a.id as number, { ...(a.name !== undefined ? { name: a.name as string } : {}) }) }),
  },
  database_delete_record: {
    domain: "database",
    destructive: true,
    description:
      'DESTRUCTIVE: delete a record without renumbering. mode "clear" (default) replaces it with a blank record in the same slot; "truncate_last" removes the highest ID only. The preview lists every known reference. Apply with apply_changes + confirm.',
    shape: { category, id: z.number().int(), mode: z.enum(["clear", "truncate_last"]).optional() },
    run: ({ session, ws }, a) => session.db.deleteRecord(ws, a.category as string, a.id as number, (a.mode as "clear" | "truncate_last" | undefined) ?? "clear"),
  },
  database_edit_collection: {
    domain: "database",
    description:
      'Edit a nested collection (traits, effects, learnings, actions, dropItems, members, flashTimings, soundTimings) with typed ops: {op:"add", entry, index?} | {op:"update", index, entry (partial), fingerprint?} | {op:"remove", index, fingerprint?} | {op:"move", from, to}. update/remove/move need expectedRevision (collections.<key>.revision from database_get_record). Trait/effect codes and dataIds accept labels (e.g. code "State Resist", dataId "Poison").',
    shape: {
      category,
      id: z.number().int(),
      collection: z.string(),
      ops: z.array(z.record(z.string(), z.unknown())),
      expectedRevision: z.string().optional(),
    },
    run: ({ session, ws }, a) => session.db.editCollection(ws, a.category as string, a.id as number, a.collection as string, a.ops as unknown[], a.expectedRevision as string | undefined),
  },
  database_edit_note: {
    domain: "database",
    description:
      'Edit a record\'s note: {op:"set_tag", tag, value?} (value omitted = flag tag <Tag>), {op:"remove_tag", tag}, or {op:"replace", note}. Unrelated tags and text are preserved exactly.',
    shape: { category, id: z.number().int(), op: z.enum(["set_tag", "remove_tag", "replace"]), tag: z.string().optional(), value: z.string().optional(), note: z.string().optional() },
    run: ({ session, ws }, a) => {
      const op = a.op as string;
      if (op === "replace") {
        if (typeof a.note !== "string") throw invalidInput("note is required for replace.");
        return session.db.setNote(ws, a.category as string, a.id as number, { op: "replace", note: a.note });
      }
      if (typeof a.tag !== "string") throw invalidInput("tag is required.");
      if (op === "set_tag") return session.db.setNote(ws, a.category as string, a.id as number, { op: "set_tag", tag: a.tag, value: (a.value as string | undefined) ?? true });
      return session.db.setNote(ws, a.category as string, a.id as number, { op: "remove_tag", tag: a.tag });
    },
  },
  database_set_class_curve: {
    domain: "database",
    description: "Regenerate one class parameter curve from level-1 and level-99 values (shape linear | ease_in | ease_out), or set all 100 values explicitly.",
    shape: {
      classId: z.number().int(),
      param: z.union([z.string(), z.number()]).describe('Parameter: 0-7 or "mhp", "atk", "Max HP", ...'),
      level1: z.number().int().optional(),
      level99: z.number().int().optional(),
      shape: z.enum(["linear", "ease_in", "ease_out"]).optional(),
      values: z.array(z.number().int()).optional(),
    },
    run: ({ session, ws }, a) => {
      if (a.values) return session.db.setClassCurve(ws, a.classId as number, a.param, { values: a.values as number[] });
      if (a.level1 === undefined || a.level99 === undefined) throw invalidInput("Provide level1 and level99, or values.");
      return session.db.setClassCurve(ws, a.classId as number, a.param, {
        level1: a.level1 as number,
        level99: a.level99 as number,
        ...(a.shape ? { shape: a.shape as "linear" | "ease_in" | "ease_out" } : {}),
      });
    },
  },
};

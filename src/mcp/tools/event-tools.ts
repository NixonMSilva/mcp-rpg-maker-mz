import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NativeCommonEvent } from "../../adapters/rpg-maker-mz/native-types.js";
import { eventIrReference } from "../../eventing/ir/reference-doc.js";
import { supportedBlockTypes } from "../../eventing/ir/normalize.js";
import { EVENT_TEMPLATES } from "../../eventing/templates/event-templates.js";
import { invalidInput } from "../../project/errors.js";
import { projectView, ReferenceIndex } from "../../references/reference-resolver.js";
import type { RefKind } from "../../references/ref-types.js";
import { analyzeCommonEventCycles, analyzeEvent, analyzeSwitchUsage } from "../../validation/flow-analysis.js";
import { reportRef } from "../../validation/event-validator.js";
import { ReferenceChecker } from "../../validation/reference-validator.js";
import { DiagnosticBag } from "../../validation/diagnostics.js";
import { findMapEvent } from "../../eventing/targets.js";
import type { AppContext } from "../context.js";
import { OPERATIONS, targetFrom } from "../operations.js";
import { diagnosticsReport, handler, mutationFlags, ok, runMutation } from "../tool-helpers.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const targetShape = {
  mapId: z.number().int().optional().describe("Map ID (map event page)"),
  eventId: z.number().int().optional().describe("Event ID (map event page)"),
  pageIndex: z.number().int().optional().describe("ZERO-based page index (map event or troop page)"),
  commonEventId: z.number().int().optional().describe("Common event ID"),
  troopId: z.number().int().optional().describe("Troop ID (battle event page)"),
};
type TargetArgs = { mapId?: number; eventId?: number; pageIndex?: number; commonEventId?: number; troopId?: number };

export function registerEventTools(server: McpServer, ctx: AppContext): void {
  // ---------------------------------------------------------------- inspection
  server.registerTool(
    "get_event_page",
    {
      title: "Get event page",
      description:
        "Page settings plus readable logic (with block ids) and the list revision. Works for map event pages, common events and troop pages. detailed=true adds the full Event IR.",
      inputSchema: { ...targetShape, detailed: z.boolean().optional() },
      annotations: RO,
    },
    handler((a: TargetArgs & { detailed?: boolean }) => ok("Event page", ctx.current().events.getEventPage(targetFrom(a), a.detailed === true))),
  );

  server.registerTool(
    "describe_event_page",
    {
      title: "Describe event page",
      description: "Human-readable description of a page: conditions, graphic, trigger, priority, movement and the command flow with block ids.",
      inputSchema: targetShape,
      annotations: RO,
    },
    handler((a: TargetArgs) => {
      const text = ctx.current().events.describeEventPage(targetFrom(a));
      return { content: [{ type: "text", text }] };
    }),
  );

  server.registerTool(
    "describe_map_event",
    {
      title: "Describe map event",
      description: "Human-readable description of an event and ALL its pages (page priority explained).",
      inputSchema: { mapId: z.number().int(), eventId: z.number().int() },
      annotations: RO,
    },
    handler(({ mapId, eventId }: { mapId: number; eventId: number }) => ({ content: [{ type: "text", text: ctx.current().events.describeEvent(mapId, eventId) }] })),
  );

  server.registerTool(
    "get_event_logic",
    {
      title: "Get event logic (IR)",
      description:
        "The Event IR of a command list with block ids, the revision token required by path-based edits, and whether the semantic view is complete (raw_command blocks are opaque but preserved).",
      inputSchema: targetShape,
      annotations: RO,
    },
    handler((a: TargetArgs) => ok("Event logic", ctx.current().events.getEventLogic(targetFrom(a)))),
  );

  server.registerTool(
    "get_event_page_native",
    { title: "Get native page data", description: "Raw native JSON of a page / common event / troop page, for debugging.", inputSchema: targetShape, annotations: RO },
    handler((a: TargetArgs) => ok("Native data", ctx.current().events.getEventPageNative(targetFrom(a)))),
  );

  server.registerTool(
    "search_event_commands",
    {
      title: "Search event commands",
      description:
        "Search all map events, common events and troop pages for blocks matching text, a block type and/or a reference (e.g. refKind \"switch\", refId 12). Results include locations and block ids.",
      inputSchema: {
        text: z.string().optional(),
        blockType: z.string().optional().describe("e.g. show_text, transfer_player, plugin_command, raw_command"),
        refKind: z.string().optional().describe("switch, variable, item, weapon, armor, actor, skill, state, common_event, map, troop, ..."),
        refId: z.union([z.number(), z.string()]).optional(),
        mapId: z.number().int().optional(),
        eventId: z.number().int().optional(),
        includeCommonEvents: z.boolean().optional(),
        includeTroops: z.boolean().optional(),
        limit: z.number().int().max(500).optional(),
      },
      annotations: RO,
    },
    handler((a: Record<string, unknown>) => {
      if (a.text === undefined && a.blockType === undefined && a.refKind === undefined) throw invalidInput("Provide text, blockType and/or refKind.");
      return ok("Search results", ctx.current().events.searchEventCommands(a as Parameters<ReturnType<AppContext["current"]>["events"]["searchEventCommands"]>[0]));
    }),
  );

  server.registerTool(
    "trace_event_dependencies",
    {
      title: "Trace event dependencies",
      description:
        "Switches, variables, self switches, items, actors, common events, maps and other IDs referenced by a page (including page conditions and \\V[n] text codes), with names and validity. followCommonEvents also traces called common events.",
      inputSchema: { ...targetShape, followCommonEvents: z.boolean().optional() },
      annotations: RO,
    },
    handler((a: TargetArgs & { followCommonEvents?: boolean }) => ok("Dependencies", ctx.current().events.traceDependencies(targetFrom(a), a.followCommonEvents !== false))),
  );

  server.registerTool(
    "find_references",
    {
      title: "Find references",
      description:
        "Reverse lookup: every known reference to a switch, variable, database record, common event, map, or map event (refKind \"event\" needs mapId). Includes low-confidence matches inferred from script text.",
      inputSchema: {
        refKind: z.string(),
        id: z.union([z.number(), z.string()]),
        mapId: z.number().int().optional(),
        eventId: z.number().int().optional().describe("For self_switch: the owning event"),
      },
      annotations: RO,
    },
    handler((a: { refKind: string; id: number | string; mapId?: number; eventId?: number }) =>
      ok(`References to ${a.refKind} ${a.id}`, ctx.current().db.findRefsOfKind(a.refKind as RefKind, a.id, { ...(a.mapId !== undefined ? { mapId: a.mapId } : {}), ...(a.eventId !== undefined ? { eventId: a.eventId } : {}) })),
    ),
  );

  server.registerTool(
    "get_event_ir_reference",
    { title: "Event IR reference", description: "Documentation of every Event IR block type, condition, route command and convention.", inputSchema: {}, annotations: RO },
    handler(() => ({ content: [{ type: "text", text: eventIrReference() }] })),
  );

  server.registerTool(
    "list_event_templates",
    { title: "List event templates", description: "Event templates usable with create_event_from_template, with their parameters.", inputSchema: {}, annotations: RO },
    handler(() => ok("Event templates", { templates: Object.entries(EVENT_TEMPLATES).map(([name, t]) => ({ name, description: t.description, params: t.params })), blockTypes: supportedBlockTypes() })),
  );

  // ---------------------------------------------------------------- validation & analysis
  server.registerTool(
    "validate_event_page",
    {
      title: "Validate event page",
      description:
        "Validate a page (structure, settings, references, flow heuristics). Pass `proposedLogic` (IR) to validate a replacement without staging it. Errors block writes; warnings need acknowledgement.",
      inputSchema: { ...targetShape, proposedLogic: z.union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown())]).optional(), allowScript: z.boolean().optional() },
      annotations: RO,
    },
    handler((a: TargetArgs & { proposedLogic?: unknown; allowScript?: boolean }) => {
      const ev = ctx.current().events;
      const t = targetFrom(a);
      const diags =
        a.proposedLogic !== undefined
          ? ev.validateProposedLogic(t, Array.isArray(a.proposedLogic) ? a.proposedLogic : (a.proposedLogic as { blocks?: unknown }).blocks, { allowScript: a.allowScript === true, existingScripts: new Set() })
          : ev.validateList(t);
      const r = diagnosticsReport(diags);
      return ok(`Validation: ${String(r.errorCount)} error(s), ${String(r.warningCount)} warning(s)`, r);
    }),
  );

  server.registerTool(
    "validate_map_events",
    { title: "Validate map events", description: "Validate every event and page on a map (structure, settings, references, positions, page shadowing).", inputSchema: { mapId: z.number().int() }, annotations: RO },
    handler(({ mapId }: { mapId: number }) => {
      const r = diagnosticsReport(ctx.current().events.validateMap(mapId), 100);
      return ok(`Map ${mapId}: ${String(r.errorCount)} error(s), ${String(r.warningCount)} warning(s)`, r);
    }),
  );

  server.registerTool(
    "validate_project_references",
    {
      title: "Validate project references",
      description:
        "Check every indexed reference in the project (events, common events, troops, database records) for missing/blank targets. scope: all | events | database. Distinguishes invalid references from unresolvable ones.",
      inputSchema: { scope: z.enum(["all", "events", "database"]).optional(), limit: z.number().int().max(2000).optional() },
      annotations: RO,
    },
    handler(({ scope, limit }: { scope?: "all" | "events" | "database"; limit?: number }) => {
      const s = ctx.current();
      const view = projectView(s.project);
      const idx = ReferenceIndex.build(view);
      const checker = ReferenceChecker.forProject(s.project, view);
      const bag = new DiagnosticBag();
      for (const e of idx.entries) {
        const isEvent = e.source.mapId !== undefined || e.source.commonEventId !== undefined || e.source.troopId !== undefined;
        if (scope === "events" && !isEvent) continue;
        if (scope === "database" && isEvent) continue;
        reportRef(bag, checker, e.ref, { ...(e.source.mapId !== undefined ? { mapId: e.source.mapId } : {}) }, e.source.label);
      }
      bag.merge(analyzeCommonEventCycles(s.project.commonEvents().data as (NativeCommonEvent | null)[]));
      const items = bag.items.slice(0, limit ?? 500);
      const r = diagnosticsReport(items, 50);
      return ok(`Checked ${idx.entries.length} references: ${String(r.errorCount)} error(s), ${String(r.warningCount)} warning(s)`, { referencesChecked: idx.entries.length, ...r, truncated: bag.items.length > items.length });
    }),
  );

  server.registerTool(
    "analyze_event_flow",
    {
      title: "Analyze event flow",
      description:
        "Heuristic logic analysis (labelled as heuristics, never auto-fixed): unreachable blocks, contradicted/redundant conditions, loops without exit, autorun pages that never end, shadowed pages, unused self switches, switches set but never read on the map, common event call cycles.",
      inputSchema: { ...targetShape, scope: z.enum(["page", "event", "map"]).optional() },
      annotations: RO,
    },
    handler((a: TargetArgs & { scope?: "page" | "event" | "map" }) => {
      const s = ctx.current();
      const bag = new DiagnosticBag();
      const scope = a.scope ?? (a.pageIndex !== undefined || a.commonEventId !== undefined ? "page" : a.eventId !== undefined ? "event" : "map");
      if (scope === "page") {
        bag.merge(s.events.validateList(targetFrom(a)).filter((d) => d.heuristic));
      } else {
        if (a.mapId === undefined) throw invalidInput("mapId is required for event/map scope.");
        const map = s.project.readMap(a.mapId).data;
        const events = scope === "event" ? [findMapEvent(map, a.mapId, a.eventId ?? -1)] : map.events.filter((e) => e !== null);
        const writes = new Map<number, string[]>();
        const reads = new Set<number>();
        for (const ev of events) {
          if (!ev) continue;
          bag.merge(analyzeEvent(ev, `Map ${a.mapId} / Event ${ev.id} [${ev.name}]`));
          ev.pages.forEach((_p, i) => bag.merge(s.events.validateList({ kind: "map_event_page", mapId: a.mapId!, eventId: ev.id, pageIndex: i }).filter((d) => d.heuristic)));
        }
        if (scope === "map") {
          const idx = ReferenceIndex.build(projectView(s.project));
          for (const e of idx.entries) {
            if (e.ref.kind !== "switch" || typeof e.ref.id !== "number") continue;
            if (e.ref.role === "write" && e.source.mapId === a.mapId) writes.set(e.ref.id, [...(writes.get(e.ref.id) ?? []), e.source.label]);
            if (e.ref.role !== "write") reads.add(e.ref.id);
          }
          bag.merge(analyzeSwitchUsage(writes, reads, "the whole project"));
        }
      }
      const r = diagnosticsReport(bag.items, 100);
      return ok(`Flow analysis (${scope}, heuristic): ${String(r.warningCount)} warning(s), ${String(r.infoCount)} info`, r);
    }),
  );

  // ---------------------------------------------------------------- mutations (one tool per operation)
  for (const [name, def] of Object.entries(OPERATIONS)) {
    if (def.domain !== "event") continue;
    server.registerTool(
      name,
      {
        title: name.replace(/_/g, " "),
        description: `${def.description}\n\nPreview-first: returns a change set (semantic + native diff, validation). ${def.destructive ? "Destructive: apply only via apply_changes with confirm." : "Pass apply=true to commit immediately when the preview is clean."}`,
        inputSchema: { ...def.shape, ...mutationFlags },
        annotations: { readOnlyHint: false, destructiveHint: def.destructive === true, idempotentHint: false, openWorldHint: false },
      },
      handler((a: Record<string, unknown>) => {
        const { apply, acknowledgeWarnings, allowScript, description, ...args } = a;
        return runMutation(ctx, {
          ops: [{ op: name, args }],
          apply: apply === true,
          acknowledgeWarnings: acknowledgeWarnings === true,
          allowScript: allowScript === true,
          ...(typeof description === "string" ? { description } : {}),
        });
      }),
    );
  }

  const batchSchema = {
    operations: z
      .array(z.object({ op: z.string().describe("Operation name, e.g. create_map_event, append_event_blocks, database_create_record"), args: z.record(z.string(), z.unknown()) }))
      .min(1)
      .describe("Operations applied in order to one staged workspace"),
    ...mutationFlags,
  };
  const batch = handler((a: { operations: { op: string; args: Record<string, unknown> }[]; apply?: boolean; acknowledgeWarnings?: boolean; allowScript?: boolean; description?: string }) =>
    runMutation(ctx, {
      ops: a.operations,
      apply: a.apply === true,
      acknowledgeWarnings: a.acknowledgeWarnings === true,
      allowScript: a.allowScript === true,
      ...(a.description ? { description: a.description } : {}),
    }),
  );
  const batchDesc = (domain: string) =>
    `Preview several operations as ONE atomic change set (${domain}; any registered operation is accepted, so events and database records can be changed together). The whole resulting project state is validated; nothing is written until apply_changes. Operations: ${Object.keys(OPERATIONS).join(", ")}.`;
  server.registerTool("preview_event_changes", { title: "Preview event changes (batch)", description: batchDesc("event-focused"), inputSchema: batchSchema, annotations: { readOnlyHint: false, openWorldHint: false } }, batch);
  server.registerTool("preview_changes", { title: "Preview changes (batch)", description: batchDesc("cross-domain"), inputSchema: batchSchema, annotations: { readOnlyHint: false, openWorldHint: false } }, batch);
}

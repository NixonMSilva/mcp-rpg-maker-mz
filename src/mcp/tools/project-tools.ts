import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parsePluginHeader } from "../../adapters/rpg-maker-mz/plugin-header.js";
import { notFound } from "../../project/errors.js";
import { SUPPORTED_MZ_VERSIONS } from "../../project/project-service.js";
import type { AppContext } from "../context.js";
import { applyReport, changeSetReport, handler, ok } from "../tool-helpers.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerProjectTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_project_info",
    {
      title: "Project info",
      description: "Project root, detected engine/editor version, write mode, available data files and plugin count. Call this first.",
      inputSchema: {},
      annotations: RO,
    },
    handler(() => {
      const s = ctx.current();
      const p = s.project;
      const maps = p.mapInfos().data.filter(Boolean).length;
      let plugins: number | string = 0;
      try {
        plugins = p.plugins().length;
      } catch (err) {
        plugins = `unreadable: ${(err as Error).message}`;
      }
      const sys = p.system().data;
      return ok(`Project ${String(sys.gameTitle ?? "")} at ${p.root}`, {
        root: p.root,
        gameTitle: sys.gameTitle,
        engine: p.detection.engine,
        editorVersion: p.detection.editorVersion,
        coreScriptVersion: p.detection.coreScriptVersion,
        supportedVersions: SUPPORTED_MZ_VERSIONS,
        detectionNotes: p.detection.notes,
        writeEnabled: p.allowWrite && p.detection.isMz,
        writeMode: p.allowWrite ? "preview + apply (--allow-write)" : "read-only (previews only)",
        stateDir: p.stateDir,
        mapCount: maps,
        dataFiles: p.listDataFiles(),
        pluginCount: plugins,
        conventions: [
          "pageIndex is zero-based (Page 1 = pageIndex 0); later pages win when several pages' conditions are met.",
          "All writes are previewed as change sets, validated, backed up and applied atomically with apply_changes.",
          "Database IDs and event IDs are never renumbered.",
        ],
      });
    }),
  );

  server.registerTool(
    "list_projects",
    { title: "List configured projects", description: "Projects configured at server start (--project). The selected one is used by all tools.", inputSchema: {}, annotations: RO },
    handler(() => ok("Configured projects", { projects: ctx.listProjects() })),
  );

  server.registerTool(
    "select_project",
    {
      title: "Select project",
      description: "Switch the active project to one of the configured projects (by index, folder name or path).",
      inputSchema: { project: z.string().describe("Index, folder name or path of a configured project") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ project }: { project: string }) => {
      const s = ctx.select(project);
      return ok(`Selected ${s.project.root}`, { root: s.project.root, engine: s.project.detection.engine, editorVersion: s.project.detection.editorVersion });
    }),
  );

  server.registerTool(
    "list_maps",
    {
      title: "List maps",
      description: "Enumerate maps from MapInfos.json (IDs, names, tree parent and order). Map files are resolved by ID, never by display name.",
      inputSchema: { nameContains: z.string().optional(), parentId: z.number().int().optional() },
      annotations: RO,
    },
    handler((a: { nameContains?: string; parentId?: number }) => {
      const maps = ctx.current().events.listMaps(a);
      return ok(`${maps.length} map(s)`, { maps });
    }),
  );

  server.registerTool(
    "get_map_summary",
    { title: "Map summary", description: "Map metadata (size, tileset, display name, note) and a summary of every event.", inputSchema: { mapId: z.number().int() }, annotations: RO },
    handler(({ mapId }: { mapId: number }) => {
      const m = ctx.current().events.mapSummary(mapId);
      return ok(`Map ${mapId} [${String(m.name)}]: ${String(m.eventCount)} event(s)`, m);
    }),
  );

  server.registerTool(
    "list_map_events",
    {
      title: "List map events",
      description: "Event IDs, names, coordinates, page counts and triggers on a map (paginated).",
      inputSchema: { mapId: z.number().int(), nameContains: z.string().optional(), offset: z.number().int().optional(), limit: z.number().int().max(500).optional() },
      annotations: RO,
    },
    handler((a: { mapId: number; nameContains?: string; offset?: number; limit?: number }) => ok(`Events on map ${a.mapId}`, ctx.current().events.listMapEvents(a.mapId, a))),
  );

  server.registerTool(
    "get_map_event",
    {
      title: "Get map event",
      description: "Event metadata and every page's settings (conditions, graphic, trigger, priority, movement), command counts, logic revisions and a short preview.",
      inputSchema: { mapId: z.number().int(), eventId: z.number().int() },
      annotations: RO,
    },
    handler(({ mapId, eventId }: { mapId: number; eventId: number }) => ok(`Map ${mapId} / Event ${eventId}`, ctx.current().events.getMapEvent(mapId, eventId))),
  );

  server.registerTool(
    "list_common_events",
    {
      title: "List common events",
      description: "Common event IDs, names and triggers (paginated).",
      inputSchema: { nameContains: z.string().optional(), offset: z.number().int().optional(), limit: z.number().int().max(500).optional() },
      annotations: RO,
    },
    handler((a: { nameContains?: string; offset?: number; limit?: number }) => ok("Common events", ctx.current().events.listCommonEvents(a))),
  );

  server.registerTool(
    "get_common_event",
    {
      title: "Get common event",
      description: "A common event's trigger, condition switch and logic description (detailed=true also returns the Event IR).",
      inputSchema: { commonEventId: z.number().int(), detailed: z.boolean().optional() },
      annotations: RO,
    },
    handler(({ commonEventId, detailed }: { commonEventId: number; detailed?: boolean }) => ok(`Common event ${commonEventId}`, ctx.current().events.getCommonEvent(commonEventId, detailed === true))),
  );

  server.registerTool(
    "list_plugins",
    {
      title: "List plugins",
      description: "Plugins from js/plugins.js with status and parameters (parsed as data; plugin code is never executed).",
      inputSchema: { enabledOnly: z.boolean().optional() },
      annotations: RO,
    },
    handler(({ enabledOnly }: { enabledOnly?: boolean }) => {
      const plugins = ctx.current().events.listPlugins(enabledOnly === true);
      return ok(`${plugins.length} plugin(s)`, { plugins });
    }),
  );

  server.registerTool(
    "get_plugin_commands",
    {
      title: "Plugin command schemas",
      description:
        "Commands and arguments declared in a plugin's annotation header (js/plugins/<name>.js, read as text, never executed). Schemas are INFERRED from annotations; use them to author plugin_command blocks without inventing names.",
      inputSchema: { pluginName: z.string() },
      annotations: RO,
    },
    handler(({ pluginName }: { pluginName: string }) => {
      const p = ctx.current().project;
      const entry = p.plugins().find((x) => x.name === pluginName);
      const src = p.pluginSource(pluginName);
      if (!src) throw notFound(`No readable plugin file js/plugins/${pluginName}.js.`);
      const header = parsePluginHeader(src);
      return ok(`${pluginName}: ${header?.commands.length ?? 0} declared command(s)`, {
        pluginName,
        installed: !!entry,
        enabled: entry?.status ?? false,
        header,
        note: "Schemas are inferred from @command/@arg annotations; plugins may accept more than they declare.",
      });
    }),
  );

  for (const kind of ["switch", "variable"] as const) {
    server.registerTool(
      kind === "switch" ? "list_switches" : "list_variables",
      {
        title: kind === "switch" ? "List switches" : "List variables",
        description: `Game ${kind}es with names and how many event/common-event/troop references use each. onlyFree=true lists unnamed, unreferenced IDs to use for new logic without conflicts.`.replace("variablees", "variables"),
        inputSchema: { onlyFree: z.boolean().optional(), nameContains: z.string().optional(), offset: z.number().int().optional(), limit: z.number().int().max(2000).optional() },
        annotations: RO,
      },
      handler((a: { onlyFree?: boolean; nameContains?: string; offset?: number; limit?: number }) => ok(`${kind}s`, ctx.current().db.listSwitchesOrVariables(kind, a))),
    );
  }

  // ---------------------------------------------------------------- transactions

  const applySchema = {
    changeSetId: z.string(),
    acknowledgeWarnings: z.boolean().optional().describe("Required when the change set has warnings"),
    confirm: z.string().optional().describe("For destructive change sets: repeat the changeSetId to confirm"),
  };
  const applyHandler = handler((a: { changeSetId: string; acknowledgeWarnings?: boolean; confirm?: string }) => {
    const s = ctx.current();
    const r = s.tx.apply(a.changeSetId, { ...(a.acknowledgeWarnings !== undefined ? { acknowledgeWarnings: a.acknowledgeWarnings } : {}), ...(a.confirm !== undefined ? { confirm: a.confirm } : {}) });
    return ok(r.transactionId ? `Committed ${a.changeSetId} as ${r.transactionId}. Backup: ${r.backupDir}. Re-read affected data before further edits.` : "Nothing to write.", applyReport(r));
  });
  const applyDesc =
    "Commit a previously previewed change set. Re-checks file revisions (rejects stale previews), backs up originals, writes atomically, and rolls back on failure. Requires --allow-write.";
  for (const name of ["apply_changes", "apply_event_changes", "database_apply_changes"]) {
    server.registerTool(
      name,
      {
        title: "Apply change set",
        description: name === "apply_changes" ? applyDesc : `${applyDesc} (Alias of apply_changes; any change set id is accepted.)`,
        inputSchema: applySchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      applyHandler,
    );
  }

  server.registerTool(
    "list_pending_changes",
    { title: "Pending change sets", description: "Change sets previewed but not yet applied (expire after 1 hour).", inputSchema: {}, annotations: RO },
    handler(() => {
      const s = ctx.current();
      return ok("Pending change sets", { pending: s.tx.listPending().map((cs) => ({ id: cs.id, description: cs.description, createdAt: cs.createdAt, destructive: cs.destructive, files: cs.files.map((f) => f.relPath), diagnostics: cs.diagnosticSummary })) });
    }),
  );

  server.registerTool(
    "get_change_set",
    { title: "Get change set", description: "Full preview (diffs, diagnostics) of a pending change set.", inputSchema: { changeSetId: z.string() }, annotations: RO },
    handler(({ changeSetId }: { changeSetId: string }) => {
      const s = ctx.current();
      return ok(`Change set ${changeSetId}`, { changeSet: changeSetReport(s.tx.getPending(changeSetId), s.project.allowWrite) });
    }),
  );

  server.registerTool(
    "discard_changes",
    { title: "Discard change set", description: "Drop a pending change set (nothing on disk is touched).", inputSchema: { changeSetId: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false } },
    handler(({ changeSetId }: { changeSetId: string }) => ok(ctx.current().tx.discard(changeSetId) ? `Discarded ${changeSetId}` : `No pending change set ${changeSetId}`, {})),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "Transaction log",
      description: "Committed (and failed) write transactions with changed files, revisions and backup locations, newest first.",
      inputSchema: { limit: z.number().int().max(500).optional() },
      annotations: RO,
    },
    handler(({ limit }: { limit?: number }) => {
      const log = ctx.current().tx.readLog().reverse().slice(0, limit ?? 50);
      return ok(`${log.length} transaction(s)`, { transactions: log });
    }),
  );

  server.registerTool(
    "rollback_transaction",
    {
      title: "Roll back a transaction",
      description:
        "Preview restoring the files of a committed transaction from its backup. Refused if those files changed afterwards. The rollback itself is a destructive change set: apply it with apply_changes + confirm.",
      inputSchema: { transactionId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(({ transactionId }: { transactionId: string }) => {
      const s = ctx.current();
      const cs = s.tx.stageRollback(transactionId);
      return ok(`Previewed rollback of ${transactionId} as ${cs.id}`, { changeSet: changeSetReport(cs, s.project.allowWrite) });
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES } from "../../database/database-catalog.js";
import { TEMPLATES } from "../../database/templates.js";
import type { AppContext } from "../context.js";
import { OPERATIONS } from "../operations.js";
import { diagnosticsReport, handler, mutationFlags, ok, runMutation } from "../tool-helpers.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const category = z.enum(CATEGORIES.map((c) => c.category) as [string, ...string[]]).describe("Database category");

export function registerDatabaseTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "database_list_categories",
    { title: "Database categories", description: "Available database categories with record counts and max IDs.", inputSchema: {}, annotations: RO },
    handler(() => ok("Database categories", { categories: ctx.current().db.listCategories() })),
  );

  server.registerTool(
    "database_list_records",
    {
      title: "List database records",
      description: "Concise record summaries of a category (paginated). Blank (unnamed) slots are hidden unless includeBlank=true.",
      inputSchema: {
        category,
        nameContains: z.string().optional(),
        includeBlank: z.boolean().optional(),
        offset: z.number().int().optional(),
        limit: z.number().int().max(1000).optional(),
      },
      annotations: RO,
    },
    handler((a: { category: string; nameContains?: string; includeBlank?: boolean; offset?: number; limit?: number }) => ok(`${a.category} records`, ctx.current().db.listRecords(a.category, a))),
  );

  server.registerTool(
    "database_get_record",
    {
      title: "Get database record",
      description:
        "Normalized record: fields with enum labels and reference names, collections (traits/effects/...) with per-collection revision and per-entry fingerprints, note tags, unmodeled (plugin) fields. detailed=true includes the native JSON. For system omit id.",
      inputSchema: { category, id: z.number().int().optional(), detailed: z.boolean().optional() },
      annotations: RO,
    },
    handler((a: { category: string; id?: number; detailed?: boolean }) => ok(`${a.category} ${a.id ?? ""}`.trim(), ctx.current().db.getRecord(a.category, a.id, a.detailed === true))),
  );

  server.registerTool(
    "database_search_records",
    {
      title: "Search database records",
      description: "Search records by name, note, description or note-tag metadata across one or more categories.",
      inputSchema: {
        text: z.string(),
        categories: z.array(category).optional(),
        fields: z.array(z.enum(["name", "note", "description", "meta"])).optional(),
        limit: z.number().int().max(500).optional(),
      },
      annotations: RO,
    },
    handler((a: { text: string; categories?: string[]; fields?: ("name" | "note" | "description" | "meta")[]; limit?: number }) => ok("Search results", ctx.current().db.search(a))),
  );

  server.registerTool(
    "database_resolve_reference",
    {
      title: "Resolve database reference",
      description:
        "Validate a category+ID, or find a record by name (exact matches first, then partial candidates). Use before authoring events that reference database records; ask the user when ambiguous.",
      inputSchema: { category, id: z.number().int().optional(), name: z.string().optional() },
      annotations: RO,
    },
    handler((a: { category: string; id?: number; name?: string }) =>
      ok("Resolution", ctx.current().db.resolveReference(a.category, { ...(a.id !== undefined ? { id: a.id } : {}), ...(a.name !== undefined ? { name: a.name } : {}) })),
    ),
  );

  server.registerTool(
    "database_find_references",
    {
      title: "Find references to a record",
      description: "Every known reference to a record from events, common events, troops and other records (run before deleting or repurposing a record).",
      inputSchema: { category, id: z.number().int() },
      annotations: RO,
    },
    handler((a: { category: string; id: number }) => ok(`References to ${a.category} ${a.id}`, ctx.current().db.findReferences(a.category, a.id))),
  );

  server.registerTool(
    "database_validate_category",
    {
      title: "Validate database category",
      description: "Record validation (types, enums, ranges, required native fields), reference validation and advisory design diagnostics for a category or selected IDs.",
      inputSchema: { category, ids: z.array(z.number().int()).optional() },
      annotations: RO,
    },
    handler((a: { category: string; ids?: number[] }) => {
      const r = diagnosticsReport(ctx.current().db.validateCategory(a.category, a.ids), 100);
      return ok(`${a.category}: ${String(r.errorCount)} error(s), ${String(r.warningCount)} warning(s)`, r);
    }),
  );

  server.registerTool(
    "database_compare_records",
    { title: "Compare records", description: "Structural differences between two records of the same category.", inputSchema: { category, a: z.number().int(), b: z.number().int() }, annotations: RO },
    handler((x: { category: string; a: number; b: number }) => ok("Comparison", ctx.current().db.compareRecords(x.category, x.a, x.b))),
  );

  server.registerTool(
    "database_list_templates",
    { title: "Database templates", description: "Record templates for database_create_record (template + templateParams).", inputSchema: {}, annotations: RO },
    handler(() => ok("Templates", { templates: Object.entries(TEMPLATES).map(([name, t]) => ({ name, category: t.category, description: t.description, params: t.params })) })),
  );

  server.registerTool(
    "database_describe_schema",
    {
      title: "Database schema",
      description: "Patchable fields (with types, ranges, enums, reference kinds) and collections of a category.",
      inputSchema: { category },
      annotations: RO,
    },
    handler(({ category: c }: { category: string }) => {
      const def = ctx.current().db.def(c);
      return ok(`${def.label} schema`, {
        category: def.category,
        file: `data/${def.file}`,
        fields: def.fields.map((f) => ({ path: f.path, type: f.type, description: f.description, ...(f.enum ? { options: f.enum.options() } : {}), ...(f.ref ? { ref: f.ref } : {}), ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}), ...(f.special ? { special: f.special } : {}) })),
        collections: def.collections.map((c2) => ({ key: c2.key, label: c2.label, fixedLength: c2.fixedLength, entry: c2.entry.map((e) => ({ key: e.key, type: e.type, description: e.description, ...(e.enum ? { options: e.enum.options() } : {}) })) })),
      });
    }),
  );

  // ---------------------------------------------------------------- mutations
  for (const [name, def] of Object.entries(OPERATIONS)) {
    if (def.domain !== "database") continue;
    server.registerTool(
      name,
      {
        title: name.replace(/_/g, " "),
        description: `${def.description}\n\nPreview-first: returns a change set (normalized + native diff, validation incl. reverse references). ${def.destructive ? "Destructive: apply only via apply_changes with confirm." : "Pass apply=true to commit immediately when the preview is clean."}`,
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

  server.registerTool(
    "database_preview_changes",
    {
      title: "Preview database changes (batch)",
      description: `Preview several operations as one atomic change set; the complete resulting state is validated (records, references, reverse references). Operations: ${Object.keys(OPERATIONS).join(", ")}.`,
      inputSchema: { operations: z.array(z.object({ op: z.string(), args: z.record(z.string(), z.unknown()) })).min(1), ...mutationFlags },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler((a: { operations: { op: string; args: Record<string, unknown> }[]; apply?: boolean; acknowledgeWarnings?: boolean; allowScript?: boolean; description?: string }) =>
      runMutation(ctx, { ops: a.operations, apply: a.apply === true, acknowledgeWarnings: a.acknowledgeWarnings === true, allowScript: a.allowScript === true, ...(a.description ? { description: a.description } : {}) }),
    ),
  );
}

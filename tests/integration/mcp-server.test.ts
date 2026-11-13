import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/index.js";
import { AppContext } from "../../src/mcp/context.js";
import { createServer } from "../../src/mcp/server.js";
import { FIXTURE_ROOT, MAP2, readJson, tempProject } from "../helpers/fixture.js";

let client: Client | null = null;

async function connect(projects: string[], allowWrite: boolean): Promise<Client> {
  const ctx = new AppContext({ projects, allowWrite, allowAnyProject: false, stateDir: ".rpgmz-mcp" });
  expect(ctx.init()).toBeNull();
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

afterEach(async () => {
  await client?.close();
  client = null;
});

function data(r: unknown): Record<string, unknown> {
  return ((r as CallToolResult).structuredContent ?? {}) as Record<string, unknown>;
}

describe("MCP server (stdio-equivalent, in-memory transport)", () => {
  it("exposes the event and database tools, resources and prompts", async () => {
    const c = await connect([FIXTURE_ROOT], false);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const name of [
      "get_project_info",
      "list_maps",
      "get_map_summary",
      "list_map_events",
      "get_map_event",
      "get_common_event",
      "list_plugins",
      "get_event_page",
      "describe_event_page",
      "search_event_commands",
      "trace_event_dependencies",
      "get_event_page_native",
      "create_map_event",
      "update_map_event",
      "create_event_page",
      "clone_event_page",
      "delete_event_page",
      "update_event_page_settings",
      "reorder_event_pages",
      "delete_map_event",
      "append_event_blocks",
      "insert_event_blocks",
      "replace_event_block",
      "remove_event_block",
      "move_event_block",
      "replace_event_logic",
      "get_event_logic",
      "validate_event_page",
      "validate_map_events",
      "validate_project_references",
      "analyze_event_flow",
      "preview_event_changes",
      "apply_event_changes",
      "database_list_categories",
      "database_list_records",
      "database_get_record",
      "database_search_records",
      "database_resolve_reference",
      "database_create_record",
      "database_update_record",
      "database_duplicate_record",
      "database_delete_record",
      "database_edit_collection",
      "database_find_references",
      "database_validate_category",
      "database_compare_records",
      "database_preview_changes",
      "database_apply_changes",
      "rollback_transaction",
    ]) {
      expect(tools, name).toContain(name);
    }
    const resources = await c.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain("rpgmz://docs/event-ir");
    const doc = await c.readResource({ uri: "rpgmz://docs/event-ir" });
    expect(String((doc.contents[0] as { text: string }).text)).toContain("show_choices");
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toContain("create_quest_npc");
  });

  it("inspects a project read-only and reports write mode", async () => {
    const c = await connect([FIXTURE_ROOT], false);
    const info = data(await c.callTool({ name: "get_project_info", arguments: {} }));
    expect(info).toMatchObject({ success: true, engine: "MZ", editorVersion: "1.10.0", writeEnabled: false });
    const page = await c.callTool({ name: "describe_event_page", arguments: { mapId: 2, eventId: 2, pageIndex: 0 } });
    const text = (page.content as { text: string }[])[0]!.text;
    expect(text).toContain("If: Switch 1 [Gate Open] is ON");
    expect(text).toContain("[0/else/0] If: Party has Item 7 [Potion]");
    const deps = data(await c.callTool({ name: "trace_event_dependencies", arguments: { mapId: 2, eventId: 6, pageIndex: 0 } }));
    const kinds = Object.keys(deps.dependencies as object);
    expect(kinds).toEqual(expect.arrayContaining(["common_event", "plugin", "variable", "switch"]));
    // Writes are previewed but refused in read-only mode.
    const prev = data(await c.callTool({ name: "append_event_blocks", arguments: { mapId: 2, eventId: 1, pageIndex: 0, blocks: [{ type: "wait", frames: 5 }], apply: true } }));
    expect(prev.applied).toBe(false);
    expect((prev.applyError as { code: string }).code).toBe("WRITE_DISABLED");
  });

  it("returns structured, actionable errors", async () => {
    const c = await connect([FIXTURE_ROOT], false);
    const r = (await c.callTool({ name: "get_event_page", arguments: { mapId: 2, eventId: 99, pageIndex: 0 } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(data(r)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    const bad = (await c.callTool({ name: "append_event_blocks", arguments: { mapId: 2, eventId: 1, pageIndex: 0, blocks: [{ type: "telepor" }] } })) as CallToolResult;
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toContain('unknown block type "telepor"');
  });

  it("completes a database-aware authoring workflow: resolve → create → preview → apply → re-read", async () => {
    const root = tempProject();
    const c = await connect([root], true);
    const resolved = data(await c.callTool({ name: "database_resolve_reference", arguments: { category: "item", name: "Potion" } }));
    expect(resolved.status).toBe("resolved");

    const preview = data(
      await c.callTool({
        name: "preview_changes",
        arguments: {
          operations: [
            { op: "database_create_record", args: { category: "item", name: "Bronze Key", template: "key_item" } },
            {
              op: "create_event_from_template",
              args: { mapId: 2, template: "treasure_chest", x: 18, y: 12, params: { reward: { kind: "item", id: resolved.id, amount: 1 }, message: "Found a Potion!" } },
            },
          ],
        },
      }),
    );
    const cs = preview.changeSet as { changeSetId: string; files: { relPath: string }[]; diagnostics: { errorCount: number; warningCount: number } };
    expect(cs.diagnostics.errorCount).toBe(0);
    expect(cs.files.map((f) => f.relPath).sort()).toEqual(["data/Items.json", MAP2]);
    const applied = data(await c.callTool({ name: "apply_changes", arguments: { changeSetId: cs.changeSetId, acknowledgeWarnings: true } }));
    expect(applied.transactionId).toMatch(/^tx_/);
    const map = readJson(root, MAP2) as { events: ({ name: string } | null)[] };
    expect(map.events[10]!.name).toBe("Chest");
    const logic = data(await c.callTool({ name: "get_event_logic", arguments: { mapId: 2, eventId: 10, pageIndex: 0 } }));
    expect(logic.complete).toBe(true);
    const log = data(await c.callTool({ name: "list_transactions", arguments: {} }));
    expect((log.transactions as unknown[]).length).toBe(1);
  });

  it("requires confirmation for destructive tools", async () => {
    const c = await connect([tempProject()], true);
    const prev = data(await c.callTool({ name: "delete_map_event", arguments: { mapId: 2, eventId: 11, apply: true } }));
    expect(prev.applied).toBe(false);
    const id = (prev.changeSet as { changeSetId: string }).changeSetId;
    const refused = (await c.callTool({ name: "apply_changes", arguments: { changeSetId: id } })) as CallToolResult;
    expect(data(refused)).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED" } });
    const ok = data(await c.callTool({ name: "apply_changes", arguments: { changeSetId: id, confirm: id, acknowledgeWarnings: true } }));
    expect(ok.success).toBe(true);
  });

  it("only selects configured projects", async () => {
    const c = await connect([FIXTURE_ROOT], false);
    const r = (await c.callTool({ name: "select_project", arguments: { project: "C:/Windows" } })) as CallToolResult;
    expect(r.isError).toBe(true);
  });
});

describe("CLI arguments", () => {
  it("parses projects, write mode and state dir", () => {
    expect(parseArgs(["--project", "a", "--allow-write"], {})).toMatchObject({ projects: ["a"], allowWrite: true, stateDir: ".rpgmz-mcp" });
    expect(parseArgs([], { RPGMZ_PROJECT: "x", RPGMZ_MCP_ALLOW_WRITE: "1" })).toMatchObject({ projects: ["x"], allowWrite: true });
    expect(() => parseArgs(["--state-dir", "../out"], {})).toThrow(/relative path inside/);
    expect(() => parseArgs(["--nope"], {})).toThrow(/Unknown argument/);
  });
});

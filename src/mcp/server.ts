import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerDatabaseTools } from "./tools/database-tools.js";
import { registerEventTools } from "./tools/event-tools.js";
import { registerMapTools } from "./tools/map-tools.js";
import { registerProjectTools } from "./tools/project-tools.js";

export const SERVER_NAME = "rpgmaker-mz-authoring";
export const SERVER_VERSION = "0.1.0";

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "RPG Maker MZ authoring server (events + database). Start with get_project_info.",
        "Read before writing: describe_map_event / get_event_logic / database_get_record.",
        "Before placing or moving events, look at the map: render_map (image) and get_map_passability (exact walkability); get_tile_info checks spots, find_path builds movement routes.",
        "Every write tool returns a PREVIEW change set (semantic + native diff, validation). Commit with apply_changes (or apply=true for clean, non-destructive edits).",
        "pageIndex is zero-based. Path-based logic edits need the list revision from get_event_logic. IDs are never renumbered.",
        "Resolve database references by name with database_resolve_reference instead of guessing IDs; pick new switches/variables with list_switches/list_variables onlyFree=true.",
        "Only set allowScript=true when the user explicitly asked for JavaScript.",
      ].join("\n"),
    },
  );
  registerProjectTools(server, ctx);
  registerEventTools(server, ctx);
  registerMapTools(server, ctx);
  registerDatabaseTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

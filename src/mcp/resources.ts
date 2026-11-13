import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eventIrReference } from "../eventing/ir/reference-doc.js";
import type { AppContext } from "./context.js";

/** MCP resources: documentation plus project/event context (EVENT_SPEC §1, §6). */
export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    "event-ir-reference",
    "rpgmz://docs/event-ir",
    { title: "Event IR reference", description: "Every Event IR block type, condition and convention", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: eventIrReference() }] }),
  );

  server.registerResource(
    "project-info",
    "rpgmz://project",
    { title: "Active project", description: "Root, versions, write mode and map list of the active project", mimeType: "application/json" },
    async (uri) => {
      const s = ctx.current();
      const data = {
        root: s.project.root,
        engine: s.project.detection.engine,
        editorVersion: s.project.detection.editorVersion,
        writeEnabled: s.project.allowWrite,
        maps: s.events.listMaps(),
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 1) }] };
    },
  );

  server.registerResource(
    "map",
    new ResourceTemplate("rpgmz://maps/{mapId}", {
      list: async () => {
        try {
          return { resources: ctx.current().events.listMaps().map((m) => ({ uri: `rpgmz://maps/${String(m.mapId)}`, name: `Map ${String(m.mapId)}: ${String(m.name)}`, mimeType: "application/json" })) };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { title: "Map summary", description: "Map metadata and event summaries", mimeType: "application/json" },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx.current().events.mapSummary(Number(vars.mapId)), null, 1) }] }),
  );

  server.registerResource(
    "map-event",
    new ResourceTemplate("rpgmz://maps/{mapId}/events/{eventId}", { list: undefined }),
    { title: "Map event description", description: "Readable description of an event and all its pages", mimeType: "text/plain" },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: ctx.current().events.describeEvent(Number(vars.mapId), Number(vars.eventId)) }] }),
  );

  server.registerResource(
    "common-event",
    new ResourceTemplate("rpgmz://common-events/{commonEventId}", { list: undefined }),
    { title: "Common event", description: "Common event description", mimeType: "application/json" },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx.current().events.getCommonEvent(Number(vars.commonEventId), false), null, 1) }] }),
  );

  server.registerResource(
    "database-record",
    new ResourceTemplate("rpgmz://database/{category}/{id}", { list: undefined }),
    { title: "Database record", description: "Normalized database record", mimeType: "application/json" },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx.current().db.getRecord(String(vars.category), Number(vars.id), false), null, 1) }] }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Point } from "../../maps/map-grid.js";
import type { AssumedState } from "../../maps/map-model.js";
import type { MapService, PointOrEvent } from "../../maps/map-service.js";
import { McpError } from "../../project/errors.js";
import type { AppContext } from "../context.js";
import { handler } from "../tool-helpers.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const point = z.object({ x: z.number().int(), y: z.number().int() });
const pointOrEvent = z
  .object({ x: z.number().int().optional(), y: z.number().int().optional(), eventId: z.number().int().optional() })
  .describe("{x, y} or {eventId} (the event's position)");
const region = z
  .object({ x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(), width: z.number().int().min(1).optional(), height: z.number().int().min(1).optional() })
  .describe("Map cells to cover (default: whole map)");
const assume = z
  .object({
    switchesOn: z.array(z.number().int()).optional(),
    selfSwitchesOn: z.array(z.string()).optional().describe('e.g. ["12:A"] = event 12 self switch A'),
    variables: z.record(z.string(), z.number()).optional().describe('e.g. {"5": 3}'),
  })
  .optional()
  .describe("Game state used to pick each event's active page. Default: all switches/self switches OFF, variables 0, no items.");
const ignoreEvents = z.boolean().optional().describe("Ignore events (tiles only). Default false: blocking events count as obstacles.");
const ignoreEventIds = z.array(z.number().int()).optional().describe("Events that never block (e.g. NPCs that will have moved away)");

/** Text block + JSON, without repeating large text sections inside the JSON text. */
function result(summary: string, textBlocks: string[], data: Record<string, unknown>, textOmit: string[] = []): CallToolResult {
  const payload = { success: true, ...data };
  const forText: Record<string, unknown> = { success: true };
  for (const [k, v] of Object.entries(data)) if (!textOmit.includes(k)) forText[k] = v;
  let json = JSON.stringify(forText, null, 1);
  if (json.length > 60_000) json = `${json.slice(0, 60_000)}\n… (truncated; narrow the region or the include list)`;
  return { content: [{ type: "text", text: [summary, ...(textBlocks.length ? ["", ...textBlocks] : []), "", json].join("\n") }], structuredContent: payload };
}

export function registerMapTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "render_map",
    {
      title: "Render map image",
      description:
        "PNG image of a map (or a region) as the game draws it: tile layers with real autotiles, shadows, event sprites, plus a coordinate grid with x/y axis labels, event id boxes (colored by trigger), the player start (S) and transfer arrivals (T). Overlays: passability (blocked cells + walls), reachable (from the player start, a transfer arrival or reachableFrom), regions. Use it to understand the layout before placing events; use get_map_passability for exact walkability.",
      inputSchema: {
        mapId: z.number().int(),
        region: region.optional(),
        scale: z.number().min(0.05).max(2).optional().describe("Pixels per tile = tileSize x scale. Default: fit the longest side in about 1024 px"),
        grid: z.boolean().optional().describe("Cell grid and axis labels (default true)"),
        events: z.enum(["sprites", "markers", "none"]).optional().describe("sprites (default) = character graphics + id boxes, markers = id boxes only"),
        overlay: z.enum(["none", "passability", "reachable", "regions"]).optional(),
        reachableFrom: pointOrEvent.optional().describe("Origin for overlay=reachable (default: player start or first transfer arrival)"),
        assume,
        ignoreEvents,
      },
      annotations: RO,
    },
    handler((a: Parameters<MapService["render"]>[0]) => {
      const r = ctx.current().maps.render(a);
      return {
        content: [
          { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: r.summary.join("\n") },
        ],
        structuredContent: { success: true, ...r.data, summary: r.summary },
      };
    }),
  );

  server.registerTool(
    "get_map_passability",
    {
      title: "Map passability grid",
      description:
        "Text map of where the player can walk, using the engine's exact passage rules (directional tile bits, star tiles, wall tops, counters, blocking events). Returns an ASCII grid (2 characters per cell: walls drawn between cells), reachability from an origin (default: player start or the first transfer arrival), the separate walkable areas, and every event with its active page and whether the player can trigger it. Works without image support.",
      inputSchema: {
        mapId: z.number().int(),
        from: pointOrEvent.optional().describe("Reachability origin (default: player start on this map, else the first transfer arrival)"),
        region: region.optional(),
        include: z.array(z.enum(["grid", "areas", "events", "cells"])).optional().describe('Default ["grid","areas","events"]; "cells" lists ladders, bushes, counters, damage floors, terrain tags and regions'),
        assume,
        ignoreEvents,
        ignoreEventIds,
      },
      annotations: RO,
    },
    handler((a: Parameters<MapService["passability"]>[0]) => {
      const r = ctx.current().maps.passability(a);
      const d = r.data;
      const summary = `Map ${String(d.mapId)} [${String(d.name)}] ${String(d.width)}x${String(d.height)}${d.reachableCells !== undefined ? `: ${String(d.reachableCells)} cell(s) reachable from (${(d.origin as { x: number }).x},${(d.origin as { y: number }).y})` : ": no origin (no player start or transfer into this map; pass from)"}.`;
      return result(summary, r.text, d, ["grid"]);
    }),
  );

  server.registerTool(
    "get_tile_info",
    {
      title: "Tile info",
      description:
        "Facts about one or more cells: tile ids per layer (sheet, autotile kind/shape, flags), blocked sides, exits, shadow, region, terrain tag, ladder/bush/counter/damage, events on it, reachability, and `free` (exit + no event + reachable): use it to check spots before placing NPCs or transfer destinations.",
      inputSchema: {
        mapId: z.number().int(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        positions: z.array(point).max(100).optional().describe("Several cells at once (instead of x/y)"),
        from: pointOrEvent.optional().describe("Reachability origin (default: player start or first transfer arrival)"),
        assume,
        ignoreEvents,
      },
      annotations: RO,
    },
    handler((a: { mapId: number; x?: number; y?: number; positions?: Point[]; from?: PointOrEvent; assume?: AssumedState; ignoreEvents?: boolean }) => {
      const positions = a.positions?.length ? a.positions : a.x !== undefined && a.y !== undefined ? [{ x: a.x, y: a.y }] : [];
      if (!positions.length) throw new McpError("INVALID_INPUT", "Give x and y, or positions.");
      const r = ctx.current().maps.tileInfo({ ...a, positions });
      const cells = r.cells as { x: number; y: number; free?: boolean }[];
      return result(`Map ${a.mapId}: ${cells.map((c) => `(${c.x},${c.y}) ${c.free ? "free" : "not free"}`).join(", ")}`, [], r);
    }),
  );

  server.registerTool(
    "find_path",
    {
      title: "Find walking path",
      description:
        "Shortest walking route between two cells using the engine's passage rules. Returns route command names (move_up, ...) and a ready-to-use set_movement_route block. With from={eventId} the event is the mover (blocked by any non-through event). adjacent=true (default when `to` is an event) stops next to the target and turns to face it.",
      inputSchema: {
        mapId: z.number().int(),
        from: pointOrEvent,
        to: pointOrEvent,
        adjacent: z.boolean().optional(),
        assume,
        ignoreEvents,
        ignoreEventIds,
      },
      annotations: RO,
    },
    handler((a: Parameters<MapService["findPath"]>[0]) => {
      const r = ctx.current().maps.findPath(a);
      const grid = (r.grid as string[] | undefined) ?? [];
      return result(r.found ? `Path found: ${String(r.steps)} step(s): ${String(r.summary)}` : `No path: ${String(r.message)}`, grid, r, ["grid"]);
    }),
  );
}

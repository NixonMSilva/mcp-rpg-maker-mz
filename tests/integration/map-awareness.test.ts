import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ListTarget } from "../../src/eventing/targets.js";
import { MapService } from "../../src/maps/map-service.js";
import { loadMap } from "../../src/maps/map-model.js";
import { decodePng } from "../../src/maps/png.js";
import { FLOOR_AUTOTILE_TABLE, WALL_AUTOTILE_TABLE, WATERFALL_AUTOTILE_TABLE } from "../../src/maps/tiles.js";
import { projectView } from "../../src/references/reference-resolver.js";
import { checkStartPosition, MapCache } from "../../src/validation/map-validator.js";
import { FIXTURE_ROOT, session, tempProject } from "../helpers/fixture.js";
import { realDataDirs } from "../helpers/real-projects.js";

const LAB = 3;
const page = (eventId: number, pageIndex = 0): ListTarget => ({ kind: "map_event_page", mapId: LAB, eventId, pageIndex });

function lab(assume = {}) {
  const s = session(FIXTURE_ROOT, false);
  const m = loadMap(projectView(s.project), LAB, assume)!;
  return { s, m, g: m.grid };
}

describe("autotile shape tables", () => {
  it("have the engine's sizes and the single-tile preview shape", () => {
    expect(FLOOR_AUTOTILE_TABLE).toHaveLength(48);
    expect(WALL_AUTOTILE_TABLE).toHaveLength(16);
    expect(WATERFALL_AUTOTILE_TABLE).toHaveLength(4);
    expect(FLOOR_AUTOTILE_TABLE[47]).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
    expect(FLOOR_AUTOTILE_TABLE[0]).toEqual([[2, 4], [1, 4], [2, 3], [1, 3]]);
    expect(FLOOR_AUTOTILE_TABLE[46]).toEqual([[0, 2], [3, 2], [0, 5], [3, 5]]);
  });

  // Local only: compares the derived tables with rmmz_core.js of a configured real project.
  const core = realDataDirs()
    .map((d) => path.join(d, "..", "js", "rmmz_core.js"))
    .find((f) => fs.existsSync(f));
  it.skipIf(!core)("match the tables in a real rmmz_core.js", () => {
    const src = fs.readFileSync(core!, "utf8");
    const grab = (name: string) => {
      const i = src.indexOf(`Tilemap.${name} = `);
      return JSON.parse(src.slice(src.indexOf("[", i), src.indexOf("];", i) + 1)) as unknown;
    };
    expect(FLOOR_AUTOTILE_TABLE).toEqual(grab("FLOOR_AUTOTILE_TABLE"));
    expect(WALL_AUTOTILE_TABLE).toEqual(grab("WALL_AUTOTILE_TABLE"));
    expect(WATERFALL_AUTOTILE_TABLE).toEqual(grab("WATERFALL_AUTOTILE_TABLE"));
  });
});

describe("passability model (fixture map 3)", () => {
  it("applies directional bits, star tiles, tile events and counters like the engine", () => {
    const { g } = lab();
    expect(g.tileExits(0, 0)).toEqual([]); // wall top
    expect(g.edgeOpen(2, 1, 2)).toBe(false); // fence: north side of (2,2) closed...
    expect(g.edgeOpen(2, 2, 8)).toBe(false); // ...in both directions (symmetric)
    expect(g.edgeOpen(2, 2, 4)).toBe(true); // other sides open
    expect(g.tileExits(3, 4).length).toBeGreaterThan(0); // star decoration over floor stays walkable
    expect(g.tileExits(7, 4)).toEqual([]); // tile event (B wall tile, below characters) blocks
    expect(g.tileExits(6, 7)).toEqual([]); // water
    expect(g.isCounter(8, 2)).toBe(true);
    expect(g.isLadder(9, 7)).toBe(true);
    expect(g.isBush(7, 7)).toBe(true);
    expect(g.isDamageFloor(8, 7)).toBe(true);
    expect(g.terrainTag(8, 7)).toBe(3);
    expect(g.regionId(10, 1)).toBe(7);
    // The action button reaches the clerk across the counter.
    const clerk = g.events.find((e) => e.id === 2)!;
    expect(g.interactionCells(clerk, 0)).toContainEqual({ x: 8, y: 3 });
  });

  it("computes reachability with blocking events and an assumed game state", () => {
    const initial = lab().g;
    const d0 = initial.distances([{ x: 1, y: 3 }]);
    expect(d0[initial.index(4, 4)]).toBeGreaterThan(0);
    expect(d0[initial.index(6, 3)]).toBe(-1); // guard blocks the doorway
    expect(d0[initial.index(1, 6)]).toBe(-1); // closed room
    const opened = lab({ switchesOn: [1] }).g;
    const d1 = opened.distances([{ x: 1, y: 3 }]);
    expect(d1[opened.index(10, 7)]).toBeGreaterThan(0);
    expect(d1[opened.index(1, 6)]).toBe(-1);
    expect(initial.distances([{ x: 1, y: 3 }], { ignoreEvents: true })[initial.index(6, 3)]).toBeGreaterThan(0);
  });

  it("reports grid, areas, events and special cells", () => {
    const s = session(FIXTURE_ROOT, false);
    const ms = new MapService(s.project);
    const r = ms.passability({ mapId: LAB, include: ["grid", "areas", "events", "cells"] });
    const grid = r.data.grid as string[];
    expect(grid.find((l) => l.startsWith("3 "))).toBe("3  # T . . . E o o o o o #");
    expect(grid).toContain("      +-+"); // fence wall between rows 1 and 2
    expect(r.data.reachableCells).toBe(16);
    const events = r.data.events as { id: number; playerCanTrigger?: boolean; blocksPlayer: boolean }[];
    expect(events.find((e) => e.id === 1)).toMatchObject({ blocksPlayer: true, playerCanTrigger: true });
    expect(events.find((e) => e.id === 2)!.playerCanTrigger).toBe(false);
    expect(events.find((e) => e.id === 3)!.playerCanTrigger).toBe(false);
    const areas = r.data.walkableAreas as { size: number; containsOrigin: boolean }[];
    expect(areas.map((a) => a.size)).toEqual([30, 16, 7]);
    expect((r.data.specialCells as { counter: unknown[] }).counter).toEqual([{ x: 8, y: 2 }]);
  });

  it("finds paths and builds a movement route that faces the target", () => {
    const ms = new MapService(session(FIXTURE_ROOT, false).project);
    const blocked = ms.findPath({ mapId: LAB, from: { x: 1, y: 3 }, to: { eventId: 2 } });
    expect(blocked.found).toBe(false);
    const p = ms.findPath({ mapId: LAB, from: { x: 1, y: 3 }, to: { eventId: 2 }, assume: { switchesOn: [1] } });
    expect(p).toMatchObject({ found: true, steps: 8, stopsAt: { x: 7, y: 1 }, facing: "right" });
    expect(p.commands).toEqual(["move_right", "move_right", "move_right", "move_right", "move_right", "move_right", "move_up", "move_up", "turn_right"]);
    expect((p.routeBlock as { character: number }).character).toBe(-1);
    // An event as the mover is blocked by every non-through event, including below-priority ones.
    const ev = ms.findPath({ mapId: LAB, from: { eventId: 5 }, to: { x: 7, y: 5 }, adjacent: false });
    expect(ev).toMatchObject({ found: true, mover: "event 5", steps: 2 });
  });

  it("describes tiles and whether a spot is free", () => {
    const ms = new MapService(session(FIXTURE_ROOT, false).project);
    const r = ms.tileInfo({ mapId: LAB, positions: [{ x: 2, y: 3 }, { x: 8, y: 2 }, { x: 8, y: 4 }, { x: 99, y: 0 }] });
    const cells = r.cells as Record<string, unknown>[];
    expect(cells[0]).toMatchObject({ free: true, reachable: true });
    expect(cells[1]).toMatchObject({ counter: true, free: false });
    expect((cells[1]!.layers as { description: string }[])[1]!.description).toBe("A2 floor autotile kind 17, shape 0");
    expect(cells[2]).toMatchObject({ free: false, notFreeBecause: [expect.stringContaining("not reachable")] });
    expect(cells[3]!.error).toContain("outside");
  });
});

describe("render_map", () => {
  const pixel = (img: { width: number; data: Uint8Array }, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

  it("composes autotile quarters, shadows and star tiles from the tileset sheets", () => {
    const ms = new MapService(session(FIXTURE_ROOT, false).project);
    const r = ms.render({ mapId: LAB, scale: 1, grid: false, events: "none" });
    const img = decodePng(r.png);
    expect([img.width, img.height]).toEqual([12 * 48, 9 * 48]);
    expect(r.data.problems).toEqual([]);
    // Floor (A2 kind 16, shape 0): TL quarter comes from quarter (2,4), TR from (1,4) of the sheet.
    expect(pixel(img, 48 + 5, 48 + 5)).toEqual([16, 92, 40, 255]);
    expect(pixel(img, 48 + 30, 48 + 5)).toEqual([8, 92, 40, 255]);
    // Shadow bits 0b0101 on (6,1): left half darkened, right half not.
    expect(pixel(img, 6 * 48 + 5, 48 + 5)).toEqual([8, 46, 20, 255]);
    expect(pixel(img, 6 * 48 + 30, 48 + 5)).toEqual([8, 92, 40, 255]);
    // Star tile B 2 at (3,4): drawn on top (B sheet colors: col*16, row*16, 220).
    expect(pixel(img, 3 * 48 + 20, 4 * 48 + 20)).toEqual([32, 0, 220, 255]);
  });

  it("is stable (golden pixel hashes at scale 1 and 0.5)", () => {
    const ms = new MapService(session(FIXTURE_ROOT, false).project);
    const hash = (scale: number) => crypto.createHash("sha256").update(decodePng(ms.render({ mapId: LAB, scale, overlay: "passability" }).png).data).digest("hex").slice(0, 16);
    expect({ full: hash(1), half: hash(0.5) }).toEqual({ full: "0c661549ecdbc482", half: "49c19b2570186bbe" });
  });

  it("draws missing images as magenta and reports them", () => {
    const root = tempProject();
    fs.rmSync(path.join(root, "img", "tilesets", "Fix_A2.png"));
    const ms = new MapService(session(root, false).project);
    const r = ms.render({ mapId: LAB, scale: 1, grid: false, events: "none" });
    expect((r.data.problems as string[]).join(" ")).toContain("img/tilesets/Fix_A2.png");
    expect(pixel(decodePng(r.png), 48 + 5, 48 + 5)).toEqual([255, 0, 255, 255]);
  });
});

describe("map-aware validation", () => {
  it("warns about transfers onto blocked cells and notes transfers onto events", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.events.editLogic(ws, page(1), { op: "append", blocks: [{ type: "transfer_player", mapId: LAB, x: 0, y: 0 }, { type: "transfer_player", mapId: LAB, x: 8, y: 1 }] });
    const cs = s.tx.stage(ws, "transfers");
    const codes = cs.diagnostics.map((d) => d.code);
    expect(codes).toContain("transfer.destination.blocked");
    expect(codes).toContain("transfer.destination.occupied");
  });

  it("warns when a waiting, non-skippable movement route walks into a wall", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.events.editLogic(ws, page(2), {
      op: "append",
      blocks: [
        { type: "set_movement_route", character: 0, wait: true, commands: ["move_left", "move_left"] }, // (8,1) -> (6,1): fine
        { type: "set_movement_route", character: 0, wait: true, commands: ["move_up"] }, // (6,1) -> wall
        { type: "set_movement_route", character: 0, wait: true, skippable: true, commands: ["move_up"] }, // skippable: no warning
      ],
    });
    const cs = s.tx.stage(ws, "routes");
    const route = cs.diagnostics.filter((d) => d.code === "route.blocked");
    expect(route).toHaveLength(1);
    expect(route[0]!.message).toContain("from (6,1)");
  });

  it("notes action-button events nobody can reach", () => {
    const s = session(FIXTURE_ROOT, false);
    const diags = s.events.validateMap(LAB).filter((d) => d.code === "event.unreachable");
    expect(diags.map((d) => d.location)).toEqual(["Map 3 / Event 3 [Hidden] / Page 1"]);
  });

  it("checks the player start position", () => {
    const s = session(FIXTURE_ROOT, false);
    const base = projectView(s.project);
    const withStart = (x: number, y: number) => ({ json: (rel: string) => (rel === "data/System.json" ? { ...(base.json(rel) as object), startMapId: LAB, startX: x, startY: y } : base.json(rel)) });
    const v1 = withStart(17, 12);
    expect(checkStartPosition(v1, new MapCache(v1)).map((d) => d.code)).toEqual(["system.start.out_of_bounds"]);
    const v2 = withStart(0, 0);
    expect(checkStartPosition(v2, new MapCache(v2)).map((d) => d.code)).toEqual(["system.start.blocked"]);
    const v3 = withStart(1, 1);
    expect(checkStartPosition(v3, new MapCache(v3))).toEqual([]);
    // A blocked start on a map with an autorun event (typical "blank start map that transfers away") is only info.
    const map3 = base.json("data/Map003.json") as { events: ({ pages: { trigger: number }[] } | null)[] };
    const withAutorun = { ...map3, events: map3.events.map((e, i) => (e && i === 5 ? { ...e, pages: e.pages.map((p) => ({ ...p, trigger: 3 })) } : e)) };
    const v4 = { json: (rel: string) => (rel === "data/Map003.json" ? withAutorun : v2.json(rel)) };
    expect(checkStartPosition(v4, new MapCache(v4)).map((d) => d.severity)).toEqual(["info"]);
  });
});

---
name: map-placement
description: Choose where to place or move things on an RPG Maker MZ map (NPCs, chests, doors, transfer destinations, walking routes) by looking at the map with render_map, get_map_passability, get_tile_info and find_path. Use before creating or moving any map event, when picking a transfer destination, or when writing a movement route.
---

# Map-aware placement

Never guess coordinates. Look at the map, check the exact cell, and confirm the result.

## 1. See the map

- `get_map_summary { mapId }` gives the size, the tileset and the existing events with their positions.
- `render_map { mapId }` returns a PNG with an x/y grid, event id boxes, the player start `S` and transfer arrivals `T`. Useful options:
  - `overlay: "passability"`: blocked cells and walls.
  - `overlay: "reachable"`: what the player can reach from the start or arrival (or from `reachableFrom`).
  - `region: {x, y, width, height}` zooms into an area on large maps.
- Without image support, use `get_map_passability { mapId }`. It returns an ASCII grid (2 characters per cell, walls drawn between cells),
  the separate walkable areas, and every event with its active page and whether the player can trigger it.

## 2. Check candidate cells

`get_tile_info { mapId, positions: [{x,y}, ...] }` checks up to 100 cells per call. Pick cells with `free: true`, which means the
cell is passable, has no event and is reachable. Also look at `region`, `terrainTag`, `bush`, `counter` and `damage` when they matter. A
shopkeeper, for example, stands behind a counter cell.

Placement guidelines:
- Don't put a `priority: "same"` event (NPC, chest) on a 1-tile-wide corridor or doorway, because it blocks the path. After previewing,
  re-run `get_map_passability` and confirm the walkable areas and reachable cell count didn't shrink unexpectedly.
- Action-button events must have a reachable, passable cell next to them on a side the player can face.
- Counters: the player can talk across a counter tile, so an NPC behind a counter is fine.

## 3. Transfers

For a `transfer_player` or `door` destination, run `get_tile_info` on the **destination map** cell. It must be free and reachable.
Don't land the player on, or right next to, a `player_touch` transfer on the destination, or the player bounces straight
back. Arrive one step inside the room, facing away from the exit (`direction`).

## 4. Movement routes

`find_path { mapId, from, to, adjacent? }` returns route commands and a ready-made `set_movement_route` block:
- `from: { eventId }` makes that event the mover, blocked by other non-through events. `from: {x, y}` is a plain cell, for example the
  player's position in a cutscene.
- `to: { eventId }` stops next to the target and turns to face it (`adjacent` defaults to true for events).
- Use the returned block with `character: -1` / `"player"` for the player, or the event id.

## 5. Game state

By default, analysis assumes all switches and self switches OFF, variables 0 and no items. To check a later situation, pass
`assume: { switchesOn: [12], selfSwitchesOn: ["7:A"], variables: { "5": 2 } }`, for example "after the gate opens" or "quest
stage 2". `ignoreEventIds` treats NPCs that will have moved away as non-blocking. `ignoreEvents: true` checks tiles only.

## Limits to keep in mind

Analysis models one game state at a time. Arrivals through variable-based transfers, plugin teleports or scripts are not
seen. Randomly moving NPCs count as standing on their start cell. Renders show a static frame (no parallax, pictures, weather or plugin
graphics). When a result depends on one of these, say so to the user.

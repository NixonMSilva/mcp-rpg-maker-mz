# Proposal: map awareness tools (+ friction from the first real authoring session)

Status: map awareness tools and validation hooks implemented (2026-11-13), see "Implementation notes"; friction items
F1-F8 still open. Source: eventing the *Coalescence Protocol* prologue on MCPTest
(2 maps, 11 events, 1 change set) on 2026-11-13.

## Problem

The server describes a map's *metadata* (size, tileset, events) but nothing about its **layout**. To place events,
the agent had to know where the bed, front door, walls and walkable corridors were. With no tool for that, it wrote
two throwaway scripts outside the server:

| Script | What it did | Outcome |
|---|---|---|
| ASCII passability grid (node) | First non-star tile's `flags & 0x0f` per cell | **Misleading**: wall tops counted as walkable, and walls had no direction |
| `render.ps1` (PowerShell + System.Drawing) | Drew layers 0-3 from the tileset sheets, with a coordinate grid and event markers, to a PNG | Good enough to read the layout. Autotiles not joined |
| `reach.mjs` (node) | Flood fill from a start tile, using the engine's directional passage rules | **Most useful**: showed that the laser checkpoint splits the base map in two, and which tiles NPCs can stand on |

Every agent that events an unseen map will hit this gap. The server should provide these as tools.

## Proposed tools (read-only)

### 1. `render_map`
Returns a PNG (MCP `image` content) of a map or a region of it.

```jsonc
{ "mapId": 1,
  "region"?: { "x": 0, "y": 0, "width": 17, "height": 13 },  // default: whole map
  "scale"?: 0.5,             // 48px tiles get large: 31x30 = 1488x1440
  "grid"?: true,             // cell lines + "x,y" labels
  "events"?: "markers" | "sprites" | "none",   // markers = box + id
  "overlay"?: "none" | "passability" | "regions" | "reachable",
  "reachableFrom"?: { "x": 15, "y": 28 } }
```

Implementation notes:
- **No native deps.** Node's `zlib` is enough for a small PNG decoder (8-bit RGBA/RGB/palette, all 5 filter types) and
  an encoder. That is about 150-200 lines. Avoid `canvas`/`sharp` because of Windows build pain.
- Tile ID → sheet/source rect: B-E `0-1023`, A5 `1536+`, A1 `2048+`, A2 `2816+`, A3 `4352+`, A4 `5888+`. Mirror
  `Tilemap._drawAutotile` from rmmz_core.js. **Do the real autotile composition** (the 4 quarter-tiles from the shape
  tables, `FLOOR/WALL/WATERFALL_AUTOTILE_TABLE`). The prototype's single-sample shortcut made wall edges unreadable.
- Layer 4 = shadow bits (draw as half-alpha black quarters), layer 5 = regions (only for `overlay: "regions"`).
- Event sprites: crop frame `pattern 1` of the page-1 image (`$` = single character, `!` = no offset). Use tile events'
  `tileId`.
- Missing image files → magenta placeholder + a diagnostic. This also partly covers L9 (asset validation).
- Return a text summary next to the image (legend, scale, region) so clients that can't show images still get something.

### 2. `get_map_passability`
Text and JSON, cheap, works for agents without vision.

```jsonc
{ "mapId": 2, "from"?: { "x": 9, "y": 5 }, "region"?: {...},
  "include"?: ["grid", "reachable", "edges"] }
```
- Directional passage exactly as `Game_Map.checkPassage` (4 bits + star `0x10`, top layer first) **plus** the
  `isPassable` check on the reverse direction for the destination tile. Ladder/bush/counter/damage flags reported per
  cell.
- `grid`: one char per cell (`.` open, `#` blocked, `^v<>` one-way edges, `E` event, `S` start).
- `reachable`: BFS from `from`. Events with `priority: same` and `through: false` block. Option to ignore events.
- Use the same grid for `overlay: "passability"` in `render_map`.

### 3. Small queries (optional, fold in if cheap)
- `is_tile_free { mapId, x, y }`: passable, not occupied by an event, reachable from the map's main entry.
- `find_path { mapId, from, to }` → route commands (`move_up`, ...) usable directly in `set_movement_route`. The
  prologue hand-wrote `move_up ×9, move_right, move_up` for Rotrude. A path tool removes that guesswork.
- `get_tile_info { mapId, x, y }`: tile IDs per layer, sheet + kind, flags, terrain tag, region.

### Validation hooks (once passability exists)
- Warn: transfer destination tile is impassable or unreachable from where events start (`transfer.destination.blocked`).
- Warn: `set_movement_route` with `wait: true` and a fixed path that hits a blocked tile (would hang the cutscene unless
  `skippable`).
- Warn: `System.startX/startY` outside the map or on a blocked tile. **Real case:** MCPTest had start (17,12) on a 17-wide
  map after the user swapped maps.
- Info: event placed on an unreachable tile with an `action_button`/`player_touch` trigger.

## Implementation notes (what shipped)

- Tools: `render_map`, `get_map_passability`, `get_tile_info` (includes the `is_tile_free` verdict as `free`, for one
  cell or up to 100), `find_path` (returns route commands plus a ready `set_movement_route` block; `adjacent` stops next
  to an event and turns to face it). Code in `src/maps/`, tools in `src/mcp/tools/map-tools.ts`.
- **No one-way edges.** Tile passage is symmetric in MZ: A to B checks A's exit bit and B's entry bit, and B to A checks
  the same two bits. So the ASCII grid draws walls *between* cells (`|`, `-`) instead of `^v<>`.
- Reachability defaults to **every arrival point** (player start + direct Transfer Player destinations), not a single
  start. The separate walkable areas are listed, which shows splits like the laser checkpoint.
- Events are evaluated in an **assumed game state** (`assume: {switchesOn, selfSwitchesOn, variables}`) with the
  engine's last-matching-page rule, e.g. "is the south wing reachable once switch N opens the checkpoint?".
- The render uses axis labels (x on top, y on the left) instead of an "x,y" label in every cell, which stays readable
  at small scales and does not hide the tiles.
- Validation codes: `transfer.destination.blocked` (warning), `transfer.destination.occupied` (info),
  `route.blocked` (warning, heuristic), `event.unreachable` (info, heuristic), `system.start.out_of_bounds` and
  `system.start.blocked` (warnings; `get_project_info` reports them too).
- Autotile shape tables are derived from the shape semantics, not copied, and a local-only test checks them against
  `rmmz_core.js`. The fixture gained a synthetic tileset, images and a "Passability Lab" map (Map003).
- First findings on MCPTest: the Studio Apartment's bathroom and kitchen have no doorway (unreachable in game), and the
  base's south half is only reachable through its own transfer arrival.
- Remaining limits: LIMITATIONS.md L28-L31.

## Other friction from the session

| # | Friction | Suggestion |
|---|---|---|
| F1 | Name Input (303) and Change Actor Images (322) had to be `raw_command` | Add IR blocks `name_input {actorId, maxChars}` and `change_actor_images {actorId, face, character, battler}`. Both are core to character creation (L6) |
| F2 | Event IDs of new events are only known after preview. The intro's movement route needed Rotrude's ID before it existed | Allow symbolic refs in a batch: `create_map_event { ..., "ref": "rotrude" }` and `character: {"ref":"rotrude"}` resolved at staging |
| F3 | Message wrapping done by hand in the generator (monospace main font: about 46 chars with a face, 58 without) | `show_text { wrap: true }` → auto-wrap + split into 4-line boxes. Width from the font/face (text codes zero-width, `\N[n]` ≈ name max length). Templates already split, so reuse that code |
| F4 | Same speaker repeated in 70+ `show_text` blocks | Optional `speakers` table per batch (`{ "Oraculum": {face, index} }`) and `show_text { speaker: "Oraculum" }` |
| F5 | String variables (e.g. pronoun words for `\V[n]`) need `script` operands → `allowScript` | Consider a `control_variables` operand `{type:"string", value}` compiling to a script operand flagged as safe-literal. Or document the "numeric variable + conditional" pattern |
| F6 | MCP not registered in the session the user asked from. The agent had to drive `dist/index.js` over stdio with a hand-written SDK client | README: a troubleshooting note, and maybe `rpgmz-mcp doctor` that prints the `.mcp.json` it expects for the cwd |
| F7 | Previews live in server memory (L20), so a one-shot client must preview+apply in the same process | Fine for real MCP clients. Mention it in the README for scripted use, or persist pending sets to the state dir |
| F8 | Which project is open in the editor is unknown (L5). The target maps existed only in an unsaved editor session | `get_project_info`: report `data/` mtime vs `game.rmmzproject` mtime and the running editor. Hint "editor may hold unsaved maps" |

## Suggested order

1. `get_map_passability` (pure logic, easy to test against fixture maps, unblocks validation hooks)
2. F1 IR blocks (small, high value for any intro sequence)
3. `render_map` with the PNG codec + real autotiles (biggest effort; golden-image tests on the fixture's tilesets)
4. F2 symbolic refs, F3 auto-wrap
5. Validation hooks, `find_path`

## Test ideas
- Fixture map with known one-way edges, star tiles over walls, counters and a closed room → assert BFS sets.
- Golden PNG hashes for the fixture map at scale 1 and 0.5 (store small crops, not whole maps).
- Round-trip: the PNG decoder reads every image in the fixture `img/tilesets/` without error.
- Regression for the start-position warning (start outside the map).

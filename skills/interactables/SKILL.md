---
name: interactables
description: Create treasure chests, doors and transfer tiles, levers and switch-controlled gates on RPG Maker MZ maps using the server's event templates. Use for "put a chest with X here", "connect this door to map Y", "add a lever that opens the gate", or similar map objects.
---

# Chests, doors, transfers and levers

Pick every coordinate with the **map-placement** skill, and commit with the **safe-changes** skill. `list_event_templates`
shows the current template parameters.

## Treasure chest

1. Resolve the reward with `database_resolve_reference` (item, weapon or armor). For gold, use `kind: "gold"`.
2. Match existing chests: `search_event_commands { blockType: "change_items", mapId }` shows their graphic and message style.
3. Call `create_event_from_template { template: "treasure_chest", mapId, x, y, params: { reward: { kind, id, amount }, message?,
   characterName?, characterIndex?, selfSwitch? } }`. `reward` may be an array.
4. In the preview, check that page 1 gives the reward and sets the self switch, and that page 2 is conditioned on that self switch, so the chest
   stays open.

## Door or transfer

1. Check the **destination** cell with `get_tile_info { mapId: <destination map>, x, y }`. It must be `free`. Don't arrive on top of
   or next to the return transfer.
2. Call `create_event_from_template { template: "door", mapId, x, y, params: { mapId: <dest>, x: <dx>, y: <dy>, direction?, fade?,
   characterName?, se? } }`.
   - `characterName: ""` creates an invisible `player_touch` transfer tile, for map edges and stairs.
   - Note the name clash: the top-level `mapId/x/y` place the event, and `params.mapId/x/y` set the destination.
3. A two-way connection is two events, one on each map. Preview both in one `preview_changes` batch.
4. After applying, `render_map { mapId: <dest> }` shows the new arrival marker `T`.

## Lever and gate

1. Choose a switch from `list_switches { onlyFree: true }` and name it (`database_update_record { category: "system", patch:
   { "switches.<id>": "Gate open" } }`).
2. Lever: `create_event_from_template { template: "switch_lever", params: { switchId } }` toggles the switch on each use.
3. Gate: a page 1 that blocks (closed graphic, `priority: "same"`), plus a page 2 conditioned on `conditions.switch1: <id>` with the open
   graphic and `through: true`, or no graphic and `priority: "below"`.
4. Check both states with `get_map_passability { mapId, assume: { switchesOn: [<id>] } }`. The area behind the gate should become
   reachable.
5. Put the lever, gate and switch name in one batch.

## Assets

The template defaults (`!Chest`, `!Door1`, `!Switch1`, sound effects `Open1`, `Switch1`) assume the default RTP assets. The server
does not check `img/` or `audio/` for event graphics. `render_map` reports character sheets it couldn't load, so render the
area after previewing, or ask the user which assets the project uses.

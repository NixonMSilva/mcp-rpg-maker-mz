---
name: cutscene
description: Script cutscenes in RPG Maker MZ, meaning one-shot story scenes triggered by stepping on a tile or by autorun on a switch, with dialogue, character movement routes, screen fades, sound, waits and transfers. Use for "when the player enters, X walks up and says…", intros, boss reveals or ending sequences.
---

# Cutscenes

## 1. Choose the trigger

- **Step-on trigger** (`player_touch`): put it on a cell the player must cross. Use `get_map_passability` to find a chokepoint in
  the reachable area. A trigger beside the path can be walked around.
- **Autorun gated by a switch:** use this when the scene starts after something else, such as a transfer or another event. Autorun pages
  freeze player control until they end, so they **must** have a switch condition and must turn themselves off.
- **Parallel** pages run alongside play. Use them for ambience, not for story scenes.

## 2. Write the script

Plan the beats with the user first: who moves where, who says what, and the camera and screen effects. Then write Event IR blocks:

- Movement: `find_path { mapId, from: { eventId }, to: { x, y } | { eventId } }` returns a ready `set_movement_route` block. For the
  player, use `from: { x, y }` (the trigger cell) and `character: "player"`. Keep `wait: true` so steps happen in sequence.
- Pacing: `wait { frames }` (60 = 1 s), `show_balloon`, `play_animation`.
- Screen: `fadeout_screen` / `fadein_screen`, `tint_screen`, `flash_screen`, `shake_screen`.
- Audio: `save_bgm`, `play_bgm`, `play_se`, then `resume_bgm`.
- Ending: `transfer_player`, `change_party_member`, `control_switches` to unlock the next story state.

Pictures, weather, scroll map and timers are not editable IR blocks. They can only exist as preserved `raw_command` blocks.
Tell the user to add those in the editor, or reuse an existing raw block they point to.

## 3. Build it

`create_event_from_template { template: "cutscene_trigger", mapId, x, y, params: { blocks, trigger?: "player_touch" | "autorun",
conditionSwitchId? (required for autorun), selfSwitch?: "A" } }` runs the blocks once, then disables itself with the self switch.

For a scene that lives in a common event (reused across maps), edit the common event with `append_event_blocks { commonEventId }`
and call it with `call_common_event`.

## 4. Check it

- `analyze_event_flow` flags autorun pages that never end and switches that are set but never read.
- Check the state after the scene: `get_map_passability { assume: { switchesOn: [...], selfSwitchesOn: ["<eventId>:A"] } }`.
  NPCs that walked in shouldn't block the exit. If they leave, use `ignoreEventIds`.
- Movement routes are only simulated for fixed commands. Random or toward-player moves, and routes inside branches, make positions
  unknown. Mention this when it applies.

Commit with the **safe-changes** skill, then walk the user through the scene beat by beat with `describe_event_page`.

---
name: project-audit
description: Health-check an RPG Maker MZ project or map (broken references, invalid events, logic problems, unreachable areas, bad transfers, database errors) and report findings without changing anything. Use for "check my project for bugs", "audit map 5", "why isn't this event triggering?", or before a release or playtest.
---

# Project audit

An audit only reads. Report findings and propose fixes. Apply them only when the user asks, through the **safe-changes** skill.

## Whole project

1. `get_project_info`: check its `warnings`, for example a player start on a blocked or missing tile.
2. `validate_project_references { scope: "all" }` finds dangling and blank references across events, common events, troops and the database,
   plus common-event call cycles. It separates invalid references from unresolvable ones.
3. `database_validate_category { category }` for each category that has records (`database_list_categories`) reports record errors and
   design diagnostics.
4. Each map, or the ones the user cares about (`list_maps`), gets the per-map pass below.

## Per map

- `validate_map_events { mapId }` checks structure, settings, references, positions and page shadowing.
- `analyze_event_flow { mapId, scope: "map" }` is heuristic. It finds unreachable blocks, contradictory conditions, loops without exit,
  autorun pages that never end, unused self switches, and switches set but never read.
- `get_map_passability { mapId }` finds:
  - several walkable areas where only one is expected (sealed-off rooms),
  - events the player can't trigger (no reachable adjacent cell),
  - transfer arrivals on blocked cells.
  Repeat with `assume` for important story states, such as switches ON after the main quest.
- `render_map { mapId, overlay: "reachable" }` shows the same thing visually, and lists tileset or character images that failed to load.

## "Why doesn't this event trigger?"

1. `describe_map_event` and `get_map_event` show the page conditions. Is a later page with met conditions shadowing it?
2. `get_map_passability { mapId, assume: <the state the user is in> }`, in the events section, shows the active page and whether the player
   can trigger it.
3. Check the trigger and priority. An `action_button` event with `priority: "below"` under a solid tile, or a `player_touch`
   event on an unreachable cell, never fires.
4. `trace_event_dependencies` and `find_references` show whether the switch or variable it waits for is ever set.

## Report

Group the findings by severity (errors, then warnings, then heuristics/info), each with a location in editor terms and a proposed fix. Label
heuristic findings as such. Mention what the audit can't see: asset files referenced by events aren't checked, analysis
uses one game state at a time, and transfers through variables, plugin teleports and scripts are invisible.

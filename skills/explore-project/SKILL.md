---
name: explore-project
description: Get oriented in an RPG Maker MZ project and explain how it works (maps, events, common events, switches/variables, plugins, database) through the rpgmaker-mz MCP server. Use at the start of a session, when the user asks "how does X work?", "what does this event do?" or "where is Y?", or before planning larger changes.
---

# Exploring and explaining a project

Everything here is read-only. Explain what you found, then offer changes.

## Orientation (start of a session)

1. `get_project_info` returns the root, the MZ version, `writeEnabled`, the player start, the plugin count and the core conventions (zero-based
   `pageIndex`, highest page wins). If several projects are configured, use `list_projects` and `select_project`.
2. `list_maps` shows the map tree (IDs, names, parents). Maps are addressed by ID, never by display name.
3. `list_common_events`, `list_plugins { enabledOnly: true }` and `database_list_categories` give a sense of scale and which systems exist.
4. `list_switches` and `list_variables` show names and usage counts. Named switches and variables reveal the game's story flags and systems.

## Explaining a map

- `get_map_summary { mapId }`, then `render_map { mapId }` for a picture with event ids, the start and arrivals. Without image support, use
  `get_map_passability`.
- Group the events by role: NPCs, transfers, chests, cutscenes, parallel processes.
- Transfers show how maps connect. `search_event_commands { blockType: "transfer_player", mapId }` lists them.

## Explaining an event or system

- `describe_map_event { mapId, eventId }` describes all pages and which one wins under which conditions. Translate that into
  plain language ("before switch 12 is ON he warns you; after it he thanks you").
- `trace_event_dependencies { mapId, eventId, pageIndex, followCommonEvents: true }` lists every switch, variable, item, common event and map
  the page touches, with names.
- `find_references { refKind, id }` answers "who else reads or writes this flag?" Together, these two reconstruct a quest or story
  state machine across maps.
- `get_common_event { commonEventId, detailed }` covers shared logic. `get_plugin_commands { pluginName }` shows what a plugin's commands do.
- For database questions, use `database_get_record`, `database_search_records { text }` and `database_find_references`.

## Answering "where is…"

- `search_event_commands { text }` finds dialogue lines, `{ blockType }` finds command types, and `{ refKind, refId }` finds uses of an ID.
- `database_search_records { text, fields: ["name", "note", "description", "meta"] }` searches the database.

## Presenting

Use editor terms: map name and ID, event name and ID, and "Page N" (= pageIndex + 1). Give the user a short summary, then details on request. Say
when something is opaque, such as `raw_command` blocks, `native` conditions or script text, rather than guessing what it does.
Resources (`rpgmz://project`, `rpgmz://maps/{mapId}`, `rpgmz://maps/{mapId}/events/{eventId}`, `rpgmz://docs/event-ir`)
provide the same data for clients that prefer resources.

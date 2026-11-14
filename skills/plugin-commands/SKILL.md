---
name: plugin-commands
description: Add or edit plugin commands in RPG Maker MZ events using the command schemas declared by installed plugins. Use when the user wants an event to call a plugin feature (quest log, camera, message, battle-system or VisuStella-style commands), or asks what commands a plugin offers.
---

# Plugin commands

## 1. Confirm the plugin

- `list_plugins { enabledOnly: true }` shows whether the plugin is installed **and enabled**, along with its configured parameters.
- `get_plugin_commands { pluginName }` lists the commands and arguments declared in the plugin's annotation header (`@command`, `@arg`, types,
  defaults, options). The file is read as text and never executed.

Never invent command or argument names. If the plugin declares nothing that fits, tell the user.

## 2. Copy real usage

`search_event_commands { blockType: "plugin_command", text: "<pluginName>" }` finds existing calls in the project. They are the
best reference for argument formats, especially structs and lists.

## 3. Write the block

```json
{ "type": "plugin_command", "pluginName": "QuestLog", "commandName": "AddQuest",
  "commandText": "Add Quest", "args": { "questId": "3", "visible": "true" } }
```

- `args` values are **strings**, exactly as the editor stores them. Numbers, booleans, and JSON-encoded structs and arrays all go in as strings.
- `commandText` is the display label the editor shows. Take it from the header (`@text`).
- `plugin_command_mv { command }` is only for old MV-style plugins that parse a text command.

Add it with `append_event_blocks` or `insert_event_blocks` (see the **edit-event** skill), and commit with the **safe-changes** skill.

## Limits

Schemas are inferred from the default-language header block only. Plugins may accept more than they declare, and there are no
dedicated adapters for popular plugin suites. Validation checks structure, not whether the plugin will accept the values. Suggest a
playtest for anything non-trivial.

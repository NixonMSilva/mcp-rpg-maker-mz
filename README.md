# RPG Maker MZ Authoring MCP

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent inspect, author, validate
and safely modify **RPG Maker MZ** projects. It works with semantic event blocks and typed database records instead of
raw JSON.

- **Eventing**: maps, events, pages, page settings, and an Event IR that compiles to
  native MZ commands. Unsupported commands are preserved exactly.
- **Database**: all database categories with normalized views, patch updates,
  traits/effects/actions/drops collections, note tags, templates, and reference analysis.
- **Shared safety layer**: preview-first change sets, full validation of the resulting state, backups, atomic writes,
  stale-edit detection, a transaction log and rollback.

Supported: RPG Maker MZ 1.x project data (verified on 1.10.0). Node.js 20.10+ to run, 22.12+ to develop and test.
Known limitations: [LIMITATIONS.md](LIMITATIONS.md). Milestone status: [docs/STATUS.md](docs/STATUS.md).

## Install

Requires Node.js 20.10+. Installing compiles the TypeScript automatically (`prepare` script) and puts an `rpgmz-mcp`
command on your PATH, so it doesn't matter where the source code lives.

```bash
# from GitHub
npm install -g github:NixonMSilva/mcp-rpg-maker-mz

# or from a local clone (the command follows your working copy; re-run `npm run build` after changes)
git clone https://github.com/NixonMSilva/mcp-rpg-maker-mz.git
cd mcp-rpg-maker-mz
npm install
npm link
```

To update a GitHub install, run the same `npm install -g github:...` command again.

Run it on a project (read-only by default). `--project` is the project folder, the one that contains `game.rmmzproject`
and `data/`:

```bash
rpgmz-mcp --project "C:/path/to/MyGame"                 # inspect + preview only
rpgmz-mcp --project "C:/path/to/MyGame" --allow-write   # allow committing previews
```

Started by hand, it only waits for an MCP client. Register it with Claude Code instead (below).

| Option | Env var | Meaning |
|---|---|---|
| `--project <path>` (repeatable) | `RPGMZ_PROJECT` (path-delimited) | Project roots; the first is selected at startup |
| `--allow-write` | `RPGMZ_MCP_ALLOW_WRITE=1` | Enable `apply_changes` (otherwise read-only) |
| `--state-dir <rel>` | `RPGMZ_MCP_STATE_DIR` | Backups and transaction log, relative to the project (default `.rpgmz-mcp`) |
| `--allow-any-project` | `RPGMZ_MCP_ALLOW_ANY_PROJECT=1` | Let `select_project` open unconfigured paths (off by default) |

### Claude Code

On Windows, npm commands are `.cmd` shims, so launch them through `cmd /c`:

```powershell
claude mcp add rpgmaker-mz -- cmd /c rpgmz-mcp --project "C:/path/to/MyGame" --allow-write
```

macOS / Linux:

```bash
claude mcp add rpgmaker-mz -- rpgmz-mcp --project "/path/to/MyGame" --allow-write
```

Or add a `.mcp.json` to the folder you open Claude Code in. Use forward slashes or `\\` in JSON paths, and on
macOS/Linux use `"command": "rpgmz-mcp"` without `cmd /c`:

```json
{
  "mcpServers": {
    "rpgmaker-mz": {
      "command": "cmd",
      "args": ["/c", "rpgmz-mcp", "--project", "C:/path/to/MyGame", "--allow-write"]
    }
  }
}
```

Without a global install, point at the built file instead: `node "C:/path/to/repo/dist/index.js" --project ...`.

**Close the project in the RPG Maker MZ editor before applying changes**, or reload it afterwards without saving. The
editor keeps data in memory and overwrites external changes when you save. The server warns when `RPGMZ.exe` is running.

## How an agent uses it

1. `get_project_info` → `list_maps` → `get_map_summary` / `describe_map_event`. To place or move events, look at the
   map first: `render_map` (PNG with coordinates), `get_map_passability` (text grid of where the player can walk),
   `get_tile_info` (is this spot free?) and `find_path` (ready-made movement routes).
2. `get_event_logic` returns the Event IR with block ids and a `revision`. `get_event_ir_reference` documents every block.
3. Edit with `append_event_blocks`, `insert_event_blocks`, `replace_event_block`, `move_event_block`,
   `remove_event_block`, `update_event_page_settings`, `create_map_event`, `create_event_from_template`, and so on.
   Each returns a **change set preview**: semantic diff, native diff, and errors/warnings/info.
4. `apply_changes { changeSetId, acknowledgeWarnings?, confirm? }` commits it with a backup. `rollback_transaction`
   undoes a commit.

For database-aware events, resolve names first (`database_resolve_reference { category: "item", name: "Bronze Key" }`).
Use `preview_changes` to create a record and the event that uses it in **one** atomic change set.

```json
{ "type": "conditional", "condition": { "type": "item", "itemId": 12 },
  "then": [ { "type": "show_text", "text": "The gate opens." }, { "type": "control_switches", "switchId": 4, "value": "on" } ],
  "else": [ { "type": "show_text", "text": "It's locked." } ] }
```

## Tools (75)

| Area | Tools |
|---|---|
| Project | `get_project_info`, `list_projects`, `select_project`, `list_maps`, `get_map_summary`, `list_map_events`, `get_map_event`, `list_common_events`, `get_common_event`, `list_plugins`, `get_plugin_commands`, `list_switches`, `list_variables` |
| Map awareness | `render_map`, `get_map_passability`, `get_tile_info`, `find_path` |
| Event inspection | `get_event_page`, `describe_event_page`, `describe_map_event`, `get_event_logic`, `get_event_page_native`, `search_event_commands`, `trace_event_dependencies`, `find_references`, `get_event_ir_reference`, `list_event_templates` |
| Event writes | `create_map_event`, `update_map_event`, `delete_map_event`, `create_event_page`, `clone_event_page`, `delete_event_page`, `update_event_page_settings`, `reorder_event_pages`, `update_common_event`, `create_event_from_template`, `append_event_blocks`, `insert_event_blocks`, `replace_event_block`, `remove_event_block`, `move_event_block`, `replace_event_logic` |
| Validation | `validate_event_page`, `validate_map_events`, `validate_project_references`, `analyze_event_flow`, `database_validate_category` |
| Database inspection | `database_list_categories`, `database_list_records`, `database_get_record`, `database_search_records`, `database_resolve_reference`, `database_find_references`, `database_compare_records`, `database_list_templates`, `database_describe_schema` |
| Database writes | `database_create_record`, `database_update_record`, `database_duplicate_record`, `database_delete_record`, `database_edit_collection`, `database_edit_note`, `database_set_class_curve` |
| Change sets | `preview_changes`, `preview_event_changes`, `database_preview_changes`, `apply_changes`, `apply_event_changes`, `database_apply_changes`, `get_change_set`, `list_pending_changes`, `discard_changes`, `list_transactions`, `rollback_transaction` |

Resources: `rpgmz://docs/event-ir`, `rpgmz://project`, `rpgmz://maps/{mapId}`, `rpgmz://maps/{mapId}/events/{eventId}`,
`rpgmz://common-events/{id}`, `rpgmz://database/{category}/{id}`.
Prompts: `create_npc_interaction`, `create_quest_npc`, `create_treasure_chest`, `modify_existing_event`,
`give_item_in_event`, `design_database_entry`.

## Safety model

- All file access is confined to the configured project root, with traversal and symlink-escape checks. Only
  `data/*.json` can be written. Plugin and project JavaScript is never executed.
- Writes are previewed and validated against the complete resulting project state. Errors block a write, warnings need
  `acknowledgeWarnings`, and destructive changes need `confirm`.
- Before writing, every base file's content hash is re-checked. If the editor or anything else changed a file, the
  preview is rejected.
- Originals are backed up to `.rpgmz-mcp/backups/<transaction>/`. Files are replaced through temp file + rename, and if a
  multi-file write fails midway, every file is restored.
- IDs are never renumbered. Unknown fields, plugin data, unsupported commands and the editor's exact JSON layout are
  preserved, so an edit changes only the affected line.
- Inserting JavaScript requires `allowScript=true`, which an agent should set only when the user asked for it.

## Development

```bash
npm install      # also builds dist/
npm test
npm run typecheck
```

- `npm test` runs unit, integration and round-trip tests.
- **Real-project round-trip test (optional, read-only).** It is skipped unless you point it at real `data` folders, either
  with `RPGMZ_TEST_DATA_DIRS` (path-delimited) or with a gitignored `tests/real-data.local.json`:
  ```json
  { "dataDirs": ["C:/path/to/MyGame/data", "C:/path/to/RPG Maker MZ/newdata/data"] }
  ```
- `npm run docs` regenerates [docs/EVENT_IR.md](docs/EVENT_IR.md) from the block definitions.
- `tests/fixtures/mz-project` is a small **synthetic** MZ project generated by `tests/fixtures/build-fixture.mjs`. It
  contains no RPG Maker data, only the same native shapes. Re-run the script after changing it.
- Design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Verified native structures:
  [docs/NATIVE_FORMATS.md](docs/NATIVE_FORMATS.md).

## License

[MIT](LICENSE). RPG Maker is a trademark of Gotcha Gotcha Games / KADOKAWA. This project is not affiliated with them and
contains no RPG Maker data or engine code (the test fixture is synthetic).

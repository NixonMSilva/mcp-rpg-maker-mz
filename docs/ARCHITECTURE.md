# Architecture

One MCP server with independent **Eventing** and **Database** modules. They share a single project context, transaction
manager, validation system and reference resolver (DATABASE_SPEC §2, §17).

```text
src/
├── index.ts                      CLI entry (stdio transport, argument parsing)
├── mcp/                          MCP interface layer
│   ├── server.ts                 McpServer creation + instructions
│   ├── context.ts                ServerConfig, AppContext, ProjectSession (one per project root)
│   ├── operations.ts             Registry of ALL write operations (zod schema + workspace handler)
│   ├── tool-helpers.ts           Result conventions, change-set reports, runMutation()
│   ├── tools/project-tools.ts    Project/map/plugin discovery, apply/discard/rollback/log
│   ├── tools/event-tools.ts      Event inspection, validation, analysis, event write tools, batch preview
│   ├── tools/database-tools.ts   Database inspection, validation, database write tools, batch preview
│   ├── tools/map-tools.ts        Map awareness: render_map, get_map_passability, get_tile_info, find_path
│   ├── resources.ts              rpgmz:// resources (IR docs, project, maps, events, records)
│   └── prompts.ts                Workflow prompts (NPC, quest NPC, chest, minimal edit, cross-domain)
├── project/                      Project service (shared infrastructure)
│   ├── project-service.ts        Detection, version, canonical readers for MapInfos/System/CommonEvents/Troops/plugins
│   ├── path-guard.ts             Root confinement, traversal and symlink-escape protection
│   ├── file-manager.ts           Revisioned, stat-validated reads (never writes)
│   ├── mz-json-format.ts         Editor-identical serializer with layout detection
│   ├── transaction-manager.ts    Workspace → staged change set → validated, backed-up, atomic commit; rollback; log
│   ├── json-diff.ts, text-diff.ts Native (JSON path) and semantic (line) diffs
│   └── errors.ts                 Typed error codes
├── adapters/rpg-maker-mz/        Native knowledge, centralized
│   ├── command-catalog.ts        Named command codes, continuation/branch structure, route commands
│   ├── enum-catalog.ts           Every enum with labels/aliases (page, command, database, traits, effects)
│   ├── native-types.ts           Native JSON types + editor-default page
│   ├── plugins-js.ts             js/plugins.js data parser (never executed)
│   └── plugin-header.ts          @command/@arg annotation parser (inferred schemas)
├── eventing/
│   ├── ir/                       Event IR v1: types, block definitions, conditions, containers,
│   │                             parser (verified, lossless), compiler (+ source map), normalizer, describer, docs
│   ├── block-service.ts          Minimal native patches for insert/replace/remove/move/replace-all
│   ├── page-model.ts             Page settings view + patching
│   ├── event-service.ts          Inspection, search, dependency tracing, edit operations on a Workspace
│   ├── targets.ts                Command-list targets: map page | common event | troop page
│   └── templates/                NPC, chest, door, quest NPC, lever, cutscene
├── database/
│   ├── database-catalog.ts       Categories, field specs, collections, blank records, record → references
│   ├── record-views.ts           Normalized views (labels, names, revisions, fingerprints)
│   ├── database-service.ts       Discovery, search, resolve, patch, collections, create/duplicate/delete, validation
│   ├── note-tags.ts              Note tag parsing and targeted edits
│   └── templates.ts              Record templates
├── maps/                         Map awareness (read-only)
│   ├── tiles.ts                  Tile id ranges, flag bits, autotile shape tables (derived), sheet geometry
│   ├── map-grid.ts               Engine passage rules, event blocking, BFS reachability, paths, ASCII grid
│   ├── map-model.ts              Map + tileset loading, active page per assumed game state, start/transfer arrivals
│   ├── map-renderer.ts           Tilemap composition (autotiles, shadows, tables, star tiles, sprites) + overlays
│   ├── raster.ts, png.ts         RGBA canvas with box-filtered scaling and a 3x5 font; dependency-free PNG codec
│   └── map-service.ts            Tool-facing service with an mtime-validated image cache
├── references/                   Shared reference resolver (index, names, inferred script refs)
└── validation/                   Diagnostics model, reference checker, event validator, flow heuristics,
                                  map-aware checks (map-validator.ts), staged-state validators run by every change set
```

## Write pipeline

1. A tool (or one step of a batch) runs an **operation** from `mcp/operations.ts` against a `Workspace`, which holds
   cloned, in-memory copies of the files it touches.
2. `TransactionManager.stage()` serializes each touched file in its detected layout, re-parses it, and computes native and
   semantic diffs. It then runs the registered validators against the **complete staged state**: changed events, pages
   and records are re-validated, and deleted or blanked records/events get reverse-reference checks.
3. The change set is stored with its base file revisions (content hashes). Nothing is written yet.
4. `apply()` checks write mode, errors, warning acknowledgement and destructive confirmation. It then re-hashes every
   base file (stale check), takes a lock file, backs up the originals, and replaces each file through a temp file plus
   rename. If any file fails, every file already written is restored. Each attempt is recorded in
   `<root>/.rpgmz-mcp/transactions.jsonl`.
5. `rollback_transaction` stages the backup contents as a new destructive change set. It is refused if the files changed
   after the transaction.

## Deviations from the spec layouts (intentional)

- The two specs propose slightly different source trees. The implementation follows DATABASE_SPEC §2.2 (the unified
  layout), with Event IR code under `eventing/ir/` and MZ adapters under `adapters/rpg-maker-mz/`.
- There is no separate `native-command-parser` and `native-command-compiler`: `eventing/ir/parser.ts` and `compiler.ts`
  hold all native framing, and the per-command encodings live in `eventing/ir/blocks.ts`. Numeric codes appear only in
  the command catalog and the block definitions.
- `preview_event_changes` and `database_preview_changes` accept **any** registered operation, so a database record and
  the event that uses it can commit atomically (DATABASE_SPEC §11). `preview_changes` is the neutral alias.
  `apply_event_changes` and `database_apply_changes` are aliases of `apply_changes`.
- Block ids are paths (`"3/then/0"`) and are valid only together with the list `revision` (EVENT_SPEC §6.4 allows either
  explicit ids or index paths with revision tokens).

## Map awareness

The `maps/` module mirrors the engine instead of approximating it:

- **Passage** follows `Game_Map.checkPassage`: tile events ("below characters" priority with a tile graphic) and
  layers 3..0 are checked top first, star tiles are skipped, the first other tile decides. A step needs the exit side of
  the source cell and the opposite side of the destination, so tile passage is symmetric (one-way walls cannot exist).
- **Events** are evaluated in an assumed game state (default: all switches and self switches OFF, variables 0, no
  items, party from System.json) to pick the active page, like `Game_Event.findProperPageIndex`. "Same as characters"
  non-through events block the player; any non-through event blocks a moving event. Boats and ships at their start
  position block too.
- **Reachability** starts from every known arrival: the System player start and the destination of every direct
  Transfer Player into the map. Transfers through variables are not resolved.
- **Rendering** composes the tilemap like `Tilemap._addSpot`: lower layers, layer-4 shadows, counter "table" edges,
  star tiles above characters, and sprites at the engine's screen offsets. The autotile shape tables are derived from
  the shape semantics; a local test compares them with `rmmz_core.js` when a real install is configured.
- **Validation hooks** (`validation/map-validator.ts`) run on the staged state: transfers onto cells the player cannot
  leave, waiting non-skippable movement routes that walk into walls (simulated from the event's position), action/touch
  events no arrival can reach, and a player start outside the map or on a blocked cell. They are skipped when
  Tilesets.json is missing.

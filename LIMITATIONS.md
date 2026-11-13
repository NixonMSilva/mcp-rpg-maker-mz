# Known limitations

The tracked list of what the server does not do, or does only partially. When you fix an item, remove it or mark it
done, and update the tests.

## Verification

- **L1. No manual editor check yet.** Modified projects have not been opened in the RPG Maker MZ editor and play-tested
  (EVENT_SPEC §15.3). The native encodings come from real editor output and the engine source, and they round-trip
  losslessly on real data, but that does not prove the editor accepts them.
- **L2. Only verified on MZ 1.10.0.** Other 1.x versions share the same structures but were not tested.
- **L3. MV projects are read-only.** MV data loads, but writes are refused.

## Editor interaction

- **L4. The editor overwrites external changes.** If the project is open in RPG Maker MZ, saving in the editor replaces
  what the server wrote. Close the project, or reload it without saving, after applying.
- **L5. Editor detection is Windows-only.** The server warns when `RPGMZ.exe` is running, using `tasklist`. It cannot
  tell which project is open, and the check is skipped on other systems.

## Event IR coverage

- **L6. Some commands are opaque.** They are preserved exactly as `raw_command` blocks and can be moved or removed, but
  not edited field by field:
  - pictures (Show/Move/Rotate/Tint Picture), weather, scroll map, control timer
  - change battle BGM / victory ME / defeat ME / vehicle BGM, change window color
  - vehicle commands (set vehicle location, change vehicle image)
  - change parallax / tileset / battle background, get location info, play movie, change map name display
  - name input, change equipment, change actor images, change parameter
  - battle-only commands: enemy HP/MP/TP/state, enemy recover all/appear/transform, battle animation, force action,
    abort battle

  To model more, add a definition in `src/eventing/ir/blocks.ts`.
- **L7. Some conditions stay native.** Conditional Branch parameter shapes that don't round-trip exactly are kept as
  `{"type":"native"}` conditions. The branch stays editable; the condition is opaque.
- **L8. Show Text over 4 lines is only warned about.** It is not split automatically. The templates do split it.

## Validation and analysis

- **L9. Asset references are not validated.** Character, face, battler, picture and audio file names are not checked
  against `img/` or `audio/`. The templates' default graphics (`!Chest`, `!Door1`, `!Switch1`) assume the default
  assets exist.
- **L10. Flow analysis is heuristic and partial.** "Self switches never reset where a reset may be expected" is only
  partly covered (set but never read). The switch check reports "set but never read".
- **L11. Inferred references are best effort.** Script text is matched against common patterns, and only the `\V[n]`
  and `\N[n]` text codes are recognized. Note tags and plugin parameters are not mined for IDs, so an empty reference
  list never proves a record is unused.
- **L12. Plugin schemas are inferred.** Command schemas come from `@command`/`@arg` annotations in the default-language
  header block only. There are no adapters for popular plugins (VisuMZ, etc.).
- **L13. Design diagnostics are fixed.** Thresholds and rules are not configurable per project (DATABASE_SPEC §10.3).

## Database

- **L14. Troop pages are only partly editable.** Battle-page conditions and span cannot be edited, and pages cannot be
  added or removed. Page command lists are editable with the event tools (`troopId` + `pageIndex`).
- **L15. No resizing.** Database arrays ("Change Maximum") and the switch/variable lists cannot be resized. New records
  always append at max+1.
- **L16. No ID migration.** IDs never change, and there is no renumbering with reference rewrites.
- **L17. No map or tileset creation.** Tileset flags and animation frame/timing data beyond the listed fields are not
  editable.
- **L18. System.json is allowlist-only.** Fields outside the allowlist (for example `versionId`, `advanced`,
  `attackMotions`, `testBattlers`) cannot be patched.
- **L19. Block note tags are read-only.** Tags of the form `<Tag>...</Tag>` are reported but never rewritten.

## Transactions and storage

- **L20. Pending change sets live in memory.** Previews are lost when the server restarts and expire after 1 hour.
- **L21. Batch revisions are checked once.** In a batch, a path-based edit's `revision` is checked against the list as
  it was when the batch started. Block ids in later steps refer to the state after the earlier steps.
- **L22. Rolling back file creation is refused.** No current operation creates files.
- **L23. Backups are never pruned.** `.rpgmz-mcp/backups/` grows with every commit. It lives inside the project, so
  exclude it from deployment or set `--state-dir`.
- **L24. The lock is a lock file.** A crashed process leaves `.rpgmz-mcp/write.lock` behind, and the lock counts as
  stale after 5 minutes.

## Performance and transport

- **L25. The reference index is rebuilt per call.** `find_references`, `list_switches`, `validate_project_references`,
  deletions and similar calls scan the whole project each time. That takes under 1 s on the tested projects but may be
  slow on very large ones.
- **L26. Only stdio.** There is no HTTP transport (optional in EVENT_SPEC §3.1).

## Not started

- **L27. Runtime testing.** The MCPBridge milestone (EVENT_SPEC §14, DATABASE_SPEC Milestone 7) is not started: no
  playtest launch, runtime state, screenshots or scenario runs.

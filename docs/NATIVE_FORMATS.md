# Native RPG Maker MZ formats (verified)

Everything in this file was checked against real data, not taken from memory:

- the MZ 1.10.0 engine source (`rmmz_objects.js`: `Game_Interpreter.commandNNN`, `Game_Character.ROUTE_*`,
  `Game_BattlerBase.TRAIT_*`, `Game_Action.EFFECT_*`, `Game_Event.meetsConditions`, `Game_Enemy.meetsCondition`)
- editor output in `newdata`, the official SRPG Gear MZ sample project, the Remake Map packs, and two user projects.

A read-only corpus test (`tests/round-trip/real-corpus.test.ts`) re-checks these facts on every run when the corpus is present:
5,091 command lists and 26,367 commands parse and recompile byte-identically, and 410 of 413 JSON files reserialize byte-identically.
The remaining 3 files use layouts the serializer detects and keeps: CRLF line endings and pretty-printed plugin data.

## File layouts

| Layout | Files | Shape |
|---|---|---|
| record-array | Actors, Items, …, MapInfos, CommonEvents, Troops | `"[\n" + records.map(JSON.stringify).join(",\n") + "\n]"`; empty array is `"[\n]"` |
| map | `MapNNN.json` | `"{\n" + header pairs on one line + ",\n\"data\":[…],\n\"events\":" + record-array + "\n}"` |
| compact | System.json | single `JSON.stringify` line |

Other tools sometimes write CRLF line endings or pretty-printed JSON. The writer detects the layout of each file
(`src/project/mz-json-format.ts`) and keeps it, so editing one event changes only that event's line.

## Command lists

- A command is `{ "code", "indent", "parameters" }` (this key order). Every list ends with `{code:0, indent:0}`.
- Continuation lines share the header's indent: 101→401, 105→405, 108→408 (the comment header holds line 1),
  355→655 (the script header holds line 1), 357→657 (display lines only; the engine ignores them),
  205→505 (one display copy per route command; some tools omit them), 302→605 (shop goods).
- Branch bodies are at `indent+1` and end with `{code:0, indent:indent+1}`.
  - Conditional: `111 @n, body, [411 @n, body], 412 @n`
  - Choices: `102 @n, (402 [index, text] @n, body)*, [403 [6, null] @n, body], 404 @n`
  - Loop: `112 @n, body, 413 @n`
  - Battle: `301 @n, [601 @n body, [602 body], [603 body], 604 @n]`. The branch section exists only when "can escape" or "can lose" is set.
- Show Choices `cancelType`: `-1` = disallow, `-2` = branch (the 403 marker is always `[6, null]`), `n` = same as choice `n`.
  `defaultType`: `-1` = none.
- Show Text: `[faceName, faceIndex, background(0 window|1 dim|2 transparent), position(0 top|1 middle|2 bottom), speakerName]`.
  MV-era data has only 4 parameters (no speaker). The parser keeps that shape.
- Conditional Branch parameters are documented in `src/eventing/ir/conditions.ts`.
- Move route commands inside 205 use `{"code":N,"parameters":[…],"indent":null}` and end with `{"code":0}`.
  Page `moveRoute` lists end with `{"code":0,"parameters":[]}`. Both shapes are preserved exactly.
- Plugin command (357): `[pluginFileName, commandName, commandText, {argName: "string value"}]`. Every argument value is a
  string, and structs/arrays are JSON strings.

## Event pages and events

- Event keys: `id, name, note, pages, x, y`. Page keys: `conditions, directionFix, image, list, moveFrequency, moveRoute,
  moveSpeed, moveType, priorityType, stepAnime, through, trigger, walkAnime`.
- Page conditions keep the stored IDs when a "Valid" flag is off. The engine activates the **highest-numbered** page whose
  conditions are met.
- A blank editor page (verified on 100+ real pages) is `defaultEventPage()` in `src/adapters/rpg-maker-mz/native-types.ts`.
- New events take the lowest `null` slot in `events` (editor convention). Deleted events become `null`. Arrays are never compacted.

## Database

- Every database array has `null` at index 0. Record `id` equals its index. The editor fills unused slots with **blank records**
  (name `""`), not `null`. The blank shape of each category is in `src/database/database-catalog.ts` (taken from real files).
- Blank class records contain generated parameter curves. New classes copy class 1's curves, or fall back to a linear curve.
- Enemy `dropItems` always has 3 entries. An empty slot is `kind: 0`, and its `dataId` may be `0` (seen in official sample data).
- `System.json` lists (`elements`, `skillTypes`, `weaponTypes`, `armorTypes`, `equipTypes`, `switches`, `variables`) are
  1-based, with index 0 unused.

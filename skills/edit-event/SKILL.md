---
name: edit-event
description: Make a targeted change to an existing RPG Maker MZ map event, common event or troop battle page (add a line of dialogue, insert a condition, fix a branch, change a page's trigger, graphic or conditions) without rewriting it. Use whenever the user asks to change, fix or extend event logic that already exists.
---

# Editing existing events

## 1. Find and read it

- Locate the event with `list_map_events { mapId, nameContains }` or `search_event_commands { text: "<a line it says>" }`.
- `describe_map_event { mapId, eventId }` describes every page, its conditions and which page wins. Read it before touching anything.
- `get_event_logic { mapId, eventId, pageIndex }` returns the Event IR with block ids (`"3"`, `"3/then/0"`, `"5/choice:1/2"`) and the
  `revision` token. Other targets are `{ commonEventId }` and `{ troopId, pageIndex }`.
- `pageIndex` is zero-based: editor "Page 2" is `pageIndex: 1`.

Describe the current behavior to the user in a sentence or two before proposing the change.

## 2. Choose the smallest edit

| Change | Tool |
|---|---|
| Add at the end | `append_event_blocks` (no revision needed) |
| Add in the middle or inside a branch | `insert_event_blocks { revision, position, blocks }` |
| Change one block (with its branches) | `replace_event_block { revision, blockId, block }` |
| Delete one block | `remove_event_block { revision, blockId }` |
| Reorder | `move_event_block { revision, blockId, position }` |
| Trigger, graphic, conditions, movement, priority | `update_event_page_settings { settings }`; `null` disables a condition |
| Name or position | `update_map_event` |
| New or alternative state | `create_event_page`, `clone_event_page`, `reorder_event_pages` |

`position` is `{ before: id }`, `{ after: id }` or `{ parentId, branch, index? }`. A branch is `then`, `else`, `body`, `choice:<n>`, `cancel`,
`win`, `escape` or `lose`. Inserting into a missing `else` creates it.

Use `replace_event_logic` only when the user asked for a rewrite. If you rewrite, copy every `raw_command` block you received
unchanged: those are commands the IR doesn't model (pictures, weather, plugin codes, and so on), and they are preserved byte for byte.

## 3. Several edits

- Block ids and revisions are only valid for the version they were read from. After applying, call `get_event_logic` again.
- To make several edits at once, batch them in `preview_changes`. Later steps see block ids as they are after the earlier steps.
  Every step's `revision` is the one from before the batch.

## 4. Check and commit

- `validate_event_page` (or pass `proposedLogic` to check a replacement before staging it) and `analyze_event_flow` for the page.
- Page order matters: a new page added after an existing one wins whenever both pages' conditions hold. `analyze_event_flow` reports
  shadowed pages.
- Commit with the **safe-changes** skill, then re-read with `describe_event_page` and show the user the before and after.

Plugin command blocks: see the **plugin-commands** skill. JavaScript needs `allowScript: true`, and only when the user asked for it.

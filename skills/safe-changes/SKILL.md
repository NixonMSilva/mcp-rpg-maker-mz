---
name: safe-changes
description: Preview, review, apply and roll back changes to an RPG Maker MZ project through the rpgmaker-mz MCP server. Use whenever you are about to write to an MZ project (events, maps, database), apply or discard a change set, deal with validation warnings or a stale preview, or undo a commit.
---

# Safe changes to an RPG Maker MZ project

Every write tool on the rpgmaker-mz server returns a **change set preview** and does not touch the disk. Nothing is written until
`apply_changes`. This skill is the commit loop that every other authoring skill ends with.

## Before the first write

1. Call `get_project_info`. Check `writeEnabled`. If it is false, the server runs read-only (no `--allow-write`). You can still
   preview, but tell the user that applying needs the flag.
2. Remind the user to **close the project in the RPG Maker MZ editor**, or to reload it afterwards without saving. When the editor saves,
   it overwrites external changes. The server warns when `RPGMZ.exe` is running.
3. Never edit `data/*.json` by hand or with other file tools. Doing that bypasses validation, backups and stale-edit detection.

## The loop

1. **Preview.** Call the write tool, such as `create_map_event`, `insert_event_blocks` or `database_update_record`. If several edits belong
   together (an item plus the event that gives it, an event plus the switch name it uses), put them in one `preview_changes`
   call: `{ operations: [{ op, args }, ...] }`. They are validated together and commit atomically.
2. **Read the preview.** `semanticDiff` shows what changes in editor terms, `nativeDiff` shows the JSON lines, and `diagnostics` lists
   errors, warnings and info.
3. **Fix errors.** Errors block the write. Correct the input and preview again. Call `discard_changes` on the old change set if you
   won't use it.
4. **Explain warnings.** Summarize them for the user. Pass `acknowledgeWarnings: true` only after the user accepts them or clearly
   asked for exactly this result.
5. **Destructive change sets** (deleting an event, a page or a record, or a rollback) need `confirm: "<changeSetId>"`. Get explicit
   user approval first, and name what will be lost.
6. **Apply** with `apply_changes { changeSetId, acknowledgeWarnings?, confirm? }`. The result names the transaction id and the backup
   folder.
7. **Verify.** Re-read what you changed (`describe_map_event`, `get_event_logic`, `database_get_record`). Revisions and block ids
   change after a commit, so always re-read before the next path-based edit.

Shortcut: non-destructive write tools accept `apply: true`, which commits right after a clean preview. Use it only when the user already
asked for this exact change and the preview has no warnings you haven't discussed.

## Rules that are easy to get wrong

- `allowScript: true` is required to insert JavaScript (script blocks, script conditions or operands, route scripts). Set it **only** when the user asked for script.
- In a batch, a path-based edit's `revision` is checked against the list as it was when the batch started. Block ids in later
  steps refer to the state after the earlier steps.
- New database records always get ID max+1 (`database_list_categories` shows `maxId`). A later step in the same batch can
  reference that ID, and the preview validates it.
- Pending change sets live in memory. They expire after 1 hour and are lost when the server restarts. `list_pending_changes` shows them.
- A **stale preview** error means a file changed after the preview, usually because the editor saved. Re-read the data and preview again.
  Never try to force the write.
- IDs are never renumbered. Deleting clears the slot.

## Undo

1. `list_transactions` lists recent commits with their changed files.
2. `rollback_transaction { transactionId }` previews restoring the backup. It is refused if those files changed afterwards.
3. Apply that preview with `apply_changes` and `confirm` set to its change set id, after the user agrees.

## Reporting back

Tell the user what was committed (in editor terms: map, event name/ID, page number = pageIndex + 1), the transaction id,
any warnings that were accepted, and that the editor must reload the project.

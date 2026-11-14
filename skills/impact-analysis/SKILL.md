---
name: impact-analysis
description: Find everything that uses a switch, variable, self switch, database record, common event, map or map event in an RPG Maker MZ project before deleting, repurposing, renaming or changing it. Use for "is switch 12 used?", "can I delete this item?", "what breaks if I change this?", or when picking safe IDs for new logic.
---

# Impact analysis

## 1. Collect the references

| Target | Call |
|---|---|
| Switch or variable | `find_references { refKind: "switch" \| "variable", id }`; `list_switches` and `list_variables` show usage counts |
| Self switch | `find_references { refKind: "self_switch", id: "A", mapId, eventId }` |
| Map event | `find_references { refKind: "event", id: eventId, mapId }` |
| Common event or map | `find_references { refKind: "common_event" \| "map", id }` |
| Database record | `database_find_references { category, id }` (events, common events, troops and other records) |
| Text or command type | `search_event_commands { text \| blockType }` |
| What one page depends on | `trace_event_dependencies { ..., followCommonEvents: true }` |

## 2. Judge confidence

- References inferred from script text are marked low-confidence. Only `\V[n]` and `\N[n]` text codes are recognized.
- **Note tags and plugin parameters are not mined for IDs.** An empty result never proves something is unused. For anything
  plugin-heavy, also check `list_plugins` (parameters) and `database_search_records { text, fields: ["note", "meta"] }`, and
  tell the user what could not be checked.

## 3. Report

Give the user a table with location (map/event/page or record), role (condition, read or write) and confidence, followed by a
verdict: safe to change, safe with these follow-up edits, or risky.

## 4. Act, only when asked

- Repurposing: rename the switch or variable (`database_update_record { category: "system", patch: { "switches.<id>": "..." } }`)
  and update the readers and writers in one `preview_changes` batch.
- Deleting: `database_delete_record` (mode `clear` keeps the slot, `truncate_last` removes only the highest ID) or
  `delete_map_event`. Both are destructive. The preview lists every remaining reference and needs `confirm`. IDs are never
  renumbered, so dangling references stay dangling. Fix them in the same batch.
- For new logic, take IDs from `list_switches { onlyFree: true }` or `list_variables { onlyFree: true }`. Those are unnamed and unreferenced.

Commit with the **safe-changes** skill. `validate_project_references` afterwards confirms that no reference now points to nothing.

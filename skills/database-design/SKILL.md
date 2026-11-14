---
name: database-design
description: Create, tune or balance RPG Maker MZ database entries (items, skills, weapons, armors, enemies, states, actors, classes, troops, system terms and switch/variable names) using schemas, templates and comparisons with existing records. Use for "make a fire sword", "add a poison skill", "rebalance these enemies", class stat curves, traits/effects or note tags.
---

# Database design

## 1. Learn the category and its neighbors

- `database_describe_schema { category }` lists the patchable fields (types, ranges, enum labels, reference kinds) and the collections.
- `database_list_templates` shows the starting points: `consumable_item`, `key_item`, `revival_item`, `status_removal_item`, `healing_skill`,
  `damage_skill`, `state_skill`, `weapon`, `armor`, `basic_enemy`, `actor` and `state`.
- **Anchor the numbers to the project.** Find comparable records (`database_list_records { category, nameContains }`,
  `database_get_record`, `database_compare_records { a, b }`) and place the new entry on the existing power curve: price,
  stats, damage formula, MP cost. Explain the reasoning to the user.

## 2. Create or change

- **Create:** `database_create_record { category, name, template?, templateParams?, fields?, collections?, noteTags? }`.
  - Field paths can be nested: `"damage.formula"`, `"damage.elementId"`.
  - Enums and references accept labels and names: `"scope": "All Enemies"`, trait `code: "State Resist"`, `dataId: "Poison"`.
- **Tweak:** `database_update_record { category, id, patch }`. Only the listed fields change.
- **Traits, effects, learnings, actions, drops and troop members:** `database_edit_collection { category, id, collection, ops,
  expectedRevision }`, with ops `add`, `update`, `remove` and `move`. Take `expectedRevision` from `collections.<key>.revision` in
  `database_get_record`.
- **Note tags (for plugins):** `database_edit_note { op: "set_tag" | "remove_tag" | "replace" }` leaves the other tags and text unchanged.
  Block tags such as `<Tag>…</Tag>` are read-only.
- **Variants:** `database_duplicate_record`. The copy references the same class, skills and states. It doesn't duplicate them.
- **Class growth:** `database_set_class_curve { classId, param: "mhp", level1, level99, shape: "linear" | "ease_in" | "ease_out" }`,
  or give all 100 `values`.
- **System:** `database_update_record { category: "system", patch: { "switches.<id>": "...", "variables.<id>": "...",
  "terms.messages.<key>": "..." } }`. Only allowlisted fields can be changed.

If the record is meant for an event (a quest item, a shop good), create it and the event in one `preview_changes` batch.

## 3. Review

- The preview runs record validation, reference validation (including reverse references) and advisory **design diagnostics**.
  Discuss the diagnostics. Don't just acknowledge them.
- `database_validate_category { category, ids }` checks the records afterwards.
- Commit with the **safe-changes** skill.

## Limits

Database arrays can't be resized, so new records always append at max+1. IDs are never renumbered. Deleting clears the slot
(`database_delete_record`, destructive). Run the **impact-analysis** skill first. Troop battle-page conditions and span are read-only.
Animation and tileset data are editable only for the listed fields.

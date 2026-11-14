---
name: quest-npc
description: Build a multi-stage quest in RPG Maker MZ, with a quest-giver whose dialogue and pages change with quest progress, item turn-ins, rewards and follow-up flags. Use for fetch quests, "talk to X then Y" chains, or any event driven by a stage variable or switches.
---

# Multi-stage quests

A quest is a state machine. Design it explicitly, get the user to agree, then build it.

## 1. Reuse the project's quest system

- Look for an existing convention before inventing one: `list_variables { nameContains: "quest" }`, `list_switches`,
  `search_event_commands { refKind: "variable" }`, `list_common_events`, and `list_plugins` for a quest-log plugin.
- If nothing fits, propose **one stage variable** from `list_variables { onlyFree: true }`. Explain it to the user before writing,
  and name it in the same batch: `database_update_record { category: "system", patch: { "variables.<id>": "Quest: <name>" } }`.

## 2. Resolve every reference

- Resolve required items and rewards by name with `database_resolve_reference` (try item, then weapon, then armor). If a name is ambiguous, ask the user.
- If a quest item doesn't exist yet, create it in the **same** `preview_changes` batch (`database_create_record` with template
  `key_item`). New records get ID max+1 (`database_list_categories` → `maxId`), so later steps can reference that ID.

## 3. Lay out the state machine

Write a table and show it to the user:

| Stage (variable value) | Active page | What the NPC does | Effect |
|---|---|---|---|
| 0 | Page 1 | Offers the quest | variable = 1 |
| 1 | Page 2 (variable ≥ 1) | Checks for the item | consume item, reward, variable = 2 |
| 2 | Page 3 (variable ≥ 2) | Thanks the player | none |

Engine rules:
- The highest-numbered page whose conditions are met wins.
- Page conditions on a variable can only express "variable ≥ N" (`conditions.variable: { variableId, atLeast }`).
- A page's `item` condition and an `item` conditional only check "has at least one". To check a count, read it into a variable
  (`control_variables` with a `game_data` operand, source `item`) and compare with a `variable` conditional.

## 4. Build it

- For one quest-giver, use `create_event_from_template { template: "quest_npc", params: { variableId, characterName, characterIndex?, faceName?,
  speakerName?, stages: [{ text, requireItem?: { itemId, amount?, consume?, notMetText }, rewards?: [{ kind, id?, amount? }],
  advance?, switchOn? }] } }`. Stage k becomes page k+1.
- For chains that span several NPCs, give the other NPCs pages or conditionals on the same stage variable, and advance it where the
  story says. Place new NPCs with the **map-placement** skill.

## 5. Check it

- `analyze_event_flow { mapId, eventId, scope: "event" }` finds shadowed pages, contradictory conditions and unreachable blocks.
- For each stage, `get_map_passability { mapId, assume: { variables: { "<id>": <stage> } } }` confirms the right page is active and
  the NPC can be reached in that state.
- `trace_event_dependencies` lists every switch, variable and item the pages touch.

Commit with the **safe-changes** skill. Finally, give the user the state machine table with the real IDs.

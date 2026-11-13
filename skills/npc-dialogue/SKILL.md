---
name: npc-dialogue
description: Add or write a talking NPC in an RPG Maker MZ project, with dialogue, choices, branches on switches/variables/items, faces and speaker names. Use for "add an NPC who says…", shopkeepers, innkeepers, guards, signposts and other action-button conversations.
---

# Talking NPCs

## 1. Follow the project's conventions

- Pick the tile with the **map-placement** skill (`get_tile_info` → `free: true`).
- Open 2-3 existing NPCs on the same or a similar map (`list_map_events`, `describe_map_event`). Note their `characterName`/`characterIndex`,
  whether they use faces (`faceName`/`faceIndex`) or `speakerName`, how they format text, and their movement type. Match them.
- Character sheets and faces are not validated against `img/`. Reuse names that appear in the project, or ask the user.

## 2. Game state

If the dialogue depends on state:
- Reuse existing flags first: `list_switches { nameContains }` and `list_variables { nameContains }` show names and usage counts.
- For a new flag, take an ID from `list_switches { onlyFree: true }` (or `list_variables`). Tell the user which ID you chose, and name it
  in the same batch with `database_update_record { category: "system", patch: { "switches.<id>": "Name" } }`.
- Resolve items and actors by name with `database_resolve_reference`. Never hard-code a guessed ID.

## 3. Build it

- **Simple talker:** `create_event_from_template { template: "npc", mapId, x, y, params: { characterName, characterIndex,
  faceName?, speakerName?, text } }`. `text` may be a string, an array of lines, or an array of messages. Text over 4 lines is split
  automatically.
- **Branching conversation:** `create_map_event` with `pages: [{ settings, blocks }]`. Settings for a normal NPC are
  `{ image: { characterName, characterIndex, direction }, priority: "same", trigger: "action_button", walkAnime: true }`.
  Blocks:
  - `show_text` immediately followed by `show_choices`, so the question stays visible in the same window.
  - `conditional` with `switch`, `variable`, `item`, `gold`, `actor` or `self_switch` conditions.
  - `show_text` holds at most 4 lines per message, so use several blocks for longer speech. Text codes such as `\\V[n]`, `\\N[n]` and `\\C[n]` work
    (escape the backslash in JSON).
- **One-off branch or new page?** For a lasting change ("after the bridge is fixed he says something else"), add a page conditioned on
  the switch with `settings.conditions.switch1`. The highest-numbered page whose conditions are met wins. Use a `conditional` for
  checks made while talking ("do you have 100 gold?").

Common patterns:
- **Shop:** `shop_processing { goods: [{ goodsType: "item", id, price: null }] }`. Resolve every good by name first.
- **Inn:** `show_choices` (Stay / Leave), then `conditional` on `gold >= price`, then `change_gold` decrease, `fadeout_screen`, `recover_all { actor: 0 }`,
  `fadein_screen`.
- **Talk once, then repeat a short line:** set a self switch (`control_self_switch`) and add a page 2 conditioned on
  `selfSwitch: "A"`.

Run `get_event_ir_reference` when you need the exact fields of a block.

## 4. Commit

Preview, review the diagnostics and apply with the **safe-changes** skill. Then show the user the result with `describe_map_event`.

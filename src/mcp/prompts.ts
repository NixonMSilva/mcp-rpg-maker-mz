import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Workflow prompts (EVENT_SPEC §12, DATABASE_SPEC §11). */
export function registerPrompts(server: McpServer): void {
  const prompt = (name: string, title: string, description: string, args: Record<string, z.ZodString>, body: (a: Record<string, string | undefined>) => string) => {
    server.registerPrompt(name, { title, description, argsSchema: args }, (a) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: body(a as Record<string, string | undefined>) } }],
    }));
  };

  prompt(
    "create_npc_interaction",
    "Create an NPC interaction",
    "Guided workflow to add a talking NPC with optional choices/branches.",
    { mapId: z.string(), description: z.string().describe("What the NPC should say/do") },
    (a) => `Create an NPC on map ${a.mapId}: ${a.description}

Workflow:
1. get_map_summary to inspect the map size and nearby events; pick a free tile.
2. Find assets/conventions: look at similar NPC events (describe_map_event) for character sheet names and face usage.
3. If the dialogue depends on game state, use list_switches/list_variables (onlyFree=true for new IDs) — never invent IDs that are already in use.
4. Create the event with create_map_event (pages with settings {image, priority:"same", trigger:"action_button"} and IR blocks: show_text, show_choices, conditional...). Consider create_event_from_template template "npc" for simple cases.
5. Check the preview diagnostics; fix errors; discuss warnings.
6. Apply with apply_changes, then describe_map_event to confirm.`,
  );

  prompt(
    "create_quest_npc",
    "Create a multi-stage quest NPC",
    "Guided workflow for an NPC whose behavior depends on quest progress.",
    { mapId: z.string(), quest: z.string().describe("Quest stages, requirements and rewards") },
    (a) => `Create a quest NPC on map ${a.mapId}. Quest: ${a.quest}

Workflow:
1. Inspect existing quest conventions: search_event_commands (e.g. refKind "variable") and list_variables/list_switches with names to reuse an existing quest system.
2. If none fits, propose ONE stage variable (list_variables onlyFree=true) and explain it to the user before writing; do not invent conflicting IDs.
3. Resolve every item/reward by name with database_resolve_reference (ask the user when ambiguous).
4. Build pages per stage (create_event_from_template "quest_npc" or explicit pages; remember later pages win and page conditions only support "variable >= N").
5. Validate (preview diagnostics, analyze_event_flow) and explain the state machine (stage → page → effect) to the user.
6. Apply after confirmation.`,
  );

  prompt(
    "create_treasure_chest",
    "Create a treasure chest",
    "Chest with a reward, self switch and opened page.",
    { mapId: z.string(), x: z.string(), y: z.string(), reward: z.string() },
    (a) => `Create a treasure chest at (${a.x},${a.y}) on map ${a.mapId} containing: ${a.reward}.

1. Resolve the reward with database_resolve_reference (items/weapons/armors) and check existing chests (search_event_commands blockType "change_items") for conventions such as graphics and messages.
2. Use create_event_from_template template "treasure_chest" with params {reward: {kind, id, amount}, message}.
3. Confirm page 2 is conditioned on the self switch and that priority/trigger are "same"/"action_button". Apply after review.`,
  );

  prompt(
    "modify_existing_event",
    "Modify an existing event",
    "Minimal, safe edit of an existing event.",
    { mapId: z.string(), eventId: z.string(), change: z.string() },
    (a) => `Modify map ${a.mapId} event ${a.eventId}: ${a.change}

1. describe_map_event to read every page, then get_event_logic for the page(s) to edit (note the revision).
2. Describe the current behavior to the user.
3. Choose the SMALLEST edit: insert_event_blocks / replace_event_block / remove_event_block / update_event_page_settings. Avoid replace_event_logic unless a rewrite was requested; keep raw_command blocks untouched.
4. Review the change set (semanticDiff + diagnostics), apply it, then re-read and validate_event_page.`,
  );

  prompt(
    "give_item_in_event",
    "Database-aware event authoring",
    "Create an event that gives a database item resolved by name.",
    { itemName: z.string(), mapId: z.string() },
    (a) => `Create an event on map ${a.mapId} that gives the player "${a.itemName}".

1. database_resolve_reference category "item" (also weapon/armor if not found) name "${a.itemName}". If ambiguous or missing, ask the user (or offer to create it with database_create_record).
2. Use the resolved ID in change_items/change_weapons/change_armors blocks.
3. If you also create the database record, put both operations in ONE preview_changes batch so they commit atomically.
4. Validate, preview and apply after authorization.`,
  );

  prompt(
    "design_database_entry",
    "Design a database entry",
    "Create or tune an item, skill, weapon, armor, enemy or state.",
    { category: z.string(), idea: z.string() },
    (a) => `Create a ${a.category} for: ${a.idea}

1. database_describe_schema and database_list_templates for the category; look at comparable records (database_list_records / database_get_record) for balance.
2. database_create_record with a template and explicit fields/collections (traits/effects accept labels like "State Resist" and record names).
3. Review validation (dangling references, design diagnostics) and the normalized diff; apply after confirmation.`,
  );
}

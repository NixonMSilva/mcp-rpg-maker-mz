import { ROUTE_COMMANDS } from "../../adapters/rpg-maker-mz/command-catalog.js";
import { allLeafDefs } from "./blocks.js";

/**
 * Agent-facing Event IR reference, generated from the block definitions so
 * it cannot drift from the implementation.
 */
export function eventIrReference(): string {
  const leaf = allLeafDefs()
    .map((d) => `- \`${d.type}\` (native ${d.codes.join("/")}${d.continuation ? ` + ${d.continuation} lines` : ""}): ${d.doc}`)
    .join("\n");
  const routes = ROUTE_COMMANDS.filter((r) => r.code !== 0)
    .map((r) => (r.params.length ? `${r.name}(${r.params.join(", ")})` : r.name))
    .join(", ");
  return `# Event IR v1 reference

Event logic is a list of blocks: \`{"irVersion": 1, "blocks": [...]}\`. Every block has a \`type\`.
Blocks returned by the server carry an \`id\` (its path, e.g. \`"3"\`, \`"3/then/0"\`, \`"5/choice:1/2"\`); ids are only valid for the
revision they were read with. Input \`id\` fields are ignored. Enum fields accept the snake_case labels shown here or native numbers.

## Conventions
- Page indexes are ZERO-based (\`pageIndex: 0\` is "Page 1" in the editor). The engine activates the HIGHEST-numbered page whose conditions are met.
- Character references: \`-1\` / \`"player"\`, \`0\` / \`"this_event"\`, or a map event ID.
- Operands: a number (constant) or \`{"type":"variable","variableId":N}\`.
- Actor targets: actorId (\`0\` = entire party) or \`{"type":"variable","variableId":N}\`.
- Text: \`"text": "line1\\nline2"\` or \`"lines": [...]\`. The message window shows 4 lines; MZ text codes like \`\\\\V[1]\`, \`\\\\N[1]\`, \`\\\\C[2]\` work.
- JavaScript (script blocks, script conditions/operands, route scripts) requires \`allowScript: true\`, which must only be set when the user asked for it.

## Container blocks
- \`conditional\`: \`{ condition, then: Block[], else?: Block[] }\` — omit \`else\` for no else branch.
  Conditions: \`{type:"switch", switchId, value:"on"|"off"}\`, \`{type:"variable", variableId, comparison:"=="|">="|"<="|">"|"<"|"!=", operand}\`,
  \`{type:"self_switch", selfSwitch:"A", value}\`, \`{type:"timer", comparison:">="|"<=", seconds}\`,
  \`{type:"actor", actorId, check:"in_party"|"name"|"class"|"skill"|"weapon"|"armor"|"state", value?}\`,
  \`{type:"enemy", enemyIndex, check:"appeared"|"state", stateId?}\`, \`{type:"character", character, direction:"down"|"left"|"right"|"up"}\`,
  \`{type:"gold", comparison:">="|"<="|"<", amount}\`, \`{type:"item", itemId}\`, \`{type:"weapon"|"armor", weaponId|armorId, includeEquipment}\`,
  \`{type:"button", button:"ok"|"cancel"|"shift"|"down"|"left"|"right"|"up"|"pageup"|"pagedown", mode?:"pressed"|"triggered"|"repeated"}\`,
  \`{type:"script", script}\`, \`{type:"vehicle", vehicle:"boat"|"ship"|"airship"}\`, \`{type:"native", parameters}\` (opaque, preserved).
- \`loop\`: \`{ body: Block[] }\` — exit with \`break_loop\` (or exit/jump).
- \`show_choices\`: \`{ choices: [{text, blocks}], cancel: "disallow"|"branch"|<choice index>, default: "none"|<index>, position: "left"|"middle"|"right", background, cancelBlocks?: Block[] (only when cancel = "branch") }\`.
  Put a \`show_text\` immediately before it to show the question in the same window.
- \`battle_processing\`: \`{ troop: troopId | {type:"direct",troopId} | {type:"variable",variableId} | {type:"random_encounter"}, canEscape, canLose, win?, escape?, lose? }\`.

## Leaf blocks
${leaf}

## raw_command (escape hatch)
\`{ "type": "raw_command", "commands": [{ "code", "indent" (relative to the block), "parameters" }], "reason"? }\`
Used for commands the IR does not model (pictures, plugin-specific codes, ...). Keep raw blocks you receive when rewriting logic: they preserve
unsupported commands exactly. Writing new raw commands is allowed but only validated structurally.

## Movement route commands
Use names (string) or objects with parameters: ${routes}, and \`{"command":"raw","code":N,"parameters":[...]}\`.
Example: \`["turn_left", {"command":"wait","frames":3}, {"command":"jump","x":1,"y":0}, {"command":"play_se","se":{"name":"Jump1"}}]\`.

## Example
\`\`\`json
{ "irVersion": 1, "blocks": [
  { "type": "show_text", "speakerName": "Guard", "text": "Halt! Do you have a pass?" },
  { "type": "conditional", "condition": { "type": "item", "itemId": 5 },
    "then": [ { "type": "show_text", "text": "Go ahead." }, { "type": "control_switches", "switchId": 12, "value": "on" } ],
    "else": [ { "type": "show_text", "text": "No pass, no entry." } ] }
] }
\`\`\`
`;
}

import { invalidInput } from "../../project/errors.js";

/**
 * High-level event templates (EVENT_SPEC §2.2, §12, Milestone 4). A template
 * expands into ordinary page settings + Event IR blocks, which then go
 * through the normal normalization, validation and preview pipeline. The
 * structures mirror the editor's Quick Event conventions (e.g. a chest is
 * "page 1 closed + self switch A, page 2 opened").
 */

type P = Record<string, unknown>;

export interface TemplateEvent {
  name: string;
  pages: { settings?: Record<string, unknown>; blocks?: Record<string, unknown>[] }[];
  /** Human explanation of the generated state machine. */
  summary: string;
}

const s = (p: P, k: string, d?: string): string => {
  const v = p[k];
  if (v === undefined) {
    if (d === undefined) throw invalidInput(`params.${k} is required.`);
    return d;
  }
  if (typeof v !== "string") throw invalidInput(`params.${k} must be a string.`);
  return v;
};
const n = (p: P, k: string, d?: number): number => {
  const v = p[k];
  if (v === undefined) {
    if (d === undefined) throw invalidInput(`params.${k} is required.`);
    return d;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw invalidInput(`params.${k} must be an integer.`);
  return v;
};

/** Convert lines (or a single string) into Show Text blocks of at most 4 lines each. */
function messages(text: unknown, face: P, path: string): Record<string, unknown>[] {
  let groups: string[][];
  if (typeof text === "string") groups = [text.split(/\r?\n/)];
  else if (Array.isArray(text) && text.every((t) => typeof t === "string")) groups = [text as string[]];
  else if (Array.isArray(text) && text.every((t) => Array.isArray(t))) groups = text as string[][];
  else throw invalidInput(`${path}: expected a string, string[] (one message) or string[][] (several messages).`);
  const out: Record<string, unknown>[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.length; i += 4) {
      out.push({
        type: "show_text",
        faceName: typeof face.faceName === "string" ? face.faceName : "",
        faceIndex: typeof face.faceIndex === "number" ? face.faceIndex : 0,
        speakerName: typeof face.speakerName === "string" ? face.speakerName : "",
        lines: g.slice(i, i + 4),
      });
    }
  }
  return out;
}

function gainBlocks(reward: unknown, path: string): Record<string, unknown>[] {
  if (reward === undefined) return [];
  const list = Array.isArray(reward) ? reward : [reward];
  return list.map((r, i) => {
    const o = r as P;
    const kind = s(o, "kind", "item");
    const amount = n(o, "amount", 1);
    if (kind === "gold") return { type: "change_gold", operation: "increase", operand: amount };
    const map: Record<string, [string, string]> = { item: ["change_items", "itemId"], weapon: ["change_weapons", "weaponId"], armor: ["change_armors", "armorId"] };
    const m = map[kind];
    if (!m) throw invalidInput(`${path}[${i}].kind must be item, weapon, armor or gold.`);
    return { type: m[0], [m[1]]: n(o, "id"), operation: "increase", operand: amount };
  });
}

function npcImage(p: P): Record<string, unknown> {
  return {
    characterName: s(p, "characterName", ""),
    characterIndex: n(p, "characterIndex", 0),
    direction: p.direction ?? "down",
    pattern: 1,
  };
}

const openAnimation = [
  { type: "play_se", name: "Chest1", volume: 90, pitch: 100, pan: 0 },
  {
    type: "set_movement_route",
    character: 0,
    wait: true,
    commands: ["direction_fix_off", "turn_left", { command: "wait", frames: 3 }, "turn_right", { command: "wait", frames: 3 }, "turn_up", "direction_fix_on"],
  },
];

export const EVENT_TEMPLATES: Record<string, { description: string; params: string; build: (p: P) => TemplateEvent }> = {
  npc: {
    description: "Talking NPC (action button, same priority as characters).",
    params:
      'characterName, characterIndex?, direction?, moveType? ("fixed"|"random"), faceName?, faceIndex?, speakerName?, text: string | string[] | string[][] (several messages; >4 lines are split)',
    build: (p) => ({
      name: s(p, "name", "NPC"),
      pages: [
        {
          settings: {
            image: npcImage(p),
            movement: { type: p.moveType ?? "fixed" },
            walkAnime: true,
            priority: "same",
            trigger: "action_button",
          },
          blocks: messages(p.text, p, "params.text"),
        },
      ],
      summary: "Single page: talks when the player presses the action button.",
    }),
  },
  treasure_chest: {
    description: "Treasure chest: page 1 (closed) gives the reward and turns self switch on; page 2 (opened, conditioned on that self switch) does nothing.",
    params: 'reward: {kind:"item"|"weapon"|"armor"|"gold", id?, amount?} | reward[], message?, characterName?="!Chest", characterIndex?=0, selfSwitch?="A"',
    build: (p) => {
      const ss = s(p, "selfSwitch", "A");
      const image = { characterName: s(p, "characterName", "!Chest"), characterIndex: n(p, "characterIndex", 0), pattern: 0 };
      const reward = gainBlocks(p.reward, "params.reward");
      if (!reward.length) throw invalidInput("params.reward is required.");
      return {
        name: s(p, "name", "Chest"),
        pages: [
          {
            settings: { image: { ...image, direction: "down" }, priority: "same", trigger: "action_button", walkAnime: false },
            blocks: [...openAnimation, ...reward, ...messages(s(p, "message", "Found a treasure!"), {}, "params.message"), { type: "control_self_switch", selfSwitch: ss, value: "on" }],
          },
          {
            settings: { conditions: { selfSwitch: ss }, image: { ...image, direction: "up" }, priority: "same", trigger: "action_button", directionFix: true, walkAnime: false },
            blocks: [],
          },
        ],
        summary: `Page 1 (closed): opens, gives the reward and sets self switch ${ss} ON. Page 2 (self switch ${ss} ON): stays open forever.`,
      };
    },
  },
  door: {
    description: "Door that opens and transfers the player (action button). Without a graphic it becomes a touch-triggered transfer tile.",
    params: 'mapId, x, y, direction?="retain", fade?="black", characterName?="!Door1" ("" for an invisible touch transfer), characterIndex?=0, se?="Open1"',
    build: (p) => {
      const transfer = { type: "transfer_player", location: { type: "direct", mapId: n(p, "mapId"), x: n(p, "x"), y: n(p, "y") }, direction: p.direction ?? "retain", fade: p.fade ?? "black" };
      const characterName = s(p, "characterName", "!Door1");
      if (characterName === "") {
        return {
          name: s(p, "name", "Transfer"),
          pages: [{ settings: { priority: "below", trigger: "player_touch" }, blocks: [transfer] }],
          summary: "Invisible tile: transfers the player on touch.",
        };
      }
      return {
        name: s(p, "name", "Door"),
        pages: [
          {
            settings: { image: { characterName, characterIndex: n(p, "characterIndex", 0), direction: "down", pattern: 0 }, priority: "same", trigger: "action_button", walkAnime: false },
            blocks: [
              { type: "play_se", name: s(p, "se", "Open1"), volume: 90, pitch: 100, pan: 0 },
              { type: "set_movement_route", character: 0, wait: true, commands: ["direction_fix_off", "turn_left", { command: "wait", frames: 3 }, "turn_right", { command: "wait", frames: 3 }, "turn_up"] },
              transfer,
            ],
          },
        ],
        summary: "Plays the opening animation, then transfers the player (the door resets when the map reloads).",
      };
    },
  },
  quest_npc: {
    description:
      "Multi-stage quest NPC driven by one variable. Page k is active when the variable >= k (later pages win), so the variable is the quest stage. Each stage can require/consume an item, give rewards and advance the stage.",
    params:
      'variableId (quest stage variable, choose an unused one with list_variables), characterName, characterIndex?, faceName?, speakerName?, stages: {text, requireItem?: {itemId, amount?=1, consume?=true, notMetText}, rewards?: reward[], advance?: boolean (default true except last stage), switchOn?: switchId}[]',
    build: (p) => {
      const variableId = n(p, "variableId");
      if (!Array.isArray(p.stages) || p.stages.length === 0) throw invalidInput("params.stages must be a non-empty array.");
      const stages = p.stages as P[];
      const pages = stages.map((st, k) => {
        const path = `params.stages[${k}]`;
        const advance = st.advance ?? k < stages.length - 1;
        const done: Record<string, unknown>[] = [
          ...gainBlocks(st.rewards, `${path}.rewards`),
          ...(typeof st.switchOn === "number" ? [{ type: "control_switches", switchId: st.switchOn, value: "on" }] : []),
          ...(advance ? [{ type: "control_variables", variableId, operation: "set", operand: k + 1 }] : []),
        ];
        let blocks: Record<string, unknown>[];
        if (st.requireItem) {
          const r = st.requireItem as P;
          const itemId = n(r, "itemId");
          const amount = n(r, "amount", 1);
          const consume = r.consume !== false;
          blocks = [
            {
              type: "conditional",
              condition: { type: "item", itemId },
              then: [
                ...messages(st.text, p, `${path}.text`),
                ...(consume ? [{ type: "change_items", itemId, operation: "decrease", operand: amount }] : []),
                ...done,
              ],
              else: messages(r.notMetText ?? "Come back when you have it.", p, `${path}.requireItem.notMetText`),
            },
          ];
        } else {
          blocks = [...messages(st.text, p, `${path}.text`), ...done];
        }
        const settings: Record<string, unknown> = { image: npcImage(p), walkAnime: true, priority: "same", trigger: "action_button" };
        if (k > 0) settings.conditions = { variable: { variableId, atLeast: k } };
        return { settings, blocks };
      });
      const lines = stages.map((st, k) => `stage ${k} (variable ${variableId} ${k === 0 ? "< 1" : `>= ${k}`}) → page ${k + 1}${st.requireItem ? ", requires an item" : ""}${(st.advance ?? k < stages.length - 1) ? `, advances to ${k + 1}` : ""}`);
      return {
        name: s(p, "name", "Quest NPC"),
        pages,
        summary: `Quest state machine on variable ${variableId}: ${lines.join("; ")}. Only the item condition is checked with "has at least one"; for amount > 1 check counts with a variable.`,
      };
    },
  },
  switch_lever: {
    description: "Lever/button that toggles a game switch (with a sound) each time it is used.",
    params: 'switchId, characterName?="!Switch1", characterIndex?=0, se?="Switch1"',
    build: (p) => {
      const switchId = n(p, "switchId");
      return {
        name: s(p, "name", "Lever"),
        pages: [
          {
            settings: { image: { characterName: s(p, "characterName", "!Switch1"), characterIndex: n(p, "characterIndex", 0), direction: "down", pattern: 0 }, priority: "same", trigger: "action_button", walkAnime: false },
            blocks: [
              { type: "play_se", name: s(p, "se", "Switch1"), volume: 90, pitch: 100, pan: 0 },
              {
                type: "conditional",
                condition: { type: "switch", switchId, value: "on" },
                then: [{ type: "control_switches", switchId, value: "off" }],
                else: [{ type: "control_switches", switchId, value: "on" }],
              },
            ],
          },
        ],
        summary: `Toggles switch ${switchId} each use.`,
      };
    },
  },
  cutscene_trigger: {
    description: "One-shot cutscene: runs the given blocks when the player steps on it (or on autorun when a switch is ON), then disables itself with a self switch.",
    params: 'blocks: IR blocks of the cutscene, trigger?="player_touch" | "autorun", conditionSwitchId? (required for autorun), selfSwitch?="A"',
    build: (p) => {
      if (!Array.isArray(p.blocks)) throw invalidInput("params.blocks (Event IR blocks) is required.");
      const ss = s(p, "selfSwitch", "A");
      const trigger = s(p, "trigger", "player_touch");
      const settings: Record<string, unknown> = { priority: "below", trigger };
      if (trigger === "autorun") {
        if (typeof p.conditionSwitchId !== "number") throw invalidInput("params.conditionSwitchId is required for autorun cutscenes (otherwise it runs immediately on map load).");
        settings.conditions = { switch1: p.conditionSwitchId };
      }
      return {
        name: s(p, "name", "Cutscene"),
        pages: [
          { settings, blocks: [...(p.blocks as Record<string, unknown>[]), { type: "control_self_switch", selfSwitch: ss, value: "on" }] },
          { settings: { conditions: { selfSwitch: ss }, priority: "below", trigger: "action_button" }, blocks: [] },
        ],
        summary: `Runs once (${trigger}${trigger === "autorun" ? ` while switch ${String(p.conditionSwitchId)} is ON` : ""}), then self switch ${ss} disables it via page 2.`,
      };
    },
  },
};

export function buildEventFromTemplate(name: string, params: P): TemplateEvent {
  const t = EVENT_TEMPLATES[name];
  if (!t) throw invalidInput(`Unknown event template ${JSON.stringify(name)}. Templates: ${Object.keys(EVENT_TEMPLATES).join(", ")}.`);
  return t.build(params);
}

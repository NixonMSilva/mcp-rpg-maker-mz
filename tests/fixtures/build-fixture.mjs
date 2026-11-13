// Builds the synthetic fixture project tests/fixtures/mz-project from scratch.
//
// Every file is generated here: no data is copied from RPG Maker MZ. The native SHAPES (keys, key order,
// command layouts, file layouts) follow real MZ 1.10.0 editor output (see docs/NATIVE_FORMATS.md); the
// CONTENT (names, numbers, texts) is synthetic.
//
// Run: node tests/fixtures/build-fixture.mjs  (output is committed; tests never regenerate it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "mz-project");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.mkdirSync(path.join(root, "js", "plugins"), { recursive: true });

const D = (f) => path.join(root, "data", f);
const arr = (a) => (a.length ? "[\n" + a.map((x) => JSON.stringify(x)).join(",\n") + "\n]" : "[\n]");
const writeArr = (file, records) => fs.writeFileSync(D(file), arr([null, ...records]));
const c = (code, indent, parameters = []) => ({ code, indent, parameters });
const se = (name) => ({ name, volume: 90, pitch: 100, pan: 0 });
const audio = (name) => ({ name, pan: 0, pitch: 100, volume: 90 });
const t = (code, dataId, value) => ({ code, dataId, value });
const fx = (code, dataId, value1, value2 = 0) => ({ code, dataId, value1, value2 });
const range = (n, f) => Array.from({ length: n }, (_v, i) => f(i));

// ------------------------------------------------------------------ database

writeArr(
  "Actors.json",
  [
    [1, "Aria", 1, [1, 1, 0, 3, 0]],
    [2, "Bram", 2, [2, 0, 2, 3, 0]],
    [3, "Cora", 1, [3, 0, 0, 3, 0]],
  ].map(([id, name, classId, equips]) => ({
    id,
    battlerName: `Hero${id}`,
    characterIndex: id - 1,
    characterName: "Heroes",
    classId,
    equips,
    faceIndex: id - 1,
    faceName: "Heroes",
    traits: [],
    initialLevel: 1,
    maxLevel: 99,
    name,
    nickname: "",
    note: "",
    profile: "",
  })),
);

const curve = (l1, l99) => range(100, (lv) => (lv === 0 ? l1 : Math.round(l1 + ((l99 - l1) * (lv - 1)) / 98)));
writeArr(
  "Classes.json",
  [
    [1, "Fighter", [400, 60, 20, 18, 10, 12, 18, 15], [4000, 400, 300, 260, 120, 160, 250, 200], [10]],
    [2, "Scholar", [300, 120, 10, 12, 22, 20, 16, 18], [3000, 1200, 140, 160, 320, 300, 220, 240], [10, 11]],
  ].map(([id, name, l1, l99, skills]) => ({
    id,
    expParams: [30, 20, 30, 30],
    traits: [t(23, 0, 1), t(22, 0, 0.95), t(22, 1, 0.05), t(22, 2, 0.04), t(41, 1, 0), t(51, id, 0), t(52, 1, 0)],
    learnings: skills.map((skillId, i) => ({ level: 1 + i * 4, note: "", skillId })),
    name,
    note: "",
    params: l1.map((v, i) => curve(v, l99[i])),
  })),
);

const skill = (id, name, o = {}) => ({
  id,
  animationId: o.animationId ?? 1,
  damage: { critical: o.critical ?? false, elementId: o.elementId ?? 0, formula: o.formula ?? "0", type: o.damageType ?? 0, variance: 20 },
  description: o.description ?? "",
  effects: o.effects ?? [],
  hitType: o.hitType ?? 0,
  iconIndex: o.iconIndex ?? 64,
  message1: o.message1 ?? "%1 uses %2!",
  message2: "",
  mpCost: o.mpCost ?? 0,
  name,
  note: o.note ?? "",
  occasion: o.occasion ?? 1,
  repeats: 1,
  requiredWtypeId1: 0,
  requiredWtypeId2: 0,
  scope: o.scope ?? 1,
  speed: 0,
  stypeId: o.stypeId ?? 0,
  successRate: 100,
  tpCost: 0,
  tpGain: o.tpGain ?? 0,
  messageType: 1,
});
writeArr("Skills.json", [
  skill(1, "Attack", { damageType: 1, formula: "a.atk * 4 - b.def * 2", hitType: 1, critical: true, elementId: -1, animationId: -1, tpGain: 5, effects: [fx(21, 0, 1)], note: "Skill 1 is the Attack command." }),
  skill(2, "Guard", { scope: 11, effects: [fx(21, 2, 1)] }),
  skill(3, "Double Strike", { damageType: 1, formula: "a.atk * 3 - b.def * 2", hitType: 1, stypeId: 2, mpCost: 4 }),
  skill(4, "Rally", { scope: 8, stypeId: 2, mpCost: 6 }),
  skill(5, "Spark", { damageType: 1, formula: "50 + a.mat * 2 - b.mdf", hitType: 2, elementId: 3, stypeId: 1, mpCost: 3 }),
  skill(6, "Chill", { damageType: 1, formula: "50 + a.mat * 2 - b.mdf", hitType: 2, elementId: 4, stypeId: 1, mpCost: 3 }),
  skill(7, "Mend", { damageType: 3, formula: "100 + a.mat", scope: 7, occasion: 0, stypeId: 1, mpCost: 4 }),
  skill(8, "Purify", { scope: 7, occasion: 0, stypeId: 1, mpCost: 4, effects: [fx(22, 4, 1)] }),
  skill(9, "Focus", { scope: 11, stypeId: 2, mpCost: 2, effects: [fx(31, 2, 3)] }),
  skill(10, "Fireball", { damageType: 1, formula: "100 + a.mat * 2 - b.mdf * 2", hitType: 2, elementId: 2, stypeId: 1, mpCost: 5 }),
  skill(11, "Heal", { damageType: 3, formula: "200 + a.mat", scope: 7, occasion: 0, stypeId: 1, mpCost: 5 }),
  skill(12, "Venom Bite", { damageType: 1, formula: "a.atk * 2 - b.def", hitType: 1, effects: [fx(21, 4, 0.5)] }),
]);

const item = (id, name, o = {}) => ({
  id,
  animationId: o.animationId ?? 0,
  consumable: o.consumable ?? true,
  damage: { critical: false, elementId: 0, formula: "0", type: 0, variance: 20 },
  description: o.description ?? "",
  effects: o.effects ?? [],
  hitType: 0,
  iconIndex: o.iconIndex ?? 176,
  itypeId: o.itypeId ?? 1,
  name,
  note: o.note ?? "",
  occasion: o.occasion ?? 0,
  price: o.price ?? 0,
  repeats: 1,
  scope: o.scope ?? 7,
  speed: 0,
  successRate: 100,
  tpGain: 0,
});
writeArr("Items.json", [
  item(1, "Herb", { price: 20, effects: [fx(11, 0, 0, 100)] }),
  item(2, "Antidote", { price: 40, effects: [fx(22, 4, 1)] }),
  item(3, "Ether", { price: 150, effects: [fx(12, 0, 0, 50)] }),
  item(4, "Elixir", { price: 1000, effects: [fx(11, 0, 1), fx(12, 0, 1)] }),
  item(5, "Tent", { price: 300, scope: 8, occasion: 2 }),
  item(6, "Old Map", { itypeId: 2, consumable: false, scope: 0, occasion: 3, note: "<Quest: Lost Road>" }),
  item(7, "Potion", { price: 50, effects: [fx(11, 0, 0, 500)], description: "Restores 500 HP." }),
  item(8, "Smoke Bomb", { price: 80, scope: 11, occasion: 1, effects: [fx(41, 0, 1)] }),
]);

const weapon = (id, name, wtypeId, atk, price) => ({
  id,
  animationId: 1,
  description: "",
  etypeId: 1,
  traits: [t(31, 1, 0), t(22, 0, 0)],
  iconIndex: 96 + id,
  name,
  note: "",
  params: [0, 0, atk, 0, 0, 0, 0, 0],
  price,
  wtypeId,
});
writeArr("Weapons.json", [weapon(1, "Iron Sword", 2, 12, 400), weapon(2, "Oak Staff", 6, 6, 250), weapon(3, "Short Bow", 7, 9, 350)]);

const armor = (id, name, atypeId, etypeId, def, price) => ({
  id,
  atypeId,
  description: "",
  etypeId,
  traits: [t(22, 1, 0)],
  iconIndex: 128 + id,
  name,
  note: "",
  params: [0, 0, 0, def, 0, 0, 0, 0],
  price,
});
writeArr("Armors.json", [armor(1, "Buckler", 5, 2, 6, 200), armor(2, "Leather Cap", 1, 3, 3, 120), armor(3, "Travel Clothes", 1, 4, 5, 150)]);

const enemy = (id, name, params, exp, gold, actions, drops) => ({
  id,
  actions: actions.map((skillId) => ({ conditionParam1: 0, conditionParam2: 0, conditionType: 0, rating: 5, skillId })),
  battlerHue: 0,
  battlerName: name,
  dropItems: drops,
  exp,
  traits: [t(22, 0, 0.95), t(22, 1, 0.05), t(31, 1, 0)],
  gold,
  name,
  note: "",
  params,
});
const noDrop = { dataId: 1, denominator: 1, kind: 0 };
writeArr("Enemies.json", [
  enemy(1, "Slime", [120, 0, 14, 10, 10, 10, 10, 10], 8, 4, [1], [{ dataId: 7, denominator: 2, kind: 1 }, noDrop, noDrop]),
  enemy(2, "Bat", [90, 20, 16, 8, 12, 10, 20, 10], 10, 6, [1, 12], [noDrop, noDrop, noDrop]),
]);

const troopPage = () => ({
  conditions: { actorHp: 50, actorId: 1, actorValid: false, enemyHp: 50, enemyIndex: 0, enemyValid: false, switchId: 1, switchValid: false, turnA: 0, turnB: 0, turnEnding: false, turnValid: false },
  list: [c(0, 0)],
  span: 0,
});
writeArr("Troops.json", [
  { id: 1, members: [{ enemyId: 1, x: 336, y: 436, hidden: false }, { enemyId: 1, x: 480, y: 436, hidden: false }], name: "Slime*2", pages: [troopPage()] },
  { id: 2, members: [{ enemyId: 2, x: 408, y: 436, hidden: false }], name: "Bat", pages: [troopPage()] },
]);

const state = (id, name, o = {}) => ({
  id,
  autoRemovalTiming: o.autoRemovalTiming ?? 0,
  chanceByDamage: 100,
  iconIndex: o.iconIndex ?? id,
  maxTurns: o.maxTurns ?? 1,
  message1: o.message1 ?? "",
  message2: "",
  message3: "",
  message4: "",
  minTurns: o.minTurns ?? 1,
  motion: o.motion ?? 0,
  name,
  note: "",
  overlay: o.overlay ?? 0,
  priority: o.priority ?? 50,
  releaseByDamage: false,
  removeAtBattleEnd: o.removeAtBattleEnd ?? false,
  removeByDamage: o.removeByDamage ?? false,
  removeByRestriction: false,
  removeByWalking: false,
  restriction: o.restriction ?? 0,
  stepsToRemove: 100,
  traits: o.traits ?? [],
  messageType: 1,
});
writeArr("States.json", [
  state(1, "Knockout", { restriction: 4, priority: 100, motion: 3, traits: [t(23, 9, 0)], message1: "%1 falls!" }),
  state(2, "Guard", { priority: 0, autoRemovalTiming: 2, removeAtBattleEnd: true, traits: [t(62, 1, 0)] }),
  state(3, "Immortal", { priority: 0, removeAtBattleEnd: true, traits: [t(14, 1, 0)] }),
  state(4, "Poison", { overlay: 1, traits: [t(22, 7, -0.1)], message1: "%1 is poisoned!" }),
  state(5, "Blind", { overlay: 2, autoRemovalTiming: 2, minTurns: 3, maxTurns: 5, removeAtBattleEnd: true, traits: [t(22, 0, -0.5)] }),
  state(6, "Sleep", { restriction: 4, motion: 2, autoRemovalTiming: 2, minTurns: 2, maxTurns: 4, removeByDamage: true, removeAtBattleEnd: true }),
]);

const animation = (id, name, effectName) => ({
  id,
  displayType: 0,
  effectName,
  flashTimings: [{ frame: 0, duration: 20, color: [255, 255, 255, 170] }],
  name,
  offsetX: 0,
  offsetY: 0,
  rotation: { x: 0, y: 0, z: 0 },
  scale: 100,
  soundTimings: [{ frame: 0, se: audio("Hit1") }],
  speed: 100,
});
writeArr("Animations.json", [animation(1, "Hit", "Hit"), animation(2, "Sparkle", "Sparkle")]);

writeArr("CommonEvents.json", [
  { id: 1, list: [c(250, 0, [se("Recovery")]), c(314, 0, [0, 0]), c(0, 0)], name: "Heal Party", switchId: 1, trigger: 0 },
  { id: 2, list: [c(117, 0, [3]), c(0, 0)], name: "Cycle A", switchId: 1, trigger: 0 },
  { id: 3, list: [c(117, 0, [2]), c(0, 0)], name: "Cycle B", switchId: 1, trigger: 0 },
  { id: 4, list: [c(0, 0)], name: "", switchId: 1, trigger: 0 },
]);

writeArr("MapInfos.json", [
  { id: 1, expanded: false, name: "FIELD", order: 1, parentId: 0, scrollX: 0, scrollY: 0 },
  { id: 2, expanded: false, name: "TEST_TOWN", order: 2, parentId: 0, scrollX: 0, scrollY: 0 },
  { id: 3, expanded: false, name: "PASSABILITY_LAB", order: 3, parentId: 0, scrollX: 0, scrollY: 0 },
]);

const names = (n, named) => range(n + 1, (i) => named[i] ?? "");
const vehicle = (characterIndex) => ({ bgm: audio(""), characterIndex, characterName: "Vehicles", startMapId: 0, startX: 0, startY: 0 });
const system = {
  advanced: { gameId: 12345678, screenWidth: 816, screenHeight: 624, uiAreaWidth: 816, uiAreaHeight: 624, numberFontFilename: "", fallbackFonts: "Verdana, sans-serif", fontSize: 26, mainFontFilename: "" },
  airship: vehicle(3),
  armorTypes: ["", "General Armor", "Magic Armor", "Light Armor", "Heavy Armor", "Small Shield", "Large Shield"],
  attackMotions: range(13, (i) => ({ type: i === 0 ? 0 : 1, weaponImageId: i })),
  battleBgm: audio("Battle"),
  battleback1Name: "",
  battleback2Name: "",
  battlerHue: 0,
  battlerName: "",
  battleSystem: 0,
  boat: vehicle(0),
  currencyUnit: "G",
  defeatMe: audio("Defeat"),
  editMapId: 2,
  elements: ["", "Physical", "Fire", "Thunder", "Ice"],
  equipTypes: ["", "Weapon", "Shield", "Head", "Body", "Accessory"],
  gameTitle: "Fixture Project",
  gameoverMe: audio("Gameover"),
  itemCategories: [true, true, true, true],
  locale: "en_US",
  magicSkills: [1],
  menuCommands: [true, true, true, true, true, true],
  optAutosave: true,
  optDisplayTp: true,
  optDrawTitle: true,
  optExtraExp: false,
  optFloorDeath: false,
  optFollowers: true,
  optKeyItemsNumber: false,
  optSideView: false,
  optSlipDeath: false,
  optTransparent: false,
  partyMembers: [1, 2],
  ship: vehicle(1),
  skillTypes: ["", "Magic", "Technique"],
  sounds: range(24, (i) => audio(`System${i}`)),
  startMapId: 2,
  startX: 8,
  startY: 8,
  switches: names(20, { 1: "Gate Open", 2: "Quest Done" }),
  terms: {
    basic: ["Level", "Lv", "HP", "HP", "MP", "MP", "TP", "TP", "EXP", "EXP"],
    commands: ["Fight", "Escape", "Attack", "Guard", "Item", "Skill", "Equip", "Status", "Formation", "Save", "Game End", "Options", "Weapon", "Armor", "Key Item", "Equip", "Optimize", "Clear", "New Game", "Continue", null, "To Title", "Cancel", null, "Buy", "Sell"],
    params: ["Max HP", "Max MP", "Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck", "Hit", "Evasion"],
    messages: {
      actionFailure: "No effect on %1.",
      actorDamage: "%1 took %2 damage!",
      actorGain: "%1 gained %2 %3!",
      emerge: "%1 appeared!",
      escapeStart: "%1 tries to escape!",
      levelUp: "%1 reached %2 %3!",
      obtainExp: "%1 %2 received!",
      obtainGold: "%1\\G found!",
      obtainItem: "%1 found!",
      victory: "%1 won!",
    },
  },
  testBattlers: [
    { actorId: 1, level: 1, equips: [1, 1, 0, 3, 0] },
    { actorId: 2, level: 1, equips: [2, 0, 2, 3, 0] },
  ],
  testTroopId: 1,
  title1Name: "",
  title2Name: "",
  titleBgm: audio("Title"),
  titleCommandWindow: { background: 0, offsetX: 0, offsetY: 0 },
  variables: names(20, { 1: "Quest Stage", 3: "Counter" }),
  versionId: 1,
  victoryMe: audio("Victory"),
  weaponTypes: ["", "Dagger", "Sword", "Flail", "Axe", "Whip", "Staff", "Bow"],
  windowTone: [0, 0, 0, 0],
};
fs.writeFileSync(D("System.json"), JSON.stringify(system));

// ------------------------------------------------------------------ maps

const mapHeader = (displayName, width, height) => ({
  autoplayBgm: false,
  autoplayBgs: false,
  battleback1Name: "",
  battleback2Name: "",
  bgm: { name: "", pan: 0, pitch: 100, volume: 90 },
  bgs: { name: "", pan: 0, pitch: 100, volume: 90 },
  disableDashing: false,
  displayName,
  encounterList: [],
  encounterStep: 30,
  height,
  note: "",
  parallaxLoopX: false,
  parallaxLoopY: false,
  parallaxName: "",
  parallaxShow: true,
  parallaxSx: 0,
  parallaxSy: 0,
  scrollType: 0,
  specifyBattleback: false,
  tilesetId: 1,
  width,
});
// Layer 0 of the plain maps is the A2 floor (kind 16, shape 0); everything else is empty.
const FLOOR = 2816;
function writeMap(file, header, events, data = floorData(header.width, header.height)) {
  const head = Object.keys(header)
    .map((k) => JSON.stringify(k) + ":" + JSON.stringify(header[k]))
    .join(",");
  fs.writeFileSync(D(file), "{\n" + head + ",\n\"data\":" + JSON.stringify(data) + ",\n\"events\":" + arr(events) + "\n}");
}

const page = (over = {}) => ({
  conditions: {
    actorId: 1,
    actorValid: false,
    itemId: 1,
    itemValid: false,
    selfSwitchCh: "A",
    selfSwitchValid: false,
    switch1Id: 1,
    switch1Valid: false,
    switch2Id: 1,
    switch2Valid: false,
    variableId: 1,
    variableValid: false,
    variableValue: 0,
    ...(over.conditions ?? {}),
  },
  directionFix: false,
  image: { tileId: 0, characterName: "People1", direction: 2, pattern: 1, characterIndex: 0, ...(over.image ?? {}) },
  list: over.list ?? [c(0, 0)],
  moveFrequency: 3,
  moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
  moveSpeed: 3,
  moveType: 0,
  priorityType: over.priorityType ?? 1,
  stepAnime: false,
  through: false,
  trigger: over.trigger ?? 0,
  walkAnime: true,
});
const ev = (id, name, x, y, pages) => ({ id, name, note: "", pages, x, y });

writeMap("Map001.json", mapHeader("Field", 17, 13), []);

const events = [null];
// 1 simple dialogue
events[1] = ev(1, "Villager", 3, 3, [page({ list: [c(101, 0, ["Actor1", 0, 0, 2, "Reid"]), c(401, 0, ["Hello there!"]), c(401, 0, ["Nice weather, \\V[1]."]), c(0, 0)] })]);
// 2 nested conditional with else
events[2] = ev(2, "Guard", 5, 3, [
  page({
    list: [
      c(111, 0, [0, 1, 0]),
      c(101, 1, ["", 0, 0, 2, ""]),
      c(401, 1, ["The gate is open."]),
      c(0, 1),
      c(411, 0),
      c(111, 1, [8, 7]),
      c(126, 2, [7, 1, 0, 1]),
      c(121, 2, [1, 1, 0]),
      c(0, 2),
      c(411, 1),
      c(101, 2, ["", 0, 0, 2, ""]),
      c(401, 2, ["The gate remains sealed."]),
      c(0, 2),
      c(412, 1),
      c(0, 1),
      c(412, 0),
      c(0, 0),
    ],
  }),
]);
// 3 choices with cancel branch + shop
events[3] = ev(3, "Merchant", 7, 3, [
  page({
    list: [
      c(101, 0, ["", 0, 0, 2, "Merchant"]),
      c(401, 0, ["What do you need?"]),
      c(102, 0, [["Buy", "Sell", "Leave"], -2, 0, 2, 0]),
      c(402, 0, [0, "Buy"]),
      c(302, 1, [0, 1, 0, 0, false]),
      c(605, 1, [0, 2, 0, 0]),
      c(605, 1, [1, 1, 1, 150]),
      c(0, 1),
      c(402, 0, [1, "Sell"]),
      c(101, 1, ["", 0, 0, 2, ""]),
      c(401, 1, ["Nothing to sell."]),
      c(0, 1),
      c(402, 0, [2, "Leave"]),
      c(0, 1),
      c(403, 0, [6, null]),
      c(250, 1, [se("Cancel2")]),
      c(0, 1),
      c(404, 0),
      c(0, 0),
    ],
  }),
]);
// 4 loop with input and break
events[4] = ev(4, "Looper", 9, 3, [
  page({
    list: [
      c(112, 0),
      c(103, 1, [2, 2]),
      c(111, 1, [1, 2, 0, 42, 0]),
      c(113, 2),
      c(0, 2),
      c(412, 1),
      c(122, 1, [3, 3, 1, 0, 1]),
      c(0, 1),
      c(413, 0),
      c(0, 0),
    ],
  }),
]);
// 5 movement route & misc presentation
const route = [
  { code: 44, parameters: [se("Jump1")], indent: null },
  { code: 14, parameters: [0, -1], indent: null },
  { code: 15, parameters: [10], indent: null },
  { code: 19, indent: null },
];
events[5] = ev(5, "Mover", 11, 3, [
  page({
    list: [
      c(205, 0, [0, { list: [...route, { code: 0 }], repeat: false, skippable: false, wait: true }]),
      ...route.map((r) => c(505, 0, [r])),
      c(213, 0, [-1, 1, true]),
      c(230, 0, [30]),
      c(203, 0, [0, 0, 12, 4, 2]),
      c(212, 0, [0, 1, false]),
      c(0, 0),
    ],
  }),
]);
// 6 common event call, plugin command, script, comment
events[6] = ev(6, "Caller", 13, 3, [
  page({
    list: [
      c(117, 0, [1]),
      c(357, 0, ["TestPlugin", "DoThing", "Do Thing", { power: "5", target: '{"x":"1"}' }]),
      c(657, 0, ["Power = 5"]),
      c(657, 0, ['Target = {"x":"1"}']),
      c(355, 0, ["const v = $gameVariables.value(3);"]),
      c(655, 0, ["$gameSwitches.setValue(2, v > 10);"]),
      c(108, 0, ["A comment"]),
      c(408, 0, ["second line"]),
      c(0, 0),
    ],
  }),
]);
// 7 chest: multi-page with conditions
events[7] = ev(7, "Chest", 15, 3, [
  page({
    image: { characterName: "!Chest", pattern: 0 },
    list: [c(250, 0, [se("Chest1")]), c(126, 0, [7, 0, 0, 1]), c(101, 0, ["", 0, 0, 2, ""]), c(401, 0, ["Found a Potion!"]), c(123, 0, ["A", 0]), c(0, 0)],
  }),
  page({ image: { characterName: "!Chest", direction: 8, pattern: 0 }, conditions: { selfSwitchValid: true } }),
  page({ image: { characterName: "!Chest", direction: 8, pattern: 0 }, conditions: { switch1Id: 2, switch1Valid: true, variableId: 3, variableValid: true, variableValue: 5 } }),
]);
// 8 unknown / unsupported commands (must be preserved verbatim)
events[8] = ev(8, "Weird", 3, 6, [
  page({
    list: [
      c(231, 0, [1, "Picture", 0, 0, 0, 0, 100, 100, 255, 0]),
      { code: 999, indent: 0, parameters: ["plugin-ish"], extraKey: { keep: true } },
      c(999, 1, ["nested child of unknown"]),
      c(356, 0, ["OldPlugin arg1 arg2"]),
      c(101, 0, ["", 0, 0, 2]),
      c(401, 0, ["MV-style text without speaker name"]),
      c(0, 0),
    ],
  }),
]);
// 9 battle with branches, gold/HP/state, transfer
events[9] = ev(9, "Gatekeeper", 5, 6, [
  page({
    list: [
      c(301, 0, [0, 1, true, false]),
      c(601, 0),
      c(125, 1, [0, 0, 100]),
      c(311, 1, [0, 0, 0, 0, 50, false]),
      c(0, 1),
      c(602, 0),
      c(313, 1, [0, 1, 0, 4]),
      c(0, 1),
      c(604, 0),
      c(201, 0, [0, 1, 8, 6, 2, 0]),
      c(0, 0),
    ],
  }),
]);
events[10] = null; // free slot: the next created event must get ID 10
events[11] = ev(11, "AfterGap", 7, 6, [page({ priorityType: 0 })]);

writeMap("Map002.json", mapHeader("Test Town", 20, 15), events);

// ------------------------------------------------------------------ map awareness (tileset, images, lab map)

function floorData(width, height) {
  const data = new Array(width * height * 6).fill(0);
  data.fill(FLOOR, 0, width * height);
  return data;
}

// Minimal PNG writer (8-bit RGBA, filter 0) for the synthetic images.
const crcTable = Array.from({ length: 256 }, (_v, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Synthetic sheets: every 24x24 quarter-tile has its own color, so tests can tell which quarter was drawn where.
// A1 = blue channel 200, A2 = blue 40, A4 = blue 120, B = one color per 48x48 tile.
const img = (dir, name, buf) => {
  fs.mkdirSync(path.join(root, "img", dir), { recursive: true });
  fs.writeFileSync(path.join(root, "img", dir, `${name}.png`), buf);
};
const quarterColor = (blue) => (x, y) => [(Math.floor(x / 24) * 8) % 256, (60 + Math.floor(y / 24) * 8) % 256, blue, 255];
img("tilesets", "Fix_A1", png(768, 576, quarterColor(200)));
img("tilesets", "Fix_A2", png(768, 576, quarterColor(40)));
img("tilesets", "Fix_A4", png(768, 720, quarterColor(120)));
img("tilesets", "Fix_B", png(768, 768, (x, y) => (Math.floor(x / 48) + Math.floor(y / 48) === 0 ? [0, 0, 0, 0] : [Math.floor(x / 48) * 16, Math.floor(y / 48) * 16, 220, 255])));
// One 12x8 frame sheet (48x48 frames); each frame is a colored 24x40 figure on transparency.
img("characters", "People1", png(576, 384, (x, y) => {
  const fx = Math.floor(x / 48), fy = Math.floor(y / 48), lx = x % 48, ly = y % 48;
  return lx >= 12 && lx < 36 && ly >= 8 ? [fx * 20, fy * 30, 255, 255] : [0, 0, 0, 0];
}));

// Tile ids used by the lab map.
const A1_WATER = 2048; // A1 kind 0
const A2_TABLE = 2864; // A2 kind 17 (counter flag => drawn as a table)
const A4_WALL_TOP = 5888; // A4 kind 80
const A4_WALL_SIDE = 6272 + 15; // A4 kind 88, shape 15
const B_WALL = 1, B_STAR = 2, B_FENCE_NORTH = 4, B_LADDER = 5, B_DAMAGE = 6, B_BUSH = 7;

const flags = new Array(8192).fill(0);
flags[0] = 0x10;
const kindFlags = (base, kind, value) => flags.fill(value, base + kind * 48, base + kind * 48 + 48);
kindFlags(2048, 0, 0x0f); // water: impassable on foot
kindFlags(2048, 16, 0x00); // floor
kindFlags(2048, 17, 0x8f); // table: counter + impassable
kindFlags(2048, 80, 0x0f); // wall top
kindFlags(2048, 88, 0x0f); // wall side
flags[B_WALL] = 0x0f;
flags[B_STAR] = 0x10;
flags[B_FENCE_NORTH] = 0x08; // blocks the cell's north side only
flags[B_LADDER] = 0x20;
flags[B_DAMAGE] = 0x100 | (3 << 12); // damage floor, terrain tag 3
flags[B_BUSH] = 0x40;
writeArr("Tilesets.json", [
  { id: 1, flags, mode: 1, name: "Fixture", note: "", tilesetNames: ["Fix_A1", "Fix_A2", "", "Fix_A4", "", "Fix_B", "", "", ""] },
]);

// Map 3 "Passability Lab" (12x9):
//   y0  W W W W W W W W W W W W     W wall top, w wall side (bottom row)
//   y1  W . . . . W . . 2 . r W     2 clerk behind the table, r region 7
//   y2  W . f . . W . . T . r W     f fence (north side blocked), T table/counter
//   y3  W @ . . . 1 . . . . . W     1 guard in the doorway (blocks until switch 1), @ transfer arrival
//   y4  W . . * . W . 4 . . . W     * star decoration (passable), 4 tile event acting as a wall
//   y5  W W W W W W . . . 5 . W     5 teleporter (transfer to (1,3))
//   y6  W . 3 . . W . . . . . W     3 hidden event in a closed room
//   y7  W . . . . W ~ " ! H . W     ~ water, " bush, ! damage, H ladder
//   y8  w w w w w w w w w w w w
{
  const W = 12, H = 9;
  const data = floorData(W, H);
  const set = (x, y, z, id) => (data[(z * H + y) * W + x] = id);
  for (let x = 0; x < W; x++) {
    set(x, 0, 0, A4_WALL_TOP);
    set(x, 8, 0, A4_WALL_SIDE);
  }
  for (let y = 1; y < 8; y++) {
    set(0, y, 0, A4_WALL_TOP);
    set(11, y, 0, A4_WALL_TOP);
    if (y !== 3) set(5, y, 0, A4_WALL_TOP);
  }
  for (let x = 0; x < 5; x++) set(x, 5, 0, A4_WALL_TOP);
  set(2, 2, 2, B_FENCE_NORTH);
  set(8, 2, 1, A2_TABLE);
  set(3, 4, 3, B_STAR);
  set(6, 7, 0, A1_WATER);
  set(7, 7, 2, B_BUSH);
  set(8, 7, 2, B_DAMAGE);
  set(9, 7, 2, B_LADDER);
  set(6, 1, 4, 0b0101); // shadow on the left half
  set(10, 1, 5, 7);
  set(10, 2, 5, 7);
  const talk = (text) => [c(101, 0, ["", 0, 0, 2, ""]), c(401, 0, [text]), c(0, 0)];
  const lab = [null];
  lab[1] = ev(1, "Guard", 5, 3, [page({ list: talk("Halt.") }), page({ conditions: { switch1Valid: true, switch1Id: 1 }, priorityType: 0, list: talk("Go ahead.") })]);
  lab[2] = ev(2, "Clerk", 8, 1, [page({ list: talk("Welcome!") })]);
  lab[3] = ev(3, "Hidden", 2, 6, [page({ list: talk("Nobody can reach me.") })]);
  lab[4] = ev(4, "Crate", 7, 4, [page({ image: { tileId: B_WALL, characterName: "" }, priorityType: 0 })]);
  lab[5] = ev(5, "Teleporter", 9, 5, [page({ list: [c(201, 0, [0, 3, 1, 3, 0, 0]), c(0, 0)] })]);
  writeMap("Map003.json", mapHeader("Passability Lab", W, H), lab, data);
}

// ------------------------------------------------------------------ project files

fs.writeFileSync(path.join(root, "game.rmmzproject"), "RPGMZ 1.10.0");
// Version header only (used for engine-version detection); not the engine source.
fs.writeFileSync(path.join(root, "js", "rmmz_core.js"), "//=============================================================================\n// rmmz_core.js v1.10.0\n// (fixture stub: version header only)\n");
fs.writeFileSync(
  path.join(root, "js", "plugins.js"),
  "// Generated by RPG Maker.\n// Do not edit this file directly.\nvar $plugins =\n" +
    arr([
      { name: "TestPlugin", status: true, description: "Fixture plugin", parameters: { Speed: "5" } },
      { name: "DisabledPlugin", status: false, description: "Disabled fixture plugin", parameters: {} },
    ]) +
    ";\n",
);
fs.writeFileSync(
  path.join(root, "js", "plugins", "TestPlugin.js"),
  "/*:\n * @target MZ\n * @plugindesc Fixture plugin\n * @command DoThing\n * @text Do Thing\n * @arg power\n * @text Power\n * @arg target\n */\n(() => {})();\n",
);
console.log("fixture written to", root);

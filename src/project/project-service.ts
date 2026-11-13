import * as fs from "node:fs";
import * as path from "node:path";
import { parsePluginsJs, type PluginEntry } from "../adapters/rpg-maker-mz/plugins-js.js";
import type {
  NativeCommonEvent,
  NativeMap,
  NativeMapInfo,
  NativeTroop,
} from "../adapters/rpg-maker-mz/native-types.js";
import { McpError, notFound } from "./errors.js";
import { FileManager, type JsonSnapshot } from "./file-manager.js";
import { PathGuard } from "./path-guard.js";

export interface ProjectOptions {
  /** Enables committing change sets. Read-only by default (EVENT_SPEC §16). */
  allowWrite?: boolean;
  /** Project-relative directory for backups and the transaction log. */
  stateDir?: string;
}

export interface ProjectDetection {
  engine: "MZ" | "MV" | "unknown";
  /** Editor version from game.rmmzproject, e.g. "1.10.0". */
  editorVersion: string | null;
  /** Core script version from js/rmmz_core.js header, e.g. "1.10.0". */
  coreScriptVersion: string | null;
  projectFile: string | null;
  isMz: boolean;
  notes: string[];
}

/** Tested against MZ 1.10.0 data; other 1.x versions share the same structures. */
export const SUPPORTED_MZ_VERSIONS = ">=1.0.0 <2.0.0 (verified on 1.10.0)";

export const DATA_DIR = "data";

/**
 * One opened RPG Maker MZ project. Owns path confinement and read access.
 * Shared, canonical accessors for MapInfos/System/CommonEvents/Troops live
 * here so eventing and database modules never parse them independently
 * (DATABASE_SPEC §3.1).
 */
export class ProjectService {
  readonly root: string;
  readonly guard: PathGuard;
  readonly files: FileManager;
  readonly detection: ProjectDetection;
  readonly allowWrite: boolean;
  readonly stateDir: string;

  private constructor(root: string, detection: ProjectDetection, options: ProjectOptions) {
    this.root = root;
    this.guard = new PathGuard(root);
    this.files = new FileManager(this.guard);
    this.detection = detection;
    this.allowWrite = options.allowWrite === true;
    this.stateDir = options.stateDir ?? ".rpgmz-mcp";
  }

  static open(rootPath: string, options: ProjectOptions = {}): ProjectService {
    const root = path.resolve(rootPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      throw new McpError("PROJECT_NOT_FOUND", `Project directory does not exist: ${root}`);
    }
    if (!stat.isDirectory()) {
      throw new McpError("PROJECT_NOT_FOUND", `Project path is not a directory: ${root}`);
    }
    const detection = detectProject(root);
    if (detection.engine === "unknown") {
      throw new McpError(
        "NOT_AN_MZ_PROJECT",
        `${root} does not look like an RPG Maker project (expected data/System.json and data/MapInfos.json). ${detection.notes.join(" ")}`,
      );
    }
    return new ProjectService(root, detection, options);
  }

  /** Throws unless the project is MZ and write access was enabled. */
  assertWritable(): void {
    if (!this.detection.isMz) {
      throw new McpError(
        "NOT_AN_MZ_PROJECT",
        `Writes are only allowed for verified RPG Maker MZ projects (detected engine: ${this.detection.engine}).`,
      );
    }
    if (!this.allowWrite) {
      throw new McpError(
        "WRITE_DISABLED",
        "The server is running in read-only mode. Restart it with --allow-write (or RPGMZ_MCP_ALLOW_WRITE=1) to commit changes. Previews remain available.",
      );
    }
  }

  dataPath(fileName: string): string {
    return `${DATA_DIR}/${fileName}`;
  }

  hasDataFile(fileName: string): boolean {
    return this.files.exists(this.dataPath(fileName));
  }

  readData<T = unknown>(fileName: string): JsonSnapshot<T> {
    return this.files.readJson<T>(this.dataPath(fileName));
  }

  listDataFiles(): string[] {
    return this.files
      .listDir(DATA_DIR)
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort();
  }

  // ---------------------------------------------------------------- shared structures

  mapInfos(): JsonSnapshot<(NativeMapInfo | null)[]> {
    const snap = this.readData<(NativeMapInfo | null)[]>("MapInfos.json");
    if (!Array.isArray(snap.data)) throw new McpError("MALFORMED_DATA", "data/MapInfos.json is not an array.");
    return snap;
  }

  mapInfo(mapId: number): NativeMapInfo {
    const info = this.mapInfos().data[mapId];
    if (!info) throw notFound(`Map ${mapId} is not registered in MapInfos.json.`, { mapId });
    return info;
  }

  /** Map file names are derived from the numeric ID registered in MapInfos (never from display names). */
  static mapFileName(mapId: number): string {
    return `Map${String(mapId).padStart(3, "0")}.json`;
  }

  readMap(mapId: number): JsonSnapshot<NativeMap> {
    this.mapInfo(mapId);
    const snap = this.readData<NativeMap>(ProjectService.mapFileName(mapId));
    const d = snap.data as unknown;
    if (!d || typeof d !== "object" || !Array.isArray((d as NativeMap).events)) {
      throw new McpError("MALFORMED_DATA", `${ProjectService.mapFileName(mapId)} has no events array.`, { mapId });
    }
    return snap;
  }

  commonEvents(): JsonSnapshot<(NativeCommonEvent | null)[]> {
    const snap = this.readData<(NativeCommonEvent | null)[]>("CommonEvents.json");
    if (!Array.isArray(snap.data)) throw new McpError("MALFORMED_DATA", "data/CommonEvents.json is not an array.");
    return snap;
  }

  troops(): JsonSnapshot<(NativeTroop | null)[]> {
    const snap = this.readData<(NativeTroop | null)[]>("Troops.json");
    if (!Array.isArray(snap.data)) throw new McpError("MALFORMED_DATA", "data/Troops.json is not an array.");
    return snap;
  }

  system(): JsonSnapshot<Record<string, unknown>> {
    return this.readData<Record<string, unknown>>("System.json");
  }

  /** Name of switch `id` from System.json, or "" if unnamed. */
  switchName(id: number): string {
    const sw = this.system().data.switches;
    return Array.isArray(sw) && typeof sw[id] === "string" ? (sw[id] as string) : "";
  }

  variableName(id: number): string {
    const v = this.system().data.variables;
    return Array.isArray(v) && typeof v[id] === "string" ? (v[id] as string) : "";
  }

  plugins(): PluginEntry[] {
    const rel = "js/plugins.js";
    if (!this.files.exists(rel)) return [];
    return parsePluginsJs(this.files.readText(rel).text);
  }

  /** Read a plugin's source header (text only; plugin code is never executed). */
  pluginSource(name: string): string | null {
    if (!/^[\w.\- ]+$/.test(name)) return null;
    const rel = `js/plugins/${name}.js`;
    return this.files.exists(rel) ? this.files.readText(rel).text : null;
  }
}

function readFirstLine(file: string, maxBytes = 512): string | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function detectProject(root: string): ProjectDetection {
  const notes: string[] = [];
  const has = (rel: string) => fs.existsSync(path.join(root, rel));
  let projectFile: string | null = null;
  let editorVersion: string | null = null;
  let engine: ProjectDetection["engine"] = "unknown";

  if (has("game.rmmzproject")) {
    projectFile = "game.rmmzproject";
    engine = "MZ";
    const txt = readFirstLine(path.join(root, projectFile)) ?? "";
    const m = /RPGMZ\s+(\d+\.\d+\.\d+)/.exec(txt);
    editorVersion = m?.[1] ?? null;
  } else if (has("Game.rpgproject")) {
    projectFile = "Game.rpgproject";
    engine = "MV";
    notes.push("Found an RPG Maker MV project file; this server targets MZ.");
  }

  let coreScriptVersion: string | null = null;
  const core = readFirstLine(path.join(root, "js", "rmmz_core.js"));
  if (core) {
    const m = /rmmz_core\.js v(\d+\.\d+\.\d+)/.exec(core);
    coreScriptVersion = m?.[1] ?? null;
    if (engine === "unknown") {
      engine = "MZ";
      notes.push("No game.rmmzproject file; detected MZ from js/rmmz_core.js.");
    }
  } else if (has("js/rpg_core.js") && engine === "unknown") {
    engine = "MV";
    notes.push("Detected RPG Maker MV core scripts; this server targets MZ.");
  }

  const hasData = has("data/System.json") && has("data/MapInfos.json");
  if (!hasData) {
    notes.push("Missing data/System.json or data/MapInfos.json.");
    engine = "unknown";
  }
  return { engine, editorVersion, coreScriptVersion, projectFile, isMz: engine === "MZ" && hasData, notes };
}

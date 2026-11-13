import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseService } from "../../src/database/database-service.js";
import { EventService } from "../../src/eventing/event-service.js";
import { ProjectService } from "../../src/project/project-service.js";
import { TransactionManager } from "../../src/project/transaction-manager.js";
import { databaseValidator, eventValidator } from "../../src/validation/workspace-validators.js";

process.env.RPGMZ_MCP_SKIP_EDITOR_CHECK = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.resolve(here, "../fixtures/mz-project");
const TMP_ROOT = path.resolve(here, "../.tmp");

/** Copy the fixture project to a fresh temp directory (write tests never touch the committed fixture). */
export function tempProject(): string {
  const dir = path.join(TMP_ROOT, `p_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

export interface TestSession {
  root: string;
  project: ProjectService;
  tx: TransactionManager;
  events: EventService;
  db: DatabaseService;
}

export function session(root = tempProject(), allowWrite = true): TestSession {
  const project = ProjectService.open(root, { allowWrite });
  const tx = new TransactionManager(project);
  tx.registerValidator(eventValidator(project));
  tx.registerValidator(databaseValidator(project));
  return { root, project, tx, events: new EventService(project), db: new DatabaseService(project) };
}

export function readJson(root: string, rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

export function readText(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

export const MAP2 = "data/Map002.json";

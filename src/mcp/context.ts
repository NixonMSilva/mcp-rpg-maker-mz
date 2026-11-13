import * as path from "node:path";
import { DatabaseService } from "../database/database-service.js";
import { EventService } from "../eventing/event-service.js";
import { MapService } from "../maps/map-service.js";
import { McpError } from "../project/errors.js";
import { ProjectService } from "../project/project-service.js";
import { TransactionManager } from "../project/transaction-manager.js";
import { databaseValidator, eventValidator } from "../validation/workspace-validators.js";

/**
 * Server configuration and the active project session. One session = one
 * project root with its own transaction manager; eventing and database
 * services share it (one project context, one transaction manager, one
 * validation system, one reference resolver).
 */
export interface ServerConfig {
  /** Explicitly configured project roots (first one is selected at startup). */
  projects: string[];
  allowWrite: boolean;
  /** Allow select_project with arbitrary paths (off by default). */
  allowAnyProject: boolean;
  stateDir: string;
}

export class ProjectSession {
  readonly project: ProjectService;
  readonly tx: TransactionManager;
  readonly events: EventService;
  readonly db: DatabaseService;
  readonly maps: MapService;

  constructor(root: string, config: ServerConfig) {
    this.project = ProjectService.open(root, { allowWrite: config.allowWrite, stateDir: config.stateDir });
    this.tx = new TransactionManager(this.project);
    this.tx.registerValidator(eventValidator(this.project));
    this.tx.registerValidator(databaseValidator(this.project));
    this.events = new EventService(this.project);
    this.db = new DatabaseService(this.project);
    this.maps = new MapService(this.project);
  }
}

export class AppContext {
  private session: ProjectSession | null = null;
  private readonly sessions = new Map<string, ProjectSession>();

  constructor(readonly config: ServerConfig) {}

  /** Open the first configured project, if any (errors are deferred to the first tool call). */
  init(): string | null {
    if (!this.config.projects.length) return null;
    try {
      this.select(this.config.projects[0]!);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  current(): ProjectSession {
    if (!this.session) {
      throw new McpError(
        "PROJECT_NOT_FOUND",
        this.config.projects.length
          ? `No project is open. Configured projects: ${this.config.projects.join(", ")}. Use select_project.`
          : "No project configured. Start the server with --project <path to RPG Maker MZ project> (or RPGMZ_PROJECT).",
      );
    }
    return this.session;
  }

  select(rootOrIndex: string): ProjectSession {
    let root: string;
    if (/^\d+$/.test(rootOrIndex) && this.config.projects[Number(rootOrIndex)]) root = this.config.projects[Number(rootOrIndex)]!;
    else {
      const resolved = path.resolve(rootOrIndex);
      const configured = this.config.projects.find((p) => path.resolve(p) === resolved || path.basename(p) === rootOrIndex);
      if (configured) root = configured;
      else if (this.config.allowAnyProject) root = resolved;
      else {
        throw new McpError(
          "PATH_OUTSIDE_PROJECT",
          `"${rootOrIndex}" is not a configured project. Configured: ${this.config.projects.map((p, i) => `${i}: ${p}`).join("; ") || "(none)"}. Arbitrary paths require --allow-any-project.`,
        );
      }
    }
    const key = path.resolve(root);
    let s = this.sessions.get(key);
    if (!s) {
      s = new ProjectSession(key, this.config);
      this.sessions.set(key, s);
    }
    this.session = s;
    return s;
  }

  listProjects(): { index: number; root: string; selected: boolean }[] {
    const cur = this.session?.project.root;
    return this.config.projects.map((p, i) => ({ index: i, root: path.resolve(p), selected: cur === path.resolve(p) }));
  }
}

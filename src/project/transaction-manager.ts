import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DiagnosticBag, summarizeDiagnostics, type Diagnostic } from "../validation/diagnostics.js";
import { McpError } from "./errors.js";
import { hashBytes, type JsonSnapshot } from "./file-manager.js";
import { jsonDiff, lineChangeStats, type JsonChange } from "./json-diff.js";
import { defaultStyleForFile, detectJsonStyle, parseJsonText, serializeJson, type JsonStyle } from "./mz-json-format.js";
import type { ProjectService } from "./project-service.js";

/**
 * Shared transaction infrastructure for eventing and database writes
 * (EVENT_SPEC §11, DATABASE_SPEC §13).
 *
 * Flow:
 *  1. An operation mutates in-memory clones inside a `Workspace`.
 *  2. `stage()` serializes the touched files in their original layout,
 *     re-parses them, runs registered validators against the whole resulting
 *     state, builds native + semantic diffs and stores a pending ChangeSet.
 *  3. `apply()` re-checks every base file revision (stale detection), takes
 *     a lock, backs up originals, writes each file through a temp file +
 *     rename, and rolls everything back if any write fails. A transaction
 *     log entry records files, revisions and the backup location.
 *  4. `rollback()` restores a committed transaction's backups through the
 *     same staged/validated path, refusing if files changed since.
 */

/** Only native data files may be written (never plugins, scripts or assets). */
const WRITABLE_PATH = /^data\/[A-Za-z0-9_\-]+\.json$/;

interface TouchedFile {
  relPath: string;
  base: JsonSnapshot | null;
  data: unknown;
  style: JsonStyle;
}

export class Workspace {
  private readonly touched = new Map<string, TouchedFile>();
  /** Human-readable summaries of the operations performed. */
  readonly operations: string[] = [];
  /** Semantic (normalized) diff lines contributed by domain services. */
  readonly semanticDiff: string[] = [];
  /** Diagnostics raised by operations themselves (e.g. warnings about the request). */
  readonly diagnostics = new DiagnosticBag();
  destructive = false;
  /** Free-form scratch state for domain services (e.g. revision checks already done). */
  readonly scratch = new Map<string, unknown>();

  constructor(readonly project: ProjectService) {}

  /** Mutable clone of a data file (loaded once per workspace). */
  json<T = unknown>(relPath: string): T {
    let t = this.touched.get(relPath);
    if (!t) {
      const snap = this.project.files.readJson(relPath);
      t = { relPath, base: snap, data: structuredClone(snap.data), style: snap.style };
      this.touched.set(relPath, t);
    }
    return t.data as T;
  }

  /** Read-only view of a file as staged in this workspace (no clone, no touch); undefined if absent. */
  peek(relPath: string): unknown {
    const t = this.touched.get(relPath);
    if (t) return t.data;
    return this.project.files.exists(relPath) ? this.project.files.readJson(relPath).data : undefined;
  }

  /** The unmodified snapshot this workspace started from (null for files created in this workspace). */
  baseSnapshot(relPath: string): JsonSnapshot | null {
    const t = this.touched.get(relPath);
    if (t) return t.base;
    return this.project.files.exists(relPath) ? this.project.files.readJson(relPath) : null;
  }

  /** Replace a file's whole content (used by rollback). The base revision is still tracked. */
  replaceJson(relPath: string, data: unknown, style: JsonStyle): void {
    this.json(relPath);
    const t = this.touched.get(relPath)!;
    t.data = data;
    t.style = style;
  }

  createJson(relPath: string, data: unknown, style?: JsonStyle): void {
    if (this.touched.has(relPath) || this.project.files.exists(relPath)) {
      throw new McpError("INVALID_INPUT", `File already exists: ${relPath}`);
    }
    this.touched.set(relPath, { relPath, base: null, data, style: style ?? defaultStyleForFile(relPath) });
  }

  touchedFiles(): TouchedFile[] {
    return [...this.touched.values()];
  }

  isTouched(relPath: string): boolean {
    return this.touched.has(relPath);
  }
}

export interface ChangeSetFile {
  relPath: string;
  baseRevision: string | null;
  newRevision: string;
  created: boolean;
  lineStats: { linesBefore: number; linesAfter: number; changedLines: number };
  nativeDiff: JsonChange[];
  nativeDiffTruncated: boolean;
}

export interface ChangeSet {
  id: string;
  createdAt: string;
  description: string;
  operations: string[];
  semanticDiff: string[];
  files: ChangeSetFile[];
  diagnostics: Diagnostic[];
  diagnosticSummary: { errors: number; warnings: number; infos: number };
  destructive: boolean;
  /** True if nothing would change on disk. */
  empty: boolean;
  /** Present when the change set came from a rollback request. */
  rollbackOf?: string;
}

interface PendingChangeSet {
  changeSet: ChangeSet;
  texts: Map<string, string>;
  expiresAt: number;
}

export interface ApplyOptions {
  acknowledgeWarnings?: boolean;
  /** Required for destructive change sets; must equal the change set id. */
  confirm?: string;
}

export interface ApplyResult {
  transactionId: string;
  changeSetId: string;
  backupDir: string;
  files: { relPath: string; beforeRevision: string | null; afterRevision: string; created: boolean }[];
  warnings: string[];
}

export interface TransactionLogEntry {
  transactionId: string;
  changeSetId: string;
  timestamp: string;
  description: string;
  status: "committed" | "failed_rolled_back" | "failed_partial";
  rollbackOf?: string;
  backupDir: string;
  files: { relPath: string; beforeRevision: string | null; afterRevision: string; created: boolean }[];
  error?: string;
}

export type WorkspaceValidator = (ws: Workspace, changedFiles: string[]) => Diagnostic[];

const PENDING_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING = 100;

export class TransactionManager {
  private readonly pending = new Map<string, PendingChangeSet>();
  private readonly validators: WorkspaceValidator[] = [];
  private editorCheck: { at: number; running: boolean } | null = null;

  constructor(readonly project: ProjectService) {}

  registerValidator(v: WorkspaceValidator): void {
    this.validators.push(v);
  }

  workspace(): Workspace {
    return new Workspace(this.project);
  }

  // ------------------------------------------------------------------ staging

  stage(ws: Workspace, description: string, extra: { rollbackOf?: string } = {}): ChangeSet {
    this.gcPending();
    const texts = new Map<string, string>();
    const files: ChangeSetFile[] = [];
    const diags = new DiagnosticBag();
    diags.merge(ws.diagnostics.items);

    for (const t of ws.touchedFiles()) {
      if (!WRITABLE_PATH.test(t.relPath)) {
        throw new McpError("PATH_OUTSIDE_PROJECT", `Refusing to stage a write to a non-data file: ${t.relPath}`);
      }
      this.project.guard.resolve(t.relPath);
      const text = serializeJson(t.data, t.style);
      // Validate the complete serialized JSON before it can ever replace the original.
      let reparsed: unknown;
      try {
        reparsed = parseJsonText(text);
      } catch (err) {
        throw new McpError("WRITE_FAILED", `Serialized ${t.relPath} is not valid JSON: ${(err as Error).message}`);
      }
      const baseText = t.base?.text ?? "";
      if (t.base && text === baseText) continue; // unchanged on disk
      const { changes, truncated } = jsonDiff(t.base?.data ?? null, reparsed);
      texts.set(t.relPath, text);
      files.push({
        relPath: t.relPath,
        baseRevision: t.base?.revision ?? null,
        newRevision: hashBytes(Buffer.from(text, "utf8")),
        created: t.base === null,
        lineStats: lineChangeStats(baseText, text),
        nativeDiff: changes,
        nativeDiffTruncated: truncated,
      });
    }

    const changedFiles = files.map((f) => f.relPath);
    if (changedFiles.length > 0) {
      for (const v of this.validators) diags.merge(v(ws, changedFiles));
      if (this.isEditorRunning()) {
        diags.warning(
          "project.editor_running",
          "The RPG Maker MZ editor appears to be running. If this project is open in it, close the project (or reload it without saving) after applying, otherwise saving in the editor will overwrite these changes.",
        );
      }
    }

    const id = `cs_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const changeSet: ChangeSet = {
      id,
      createdAt: new Date().toISOString(),
      description,
      operations: [...ws.operations],
      semanticDiff: [...ws.semanticDiff],
      files,
      diagnostics: diags.items,
      diagnosticSummary: summarizeDiagnostics(diags.items),
      destructive: ws.destructive,
      empty: files.length === 0,
    };
    if (extra.rollbackOf) changeSet.rollbackOf = extra.rollbackOf;
    this.pending.set(id, { changeSet, texts, expiresAt: Date.now() + PENDING_TTL_MS });
    return changeSet;
  }

  getPending(id: string): ChangeSet {
    this.gcPending();
    const p = this.pending.get(id);
    if (!p) {
      throw new McpError(
        "CHANGESET_NOT_FOUND",
        `Change set ${id} was not found. It may have expired (1 hour), been applied already, or been invalidated by a newer read. Preview the change again.`,
      );
    }
    return p.changeSet;
  }

  discard(id: string): boolean {
    return this.pending.delete(id);
  }

  listPending(): ChangeSet[] {
    this.gcPending();
    return [...this.pending.values()].map((p) => p.changeSet);
  }

  // ------------------------------------------------------------------ apply

  apply(id: string, options: ApplyOptions = {}): ApplyResult {
    this.project.assertWritable();
    const p = this.pending.get(id);
    if (!p) this.getPending(id); // throws CHANGESET_NOT_FOUND
    const { changeSet, texts } = p!;

    if (changeSet.diagnosticSummary.errors > 0) {
      throw new McpError("VALIDATION_FAILED", `Change set ${id} has ${changeSet.diagnosticSummary.errors} validation error(s) and cannot be applied.`, {
        diagnostics: changeSet.diagnostics.filter((d) => d.severity === "error"),
      });
    }
    if (changeSet.diagnosticSummary.warnings > 0 && !options.acknowledgeWarnings) {
      throw new McpError(
        "WARNINGS_NOT_ACKNOWLEDGED",
        `Change set ${id} has ${changeSet.diagnosticSummary.warnings} warning(s). Review them and pass acknowledgeWarnings=true to apply.`,
        { diagnostics: changeSet.diagnostics.filter((d) => d.severity === "warning") },
      );
    }
    if (changeSet.destructive && options.confirm !== id) {
      throw new McpError(
        "CONFIRMATION_REQUIRED",
        `Change set ${id} is destructive. Pass confirm="${id}" to apply it.`,
      );
    }
    if (changeSet.empty) {
      this.pending.delete(id);
      return { transactionId: "", changeSetId: id, backupDir: "", files: [], warnings: ["No file changes; nothing was written."] };
    }

    const release = this.acquireLock();
    try {
      // Stale detection: every base file must still be exactly what we read.
      for (const f of changeSet.files) {
        const current = this.project.files.currentRevision(f.relPath);
        if (current !== f.baseRevision) {
          this.pending.delete(id);
          this.project.files.invalidate(f.relPath);
          throw new McpError(
            "STALE_CHANGESET",
            `${f.relPath} changed on disk after change set ${id} was previewed (expected revision ${f.baseRevision ?? "none"}, found ${current ?? "none"}). Re-read and preview again.`,
            { relPath: f.relPath },
          );
        }
      }
      return this.commit(changeSet, texts);
    } finally {
      release();
    }
  }

  private commit(changeSet: ChangeSet, texts: Map<string, string>): ApplyResult {
    const txId = `tx_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomBytes(3).toString("hex")}`;
    const backupRel = `${this.project.stateDir}/backups/${txId}`;
    const backupAbs = this.stateAbs(backupRel);
    fs.mkdirSync(backupAbs, { recursive: true });

    const fileEntries = changeSet.files.map((f) => ({
      relPath: f.relPath,
      beforeRevision: f.baseRevision,
      afterRevision: f.newRevision,
      created: f.created,
    }));

    // 1. Back up every original before touching anything.
    for (const f of changeSet.files) {
      if (f.created) continue;
      const src = this.project.guard.resolve(f.relPath);
      const dst = path.join(backupAbs, ...f.relPath.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    fs.writeFileSync(
      path.join(backupAbs, "manifest.json"),
      JSON.stringify({ transactionId: txId, changeSetId: changeSet.id, description: changeSet.description, files: fileEntries }, null, 2),
    );

    // 2. Write each file atomically; on failure restore what was written.
    const written: ChangeSetFile[] = [];
    try {
      for (const f of changeSet.files) {
        const abs = this.project.guard.resolve(f.relPath);
        atomicWrite(abs, texts.get(f.relPath)!);
        written.push(f);
        this.project.files.invalidate(f.relPath);
      }
    } catch (err) {
      let status: TransactionLogEntry["status"] = "failed_rolled_back";
      for (const f of written.reverse()) {
        try {
          const abs = this.project.guard.resolve(f.relPath);
          if (f.created) fs.rmSync(abs, { force: true });
          else atomicWrite(abs, fs.readFileSync(path.join(backupAbs, ...f.relPath.split("/")), "utf8"));
          this.project.files.invalidate(f.relPath);
        } catch {
          status = "failed_partial";
        }
      }
      this.appendLog({
        transactionId: txId,
        changeSetId: changeSet.id,
        timestamp: new Date().toISOString(),
        description: changeSet.description,
        status,
        backupDir: backupRel,
        files: fileEntries,
        error: (err as Error).message,
        ...(changeSet.rollbackOf ? { rollbackOf: changeSet.rollbackOf } : {}),
      });
      this.pending.delete(changeSet.id);
      throw new McpError(
        status === "failed_rolled_back" ? "WRITE_FAILED" : "ROLLBACK_FAILED",
        status === "failed_rolled_back"
          ? `Write failed and all files were restored: ${(err as Error).message}`
          : `Write failed AND restoring some files failed. Originals are in ${backupRel}. Error: ${(err as Error).message}`,
        { backupDir: backupRel },
      );
    }

    this.appendLog({
      transactionId: txId,
      changeSetId: changeSet.id,
      timestamp: new Date().toISOString(),
      description: changeSet.description,
      status: "committed",
      backupDir: backupRel,
      files: fileEntries,
      ...(changeSet.rollbackOf ? { rollbackOf: changeSet.rollbackOf } : {}),
    });
    this.pending.delete(changeSet.id);
    // Any other pending change set touching these files is now stale; drop it eagerly.
    for (const [pid, pc] of this.pending) {
      if (pc.changeSet.files.some((f) => texts.has(f.relPath))) this.pending.delete(pid);
    }
    const warnings = changeSet.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
    return { transactionId: txId, changeSetId: changeSet.id, backupDir: backupRel, files: fileEntries, warnings };
  }

  // ------------------------------------------------------------------ rollback & log

  readLog(): TransactionLogEntry[] {
    const abs = this.stateAbs(`${this.project.stateDir}/transactions.jsonl`);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readFileSync(abs, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as TransactionLogEntry];
        } catch {
          return [];
        }
      });
  }

  /** Stage a change set that restores the files of a committed transaction. */
  stageRollback(transactionId: string): ChangeSet {
    const entry = this.readLog().find((e) => e.transactionId === transactionId && e.status === "committed");
    if (!entry) throw new McpError("NOT_FOUND", `No committed transaction ${transactionId} in the transaction log.`);
    const ws = this.workspace();
    const backupAbs = this.stateAbs(entry.backupDir);
    for (const f of entry.files) {
      const current = this.project.files.currentRevision(f.relPath);
      if (current !== f.afterRevision) {
        throw new McpError(
          "STALE_REVISION",
          `${f.relPath} changed after transaction ${transactionId} (expected ${f.afterRevision}, found ${current ?? "missing"}). Refusing to roll back over newer changes.`,
        );
      }
      if (f.created) {
        throw new McpError("UNSUPPORTED", `Transaction ${transactionId} created ${f.relPath}; rolling back file creation is not supported. Restore manually from ${entry.backupDir}.`);
      }
      const backupText = fs.readFileSync(path.join(backupAbs, ...f.relPath.split("/")), "utf8");
      const restored = parseJsonText(backupText);
      ws.replaceJson(f.relPath, restored, detectJsonStyle(backupText, restored));
    }
    ws.operations.push(`Roll back transaction ${transactionId} (${entry.description})`);
    ws.destructive = true;
    return this.stage(ws, `Rollback of ${transactionId}`, { rollbackOf: transactionId });
  }

  // ------------------------------------------------------------------ internals

  private stateAbs(rel: string): string {
    const abs = path.resolve(this.project.root, ...rel.split("/"));
    this.project.guard.assertRealPathInside(abs, rel);
    return abs;
  }

  private appendLog(entry: TransactionLogEntry): void {
    const abs = this.stateAbs(`${this.project.stateDir}/transactions.jsonl`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, JSON.stringify(entry) + "\n");
  }

  private acquireLock(): () => void {
    const abs = this.stateAbs(`${this.project.stateDir}/write.lock`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(abs, "wx");
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fs.closeSync(fd);
        return () => fs.rmSync(abs, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const age = Date.now() - fs.statSync(abs).mtimeMs;
        if (age > 5 * 60 * 1000) {
          fs.rmSync(abs, { force: true }); // stale lock from a crashed process
          continue;
        }
        throw new McpError("WRITE_FAILED", `Another write is in progress (lock file ${this.project.stateDir}/write.lock). Try again shortly.`);
      }
    }
    throw new McpError("WRITE_FAILED", "Could not acquire the project write lock.");
  }

  private gcPending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  /** Best-effort detection of a running MZ editor (Windows only; cached for 30 s). */
  isEditorRunning(): boolean {
    if (process.platform !== "win32" || process.env.RPGMZ_MCP_SKIP_EDITOR_CHECK === "1") return false;
    if (this.editorCheck && Date.now() - this.editorCheck.at < 30_000) return this.editorCheck.running;
    let running = false;
    try {
      const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq RPGMZ.exe", "/NH"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      running = typeof r.stdout === "string" && /RPGMZ\.exe/i.test(r.stdout);
    } catch {
      running = false;
    }
    this.editorCheck = { at: Date.now(), running };
    return running;
  }
}

/** Write via temp file in the same directory, flush, then rename over the target. */
export function atomicWrite(abs: string, text: string): void {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: "utf8", flush: true });
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, abs);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) {
        /* brief synchronous back-off for Windows file locks */
      }
    }
  }
  fs.rmSync(tmp, { force: true });
  throw lastErr;
}

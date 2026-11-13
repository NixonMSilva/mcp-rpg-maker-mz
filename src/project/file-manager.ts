import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { McpError } from "./errors.js";
import { detectJsonStyle, parseJsonText, type JsonStyle } from "./mz-json-format.js";
import type { PathGuard } from "./path-guard.js";

export interface TextSnapshot {
  relPath: string;
  text: string;
  /** Content hash of the raw bytes; used as the file revision token. */
  revision: string;
  mtimeMs: number;
  size: number;
}

export interface JsonSnapshot<T = unknown> extends TextSnapshot {
  /** Parsed data. Shared with the cache: treat as read-only. Clone before mutating. */
  data: T;
  style: JsonStyle;
}

export function hashBytes(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * Read access to project files with revision tracking and a small
 * stat-validated cache. All paths are project-relative and confined by the
 * PathGuard. This class never writes; writes go through TransactionManager.
 */
export class FileManager {
  private readonly cache = new Map<string, JsonSnapshot>();

  constructor(private readonly guard: PathGuard) {}

  exists(relPath: string): boolean {
    try {
      return fs.statSync(this.guard.resolve(relPath)).isFile();
    } catch (err) {
      if (err instanceof McpError) throw err;
      return false;
    }
  }

  readText(relPath: string): TextSnapshot {
    const abs = this.guard.resolve(relPath);
    let buf: Buffer;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
      buf = fs.readFileSync(abs);
    } catch {
      throw new McpError("FILE_NOT_FOUND", `File not found in project: ${relPath}`, { relPath });
    }
    return {
      relPath,
      text: buf.toString("utf8"),
      revision: hashBytes(buf),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  }

  /** Raw bytes of a project file (e.g. images), or null if it does not exist. */
  readBytes(relPath: string): { bytes: Buffer; mtimeMs: number; size: number } | null {
    const abs = this.guard.resolve(relPath);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return null;
      return { bytes: fs.readFileSync(abs), mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  /** Stat-only check used by caches. */
  statFile(relPath: string): { mtimeMs: number; size: number } | null {
    try {
      const stat = fs.statSync(this.guard.resolve(relPath));
      return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
    } catch (err) {
      if (err instanceof McpError) throw err;
      return null;
    }
  }

  /** Current revision of a file on disk, or null if it does not exist. */
  currentRevision(relPath: string): string | null {
    const abs = this.guard.resolve(relPath);
    try {
      return hashBytes(fs.readFileSync(abs));
    } catch {
      return null;
    }
  }

  readJson<T = unknown>(relPath: string): JsonSnapshot<T> {
    const abs = this.guard.resolve(relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new McpError("FILE_NOT_FOUND", `File not found in project: ${relPath}`, { relPath });
    }
    const cached = this.cache.get(relPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached as JsonSnapshot<T>;
    }
    const snap = this.readText(relPath);
    let data: unknown;
    try {
      data = parseJsonText(snap.text);
    } catch (err) {
      throw new McpError("MALFORMED_JSON", `${relPath} is not valid JSON: ${(err as Error).message}`, { relPath });
    }
    const out: JsonSnapshot = { ...snap, data, style: detectJsonStyle(snap.text, data) };
    this.cache.set(relPath, out);
    return out as JsonSnapshot<T>;
  }

  invalidate(relPath?: string): void {
    if (relPath === undefined) this.cache.clear();
    else this.cache.delete(relPath);
  }

  listDir(relDir: string): string[] {
    const abs = this.guard.resolve(relDir);
    try {
      return fs.readdirSync(abs);
    } catch {
      return [];
    }
  }
}

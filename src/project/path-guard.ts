import * as fs from "node:fs";
import * as path from "node:path";
import { McpError } from "./errors.js";

/**
 * Confines every file access to a project root.
 *
 * - Rejects absolute paths, drive letters, NUL bytes and ".." traversal.
 * - Resolves symlinks/junctions of the target (or its nearest existing
 *   ancestor) and rejects anything whose real path escapes the root.
 */
export class PathGuard {
  readonly root: string;
  readonly realRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync.native(this.root);
  }

  /** Resolve a project-relative path (forward or back slashes) to an absolute path inside the root. */
  resolve(relPath: string): string {
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new McpError("PATH_OUTSIDE_PROJECT", "Empty path.");
    }
    if (relPath.includes("\0")) {
      throw new McpError("PATH_OUTSIDE_PROJECT", "Path contains a NUL byte.");
    }
    if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith("\\\\")) {
      throw new McpError("PATH_OUTSIDE_PROJECT", `Absolute paths are not accepted: ${relPath}`);
    }
    const segments = relPath.split(/[\\/]+/);
    if (segments.some((s) => s === "..")) {
      throw new McpError("PATH_OUTSIDE_PROJECT", `Path traversal is not allowed: ${relPath}`);
    }
    const abs = path.resolve(this.root, ...segments);
    if (!isInside(this.root, abs)) {
      throw new McpError("PATH_OUTSIDE_PROJECT", `Path escapes the project root: ${relPath}`);
    }
    this.assertRealPathInside(abs, relPath);
    return abs;
  }

  /** Verify the real (symlink-resolved) location of `abs` or its nearest existing ancestor stays inside the root. */
  assertRealPathInside(abs: string, label: string = abs): void {
    let probe = abs;
    for (;;) {
      try {
        const real = fs.realpathSync.native(probe);
        const rest = path.relative(probe, abs);
        const finalReal = rest ? path.join(real, rest) : real;
        if (!isInside(this.realRoot, finalReal)) {
          throw new McpError("PATH_OUTSIDE_PROJECT", `Path resolves outside the project root (symlink escape): ${label}`);
        }
        return;
      } catch (err) {
        if (err instanceof McpError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) {
          throw new McpError("PATH_OUTSIDE_PROJECT", `Cannot resolve path: ${label}`);
        }
        probe = parent;
      }
    }
  }

  /** Convert an absolute path inside the root to the canonical project-relative form (forward slashes). */
  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

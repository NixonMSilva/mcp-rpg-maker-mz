import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Remove temporary project copies from previous runs (tests/.tmp is gitignored). */
export default function setup(): void {
  const tmp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
}

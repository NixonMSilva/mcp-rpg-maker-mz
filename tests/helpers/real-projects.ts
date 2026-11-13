import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Optional corpus of real RPG Maker MZ `data` directories used by the
 * read-only round-trip tests. Nothing machine-specific is committed:
 *
 *  - RPGMZ_TEST_DATA_DIRS: path-delimited list of `data` folders (";" on Windows, ":" elsewhere), or
 *  - tests/real-data.local.json (gitignored): { "dataDirs": ["C:/path/to/Game/data", ...] }
 *
 * Tests using the corpus are skipped when no folder is configured or found.
 */
export function realDataDirs(): string[] {
  const env = process.env.RPGMZ_TEST_DATA_DIRS;
  let candidates: string[] = [];
  if (env) candidates = env.split(path.delimiter);
  else {
    const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../real-data.local.json");
    if (fs.existsSync(local)) {
      const cfg = JSON.parse(fs.readFileSync(local, "utf8")) as { dataDirs?: unknown };
      if (Array.isArray(cfg.dataDirs)) candidates = cfg.dataDirs.filter((d): d is string => typeof d === "string");
    }
  }
  return candidates.filter((d) => d && fs.existsSync(d) && fs.statSync(d).isDirectory());
}

export interface CorpusList {
  source: string;
  list: unknown[];
}

/** Every event command list (map pages, common events, troop pages) in the corpus. */
export function* corpusLists(dirs: string[]): Generator<CorpusList> {
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      let j: unknown;
      try {
        j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
      } catch {
        continue;
      }
      const tag = `${path.basename(path.dirname(d))}/${f}`;
      const out: CorpusList[] = [];
      if (/^Map\d+\.json$/.test(f)) {
        for (const e of (j as { events?: unknown[] }).events ?? []) {
          if (!e || typeof e !== "object") continue;
          const ev = e as { id: number; pages: { list: unknown[] }[] };
          ev.pages.forEach((p, pi) => {
            if (Array.isArray(p.list)) out.push({ source: `${tag}#ev${ev.id}p${pi}`, list: p.list });
          });
        }
      } else if (f === "CommonEvents.json" && Array.isArray(j)) {
        for (const ce of j) if (ce && Array.isArray(ce.list)) out.push({ source: `${tag}#ce${ce.id}`, list: ce.list });
      } else if (f === "Troops.json" && Array.isArray(j)) {
        for (const t of j) if (t) (t.pages as { list: unknown[] }[]).forEach((p, pi) => out.push({ source: `${tag}#troop${t.id}p${pi}`, list: p.list }));
      }
      yield* out;
    }
  }
}

export function* corpusJsonFiles(dirs: string[]): Generator<{ file: string; text: string }> {
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      yield { file: path.join(d, f), text: fs.readFileSync(path.join(d, f), "utf8") };
    }
  }
}

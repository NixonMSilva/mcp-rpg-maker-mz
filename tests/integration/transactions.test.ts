import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { McpError } from "../../src/project/errors.js";
import { MAP2, readText, session } from "../helpers/fixture.js";

const target = { kind: "map_event_page" as const, mapId: 2, eventId: 1, pageIndex: 0 };

function stageTextChange(s: ReturnType<typeof session>, text = "Added line") {
  const ws = s.tx.workspace();
  s.events.editLogic(ws, target, { op: "append", blocks: [{ type: "show_text", text }] });
  return s.tx.stage(ws, "append text");
}

describe("transactions", () => {
  it("previews without touching disk, then backs up and writes atomically", () => {
    const s = session();
    const original = readText(s.root, MAP2);
    const cs = stageTextChange(s);
    expect(readText(s.root, MAP2)).toBe(original);
    expect(cs.files[0]!.nativeDiff.some((d) => d.kind === "added")).toBe(true);

    const r = s.tx.apply(cs.id);
    const backup = path.join(s.root, ...r.backupDir.split("/"), "data", "Map002.json");
    expect(fs.readFileSync(backup, "utf8")).toBe(original);
    expect(readText(s.root, MAP2)).not.toBe(original);
    // No temp files left behind.
    expect(fs.readdirSync(path.join(s.root, "data")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // Transaction log.
    const log = s.tx.readLog();
    expect(log.at(-1)).toMatchObject({ transactionId: r.transactionId, status: "committed", files: [{ relPath: MAP2 }] });
    // A change set cannot be applied twice.
    expect(() => s.tx.apply(cs.id)).toThrow(/not found/);
  });

  it("only changes the edited line of the file (minimal diff in editor layout)", () => {
    const s = session();
    const before = readText(s.root, MAP2).split("\n");
    s.tx.apply(stageTextChange(s).id);
    const after = readText(s.root, MAP2).split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('"name":"Villager"');
  });

  it("rejects stale previews when the file changed on disk (e.g. the editor saved)", () => {
    const s = session();
    const cs = stageTextChange(s);
    const abs = path.join(s.root, MAP2);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace('"Villager"', '"Villager2"'));
    try {
      s.tx.apply(cs.id);
      expect.unreachable();
    } catch (err) {
      expect((err as McpError).code).toBe("STALE_CHANGESET");
    }
    expect(readText(s.root, MAP2)).toContain("Villager2");
  });

  it("invalidates other pending previews of the same file after a commit", () => {
    const s = session();
    const a = stageTextChange(s, "A");
    const b = stageTextChange(s, "B");
    s.tx.apply(a.id);
    expect(() => s.tx.apply(b.id)).toThrow(McpError);
  });

  it("is read-only unless write access was enabled", () => {
    const s = session(undefined, false);
    const cs = stageTextChange(s);
    expect(cs.files).toHaveLength(1);
    try {
      s.tx.apply(cs.id);
      expect.unreachable();
    } catch (err) {
      expect((err as McpError).code).toBe("WRITE_DISABLED");
    }
  });

  it("rolls back a committed transaction and refuses when files changed since", () => {
    const s = session();
    const original = readText(s.root, MAP2);
    const r = s.tx.apply(stageTextChange(s).id);
    const rb = s.tx.stageRollback(r.transactionId);
    expect(rb.destructive).toBe(true);
    s.tx.apply(rb.id, { confirm: rb.id, acknowledgeWarnings: true });
    expect(readText(s.root, MAP2)).toBe(original);

    const r2 = s.tx.apply(stageTextChange(s, "again").id);
    s.tx.apply(stageTextChange(s, "newer").id);
    expect(() => s.tx.stageRollback(r2.transactionId)).toThrow(/changed after/);
  });

  it("restores every file if a multi-file write fails midway", () => {
    const s = session();
    const ws = s.tx.workspace();
    s.events.editLogic(ws, target, { op: "append", blocks: [{ type: "wait", frames: 5 }] });
    s.db.updateRecord(ws, "item", 1, { price: 77 });
    const cs = s.tx.stage(ws, "two files");
    expect(cs.files).toHaveLength(2);
    const originals = cs.files.map((f) => readText(s.root, f.relPath));
    // Make the second file unwritable so the rename fails after the first file was replaced.
    const second = path.join(s.root, ...cs.files[1]!.relPath.split("/"));
    fs.chmodSync(second, 0o444);
    let failed = false;
    try {
      s.tx.apply(cs.id, { acknowledgeWarnings: true });
    } catch (err) {
      failed = true;
      expect(["WRITE_FAILED", "ROLLBACK_FAILED"]).toContain((err as McpError).code);
    } finally {
      fs.chmodSync(second, 0o666);
    }
    // On Windows a read-only target cannot be replaced, so the failure path must have run.
    if (process.platform === "win32") expect(failed).toBe(true);
    if (!failed) {
      // Platforms where read-only files can still be replaced by rename (POSIX) cannot simulate this failure.
      return;
    }
    expect(cs.files.map((f) => readText(s.root, f.relPath))).toEqual(originals);
    expect(s.tx.readLog().at(-1)!.status).toBe("failed_rolled_back");
  });

  it("refuses to stage writes outside data/*.json", () => {
    const s = session();
    const ws = s.tx.workspace();
    ws.createJson("js/evil.json", {});
    expect(() => s.tx.stage(ws, "evil")).toThrow(/non-data file/);
  });

  it("produces an empty change set when nothing changes", () => {
    const s = session();
    const ws = s.tx.workspace();
    ws.json(MAP2); // touched but unchanged
    const cs = s.tx.stage(ws, "noop");
    expect(cs.empty).toBe(true);
    expect(s.tx.apply(cs.id).files).toEqual([]);
  });
});

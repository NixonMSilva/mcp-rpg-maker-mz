/**
 * Structural JSON diff used for change previews ("native diff"). Map files
 * store each event on a single line, so a text line diff is unreadable;
 * instead we report changes as JSON paths with truncated values.
 */
export interface JsonChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

const MAX_VALUE_CHARS = 240;

export function preview(v: unknown, max = MAX_VALUE_CHARS): string {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return Number.isNaN(a) && Number.isNaN(b);
}

function pathJoin(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`;
}

/**
 * Compute a structural diff. Arrays are aligned with an LCS over element
 * equality when small enough so insertions/removals are reported as such
 * rather than as a cascade of index changes.
 */
export function jsonDiff(before: unknown, after: unknown, maxChanges = 200): { changes: JsonChange[]; truncated: boolean } {
  const changes: JsonChange[] = [];
  let truncated = false;
  const push = (c: JsonChange) => {
    if (changes.length >= maxChanges) {
      truncated = true;
      return;
    }
    changes.push(c);
  };

  const walk = (a: unknown, b: unknown, p: string): void => {
    if (truncated) return;
    if (deepEqual(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      diffArrays(a, b, p);
      return;
    }
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(a)) {
        if (!(k in b)) push({ path: pathJoin(p, k), kind: "removed", before: preview(a[k]) });
        else walk(a[k], b[k], pathJoin(p, k));
      }
      for (const k of Object.keys(b)) {
        if (!(k in a)) push({ path: pathJoin(p, k), kind: "added", after: preview(b[k]) });
      }
      return;
    }
    push({ path: p || "(root)", kind: "changed", before: preview(a), after: preview(b) });
  };

  const diffArrays = (a: unknown[], b: unknown[], p: string): void => {
    // Same length: compare positionally (common for in-place edits).
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], pathJoin(p, i));
      return;
    }
    const n = a.length;
    const m = b.length;
    if (n * m > 4_000_000) {
      const min = Math.min(n, m);
      for (let i = 0; i < min; i++) walk(a[i], b[i], pathJoin(p, i));
      for (let i = min; i < n; i++) push({ path: pathJoin(p, i), kind: "removed", before: preview(a[i]) });
      for (let i = min; i < m; i++) push({ path: pathJoin(p, i), kind: "added", after: preview(b[i]) });
      return;
    }
    // Trim common prefix/suffix first, then LCS the middle.
    let start = 0;
    while (start < n && start < m && deepEqual(a[start], b[start])) start++;
    let endA = n;
    let endB = m;
    while (endA > start && endB > start && deepEqual(a[endA - 1], b[endB - 1])) {
      endA--;
      endB--;
    }
    const aa = a.slice(start, endA);
    const bb = b.slice(start, endB);
    const keyA = aa.map((x) => JSON.stringify(x));
    const keyB = bb.map((x) => JSON.stringify(x));
    const lcs: number[][] = Array.from({ length: aa.length + 1 }, () => new Array<number>(bb.length + 1).fill(0));
    for (let i = aa.length - 1; i >= 0; i--) {
      for (let j = bb.length - 1; j >= 0; j--) {
        lcs[i]![j] = keyA[i] === keyB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < aa.length || j < bb.length) {
      if (i < aa.length && j < bb.length && keyA[i] === keyB[j]) {
        i++;
        j++;
      } else if (j < bb.length && (i >= aa.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
        push({ path: pathJoin(p, start + j), kind: "added", after: preview(bb[j]) });
        j++;
      } else {
        push({ path: pathJoin(p, start + i), kind: "removed", before: preview(aa[i]) });
        i++;
      }
    }
  };

  walk(before, after, "");
  return { changes, truncated };
}

/** Count changed lines between two texts (cheap stat for file summaries). */
export function lineChangeStats(before: string, after: string): { linesBefore: number; linesAfter: number; changedLines: number } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const setA = new Map<string, number>();
  for (const l of a) setA.set(l, (setA.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = setA.get(l) ?? 0;
    if (c > 0) {
      common++;
      setA.set(l, c - 1);
    }
  }
  return { linesBefore: a.length, linesAfter: b.length, changedLines: a.length + b.length - 2 * common };
}

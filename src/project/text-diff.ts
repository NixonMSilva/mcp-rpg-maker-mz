/**
 * Minimal line diff (LCS) producing unified-style output with context, used
 * for semantic (normalized) previews such as described event logic.
 */
export function lineDiff(before: readonly string[], after: readonly string[], context = 2, maxLines = 200): string[] {
  const n = before.length;
  const m = after.length;
  if (n * m > 2_000_000) {
    return [`(diff too large: ${n} → ${m} lines)`];
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { op: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      ops.push({ op: " ", text: before[i]! });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ op: "+", text: after[j]! });
      j++;
    } else {
      ops.push({ op: "-", text: before[i]! });
      i++;
    }
  }
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.op !== " ") for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = true;
  });
  const out: string[] = [];
  let skipped = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      skipped = true;
      continue;
    }
    if (skipped && out.length) out.push("  …");
    skipped = false;
    out.push(`${ops[k]!.op} ${ops[k]!.text}`);
    if (out.length >= maxLines) {
      out.push(`… diff truncated at ${maxLines} lines`);
      break;
    }
  }
  return out;
}

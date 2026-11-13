/**
 * Serializer that reproduces the RPG Maker MZ editor's on-disk JSON layout.
 *
 * Verified against real projects (see tests/round-trip/format.test.ts): the
 * editor writes three layouts:
 *  - "record-array": database files (Actors.json, MapInfos.json, ...):
 *        "[\n" + records.map(JSON.stringify).join(",\n") + "\n]"
 *  - "map": MapXXX.json:
 *        "{\n" + <header pairs on one line> + ",\n\"data\":[...],\n\"events\":" + <record-array> + "\n}"
 *  - "compact": System.json: a single JSON.stringify line.
 *
 * Files written by other tools may use CRLF line endings or pretty-printed
 * indentation; the detected style is reused when re-serializing so that an
 * unchanged document produces byte-identical output and a changed document
 * produces a minimal diff.
 */

export type JsonLayout =
  | { kind: "compact" }
  | { kind: "record-array" }
  | { kind: "map" }
  | { kind: "pretty"; indent: string | number };

export interface JsonStyle {
  layout: JsonLayout;
  eol: "\n" | "\r\n";
  bom: boolean;
  trailingNewline: boolean;
}

function recordArray(arr: unknown[], eol: string): string {
  if (arr.length === 0) return `[${eol}]`;
  return `[${eol}${arr.map((x) => JSON.stringify(x) ?? "null").join(`,${eol}`)}${eol}]`;
}

function mapLayout(obj: Record<string, unknown>, eol: string): string | undefined {
  const keys = Object.keys(obj);
  // The editor always places "data" then "events" last.
  if (keys.length < 2 || keys[keys.length - 2] !== "data" || keys[keys.length - 1] !== "events") return undefined;
  if (!Array.isArray(obj.events)) return undefined;
  const head = keys
    .slice(0, -2)
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`)
    .join(",");
  const headPart = head.length > 0 ? `${head},${eol}` : "";
  return `{${eol}${headPart}"data":${JSON.stringify(obj.data)},${eol}"events":${recordArray(obj.events, eol)}${eol}}`;
}

function render(data: unknown, layout: JsonLayout, eol: string): string | undefined {
  switch (layout.kind) {
    case "compact":
      return JSON.stringify(data);
    case "record-array":
      return Array.isArray(data) ? recordArray(data, eol) : undefined;
    case "map":
      return data !== null && typeof data === "object" && !Array.isArray(data)
        ? mapLayout(data as Record<string, unknown>, eol)
        : undefined;
    case "pretty": {
      const s = JSON.stringify(data, null, layout.indent);
      return eol === "\n" ? s : s.replace(/\n/g, eol);
    }
  }
}

/** Detect the layout used by `text` (whose parsed value is `data`). */
export function detectJsonStyle(text: string, data: unknown): JsonStyle {
  let body = text;
  const bom = body.charCodeAt(0) === 0xfeff;
  if (bom) body = body.slice(1);
  const eol: "\n" | "\r\n" = body.includes("\r\n") ? "\r\n" : "\n";
  let trailingNewline = false;
  if (body.endsWith(eol)) {
    trailingNewline = true;
    body = body.slice(0, -eol.length);
  }
  const candidates: JsonLayout[] = [{ kind: "record-array" }, { kind: "map" }, { kind: "compact" }];
  const indentMatch = /^[[{]\r?\n([ \t]+)\S/.exec(body);
  if (indentMatch?.[1]) {
    const ws = indentMatch[1];
    candidates.unshift({ kind: "pretty", indent: /^ +$/.test(ws) ? ws.length : ws });
  }
  for (const layout of candidates) {
    if (render(data, layout, eol) === body) return { layout, eol, bom, trailingNewline };
  }
  // Unknown layout: pick the closest structural default.
  let fallback: JsonLayout;
  if (indentMatch?.[1]) {
    const ws = indentMatch[1];
    fallback = { kind: "pretty", indent: /^ +$/.test(ws) ? ws.length : ws };
  } else if (Array.isArray(data) && (body.startsWith("[\n") || body.startsWith("[\r\n"))) {
    fallback = { kind: "record-array" };
  } else if (data !== null && typeof data === "object" && "events" in (data as object)) {
    fallback = { kind: "map" };
  } else {
    fallback = { kind: "compact" };
  }
  return { layout: fallback, eol, bom, trailingNewline };
}

/** Default style for a data file that does not yet exist, by file name. */
export function defaultStyleForFile(fileName: string): JsonStyle {
  const base = fileName.replace(/^.*[\\/]/, "");
  let layout: JsonLayout;
  if (/^Map\d{3,}\.json$/i.test(base)) layout = { kind: "map" };
  else if (/^System\.json$/i.test(base)) layout = { kind: "compact" };
  else layout = { kind: "record-array" };
  return { layout, eol: "\n", bom: false, trailingNewline: false };
}

export function serializeJson(data: unknown, style: JsonStyle): string {
  let out = render(data, style.layout, style.eol);
  if (out === undefined) {
    // Data no longer fits the layout (e.g. a map lost its "events" key); fall back safely.
    out = Array.isArray(data) ? recordArray(data, style.eol) : JSON.stringify(data);
  }
  if (style.trailingNewline) out += style.eol;
  if (style.bom) out = "﻿" + out;
  return out;
}

export function parseJsonText(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(body);
}

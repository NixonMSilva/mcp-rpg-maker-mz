import type { MzEnum } from "../../adapters/rpg-maker-mz/enum-catalog.js";
import { invalidInput } from "../../project/errors.js";

/**
 * Helpers used to normalize agent-supplied IR into canonical IR. Every
 * failure throws INVALID_INPUT with the JSON path of the offending field.
 */

export type Obj = Record<string, unknown>;

export interface NormalizeContext {
  /** True when the user explicitly authorized inserting script/JS content. */
  allowScript: boolean;
  /** Script texts already present on the target page (re-submitting them needs no authorization). */
  existingScripts: ReadonlySet<string>;
}

export const DEFAULT_NORMALIZE_CONTEXT: NormalizeContext = { allowScript: false, existingScripts: new Set() };

export function asObj(v: unknown, path: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw invalidInput(`${path}: expected an object.`);
  return v as Obj;
}

export function has(o: Obj, key: string): boolean {
  return o[key] !== undefined;
}

export function int(o: Obj, key: string, path: string, opts: { min?: number; max?: number; def?: number } = {}): number {
  const v = o[key];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    throw invalidInput(`${path}.${key}: required integer is missing.`);
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw invalidInput(`${path}.${key}: expected an integer, got ${JSON.stringify(v)}.`);
  if (opts.min !== undefined && v < opts.min) throw invalidInput(`${path}.${key}: must be >= ${opts.min} (got ${v}).`);
  if (opts.max !== undefined && v > opts.max) throw invalidInput(`${path}.${key}: must be <= ${opts.max} (got ${v}).`);
  return v;
}

export function num(o: Obj, key: string, path: string, opts: { min?: number; max?: number; def?: number } = {}): number {
  const v = o[key];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    throw invalidInput(`${path}.${key}: required number is missing.`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalidInput(`${path}.${key}: expected a number, got ${JSON.stringify(v)}.`);
  if (opts.min !== undefined && v < opts.min) throw invalidInput(`${path}.${key}: must be >= ${opts.min} (got ${v}).`);
  if (opts.max !== undefined && v > opts.max) throw invalidInput(`${path}.${key}: must be <= ${opts.max} (got ${v}).`);
  return v;
}

export function bool(o: Obj, key: string, path: string, def?: boolean): boolean {
  const v = o[key];
  if (v === undefined) {
    if (def !== undefined) return def;
    throw invalidInput(`${path}.${key}: required boolean is missing.`);
  }
  if (typeof v !== "boolean") throw invalidInput(`${path}.${key}: expected true/false, got ${JSON.stringify(v)}.`);
  return v;
}

export function str(o: Obj, key: string, path: string, def?: string): string {
  const v = o[key];
  if (v === undefined) {
    if (def !== undefined) return def;
    throw invalidInput(`${path}.${key}: required string is missing.`);
  }
  if (typeof v !== "string") throw invalidInput(`${path}.${key}: expected a string, got ${JSON.stringify(v)}.`);
  return v;
}

export function enumKey<V extends number | string>(o: Obj, key: string, path: string, en: MzEnum<V>, def?: V): V {
  const v = o[key];
  if (v === undefined) {
    if (def !== undefined) return def;
    throw invalidInput(`${path}.${key}: required value is missing. Options: ${en.options()}.`);
  }
  return en.parse(v, `${path}.${key}`);
}

/** Text lines from either `lines: string[]` or `text: string` (split on newlines). */
export function textLines(o: Obj, path: string, opts: { allowEmpty?: boolean } = {}): string[] {
  if (o.lines !== undefined) {
    if (!Array.isArray(o.lines) || o.lines.some((l) => typeof l !== "string")) {
      throw invalidInput(`${path}.lines: expected an array of strings.`);
    }
    const lines = o.lines as string[];
    if (lines.some((l) => /[\r\n]/.test(l))) throw invalidInput(`${path}.lines: individual lines must not contain newlines.`);
    if (!opts.allowEmpty && lines.length === 0) throw invalidInput(`${path}.lines: at least one line is required.`);
    return [...lines];
  }
  if (typeof o.text === "string") return o.text.split(/\r?\n/);
  if (opts.allowEmpty) return [];
  throw invalidInput(`${path}: provide "text" (string) or "lines" (string[]).`);
}

export function audio(v: unknown, path: string): { name: string; volume: number; pitch: number; pan: number } {
  if (typeof v === "string") return { name: v, volume: 90, pitch: 100, pan: 0 };
  const o = asObj(v, path);
  return {
    name: str(o, "name", path),
    volume: int(o, "volume", path, { min: 0, max: 100, def: 90 }),
    pitch: int(o, "pitch", path, { min: 50, max: 150, def: 100 }),
    pan: int(o, "pan", path, { min: -100, max: 100, def: 0 }),
  };
}

export function requireScriptAuthorization(text: string, ctx: NormalizeContext, path: string): void {
  if (ctx.allowScript || ctx.existingScripts.has(text)) return;
  throw invalidInput(
    `${path}: inserting JavaScript (script commands, script conditions/operands, route scripts) requires explicit user authorization. Re-run with allowScript=true only if the user asked for this script.`,
  );
}

export function rejectUnknownKeys(o: Obj, allowed: readonly string[], path: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k) && k !== "type" && k !== "id");
  if (extra.length) throw invalidInput(`${path}: unknown field(s) ${extra.map((k) => JSON.stringify(k)).join(", ")}. Allowed: ${allowed.join(", ")}.`);
}

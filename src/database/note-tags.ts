/**
 * Note-tag handling (DATABASE_SPEC §8). The note text is preserved exactly;
 * targeted edits only touch the addressed tag. Recognized syntaxes (the
 * conventions used by the MZ engine's DataManager.extractMetadata):
 *
 *   <Tag>              flag tag              → meta.Tag = true
 *   <Tag: value>       value tag             → meta.Tag = "value"
 *   <Tag:value>        (no space)
 *
 * Block tags such as <Tag>...</Tag> are reported but never rewritten.
 */

export interface NoteTag {
  name: string;
  value: string | true;
  /** Character offset of the tag in the note. */
  index: number;
  raw: string;
}

const TAG_RE = /<([^<>:]+)(:?)([^>]*)>/g;

/** Same parsing rule as DataManager.extractMetadata in rmmz_managers.js. */
export function parseNoteTags(note: string): NoteTag[] {
  const out: NoteTag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(note))) {
    const name = m[1]!;
    if (name.startsWith("/")) continue; // closing tag of a block
    out.push({ name, value: m[2] === ":" ? m[3]! : true, index: m.index, raw: m[0] });
  }
  return out;
}

export function noteMeta(note: string): Record<string, string | true> {
  const meta: Record<string, string | true> = {};
  for (const t of parseNoteTags(note)) meta[t.name] = t.value;
  return meta;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Set (or add) a tag. Existing occurrences of the same tag are rewritten in
 * place (keeping the original spacing after ':'); other text is untouched.
 * `value === true` writes a flag tag. Returns the new note.
 */
export function setNoteTag(note: string, name: string, value: string | true): string {
  if (/[<>]/.test(name) || name.includes(":")) throw new Error(`Invalid tag name ${JSON.stringify(name)}.`);
  if (typeof value === "string" && /[<>]/.test(value)) throw new Error("Tag values must not contain < or >.");
  const re = new RegExp(`<${escapeRe(name)}(:\\s*)?([^>]*)>`);
  const m = re.exec(note);
  const render = (sep: string | undefined) => (value === true ? `<${name}>` : `<${name}${sep ?? ": "}${value}>`);
  if (m && (m[1] !== undefined || m[2] === "")) {
    return note.slice(0, m.index) + render(m[1]) + note.slice(m.index + m[0].length);
  }
  const tag = render(undefined);
  if (note === "") return tag;
  const eol = note.includes("\r\n") ? "\r\n" : "\n";
  return note.endsWith("\n") ? note + tag : note + eol + tag;
}

/** Remove every occurrence of a single-line tag; returns the new note and how many were removed. */
export function removeNoteTag(note: string, name: string): { note: string; removed: number } {
  const tag = `<${escapeRe(name)}(?::[^>]*)?>`;
  let removed = 0;
  // Tags alone on their line: drop the whole line (with its line break).
  const lines = note.split(/(\r?\n)/); // keeps separators at odd indexes
  const whole = new RegExp(`^[ \\t]*${tag}[ \\t]*$`);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i]!;
    const sep = lines[i + 1] ?? "";
    if (whole.test(line)) {
      removed++;
      // Removing the last line: also drop the separator that preceded it.
      if (sep === "" && kept.length >= 2) kept.pop();
      continue;
    }
    kept.push(line, sep);
  }
  let out = kept.join("");
  // Inline occurrences: remove just the tag text.
  out = out.replace(new RegExp(tag, "g"), () => {
    removed++;
    return "";
  });
  return { note: out, removed };
}

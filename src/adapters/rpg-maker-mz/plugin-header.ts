/**
 * Parser for MZ plugin annotation headers (the `/*: ... *\/` comment block).
 * Text only: plugin code is never executed (EVENT_SPEC §13). The resulting
 * command schemas are INFERRED from annotations and reported as such.
 *
 *   @command Name      starts a command
 *   @text / @desc      label / description of the current command or argument
 *   @arg name          starts an argument of the current command
 *   @type / @default   argument type / default value
 */
export interface PluginArgSchema {
  name: string;
  text?: string;
  desc?: string;
  type?: string;
  default?: string;
}

export interface PluginCommandSchema {
  name: string;
  text?: string;
  desc?: string;
  args: PluginArgSchema[];
}

export interface PluginHeader {
  target?: string;
  plugindesc?: string;
  commands: PluginCommandSchema[];
  /** Always "inferred": derived from annotations, not authoritative. */
  confidence: "inferred";
}

/** Parse the default-language header block (`/*:` without a language suffix, falling back to the first `/*:xx` block). */
export function parsePluginHeader(source: string): PluginHeader | null {
  const blocks = [...source.matchAll(/\/\*:([a-zA-Z_]*)\s*\n([\s\S]*?)\*\//g)];
  if (!blocks.length) return null;
  const block = blocks.find((b) => b[1] === "") ?? blocks.find((b) => b[1] === "en") ?? blocks[0]!;
  const out: PluginHeader = { commands: [], confidence: "inferred" };
  let cmd: PluginCommandSchema | null = null;
  let arg: PluginArgSchema | null = null;
  let inParam = false;
  for (const raw of block[2]!.split(/\r?\n/)) {
    const line = raw.replace(/^\s*\*?\s?/, "");
    const m = /^@(\w+)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, tag, value = ""] = m;
    const v = value.trim();
    switch (tag) {
      case "target":
        out.target = v;
        break;
      case "plugindesc":
        out.plugindesc = v;
        break;
      case "param":
        inParam = true;
        arg = null;
        break;
      case "command":
        cmd = { name: v, args: [] };
        out.commands.push(cmd);
        arg = null;
        inParam = false;
        break;
      case "arg":
        if (cmd) {
          arg = { name: v };
          cmd.args.push(arg);
          inParam = false;
        }
        break;
      case "text":
      case "desc":
      case "type":
      case "default":
        if (inParam) break;
        if (arg) (arg as unknown as Record<string, string>)[tag] = v;
        else if (cmd && (tag === "text" || tag === "desc")) cmd[tag] = v;
        break;
      default:
        break;
    }
  }
  return out;
}

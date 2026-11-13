#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppContext, type ServerConfig } from "./mcp/context.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";

/**
 * CLI entry point (stdio transport).
 *
 *   rpgmz-mcp --project <path> [--project <path> ...] [--allow-write] [--state-dir .rpgmz-mcp] [--allow-any-project]
 *
 * Environment fallbacks: RPGMZ_PROJECT (path-delimited list), RPGMZ_MCP_ALLOW_WRITE=1,
 * RPGMZ_MCP_STATE_DIR, RPGMZ_MCP_ALLOW_ANY_PROJECT=1.
 *
 * Logs go to stderr only (stdout carries the MCP protocol).
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ServerConfig {
  const projects: string[] = [];
  let allowWrite = env.RPGMZ_MCP_ALLOW_WRITE === "1" || env.RPGMZ_MCP_ALLOW_WRITE === "true";
  let allowAnyProject = env.RPGMZ_MCP_ALLOW_ANY_PROJECT === "1";
  let stateDir = env.RPGMZ_MCP_STATE_DIR ?? ".rpgmz-mcp";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--project" || a === "-p") projects.push(next());
    else if (a.startsWith("--project=")) projects.push(a.slice("--project=".length));
    else if (a === "--allow-write") allowWrite = true;
    else if (a === "--read-only") allowWrite = false;
    else if (a === "--allow-any-project") allowAnyProject = true;
    else if (a === "--state-dir") stateDir = next();
    else if (a === "--help" || a === "-h") {
      process.stderr.write(
        `${SERVER_NAME} ${SERVER_VERSION}\nUsage: rpgmz-mcp --project <path> [--allow-write] [--state-dir <rel>] [--allow-any-project]\n`,
      );
      process.exit(0);
    } else if (!a.startsWith("-") && projects.length === 0) projects.push(a);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!projects.length && env.RPGMZ_PROJECT) projects.push(...env.RPGMZ_PROJECT.split(path.delimiter).filter(Boolean));
  if (/^\.\.|^[\\/]|^[a-zA-Z]:/.test(stateDir) || stateDir.split(/[\\/]/).includes("..")) {
    throw new Error("--state-dir must be a relative path inside the project root.");
  }
  return { projects, allowWrite, allowAnyProject, stateDir };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2), process.env);
  const ctx = new AppContext(config);
  const initError = ctx.init();
  if (initError) process.stderr.write(`[${SERVER_NAME}] project not opened: ${initError}\n`);
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[${SERVER_NAME}] ${SERVER_VERSION} ready (stdio). Projects: ${config.projects.join(", ") || "(none)"}; write mode: ${config.allowWrite ? "ENABLED" : "read-only"}\n`,
  );
}

/** True when this file is the process entry point (direct run, npm bin shim or symlinked global install). */
const isMain = (() => {
  if (process.env.RPGMZ_MCP_FORCE_MAIN === "1") return true;
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}

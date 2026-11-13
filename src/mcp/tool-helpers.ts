import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isMcpError, McpError } from "../project/errors.js";
import type { ApplyResult, ChangeSet } from "../project/transaction-manager.js";
import type { Diagnostic } from "../validation/diagnostics.js";
import type { AppContext } from "./context.js";
import { OPERATIONS } from "./operations.js";

/**
 * Tool result conventions (EVENT_SPEC §6.6): every result has `success`,
 * identities, change-set ids, summaries, warnings/errors and backup info for
 * writes. Text content carries a readable summary plus the JSON payload;
 * structuredContent carries the same JSON for hosts that support it.
 */

const MAX_TEXT = 90_000;

export function ok(summary: string, data: Record<string, unknown> = {}): CallToolResult {
  const payload = { success: true, ...data };
  let json = JSON.stringify(payload, null, 1);
  if (json.length > MAX_TEXT) {
    json = `${json.slice(0, MAX_TEXT)}\n… (output truncated at ${MAX_TEXT} characters; narrow the request, use pagination or compact mode)`;
  }
  return { content: [{ type: "text", text: `${summary}\n\n${json}` }], structuredContent: payload };
}

export function fail(err: unknown): CallToolResult {
  if (isMcpError(err)) {
    const payload = { success: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
    return { content: [{ type: "text", text: `Error [${err.code}]: ${err.message}${err.details ? `\n${JSON.stringify(err.details, null, 1).slice(0, 20_000)}` : ""}` }], structuredContent: payload, isError: true };
  }
  if (err instanceof z.ZodError) {
    const msg = err.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
    return { content: [{ type: "text", text: `Error [INVALID_INPUT]: ${msg}` }], structuredContent: { success: false, error: { code: "INVALID_INPUT", message: msg } }, isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error [INTERNAL]: ${message}` }], structuredContent: { success: false, error: { code: "INTERNAL", message } }, isError: true };
}

export function handler<A>(fn: (args: A) => CallToolResult | Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export function diagnosticsReport(items: readonly Diagnostic[], maxInfo = 30): Record<string, unknown> {
  const errors = items.filter((d) => d.severity === "error");
  const warnings = items.filter((d) => d.severity === "warning");
  const infos = items.filter((d) => d.severity === "info");
  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    infoCount: infos.length,
    errors: errors.slice(0, 100),
    warnings: warnings.slice(0, 100),
    infos: infos.slice(0, maxInfo),
    ...(infos.length > maxInfo ? { infosTruncated: infos.length - maxInfo } : {}),
  };
}

export function changeSetReport(cs: ChangeSet, writable: boolean): Record<string, unknown> {
  let next: string;
  if (cs.empty) next = "Nothing would change on disk.";
  else if (cs.diagnosticSummary.errors > 0) next = "Fix the validation errors; this change set cannot be applied.";
  else if (!writable) next = "Server is read-only: restart it with --allow-write to apply previews.";
  else {
    const parts = [`apply_changes {"changeSetId":"${cs.id}"`];
    if (cs.diagnosticSummary.warnings > 0) parts.push(`"acknowledgeWarnings":true`);
    if (cs.destructive) parts.push(`"confirm":"${cs.id}"`);
    next = `To commit: ${parts.join(",")}}${cs.diagnosticSummary.warnings > 0 ? " after reviewing the warnings with the user" : ""}.`;
  }
  return {
    changeSetId: cs.id,
    description: cs.description,
    destructive: cs.destructive,
    empty: cs.empty,
    operations: cs.operations,
    semanticDiff: cs.semanticDiff.length > 400 ? [...cs.semanticDiff.slice(0, 400), `… ${cs.semanticDiff.length - 400} more lines`] : cs.semanticDiff,
    files: cs.files.map((f) => ({
      relPath: f.relPath,
      created: f.created,
      baseRevision: f.baseRevision,
      changedLines: f.lineStats.changedLines,
      nativeDiff: f.nativeDiff.slice(0, 25),
      ...(f.nativeDiff.length > 25 || f.nativeDiffTruncated ? { nativeDiffTruncated: true } : {}),
    })),
    diagnostics: diagnosticsReport(cs.diagnostics),
    next,
  };
}

export function applyReport(r: ApplyResult): Record<string, unknown> {
  return {
    transactionId: r.transactionId,
    backupDir: r.backupDir,
    files: r.files,
    warnings: r.warnings,
    rollback: r.transactionId ? `rollback_transaction {"transactionId":"${r.transactionId}"} restores the previous files (refused if they changed since).` : undefined,
  };
}

export const mutationFlags = {
  apply: z
    .boolean()
    .optional()
    .describe("Commit right after a successful preview (non-destructive operations only; needs --allow-write; warnings also need acknowledgeWarnings). Default false = preview only."),
  acknowledgeWarnings: z.boolean().optional().describe("Accept validation warnings when apply=true. Review them with the user first."),
  allowScript: z.boolean().optional().describe("true ONLY if the user explicitly asked to insert JavaScript (script commands, script conditions/operands, route scripts)."),
  description: z.string().optional().describe("Optional description stored in the transaction log"),
};

export interface MutationRequest {
  ops: { op: string; args: Record<string, unknown> }[];
  apply?: boolean;
  acknowledgeWarnings?: boolean;
  allowScript?: boolean;
  description?: string;
}

/** Run operations in one workspace, stage a change set and optionally apply it. */
export function runMutation(ctx: AppContext, req: MutationRequest): CallToolResult {
  const session = ctx.current();
  const ws = session.tx.workspace();
  const results: unknown[] = [];
  req.ops.forEach((o, i) => {
    const def = OPERATIONS[o.op];
    if (!def) throw new McpError("INVALID_INPUT", `operations[${i}].op: unknown operation ${JSON.stringify(o.op)}. Known: ${Object.keys(OPERATIONS).join(", ")}.`);
    const args = z.object(def.shape).strict().parse(o.args ?? {}) as Record<string, unknown>;
    if (def.destructive) ws.destructive = true;
    try {
      results.push(def.run({ session, ws, allowScript: req.allowScript === true }, args));
    } catch (err) {
      if (isMcpError(err) && req.ops.length > 1) throw new McpError(err.code, `operations[${i}] (${o.op}): ${err.message}`, err.details);
      throw err;
    }
  });
  const description = req.description ?? ws.operations.join(" | ").slice(0, 300);
  const cs = session.tx.stage(ws, description);
  const out: Record<string, unknown> = { results: results.length === 1 ? results[0] : results, changeSet: changeSetReport(cs, session.project.allowWrite) };
  let summary = `Previewed change set ${cs.id}: ${cs.operations.length} operation(s), ${cs.files.length} file(s), ${cs.diagnosticSummary.errors} error(s), ${cs.diagnosticSummary.warnings} warning(s).`;
  if (req.apply) {
    if (cs.destructive) {
      out.applied = false;
      out.applyNote = "Destructive operations are never auto-applied. Review the preview, then call apply_changes with confirm.";
    } else {
      try {
        const r = session.tx.apply(cs.id, { acknowledgeWarnings: req.acknowledgeWarnings === true });
        out.applied = true;
        out.commit = applyReport(r);
        summary = `Applied change set ${cs.id} as transaction ${r.transactionId || "(no-op)"}: ${cs.operations.join(" | ").slice(0, 400)}`;
      } catch (err) {
        out.applied = false;
        out.applyError = isMcpError(err) ? { code: err.code, message: err.message } : { code: "INTERNAL", message: String(err) };
        summary += ` NOT applied: ${isMcpError(err) ? err.message : String(err)}`;
      }
    }
  }
  return ok(summary, out);
}

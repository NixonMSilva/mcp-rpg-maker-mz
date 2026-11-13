/**
 * Shared diagnostic model used by event validation, database validation,
 * reference validation and flow analysis.
 *
 * Severity semantics (EVENT_SPEC §10):
 *  - error:   unsafe or structurally invalid; writing is blocked.
 *  - warning: suspicious; writing requires explicit acknowledgement.
 *  - info:    useful observation.
 */
export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. "ref.switch.out_of_range". */
  code: string;
  message: string;
  /** Human-readable location, e.g. "Map 3 / Event 5 / Page 1 / block 2.then.0". */
  location?: string;
  /** True when the diagnostic is produced by a heuristic rather than a definite rule. */
  heuristic?: boolean;
  details?: Record<string, unknown>;
}

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.items.push(d);
  }

  error(code: string, message: string, location?: string, details?: Record<string, unknown>): void {
    this.add(clean({ severity: "error", code, message, location, details }));
  }

  warning(code: string, message: string, location?: string, details?: Record<string, unknown>): void {
    this.add(clean({ severity: "warning", code, message, location, details }));
  }

  info(code: string, message: string, location?: string, details?: Record<string, unknown>): void {
    this.add(clean({ severity: "info", code, message, location, details }));
  }

  heuristic(severity: Severity, code: string, message: string, location?: string, details?: Record<string, unknown>): void {
    this.add(clean({ severity, code, message, location, details, heuristic: true }));
  }

  merge(other: Iterable<Diagnostic>): void {
    for (const d of other) this.items.push(d);
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  get hasWarnings(): boolean {
    return this.items.some((d) => d.severity === "warning");
  }
}

function clean(d: Diagnostic): Diagnostic {
  const out: Diagnostic = { severity: d.severity, code: d.code, message: d.message };
  if (d.location !== undefined) out.location = d.location;
  if (d.details !== undefined) out.details = d.details;
  if (d.heuristic) out.heuristic = true;
  return out;
}

export function summarizeDiagnostics(items: readonly Diagnostic[]): { errors: number; warnings: number; infos: number } {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of items) {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

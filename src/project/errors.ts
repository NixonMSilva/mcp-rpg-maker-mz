/**
 * Error types shared by every subsystem. Each error carries a stable `code`
 * so MCP clients (and tests) can react to failure classes without parsing
 * human-readable messages.
 */
export type McpErrorCode =
  | "PROJECT_NOT_FOUND"
  | "NOT_AN_MZ_PROJECT"
  | "PATH_OUTSIDE_PROJECT"
  | "FILE_NOT_FOUND"
  | "MALFORMED_JSON"
  | "MALFORMED_DATA"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "STALE_REVISION"
  | "STALE_CHANGESET"
  | "VALIDATION_FAILED"
  | "WARNINGS_NOT_ACKNOWLEDGED"
  | "WRITE_DISABLED"
  | "CHANGESET_NOT_FOUND"
  | "CONFIRMATION_REQUIRED"
  | "WRITE_FAILED"
  | "ROLLBACK_FAILED"
  | "UNSUPPORTED";

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.details = details;
  }
}

export function isMcpError(err: unknown): err is McpError {
  return err instanceof McpError;
}

export function notFound(message: string, details?: Record<string, unknown>): McpError {
  return new McpError("NOT_FOUND", message, details);
}

export function invalidInput(message: string, details?: Record<string, unknown>): McpError {
  return new McpError("INVALID_INPUT", message, details);
}

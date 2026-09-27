import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "./session.js";

// Tool arguments arrive as untyped JSON and the SDK does not enforce the
// inputSchema it advertises, so these are the trust boundary for everything
// behind them, including the argv handed to spawn.

export function requireStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be an array of strings`);
  }
  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be a non-empty string`);
  }
  return value;
}

export function optionalTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  // A zero, negative or non-finite timeout fires before the debugger can answer
  // and leaves the session waiting on a prompt it has already given up on.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_COMMAND_TIMEOUT_MS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `timeout must be a number between 1 and ${MAX_COMMAND_TIMEOUT_MS} milliseconds`
    );
  }
  return value;
}

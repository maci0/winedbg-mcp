import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "./constants.js";
import { LINE_BREAKS } from "./session.js";

// Tool arguments arrive as untyped JSON and the SDK does not enforce the
// inputSchema it advertises, so these are the trust boundary for everything
// behind them, including the argv handed to spawn.

// No debugger command is anywhere near this long, and the value is copied into
// an argv entry and into a pipe write, so an unbounded one is a caller's memory
// and the child's command line, for no debugging value.
export const MAX_ARG_CHARS = 4096;
export const MAX_COMMAND_CHARS = 4096;
// winedbg takes a program path and a handful of switches. An array this long is
// a caller filling the process table, not a debugging session.
export const MAX_START_ARGS = 64;

// JSON lets a string carry a lone surrogate, an unpaired half of a UTF-16 pair.
// UTF-8 has no encoding for one, so the encoder that writes a command or an
// argv silently substitutes U+FFFD and the debugger opens a different path than
// the client named, with nothing anywhere reporting the substitution.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function requireEncodable(value: string, field: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${field} contains an unpaired UTF-16 surrogate, which no UTF-8 byte sequence can carry`,
    );
  }
  return value;
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be an array of strings`);
  }
  if (value.length > MAX_START_ARGS) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must have at most ${MAX_START_ARGS} entries`);
  }
  // Narrowed item by item rather than asserted: Array.isArray only proves the
  // array, not its elements, and this list goes straight to spawn.
  const items: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      throw new McpError(ErrorCode.InvalidParams, `${field} must be an array of strings`);
    }
    if (item.length > MAX_ARG_CHARS) {
      throw new McpError(ErrorCode.InvalidParams, `${field} entries must be at most ${MAX_ARG_CHARS} characters`);
    }
    // A NUL cannot reach execve, so spawn() rejects the whole call with
    // ERR_INVALID_ARG_VALUE naming neither the argument nor its index.
    if (item.includes("\0")) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${field}[${index}] contains a NUL byte, which no argument can carry`,
      );
    }
    items.push(requireEncodable(item, field));
  }
  return items;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be a non-empty string`);
  }
  if (value.length > MAX_COMMAND_CHARS) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be at most ${MAX_COMMAND_CHARS} characters`);
  }
  if (LINE_BREAKS.test(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${field} must be a single line: no line break (\\n, \\r, \\v, \\f, U+0085, U+2028, U+2029) and no NUL`,
    );
  }
  return requireEncodable(value, field);
}

export function optionalTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  // A zero, negative or non-finite timeout fires before the debugger can answer
  // and leaves the session waiting on a prompt it has already given up on. A
  // fraction is the same problem in smaller units: the stated floor is a whole
  // millisecond, and one below it is not a timeout anyone asked for.
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_COMMAND_TIMEOUT_MS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `timeout must be a whole number of milliseconds between 1 and ${MAX_COMMAND_TIMEOUT_MS}`,
    );
  }
  return value;
}

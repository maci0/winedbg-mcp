import { AsyncLocalStorage } from "node:async_hooks";
import type { LogLevel } from "./constants.js";

/** The fields a log line may carry beside its message. Flat scalars only, so every line stays one object. */
export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * A logger over one write function. `write` takes a finished line, so the sink
 * decides where it goes and tests can collect lines without touching a stream.
 *
 * One JSON object per line, so a log aggregator can parse the stream and a
 * multiline debugger reply cannot break the parse. The message is fixed text and
 * the varying parts are named fields, so a query filters on a field rather than
 * on a substring of prose.
 */
export function formatRecord(time: string, level: LogLevel, message: string, fields: LogFields = {}): string {
  return JSON.stringify({ time, level, message, ...fields });
}

export function createLogger(
  level: LogLevel,
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): Logger {
  const emit = (record: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_RANK[record] < LEVEL_RANK[level]) return;
    write(formatRecord(now().toISOString(), record, message, fields));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

const callContext = new AsyncLocalStorage<{ callId: string }>();

/**
 * Run `body` with the tool call its log lines belong to. The MCP SDK hands a
 * handler the params and not the JSON-RPC envelope, so the call is identified
 * here, and everything the call reaches asynchronously (a spawned debugger, a
 * ready timer, the promise a command's reply settles) carries the same id.
 */
export function runWithCallId<T>(callId: string, body: () => T): T {
  return callContext.run({ callId }, body);
}

/**
 * The `callId` a line written right now belongs to, or no field at all when the
 * line is not part of a call: startup, shutdown and a process signal are the
 * server's own, and a call id on them would name a call that has already ended.
 */
export function callFields(): LogFields {
  const context = callContext.getStore();
  return context === undefined ? {} : { callId: context.callId };
}

/** Where the server logs by default: the same stderr the CLI already reports on. */
export const stderrLogger: Logger = createLogger("info", (line) => {
  process.stderr.write(`${line}\n`);
});

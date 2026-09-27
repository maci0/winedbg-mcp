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
export function createLogger(
  level: LogLevel,
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): Logger {
  const emit = (record: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_RANK[record] < LEVEL_RANK[level]) return;
    write(JSON.stringify({ time: now().toISOString(), level: record, message, ...fields }));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/** Where the server logs by default: the same stderr the CLI already reports on. */
export const stderrLogger: Logger = createLogger("info", (line) => {
  process.stderr.write(`${line}\n`);
});

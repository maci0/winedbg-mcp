// Defaults and limits shared by the config, validation, tool and session
// layers. They live here so no layer has to import another one to name a
// number they both use.

export const DEFAULT_BINARY = "winedbg";
// A cold wineprefix takes longer to answer than a warm one; config.ts lets a
// deployment raise this without a rebuild.
export const DEFAULT_READY_TIMEOUT_MS = 10000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
export const MAX_COMMAND_TIMEOUT_MS = 600000;
// A separate limit from MAX_COMMAND_TIMEOUT_MS even at the same value: the two
// bound unrelated waits, and raising the command ceiling must not silently
// raise the first-prompt wait.
export const MAX_READY_TIMEOUT_MS = 600000;

// Tool argument sizes. The tool schemas advertise these and the validator
// refuses past them, so both read the same number here: a limit stated in only
// one of the two is a contract the model is never told about. Neither is a
// length any debugger command approaches; the value is copied into an argv
// entry and into a pipe write, so an unbounded one is a caller's memory and the
// child's command line, for no debugging value.
export const MAX_ARG_CHARS = 4096;
export const MAX_COMMAND_CHARS = 4096;
// winedbg takes a program path and a handful of switches. An array this long is
// a caller filling the process table, not a debugging session.
export const MAX_START_ARGS = 64;

// Log levels, ordered from most to least verbose. A line below the configured
// level is never formatted, so a debug-level deployment costs nothing on a
// quiet one.
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

// Defaults and limits shared by the config, validation, tool and session
// layers. They live here so no layer has to import another one to name a
// value they both use.

// The debugger answers one line with one prompt, so a command is one line only
// if it is one line under every reader: a stream reader splits on \n, \r and
// vertical tab, and a text decoder that honours the Unicode line breaks splits
// on NEL (U+0085), U+2028 and U+2029 too. NUL is not a line break but truncates
// the line for most C readers, leaving the reply stream one prompt out of step
// the same way a second line would.
export const LINE_BREAKS = /[\n\r\v\f\0\u0085\u2028\u2029]/;

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

// Log levels, ordered from most to least verbose. A line below the configured
// level is never formatted, so a debug-level deployment costs nothing on a
// quiet one.
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

// The names this server's own configuration is read from. A misspelled one is
// refused rather than ignored, and nothing under the prefix is forwarded to the
// debugger: the WINE* family a wineprefix needs would otherwise sweep it in.
export const CONFIG_VAR_PREFIX = "WINEDBG_MCP_";

import type { Logger } from "./logger.js";
import { SERVER_VERSION } from "./version.js";

/** The two failures the server did not handle and so never logged itself. */
export type FatalKind = "uncaughtException" | "unhandledRejection";

/**
 * A crash as one record on the same surface as every other line: a level an
 * aggregator filters on, a fixed message, and the error and stack that node
 * would otherwise print as plain text with no timestamp and no version beside
 * them.
 */
export function reportFatal(log: Logger, kind: FatalKind, error: unknown): void {
  log.error("server crashed", {
    kind,
    version: SERVER_VERSION,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  });
}

/**
 * Report a failure the server did not handle, and leave.
 *
 * Both end the process the same way they would without a handler, which is what
 * runs the exit handler that signals winedbg: a debugger and its debuggee must
 * not outlive the server that owns them. So the handler exits rather than
 * returns, since node keeps a process with an uncaughtException listener alive
 * and the orphan would be the price of the log line.
 */
export function installFatalHandlers(log: Logger): void {
  const crash = (kind: FatalKind, error: unknown): never => {
    reportFatal(log, kind, error);
    return process.exit(1);
  };
  process.on("uncaughtException", (error) => crash("uncaughtException", error));
  // A rejected promise nobody awaits is a bug the same either way, and the
  // reason is whatever was thrown, which need not be an Error.
  process.on("unhandledRejection", (reason) => crash("unhandledRejection", reason));
}

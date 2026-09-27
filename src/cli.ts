import {
  DEFAULT_BINARY,
  DEFAULT_LOG_LEVEL,
  DEFAULT_READY_TIMEOUT_MS,
  LOG_LEVELS,
  MAX_READY_TIMEOUT_MS,
} from "./constants.js";
import { TERMINATION_WAIT_MS } from "./session.js";
import { SERVER_VERSION } from "./version.js";

// Every number here is read from the constant the code enforces, so the help
// cannot name a default or a limit the server does not apply.
const USAGE = `Usage: winedbg-mcp [OPTION]

MCP server for the Wine debugger. An MCP client launches it and speaks JSON-RPC
over stdin/stdout; stdout carries protocol traffic only, and every diagnostic
goes to stderr.

Options:
  -h, --help       Print this help and exit
      --version    Print the version and exit

With no option the server starts and waits for a client on stdin.

Environment:
  WINEDBG_MCP_BINARY             winedbg command or path. Default: ${DEFAULT_BINARY}
  WINEDBG_MCP_READY_TIMEOUT_MS  Milliseconds to wait for the first winedbg
                                prompt, 1 to ${MAX_READY_TIMEOUT_MS}. Default: ${DEFAULT_READY_TIMEOUT_MS}
  WINEDBG_MCP_LOG_LEVEL          ${LOG_LEVELS.join(", ")}. Default: ${DEFAULT_LOG_LEVEL}

Example MCP client configuration:
  {
    "mcpServers": {
      "winedbg": {
        "command": "winedbg-mcp",
        "env": { "WINEDBG_MCP_READY_TIMEOUT_MS": "60000" }
      }
    }
  }

Exit codes:
  0  Clean shutdown on SIGINT, SIGTERM, or end of stdin. winedbg and the
     debuggee it started are waited for, up to ${TERMINATION_WAIT_MS / 1000}s, so neither is left running
  1  A configuration value the server cannot use, or a failed start
  2  An unknown or invalid command-line argument
`;

/** An argument the user can fix by changing the command line. Exit code 2. */
export class UsageError extends Error {}

export type CliAction = { kind: "serve" } | { kind: "help"; usage: string } | { kind: "version"; version: string };

/**
 * Resolve argv to the one action to take. Anything unrecognized is a usage
 * error rather than something to ignore: a typo in a flag the server has no use
 * for is a mistake worth reporting, and a server that starts anyway hides it.
 */
export function parseCliArgs(argv: readonly string[]): CliAction {
  for (const arg of argv) {
    switch (arg) {
      case "-h":
      case "--help":
        return { kind: "help", usage: USAGE };
      case "--version":
        return { kind: "version", version: SERVER_VERSION };
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return { kind: "serve" };
}

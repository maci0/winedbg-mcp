import { SERVER_VERSION } from "./version.js";

const INVOCATION = "winedbg-mcp [OPTION]";

/** The one-line invocation form, reprinted on a usage error. */
export const USAGE_LINE = `Usage: ${INVOCATION}`;

const USAGE = `${USAGE_LINE}

MCP server for the Wine debugger. An MCP client launches it and speaks JSON-RPC
over stdin/stdout; stdout carries protocol traffic only, and every diagnostic
goes to stderr.

Options:
  -h, --help       Print this help and exit
  -V, --version    Print the version and exit

With no option the server starts and waits for a client on stdin.

Environment:
  WINEDBG_MCP_BINARY             winedbg command or path. Default: winedbg
  WINEDBG_MCP_READY_TIMEOUT_MS  Milliseconds to wait for the first winedbg
                                prompt, 1 to 600000. Default: 10000
  WINEDBG_MCP_COMMAND_TIMEOUT_MS
                                Milliseconds winedbg_execute waits for a reply
                                when the call names no timeout of its own,
                                1 to 600000. Default: 30000
  WINEDBG_MCP_LOG_LEVEL          debug, info, warn or error. Default: info
  WINEDBG_MCP_PASSTHROUGH_ENV   Comma-separated extra variable names to
                                forward to winedbg. Default: none

winedbg is started with an allowlisted environment, not the one it was
launched from, so credentials in this environment do not reach the program
under debug. Name any variable it does need here.

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
     debuggee it started are waited for, up to 6s, so neither is left running
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
  // "--" ends the options. The server takes no operands, so it changes nothing
  // by itself, but it stops what follows from being read as a flag: `-- --help`
  // is a request to run a command named --help, and saying so is better than
  // quietly starting a server that waits on a client nobody is going to send.
  let optionsEnded = false;
  for (const arg of argv) {
    if (optionsEnded) throw new UsageError(`Unknown argument: ${arg}`);
    switch (arg) {
      case "--":
        optionsEnded = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help", usage: USAGE };
      case "-V":
      case "--version":
        return { kind: "version", version: SERVER_VERSION };
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return { kind: "serve" };
}

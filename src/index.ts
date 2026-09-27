#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseCliArgs, UsageError } from "./cli.js";
import type { Config } from "./config.js";
import { describeConfig, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { nodeRuntime } from "./runtime.js";
import { WinedbgSession } from "./session.js";
import { callTool, describeTools, type ToolResult } from "./tools.js";
import { SERVER_VERSION } from "./version.js";

// The command line is resolved before the environment, so --help and --version
// still work in a deployment whose environment the server would refuse to run
// on.
const argv = process.argv.slice(2);
try {
  const action = parseCliArgs(argv);
  if (action.kind === "help") {
    process.stdout.write(action.usage);
    process.exit(0);
  }
  if (action.kind === "version") {
    process.stdout.write(`${action.version}\n`);
    process.exit(0);
  }
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`winedbg-mcp: ${error.message}\nTry 'winedbg-mcp --help' for the accepted arguments.\n`);
    process.exit(2);
  }
  // --version reads the manifest this process was installed from, so a failure
  // there is a broken install rather than a bad argument. Reported as one, with
  // the stack it would otherwise print left out.
  process.stderr.write(`winedbg-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// Read the environment before anything else: a bad value stops the server here,
// with the variable named, instead of surfacing later as a spawn or start failure.
let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  // biome-ignore lint/suspicious/noConsole: stdout carries the JSON-RPC stream, so stderr is the only channel a startup failure can be reported on.
  console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const server = new Server(
  {
    name: "winedbg-mcp",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const log = createLogger(config.logLevel, (line) => {
  process.stderr.write(`${line}\n`);
});
// One runtime for the whole server, so the session and the timings this file
// logs are read off the same clock: a duration measured on the host beside a
// session running on a virtual one is a number from two different runs.
const runtime = nodeRuntime();
const session = new WinedbgSession(config.binary, config.readyTimeoutMs, runtime, log, config.commandTimeoutMs);
const tools = describeTools(config.commandTimeoutMs);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// A tool call is a debugger command carrying the authority of the account the
// server runs as, and the reply stream is written by the program under debug, so
// the operator's log is the only record of what actually ran. The SDK hands a
// tool call its params and not the JSON-RPC envelope, so the client's request id
// never reaches this process. A per-process counter stands in for it: one number
// that ties the start, the failure and the duration of one call together in the
// log.
let callCounter = 0;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const callId = `call-${++callCounter}`;
  const tool = request.params.name;
  const startedAt = runtime.clock.now();
  log.info("tool call started", { callId, tool });
  let result: ToolResult;
  try {
    result = await callTool(session, tool, request.params.arguments, config.commandTimeoutMs);
  } catch (error) {
    // The one failure that is not an error result: an unknown tool name, which
    // is a protocol error the client has to see. It still has to leave a line
    // here, or a call that starts in the log and never ends looks like a hang.
    log.error("tool call rejected", {
      callId,
      tool,
      durationMs: runtime.clock.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const durationMs = runtime.clock.now() - startedAt;
  // A failed tool call still answered the client, so it is a call that completed
  // with an error, not a missing one: the outcome rides on the same line as the
  // duration, which is what answers "did it succeed and how long did it take".
  if (result.isError) {
    const text = result.content[0]?.text ?? "";
    log.warn("tool call failed", { callId, tool, durationMs, error: text });
  } else {
    log.info("tool call finished", { callId, tool, durationMs });
  }
  return result;
});

// winedbg is a child of this process, so nothing else reaps it when the client
// hangs up and this process goes away. An exit handler has no event loop left
// to wait in, so the tree is killed outright rather than asked to leave.
process.on("exit", () => session.stopImmediately());

function shutdown(reason: string) {
  log.info("shutting down", { reason });
  // stop() returns once the signal is sent, and a debugger stopped inside a trap
  // handler is only ended by the escalation a grace period later. Exiting on the
  // strength of the signal alone would take that escalation with it and leave the
  // debugger, and the debuggee it launched, running with no owner. shutdown()
  // waits for them, and a second signal arriving during that wait joins the same
  // one rather than signalling anything twice. The rejection is reported rather
  // than left to an unhandled one, which would print over a debugger still
  // running with the exit code node picked for it.
  void session
    .shutdown()
    .catch((error: unknown) => {
      log.error("shutdown did not finish cleanly", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(`signal ${signal}`));
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The stdio transport never reports a client hangup on its own: a client that
  // closes stdin ends the stream without a message. Left alone, the server, the
  // debugger and the debuggee under it would keep running with nobody to talk to.
  server.onclose = () => shutdown("client closed the connection");
  process.stdin.once("end", () => shutdown("end of stdin"));
  process.stdin.once("close", () => shutdown("stdin closed"));
  log.info("winedbg MCP server running on stdio", {
    version: SERVER_VERSION,
    config: describeConfig(config),
  });
}

main().catch((error) => {
  log.error("server could not start", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  });
  process.exit(1);
});

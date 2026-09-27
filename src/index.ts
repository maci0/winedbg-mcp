#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { describeConfig, loadConfig } from "./config.js";
import { parseCliArgs, UsageError } from "./cli.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.js";
import { WinedbgSession } from "./session.js";
import { callTool, TOOLS } from "./tools.js";
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
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(
    `winedbg-mcp: ${error.message}\nTry 'winedbg-mcp --help' for the accepted arguments.\n`
  );
  process.exit(2);
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

const session = new WinedbgSession(config.binary, config.readyTimeoutMs);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// A tool call is a debugger command carrying the authority of the account the
// server runs as, and the reply stream is written by the program under debug, so
// the operator's log is the only record of what actually ran. Control characters
// are stripped so a command cannot forge log records, and the text is truncated
// so a call cannot flood the log.
const AUDIT_LOG_MAX_CHARS = 200;
const LOG_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function audit(event: string, detail: string) {
  const text = detail.replace(LOG_CONTROL_CHARS, " ").slice(0, AUDIT_LOG_MAX_CHARS);
  console.error(`[winedbg-mcp] ${event}${text ? ` ${text}` : ""}`);
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await callTool(session, name, args);
  const text = result.content[0]?.text ?? "";
  // callTool reports a tool failure as an error result rather than by throwing,
  // so the log reads the outcome back off the result.
  if (result.isError) {
    audit("error", `${name}: ${text.replace(/^Error: /, "")}`);
  } else if (name === "winedbg_start") {
    audit("start", JSON.stringify(args?.["args"] ?? []));
  } else if (name === "winedbg_execute") {
    const timeout = args?.["timeout"] ?? DEFAULT_COMMAND_TIMEOUT_MS;
    audit("execute", `${JSON.stringify(args?.["command"])} timeoutMs=${timeout} replyChars=${text.length}`);
  } else {
    audit("stop", "");
  }
  return result;
});

// winedbg is a child of this process, so nothing else reaps it when the client
// hangs up and this process goes away.
process.on("exit", () => session.stop());

function shutdown() {
  session.stop();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, shutdown);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The stdio transport never reports a client hangup on its own: a client that
  // closes stdin ends the stream without a message. Left alone, the server, the
  // debugger and the debuggee under it would keep running with nobody to talk to.
  server.onclose = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  // biome-ignore lint/suspicious/noConsole: stdout carries the JSON-RPC stream, so stderr is the only channel the banner can go to.
  console.error(`winedbg MCP server running on stdio (${describeConfig(config)})`);
}

main().catch((error) => {
  // biome-ignore lint/suspicious/noConsole: stdout carries the JSON-RPC stream, so stderr is the only channel a fatal error can be reported on.
  console.error("Server error:", error);
  process.exit(1);
});

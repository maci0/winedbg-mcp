#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { describeConfig, loadConfig } from "./config.js";
import { parseCliArgs, UsageError } from "./cli.js";
import { WinedbgSession } from "./session.js";
import { TOOLS, callTool } from "./tools.js";
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
  }
);

const session = new WinedbgSession(config.binary, config.readyTimeoutMs);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return callTool(session, request.params.name, request.params.arguments);
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
  console.error(`winedbg MCP server running on stdio (${describeConfig(config)})`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, WinedbgSession } from "./session.js";
import type { Config } from "./config.js";
import { describeConfig, loadConfig } from "./config.js";
import { optionalRequestId, optionalTimeout, requireString, requireStringArray } from "./validate.js";

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
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const session = new WinedbgSession(config.binary, config.readyTimeoutMs);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "winedbg_start",
        description: "Start or attach winedbg. Use this before running any commands. You can optionally provide arguments like the path to a .exe to launch, or a PID to attach to.",
        inputSchema: {
          type: "object",
          properties: {
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments to pass to winedbg (e.g. ['myapp.exe'] or ['1234'])",
            },
          },
        },
      },
      {
        name: "winedbg_execute",
        description: "Execute one command in the active winedbg session. (e.g., 'bt', 'step', 'break main'). One command per call: multi-line input is rejected. A command runs the debugger each time it is sent, so retry one that may already have run with the same requestId. This requires winedbg_start to have been called.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "A single winedbg command to execute",
            },
            timeout: {
              type: "number",
              description: `Optional timeout in milliseconds for the command to finish. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}ms, maximum ${MAX_COMMAND_TIMEOUT_MS}ms.`,
            },
            requestId: {
              type: "string",
              description:
                "Optional id for this command, at most 128 characters. Pass the same id to retry the same command: a repeat returns the first answer (or the first failure) without running it in winedbg a second time. Use a new id for a new command.",
            }
          },
          required: ["command"],
        },
      },
      {
        name: "winedbg_stop",
        description: "Stop the active winedbg session.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "winedbg_start": {
        const startArgs = requireStringArray(args?.["args"], "args");
        await session.start(startArgs);
        return {
          content: [
            {
              type: "text",
              text: `winedbg started successfully with args: ${startArgs.join(" ")}`,
            },
          ],
        };
      }

      case "winedbg_execute": {
        const command = requireString(args?.["command"], "command");
        const timeout = optionalTimeout(args?.["timeout"]);
        const requestId = optionalRequestId(args?.["requestId"]);

        const output = await session.executeCommand(command, timeout, requestId);
        return {
          content: [
            {
              type: "text",
              text: output || "(Command executed successfully, no output)",
            },
          ],
        };
      }

      case "winedbg_stop": {
        session.stop();
        return {
          content: [
            {
              type: "text",
              text: "winedbg session stopped.",
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// winedbg is a child of this process, so nothing else reaps it when the client
// hangs up and this process goes away.
process.on("exit", () => session.stop());

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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

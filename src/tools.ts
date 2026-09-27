import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "./constants.js";
import { describeError } from "./logger.js";
import type { WinedbgSession } from "./session.js";
import { optionalTimeout, requireString, requireStringArray } from "./validate.js";

/** What a tool call needs from the session, so the handler can be driven by a stub. */
export type ToolSession = Pick<WinedbgSession, "start" | "executeCommand" | "stop">;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

// The tool list is fixed, so it is built once instead of on every
// tools/list request.
export const TOOLS = [
  {
    name: "winedbg_start",
    description:
      "Start or attach winedbg. Use this before running any commands. You can optionally provide arguments like the path to a .exe to launch, or a PID to attach to.",
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
    description:
      "Execute one command in the active winedbg session. (e.g., 'bt', 'step', 'break main'). One command per call: multi-line input is rejected. This requires winedbg_start to have been called.",
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
] as const;

function textResult(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/**
 * Run one tool call against the session. Argument errors and session failures
 * come back as an error result, so a bad model turn does not drop the server.
 * An unknown tool is a protocol error the client has to see as such: a result
 * marked isError would report it as a successful call.
 */
export async function callTool(
  session: ToolSession,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "winedbg_start": {
        const startArgs = requireStringArray(args?.["args"], "args");
        await session.start(startArgs);
        return textResult(`winedbg started successfully with args: ${startArgs.join(" ")}`);
      }

      case "winedbg_execute": {
        const command = requireString(args?.["command"], "command");
        const timeout = optionalTimeout(args?.["timeout"]);
        const output = await session.executeCommand(command, timeout);
        return textResult(output || "(Command executed successfully, no output)");
      }

      case "winedbg_stop": {
        session.stop();
        return textResult("winedbg session stopped.");
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) throw error;
    const message = describeError(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

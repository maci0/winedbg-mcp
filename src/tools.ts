import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { COMMAND_TIMEOUT_VAR } from "./config.js";
import { MAX_COMMAND_TIMEOUT_MS } from "./constants.js";
import { describeError } from "./logger.js";
import type { WinedbgSession } from "./session.js";
import { optionalTimeout, requireString, requireStringArray } from "./validate.js";

/** What a tool call needs from the session, so the handler can be driven by a stub. */
export type ToolSession = Pick<WinedbgSession, "start" | "executeCommand" | "stop">;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

/**
 * The advertised tool list, with the deployment's command timeout in it. It is
 * built once at startup rather than on every tools/list request, and the timeout
 * it names is the one a call without a `timeout` actually gets: a description
 * saying 30000 while the deployment waits 120000 is the model passing a value the
 * operator had already raised.
 */
export function describeTools(defaultCommandTimeoutMs: number) {
  return [
    {
      name: "winedbg_start",
      description:
        "Start or attach winedbg. Use this before running any commands. You can optionally provide arguments like the path to a .exe to launch, or a PID to attach to. Repeating this call with the same args returns the session already running rather than launching a second debugger; different args are refused.",
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
        "Execute one command in the active winedbg session. (e.g., 'bt', 'step', 'break main'). One command per call: multi-line input is rejected. This requires winedbg_start to have been called. This runs the command again on every call: do not repeat a call that steps, continues or writes debugger state unless you mean to run it twice.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "A single winedbg command to execute",
          },
          timeout: {
            type: "number",
            description: `Optional timeout in milliseconds for the command to finish. Defaults to ${defaultCommandTimeoutMs}ms (${COMMAND_TIMEOUT_VAR}), maximum ${MAX_COMMAND_TIMEOUT_MS}ms.`,
          },
        },
        required: ["command"],
      },
    },
    {
      name: "winedbg_stop",
      description:
        "Stop the active winedbg session. Repeating this call, or calling it with nothing running, ends nothing further and reports success.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ] as const;
}

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
  defaultCommandTimeoutMs: number,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "winedbg_start": {
        const startArgs = requireStringArray(args?.["args"], "args");
        const outcome = await session.start(startArgs);
        return textResult(
          outcome === "started"
            ? `winedbg started successfully with args: ${startArgs.join(" ")}`
            : `winedbg is already running with args: ${startArgs.join(" ")}. The repeated start launched nothing.`,
        );
      }

      case "winedbg_execute": {
        const command = requireString(args?.["command"], "command");
        const timeout = optionalTimeout(args?.["timeout"], defaultCommandTimeoutMs);
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

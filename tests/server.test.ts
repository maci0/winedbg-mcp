// Goal: pin the entry point as a client meets it, since every other file is
// tested below this line and nothing here reached the transport: the handshake,
// the tool list on the wire, a tool call's result, the audit log and the exit
// on a client that hangs up.
//
// Method: the server is spawned and spoken to over its own stdio with
// hand-written JSON-RPC, so the framing, the stream discipline and the exit code
// are what a real client sees. No SDK client, no mock transport, and no Wine:
// winedbg_start is given tests/fake-winedbg.js as the debugger binary's argument,
// which is the same stand-in the session tests drive.

import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ErrorCode, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_VERSION } from "../src/version.js";

// fileURLToPath, not .pathname: a file: URL is percent-encoded, and on Windows
// its pathname carries a leading slash the path does not have (C:\a becomes
// /C:/a). Either way a checkout under a directory with a space or a non-ASCII
// character in it spawns a path that does not exist.
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("fake-winedbg.js", import.meta.url));
// A cold bun start plus a compile of the entry point is slow on a loaded
// machine. Past this the child is wedged, and a wedged child has to fail the
// test rather than hang it.
const CALL_TIMEOUT_MS = 30_000;
// The margin over CALL_TIMEOUT_MS lets within() report why a call was abandoned
// instead of letting the test deadline fire first with a bare timeout.
const TEST_TIMEOUT_MS = CALL_TIMEOUT_MS + 5_000;

type RpcResponse = {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type LogRecord = Record<string, unknown> & { message: string };

/** Reject rather than hang: a wedged server must fail the test, not stall it. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

const spawned: Bun.Subprocess[] = [];

afterEach(() => {
  for (const child of spawned) child.kill();
  spawned.length = 0;
});

/** The spawned server, driven over its stdio. */
type Server = {
  call(method: string, params?: unknown): Promise<RpcResponse>;
  handshake(): Promise<RpcResponse>;
  endStdin(): void;
  exited: Promise<number>;
  logRecords(): Promise<LogRecord[]>;
};

function startServer(): Server {
  const child = Bun.spawn([process.execPath, ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // The fake debugger is the same program the binary is run with elsewhere,
      // reached through the one variable a deployment names it with.
      WINEDBG_MCP_BINARY: process.execPath,
      WINEDBG_MCP_LOG_LEVEL: "debug",
    },
  });
  spawned.push(child);
  // Read to the end rather than to a point in time: the audit log is asserted
  // after the server has exited, and a partial read would be a race.
  const stderrText = new Response(child.stderr).text();

  const waiting = new Map<number, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  // A line on stdout that is not a JSON-RPC message is a protocol failure, and
  // the session must not answer one: stdout carries protocol traffic only.
  let protocolError: Error | null = null;

  const reading = (async () => {
    let buffer = "";
    // The stream yields bytes, and a decoded character can straddle two of
    // them, so the decoder holds the tail back rather than turning it into
    // U+FFFD the way the session's own readers must not.
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        let message: RpcResponse;
        try {
          message = JSON.parse(line) as RpcResponse;
        } catch {
          protocolError = new Error(`stdout carried a line that is not JSON-RPC: ${line}`);
          for (const pending of waiting.values()) pending.reject(protocolError);
          waiting.clear();
          return;
        }
        if (typeof message.id !== "number") continue;
        const pending = waiting.get(message.id);
        if (pending === undefined) continue;
        waiting.delete(message.id);
        pending.resolve(message);
      }
    }
    for (const pending of waiting.values()) pending.reject(new Error("the server closed stdout with a call in flight"));
    waiting.clear();
  })();

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const call = (method: string, params?: unknown): Promise<RpcResponse> => {
    if (protocolError !== null) return Promise.reject(protocolError);
    const id = ++nextId;
    const response = within(
      new Promise<RpcResponse>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        try {
          send({ id, method, params });
        } catch (error) {
          waiting.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
      CALL_TIMEOUT_MS,
      method,
    );
    return response;
  };

  return {
    call,
    // A client announces itself before anything else; the server answers on the
    // initialize request and takes no further request until the notification.
    handshake: async () => {
      const response = await call("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "winedbg-mcp-tests", version: "0" },
      });
      send({ method: "notifications/initialized" });
      return response;
    },
    endStdin: () => {
      child.stdin.end();
    },
    // stdout drained to the end before the exit is reported, so a test that
    // asserts on the log after it never races the last line.
    exited: within(
      Promise.all([child.exited, reading]).then(([code]) => code),
      CALL_TIMEOUT_MS,
      "the server's exit",
    ),
    logRecords: async () =>
      (await within(stderrText, CALL_TIMEOUT_MS, "the server's stderr"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LogRecord),
  };
}

/** The text of a tool result, which is the only content a call here carries. */
function textOf(response: RpcResponse): string {
  const result = response.result;
  if (result === undefined) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  const content = result["content"];
  if (!Array.isArray(content) || content.length === 0)
    throw new Error(`a result carried no content: ${JSON.stringify(result)}`);
  const first = content[0] as { type?: unknown; text?: unknown };
  expect(first.type).toBe("text");
  return String(first.text);
}

function isError(result: Record<string, unknown> | undefined): boolean {
  return result?.["isError"] === true;
}

describe("winedbg-mcp over stdio", () => {
  test(
    "the handshake names the server and tools/list carries the one required argument",
    async () => {
      const server = startServer();
      const initialized = await server.handshake();
      const serverInfo = (initialized.result?.["serverInfo"] ?? {}) as { name?: unknown; version?: unknown };
      expect(initialized.error).toBeUndefined();
      expect(serverInfo.name).toBe("winedbg-mcp");
      // The version a client pins against, read from package.json as the
      // entrypoint reads it, so the two cannot drift.
      expect(serverInfo.version).toBe(SERVER_VERSION);

      const listed = await server.call("tools/list");
      const tools = (listed.result?.["tools"] ?? []) as { name: string; inputSchema: Record<string, unknown> }[];
      expect(tools.map((tool) => tool.name)).toEqual(["winedbg_start", "winedbg_execute", "winedbg_stop"]);
      // The schema reaches the model from the server, so the required command
      // has to be on the wire and not only in the tool module.
      const execute = tools.find((tool) => tool.name === "winedbg_execute");
      if (execute === undefined) throw new Error("winedbg_execute was not advertised");
      expect(execute.inputSchema["required"]).toEqual(["command"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a start, a command and a stop round trip through the debugger",
    async () => {
      const server = startServer();
      await server.handshake();

      const started = await server.call("tools/call", { name: "winedbg_start", arguments: { args: [FAKE] } });
      expect(isError(started.result)).toBe(false);
      expect(textOf(started)).toBe(`winedbg started successfully with args: ${FAKE}`);

      const reply = await server.call("tools/call", { name: "winedbg_execute", arguments: { command: "bt" } });
      expect(isError(reply.result)).toBe(false);
      expect(textOf(reply)).toBe("ran: bt");

      const stopped = await server.call("tools/call", { name: "winedbg_stop", arguments: {} });
      expect(isError(stopped.result)).toBe(false);
      expect(textOf(stopped)).toBe("winedbg session stopped.");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every call is answered and recorded, and a client hanging up exits 0",
    async () => {
      const server = startServer();
      await server.handshake();
      await server.call("tools/call", { name: "winedbg_start", arguments: { args: [FAKE] } });
      await server.call("tools/call", { name: "winedbg_execute", arguments: { command: "bt" } });
      // A bad argument is the model's mistake, and it comes back as a result it
      // can read and correct rather than as a dropped connection.
      const badArgument = await server.call("tools/call", { name: "winedbg_execute", arguments: { command: 42 } });
      expect(isError(badArgument.result)).toBe(true);
      expect(textOf(badArgument)).toMatch(/non-empty string/);
      // An unknown name is a protocol failure instead, and reporting it as a
      // result would tell the client a call it never made succeeded.
      const unknown = await server.call("tools/call", { name: "winedbg_nope", arguments: {} });
      expect(unknown.result).toBeUndefined();
      expect(unknown.error?.code).toBe(ErrorCode.MethodNotFound);
      expect(unknown.error?.message).toMatch(/Unknown tool/);

      // A client that closes stdin without a shutdown request is the ordinary
      // way an MCP client goes away, and the server has to exit on it rather
      // than sit on a debugger nobody can reach.
      server.endStdin();
      expect(await server.exited).toBe(0);

      const records = await server.logRecords();
      const started = records.filter((record) => record.message === "tool call started");
      expect(started).toHaveLength(4);
      // One counter per call ties the start, the outcome and the duration
      // together, which is the only thing in the log that names one call.
      const callIds = started.map((record) => record["callId"]);
      expect(new Set(callIds).size).toBe(4);
      for (const id of callIds) {
        expect(id).toMatch(/^call-\d+$/);
      }
      const finished = records.find(
        (record) => record.message === "tool call finished" && record["callId"] === callIds[1],
      );
      expect(finished?.["tool"]).toBe("winedbg_execute");
      expect(typeof finished?.["durationMs"]).toBe("number");
      // A call that answered with an error is a call that completed, and says
      // so with the same text the client got.
      const failed = records.find((record) => record.message === "tool call failed" && record["callId"] === callIds[2]);
      expect(failed?.["level"]).toBe("warn");
      expect(failed?.["error"]).toMatch(/non-empty string/);
      // A call that never reached a result still has to end on a line, or a log
      // that opens a call and never closes it reads as a hang.
      const rejected = records.find(
        (record) => record.message === "tool call rejected" && record["callId"] === callIds[3],
      );
      expect(rejected?.["level"]).toBe("error");
      expect(rejected?.["error"]).toMatch(/Unknown tool/);
      expect(records.some((record) => record.message === "shutting down")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

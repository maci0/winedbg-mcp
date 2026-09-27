// Goal: pin the tool layer's dispatch and error contract, which used to live in
// the entrypoint where nothing could reach it without starting a server.

import { describe, expect, test } from "bun:test";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../src/constants.js";
import { TOOLS, callTool, type ToolSession } from "../src/tools.js";

function stubSession(overrides: Partial<ToolSession> = {}): ToolSession {
  const session: ToolSession = {
    start: async () => {},
    executeCommand: async () => "bt\n#0 0x7b\nWine-dbg>",
    stop: () => {},
  };
  return { ...session, ...overrides };
}

describe("tool list", () => {
  test("names the three tools the handler dispatches", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "winedbg_start",
      "winedbg_execute",
      "winedbg_stop",
    ]);
  });
});

describe("callTool", () => {
  test("start passes the args through and reports them", async () => {
    let started: string[] | undefined;
    const result = await callTool(
      stubSession({ start: async (args: string[]) => void (started = args) }),
      "winedbg_start",
      { args: ["myapp.exe"] }
    );
    expect(started).toEqual(["myapp.exe"]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("winedbg started successfully with args: myapp.exe");
  });

  test("execute reports the debugger output", async () => {
    const result = await callTool(stubSession(), "winedbg_execute", { command: "bt" });
    expect(result.content[0]?.text).toContain("#0 0x7b");
  });

  test("execute says so when the debugger answers with nothing", async () => {
    const result = await callTool(
      stubSession({ executeCommand: async () => "" }),
      "winedbg_execute",
      { command: "step" }
    );
    expect(result.content[0]?.text).toBe("(Command executed successfully, no output)");
  });

  test("a bad argument is an error result, not a protocol failure", async () => {
    const result = await callTool(stubSession(), "winedbg_execute", { command: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/non-empty string/);
  });

  test("a session failure is an error result", async () => {
    const result = await callTool(
      stubSession({
        executeCommand: async () => {
          throw new Error("winedbg is not running. Please start it first.");
        },
      }),
      "winedbg_execute",
      { command: "bt" }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Error: winedbg is not running. Please start it first.");
  });

  test("an unknown tool is a protocol error the client has to see", async () => {
    await expect(callTool(stubSession(), "winedbg_nope", undefined)).rejects.toThrow(/Unknown tool/);
  });

  test("execute defaults the timeout when the caller omits it", async () => {
    let seen: number | undefined;
    await callTool(
      stubSession({ executeCommand: async (_command: string, timeout: number) => void (seen = timeout) }),
      "winedbg_execute",
      { command: "bt" }
    );
    expect(seen).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });
});

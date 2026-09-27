// Goal: pin the tool layer's dispatch and error contract, which used to live in
// the entrypoint where nothing could reach it without starting a server.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_ARG_CHARS,
  MAX_COMMAND_CHARS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_START_ARGS,
} from "../src/constants.js";
import { callTool, TOOLS, type ToolSession } from "../src/tools.js";

function stubSession(overrides: Partial<ToolSession> = {}): ToolSession {
  const session: ToolSession = {
    start: async () => {},
    executeCommand: async () => "bt\n#0 0x7b\nWine-dbg>",
    stop: () => {},
  };
  return { ...session, ...overrides };
}

function schemaOf(name: string) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.inputSchema as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

function propertyOf(tool: string, property: string) {
  const properties = schemaOf(tool).properties ?? {};
  const schema = properties[property];
  if (!schema) throw new Error(`${tool} advertises no ${property}`);
  return schema;
}

describe("tool list", () => {
  test("names the three tools the handler dispatches", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(["winedbg_start", "winedbg_execute", "winedbg_stop"]);
  });

  // The SDK does not enforce the schema it advertates, so a name that drifts
  // between the schema and the handler reads nothing and reports nothing: the
  // model sends the advertised field, the handler reads undefined, and the call
  // fails at the session instead of at the boundary. Pin the advertised names.
  test("advertises the argument names the handler reads", () => {
    expect(Object.keys(schemaOf("winedbg_start").properties ?? {})).toEqual(["args"]);
    expect(Object.keys(schemaOf("winedbg_execute").properties ?? {})).toEqual(["command", "timeout"]);
    expect(Object.keys(schemaOf("winedbg_stop").properties ?? {})).toEqual([]);
  });

  // Without this, a model turn that omits the command reaches the debugger as an
  // empty line, which draws a prompt and an empty reply, and the model sees a
  // successful command it never asked for.
  test("marks command as required, and nothing else", () => {
    expect(schemaOf("winedbg_execute").required).toEqual(["command"]);
    expect(schemaOf("winedbg_start").required).toBeUndefined();
    expect(schemaOf("winedbg_stop").required).toBeUndefined();
  });

  // A model builds its arguments from the schema, and the SDK does not check the
  // call against it, so a bound the validator enforces and the schema does not
  // state is a bound the model discovers only by having the call refused. Pin
  // each advertised bound to the constant the handler checks.
  test("advertises every bound the handler enforces", () => {
    expect(propertyOf("winedbg_start", "args")["maxItems"]).toBe(MAX_START_ARGS);
    expect(propertyOf("winedbg_start", "args")["items"]).toEqual({ type: "string", maxLength: MAX_ARG_CHARS });

    expect(propertyOf("winedbg_execute", "command")["minLength"]).toBe(1);
    expect(propertyOf("winedbg_execute", "command")["maxLength"]).toBe(MAX_COMMAND_CHARS);

    // The handler takes whole milliseconds only, so a fractional timeout is a
    // rejected call rather than the millisecond it rounds to.
    expect(propertyOf("winedbg_execute", "timeout")["type"]).toBe("integer");
    expect(propertyOf("winedbg_execute", "timeout")["minimum"]).toBe(1);
    expect(propertyOf("winedbg_execute", "timeout")["maximum"]).toBe(MAX_COMMAND_TIMEOUT_MS);
  });
});

describe("callTool", () => {
  test("start passes the args through and reports them", async () => {
    let started: string[] | undefined;
    const result = await callTool(
      stubSession({
        start: async (args: string[]) => {
          started = args;
        },
      }),
      "winedbg_start",
      { args: ["myapp.exe"] },
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
    const result = await callTool(stubSession({ executeCommand: async () => "" }), "winedbg_execute", {
      command: "step",
    });
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
      { command: "bt" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Error: winedbg is not running. Please start it first.");
  });

  test("an unknown tool is a protocol error the client has to see", async () => {
    await expect(callTool(stubSession(), "winedbg_nope", undefined)).rejects.toThrow(/Unknown tool/);
  });

  test("stop ends the session the model is holding", async () => {
    let stops = 0;
    const result = await callTool(
      stubSession({
        stop: () => {
          stops++;
        },
      }),
      "winedbg_stop",
      undefined,
    );
    expect(stops).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("winedbg session stopped.");
  });

  test("a stop that fails is an error result, not a lost session", async () => {
    const result = await callTool(
      stubSession({
        stop: () => {
          throw new Error("winedbg is not running. Please start it first.");
        },
      }),
      "winedbg_stop",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Error: winedbg is not running. Please start it first.");
  });

  test("execute defaults the timeout when the caller omits it", async () => {
    let seen: number | undefined;
    await callTool(
      stubSession({
        executeCommand: async (_command: string, timeout: number) => {
          seen = timeout;
          return "bt";
        },
      }),
      "winedbg_execute",
      { command: "bt" },
    );
    expect(seen).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });
});

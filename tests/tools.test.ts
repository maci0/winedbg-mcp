// Goal: pin the tool layer's dispatch and error contract, which used to live in
// the entrypoint where nothing could reach it without starting a server.

import { describe, expect, test } from "bun:test";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "../src/constants.js";
import { callTool, describeTools, type ToolSession } from "../src/tools.js";

// The value a deployment with no WINEDBG_MCP_COMMAND_TIMEOUT_MS runs on.
const DEPLOY_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;

/** callTool as index.ts calls it, with the configured default in the fourth place. */
const call = (session: ToolSession, name: string, args?: Record<string, unknown>) =>
  callTool(session, name, args, DEPLOY_TIMEOUT_MS);

function stubSession(overrides: Partial<ToolSession> = {}): ToolSession {
  const session: ToolSession = {
    start: async () => "started",
    executeCommand: async () => "bt\n#0 0x7b\nWine-dbg>",
    stop: () => {},
  };
  return { ...session, ...overrides };
}

describe("tool list", () => {
  // The three schemas are separate literal types and only one of them declares
  // `required`, so a name-keyed read needs a shape the assertions can talk
  // about: what the tool advertises, not how it was written. A name with no
  // tool fails here rather than asserting against undefined.
  type AdvertisedSchema = { properties: Record<string, unknown>; required?: readonly string[] };
  function schemaFor(name: string): AdvertisedSchema {
    const tool = describeTools(DEPLOY_TIMEOUT_MS).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return tool.inputSchema;
  }

  test("names the three tools the handler dispatches", () => {
    expect(describeTools(DEPLOY_TIMEOUT_MS).map((tool) => tool.name)).toEqual([
      "winedbg_start",
      "winedbg_execute",
      "winedbg_stop",
    ]);
  });

  // The SDK does not enforce the schema it advertates, so a name that drifts
  // between the schema and the handler reads nothing and reports nothing: the
  // model sends the advertised field, the handler reads undefined, and the call
  // fails at the session instead of at the boundary. Pin the advertised names.
  test("advertises the argument names the handler reads", () => {
    expect(Object.keys(schemaFor("winedbg_start").properties)).toEqual(["args"]);
    expect(Object.keys(schemaFor("winedbg_execute").properties)).toEqual(["command", "timeout"]);
    expect(Object.keys(schemaFor("winedbg_stop").properties)).toEqual([]);
  });

  // Without this, a model turn that omits the command reaches the debugger as an
  // empty line, which draws a prompt and an empty reply, and the model sees a
  // successful command it never asked for.
  test("marks command as required, and nothing else", () => {
    expect(schemaFor("winedbg_execute").required).toEqual(["command"]);
    expect(schemaFor("winedbg_start").required).toBeUndefined();
    expect(schemaFor("winedbg_stop").required).toBeUndefined();
  });

  // The description is what the model reads before choosing a timeout. A list
  // built from the constant while the deployment waits on something else tells
  // the model to pass a value the operator had already raised, or to give up on
  // a slow command the server would have waited for.
  test("names the default the call gets, and the variable that sets it", () => {
    // Narrowed on the literal name, so the schema read is the execute tool's
    // own and the collected list is checked for length: a list with no execute
    // tool in it must fail, not pass by asserting nothing.
    const described: string[] = [];
    for (const tool of describeTools(120000)) {
      if (tool.name !== "winedbg_execute") continue;
      described.push(tool.inputSchema.properties.timeout.description);
    }
    expect(described).toHaveLength(1);
    expect(described[0]).toContain("120000ms");
    expect(described[0]).toContain("WINEDBG_MCP_COMMAND_TIMEOUT_MS");
    expect(described[0]).toContain(String(MAX_COMMAND_TIMEOUT_MS));
  });
});

describe("callTool", () => {
  test("start passes the args through and reports them", async () => {
    let started: string[] | undefined;
    const result = await call(
      stubSession({
        start: async (args: string[]) => {
          started = args;
          return "started";
        },
      }),
      "winedbg_start",
      { args: ["myapp.exe"] },
    );
    expect(started).toEqual(["myapp.exe"]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("winedbg started successfully with args: myapp.exe");
  });

  test("start with no args launches the debugger plain", async () => {
    let started: string[] | undefined;
    // The call a model makes to attach to a PID it names in prose, or with no
    // arguments at all, reaches the debugger with nothing on its command line.
    const result = await call(
      stubSession({
        start: async (args: string[]) => {
          started = args;
          return "started";
        },
      }),
      "winedbg_start",
    );
    expect(started).toEqual([]);
    expect(result.content[0]?.text).toBe("winedbg started successfully with args: ");
  });

  // A retry that joined a session already asked for has to say so: the caller
  // reads this to decide whether a debugger, and the debuggee it launches, is
  // one it has or one it has to wait for.
  test("a start that joined a running session says it launched nothing", async () => {
    const result = await call(stubSession({ start: async () => "already-running" }), "winedbg_start", {
      args: ["myapp.exe"],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("already running");
    expect(result.content[0]?.text).toContain("launched nothing");
  });

  test("execute reports the debugger output", async () => {
    const result = await call(stubSession(), "winedbg_execute", { command: "bt" });
    expect(result.content[0]?.text).toContain("#0 0x7b");
  });

  test("execute says so when the debugger answers with nothing", async () => {
    const result = await call(stubSession({ executeCommand: async () => "" }), "winedbg_execute", {
      command: "step",
    });
    expect(result.content[0]?.text).toBe("(Command executed successfully, no output)");
  });

  test("a bad argument is an error result, not a protocol failure", async () => {
    const result = await call(stubSession(), "winedbg_execute", { command: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/non-empty string/);
  });

  test("a session failure is an error result", async () => {
    const result = await call(
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
    await expect(call(stubSession(), "winedbg_nope", undefined)).rejects.toThrow(/Unknown tool/);
  });

  test("stop ends the session the model is holding", async () => {
    let stops = 0;
    const result = await call(
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
    const result = await call(
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

  test("execute passes the caller's timeout to the session, and defaults it when omitted", async () => {
    const seen: number[] = [];
    const session = stubSession({
      executeCommand: async (_command: string, timeout: number) => {
        seen.push(timeout);
        return "bt";
      },
    });
    await call(session, "winedbg_execute", { command: "bt" });
    expect(seen).toEqual([DEFAULT_COMMAND_TIMEOUT_MS]);
    // The caller's own bound reaches the session rather than the default
    // quietly replacing it, which is what makes a timeout the model asked for
    // the one that fires.
    await call(session, "winedbg_execute", { command: "cont", timeout: 1234 });
    expect(seen).toEqual([DEFAULT_COMMAND_TIMEOUT_MS, 1234]);
  });

  test("execute refuses a timeout outside the range before the session sees it", async () => {
    let called = false;
    const result = await call(
      stubSession({
        executeCommand: async () => {
          called = true;
          return "bt";
        },
      }),
      "winedbg_execute",
      { command: "bt", timeout: 0 },
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/between 1 and/);
  });

  // A deployment that raised its ceiling through WINEDBG_MCP_COMMAND_TIMEOUT_MS
  // must not be handed the built-in one back by a call that simply left the
  // field out, which is the shape every model turn that omits a timeout takes.
  test("a call with no timeout gets the deployment's default, not the constant", async () => {
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
      120000,
    );
    expect(seen).toBe(120000);
  });

  // An explicit value is the caller's, whatever the deployment set.
  test("an explicit timeout overrides the deployment default", async () => {
    let seen: number | undefined;
    await callTool(
      stubSession({
        executeCommand: async (_command: string, timeout: number) => {
          seen = timeout;
          return "bt";
        },
      }),
      "winedbg_execute",
      { command: "bt", timeout: 500 },
      120000,
    );
    expect(seen).toBe(500);
  });
});

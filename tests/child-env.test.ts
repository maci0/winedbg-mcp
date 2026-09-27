// Goal: pin the environment the debugger is started with, since a child that
// inherits the launcher's whole environment hands every credential an MCP
// client started this server with to the program under debug, which is whoever
// supplied the target.
//
// Method: childEnv is pure and takes the environment as an argument, so each
// case is a plain object. The second half drives a real child through
// tests/fake-winedbg.js and reads back what it actually inherited, so the
// filter is pinned on the process boundary rather than on the helper.

import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logger.js";
import { childEnv, nodeRuntime } from "../src/runtime.js";
import { WinedbgSession } from "../src/session.js";

const FAKE = fileURLToPath(new URL("fake-winedbg.js", import.meta.url));
const READY_TIMEOUT_MS = 5000;

let session: WinedbgSession | null = null;

afterEach(() => {
  session?.stop();
  session = null;
});

async function ask(runtimeEnv: NodeJS.ProcessEnv, passthrough: string[], command: string): Promise<string> {
  const s = new WinedbgSession(
    process.execPath,
    READY_TIMEOUT_MS,
    nodeRuntime(runtimeEnv, passthrough),
    createLogger("error", () => {}),
  );
  session = s;
  await s.start([FAKE]);
  return s.executeCommand(command);
}

describe("childEnv", () => {
  test("a credential in the launcher's environment is not forwarded", () => {
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret", GITHUB_TOKEN: "ghp_secret" };
    expect(childEnv(env)).toEqual({ PATH: "/usr/bin" });
  });

  test("what a wineprefix and a program under it need is forwarded", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      DISPLAY: ":0",
      WINEPREFIX: "/home/u/.wine",
      WINEDEBUG: "-all",
      LC_ALL: "C.UTF-8",
    };
    expect(childEnv(env)).toEqual(env);
  });

  test("a name the deployment asked for is forwarded, and one it did not is not", () => {
    const env = { PATH: "/usr/bin", NEEDED: "yes", SECRET: "no" };
    expect(childEnv(env, ["NEEDED"])).toEqual({ PATH: "/usr/bin", NEEDED: "yes" });
  });

  test("a name nobody set forwards nothing rather than an empty value", () => {
    expect(childEnv({ PATH: "/usr/bin" }, ["ABSENT"])).toEqual({ PATH: "/usr/bin" });
  });
});

describe("the environment the debugger is started with", () => {
  // The end-to-end claim: what the program under debug reads is the filtered
  // set, not the launcher's.
  test("a credential in the launcher's environment does not reach the child", async () => {
    const env = { ...process.env, PATH: process.env["PATH"] ?? "/usr/bin", LAUNCHER_API_TOKEN: "s3cr3t" };
    expect(await ask(env, [], "env:LAUNCHER_API_TOKEN")).toBe("LAUNCHER_API_TOKEN=<unset>");
  });

  test("a wineprefix variable does reach the child", async () => {
    const env = { ...process.env, WINEDBG_TEST_PREFIX: "/tmp/prefix" };
    expect(await ask(env, [], "env:WINEDBG_TEST_PREFIX")).toBe("WINEDBG_TEST_PREFIX=/tmp/prefix");
  });

  test("a variable the deployment named is forwarded when it asks for it", async () => {
    const env = { ...process.env, WINEDBG_TEST_PASSTHROUGH: "wanted" };
    expect(await ask(env, ["WINEDBG_TEST_PASSTHROUGH"], "env:WINEDBG_TEST_PASSTHROUGH")).toBe(
      "WINEDBG_TEST_PASSTHROUGH=wanted",
    );
  });
});

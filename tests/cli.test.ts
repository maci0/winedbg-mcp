// Goal: pin the command-line contract, since a flag the server ignores is a
// deployment running something other than what the operator asked for.
//
// Method: the entry point is spawned, so the exit code and the stream each
// message lands on are what a script and a shell redirect actually see.

import { describe, expect, test } from "bun:test";
import { parseCliArgs, UsageError } from "../src/cli.js";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;
// A cold bun start plus a compile of the entry point is slow on a loaded
// machine. Past this the child is wedged, and a wedged child has to fail the
// test rather than hang it.
const SPAWN_TIMEOUT_MS = 30_000;
// Every test here spawns the entry point, so every one of them runs on this
// budget rather than bun's 5s default: in a parallel run a cold start alone
// exceeds 5s, and the default turns a slow machine into a red suite. The margin
// lets run() kill a wedged child and report its exit code, instead of the test
// deadline firing first and hiding why.
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 5_000;

type Run = { code: number; stdout: string; stderr: string };

async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const child = Bun.spawn([process.execPath, ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // The runner's stdin is not a client, and an inherited one outlives the
    // child in ways this test does not care about.
    stdin: "ignore",
    env: { ...process.env, ...env },
  });
  const collect = (async () => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  })();
  const timeout = setTimeout(() => child.kill(), SPAWN_TIMEOUT_MS);
  try {
    return await collect;
  } finally {
    clearTimeout(timeout);
  }
}

describe("parseCliArgs", () => {
  test("no arguments starts the server", () => {
    expect(parseCliArgs([])).toEqual({ kind: "serve" });
  });

  test("--help and -h are the same request", () => {
    expect(parseCliArgs(["--help"])).toEqual(parseCliArgs(["-h"]));
  });

  test("an unrecognized argument is a usage error", () => {
    for (const arg of ["--foo", "-x", "serve", "--HELP"]) {
      expect(() => parseCliArgs([arg])).toThrow(UsageError);
    }
  });
});

describe("winedbg-mcp --help", () => {
  test(
    "prints the usage on stdout and exits 0",
    async () => {
      const { code, stdout, stderr } = await run(["--help"]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Usage: winedbg-mcp");
      expect(stdout).toContain("--version");
      expect(stdout).toContain("WINEDBG_MCP_BINARY");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "works in a deployment whose environment the server would refuse",
    async () => {
      const { code, stdout, stderr } = await run(["--help"], { WINEDBG_MCP_BINRY: "winedbg" });
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Usage: winedbg-mcp");
    },
    TEST_TIMEOUT_MS
  );
});

describe("winedbg-mcp --version", () => {
  test(
    "prints the manifest version on stdout and exits 0",
    async () => {
      const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
        version: string;
      };
      const { code, stdout, stderr } = await run(["--version"]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe(manifest.version);
    },
    TEST_TIMEOUT_MS
  );
});

describe("winedbg-mcp with an unknown argument", () => {
  test(
    "names the argument on stderr and exits 2, leaving stdout empty",
    async () => {
      const { code, stdout, stderr } = await run(["--config=foo"]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("--config=foo");
      expect(stderr).toContain("--help");
    },
    TEST_TIMEOUT_MS
  );
});

describe("winedbg-mcp with an unusable environment value", () => {
  test(
    "exits 1 with the variable named on stderr",
    async () => {
      const { code, stdout, stderr } = await run([], { WINEDBG_MCP_READY_TIMEOUT_MS: "0" });
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("WINEDBG_MCP_READY_TIMEOUT_MS");
    },
    TEST_TIMEOUT_MS
  );
});

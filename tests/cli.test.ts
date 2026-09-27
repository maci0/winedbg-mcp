// Goal: pin the command-line contract, since a flag the server ignores is a
// deployment running something other than what the operator asked for.
//
// Method: the entry point is spawned, so the exit code and the stream each
// message lands on are what a script and a shell redirect actually see.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseCliArgs, UsageError } from "../src/cli.js";

// fileURLToPath, not .pathname: a file: URL is percent-encoded, and on Windows
// its pathname carries a leading slash the path does not have (C:\a becomes
// /C:/a). Either way a checkout under a directory with a space or a non-ASCII
// character in it spawns a path that does not exist.
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
// A cold bun start plus a compile of the entry point is slow on a loaded
// machine. Past this the child is wedged, and a wedged child has to fail the
// test rather than hang it.
const SPAWN_TIMEOUT_MS = 30_000;
// Every test here spawns the entry point, so every one of them runs on this
// budget rather than bun's 5s default: in a parallel run a cold start alone
// exceeds 5s, and the default turns a slow machine into a red suite. A test
// deadline below SPAWN_TIMEOUT_MS lets the runner abandon the test while the
// child is still starting, which reports a pass-shaped failure with exit code
// 143 instead of the hang the spawn timeout exists to catch. The margin lets
// run() kill a wedged child and report its exit code, instead of the test
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

  test("--version and -V are the same request", () => {
    expect(parseCliArgs(["--version"])).toEqual(parseCliArgs(["-V"]));
  });

  test("an unrecognized argument is a usage error", () => {
    for (const arg of ["--foo", "-x", "serve", "--HELP"]) {
      expect(() => parseCliArgs([arg])).toThrow(UsageError);
    }
  });

  test("-- ends the options, so what follows is an operand and not a flag", () => {
    expect(parseCliArgs(["--"])).toEqual({ kind: "serve" });
    for (const args of [
      ["--", "--help"],
      ["--", "-h"],
      ["--", "serve"],
    ]) {
      expect(() => parseCliArgs(args)).toThrow(UsageError);
    }
  });

  // The spawned half of this is left to the artifact check rather than run here:
  // `bun <entry> -- x` hands the entry an argv with the separator already eaten,
  // so a spawn cannot put a real "--" on the command line the server reads.
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
    TEST_TIMEOUT_MS,
  );

  test(
    "works in a deployment whose environment the server would refuse",
    async () => {
      const { code, stdout, stderr } = await run(["--help"], { WINEDBG_MCP_BINRY: "winedbg" });
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Usage: winedbg-mcp");
    },
    TEST_TIMEOUT_MS,
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
    TEST_TIMEOUT_MS,
  );

  test(
    "-V is the same answer on the same stream",
    async () => {
      const short = await run(["-V"]);
      const long = await run(["--version"]);
      expect(short).toEqual(long);
    },
    TEST_TIMEOUT_MS,
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
      expect(stderr).toContain("Usage: winedbg-mcp");
      expect(stderr).toContain("--help");
    },
    TEST_TIMEOUT_MS,
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
    TEST_TIMEOUT_MS,
  );
});

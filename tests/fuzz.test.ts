// Goal: fuzz the MCP tool-argument boundary, the one place a model's turn
// becomes an argv entry and a line on the debugger's stdin. Every value here is
// untrusted, so the harness generates and mutates values no unit test writes by
// hand: the wrong type, the wrong shape, the value one character past a limit, a
// NUL, a lone surrogate, a nesting that stops being a string where the code
// expects one.
//
// Method: a seed picks a value, then a few mutations of it, and each result goes
// through the same checks. One seed fully determines the run, so a failing case
// prints its seed and WINEDBG_MCP_FUZZ_SEED replays just that one.
//
// The invariants encoded here, not just "does not throw": validation either
// rejects with InvalidParams, or returns a value that is safe to hand to spawn
// and identical to the input, and a value it returns is accepted again. On the
// callTool side, a rejected call must reach no session method at all, and an
// accepted one must reach it verbatim. That pair is what catches a validator
// that quietly mangles or truncates on the way past.

import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "../src/constants.js";
import { LINE_BREAKS } from "../src/session.js";
import { callTool, type ToolResult, type ToolSession } from "../src/tools.js";
import {
  MAX_ARG_CHARS,
  MAX_COMMAND_CHARS,
  MAX_START_ARGS,
  optionalTimeout,
  requireString,
  requireStringArray,
} from "../src/validate.js";

const CASES_PER_SEED = 150;
const MAX_MUTATIONS = 3;
// A nesting the JSON a client sends can reach and the code has to survive.
const MAX_DEPTH = 4;
// Each seed past the first is a different mix; a rerun of one seed is the same
// stream, which is what makes a report from CI reproducible.
const SEEDS: number[] = Array.from({ length: 12 }, (_, index) => 7 + index * 7919);

// Fragments that have historically broken C readers and stream decoders, kept
// together so a generated string is stitched out of exactly the pieces that
// matter instead of out of uniform random characters.
const FRAGMENTS: readonly string[] = [
  "",
  "a",
  "bt",
  "\0",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u0085",
  "\u2028",
  "\u2029",
  " ",
  "app.exe",
  "../../etc/passwd",
  "--headless",
  "\u20ac",
  "\u{1d49e}",
  "\u00e9",
  "\ud800",
  "\udfff",
  "x".repeat(64),
  "y".repeat(MAX_ARG_CHARS),
  "z".repeat(MAX_COMMAND_CHARS + 1),
];

const SCALARS: readonly unknown[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
  Number.EPSILON,
  true,
  false,
  null,
  undefined,
  { command: "bt" },
  { args: ["app.exe"] },
  ["bt"],
  () => "bt",
  Symbol.iterator,
];

/** mulberry32: small, and a fixed seed always yields the same stream. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  // rng() is in [0, 1), so the index is in range; the wrap is there for the
  // rounding that puts a value of that size on 1.
  return items[Math.floor(rng() * items.length) % items.length] as T;
}

function randomString(rng: () => number): string {
  const parts = Math.floor(rng() * 4) + 1;
  let out = "";
  for (let index = 0; index < parts; index++) out += pick(rng, FRAGMENTS);
  return out;
}

/** Any value a client can put on the wire, including shapes nobody writes on purpose. */
function randomValue(rng: () => number, depth: number = 0): unknown {
  const roll = rng();
  if (depth >= MAX_DEPTH || roll < 0.5) {
    return roll < 0.25 ? randomString(rng) : pick(rng, SCALARS);
  }
  if (roll < 0.75) {
    const length = Math.floor(rng() * 4);
    return Array.from({ length }, () => randomValue(rng, depth + 1));
  }
  const key = pick(rng, ["command", "args", "timeout", "extra"]);
  return { [key]: randomValue(rng, depth + 1) };
}

/** Damage applied to a generated value, so a near miss reaches the same code. */
function mutate(rng: () => number, value: unknown): unknown {
  const roll = rng();
  if (typeof value === "string") {
    if (roll < 0.25) return value + pick(rng, FRAGMENTS);
    if (roll < 0.5) return value.slice(0, Math.floor(rng() * (value.length + 1)));
    if (roll < 0.75) {
      const at = Math.floor(rng() * (value.length + 1));
      return value.slice(0, at) + pick(rng, FRAGMENTS) + value.slice(at);
    }
    return pick(rng, SCALARS);
  }
  if (Array.isArray(value)) {
    if (roll < 0.5) return [...value, randomValue(rng, MAX_DEPTH)];
    if (roll < 0.75) return value.slice(0, 1);
    return value.map(() => randomValue(rng, MAX_DEPTH));
  }
  if (value !== null && typeof value === "object") {
    return { ...value, command: randomValue(rng, MAX_DEPTH) };
  }
  return randomValue(rng, MAX_DEPTH);
}

/** The values of one seed, ready to check: each generated value, then its mutated form. */
function casesFor(seed: number): unknown[] {
  const rng = mulberry32(seed);
  const cases: unknown[] = [];
  for (let index = 0; index < CASES_PER_SEED; index++) {
    let value = randomValue(rng);
    cases.push(value);
    for (let round = 0; round < MAX_MUTATIONS; round++) value = mutate(rng, value);
    cases.push(value);
  }
  return cases;
}

/** Seeds to sweep, or the one a failure reported. */
function fuzzSeeds(): number[] {
  const only = process.env["WINEDBG_MCP_FUZZ_SEED"];
  return only === undefined ? SEEDS : [Number(only)];
}

function isInvalidParams(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.InvalidParams;
}

describe("requireString", () => {
  test("either rejects with InvalidParams or returns the input unchanged and safe to send", () => {
    const run: string[] = [];
    for (const seed of fuzzSeeds()) {
      const cases = casesFor(seed);
      for (const [index, value] of cases.entries()) {
        let accepted: string;
        try {
          accepted = requireString(value, "command");
        } catch (error) {
          expect({ seed, index, invalidParams: isInvalidParams(error) }).toEqual({ seed, index, invalidParams: true });
          continue;
        }
        // The input is compared as-is, so a coercion the validator made on the
        // way through is a failure here rather than a surprise at spawn.
        expect(accepted as unknown).toBe(value);
        expect(accepted.length).toBeGreaterThan(0);
        expect(accepted.length).toBeLessThanOrEqual(MAX_COMMAND_CHARS);
        // A NUL truncates the line for most C readers, so it never leaves here.
        expect(accepted.includes("\0")).toBe(false);
        expect(LINE_BREAKS.test(accepted)).toBe(false);
        // What survived the first pass has to survive the second: a value the
        // validator reshapes on the way through is one it rejects later.
        expect(requireString(accepted, "command")).toBe(accepted);
      }
      run.push(`seed ${seed}: ${cases.length} values`);
    }
    expect(run).toHaveLength(fuzzSeeds().length);
  });
});

describe("requireStringArray", () => {
  test("accepts only argv-safe entries and preserves them in order", () => {
    const run: string[] = [];
    for (const seed of fuzzSeeds()) {
      const cases = casesFor(seed);
      for (const [index, value] of cases.entries()) {
        let accepted: string[];
        try {
          accepted = requireStringArray(value, "args");
        } catch (error) {
          expect({ seed, index, invalidParams: isInvalidParams(error) }).toEqual({ seed, index, invalidParams: true });
          continue;
        }
        // An absent field is the documented default, not a pass-through.
        expect(accepted as unknown).toEqual(value === undefined ? [] : value);
        expect(accepted.length).toBeLessThanOrEqual(MAX_START_ARGS);
        for (const item of accepted) {
          expect(typeof item).toBe("string");
          expect(item.length).toBeLessThanOrEqual(MAX_ARG_CHARS);
          expect(item.includes("\0")).toBe(false);
        }
        expect(requireStringArray(accepted, "args")).toEqual(accepted);
      }
      run.push(`seed ${seed}: ${cases.length} values`);
    }
    expect(run).toHaveLength(fuzzSeeds().length);
  });

  test("defaults to empty when the field is absent", () => {
    expect(requireStringArray(undefined, "args")).toEqual([]);
  });
});

describe("optionalTimeout", () => {
  test("returns a whole number of milliseconds inside the range, or rejects", () => {
    const run: string[] = [];
    for (const seed of fuzzSeeds()) {
      for (const [index, value] of casesFor(seed).entries()) {
        let accepted: number;
        try {
          accepted = optionalTimeout(value, DEFAULT_COMMAND_TIMEOUT_MS);
        } catch (error) {
          expect({ seed, index, invalidParams: isInvalidParams(error) }).toEqual({ seed, index, invalidParams: true });
          continue;
        }
        // An absent field is the documented default, not a pass-through.
        expect(accepted as unknown).toBe(value === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : value);
        expect(Number.isInteger(accepted)).toBe(true);
        expect(accepted).toBeGreaterThan(0);
        expect(accepted).toBeLessThanOrEqual(MAX_COMMAND_TIMEOUT_MS);
        expect(optionalTimeout(accepted, DEFAULT_COMMAND_TIMEOUT_MS)).toBe(accepted);
      }
      run.push(`seed ${seed}`);
    }
    expect(run).toHaveLength(fuzzSeeds().length);
  });

  test("falls back to the default when the field is absent", () => {
    expect(optionalTimeout(undefined, DEFAULT_COMMAND_TIMEOUT_MS)).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });
});

type Recorder = {
  session: ToolSession;
  started: string[][];
  executed: { command: string; timeout: number }[];
  stopped: number;
};

function recordingSession(): Recorder {
  const started: string[][] = [];
  const executed: { command: string; timeout: number }[] = [];
  const recorder: Recorder = {
    started,
    executed,
    stopped: 0,
    session: {
      start: async (args: string[]) => {
        started.push(args);
        return "started";
      },
      executeCommand: async (command: string, timeout: number) => {
        executed.push({ command, timeout });
        return "";
      },
      stop: () => {
        recorder.stopped++;
      },
    },
  };
  return recorder;
}

/** Present a generated value as a tool-call argument object, sometimes the value itself. */
function argsBag(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { command: value, args: value, timeout: value } as unknown as Record<string, unknown>;
}

function toolNameFor(seed: number, index: number): string {
  const names = ["winedbg_start", "winedbg_execute", "winedbg_stop", "winedbg_typo"];
  return pick(mulberry32(seed * 31 + index), names);
}

describe("callTool", () => {
  test("a rejected argument reaches no session method, and an accepted one reaches it verbatim", async () => {
    const run: string[] = [];
    for (const seed of fuzzSeeds()) {
      const cases = casesFor(seed);
      for (const [index, value] of cases.entries()) {
        const recorder = recordingSession();
        const args = argsBag(value);
        let result: ToolResult;
        try {
          result = await callTool(recorder.session, toolNameFor(seed, index), args, DEFAULT_COMMAND_TIMEOUT_MS);
        } catch (error) {
          // An unknown tool is a protocol error the client has to see. A bad
          // argument is not: it has to come back as a result, so nothing ran.
          expect(error).toBeInstanceOf(McpError);
          expect((error as McpError).code).toBe(ErrorCode.MethodNotFound);
          expect(recorder.started).toEqual([]);
          expect(recorder.executed).toEqual([]);
          expect(recorder.stopped).toBe(0);
          continue;
        }
        const [first] = result.content;
        expect(first?.text.length ?? 0).toBeGreaterThan(0);
        if (result.isError === true) {
          expect(recorder.started).toEqual([]);
          expect(recorder.executed).toEqual([]);
          expect(recorder.stopped).toBe(0);
          continue;
        }
        for (const argv of recorder.started) {
          expect(argv.length).toBeLessThanOrEqual(MAX_START_ARGS);
          for (const item of argv) expect(item.includes("\0")).toBe(false);
        }
        for (const sent of recorder.executed) {
          // The session saw exactly what the validator accepted: no trimming,
          // no coercion, no substitution.
          expect(sent.command).toBe(requireString(args?.["command"], "command"));
          expect(sent.command.includes("\0")).toBe(false);
          expect(LINE_BREAKS.test(sent.command)).toBe(false);
          expect(sent.timeout).toBe(optionalTimeout(args?.["timeout"], DEFAULT_COMMAND_TIMEOUT_MS));
        }
      }
      run.push(`seed ${seed}: ${cases.length} values`);
    }
    expect(run).toHaveLength(fuzzSeeds().length);
  });

  test("an unknown tool name is a protocol error, whatever the arguments are", async () => {
    for (const name of ["", "winedbg", "WINEDBG_START", "winedbg_start ", "winedbg_start;rm -rf /"]) {
      await expect(
        callTool(recordingSession().session, name, { command: "bt" }, DEFAULT_COMMAND_TIMEOUT_MS),
      ).rejects.toBeInstanceOf(McpError);
    }
  });
});

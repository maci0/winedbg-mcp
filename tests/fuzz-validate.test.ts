// Goal: fuzz the MCP tool-argument boundary. These three functions are the only
// thing between a model's JSON and the argv handed to spawn() and the text
// written to the debugger's stdin, so a coercion bug here reaches a shell-less
// spawn and a live prompt.
//
// Method: Bun has no coverage-guided fuzzer and the project takes no fuzzing
// dependency, so this is a deterministic property run over a seeded PRNG. The
// seed corpus holds shapes a real client sends (and a few it must never send),
// and the generator mutates values around them. SEED and CASES are the two
// knobs: change the seed to get another run, or raise CASES for a longer one.
// The invariants, not the input count, are what make a failure mean something:
// every accepted value must come back byte-for-byte as the caller sent it, and
// every rejected value must fail as an InvalidParams McpError naming the field.

import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { MAX_COMMAND_TIMEOUT_MS } from "../src/session.js";
import { optionalTimeout, requireString, requireStringArray } from "../src/validate.js";

const SEED = 0x5eed;
const CASES = 3000;
const PROMPT = "Wine-dbg>";

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function capture(call: () => unknown): Outcome {
  try {
    return { ok: true, value: call() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** mulberry32: small, deterministic, and no dependency to install. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRING_PIECES = [
  "bt",
  "cont",
  " ",
  "\t",
  "\n",
  "\r\n",
  "\0",
  "1e4",
  "0x10",
  "12.5",
  "-1",
  PROMPT,
  "é",
  "\ud800",
  "𝕓",
  "\\",
  '"',
  "back;quote",
  "$(id)",
  "a".repeat(4096),
];

const NUMBERS = [
  0, -0, 1, -1, 0.5, 1e21, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, MAX_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS + 1, -MAX_COMMAND_TIMEOUT_MS, NaN, Infinity, -Infinity,
];

const SEED_CORPUS: unknown[] = [
  undefined, null, true, false, 0, 1, "", " ", "\n", PROMPT, [], {}, [""], [null], [1],
  [{ command: "bt" }], { command: "bt" }, [[]], [[[]]], { args: ["app.exe"] },
  { args: "app.exe" }, { timeout: "1000" }, { timeout: null }, { command: "" },
  ...NUMBERS, ...STRING_PIECES,
];

function randomValue(random: () => number, depth: number): unknown {
  const pick = random();
  // Deep nesting reaches the recursive shapes a real client never sends.
  if (depth > 3 || pick < 0.4) {
    const leaf = random();
    if (leaf < 0.15) return undefined;
    if (leaf < 0.25) return null;
    if (leaf < 0.35) return random() < 0.5;
    if (leaf < 0.6) return NUMBERS[Math.floor(random() * NUMBERS.length)]!;
    const piece = STRING_PIECES[Math.floor(random() * STRING_PIECES.length)]!;
    return random() < 0.5 ? piece : piece.repeat(1 + Math.floor(random() * 3));
  }
  if (pick < 0.7) {
    const length = Math.floor(random() * 4);
    return Array.from({ length }, () => randomValue(random, depth + 1));
  }
  return { command: randomValue(random, depth + 1), timeout: randomValue(random, depth + 1) };
}

const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (!condition) failures.push(label);
}

function checkRejection(outcome: Outcome, field: string, label: string): void {
  if (outcome.ok) {
    failures.push(`${label}: accepted ${JSON.stringify(outcome.value)}`);
    return;
  }
  const error = outcome.error;
  // Anything other than InvalidParams reaches the client as an opaque internal
  // failure, and a message that omits the field leaves the caller guessing.
  check(error instanceof McpError, `${label}: threw ${String(error)} instead of McpError`);
  if (!(error instanceof McpError)) return;
  check(error.code === ErrorCode.InvalidParams, `${label}: code ${error.code}`);
  check(error.message.includes(field), `${label}: message "${error.message}" omits ${field}`);
}

describe("validate.ts fuzz", () => {
  test("requireStringArray", () => {
    const random = prng(SEED);
    for (let i = 0; i < CASES; i++) {
      const input = i < SEED_CORPUS.length ? SEED_CORPUS[i] : randomValue(random, 0);
      const label = `requireStringArray case ${i} (${JSON.stringify(input)})`;
      const outcome = capture(() => requireStringArray(input, "args"));
      if (input === undefined) {
        check(outcome.ok, `${label}: undefined must default`);
        if (outcome.ok) check(Array.isArray(outcome.value) && outcome.value.length === 0, `${label}: default not empty`);
        continue;
      }
      if (outcome.ok) {
        const value = outcome.value;
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
          failures.push(`${label}: returned ${JSON.stringify(value)}`);
          continue;
        }
        // spawn() must see the argument list the client sent, element for element.
        check(
          JSON.stringify(value) === JSON.stringify(input),
          `${label}: altered the argv ${JSON.stringify(input)} -> ${JSON.stringify(value)}`
        );
        continue;
      }
      checkRejection(outcome, "args", label);
    }
  });

  test("requireString", () => {
    const random = prng(SEED + 1);
    for (let i = 0; i < CASES; i++) {
      const input = i < SEED_CORPUS.length ? SEED_CORPUS[i] : randomValue(random, 0);
      const label = `requireString case ${i} (${JSON.stringify(input)})`;
      const outcome = capture(() => requireString(input, "command"));
      if (outcome.ok) {
        const value = outcome.value;
        // A trimmed or coerced command is a different command, and an empty one
        // is a command that only draws another prompt.
        check(typeof value === "string" && value.length > 0, `${label}: returned ${JSON.stringify(value)}`);
        check(value === input, `${label}: altered the command to ${JSON.stringify(value)}`);
        continue;
      }
      checkRejection(outcome, "command", label);
    }
  });

  test("optionalTimeout", () => {
    const random = prng(SEED + 2);
    for (let i = 0; i < CASES; i++) {
      const input = i < SEED_CORPUS.length ? SEED_CORPUS[i] : randomValue(random, 0);
      const label = `optionalTimeout case ${i} (${JSON.stringify(input)})`;
      const outcome = capture(() => optionalTimeout(input));
      if (input === undefined) continue; // The default needs no invariant of its own.
      if (outcome.ok) {
        const value = outcome.value;
        // A timeout outside the range fires before the debugger can answer, and
        // a non-number would arm setTimeout with a coerced value.
        check(typeof value === "number" && Number.isFinite(value), `${label}: returned ${JSON.stringify(value)}`);
        check(value > 0 && value <= MAX_COMMAND_TIMEOUT_MS, `${label}: out of range ${String(value)}`);
        check(value === input, `${label}: altered the timeout to ${String(value)}`);
        continue;
      }
      checkRejection(outcome, "timeout", label);
    }
  });

  test("no case violated an invariant", () => {
    expect(failures).toEqual([]);
  });
});

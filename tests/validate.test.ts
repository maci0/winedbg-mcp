// Goal: pin the MCP tool-argument boundary. These values come from a model, so
// every one of them is untrusted input on the way to spawn and to the debugger.

import { describe, expect, test } from "bun:test";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "../src/constants.js";
import {
  MAX_ARG_CHARS,
  MAX_COMMAND_CHARS,
  MAX_START_ARGS,
  optionalTimeout,
  requireString,
  requireStringArray,
} from "../src/validate.js";

describe("requireStringArray", () => {
  test("defaults to empty when the field is absent", () => {
    expect(requireStringArray(undefined, "args")).toEqual([]);
  });

  test("passes an array of strings through", () => {
    expect(requireStringArray(["app.exe", "1234"], "args")).toEqual(["app.exe", "1234"]);
  });

  test("rejects a bare string, which would spread into single characters", () => {
    expect(() => requireStringArray("app.exe", "args")).toThrow(/array of strings/);
  });

  test("rejects non-string elements before they reach spawn", () => {
    expect(() => requireStringArray([1234], "args")).toThrow(/array of strings/);
    expect(() => requireStringArray([null], "args")).toThrow(/array of strings/);
  });

  test("rejects a NUL in an argument, naming its index", () => {
    // spawn() would otherwise reject the whole call with ERR_INVALID_ARG_VALUE,
    // which names neither the argument nor where it came from.
    expect(() => requireStringArray(["app.exe", "a\0b"], "args")).toThrow(/args\[1\].*NUL/);
  });

  test("bounds the number of entries and the length of each", () => {
    expect(requireStringArray(new Array(MAX_START_ARGS).fill("a"), "args").length).toBe(MAX_START_ARGS);
    expect(() => requireStringArray(new Array(MAX_START_ARGS + 1).fill("a"), "args")).toThrow(
      /at most 64 entries/
    );
    expect(() => requireStringArray(["a".repeat(MAX_ARG_CHARS + 1)], "args")).toThrow(/at most 4096 characters/);
  });

  test("passes a non-ASCII path through, encoded as UTF-8 all the way", () => {
    // A decomposed name (macOS NFD) is a different byte sequence from the
    // composed one and is a legal filename, so it has to reach spawn intact.
    // The escape keeps the form unambiguous: an editor or a formatter that
    // normalizes the file would otherwise turn the test into its opposite.
    const nfd = "cafe\u0301.txt";
    expect(nfd).not.toBe(nfd.normalize("NFC"));
    const passed = requireStringArray([nfd], "args");
    expect(passed).toEqual([nfd]);
    // The argv reaches spawn as the decomposed bytes, not the composed 0xc3 0xa9
    // a normalizer would fold it to.
    const nfdBytes = Buffer.concat([Buffer.from("cafe"), Buffer.from([0xcc, 0x81]), Buffer.from(".txt")]);
    expect(Buffer.from(passed.join(""), "utf8")).toEqual(nfdBytes);
  });

  test("rejects an unpaired surrogate, which UTF-8 cannot carry", () => {
    expect(() => requireStringArray(["app\ud800.exe"], "args")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => requireStringArray(["app\udc00.exe"], "args")).toThrow(/unpaired UTF-16 surrogate/);
  });
});

describe("requireString", () => {
  test("passes a command through", () => {
    expect(requireString("bt", "command")).toBe("bt");
  });

  test("rejects a missing command instead of sending the text 'undefined'", () => {
    expect(() => requireString(undefined, "command")).toThrow(/non-empty string/);
  });

  test("rejects an empty command, which would only draw another prompt", () => {
    expect(() => requireString("", "command")).toThrow(/non-empty string/);
  });

  test("rejects a non-string command", () => {
    expect(() => requireString({ cmd: "bt" }, "command")).toThrow(/non-empty string/);
  });

  test("rejects a line break every stream reader agrees on", () => {
    // Each of these draws a prompt in some reader, which leaves every later
    // reply one command behind.
    for (const command of ["bt\ncont", "bt\rcont", "bt\vcont", "bt\fcont", "bt\u0085cont", "bt\u2028cont", "bt\u2029cont"]) {
      expect(() => requireString(command, "command")).toThrow(/single line/);
    }
  });

  test("rejects NUL, which truncates the line for a C reader", () => {
    expect(() => requireString("bt\u0000cont", "command")).toThrow(/single line/);
  });

  test("bounds the command length", () => {
    expect(requireString("a".repeat(MAX_COMMAND_CHARS), "command")).toHaveLength(MAX_COMMAND_CHARS);
    expect(() => requireString("a".repeat(MAX_COMMAND_CHARS + 1), "command")).toThrow(/at most 4096 characters/);
  });

  test("rejects an unpaired surrogate, which UTF-8 cannot carry", () => {
    expect(() => requireString("break \ud800", "command")).toThrow(/unpaired UTF-16 surrogate/);
    // A matched pair is one character above the BMP and encodes normally.
    expect(requireString("break \u{1F600}", "command")).toBe("break \u{1F600}");
  });
});

describe("optionalTimeout", () => {
  test("defaults when absent", () => {
    expect(optionalTimeout(undefined)).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });

  test("passes a sane value through", () => {
    expect(optionalTimeout(500)).toBe(500);
    expect(optionalTimeout(MAX_COMMAND_TIMEOUT_MS)).toBe(MAX_COMMAND_TIMEOUT_MS);
  });

  test("rejects values that expire before the debugger can answer", () => {
    expect(() => optionalTimeout(0)).toThrow(/between 1 and/);
    expect(() => optionalTimeout(-1)).toThrow(/between 1 and/);
  });

  test("rejects non-finite and out-of-range values", () => {
    expect(() => optionalTimeout(NaN)).toThrow(/between 1 and/);
    expect(() => optionalTimeout(Infinity)).toThrow(/between 1 and/);
    expect(() => optionalTimeout(MAX_COMMAND_TIMEOUT_MS + 1)).toThrow(/between 1 and/);
  });

  test("rejects a fraction of a millisecond, which is below the stated floor", () => {
    expect(() => optionalTimeout(0.5)).toThrow(/between 1 and/);
  });

  test("rejects a numeric string", () => {
    expect(() => optionalTimeout("1000")).toThrow(/between 1 and/);
  });
});

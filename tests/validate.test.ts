// Goal: pin the MCP tool-argument boundary. These values come from a model, so
// every one of them is untrusted input on the way to spawn and to the debugger.

import { describe, expect, test } from "bun:test";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "../src/session.js";
import { optionalRequestId, optionalTimeout, requireString, requireStringArray } from "../src/validate.js";

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

  test("rejects a numeric string", () => {
    expect(() => optionalTimeout("1000")).toThrow(/between 1 and/);
  });
});

describe("optionalRequestId", () => {
  test("is absent when the field is absent, which leaves every call a new run", () => {
    expect(optionalRequestId(undefined)).toBeUndefined();
  });

  test("passes a short id through", () => {
    expect(optionalRequestId("break-1")).toBe("break-1");
  });

  test("rejects an empty id, which would name every retry the same command", () => {
    expect(() => optionalRequestId("")).toThrow(/1 to 128 characters/);
  });

  test("rejects a non-string id", () => {
    expect(() => optionalRequestId(7)).toThrow(/1 to 128 characters/);
  });

  test("rejects an id long enough to bloat the answers kept against it", () => {
    expect(() => optionalRequestId("x".repeat(129))).toThrow(/1 to 128 characters/);
    expect(optionalRequestId("x".repeat(128))).toHaveLength(128);
  });
});

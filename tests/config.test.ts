// Goal: pin the environment parsing, since a wrong value here is the difference
// between a server that refuses to start with the variable named and one that
// runs on defaults nobody asked for.
//
// Method: loadConfig takes the environment as an argument, so every case is a
// plain object. process.env is never touched.

import { describe, expect, test } from "bun:test";
import { BINARY_VAR, describeConfig, loadConfig, READY_TIMEOUT_VAR } from "../src/config.js";
import { DEFAULT_BINARY, DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS } from "../src/constants.js";

describe("loadConfig", () => {
  test("an empty environment gives the documented defaults", () => {
    expect(loadConfig({})).toEqual({
      binary: DEFAULT_BINARY,
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    });
  });

  test("both variables override", () => {
    const config = loadConfig({
      [BINARY_VAR]: "/opt/wine/bin/winedbg",
      [READY_TIMEOUT_VAR]: "45000",
    });
    expect(config).toEqual({ binary: "/opt/wine/bin/winedbg", readyTimeoutMs: 45000 });
  });

  test("unrelated variables are left alone", () => {
    expect(loadConfig({ PATH: "/usr/bin", WINEPREFIX: "/home/u/.wine" }).binary).toBe(DEFAULT_BINARY);
  });

  test("a misspelled WINEDBG_MCP_ variable is refused, not ignored", () => {
    expect(() => loadConfig({ WINEDBG_MCP_BINRY: "winedbg" })).toThrow(/WINEDBG_MCP_BINRY/);
  });

  test("set-to-empty is an error, not the default", () => {
    expect(() => loadConfig({ [BINARY_VAR]: "" })).toThrow(/empty/);
    expect(() => loadConfig({ [BINARY_VAR]: "   " })).toThrow(/empty/);
  });

  test("a binary path no executable can carry is refused", () => {
    expect(() => loadConfig({ [BINARY_VAR]: "/opt/wine/bin/wine\0dbg" })).toThrow(/NUL/);
  });

  test("a non-numeric ready timeout is refused", () => {
    for (const raw of ["", " ", "abc", "10s", "1e4", "0x10", "12.5", "-5"]) {
      expect(() => loadConfig({ [READY_TIMEOUT_VAR]: raw })).toThrow(new RegExp(READY_TIMEOUT_VAR));
    }
  });

  test("a ready timeout outside the range is refused", () => {
    expect(() => loadConfig({ [READY_TIMEOUT_VAR]: "0" })).toThrow(new RegExp(READY_TIMEOUT_VAR));
    expect(() => loadConfig({ [READY_TIMEOUT_VAR]: String(MAX_READY_TIMEOUT_MS + 1) })).toThrow(
      new RegExp(READY_TIMEOUT_VAR),
    );
    expect(loadConfig({ [READY_TIMEOUT_VAR]: String(MAX_READY_TIMEOUT_MS) }).readyTimeoutMs).toBe(MAX_READY_TIMEOUT_MS);
  });

  test("the startup line names both variables and their active values", () => {
    const line = describeConfig(loadConfig({ [BINARY_VAR]: "/opt/wine/bin/winedbg" }));
    expect(line).toContain(`${BINARY_VAR}=/opt/wine/bin/winedbg`);
    expect(line).toContain(`${READY_TIMEOUT_VAR}=${DEFAULT_READY_TIMEOUT_MS}`);
  });
});

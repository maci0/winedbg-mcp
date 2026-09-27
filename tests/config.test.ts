// Goal: pin the environment parsing, since a wrong value here is the difference
// between a server that refuses to start with the variable named and one that
// runs on defaults nobody asked for.
//
// Method: loadConfig takes the environment as an argument, so every case is a
// plain object. process.env is never touched.

import { describe, expect, test } from "bun:test";
import {
  BINARY_VAR,
  describeConfig,
  LOG_LEVEL_VAR,
  loadConfig,
  PASSTHROUGH_VAR,
  READY_TIMEOUT_VAR,
} from "../src/config.js";
import { DEFAULT_BINARY, DEFAULT_LOG_LEVEL, DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS } from "../src/constants.js";

describe("loadConfig", () => {
  test("an empty environment gives the documented defaults", () => {
    expect(loadConfig({})).toEqual({
      binary: DEFAULT_BINARY,
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
      logLevel: DEFAULT_LOG_LEVEL,
      passthroughEnv: [],
    });
  });

  test("every variable overrides", () => {
    const config = loadConfig({
      [BINARY_VAR]: "/opt/wine/bin/winedbg",
      [READY_TIMEOUT_VAR]: "45000",
      [LOG_LEVEL_VAR]: "debug",
      [PASSTHROUGH_VAR]: "COREPACK_ENABLE_STRICT",
    });
    expect(config).toEqual({
      binary: "/opt/wine/bin/winedbg",
      readyTimeoutMs: 45000,
      logLevel: "debug",
      passthroughEnv: ["COREPACK_ENABLE_STRICT"],
    });
  });

  test("a log level is matched whatever its case or padding", () => {
    expect(loadConfig({ [LOG_LEVEL_VAR]: " WARN " }).logLevel).toBe("warn");
  });

  test("an unrecognized log level is refused, not defaulted", () => {
    // Silently falling back to info would leave a deployment that asked for
    // debug and got none, with nothing on stderr saying so.
    for (const raw of ["", "verbose", "trace", "warning", "5"]) {
      expect(() => loadConfig({ [LOG_LEVEL_VAR]: raw })).toThrow(new RegExp(LOG_LEVEL_VAR));
    }
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
  });

  // Both ends of the accepted range, so a bound that moves to 0 or to the
  // exclusive end fails here rather than on a deployment's cold start.
  test("the range ends are inside it", () => {
    expect(loadConfig({ [READY_TIMEOUT_VAR]: "1" }).readyTimeoutMs).toBe(1);
    expect(loadConfig({ [READY_TIMEOUT_VAR]: String(MAX_READY_TIMEOUT_MS) }).readyTimeoutMs).toBe(MAX_READY_TIMEOUT_MS);
  });

  test("surrounding whitespace is a typo-free formatting habit, not a value", () => {
    expect(loadConfig({ [READY_TIMEOUT_VAR]: " 45000 " }).readyTimeoutMs).toBe(45000);
  });

  test("the startup line names every variable and its active value", () => {
    const line = describeConfig(loadConfig({ [BINARY_VAR]: "/opt/wine/bin/winedbg" }));
    expect(line).toContain(`${BINARY_VAR}=/opt/wine/bin/winedbg`);
    expect(line).toContain(`${READY_TIMEOUT_VAR}=${DEFAULT_READY_TIMEOUT_MS}`);
    expect(line).toContain(`${LOG_LEVEL_VAR}=${DEFAULT_LOG_LEVEL}`);
    expect(line).toContain(`${PASSTHROUGH_VAR}=`);
  });
});

describe("passthrough names", () => {
  test("a list is split on commas and trimmed", () => {
    expect(loadConfig({ [PASSTHROUGH_VAR]: " ONE , TWO " }).passthroughEnv).toEqual(["ONE", "TWO"]);
  });

  test("a name no environment could hold is refused rather than forwarded as nothing", () => {
    for (const raw of ["ONE;TWO", "1TOKEN", "ONE=1", "TWO=TWO=2", "A B"]) {
      expect(() => loadConfig({ [PASSTHROUGH_VAR]: raw })).toThrow(new RegExp(PASSTHROUGH_VAR));
    }
  });

  test("set-to-empty and a repeat are refused, both naming the variable", () => {
    expect(() => loadConfig({ [PASSTHROUGH_VAR]: "" })).toThrow(new RegExp(PASSTHROUGH_VAR));
    expect(() => loadConfig({ [PASSTHROUGH_VAR]: "  " })).toThrow(new RegExp(PASSTHROUGH_VAR));
    expect(() => loadConfig({ [PASSTHROUGH_VAR]: "ONE,ONE" })).toThrow(/ONE/);
  });
});

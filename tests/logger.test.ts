// Goal: pin the log line the operator reads, since a line that is not a
// parseable object, or a level filter that lets through noise, costs the only
// diagnostics this server has.
//
// Method: createLogger takes the write function and the clock, so every case
// collects lines in an array and asserts on the parsed record. No process
// stream is touched.

import { describe, expect, test } from "bun:test";
import { createLogger, formatRecord, type LogFields } from "../src/logger.js";

function collecting(level: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const log = createLogger(
    level,
    (line) => lines.push(line),
    () => new Date("2026-09-27T10:00:00.000Z"),
  );
  return { log, lines, records: () => lines.map((line) => JSON.parse(line) as LogFields) };
}

describe("formatRecord", () => {
  test("a line is one JSON object carrying time, level, message and the fields", () => {
    const line = formatRecord("2026-09-27T10:00:00.000Z", "info", "tool call finished", {
      callId: "call-7",
      durationMs: 12,
    });
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      time: "2026-09-27T10:00:00.000Z",
      level: "info",
      message: "tool call finished",
      callId: "call-7",
      durationMs: 12,
    });
  });

  test("a value carrying newlines stays on the line that carries it", () => {
    // A multiline winedbg reply reaching a field is what breaks a line parser.
    const line = formatRecord("2026-09-27T10:00:00.000Z", "error", "winedbg exited", {
      error: "first line\nsecond line",
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).error).toBe("first line\nsecond line");
  });
});

describe("createLogger", () => {
  test("a line below the configured level is not written", () => {
    const { log, lines } = collecting("warn");
    log.debug("winedbg command sent", { command: "bt" });
    log.info("tool call finished", { callId: "call-1" });
    log.warn("tool call failed", { callId: "call-1" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).level).toBe("warn");
  });

  test("every level is written at debug, each one named", () => {
    const { log, records } = collecting("debug");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(records().map((r) => r["level"])).toEqual(["debug", "info", "warn", "error"]);
  });

  test("a line with no fields still has the three fields every line has", () => {
    const { log, records } = collecting("info");
    log.info("shutting down", { reason: "signal SIGTERM" });
    log.info("winedbg stopped");
    expect(records()[1]).toEqual({
      time: "2026-09-27T10:00:00.000Z",
      level: "info",
      message: "winedbg stopped",
    });
  });
});

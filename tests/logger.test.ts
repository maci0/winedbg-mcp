// Goal: pin the log line the operator reads, since a line that is not a
// parseable object, or a level filter that lets through noise, costs the only
// diagnostics this server has.
//
// Method: createLogger takes the write function and the clock, so every case
// collects lines in an array and asserts on the parsed record. No process
// stream is touched. The correlation cases drive runWithCallId and read back
// the callId the same way, since the field is what joins a tool call to the
// session lines it produced.

import { describe, expect, test } from "bun:test";
import { callFields, createLogger, type LogFields, runWithCallId } from "../src/logger.js";

const NOW = "2026-09-27T10:00:00.000Z";

function collecting(level: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const log = createLogger(
    level,
    (line) => lines.push(line),
    () => new Date(NOW),
  );
  return { log, lines, records: () => lines.map((line) => JSON.parse(line) as LogFields) };
}

describe("createLogger", () => {
  test("a line is one JSON object carrying time, level, message and the fields", () => {
    const { log, lines } = collecting("info");
    log.info("tool call finished", { callId: "call-7", durationMs: 12 });
    const [line] = lines;
    if (line === undefined) throw new Error("nothing was written");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      time: NOW,
      level: "info",
      message: "tool call finished",
      callId: "call-7",
      durationMs: 12,
    });
  });

  test("a value carrying newlines stays on the line that carries it", () => {
    // A multiline winedbg reply reaching a field is what breaks a line parser.
    const { log, lines } = collecting("error");
    log.error("winedbg exited", { error: "first line\nsecond line" });
    const [line] = lines;
    if (line === undefined) throw new Error("nothing was written");
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).error).toBe("first line\nsecond line");
  });

  test("a line below the configured level is not written", () => {
    const { log, lines, records } = collecting("warn");
    log.debug("winedbg command sent", { command: "bt" });
    log.info("tool call finished", { callId: "call-1" });
    log.warn("tool call failed", { callId: "call-1" });
    expect(lines).toHaveLength(1);
    expect(records()[0]?.["level"]).toBe("warn");
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
      time: NOW,
      level: "info",
      message: "winedbg stopped",
    });
  });
});

describe("call correlation", () => {
  test("a line written inside a call carries that call's id", () => {
    const { log, records } = collecting("info");
    runWithCallId("call-3", () => {
      log.info("tool call started", { callId: "call-3", tool: "winedbg_execute" });
      // A session line, written by whatever the call reached: it has to name the
      // same call or a timed-out command cannot be joined to the call that sent
      // it.
      log.error("winedbg command timed out", { ...callFields(), command: "bt" });
    });
    expect(records().map((r) => r["callId"])).toEqual(["call-3", "call-3"]);
  });

  test("the id survives the await between a start and its first prompt", async () => {
    const { log, records } = collecting("info");
    await runWithCallId("call-4", async () => {
      await Promise.resolve();
      log.info("winedbg is at its first prompt", { ...callFields(), readyMs: 12 });
    });
    expect(records()[0]?.["callId"]).toBe("call-4");
  });

  test("a line written outside a call names none", () => {
    // Startup, shutdown and a signal belong to the process, not to a call that
    // has already answered: a callId there points at the wrong request.
    const { log, records } = collecting("info");
    log.info("winedbg MCP server running on stdio", { version: "1.0.0" });
    expect(callFields()).toEqual({});
    expect(records()[0]).not.toHaveProperty("callId");
  });

  test("calls in flight side by side do not share an id", async () => {
    const { log, records } = collecting("info");
    await Promise.all([
      runWithCallId("call-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.info("winedbg command sent", { ...callFields(), command: "bt" });
      }),
      runWithCallId("call-2", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        log.info("winedbg command sent", { ...callFields(), command: "info proc" });
      }),
    ]);
    expect(records().map((r) => [r["callId"], r["command"]])).toEqual([
      ["call-2", "info proc"],
      ["call-1", "bt"],
    ]);
  });
});

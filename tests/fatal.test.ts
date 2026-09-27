// Goal: pin the one failure the server cannot log from inside itself. A crash
// reaches the operator as a line or as nothing: node's own output is plain text
// with no level, no timestamp and no version, so an aggregator cannot filter it
// and an operator cannot tell which build it came from.
//
// Method: reportFatal takes the logger, so the record is collected and parsed
// here, as in tests/logger.test.ts. installFatalHandlers is the wiring the
// entry point calls; it registers the two process listeners and exits, which a
// unit test cannot drive without killing the suite.

import { describe, expect, test } from "bun:test";
import { reportFatal } from "../src/fatal.js";
import { createLogger, type LogFields } from "../src/logger.js";
import { SERVER_VERSION } from "../src/version.js";

function collecting() {
  const lines: string[] = [];
  const log = createLogger("info", (line) => lines.push(line));
  return { log, records: () => lines.map((line) => JSON.parse(line) as LogFields) };
}

describe("reportFatal", () => {
  test("an uncaught exception is an error record carrying the stack and the version", () => {
    const { log, records } = collecting();
    const error = new Error("boom");
    reportFatal(log, "uncaughtException", error);
    const [record] = records();
    if (record === undefined) throw new Error("nothing was written");
    expect(record["level"]).toBe("error");
    expect(record["message"]).toBe("server crashed");
    expect(record["kind"]).toBe("uncaughtException");
    expect(record["error"]).toBe("boom");
    expect(record["stack"]).toContain("Error: boom");
    // The build a report belongs to, which node's own crash output does not say.
    expect(record["version"]).toBe(SERVER_VERSION);
  });

  test("a rejection nobody awaited is recorded, thrown value or not", () => {
    const { log, records } = collecting();
    reportFatal(log, "unhandledRejection", new Error("no await"));
    reportFatal(log, "unhandledRejection", "a string reason");
    expect(records().map((r) => [r["error"], r["stack"]])).toEqual([
      ["no await", expect.any(String)],
      ["a string reason", null],
    ]);
  });

  test("the record is one line, whatever the message carries", () => {
    // A crash reason is as likely to hold a multiline debugger reply as any
    // other field, and a line that breaks the parse loses the whole record.
    const { log, records } = collecting();
    reportFatal(log, "uncaughtException", new Error("first line\nsecond line"));
    expect(records()[0]?.["error"]).toBe("first line\nsecond line");
  });

  test("a crash is written at every configured level", () => {
    // A deployment that silences the log with WINEDBG_MCP_LOG_LEVEL=error still
    // gets the one record that says why the server went away.
    const lines: string[] = [];
    const log = createLogger("error", (line) => lines.push(line));
    reportFatal(log, "uncaughtException", new Error("boom"));
    expect(lines).toHaveLength(1);
  });
});

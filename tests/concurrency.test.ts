// Goal: pin what happens when several tool calls are in flight at once, since
// the MCP server hands them in from the event loop without serializing them and
// they all land on the same session.
//
// Method: drive callTool(), the entry point index.ts registers for every tool
// call, against a real WinedbgSession over tests/fake-winedbg.js. Calls are
// launched in the same tick so they genuinely interleave, and each is checked
// against one rule: a reply belongs to the command that asked for it, and
// anything a caller may not do comes back as a refusal rather than as another
// call's output. No mocks, no virtual clock, nothing shared between tests.

import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../src/constants.js";
import { WinedbgSession } from "../src/session.js";
import { callTool, type ToolResult } from "../src/tools.js";

const FAKE = new URL("fake-winedbg.js", import.meta.url).pathname;
// Short enough to keep the suite quick, long enough that the fake answers
// first when it is going to.
const HANG_TIMEOUT_MS = 200;
const REPLY_TIMEOUT_MS = 5000;
const SLOW_REPLY_MS = 300;
const LATE_REPLY_WAIT_MS = SLOW_REPLY_MS * 3;
const ROUNDS = 4;
const CALLS_PER_ROUND = 6;

/** callTool as index.ts calls it, with the configured default in the fourth place. */
const call = (s: WinedbgSession, name: string, args?: Record<string, unknown>) =>
  callTool(s, name, args, DEFAULT_COMMAND_TIMEOUT_MS);

let session: WinedbgSession | null = null;

async function startedSession(): Promise<WinedbgSession> {
  const s = new WinedbgSession(process.execPath);
  session = s;
  const started = await call(s, "winedbg_start", { args: [FAKE] });
  expect(started.isError).toBeUndefined();
  return s;
}

function textOf(result: ToolResult): string {
  const [content] = result.content;
  if (content === undefined) throw new Error("a tool result carried no content");
  return content.text;
}

/** The only item of a list a test has just pinned the length of. */
function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected a list with an item in it");
  return item;
}

function isRefusal(result: ToolResult): boolean {
  return result.isError === true;
}

// The races below all resolve to one answer and one refusal, so the assertion
// is on the pair and reading either one must not need a non-null assertion.
function only<T>(values: T[]): T {
  expect(values).toHaveLength(1);
  const [value] = values;
  if (value === undefined) throw new Error("only(): the length assertion above already failed");
  return value;
}

afterEach(() => {
  session?.stop();
  session = null;
});

describe("concurrent tool calls", () => {
  test("two starts racing each other: one session, one refusal, and it works", async () => {
    const s = new WinedbgSession(process.execPath);
    session = s;
    // Both calls enter in the same tick, so the second finds the child the
    // first has already spawned rather than racing it for the slot.
    const [first, second] = await Promise.all([
      call(s, "winedbg_start", { args: [FAKE] }),
      call(s, "winedbg_start", { args: [FAKE] }),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((result) => !isRefusal(result))).toHaveLength(1);
    expect(textOf(only(outcomes.filter(isRefusal)))).toMatch(/already running/);
    expect(s.isRunning()).toBe(true);
    expect(textOf(await call(s, "winedbg_execute", { command: "bt" }))).toBe("ran: bt");
  });

  test("two commands racing for the session: one answer, one refusal, no crossed replies", async () => {
    const s = await startedSession();
    // Both calls enter in the same tick, so whichever claims the command slot
    // first does it before the other looks.
    const outcomes = await Promise.all([
      call(s, "winedbg_execute", { command: "bt", timeout: REPLY_TIMEOUT_MS }),
      call(s, "winedbg_execute", { command: "info reg", timeout: REPLY_TIMEOUT_MS }),
    ]);
    const answered = outcomes.filter((result) => !isRefusal(result));
    const refused = outcomes.filter(isRefusal);
    expect(answered).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(textOf(first(refused))).toMatch(/already in progress/);
    // The winner's output names its own command and nothing else.
    const reply = textOf(first(answered));
    expect(["ran: bt", "ran: info reg"]).toContain(reply);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("a stop racing an in-flight command settles it and leaves nothing behind", async () => {
    const s = await startedSession();
    const [pending, stopped] = await Promise.all([
      call(s, "winedbg_execute", { command: "hang", timeout: REPLY_TIMEOUT_MS }),
      call(s, "winedbg_stop", {}),
    ]);
    expect(isRefusal(pending)).toBe(true);
    expect(textOf(pending)).toMatch(/stopped manually/);
    expect(isRefusal(stopped)).toBe(false);
    expect(s.isRunning()).toBe(false);
    // Nothing the dead debugger had left to say reaches a later caller.
    const after = await call(s, "winedbg_execute", { command: "bt" });
    expect(isRefusal(after)).toBe(true);
    expect(textOf(after)).toMatch(/not running/);
  });

  test("a command racing an abandoned reply is refused, not handed the late output", async () => {
    const s = await startedSession();
    const abandoned = await call(s, "winedbg_execute", {
      command: `sleep:${SLOW_REPLY_MS}`,
      timeout: HANG_TIMEOUT_MS,
    });
    expect(textOf(abandoned)).toMatch(/timed out/);
    // The debugger still owes that prompt, so nothing new may be sent to it.
    const raced = await call(s, "winedbg_execute", { command: "bt" });
    expect(isRefusal(raced)).toBe(true);
    expect(textOf(raced)).toMatch(/has not returned to its prompt/);
    // Once the late reply has been drained, the next command is answered on its
    // own and the abandoned command's text is not spliced into it.
    await Bun.sleep(LATE_REPLY_WAIT_MS);
    const after = await call(s, "winedbg_execute", { command: "cont" });
    expect(textOf(after)).toBe("ran: cont");
  });

  test("a burst of calls answers each command with its own reply and refuses the rest", async () => {
    const s = await startedSession();
    for (let round = 0; round < ROUNDS; round++) {
      const commands = Array.from({ length: CALLS_PER_ROUND }, (_, index) => `cmd${round}-${index}`);
      const results = await Promise.all(
        commands.map((command) => call(s, "winedbg_execute", { command, timeout: REPLY_TIMEOUT_MS })),
      );
      for (const [index, result] of results.entries()) {
        const own = `ran: ${commands[index]}`;
        if (isRefusal(result)) {
          expect(textOf(result)).toMatch(/already in progress/);
          continue;
        }
        // A prompt is a boundary, and no other command's reply rode along.
        expect(textOf(result)).toBe(own);
      }
      expect(results.filter((result) => !isRefusal(result)).length).toBeGreaterThan(0);
      expect(s.isRunning()).toBe(true);
    }
  });
});

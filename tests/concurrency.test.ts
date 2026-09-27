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

let session: WinedbgSession | null = null;

async function startedSession(): Promise<WinedbgSession> {
  const s = new WinedbgSession(process.execPath);
  session = s;
  const started = await callTool(s, "winedbg_start", { args: [FAKE] });
  expect(started.isError).toBeUndefined();
  return s;
}

function textOf(result: ToolResult): string {
  const first = result.content.at(0);
  if (!first) throw new Error("tool result carried no text");
  return first.text;
}

/** The one element of a group the assertions above have counted. */
function only(results: ToolResult[]): ToolResult {
  if (results.length !== 1) throw new Error(`expected exactly one result, got ${results.length}`);
  const [result] = results;
  if (!result) throw new Error("no result");
  return result;
}

function isRefusal(result: ToolResult): boolean {
  return result.isError === true;
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
      callTool(s, "winedbg_start", { args: [FAKE] }),
      callTool(s, "winedbg_start", { args: [FAKE] }),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((result) => !isRefusal(result))).toHaveLength(1);
    const refused = outcomes.find(isRefusal);
    if (!refused) throw new Error("neither racing start was refused");
    expect(textOf(refused)).toMatch(/already running/);
    expect(s.isRunning()).toBe(true);
    expect(textOf(await callTool(s, "winedbg_execute", { command: "bt" }))).toBe("ran: bt");
  });

  test("two commands racing for the session: one answer, one refusal, no crossed replies", async () => {
    const s = await startedSession();
    // Both calls enter in the same tick, so whichever claims the command slot
    // first does it before the other looks.
    const outcomes = await Promise.all([
      callTool(s, "winedbg_execute", { command: "bt", timeout: REPLY_TIMEOUT_MS }),
      callTool(s, "winedbg_execute", { command: "info reg", timeout: REPLY_TIMEOUT_MS }),
    ]);
    const answered = outcomes.filter((result) => !isRefusal(result));
    const refused = outcomes.filter(isRefusal);
    expect(answered).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(textOf(only(refused))).toMatch(/already in progress/);
    // The winner's output names its own command and nothing else.
    const reply = textOf(only(answered));
    expect(["ran: bt", "ran: info reg"]).toContain(reply);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("a stop racing an in-flight command settles it and leaves nothing behind", async () => {
    const s = await startedSession();
    const [pending, stopped] = await Promise.all([
      callTool(s, "winedbg_execute", { command: "hang", timeout: REPLY_TIMEOUT_MS }),
      callTool(s, "winedbg_stop", {}),
    ]);
    expect(isRefusal(pending)).toBe(true);
    expect(textOf(pending)).toMatch(/stopped manually/);
    expect(isRefusal(stopped)).toBe(false);
    expect(s.isRunning()).toBe(false);
    // Nothing the dead debugger had left to say reaches a later caller.
    const after = await callTool(s, "winedbg_execute", { command: "bt" });
    expect(isRefusal(after)).toBe(true);
    expect(textOf(after)).toMatch(/not running/);
  });

  test("a command racing an abandoned reply is refused, not handed the late output", async () => {
    const s = await startedSession();
    const abandoned = await callTool(s, "winedbg_execute", {
      command: `sleep:${SLOW_REPLY_MS}`,
      timeout: HANG_TIMEOUT_MS,
    });
    expect(textOf(abandoned)).toMatch(/timed out/);
    // The debugger still owes that prompt, so nothing new may be sent to it.
    const raced = await callTool(s, "winedbg_execute", { command: "bt" });
    expect(isRefusal(raced)).toBe(true);
    expect(textOf(raced)).toMatch(/has not returned to its prompt/);
    // Once the late reply has been drained, the next command is answered on its
    // own and the abandoned command's text is not spliced into it.
    await Bun.sleep(LATE_REPLY_WAIT_MS);
    const after = await callTool(s, "winedbg_execute", { command: "cont" });
    expect(textOf(after)).toBe("ran: cont");
  });

  test("a burst of calls answers each command with its own reply and refuses the rest", async () => {
    const s = await startedSession();
    for (let round = 0; round < ROUNDS; round++) {
      const commands = Array.from({ length: CALLS_PER_ROUND }, (_, index) => `cmd${round}-${index}`);
      const results = await Promise.all(
        commands.map((command) => callTool(s, "winedbg_execute", { command, timeout: REPLY_TIMEOUT_MS })),
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

// Goal: pin the WinedbgSession state machine (start / execute / stop, and every
// error path) against a real child process, so parsing and lifecycle bugs fail
// here instead of in front of a debugger.
//
// Method: spawn tests/fake-winedbg.js, which speaks the same "Wine-dbg>" prompt
// protocol as winedbg and reacts to fixed commands (crash, hang, warn, quit,
// sleep:<ms>, noise:<n>).
// No mocks and no Wine: the code under test does real spawn/stdio work, and the
// only thing swapped out is the debugger binary. Every test owns its session and
// kills it in afterEach, so nothing is shared between tests.

import { afterEach, describe, expect, test } from "bun:test";
import { MAX_BUFFER_CHARS, WinedbgSession } from "../src/session.js";

const FAKE = new URL("fake-winedbg.js", import.meta.url).pathname;
const HANG_TIMEOUT_MS = 200;
// Short enough that the test is quick, and far below the default it overrides.
const READY_TIMEOUT_MS = 200;
const SLOW_REPLY_MS = 300;
// Comfortably past MAX_BUFFER_CHARS in session.ts, so the cap has to engage.
const OVERFLOW_CHARS = 2 * 1024 * 1024;
// Upper bound for an abandoned reply to come back, and how often to look. Wide
// enough to survive a loaded machine, narrow enough to fail rather than hang.
const ABANDONED_PROMPT_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 25;

let session: WinedbgSession | null = null;

function newSession(): WinedbgSession {
  // process.execPath runs the fixture with the same runtime as the tests, so no
  // PATH lookup or shebang interpreter is involved.
  session = new WinedbgSession(process.execPath);
  return session;
}

async function startedSession(): Promise<WinedbgSession> {
  const s = newSession();
  await s.start([FAKE]);
  return s;
}

/**
 * Wait for the prompt the abandoned command still owed. The debugger replies on
 * its own schedule, so this polls the one observable signal (a command being
 * accepted again) instead of sleeping for a guessed interval.
 */
async function waitForPrompt(s: WinedbgSession): Promise<void> {
  const deadline = Date.now() + ABANDONED_PROMPT_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await s.executeCommand("bt");
      return;
    } catch (error) {
      if (!/has not returned to its prompt/.test((error as Error).message)) throw error;
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`debugger did not return to its prompt within ${ABANDONED_PROMPT_WAIT_MS}ms`);
}

afterEach(() => {
  session?.stop();
  session = null;
});

describe("start", () => {
  test("resolves once the debugger prints its prompt", async () => {
    const s = await startedSession();
    expect(s.isRunning()).toBe(true);
    // The prompt that made it ready is consumed, not left to be read back as
    // the first command's output.
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("rejects a second start while a session is running", async () => {
    const s = await startedSession();
    await expect(s.start([FAKE])).rejects.toThrow(/already running/);
    expect(s.isRunning()).toBe(true);
  });

  test("rejects when the binary does not exist", async () => {
    const s = new WinedbgSession("/nonexistent/winedbg-fixture");
    session = s;
    await expect(s.start()).rejects.toThrow(/ENOENT/);
    // A spawn that never happened leaves nothing behind: not a session the
    // caller has to stop, and nothing that would answer "already running".
    expect(s.isRunning()).toBe(false);
    expect(() => s.stop()).not.toThrow();
  });

  test("rejects as soon as the debugger dies without prompting", async () => {
    const s = newSession();
    await expect(s.start([FAKE, "die"])).rejects.toThrow(/exited with code 2/);
    expect(s.isRunning()).toBe(false);
  });

  test("gives up on a debugger that never prompts, after the configured wait", async () => {
    const s = new WinedbgSession(process.execPath, READY_TIMEOUT_MS);
    session = s;
    // The message names the wait that was actually configured, which is the only
    // way a reader can tell the deployment's timeout apart from the default.
    await expect(s.start([FAKE, "mute"])).rejects.toThrow(
      new RegExp(`Timeout waiting for winedbg to start \\(${READY_TIMEOUT_MS}ms\\)`)
    );
    // The child is killed rather than left holding a session nobody can reach.
    expect(s.isRunning()).toBe(false);
    await expect(s.executeCommand("bt")).rejects.toThrow(/not running/);
  });

  test("rejects a start that stop() overtook", async () => {
    const s = new WinedbgSession(process.execPath, READY_TIMEOUT_MS * 25);
    session = s;
    const starting = s.start([FAKE, "mute"]);
    // A ready prompt can no longer arrive, so the caller waiting on start() has
    // to be told rather than left until the ready timeout.
    s.stop();
    await expect(starting).rejects.toThrow(/stopped before it was ready/);
    expect(s.isRunning()).toBe(false);
  });

  test("starts cleanly after the debugger died mid-session", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("crash")).rejects.toThrow(/exited with code 3/);
    // A child that dies on its own leaves state that start() has to clear, since
    // nothing called stop() and the caller only knows the session is gone.
    await s.start([FAKE]);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });
});

describe("executeCommand", () => {
  test("returns the output printed before the next prompt", async () => {
    const s = await startedSession();
    const out = await s.executeCommand("bt");
    expect(out).toBe("ran: bt");
  });

  test("strips the prompt and leaves nothing behind for the next command", async () => {
    const s = await startedSession();
    await s.executeCommand("break main");
    const second = await s.executeCommand("cont");
    expect(second).toBe("ran: cont");
    expect(second).not.toContain("Wine-dbg>");
    expect(second).not.toContain("break main");
  });

  test("captures output written to stderr", async () => {
    const s = await startedSession();
    expect(await s.executeCommand("warn")).toBe("stderr line");
  });

  test("resolves empty when the command prints nothing", async () => {
    const s = await startedSession();
    expect(await s.executeCommand("silent")).toBe("");
  });

  test("throws before start", async () => {
    const s = newSession();
    await expect(s.executeCommand("bt")).rejects.toThrow(/not running/);
  });

  test("throws after stop", async () => {
    const s = await startedSession();
    s.stop();
    await expect(s.executeCommand("bt")).rejects.toThrow(/not running/);
  });

  test("rejects a second command while one is in flight", async () => {
    const s = await startedSession();
    const first = s.executeCommand("hang", HANG_TIMEOUT_MS);
    await expect(s.executeCommand("bt")).rejects.toThrow(/already in progress/);
    await expect(first).rejects.toThrow(/timed out/);
  });

  test("rejects when the debugger never prompts again", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("hang", HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
  });

  test("rejects a multi-line command", async () => {
    const s = await startedSession();
    // Two lines would draw two prompts and put every later reply one command behind.
    await expect(s.executeCommand("bt\ncont")).rejects.toThrow(/single line/);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("refuses a new command while the debugger still owes a prompt", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("hang", HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    // The debugger never came back to its prompt, so it is not reading commands.
    // Answering the next one would mean handing it output it did not produce.
    await expect(s.executeCommand("bt")).rejects.toThrow(/has not returned to its prompt/);
  });

  test("accepts a new command once the abandoned reply lands", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("sleep:" + SLOW_REPLY_MS, HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    await waitForPrompt(s);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("never hands one command the output of an abandoned one", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("sleep:" + SLOW_REPLY_MS, HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    await waitForPrompt(s);
    const out = await s.executeCommand("sleep:" + SLOW_REPLY_MS, SLOW_REPLY_MS * 5);
    expect(out).toBe("ran: sleep:" + SLOW_REPLY_MS);
  });

  test("caps a huge reply and says how much it dropped", async () => {
    const s = await startedSession();
    const out = await s.executeCommand("noise:" + OVERFLOW_CHARS);
    const [notice = "", kept = ""] = out.split("\n");
    const dropped = Number(notice?.match(/^\[(\d+) characters of earlier output dropped: buffer limit\]$/)?.[1]);
    expect(Number.isNaN(dropped)).toBe(false);
    // Nothing is lost silently and nothing is invented: the notice accounts for
    // exactly the characters the cap removed, and what is left is the tail.
    expect(dropped + kept.length).toBe(OVERFLOW_CHARS);
    expect(kept.length).toBeLessThanOrEqual(MAX_BUFFER_CHARS);
    expect(kept).toMatch(/^n+$/);
    // The notice belongs to this command only.
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("rejects the in-flight command when the debugger exits", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("crash")).rejects.toThrow(/exited with code 3/);
    expect(s.isRunning()).toBe(false);
  });
});

describe("stop", () => {
  test("rejects the in-flight command and clears the session", async () => {
    const s = await startedSession();
    const pending = s.executeCommand("hang", HANG_TIMEOUT_MS);
    s.stop();
    await expect(pending).rejects.toThrow(/stopped manually/);
    expect(s.isRunning()).toBe(false);
  });

  test("is a no-op when nothing is running", () => {
    const s = newSession();
    expect(() => s.stop()).not.toThrow();
    expect(s.isRunning()).toBe(false);
  });

  test("allows a fresh start afterwards", async () => {
    const s = await startedSession();
    s.stop();
    await s.start([FAKE]);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });
});

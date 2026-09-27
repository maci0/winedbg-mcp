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
import { fileURLToPath } from "node:url";
import { DEFAULT_READY_TIMEOUT_MS, WinedbgSession } from "../src/session.js";

// fileURLToPath, not URL.pathname: on Windows the latter leaves "/C:/dir/..."
// and any percent-escapes in, and spawn cannot run either.
const FAKE = fileURLToPath(new URL("fake-winedbg.js", import.meta.url));
const HANG_TIMEOUT_MS = 200;
// Short enough that the test is quick, and far below the default it overrides.
const READY_TIMEOUT_MS = 200;
const SLOW_REPLY_MS = 300;
// Long enough for a signalled process to be gone, well under the kill grace
// session.ts allows before escalating to SIGKILL.
const KILL_WAIT_MS = 1000;
// Comfortably past MAX_BUFFER_CHARS in session.ts, so the cap has to engage.
const OVERFLOW_CHARS = 2 * 1024 * 1024;

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

afterEach(() => {
  session?.stop();
  session = null;
});

describe("start", () => {
  test("resolves once the debugger prints its prompt", async () => {
    const s = await startedSession();
    expect(s.isRunning()).toBe(true);
  });

  test("rejects a second start while a session is running", async () => {
    const s = await startedSession();
    await expect(s.start([FAKE])).rejects.toThrow(/already running/);
    expect(s.isRunning()).toBe(true);
  });

  test("rejects when the binary does not exist", async () => {
    const s = new WinedbgSession("/nonexistent/winedbg-fixture");
    session = s;
    await expect(s.start()).rejects.toThrow();
    // A process that never started is not a session: leaving it set would refuse
    // every later start with "already running".
    expect(s.isRunning()).toBe(false);
  });

  test("rejects as soon as the debugger dies without prompting", async () => {
    const s = newSession();
    await expect(s.start([FAKE, "die"])).rejects.toThrow(/exited with code 2/);
  });

  test("gives up on a debugger that never prompts, after the configured wait", async () => {
    const s = new WinedbgSession(process.execPath, READY_TIMEOUT_MS);
    session = s;
    const began = Date.now();
    await expect(s.start([FAKE, "mute"])).rejects.toThrow(/Timeout waiting/);
    expect(Date.now() - began).toBeLessThan(DEFAULT_READY_TIMEOUT_MS);
    expect(s.isRunning()).toBe(false);
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
    await Bun.sleep(SLOW_REPLY_MS * 2);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("never hands one command the output of an abandoned one", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("sleep:" + SLOW_REPLY_MS, HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    await Bun.sleep(SLOW_REPLY_MS * 2);
    const out = await s.executeCommand("sleep:" + SLOW_REPLY_MS, SLOW_REPLY_MS * 5);
    expect(out).toBe("ran: sleep:" + SLOW_REPLY_MS);
  });

  test("survives a debugger that stopped reading commands", async () => {
    const s = await startedSession();
    await s.executeCommand("close-stdin");
    // The command never reaches a debugger, and a write to the pipe it stopped
    // reading must not take this process down.
    await expect(s.executeCommand("bt", HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    expect(s.isRunning()).toBe(true);
  });

  test("caps a huge reply and says how much it dropped", async () => {
    const s = await startedSession();
    const out = await s.executeCommand("noise:" + OVERFLOW_CHARS);
    expect(out).toMatch(/characters of earlier output dropped/);
    expect(out.length).toBeLessThan(OVERFLOW_CHARS);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("rejects the in-flight command when the debugger exits", async () => {
    const s = await startedSession();
    await expect(s.executeCommand("crash")).rejects.toThrow(/exited with code 3/);
    expect(s.isRunning()).toBe(false);
  });

  test("names the signal when the debugger is killed without an exit code", async () => {
    const s = await startedSession();
    // "exited with code null" would hide what actually ended the debugger.
    await expect(s.executeCommand("selfkill")).rejects.toThrow(/killed by SIGKILL/);
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

  test("kills the debuggee the debugger started", async () => {
    const s = newSession();
    await s.start([FAKE, "grandchild"]);
    const pid = Number((await s.executeCommand("pid")).replace("ran: ", ""));
    expect(pid).toBeGreaterThan(0);
    s.stop();
    // Signals and the kill escalation are asynchronous; the debuggee has to be
    // gone, not merely signalled.
    await Bun.sleep(KILL_WAIT_MS);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("settles a start that is still waiting for its prompt", async () => {
    const s = new WinedbgSession(process.execPath, 5000);
    session = s;
    // "mute" never prompts, so nothing but stop() can end this start. Leaving
    // the caller awaiting a prompt that can no longer arrive hangs the request.
    const pending = s.start([FAKE, "mute"]);
    s.stop();
    await expect(pending).rejects.toThrow(/stopped before it was ready/);
    expect(s.isRunning()).toBe(false);
  });

  test("allows a fresh start afterwards", async () => {
    const s = await startedSession();
    s.stop();
    await s.start([FAKE]);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });
});

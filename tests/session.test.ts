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
import { BINARY_VAR } from "../src/config.js";
import { DEFAULT_READY_TIMEOUT_MS } from "../src/constants.js";
import { WinedbgSession } from "../src/session.js";

const FAKE = new URL("fake-winedbg.js", import.meta.url).pathname;
// Kept below SLOW_REPLY_MS, so "sleep:<SLOW_REPLY_MS>" is still outstanding when
// the timeout fires. Every test that leans on that ordering is timed off this
// value, which is why it is a wall clock as tight as the ordering allows.
const HANG_TIMEOUT_MS = 200;
// The one test that needs a command to still be in flight a moment later, on a
// host busy enough that 200ms can pass between two calls. Loose enough that the
// rejection, not the timeout, is what the second command sees.
const IN_FLIGHT_TIMEOUT_MS = 1000;
// Short enough that the test is quick, and far below the default it overrides.
const READY_TIMEOUT_MS = 200;
const SLOW_REPLY_MS = 300;
// Wall clock, so a loaded host can take longer than the reply itself. Generous
// enough that the late reply lands before the next command; the abandoned-prompt
// path itself is pinned deterministically in simulation.test.ts.
const LATE_REPLY_WAIT_MS = SLOW_REPLY_MS * 3;
// Long enough for a signalled process to be gone, well under the kill grace
// session.ts allows before escalating to SIGKILL.
const KILL_WAIT_MS = 1000;
// Comfortably past MAX_BUFFER_CHARS in session.ts, so the cap has to engage.
const OVERFLOW_CHARS = 2 * 1024 * 1024;
// Emoji take two UTF-16 units each, so this is 1.2M units of output against a
// 1M-unit cap: enough to force the cut, in astral characters rather than ASCII.
const ASTRAL_CHARS = 600_000;

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

/** Signal 0 throws once the pid is reaped, which can lag the close event. */
async function waitForExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
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
    // Named, so a regression that reports a generic start failure instead of the
    // spawn error does not pass here.
    await expect(s.start()).rejects.toThrow(/winedbg-fixture/);
    // A process that never started is not a session: leaving it set would refuse
    // every later start with "already running".
    expect(s.isRunning()).toBe(false);
  });

  test("names the binary and its variable when the executable is missing", async () => {
    const s = new WinedbgSession("/nonexistent/winedbg-fixture");
    session = s;
    // "spawn /nonexistent/winedbg-fixture ENOENT" leaves an operator with
    // nothing to check.
    const failure = await s.start().then(
      () => "",
      (error: Error) => error.message
    );
    expect(failure).toContain("ENOENT");
    expect(failure).toContain(BINARY_VAR);
  });

  test("rejects with the offending argv when spawn cannot carry it", async () => {
    const s = new WinedbgSession(process.execPath);
    session = s;
    // A NUL in argv throws from spawn() before a child exists; the raw error
    // names neither the argument nor the program it came from.
    await expect(s.start([FAKE, "a\0b"])).rejects.toThrow(/Failed to start .*a\\u0000b/);
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
    const first = s.executeCommand("hang", IN_FLIGHT_TIMEOUT_MS);
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

  test("rejects every line terminator a stream reader may split on, and NUL", async () => {
    const s = await startedSession();
    // LF, CR, VT, FF, NEL, the Unicode line and paragraph separators, and NUL:
    // the documented set, so the check cannot be narrowed to \r\n by accident.
    // A stream reader splits on VT, a text decoder that honours the Unicode line
    // breaks on NEL, U+2028 and U+2029, and NUL truncates the line for a C
    // reader. Each desynchronises the reply stream the same way a second line.
    const terminators = ["\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029", "\u0000"];
    for (const terminator of terminators) {
      await expect(s.executeCommand(`bt${terminator}cont`)).rejects.toThrow(/single line/);
    }
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
    await expect(s.executeCommand(`sleep:${SLOW_REPLY_MS}`, HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    await Bun.sleep(LATE_REPLY_WAIT_MS);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("never hands one command the output of an abandoned one", async () => {
    const s = await startedSession();
    await expect(s.executeCommand(`sleep:${SLOW_REPLY_MS}`, HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    await Bun.sleep(LATE_REPLY_WAIT_MS);
    const out = await s.executeCommand(`sleep:${SLOW_REPLY_MS}`, SLOW_REPLY_MS * 5);
    expect(out).toBe(`ran: sleep:${SLOW_REPLY_MS}`);
  });

  test("survives a debugger that stopped reading commands", async () => {
    const s = await startedSession();
    await s.executeCommand("close-stdin");
    // The command never reaches a debugger, and a write to the pipe it stopped
    // reading must not take this process down.
    await expect(s.executeCommand("bt", HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    expect(s.isRunning()).toBe(true);
  });

  // The same 2MB as the dribble fixture below, written in one piece, so the
  // budget is set for pushing it through a pipe rather than for the assertion.
  test(
    "caps a huge reply and says how much it dropped",
    async () => {
      const s = await startedSession();
      const out = await s.executeCommand("noise:" + OVERFLOW_CHARS);
      expect(out).toMatch(/characters of earlier output dropped/);
      expect(out.length).toBeLessThan(OVERFLOW_CHARS);
      expect(await s.executeCommand("bt")).toBe("ran: bt");
    },
    20000
  );

  // The fixture dribbles 2MB in 8192-byte pieces, so this is 256 child writes and
  // 256 parent reads of a buffer sitting at its cap. It takes seconds on a quiet
  // machine and overruns the 5s default under a parallel run, so the budget is
  // set for the process traffic rather than for the assertion.
  test("keeps a reply intact when it arrives in many pieces past the buffer cap", async () => {
    const s = await startedSession();
    // Each piece is its own read, so the reply is searched for a prompt hundreds
    // of times over a buffer that stays at its cap throughout.
    const out = await s.executeCommand(`dribble:${OVERFLOW_CHARS}`);
    // What is left is the dropped-count notice and the tail, with no prompt and
    // no other command's output spliced into it.
    expect(out).toMatch(/^\[\d+ characters of earlier output dropped: buffer limit\]\nd+$/);
    expect(out.length).toBeLessThan(OVERFLOW_CHARS);
    // The prompt that ended the reply was consumed, not left for the next one.
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  }, 20000);

  test("returns non-ASCII output whose characters straddle reads", async () => {
    const s = await startedSession();
    // The fixture writes one byte per write, so every character above U+007F
    // reaches the session split across two chunks. Decoding a chunk on its own
    // turns each half into U+FFFD and the reply comes back as mojibake.
    const out = await s.executeCommand("utf8:naïve café \u{1F600} 日本語");
    expect(out).toBe("utf8 reply: naïve café \u{1F600} 日本語");
    expect(out).not.toContain("�");
  });

  test(
    "cuts the overflow on a character boundary, not inside a surrogate pair",
    async () => {
      const s = await startedSession();
      const out = await s.executeCommand("astral:" + ASTRAL_CHARS);
      // A cut landing on the low half of a pair leaves a surrogate unpaired,
      // which JSON then has to escape and no terminal renders as the character
      // it was. Iterating code points is what makes an unpaired half visible:
      // it is a code point of its own, in the surrogate range and nowhere else.
      const orphans = [...out].filter((codePoint) => {
        const unit = codePoint.charCodeAt(0);
        return codePoint.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
      });
      expect(orphans.length).toBe(0);
      expect(out).not.toContain("�");
      expect(await s.executeCommand("bt")).toBe("ran: bt");
    },
    20000
  );

  test("keeps multi-byte characters whole when a read splits them", async () => {
    const s = await startedSession();
    // The reply arrives one byte per read, so every character in it is cut in
    // half by a chunk boundary. Decoding each chunk on its own would turn them
    // into U+FFFD and hand back a corrupted reply.
    const out = await s.executeCommand("utf8");
    expect(out).toBe("ran: ünïcode ✓");
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

  test("kills the debuggee without an event loop left to escalate on", async () => {
    const s = newSession();
    await s.start([FAKE, "grandchild"]);
    const pid = Number((await s.executeCommand("pid")).replace("ran: ", ""));
    expect(pid).toBeGreaterThan(0);
    // This is what an exit handler calls. The grace stop() relies on is a
    // timer, and a timer scheduled with the loop already drained never runs, so
    // this path has to take the tree down on the first signal.
    s.stopImmediately();
    await Bun.sleep(KILL_WAIT_MS);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("is a no-op when nothing is running", () => {
    const s = new WinedbgSession();
    expect(() => s.stopImmediately()).not.toThrow();
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

  test("waits for the stopped debugger to be gone before starting another", async () => {
    const s = newSession();
    // The debuggee shares the debugger's process group, so it is what a client
    // alternating start and stop would leave behind, one group per cycle.
    await s.start([FAKE, "grandchild"]);
    const first = Number((await s.executeCommand("pid")).replace("ran: ", ""));
    expect(first).toBeGreaterThan(0);
    s.stop();
    await s.start([FAKE]);
    // The reap is the runtime's, so a signal 0 can still find a zombie for a
    // moment after the close the start waited for.
    expect(await waitForExit(first, KILL_WAIT_MS)).toBe(true);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });
});

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
import { BINARY_VAR } from "../src/config.js";
import { DEFAULT_READY_TIMEOUT_MS } from "../src/constants.js";
import { createLogger } from "../src/logger.js";
import { type DebuggerChild, nodeRuntime } from "../src/runtime.js";
import { WinedbgSession } from "../src/session.js";

// fileURLToPath, not .pathname: a file: URL is percent-encoded, and on Windows
// its pathname carries a leading slash the path does not have (C:\a becomes
// /C:/a). Either way a checkout under a directory with a space or a non-ASCII
// character in it spawns a path that does not exist.
const FAKE = fileURLToPath(new URL("fake-winedbg.js", import.meta.url));
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
// How often to ask whether a signalled process is gone. shutdown() waits for
// the debugger, not for the debuggee it signalled alongside, and a process
// answering SIGTERM finishes on its own schedule.
const REAP_POLL_MS = 20;
// The bound on that wait, so a debuggee that really did outlive its debugger
// fails the test rather than hanging it.
const REAP_TIMEOUT_MS = 5000;

let session: WinedbgSession | null = null;

function newSession(): WinedbgSession {
  // process.execPath runs the fixture with the same runtime as the tests, so no
  // PATH lookup or shebang interpreter is involved. The logger discards: these
  // tests are about the state machine, and the suite's own output would
  // otherwise carry a session lifecycle per test.
  session = new WinedbgSession(
    process.execPath,
    undefined,
    undefined,
    createLogger("debug", () => {}),
  );
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
    await Bun.sleep(REAP_POLL_MS);
  }
  return false;
}

afterEach(() => {
  session?.stop();
  session = null;
});

/**
 * A debugger in memory, driven by the test rather than by a child process. It
 * exists for the pipe error path: whether a given runtime's child_process
 * raises EPIPE for a real child is that runtime's business, and a test that
 * depended on it would say nothing on the one where it does not.
 */
class PipeErrorDebugger implements DebuggerChild {
  readonly pid = 4242;
  readonly stdin = { write: () => {} };
  private readonly dataListeners: ((chunk: string) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  killTree(): void {}

  closePipes(): void {}

  /** The first prompt, which is what a start waits for. On a later turn, as a real child. */
  printPrompt(): void {
    setTimeout(() => {
      for (const listener of this.dataListeners) listener("Wine-dbg>");
    }, 0);
  }

  /** What a write to a pipe the debugger stopped reading arrives as. */
  raisePipeError(): void {
    for (const listener of this.errorListeners) listener(new Error("winedbg command pipe: write EPIPE"));
  }
}

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
      (error: Error) => error.message,
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

  // A command with no timeout of its own waits the deployment's default, not the
  // built-in one: a session built from WINEDBG_MCP_COMMAND_TIMEOUT_MS has to
  // behave like the deployment described, or the variable only reaches the tool
  // description and nothing else.
  test("a command with no timeout waits the configured default", async () => {
    const s = new WinedbgSession(
      process.execPath,
      undefined,
      undefined,
      createLogger("debug", () => {}),
      SLOW_REPLY_MS * 10,
    );
    session = s;
    await s.start([FAKE]);
    expect(await s.executeCommand(`sleep:${SLOW_REPLY_MS}`)).toBe(`ran: sleep:${SLOW_REPLY_MS}`);
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
    // reading must not take this process down. Which way the write fails is the
    // test runtime's business, so only the outcome both ways agree on is
    // asserted: the command is refused and the session outlives it. The reason
    // the pipe error carries is pinned below, where it can be raised on demand.
    await expect(s.executeCommand("bt", HANG_TIMEOUT_MS)).rejects.toThrow();
    expect(s.isRunning()).toBe(true);
  });

  // The same 2MB as the dribble fixture below, written in one piece, so the
  // budget is set for pushing it through a pipe rather than for the assertion.
  test("caps a huge reply and says how much it dropped", async () => {
    const s = await startedSession();
    const out = await s.executeCommand(`noise:${OVERFLOW_CHARS}`);
    expect(out).toMatch(/characters of earlier output dropped/);
    expect(out.length).toBeLessThan(OVERFLOW_CHARS);
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  }, 20000);

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

  test("reports the command a broken pipe failed, not a timeout", async () => {
    // A pipe error raised on demand, so the reason is pinned where it does not
    // depend on the test runtime raising EPIPE for a real child of its own.
    const pipe = new PipeErrorDebugger();
    const s = new WinedbgSession("winedbg", READY_TIMEOUT_MS, {
      clock: nodeRuntime().clock,
      spawn: () => pipe,
    });
    session = s;
    const started = s.start();
    pipe.printPrompt();
    await started;
    const pending = s.executeCommand("bt", IN_FLIGHT_TIMEOUT_MS);
    pipe.raisePipeError();
    // The debugger is still there, only its command pipe is broken, so the
    // refusal names both the command and the pipe. A timeout here would report a
    // debugger that had gone away as one that had not answered.
    await expect(pending).rejects.toThrow('winedbg failed while running "bt": winedbg command pipe: write EPIPE');
    expect(s.isRunning()).toBe(true);
  });

  // A prompt in a reply is a boundary, not output, and the reply ends at the
  // first one: the rest belongs to whatever the debugger says next, and taking
  // the last prompt in the buffer instead would hand back text from after the
  // command that asked for it.
  test("ends a reply at the first prompt, even when the output carries one", async () => {
    const s = await startedSession();
    expect(await s.executeCommand("fakeprompt")).toBe("before");
    // The prompt that ended the reply was consumed, not left for the next one.
    expect(await s.executeCommand("bt")).toBe("ran: bt");
  });

  test("cuts the overflow on a character boundary, not inside a surrogate pair", async () => {
    const s = await startedSession();
    const out = await s.executeCommand(`astral:${ASTRAL_CHARS}`);
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
  }, 20000);

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
    const s = new WinedbgSession(
      process.execPath,
      5000,
      undefined,
      createLogger("debug", () => {}),
    );
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

describe("logging", () => {
  function loggedSession(): { records: () => Record<string, unknown>[]; session: WinedbgSession } {
    const lines: string[] = [];
    const log = createLogger("debug", (line) => lines.push(line));
    session = new WinedbgSession(process.execPath, 5000, undefined, log);
    return { session, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
  }

  function messages(records: Record<string, unknown>[]): string[] {
    return records.map((record) => record["message"] as string);
  }

  function record(records: Record<string, unknown>[], message: string): Record<string, unknown> {
    const found = records.find((candidate) => candidate["message"] === message);
    if (found === undefined) throw new Error(`no log record for ${message}`);
    return found;
  }

  test("a start reports the spawn, the prompt it waited for and a command that timed out", async () => {
    const { session: s, records } = loggedSession();
    await s.start([FAKE]);
    await s.executeCommand("bt");
    const messagesSeen = messages(records());
    expect(messagesSeen).toContain("winedbg spawned, waiting for its first prompt");
    expect(messagesSeen).toContain("winedbg is at its first prompt");
    // The duration is what tells a slow wineprefix from a debugger that is stuck.
    const ready = record(records(), "winedbg is at its first prompt");
    expect(typeof ready["readyMs"]).toBe("number");
    expect(typeof ready["pid"]).toBe("number");

    await expect(s.executeCommand("hang", HANG_TIMEOUT_MS)).rejects.toThrow(/timed out/);
    const timedOut = record(records(), "winedbg command timed out");
    expect(timedOut["level"]).toBe("error");
    expect(timedOut["command"]).toBe("hang");
    expect(timedOut["timeoutMs"]).toBe(HANG_TIMEOUT_MS);
  });

  test("a debugger that exits on its own is an error, a requested stop is not", async () => {
    const { session: s, records } = loggedSession();
    await s.start([FAKE]);
    await expect(s.executeCommand("crash")).rejects.toThrow();
    const crashed = record(records(), "winedbg exited");
    expect(crashed["level"]).toBe("error");
    expect(crashed["code"]).toBe(3);
    expect(crashed["wasReady"]).toBe(true);

    s.start([FAKE]).catch(() => {});
    const before = records().length;
    s.stop();
    await Bun.sleep(KILL_WAIT_MS);
    // Everything after the stop is the close that stop() asked for, which must
    // not read as a debugger that crashed under a client.
    expect(
      records()
        .slice(before)
        .map((r) => r["message"]),
    ).not.toContain("winedbg exited");
  });
});

describe("shutdown", () => {
  test("does not resolve until a debugger that ignored SIGTERM is gone", async () => {
    const s = newSession();
    // "stubborn" answers SIGTERM with nothing, so only the escalation ends it,
    // a grace period after the signal. A caller that exits the process on the
    // strength of the signal alone would leave it, and its debuggee, running.
    await s.start([FAKE, "stubborn", "grandchild"]);
    const debuggerPid = Number(await s.executeCommand("selfpid"));
    const debuggee = Number((await s.executeCommand("pid")).replace("ran: ", ""));
    expect(debuggerPid).toBeGreaterThan(0);
    expect(debuggee).toBeGreaterThan(0);
    await s.shutdown();
    // The close the session waits for is delivered after the reap, so the
    // debugger it owns is gone by the time it resolves. The debuggee is not the
    // session's child, so nothing reaps it and its exit can lag the signal.
    expect(() => process.kill(debuggerPid, 0)).toThrow();
    expect(await waitForExit(debuggee, REAP_TIMEOUT_MS)).toBe(true);
    expect(s.isRunning()).toBe(false);
  }, 10000);

  test("resolves without signalling again when called twice", async () => {
    const s = newSession();
    await s.start([FAKE, "grandchild"]);
    const debuggee = Number((await s.executeCommand("pid")).replace("ran: ", ""));
    await s.shutdown();
    // The child was released by the first stop, so the second one has nothing to
    // signal: it settles the same cleanup rather than starting a second.
    await s.shutdown();
    // The second shutdown resolves on the same termination the first waited
    // for, and a reap can lag the close that wait is built on, so the pid going
    // away is polled rather than sampled once.
    expect(await waitForExit(debuggee, REAP_TIMEOUT_MS)).toBe(true);
    expect(s.isRunning()).toBe(false);
  }, 10000);

  test("resolves when nothing is running", async () => {
    const s = newSession();
    await s.shutdown();
    expect(s.isRunning()).toBe(false);
  });
});

/**
 * The overflow cut, driven through the runtime port instead of a child process.
 *
 * Which character the cut lands on is a function of the buffer length at the
 * moment the cap is checked, and over a real pipe that is a function of read
 * boundaries the test does not control, so it cannot be pinned against a child.
 * The port hands over exactly the chunks written here, which puts the cut at a
 * known offset into a known text on every run.
 */
describe("the overflow cut", () => {
  // MAX_BUFFER_CHARS is a module constant the port cannot move, so the cut is
  // reached by writing a read that carries the buffer past it. BUFFER_RETAIN is
  // three quarters of that cap, so the cut falls RETAIN_CHARS from the end of
  // the reply and its offset is fixed by that rather than by the arrival order.
  const CAP_CHARS = 1024 * 1024;
  const RETAIN_CHARS = Math.floor((CAP_CHARS * 3) / 4);
  const COMBINING_ACUTE = "\u0301";
  const CLUSTER = `e${COMBINING_ACUTE}`;
  // A joined sequence, where every code point after the first belongs to the one
  // before it: a cut anywhere inside it hands back a fraction of one emoji.
  const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

  /** A debugger that answers with exactly the chunks a test hands it. */
  class ScriptedDebugger implements DebuggerChild {
    readonly pid = 1;
    // The commands are never read, only the replies that follow them, so the
    // write side is a sink.
    readonly stdin = { write: () => {} };
    private readonly listeners: ((chunk: string) => void)[] = [];

    onData(listener: (chunk: string) => void): void {
      this.listeners.push(listener);
    }
    onClose(): void {}
    onError(): void {}
    killTree(): void {}
    closePipes(): void {}

    emit(chunk: string): void {
      for (const listener of this.listeners) listener(chunk);
    }
  }

  /** Run one command whose reply is `body`, and return it without the notice. */
  async function replyFrom(body: string): Promise<string> {
    const fake = new ScriptedDebugger();
    const s = new WinedbgSession(
      "winedbg",
      READY_TIMEOUT_MS,
      { clock: nodeRuntime().clock, spawn: () => fake },
      createLogger("debug", () => {}),
    );
    const started = s.start();
    // The first prompt reaches the session a microtask after start(), once
    // launch() has got as far as registering the listeners.
    await new Promise<void>((resolve) => setImmediate(resolve));
    fake.emit("Wine-dbg>");
    await started;
    const answered = s.executeCommand("bt", IN_FLIGHT_TIMEOUT_MS);
    fake.emit(body);
    fake.emit("Wine-dbg>");
    const out = await answered;
    s.stop();
    const notice = out.slice(0, out.indexOf("\n"));
    expect(notice).toMatch(/^\[\d+ characters of earlier output dropped: buffer limit\]$/);
    return out.slice(notice.length + 1);
  }

  test("starts the reply on a character with a base, not on a bare mark", async () => {
    // One unit past the cap is an odd count, and every odd offset of this text
    // is the combining mark of a cluster whose "e" the cut would have left
    // behind. A reply opening on the mark attaches an accent to the notice
    // above it instead of to its own letter.
    const tail = await replyFrom(`${CLUSTER.repeat(CAP_CHARS / 2)}e`);
    expect(tail).toBe(`${CLUSTER.repeat(Math.floor((RETAIN_CHARS - 1) / 2))}e`);
  });

  test("starts the reply on a whole emoji, not on part of a sequence", async () => {
    // Whole sequences plus four units, so the cut lands four units into one of
    // them: past a joiner and inside the next emoji, which is a split surrogate
    // pair and a split sequence at once. The whole of that sequence is dropped,
    // so the reply starts on the one after it.
    const whole = (CAP_CHARS / FAMILY.length) * (3 / 4) - 1;
    const tail = await replyFrom(`${FAMILY.repeat(CAP_CHARS / FAMILY.length)}END!`);
    expect(tail).toBe(`${FAMILY.repeat(whole)}END!`);
  });
});

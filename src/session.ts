import { BINARY_VAR } from "./config.js";
import { DEFAULT_BINARY, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS } from "./constants.js";
import { type Logger, stderrLogger } from "./logger.js";
import type { DebuggerChild, SessionRuntime, Timer } from "./runtime.js";
import { nodeRuntime } from "./runtime.js";

const PROMPT = "Wine-dbg>";

// A debuggee writing to stdout produces output no prompt ever terminates, so the
// buffer needs a ceiling that does not depend on the debugger cooperating.
const MAX_BUFFER_CHARS = 1024 * 1024;
// Once the ceiling is hit, the tail is cut back to here rather than to the
// ceiling: copying the whole buffer on every chunk of a chatty reply costs more
// than the memory the extra quarter megabyte holds.
const BUFFER_RETAIN_CHARS = Math.floor((MAX_BUFFER_CHARS * 3) / 4);
// SIGTERM asks; a debugger stopped inside a trap handler may not answer.
const KILL_GRACE_MS = 2000;
// A start waits this long for a debugger a previous stop signalled to be gone
// before spawning its own, so a client alternating start and stop cannot leave a
// detached process group per cycle. It exceeds the grace by the time a SIGKILL
// needs to land and the close event to arrive; past it the start proceeds, since
// an unresponsive child must not wedge the tool.
const TERMINATION_WAIT_MS = KILL_GRACE_MS * 2;
// A signalled process group is polled rather than waited on, since nothing
// reports the end of a member the session never spawned. The poll is short
// because every member was signalled when the debugger was: the group is only
// still there while one of them is winding down.
const GROUP_POLL_INTERVAL_MS = 50;
const GROUP_EXIT_POLLS = KILL_GRACE_MS / GROUP_POLL_INTERVAL_MS;
// A prompt is PROMPT.length characters, so one split across two reads is only
// found if the characters before the split are searched again with the next
// read. Keeping that overlap is what lets a read be searched where it landed
// rather than by re-walking the whole buffer: a reply arrives in pieces, and a
// megabyte of them searched from the head on every piece costs a pass over
// everything received so far, per piece.
const PROMPT_OVERLAP = PROMPT.length - 1;
// The debugger answers one line with one prompt, so a command is one line only
// if it is one line under every reader: a stream reader splits on \n, \r and
// vertical tab, and a text decoder that honours the Unicode line breaks splits
// on NEL (U+0085), U+2028 and U+2029 too. NUL is not a line break but truncates
// the line for most C readers, leaving the reply stream one prompt out of step
// the same way a second line would.
export const LINE_BREAKS = /[\n\r\v\f\0\u0085\u2028\u2029]/;

/**
 * Code points in `text[0, end)`, which is what a reader counts, not the UTF-16
 * units String#length reports. Counted over a range rather than over a
 * substring: the dropped prefix runs to a quarter of a megabyte on every trim,
 * and copying it only to walk it costs more than the walk.
 */
function countCodePoints(text: string, end: number): number {
  let count = 0;
  for (let i = 0; i < end; i++) {
    // A high surrogate and the low one after it are one character, two units.
    if (i + 1 < end && isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1))) i++;
    count++;
  }
  return count;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  // A signalled child has no exit code, and reporting the absent one reads as
  // "exited with code null" rather than as the signal that ended it.
  return signal !== null ? `winedbg was killed by ${signal}` : `winedbg exited with code ${code ?? "unknown"}`;
}

/**
 * One winedbg process, driven over its pipes.
 *
 * winedbg labels nothing in its output: the only marker in the merged
 * stdout/stderr stream is the prompt it prints after each command, and a
 * program under debug writes to the same pipes. Every rule below follows from
 * that, so a reply is what sits between two prompts and nothing else.
 *
 * Concurrency: the server hands tool calls in from the event loop, so several
 * can be in flight at once, and they all reach this one object. Every guard
 * here and every state change it makes sits in a single synchronous block, so
 * a check and the claim it guards cannot be separated by another task: two
 * callers racing for the command slot produce one winner and one refusal, never
 * two commands sharing a reply. A session is confined to the thread that built
 * it; it is not safe to share one across worker threads.
 */
export class WinedbgSession {
  private process: DebuggerChild | null = null;
  private currentPromise: { resolve: (out: string) => void; reject: (err: Error) => void } | null = null;
  // The command that promise is waiting on, so the error that refuses the next
  // one can name it.
  private currentCommand: string | null = null;
  private buffer: string = "";
  // The last PROMPT_OVERLAP characters of `buffer`, which is also the whole of
  // it while it is shorter. Everything before the tail has been searched and
  // holds no prompt, so a read is searched in the tail plus itself: the
  // characters a prompt could straddle, and nothing already consumed. A chatty
  // debuggee fills the buffer and keeps filling it, and searching all of it per
  // read costs a pass over a megabyte for every line printed.
  private tail: string = "";
  private isReady: boolean = false;
  // Claimed by start() before it awaits anything and released when it settles,
  // so a second start in the same tick is refused rather than racing the first
  // one past a check the first has not yet made true.
  private startPending: boolean = false;
  // Rejects the in-flight start(). Only the latest start is stored, because
  // start() refuses to run beside another one.
  private initReject: ((err: Error) => void) | null = null;
  private readyTimer: Timer | null = null;
  // Set when a command timed out: the debugger still owes that command a prompt.
  // Draining it keeps a late reply from being handed to the next command as its
  // own output. Only one can be outstanding, since executeCommand refuses to
  // send while it is.
  private awaitingAbandonedPrompt: boolean = false;
  private droppedChars: number = 0;
  // Debuggers a stop or a failed start signalled, still waiting to be reaped.
  private terminating: Set<DebuggerChild> = new Set();
  // Bumped by every start and by every stop. A launch waiting to spawn reads it
  // afterwards, so a stop during that wait cancels the start rather than leaving
  // it to spawn a debugger nobody is waiting on.
  private launchId: number = 0;
  // Distinguishes a launch cancelled by stop() from one replaced by a newer
  // start, so each reports the state the caller has to act on.
  private stopRequested: boolean = false;
  // Set by stop() before the kill, so the close that follows is reported as the
  // requested end of a session rather than as a debugger that died.
  private stoppedByRequest: boolean = false;

  constructor(
    private readonly binary: string = DEFAULT_BINARY,
    private readonly readyTimeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
    private readonly runtime: SessionRuntime = nodeRuntime(),
    private readonly log: Logger = stderrLogger,
  ) {}

  /**
   * Spawn the debugger and resolve once it prints its first prompt. `args`
   * reaches its argv unchanged, so a program to launch or a PID to attach to
   * both work. Rejects if a session is already running, and kills the child if
   * the prompt does not arrive within `readyTimeoutMs`.
   */
  // async so that everything here, spawn() throwing on an argument it cannot
  // carry included, reaches the caller as a rejection. A synchronous throw would
  // slip past a caller that handles the returned promise.
  async start(args: string[] = []): Promise<void> {
    if (this.process || this.startPending) {
      throw new Error("winedbg is already running. Please stop it first.");
    }
    this.startPending = true;
    const id = ++this.launchId;
    this.stopRequested = false;
    try {
      await this.launch(args, id);
    } finally {
      this.startPending = false;
    }
  }

  private async launch(args: string[], id: number): Promise<void> {
    await this.awaitTerminations();
    if (id !== this.launchId) {
      throw new Error(
        this.stopRequested
          ? "winedbg stopped before it was ready"
          : "winedbg was not started: a newer winedbg_start call replaced this one",
      );
    }
    // A previous session can die leaving a prompt in the buffer; without this
    // reset the next start would report ready before the new child says anything.
    this.resetState();
    this.stoppedByRequest = false;

    let child: DebuggerChild;
    try {
      child = this.runtime.spawn(this.binary, args);
    } catch (error) {
      // spawn() throws before a child exists when an argument cannot be carried,
      // and its message names neither the variable nor the argument. Nothing is
      // running, so refusing the next start is not a concern here. Rejected
      // rather than thrown: every other start failure arrives that way, and a
      // caller with only a .catch() on the result would miss this.
      this.log.error("winedbg could not be spawned", {
        binary: this.binary,
        args: JSON.stringify(args),
        error: error instanceof Error ? error.message : String(error),
      });
      return Promise.reject(
        new Error(
          `Failed to start ${this.binary} with args ${JSON.stringify(args)}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    this.process = child;
    const startedAt = Date.now();
    this.log.info("winedbg spawned, waiting for its first prompt", {
      binary: this.binary,
      args: JSON.stringify(args),
      pid: child.pid ?? null,
      readyTimeoutMs: this.readyTimeoutMs,
    });

    return new Promise<void>((resolve, reject) => {
      // Events from an already-replaced child (a kill lands after the next
      // start) must not touch the current session's state.
      const isCurrent = () => this.process === child;

      // Report a session-ending failure to whoever is waiting on it, whichever
      // event carried it: the child exiting, the child erroring, or one of its
      // output pipes failing.
      const fail = (error: Error) => {
        const failStart = !this.isReady && this.initReject !== null;
        if (failStart) this.initReject = null;
        this.clearReadyTimer();
        // A child that never got a pid never ran, so it is not a session:
        // leaving it set would refuse every later start with "already running"
        // until the close event caught up. A child that did run keeps its
        // handle, so stop() can still reach a debugger and its debuggee.
        if (child.pid === undefined) {
          this.process = null;
          this.isReady = false;
          this.awaitingAbandonedPrompt = false;
        }
        if (failStart) reject(error);
        if (this.currentPromise) {
          this.currentPromise.reject(error);
          this.releaseCurrent();
        }
      };

      this.initReject = reject;
      this.readyTimer = this.runtime.clock.setTimeout(() => {
        if (!isCurrent() || this.isReady) return;
        // Leaving the child alive would wedge the session: start refuses a
        // second run and executeCommand refuses an unready one.
        this.process = null;
        this.initReject = null;
        this.readyTimer = null;
        this.terminate(child);
        this.log.error("winedbg printed no first prompt before the ready timeout", {
          binary: this.binary,
          pid: child.pid ?? null,
          readyTimeoutMs: this.readyTimeoutMs,
        });
        reject(new Error(`Timeout waiting for ${this.binary} to print its first prompt (${this.readyTimeoutMs}ms)`));
      }, this.readyTimeoutMs);

      const onData = (chunk: string) => {
        if (!isCurrent()) return;
        const window = this.append(chunk);
        this.trimBuffer();
        const promptIndex = this.indexOfPrompt(window);
        if (this.isReady) {
          if (promptIndex !== -1) this.takeReply(promptIndex);
        } else if (promptIndex !== -1) {
          this.isReady = true;
          this.clearBuffer();
          this.initReject = null;
          this.clearReadyTimer();
          this.log.info("winedbg is at its first prompt", {
            pid: child.pid ?? null,
            readyMs: Date.now() - startedAt,
          });
          resolve();
        }
      };

      child.onData(onData);

      child.onClose((code, signal) => {
        if (!isCurrent()) return;
        const wasReady = this.isReady;
        this.process = null;
        this.isReady = false;
        this.awaitingAbandonedPrompt = false;
        this.clearReadyTimer();
        // A debugger that dies on its own, after a prompt, is the failure an
        // operator has to tell apart from a requested stop: nothing in the tool
        // result says the process went away underneath the call.
        const fields = {
          code,
          signal,
          wasReady,
          pid: child.pid ?? null,
          lifetimeMs: Date.now() - startedAt,
        };
        if (this.stoppedByRequest) this.log.info("winedbg exited after a requested stop", fields);
        else this.log.error("winedbg exited", fields);
        // A child that dies before printing a prompt fails start now, rather
        // than hanging until the ready timeout.
        const initReject = wasReady ? null : this.initReject;
        this.initReject = null;
        this.failChild(new Error(describeExit(code, signal)), initReject);
      });

      child.onError((error) => {
        if (!isCurrent()) return;
        // "spawn winedbg ENOENT" names neither the variable that carries the
        // path nor what to check, and it is the failure a mistyped binary
        // produces on every deployment.
        const message =
          child.pid === undefined
            ? `Failed to run ${this.binary}${args.length > 0 ? ` with args ${JSON.stringify(args)}` : ""}: ${error.message}. Check ${BINARY_VAR} and that the executable is on PATH.`
            : this.currentCommand === null
              ? error.message
              : `winedbg failed while running ${JSON.stringify(this.currentCommand)}: ${error.message}`;
        this.log.error("winedbg process error", {
          pid: child.pid ?? null,
          command: this.currentCommand,
          error: error.message,
        });
        fail(new Error(message));
      });
    });
  }

  /**
   * A child that died (or never ran) settles everything waiting on it: a start
   * that has not reached a prompt, and a command in flight. Both go out with
   * the same reason, and the command slot is released either way.
   */
  private failChild(reason: Error, initReject: ((err: Error) => void) | null) {
    if (initReject !== null) initReject(reason);
    if (this.currentPromise) {
      this.currentPromise.reject(reason);
      this.releaseCurrent();
    }
  }

  private clearReadyTimer() {
    if (this.readyTimer === null) return;
    this.readyTimer.cancel();
    this.readyTimer = null;
  }

  /**
   * Wait for the debuggers an earlier stop signalled to be gone. Each one holds
   * a detached process group that outlives the session that made it, and a
   * client alternating start and stop would otherwise leave one per cycle. The
   * wait is bounded: a child that outlives SIGKILL must not wedge the tool, and
   * the next start proceeds rather than waiting on it. The bound is a delay on
   * the injected clock, like every other timeout here, so a run under a virtual
   * clock is bounded by the same clock it advances.
   */
  private async awaitTerminations() {
    while (this.terminating.size > 0) {
      const children = [...this.terminating];
      const closed = Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              child.onClose(() => resolve());
            }),
        ),
      );
      // A box, not a local: the assignment happens inside the executor, which
      // the control flow analysis does not follow.
      const bound: { timer: Timer | null } = { timer: null };
      const expired = new Promise<void>((resolve) => {
        bound.timer = this.runtime.clock.setTimeout(resolve, TERMINATION_WAIT_MS);
        bound.timer.unref();
      });
      await Promise.race([closed, expired]);
      bound.timer?.cancel();
      if (this.terminating.size >= children.length) {
        // The wait expired with nothing reaped. An entry only exists to hold the
        // next start off, and a child that outlived SIGKILL is not going to
        // report a close: left in place it would grow the set by one per stop,
        // never released, and make every later wait cover all of them at once.
        for (const child of children) this.terminating.delete(child);
        return;
      }
      // The debugger's close says nothing about the debuggee it started. Both
      // were signalled in the same instant, but each ends on its own schedule,
      // and shutdown() promises the caller that neither outlives it.
      await Promise.all(children.map((child) => this.awaitGroupExit(child)));
    }
  }

  /**
   * Wait for the process group a signalled debugger led to be gone. Bounded by a
   * count of polls rather than by a reading of the clock, so it costs the same on
   * every clock this session is given.
   */
  private async awaitGroupExit(child: DebuggerChild): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) return;
    for (let poll = GROUP_EXIT_POLLS; poll > 0; poll--) {
      try {
        // Signal 0 reaches no process and reports whether the group is still
        // there. ESRCH is the answer that ends the wait.
        process.kill(-pid, 0);
      } catch {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = this.runtime.clock.setTimeout(resolve, GROUP_POLL_INTERVAL_MS);
        timer.unref();
      });
    }
  }

  private releaseCurrent() {
    this.currentPromise = null;
    this.currentCommand = null;
  }

  /**
   * Give up on the in-flight command without retracting it: the debugger has it
   * and still owes the prompt, so its reply belongs to nobody.
   */
  private abandonCurrent(error: Error) {
    if (this.currentPromise === null) return;
    this.awaitingAbandonedPrompt = true;
    this.currentPromise.reject(error);
    this.releaseCurrent();
  }

  /**
   * End the debugger and everything it started. winedbg launches the debuggee as
   * its own child, so a signal to winedbg alone would leave the program under
   * debug running with no debugger and no owner.
   */
  private terminate(child: DebuggerChild) {
    // Tracked until the close that ends it, since the next start waits for it
    // rather than racing it into a second detached process group.
    this.terminating.add(child);
    child.killTree("SIGTERM");
    // A debugger stopped inside a trap handler may not answer SIGTERM.
    const grace = this.runtime.clock.setTimeout(() => {
      child.killTree("SIGKILL");
      // A process the kernel has not finished with keeps the far end of every
      // command pipe open, and this process holds a descriptor for each until it
      // does. Left to wait for a process that may never exit, every start and
      // stop cycle would add three more.
      child.closePipes();
      // Nothing more can be done for a debugger that has survived SIGKILL, and a
      // start only ever waited a bounded time for it, so stop tracking it
      // instead of growing the set by one per cycle.
      this.terminating.delete(child);
    }, KILL_GRACE_MS);
    grace.unref();
    child.onClose(() => {
      this.terminating.delete(child);
      grace.cancel();
    });
  }

  /** Bound the buffer, keeping the tail: the prompt that ends a reply is there. */
  private trimBuffer() {
    // The cap is a memory bound, so it counts UTF-16 code units, what String#length
    // reports. droppedChars counts code points instead, because that is the unit
    // the notice names them in.
    if (this.buffer.length <= MAX_BUFFER_CHARS) return;
    const cut = this.charCountToCodePointBoundary(this.buffer.length - BUFFER_RETAIN_CHARS);
    this.droppedChars += countCodePoints(this.buffer, cut);
    this.dropBufferPrefix(cut);
  }

  /**
   * Move a cut off the middle of a surrogate pair, whichever half it lands on.
   * Characters outside the BMP take two code units, and a cut between the halves
   * leaves a lone surrogate that no JSON encoder or terminal will render as the
   * character it was. A cut on a low half moves back; one just past a high half
   * moves forward, since dropping the low half is what unpaired it.
   */
  private charCountToCodePointBoundary(count: number) {
    if (count <= 0 || count >= this.buffer.length) return count;
    if (isLowSurrogate(this.buffer.charCodeAt(count))) return count - 1;
    if (count + 1 < this.buffer.length && isHighSurrogate(this.buffer.charCodeAt(count - 1))) return count + 1;
    return count;
  }

  private clearBuffer() {
    this.buffer = "";
    this.tail = "";
  }

  /** Drop everything a run leaves behind: buffered output, readiness, owed prompts. */
  private resetState() {
    this.isReady = false;
    this.awaitingAbandonedPrompt = false;
    this.droppedChars = 0;
    this.clearBuffer();
  }

  /**
   * Take one read of output. Appending to a string the size of a reply is
   * cheap on its own; what costs is searching it, so nothing reads the whole
   * buffer back here. Returns the window the next search covers: the tail as it
   * stood before the read, then the read.
   */
  private append(chunk: string) {
    const window = this.tail + chunk;
    this.buffer += chunk;
    this.tail = window.length > PROMPT_OVERLAP ? window.slice(-PROMPT_OVERLAP) : window;
    return window;
  }

  /**
   * The first prompt in `window`, as an index into `buffer`, or -1 when there
   * is none. The window is the tail plus the newest read: everything before the
   * tail has been searched already and holds no prompt, and the tail is exactly
   * what a prompt split across two reads could straddle.
   */
  private indexOfPrompt(window: string): number {
    // A read larger than what the ceiling retains leaves the trim having cut
    // into the window, so the window is no longer a suffix of the buffer and
    // its offset is meaningless. A pipe read never is that large; searching
    // the buffer is the same search and gives the index directly.
    if (this.buffer.length < window.length) return this.buffer.indexOf(PROMPT);
    const at = window.indexOf(PROMPT);
    return at === -1 ? -1 : this.buffer.length - window.length + at;
  }

  /**
   * Hand the output between prompts to whoever is waiting on it. `first` is the
   * prompt the search found, and the boundary the reply ends at.
   */
  private takeReply(first: number) {
    // Settle the abandoned command first: its prompt is a boundary, not output
    // for whoever is waiting now.
    const drained = this.awaitingAbandonedPrompt;
    if (drained) {
      this.dropBufferPrefix(first + PROMPT.length);
      this.awaitingAbandonedPrompt = false;
    }
    if (!this.currentPromise) return;

    // A drain leaves the whole remainder unsearched, so the last prompt in it
    // ends the reply. Every other search starts past a prompt-free prefix, so
    // the first prompt it finds is also the last one in the buffer.
    const promptIndex = drained ? this.buffer.lastIndexOf(PROMPT) : first;
    if (promptIndex === -1) return;
    // Everything before the last prompt is the command's output.
    const output = this.buffer.substring(0, promptIndex).trim();
    this.dropBufferPrefix(promptIndex + PROMPT.length);

    const dropped = this.droppedChars;
    this.droppedChars = 0;
    if (dropped > 0) {
      this.log.warn("winedbg output hit the buffer limit and its head was dropped", {
        droppedChars: dropped,
        command: this.currentCommand,
      });
    }
    // Say what was lost rather than returning a silently shortened reply.
    this.currentPromise.resolve(
      dropped > 0 ? `[${dropped} characters of earlier output dropped: buffer limit]\n${output}` : output,
    );
    this.releaseCurrent();
  }

  /**
   * Drop consumed or over-long output from the head. The tail is the buffer's
   * last few characters, so a prefix drop leaves it in place unless less is
   * left than it holds, and then the whole remainder is the new tail.
   */
  private dropBufferPrefix(count: number) {
    this.buffer = this.buffer.substring(count);
    if (this.buffer.length < this.tail.length) this.tail = this.buffer;
  }

  /**
   * Send one command and resolve with the text before the next prompt.
   *
   * Rejects rather than guessing: no live session, a command already in
   * flight, a prompt still owed to a command that timed out, a command
   * carrying a line terminator, and a debugger whose stdin pipe is gone.
   * `timeoutMs` bounds the wait for the reply, not for the command to take
   * effect; the command keeps running either way.
   */
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS): Promise<string> {
    if (!this.process || !this.isReady) {
      throw new Error("winedbg is not running. Please start it first.");
    }
    if (this.currentPromise) {
      throw new Error(
        `Another command is already in progress: ${JSON.stringify(this.currentCommand)}. Wait for its reply.`,
      );
    }
    // A debugger that has not returned to its prompt is not reading commands,
    // and any output it does produce belongs to the abandoned command. Refusing
    // is what is true; guessing is what returned the wrong backtrace.
    if (this.awaitingAbandonedPrompt) {
      throw new Error(
        "The previous command timed out and the debugger has not returned to its prompt. " +
          "Retry once it does, or stop and start the session.",
      );
    }
    // Each line is a command and answers with its own prompt, so a multi-line
    // string would leave the reply stream one or more prompts out of step. The
    // set is the union of what a stream reader may split on, and the debugger is
    // not the only reader: the reply framing is a prompt count, not a byte count.
    if (LINE_BREAKS.test(command)) {
      throw new Error("Command must be a single line. Send one winedbg command per call.");
    }

    const child = this.process;
    const stdin = child.stdin;
    if (!stdin) {
      throw new Error(
        "winedbg was started without an open stdin pipe, so no command can reach it. Stop and start the session again.",
      );
    }
    return new Promise((resolve, reject) => {
      const sentAt = Date.now();
      const timeout = this.runtime.clock.setTimeout(() => {
        this.log.error("winedbg command timed out", { command, timeoutMs, commandMs: Date.now() - sentAt });
        this.abandonCurrent(new Error(`Command timed out after ${timeoutMs}ms: ${JSON.stringify(command)}`));
      }, timeoutMs);

      this.currentPromise = {
        resolve: (out) => {
          timeout.cancel();
          resolve(out);
        },
        reject: (err) => {
          timeout.cancel();
          reject(err);
        },
      };
      this.currentCommand = command;
      this.log.debug("winedbg command sent", { command, timeoutMs });

      // Anything still buffered predates this command. Owed prompts are counted
      // separately, so dropping the text here cannot lose a boundary.
      this.clearBuffer();
      try {
        stdin.write(`${command}\n`);
      } catch (error) {
        // The write failed part way, so the debugger may hold the command and
        // still owe a prompt. Release the slot instead of leaving every later
        // command refused as in progress.
        this.log.error("winedbg command could not be written", {
          command,
          error: error instanceof Error ? error.message : String(error),
        });
        this.abandonCurrent(
          new Error(
            `Failed to send ${JSON.stringify(command)} to winedbg: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /**
   * End the debugger and the debuggee under it, and settle anything waiting:
   * an in-flight start, a command in flight. Returns without waiting for the
   * child to exit; a no-op when no session is running.
   */
  stop() {
    // A start still waiting to spawn has nothing to signal, so it is cancelled
    // here rather than left to come up after the caller stopped it.
    this.launchId++;
    this.stopRequested = true;
    const child = this.detach();
    if (!child) return;
    this.terminate(child);
  }

  /**
   * End the debugger and the debuggee under it without waiting, for a process
   * that is already exiting. The grace period stop() relies on is a timer on
   * the event loop, and an exit handler runs with the loop already drained, so
   * the escalation it schedules would never fire and a debuggee that ignores
   * SIGTERM would outlive the server. There is no time left to ask nicely.
   */
  stopImmediately() {
    const child = this.detach();
    if (!child) return;
    child.killTree("SIGKILL");
  }

  /** Release the session and settle everything waiting on it, leaving the child to signal. */
  private detach(): DebuggerChild | null {
    const child = this.process;
    if (!child) return null;

    this.process = null;
    this.resetState();
    this.stoppedByRequest = true;
    // A start() in flight outlives neither this stop nor its ready timer: the
    // caller is awaiting a prompt that can no longer arrive.
    const initReject = this.initReject;
    this.initReject = null;
    this.clearReadyTimer();
    if (initReject) {
      initReject(new Error("winedbg stopped before it was ready"));
    }
    if (this.currentPromise) {
      this.currentPromise.reject(new Error("winedbg stopped manually"));
      this.releaseCurrent();
    }
    return child;
  }

  /**
   * Stop the session and wait for the debuggers it signalled to be gone.
   *
   * `stop` returns as soon as SIGTERM is sent, which is not the end of the
   * cleanup: a debugger stopped inside a trap handler ignores it and is only
   * ended by the escalation a grace period later. A caller that exits the
   * process on the strength of `stop` alone takes that escalation with it and
   * leaves the debugger, and the debuggee it launched, running with no owner.
   *
   * Calling it again signals nothing a second time: `stop` has already released
   * the child, so the repeat waits on the same termination rather than starting
   * a second one.
   */
  async shutdown(): Promise<void> {
    this.stop();
    await this.awaitTerminations();
  }

  /** Whether a debugger process is held, ready or not. Not whether it is at its prompt. */
  isRunning(): boolean {
    return this.process !== null;
  }
}

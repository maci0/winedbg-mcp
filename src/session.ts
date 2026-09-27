import { spawn, ChildProcess } from "child_process";

const PROMPT = "Wine-dbg>";
export const DEFAULT_BINARY = "winedbg";
// A cold wineprefix takes longer to answer than a warm one; config.ts lets a
// deployment raise this without a rebuild.
export const DEFAULT_READY_TIMEOUT_MS = 10000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
export const MAX_COMMAND_TIMEOUT_MS = 600000;
// A debuggee writing to stdout produces output no prompt ever terminates, so the
// buffer needs a ceiling that does not depend on the debugger cooperating.
const MAX_BUFFER_CHARS = 1024 * 1024;
// SIGTERM asks; a debugger stopped inside a trap handler may not answer.
const KILL_GRACE_MS = 2000;
// A debugger command is not naturally idempotent: `cont`, `set`, `x` and the
// rest change the state of the debugger or the debuggee, so a retry that reached
// the debugger again would run them twice. Answers are therefore kept against
// the caller's requestId, and the window is fixed: the newest DEDUP_ANSWERS
// commands and at most DEDUP_ANSWER_CHARS of their output, oldest evicted, so a
// long session cannot grow the map without end.
const DEDUP_ANSWERS = 32;
const DEDUP_ANSWER_CHARS = MAX_BUFFER_CHARS;

type CommandOutcome = { ok: true; output: string } | { ok: false; message: string };
type AnsweredCommand = { command: string; outcome: CommandOutcome };

function outcomeChars(outcome: CommandOutcome): number {
  return outcome.ok ? outcome.output.length : outcome.message.length;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  // A signalled child has no exit code, and reporting the absent one reads as
  // "exited with code null" rather than as the signal that ended it.
  return signal !== null ? `winedbg was killed by ${signal}` : `winedbg exited with code ${code ?? "unknown"}`;
}

export class WinedbgSession {
  private process: ChildProcess | null = null;
  private currentPromise: { resolve: (out: string) => void; reject: (err: Error) => void } | null = null;
  // The command that promise is waiting on, so the error that refuses the next
  // one can name it.
  private currentCommand: string | null = null;
  private buffer: string = "";
  private isReady: boolean = false;
  private initPromise: Promise<void> | null = null;
  // Rejects the in-flight start(). Only the latest start is stored, because
  // start() refuses to run beside another one.
  private initReject: ((err: Error) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  // Set when a command timed out: the debugger still owes that command a prompt.
  // Draining it keeps a late reply from being handed to the next command as its
  // own output. Only one can be outstanding, since executeCommand refuses to
  // send while it is.
  private awaitingAbandonedPrompt: boolean = false;
  private droppedChars: number = 0;
  // What the in-flight command was asked under, and the promise answering it, so
  // a retry carrying the same requestId joins the run already in progress
  // instead of starting a second one.
  private currentRequestId: string | null = null;
  private currentResult: Promise<string> | null = null;
  // Answers already given, oldest first, for retries after the command is over.
  private answered: Map<string, AnsweredCommand> = new Map();
  private answeredChars: number = 0;

  constructor(
    private readonly binary: string = DEFAULT_BINARY,
    private readonly readyTimeoutMs: number = DEFAULT_READY_TIMEOUT_MS
  ) {}

  start(args: string[] = []): Promise<void> {
    if (this.process) {
      return Promise.reject(new Error("winedbg is already running. Please stop it first."));
    }

    // A previous session can die leaving a prompt in the buffer; without this
    // reset the next start would report ready before the new child says anything.
    this.buffer = "";
    this.isReady = false;
    this.awaitingAbandonedPrompt = false;
    this.droppedChars = 0;
    // Answers belong to the session that produced them: a new debugger, even
    // with the same arguments, has not run them.
    this.clearAnswers();

    const child = spawn(this.binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so terminate() can reach the debuggee winedbg
      // started. Signalling winedbg alone leaves the debuggee running.
      detached: true,
    });
    this.process = child;

    // A command written to a pipe the debugger has already closed comes back as
    // an EPIPE 'error' on the stream, and an unhandled one takes this process
    // down with it. The handlers below already report the failure to whoever is
    // waiting on a command, so the stream's own error carries nothing new.
    child.stdin?.on("error", () => {});

    this.initPromise = new Promise((resolve, reject) => {
      // Events from an already-replaced child (a kill lands after the next
      // start) must not touch the current session's state.
      const isCurrent = () => this.process === child;

      this.initReject = reject;
      this.readyTimer = setTimeout(() => {
        if (!isCurrent() || this.isReady) return;
        // Leaving the child alive would wedge the session: start refuses a
        // second run and executeCommand refuses an unready one.
        this.process = null;
        this.initReject = null;
        this.readyTimer = null;
        this.terminate(child);
        reject(new Error(`Timeout waiting for winedbg to start (${this.readyTimeoutMs}ms)`));
      }, this.readyTimeoutMs);

      const checkReady = () => {
        if (this.buffer.includes(PROMPT)) {
          this.isReady = true;
          this.buffer = "";
          this.initReject = null;
          this.clearReadyTimer();
          resolve();
        }
      };

      const onData = (data: Buffer) => {
        if (!isCurrent()) return;
        this.buffer += data.toString();
        this.trimBuffer();
        if (!this.isReady) checkReady();
        else this.checkOutput();
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("close", (code, signal) => {
        if (!isCurrent()) return;
        const wasReady = this.isReady;
        this.process = null;
        this.isReady = false;
        this.awaitingAbandonedPrompt = false;
        const failStart = !wasReady && this.initReject !== null;
        if (failStart) this.initReject = null;
        this.clearReadyTimer();
        const reason = describeExit(code, signal);
        // A child that dies before printing a prompt fails start now, rather
        // than hanging until the ready timeout.
        if (failStart) reject(new Error(reason));
        if (this.currentPromise) {
          this.currentPromise.reject(new Error(reason));
          this.releaseCurrent();
        }
      });

      child.on("error", (error) => {
        if (!isCurrent()) return;
        const failStart = !this.isReady && this.initReject !== null;
        if (failStart) this.initReject = null;
        this.clearReadyTimer();
        // A child that could not be spawned is no session to run a command in.
        // Leaving it set would refuse the next start with "already running"
        // for a process that never existed, until the close event caught up.
        this.process = null;
        this.isReady = false;
        this.awaitingAbandonedPrompt = false;
        if (failStart) reject(error);
        if (this.currentPromise) {
          this.currentPromise.reject(error);
          this.releaseCurrent();
        }
      });
    });

    return this.initPromise;
  }

  private clearReadyTimer() {
    if (this.readyTimer === null) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private releaseCurrent() {
    this.currentPromise = null;
    this.currentCommand = null;
    this.currentRequestId = null;
    this.currentResult = null;
  }

  /** Record the answer a requestId already has, evicting the oldest past the window. */
  private remember(requestId: string, command: string, outcome: CommandOutcome) {
    // Delete first so a re-recorded id moves to the newest end of the map.
    this.forget(requestId);
    this.answered.set(requestId, { command, outcome });
    this.answeredChars += outcomeChars(outcome);
    while (this.answered.size > DEDUP_ANSWERS || this.answeredChars > DEDUP_ANSWER_CHARS) {
      const oldest = this.answered.keys().next();
      // The newest entry is over the character budget on its own; it stays, or
      // the retry that made it could never be answered.
      if (oldest.done || oldest.value === requestId) return;
      this.forget(oldest.value);
    }
  }

  private forget(requestId: string) {
    const answered = this.answered.get(requestId);
    if (answered === undefined) return;
    this.answeredChars -= outcomeChars(answered.outcome);
    this.answered.delete(requestId);
  }

  private clearAnswers() {
    this.answered.clear();
    this.answeredChars = 0;
  }

  /**
   * The answer a previous run gave this requestId, or undefined when the
   * debugger has never seen it. A reused id naming a different command is a
   * caller bug: answering it would hand back the wrong command's output.
   */
  private replay(requestId: string, command: string): Promise<string> | undefined {
    const answered = this.answered.get(requestId);
    if (answered === undefined) return undefined;
    if (answered.command !== command) {
      return Promise.reject(
        new Error(
          `requestId ${JSON.stringify(requestId)} already answered ${JSON.stringify(answered.command)}. ` +
            `Use a fresh requestId for ${JSON.stringify(command)}.`
        )
      );
    }
    if (answered.outcome.ok) return Promise.resolve(answered.outcome.output);
    return Promise.reject(new Error(answered.outcome.message));
  }

  /**
   * Give up on the in-flight command without retracting it: the debugger has it
   * and still owes the prompt, so its reply belongs to nobody.
   */
  private abandonCurrent(error: Error) {
    if (this.currentPromise === null) return;
    this.awaitingAbandonedPrompt = true;
    const { currentRequestId, currentCommand } = this;
    // The debugger may have run the command and lost the reply, so a retry
    // under the same requestId has to get this same failure, not a second run.
    if (currentRequestId !== null && currentCommand !== null) {
      this.remember(currentRequestId, currentCommand, { ok: false, message: error.message });
    }
    this.currentPromise.reject(error);
    this.releaseCurrent();
  }

  /**
   * End the debugger and everything it started. winedbg launches the debuggee as
   * its own child, so a signal to winedbg alone would leave the program under
   * debug running with no debugger and no owner.
   */
  private terminate(child: ChildProcess) {
    this.signalTree(child, "SIGTERM");
    // A debugger stopped inside a trap handler may not answer SIGTERM.
    const grace = setTimeout(() => this.signalTree(child, "SIGKILL"), KILL_GRACE_MS);
    grace.unref();
    child.once("close", () => clearTimeout(grace));
  }

  private signalTree(child: ChildProcess, signal: NodeJS.Signals) {
    if (child.pid === undefined) {
      child.kill(signal);
      return;
    }
    try {
      // Negative pid is the process group the detached child leads.
      process.kill(-child.pid, signal);
    } catch {
      // No such group: fall back to the debugger itself.
      child.kill(signal);
    }
  }

  /** Bound the buffer, keeping the tail: the prompt that ends a reply is there. */
  private trimBuffer() {
    if (this.buffer.length <= MAX_BUFFER_CHARS) return;
    const dropped = this.buffer.length - MAX_BUFFER_CHARS;
    this.buffer = this.buffer.slice(dropped);
    this.droppedChars += dropped;
  }

  private checkOutput() {
    // Settle the abandoned command first: its prompt is a boundary, not output
    // for whoever is waiting now.
    if (this.awaitingAbandonedPrompt) {
      const end = this.buffer.indexOf(PROMPT);
      if (end === -1) return;
      this.buffer = this.buffer.substring(end + PROMPT.length);
      this.awaitingAbandonedPrompt = false;
    }

    if (this.currentPromise && this.buffer.includes(PROMPT)) {
      // Everything before the last prompt is the command's output.
      const promptIndex = this.buffer.lastIndexOf(PROMPT);
      const output = this.buffer.substring(0, promptIndex).trim();
      this.buffer = this.buffer.substring(promptIndex + PROMPT.length);

      const dropped = this.droppedChars;
      this.droppedChars = 0;
      // Say what was lost rather than returning a silently shortened reply.
      this.currentPromise.resolve(dropped > 0 ? `[${dropped} characters of earlier output dropped: buffer limit]\n${output}` : output);
      this.releaseCurrent();
    }
  }

  /**
   * Send one command to the debugger. `requestId` names the logical command, not
   * the attempt: a repeat under the same id returns the first answer (or the
   * first failure) without putting the command into the debugger again, and a
   * repeat arriving while that command is still running joins it rather than
   * starting a second one. Without an id every call is a fresh run, which is
   * what a caller sending a genuinely new command wants.
   */
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS, requestId?: string): Promise<string> {
    if (requestId !== undefined) {
      const answered = this.replay(requestId, command);
      if (answered !== undefined) return answered;
      if (this.currentRequestId === requestId && this.currentResult !== null) {
        return this.currentResult;
      }
    }
    if (!this.process || !this.isReady) {
      throw new Error("winedbg is not running. Please start it first.");
    }
    if (this.currentPromise) {
      throw new Error(`Another command is already in progress: ${JSON.stringify(this.currentCommand)}. Wait for its reply.`);
    }
    // A debugger that has not returned to its prompt is not reading commands,
    // and any output it does produce belongs to the abandoned command. Refusing
    // is what is true; guessing is what returned the wrong backtrace.
    if (this.awaitingAbandonedPrompt) {
      throw new Error(
        "The previous command timed out and the debugger has not returned to its prompt. " +
          "Retry once it does, or stop and start the session."
      );
    }
    // Each line is a command and answers with its own prompt, so a multi-line
    // string would leave the reply stream one or more prompts out of step.
    if (/[\r\n]/.test(command)) {
      throw new Error("Command must be a single line. Send one winedbg command per call.");
    }

    const child = this.process;
    const stdin = child.stdin;
    if (!stdin) {
      throw new Error(
        "winedbg was started without an open stdin pipe, so no command can reach it. Stop and start the session again."
      );
    }
    const result = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.abandonCurrent(
          new Error(`Command timed out after ${timeoutMs}ms: ${JSON.stringify(command)}`)
        );
      }, timeoutMs);

      this.currentPromise = {
        resolve: (out) => {
          clearTimeout(timeout);
          if (requestId !== undefined) this.remember(requestId, command, { ok: true, output: out });
          resolve(out);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      };
      this.currentCommand = command;
      this.currentRequestId = requestId ?? null;

      // Anything still buffered predates this command. Owed prompts are counted
      // separately, so dropping the text here cannot lose a boundary.
      this.buffer = "";
      try {
        stdin.write(command + "\n");
      } catch (error) {
        // The write failed part way, so the debugger may hold the command and
        // still owe a prompt. Release the slot instead of leaving every later
        // command refused as in progress.
        this.abandonCurrent(
          new Error(
            `Failed to send ${JSON.stringify(command)} to winedbg: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
    // A write that failed synchronously already released the slot above, and an
    // answer for a command no longer in flight is the caller's own to reject.
    if (this.currentPromise !== null) this.currentResult = result;
    return result;
  }

  stop() {
    const child = this.process;
    if (!child) return;

    this.process = null;
    this.isReady = false;
    this.buffer = "";
    this.awaitingAbandonedPrompt = false;
    this.droppedChars = 0;
    // A stopped debugger is not waiting to answer anything, so a replayed
    // requestId would claim an answer the next session never gave.
    this.clearAnswers();
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

    this.terminate(child);
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}

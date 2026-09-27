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
export const MAX_BUFFER_CHARS = 1024 * 1024;
// SIGTERM asks; a debugger stopped inside a trap handler may not answer.
const KILL_GRACE_MS = 2000;

export class WinedbgSession {
  private process: ChildProcess | null = null;
  private currentPromise: { resolve: (out: string) => void; reject: (err: Error) => void } | null = null;
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

      child.on("close", (code) => {
        if (!isCurrent()) return;
        const wasReady = this.isReady;
        this.process = null;
        this.isReady = false;
        this.awaitingAbandonedPrompt = false;
        const failStart = !wasReady && this.initReject !== null;
        if (failStart) this.initReject = null;
        this.clearReadyTimer();
        // A child that dies before printing a prompt fails start now, rather
        // than hanging until the ready timeout.
        if (failStart) reject(new Error(`winedbg exited with code ${code}`));
        if (this.currentPromise) {
          this.currentPromise.reject(new Error(`winedbg exited with code ${code}`));
          this.currentPromise = null;
        }
      });

      child.on("error", (error) => {
        if (!isCurrent()) return;
        if (!this.isReady && this.initReject !== null) {
          this.initReject = null;
          this.clearReadyTimer();
          reject(error);
        }
        if (this.currentPromise) {
          this.currentPromise.reject(error);
          this.currentPromise = null;
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
      this.currentPromise = null;
    }
  }

  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS): Promise<string> {
    if (!this.process || !this.isReady) {
      throw new Error("winedbg is not running. Please start it first.");
    }
    if (this.currentPromise) {
      throw new Error("Another command is already in progress.");
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
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.currentPromise) {
          // The command is still running in the debugger; its prompt is owed.
          this.awaitingAbandonedPrompt = true;
          this.currentPromise.reject(new Error("Command execution timed out"));
          this.currentPromise = null;
        }
      }, timeoutMs);

      this.currentPromise = {
        resolve: (out) => {
          clearTimeout(timeout);
          resolve(out);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      };

      // Anything still buffered predates this command. Owed prompts are counted
      // separately, so dropping the text here cannot lose a boundary.
      this.buffer = "";
      child.stdin?.write(command + "\n");
    });
  }

  stop() {
    const child = this.process;
    if (!child) return;

    this.process = null;
    this.isReady = false;
    this.buffer = "";
    this.awaitingAbandonedPrompt = false;
    this.droppedChars = 0;
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
      this.currentPromise = null;
    }

    this.terminate(child);
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}

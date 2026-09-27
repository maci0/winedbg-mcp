import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * A scheduled callback. The session never needs the handle for anything but
 * cancelling, so that is all the port exposes.
 */
export interface Timer {
  cancel(): void;
  /**
   * Detach from the process lifetime, so a pending kill escalation cannot keep
   * a node process alive. A runtime with no such notion does nothing here.
   */
  unref(): void;
}

/** The only clock the session reads. Timeouts and backoff are delays on it, not on the host. */
export interface Clock {
  setTimeout(callback: () => void, delayMs: number): Timer;
}

/**
 * The debugger, as far as the session is concerned: a process that prints
 * "Wine-dbg>" prompts on stdout and stderr, reads commands on stdin, can end
 * without an exit code, and can be signalled as a process group.
 */
export interface DebuggerChild {
  /** Undefined when the process never started. */
  readonly pid: number | undefined;
  /** Null when the debugger was started without a command pipe. */
  readonly stdin: { write(text: string): void } | null;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  /** Signal the debugger and everything it started. */
  killTree(signal: NodeJS.Signals): void;
}

/**
 * Everything the session reaches the outside world through. Production uses
 * {@link nodeRuntime}; a simulator supplies a virtual clock and an in-memory
 * debugger, which is what makes a run reproducible from a seed alone.
 */
export type SessionRuntime = {
  readonly clock: Clock;
  spawn(binary: string, args: string[]): DebuggerChild;
};

class NodeTimer implements Timer {
  constructor(private readonly handle: NodeJS.Timeout) {}
  cancel(): void {
    clearTimeout(this.handle);
  }
  unref(): void {
    this.handle.unref();
  }
}

class NodeDebuggerChild implements DebuggerChild {
  readonly stdin: { write(text: string): void } | null;
  private readonly dataListeners: ((chunk: string) => void)[] = [];
  private readonly closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  constructor(private readonly child: ChildProcess) {
    // A command written to a pipe the debugger has already closed comes back as
    // an EPIPE 'error' on the stream, and an unhandled one takes this process
    // down with it. The session already reports the failure to whoever is
    // waiting on a command, so the stream's own error carries nothing new.
    child.stdin?.on("error", () => {});

    this.stdin = child.stdin;
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      // A pipe the debugger held open can still break under it, and a read error
      // arrives as an 'error' on the stream. Nothing listens for one, and node
      // turns that into an uncaught exception: the server dies mid-session with
      // a debugger and its debuggee still running and nobody left to signal
      // them. The session settles whatever it is waiting on with the reason,
      // which is the same path a process 'error' takes.
      stream.on("error", (error) => {
        for (const listener of this.errorListeners) listener(error);
      });
      // A pipe read ends wherever the writer's next write begins, which can be
      // in the middle of a multi-byte character. Decoding each chunk on its own
      // turns every such character into U+FFFD, so the decoder carries the
      // partial sequence across reads instead.
      const decoder = new StringDecoder("utf8");
      stream.on("data", (data: Buffer) => {
        const chunk = decoder.write(data);
        if (chunk.length > 0) {
          for (const listener of this.dataListeners) listener(chunk);
        }
      });
      // Whatever the last read held of an unfinished character is still text the
      // debugger wrote, and the close event is the last chance to hand it over.
      stream.on("end", () => {
        const tail = decoder.end();
        if (tail.length > 0) {
          for (const listener of this.dataListeners) listener(tail);
        }
      });
    }
    child.on("close", (code, signal) => {
      for (const listener of this.closeListeners) listener(code, signal);
    });
    child.on("error", (error) => {
      for (const listener of this.errorListeners) listener(error);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  killTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) {
      this.child.kill(signal);
      return;
    }
    try {
      // Negative pid is the process group the detached child leads.
      process.kill(-pid, signal);
    } catch {
      // No such group: fall back to the debugger itself.
      this.child.kill(signal);
    }
  }
}

/** Spawn a real winedbg and keep real time. */
export function nodeRuntime(): SessionRuntime {
  return {
    clock: {
      setTimeout: (callback, delayMs) => new NodeTimer(setTimeout(callback, delayMs)),
    },
    spawn: (binary, args) =>
      new NodeDebuggerChild(
        spawn(binary, args, {
          stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so killTree() can reach the debuggee winedbg
          // started. Signalling winedbg alone leaves the debuggee running.
          detached: true,
        })
      ),
  };
}

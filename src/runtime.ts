import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CONFIG_VAR_PREFIX } from "./constants.js";

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

/**
 * The only clock the session reads. Timeouts and backoff are delays on it, not
 * on the host, and the session reads the time off it too: a log line carrying a
 * measured duration is as much a result of the run as the reply it times.
 */
export interface Clock {
  setTimeout(callback: () => void, delayMs: number): Timer;
  /** Milliseconds on this clock, the only time source in the session. */
  now(): number;
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
  /**
   * Drop this side of the command pipes. A process keeps its end open until it
   * exits, and this process holds a descriptor for each until then, so a
   * debugger that has been signalled and outlives the signal keeps three
   * descriptors alive for as long as the server runs.
   */
  closePipes(): void;
}

/**
 * Everything the session reaches the outside world through. Production uses
 * {@link nodeRuntime}; a simulator supplies a virtual clock and an in-memory
 * debugger, which is what makes a run reproducible from a seed alone.
 */
export type SessionRuntime = {
  readonly clock: Clock;
  spawn(binary: string, args: string[]): DebuggerChild;
  /**
   * Whether the process group led by `pid` is still there. A signal-0 probe in
   * the session's own code would make every simulated run read the host process
   * table, so the probe is the runtime's to make and a simulator's to answer.
   */
  groupAlive(pid: number): boolean;
};

/**
 * The launcher's variables a debugger, a wineprefix and the program under
 * debug need in order to run at all. Everything else stays here.
 *
 * The environment an MCP client launches the server with is the agent's own:
 * API keys, registry tokens and cloud credentials all sit in it. The child
 * inherits it, and winedbg hands it to the program under debug, which is
 * whoever supplied the target. A target that prints its environment returns
 * those credentials on the same pipe as its ordinary output, framed as a
 * debugger reply and handed to the model. An allowlist is the only control
 * that survives that, and it has to cover a debugger's real needs, so it lists
 * what Wine and a Unix program under it read rather than everything.
 */
const FORWARDED_ENV_NAMES: ReadonlySet<string> = new Set([
  // Where the executable is found, and where scratch files go.
  "PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  // The account and the home a wineprefix defaults to. The child runs as this
  // user either way, so withholding them buys no confidentiality and costs a
  // default wineprefix location.
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "SHLVL",
  "OSTYPE",
  "HOSTNAME",
  // Where the display to debug lives.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_SESSION_TYPE",
  // Locale, which decides how a program's output is encoded and framed.
  "LANG",
  "LANGUAGE",
  "TZ",
  // What a Windows program under Wine reads for the host's equivalents.
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/**
 * Families a variable belongs to rather than a fixed name: Wine's own
 * (WINEPREFIX, WINEDEBUG, WINEDLLOVERRIDES, ...), the locale's (LC_ALL, ...),
 * the toolkit and driver settings a graphical program reads, and nothing else.
 * A family is a widening on purpose, so each one is a name space whose members
 * a Wine deployment chooses and not a credential prefix.
 */
const FORWARDED_ENV_PREFIXES: readonly string[] = [
  "WINE",
  "XDG_",
  "LC_",
  "SDL_",
  "MESA_",
  "LIBGL_",
  "__GL_",
  "GALLIUM_",
  "DXVK_",
  "VKD3D_",
  "RADV_",
  "GAMESCOPE_",
  "DRI_",
  "QT_",
  "GTK_",
  "GDK_",
  "GIO_",
];

/**
 * The environment the debugger is started with: the variables above, plus the
 * ones a deployment named in `WINEDBG_MCP_PASSTHROUGH_ENV`, and nothing else.
 * PATH is not optional, since it is what resolves a bare binary name, and a
 * child with no environment at all fails in a way that reads like a broken
 * wineprefix rather than a withheld variable.
 */
export function childEnv(env: NodeJS.ProcessEnv, passthrough: readonly string[] = []): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // This server's own variables sit under the WINE* family as far as the
    // prefix list is concerned, and none of them is anything winedbg reads.
    if (name.startsWith(CONFIG_VAR_PREFIX)) continue;
    if (FORWARDED_ENV_NAMES.has(name) || FORWARDED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      forwarded[name] = value;
    }
  }
  for (const name of passthrough) {
    const value = env[name];
    if (value !== undefined) forwarded[name] = value;
  }
  return forwarded;
}

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
    // down with it. Handling it by dropping it left the command waiting out its
    // full timeout and reported as a timeout, with the cause that ended the pipe
    // discarded, so it goes to the session like every other process failure.
    // The name is prefixed because a bare "write EPIPE" names neither the pipe
    // nor the command it belongs to.
    child.stdin?.on("error", (error) => {
      this.emitError(new Error(`winedbg command pipe: ${error.message}`, { cause: error }));
    });

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
        this.emitError(new Error(`winedbg output pipe: ${error.message}`, { cause: error }));
      });
      // A read boundary is a byte boundary, not a character one, and where it
      // falls is the pipe's business: a debuggee writing a character at a time
      // hands the reader half of it. One decoder per stream holds the trailing
      // bytes back until the rest arrives; decoding each read on its own turns
      // every split character into U+FFFD.
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
      this.emitError(error);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** One error channel for the process and all three of its pipes. */
  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
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

  closePipes(): void {
    // Destroying the streams closes this end of each pipe, and the child still
    // exits normally afterwards: the 'close' event waits on the process and on
    // the pipes, and only the pipes are already done.
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }
}

/** Spawn a real winedbg and keep real time. */
export function nodeRuntime(env: NodeJS.ProcessEnv = process.env, passthrough: readonly string[] = []): SessionRuntime {
  return {
    clock: {
      setTimeout: (callback, delayMs) => new NodeTimer(setTimeout(callback, delayMs)),
      now: () => Date.now(),
    },
    spawn: (binary, args) =>
      new NodeDebuggerChild(
        spawn(binary, args, {
          stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so killTree() can reach the debuggee winedbg
          // started. Signalling winedbg alone leaves the debuggee running.
          detached: true,
          // Not the launcher's environment: the child gets what a debugger and
          // the program under it need, not every credential the MCP client
          // started this server with.
          env: childEnv(env, passthrough),
        }),
      ),
    groupAlive: (pid) => {
      try {
        // Signal 0 reaches no process and reports whether the group is still
        // there. ESRCH is the answer that says it is not.
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

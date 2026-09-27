// Goal: drive the WinedbgSession state machine from a seed alone, with no OS
// process and no wall clock, and check an invariant after every simulated step.
//
// Method: a virtual clock and an in-memory fake behind the SessionRuntime
// port in src/runtime.ts. The seed picks every reply delay, chunking pattern,
// crash, and kill outcome, so one seed fully determines the run: the same seed
// replays the same transcript byte for byte, which the second test pins. A
// failing run prints its seed, and WINEDBG_MCP_SIM_SEED replays just that one.
//
// The model this checks: a reply belongs to the command that asked for it and
// to nobody else. Every command either gets its own output, is refused, or is
// abandoned, and an abandoned command's late prompt is drained before the next
// command is accepted. The real-process tests in session.test.ts cover the same
// state machine against an actual child, where timing is whatever the host does.

import { afterEach, describe, expect, test } from "bun:test";
import { WinedbgSession } from "../src/session.js";
import type { Clock, DebuggerChild, Timer } from "../src/runtime.js";

const PROMPT = "Wine-dbg>";
const REPLY_PREFIX = "ran: ";
const READY_TIMEOUT_MS = 50;
const COMMAND_TIMEOUT_MS = 30;
const COMMANDS_PER_RUN = 6;
// Virtual time per settle step, and a bound on how many steps one command may
// take. A step is where every invariant is rechecked.
const STEP_MS = 5;
const MAX_STEPS = 60;
const CHUNK_INTERVAL_MS = 1;
// A signalled process still has to be scheduled and torn down.
const SIGNAL_TO_EXIT_MS = 1;
// Enough to fire the SIGKILL escalation a cooperative fake never needed.
const AFTER_STOP_MS = 2500;
const SEEDS_PER_SWEEP = 16;

class VirtualTimer implements Timer {
  cancelled = false;

  constructor(
    readonly at: number,
    readonly seq: number,
    private readonly run: () => void
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  unref(): void {}

  fire(): void {
    this.run();
  }
}

class VirtualClock implements Clock {
  private timers: VirtualTimer[] = [];
  private seq = 0;
  now = 0;

  setTimeout(callback: () => void, delayMs: number): Timer {
    const timer = new VirtualTimer(this.now + Math.max(0, delayMs), this.seq++, callback);
    this.timers.push(timer);
    return timer;
  }

  /**
   * Move time forward by ms, running every callback that comes due, earliest
   * first and in scheduling order on a tie. Nothing here observes the host
   * clock, so the order is the same on every machine and every run.
   */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = due[0];
      if (next === undefined) break;
      this.timers.splice(this.timers.indexOf(next), 1);
      this.now = Math.max(this.now, next.at);
      next.fire();
    }
    this.now = target;
  }
}

type Behavior =
  | { kind: "reply"; delayMs: number; pieces: number }
  | { kind: "silent" }
  | { kind: "crash"; code: number; delayMs: number }
  | { kind: "selfkill"; delayMs: number }
  | { kind: "stop-reading"; delayMs: number };

/**
 * A fake in memory. It speaks the same prompt protocol as winedbg and
 * nothing else: no process, no pipe, no timing of its own.
 */
class SimulatedDebugger implements DebuggerChild {
  readonly pid = 4242;
  readonly stdin = { write: (text: string) => this.accept(text) };
  /** Commands whose prompt has been written out in full, owed or not. */
  readonly answered = new Set<string>();
  /** Commands with a reply still to come: the prompt is owed and will arrive. */
  readonly owed = new Set<string>();
  readonly signals: string[] = [];
  /** Callbacks scheduled and not yet run: how much is left to simulate. */
  pending = 0;
  private line = "";
  private closed = false;

  constructor(
    private readonly clock: VirtualClock,
    private readonly rng: () => number,
    promptDelayMs: number
  ) {
    this.trapped = rng() < 0.5;
    this.clock.setTimeout(() => this.emit(`\n${PROMPT}`), promptDelayMs);
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListeners.push(listener);
  }

  onError(_listener: (error: Error) => void): void {}

  killTree(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    // A fake stopped inside a trap handler does not answer SIGTERM, which
    // is what the escalation to SIGKILL is for. Dying takes a turn of virtual
    // time, as it does for a real process: close never arrives inside the
    // killTree call that caused it.
    if (this.closed || (signal === "SIGTERM" && this.trapped)) return;
    this.later(SIGNAL_TO_EXIT_MS, () => this.end(null, signal));
  }

  private readonly dataListeners: ((chunk: string) => void)[] = [];
  private readonly closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private stopReading = false;
  /** Seeded: this fake is the kind that has to be killed outright. */
  private readonly trapped: boolean;

  /** The debugger is gone: nothing more can be written to it or read from it. */
  get ended(): boolean {
    return this.closed;
  }

  /** Alive, with nothing scheduled: the session can never get its prompt back. */
  get silent(): boolean {
    return !this.closed && this.pending === 0;
  }

  /** Whether SIGTERM left it alive, and the grace period had to escalate. */
  get needsKilling(): boolean {
    return this.trapped;
  }

  private accept(text: string): void {
    if (this.closed) return;
    if (this.stopReading) throw new Error("EPIPE: the fake stopped reading commands");
    this.line += text;
    for (let nl = this.line.indexOf("\n"); nl !== -1; nl = this.line.indexOf("\n")) {
      const command = this.line.slice(0, nl).trim();
      this.line = this.line.slice(nl + 1);
      this.behave(command);
    }
  }

  private behave(command: string): void {
    const roll = this.rng();
    const delayMs = Math.floor(this.rng() * 3 * COMMAND_TIMEOUT_MS);
    let behavior: Behavior;
    if (roll < 0.55) {
      behavior = { kind: "reply", delayMs, pieces: 1 + Math.floor(this.rng() * 3) };
    } else if (roll < 0.7) {
      behavior = { kind: "silent" };
    } else if (roll < 0.8) {
      behavior = { kind: "crash", code: 3, delayMs };
    } else if (roll < 0.9) {
      behavior = { kind: "selfkill", delayMs };
    } else {
      behavior = { kind: "stop-reading", delayMs };
    }

    switch (behavior.kind) {
      case "silent":
        return;
      case "crash":
        this.later(delayMs, () => this.end(behavior.code, null));
        return;
      case "selfkill":
        this.later(delayMs, () => this.end(null, "SIGKILL"));
        return;
      case "stop-reading":
        this.stopReading = true;
        this.later(delayMs, () => this.reply(command, 1));
        return;
      case "reply":
        this.later(delayMs, () => this.reply(command, behavior.pieces));
    }
  }

  private later(delayMs: number, action: () => void): void {
    this.pending++;
    this.clock.setTimeout(() => {
      this.pending--;
      action();
    }, delayMs);
  }

  private reply(command: string, pieces: number): void {
    this.owed.add(command);
    const text = `${REPLY_PREFIX}${command}\n${PROMPT}`;
    if (pieces <= 1) {
      this.deliver(command, [text]);
      return;
    }
    const size = Math.ceil(text.length / pieces);
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += size) {
      chunks.push(text.slice(offset, offset + size));
    }
    chunks.forEach((chunk, index) => this.later(index * CHUNK_INTERVAL_MS, () => this.emit(chunk)));
    this.later(chunks.length * CHUNK_INTERVAL_MS, () => this.settlePrompt(command));
  }

  private deliver(command: string, chunks: string[]): void {
    for (const chunk of chunks) this.emit(chunk);
    this.settlePrompt(command);
  }

  private settlePrompt(command: string): void {
    this.answered.add(command);
    this.owed.delete(command);
  }

  private emit(chunk: string): void {
    if (this.closed) return;
    for (const listener of this.dataListeners) listener(chunk);
  }

  private end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(code, signal);
  }
}

/** mulberry32: small, and a fixed seed always yields the same stream. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Outcome = { ok: true; value: string } | { ok: false; error: string };

/**
 * Run one command to completion against virtual time: fire callbacks a step at
 * a time, rechecking the caller after each step, and stop as soon as it settles.
 */
async function settle(clock: VirtualClock, pending: Promise<string>): Promise<Outcome> {
  const box: { outcome: Outcome | null } = { outcome: null };
  const tracked = pending.then(
    (value) => {
      box.outcome = { ok: true, value };
    },
    (error: unknown) => {
      box.outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  );

  for (let step = 0; step < MAX_STEPS && box.outcome === null; step++) {
    clock.advance(STEP_MS);
    // Only the event loop is real here: this drains the promise callbacks a
    // fired timer settled. No host time passes and nothing waits on a pipe.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await tracked;
  if (box.outcome === null) throw new Error(`command did not settle in ${MAX_STEPS} virtual steps`);
  return box.outcome;
}

/** A command sent while the debugger still owes a prompt has to be refused. */
async function expectRefused(
  clock: VirtualClock,
  session: WinedbgSession,
  label: string,
  fail: (message: string) => never,
  transcript: string[]
): Promise<void> {
  const outcome = await settle(clock, session.executeCommand(label, COMMAND_TIMEOUT_MS));
  checkOutcome(outcome, label, fail);
  if (outcome.ok || !/has not returned to its prompt/.test(outcome.error)) {
    fail(`the probe ${label} was not refused: ${JSON.stringify(outcome)}`);
  }
  transcript.push(`${label} -> refused`);
}

/** Let every scheduled fake callback run, so owed prompts actually land. */
async function drain(clock: VirtualClock, fake: SimulatedDebugger): Promise<void> {
  for (let step = 0; step < MAX_STEPS && fake.pending > 0; step++) {
    clock.advance(STEP_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function checkOutcome(outcome: Outcome, context: string, fail: (message: string) => never): void {
  const text = outcome.ok ? outcome.value : outcome.error;
  // A prompt is a boundary, never output, whichever side of it the text came.
  if (text.includes(PROMPT)) fail(`${context}: prompt leaked into a result: ${JSON.stringify(text)}`);
}

/**
 * One simulated session. Returns the transcript, which the caller compares
 * across runs: identical transcript for identical seed is the whole point.
 */
async function runScenario(seed: number): Promise<{ transcript: string[]; signals: string[] }> {
  const rng = mulberry32(seed);
  const clock = new VirtualClock();
  // A cold wineprefix is slow, and slower than the wait is a start that gives up.
  const promptDelayMs = Math.floor(rng() * 2 * READY_TIMEOUT_MS);
  const fake = new SimulatedDebugger(clock, rng, promptDelayMs);
  const session = new WinedbgSession("winedbg", READY_TIMEOUT_MS, {
    clock,
    spawn: () => fake,
  });
  const transcript: string[] = [];
  const fail = (message: string): never => {
    throw new Error(`seed ${seed}: ${message}\n  transcript: ${transcript.join(" | ")}`);
  };

  try {
    const ready = await settle(clock, session.start().then(() => ""));
    transcript.push(`start -> ${ready.ok ? "ready" : ready.error}`);
    if (!ready.ok) {
      // A fake that never prompted is not a session, whatever the reason,
      // and a prompt that arrives late is the only reason to give up here.
      if (session.isRunning()) fail("start failed but the session still reports running");
      if (promptDelayMs < READY_TIMEOUT_MS) {
        fail(`start gave up after ${ready.error} but the prompt was only ${promptDelayMs}ms away`);
      }
      return { transcript, signals: fake.signals };
    }

    for (let i = 0; i < COMMANDS_PER_RUN; i++) {
      if (fake.ended) {
        // The debugger ended, so the session goes with it and every later
        // command is refused as not running.
        if (session.isRunning()) fail("the debugger ended but the session still reports running");
        const after = await settle(clock, session.executeCommand(`after${i}`, COMMAND_TIMEOUT_MS));
        if (after.ok || !/not running/.test(after.error)) {
          fail(`a command after the debugger ended was not refused: ${JSON.stringify(after)}`);
        }
        transcript.push(`after${i} -> refused`);
        break;
      }

      const command = `cmd${i}`;
      const outcome = await settle(clock, session.executeCommand(command, COMMAND_TIMEOUT_MS));
      checkOutcome(outcome, command, fail);
      transcript.push(`${command} -> ${outcome.ok ? JSON.stringify(outcome.value) : outcome.error}`);

      if (outcome.ok) {
        // The reply the caller received is the one it asked for, whole.
        if (outcome.value !== `${REPLY_PREFIX}${command}`) {
          fail(`${command} received ${JSON.stringify(outcome.value)}`);
        }
      }

      if (fake.ended) {
        // A debugger that died mid-command ends the session with it.
        if (session.isRunning()) fail(`the debugger ended during ${command} but the session is running`);
        if (outcome.ok || !/exited with code|killed by|EPIPE/.test(outcome.error)) {
          fail(`${command} reported ${JSON.stringify(outcome)} instead of the debugger ending`);
        }
        break;
      }

      if (!outcome.ok && /timed out/.test(outcome.error) && !fake.answered.has(command)) {
        // The fake still owes that prompt, so the next command must be refused
        // rather than handed output it did not produce.
        await expectRefused(clock, session, `${command}-probe`, fail, transcript);
        if (fake.owed.has(command)) {
          await drain(clock, fake);
          if (!fake.answered.has(command)) fail(`the prompt owed by ${command} never arrived`);
          if (!session.isRunning()) fail(`the fake ended while draining the prompt owed by ${command}`);
        } else if (fake.silent) {
          // A debugger that is never coming back keeps the session refusing
          // every command, until stop() ends it.
          await expectRefused(clock, session, `${command}-probe2`, fail, transcript);
        } else {
          // It had something else scheduled, a crash or a kill, and that ends
          // the session rather than answering.
          await drain(clock, fake);
        }
      }
    }

    const aliveAtStop = !fake.ended;
    session.stop();
    if (session.isRunning()) fail("stop() left the session running");
    // The grace period is virtual too, so the escalation can be watched: a
    // fake that answers SIGTERM never needs the SIGKILL, and one stuck in a
    // trap handler gets it.
    clock.advance(AFTER_STOP_MS);
    if (!aliveAtStop) {
      // The debugger was already gone, so there was nothing left to signal.
      if (fake.signals.length > 0) fail(`stop() signalled a debugger that had ended: ${JSON.stringify(fake.signals)}`);
    } else {
      if (fake.signals[0] !== "SIGTERM") fail(`stop() sent ${JSON.stringify(fake.signals)}`);
      if ((fake.signals.length > 1) !== fake.needsKilling) {
        fail(`stop() sent ${JSON.stringify(fake.signals)} for a fake that answers or does not`);
      }
    }
    return { transcript, signals: fake.signals };
  } finally {
    session.stop();
  }
}

const SEEDS: number[] = Array.from({ length: SEEDS_PER_SWEEP }, (_, index) => 1 + index * 1013);

describe("session simulation", () => {
  afterEach(() => {
    delete process.env.WINEDBG_MCP_SIM_SEED;
  });

  test("holds its invariants across a sweep of seeds", async () => {
    const only = process.env.WINEDBG_MCP_SIM_SEED;
    const seeds = only === undefined ? SEEDS : [Number(only)];
    const run: string[] = [];
    for (const seed of seeds) {
      const { transcript } = await runScenario(seed);
      run.push(`seed ${seed}: ${transcript.join(" | ")}`);
    }
    expect(run).toHaveLength(seeds.length);

    // The sweep is only worth running if it reaches the interesting states.
    // A seed list that quietly stopped covering them is worse than no sweep.
    const covered = run.join("\n");
    expect(covered).toContain("Timeout waiting");
    expect(covered).toMatch(/exited with code|killed by/);
    expect(covered).toContain("-> refused");
    expect(covered).toMatch(/-> "ran: /);
  });

  test("replays a seed byte for byte", async () => {
    for (const seed of SEEDS) {
      const first = await runScenario(seed);
      const second = await runScenario(seed);
      expect(second.transcript).toEqual(first.transcript);
      expect(second.signals).toEqual(first.signals);
    }
  });
});

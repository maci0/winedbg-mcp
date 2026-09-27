#!/usr/bin/env node
// Stand-in for winedbg: same prompt protocol, deterministic replies, no Wine.
// Commands: quit (exit 0), crash (exit 3), selfkill (SIGKILL, no exit code),
// hang (never prompts again), pid (the debuggee pid), "sleep:<ms>" (replies after
// <ms>), warn (writes to stderr), silent (prompt only), close-stdin (stops
// reading commands), "noise:<n>" (a reply of n characters), "dribble:<n>" (the
// same, in pieces small enough to arrive one read at a time), "split:<n>" (n
// multi-byte characters, the last one cut across two writes), anything else
// echoes back.
// Invoked with "die" as argv[2] it exits before printing a prompt; with "mute"
// it stays alive and never prints one, so the caller hits its start timeout;
// with "grandchild" it starts a debuggee of its own, which is what a real
// winedbg does for the program it is launched with.

import { spawn } from "node:child_process";

if (process.argv[2] === "die") process.exit(2);

if (process.argv[2] !== "mute") process.stdout.write("Wine-dbg>");

// Same process group as this process, and it survives this one exiting unless
// the whole group is signalled.
const debuggee =
  process.argv[2] === "grandchild"
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    : null;

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk.toString();
  let nl = pending.indexOf("\n");
  while (nl !== -1) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    handle(line);
    nl = pending.indexOf("\n");
  }
});

function reply(line) {
  process.stdout.write(`ran: ${line}\nWine-dbg>`);
}

function handle(line) {
  if (line.startsWith("noise:")) {
    // A reply far larger than anything the session is willing to buffer.
    process.stdout.write("n".repeat(Number(line.slice("noise:".length))));
    process.stdout.write("Wine-dbg>");
    return;
  }
  if (line.startsWith("dribble:")) {
    // Output in small pieces, each arriving as its own read, the way a chatty
    // debuggee prints while a command is in flight.
    let remaining = Number(line.slice("dribble:".length));
    const piece = 8192;
    const writeNext = () => {
      if (remaining <= 0) {
        process.stdout.write("Wine-dbg>");
        return;
      }
      const n = Math.min(piece, remaining);
      remaining -= n;
      process.stdout.write("d".repeat(n));
      setTimeout(writeNext, 1);
    };
    writeNext();
    return;
  }
  if (line.startsWith("split:")) {
    // A character whose bytes straddle two writes, so the reader is handed the
    // first half of it on its own: what its decoder has to carry over.
    const bytes = Buffer.from("€".repeat(Number(line.slice("split:".length))), "utf8");
    const half = bytes.length - 1;
    process.stdout.write(bytes.subarray(0, half));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(half));
      process.stdout.write("Wine-dbg>");
    }, 20);
    return;
  }
  if (line.startsWith("sleep:")) {
    // A reply that arrives long after the caller gave up is how a real debugger
    // desynchronises the stream: the output belongs to a command nobody awaits.
    setTimeout(() => reply(line), Number(line.slice("sleep:".length)));
    return;
  }
  switch (line) {
    case "quit":
      return process.exit(0);
    case "crash":
      return process.exit(3);
    case "selfkill":
      // Ends without an exit code, the way a debugger killed from outside does.
      process.kill(process.pid, "SIGKILL");
      break;
    case "hang":
      return;
    case "close-stdin":
      // A debugger that stops reading its commands: the next write hits EPIPE.
      process.stdin.destroy();
      // Otherwise the fake exits on the closed stdin, and the caller never gets
      // to write to it.
      setInterval(() => {}, 1000);
      break;
    case "pid":
      process.stdout.write(debuggee ? String(debuggee.pid) : "0");
      break;
    case "warn":
      process.stderr.write("stderr line\n");
      break;
    case "silent":
      break;
    default:
      process.stdout.write(`ran: ${line}\n`);
  }
  process.stdout.write("Wine-dbg>");
}

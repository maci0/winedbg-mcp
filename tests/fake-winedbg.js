#!/usr/bin/env node
// Stand-in for winedbg: same prompt protocol, deterministic replies, no Wine.
// Commands: quit (exit 0), crash (exit 3), selfkill (SIGKILL, no exit code),
// hang (never prompts again), pid (the debuggee pid), selfpid (its own pid),
// "sleep:<ms>" (replies after <ms>), warn (writes to stderr), silent (prompt
// only), close-stdin (stops
// reading commands), "noise:<n>" (a reply of n characters), "dribble:<n>" (the
// same, in pieces small enough to arrive one read at a time), utf8 (a non-ASCII
// reply written one byte at a time, so every character spans two reads),
// "utf8:<text>" (that text in UTF-8, one byte per write), "astral:<n>" (n emoji,
// two UTF-16 units each), "split:<n>" (n multi-byte characters, the last one cut
// across two writes), anything else echoes back.
// Invoked with "die" as argv[2] it exits before printing a prompt; with "mute"
// it stays alive and never prints one, so the caller hits its start timeout;
// with "grandchild" it starts a debuggee of its own, which is what a real
// winedbg does for the program it is launched with; with "stubborn" it does the
// same and ignores SIGTERM, the way a debugger stopped inside a trap handler
// does, so only the kill escalation ends it.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

if (process.argv[2] === "die") process.exit(2);

if (process.argv[2] === "stubborn") process.on("SIGTERM", () => {});

if (process.argv[2] !== "mute") process.stdout.write("Wine-dbg>");

// Same process group as this process, and it survives this one exiting unless
// the whole group is signalled.
const debuggee =
  process.argv[2] === "grandchild" || process.argv[2] === "stubborn"
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    : null;

// A command is one write from the caller, but a long one can still be split
// across reads, and decoding a chunk in isolation turns the tail of a
// multi-byte character into U+FFFD.
const decoder = new StringDecoder("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += decoder.write(chunk);
  let nl;
  while ((nl = pending.indexOf("\n")) !== -1) {
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
  if (line.startsWith("astral:")) {
    // Enough characters from outside the BMP to push a reader past a cap measured
    // in UTF-16 code units, so the cut it takes has to be rounded to a character
    // boundary. A reply of nothing but emoji always has an even accumulated
    // length, and every even cut lands on the high half of a pair, so the
    // one-unit "|" between pieces flips the parity and puts some cuts on a low
    // half, which is the case that orphans a surrogate.
    let remaining = Number(line.slice("astral:".length));
    const piece = 4096;
    let written = 0;
    const writeNext = () => {
      if (remaining <= 0) {
        process.stdout.write("Wine-dbg>");
        return;
      }
      const n = Math.min(piece, remaining);
      remaining -= n;
      if (written++ % 2 === 1) process.stdout.write("|");
      process.stdout.write("\u{1F600}".repeat(n));
      setTimeout(writeNext, 1);
    };
    writeNext();
    return;
  }
  if (line.startsWith("utf8:")) {
    // The reply's bytes go out one at a time, so every multi-byte character
    // reaches the reader split across two reads, the way a chatty pipe splits
    // them. A reader that decodes each read on its own returns U+FFFD.
    const text = Buffer.from(`utf8 reply: ${line.slice("utf8:".length)}`, "utf8");
    let i = 0;
    const writeByte = () => {
      if (i >= text.length) {
        process.stdout.write("Wine-dbg>");
        return;
      }
      process.stdout.write(text.subarray(i, i + 1));
      i++;
      setTimeout(writeByte, 1);
    };
    writeByte();
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
  if (line === "utf8") {
    // One byte per write, spaced far enough apart that each lands in its own
    // pipe read. Every multi-byte character is then split across two reads,
    // which is what a debuggee printing non-ASCII in small bursts does.
    const bytes = Buffer.from("ran: ünïcode ✓\n", "utf8");
    let sent = 0;
    const writeByte = () => {
      if (sent >= bytes.length) {
        process.stdout.write("Wine-dbg>");
        return;
      }
      process.stdout.write(Buffer.from([bytes[sent++]]));
      setTimeout(writeByte, 3);
    };
    writeByte();
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
    case "selfpid":
      process.stdout.write(String(process.pid));
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

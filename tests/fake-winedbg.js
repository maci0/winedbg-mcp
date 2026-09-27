#!/usr/bin/env node
// Stand-in for winedbg: same prompt protocol, deterministic replies, no Wine.
// Commands: quit (exit 0), crash (exit 3), hang (never prompts again),
// "sleep:<ms>" (replies after <ms>), warn (writes to stderr), silent (prompt
// only), "noise:<n>" (a reply of n characters), "raw:<hex>" (arbitrary bytes,
// so a fuzzed payload can carry a prompt of its own), anything else echoes back.
// Invoked with "die" as argv[2] it exits before printing a prompt; with "mute"
// it stays alive and never prints one, so the caller hits its start timeout.

if (process.argv[2] === "die") process.exit(2);

if (process.argv[2] !== "mute") process.stdout.write("Wine-dbg>");

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk.toString();
  let nl;
  while ((nl = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    handle(line);
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
  if (line.startsWith("raw:")) {
    // Arbitrary bytes as hex, then a prompt, in one write: what a debugger and
    // its debuggee can print, with no framing of the fixture's own choosing.
    // Payload bytes that look like a prompt are the interesting part, and one
    // write keeps the reply from being split across reads at the caller's end.
    process.stdout.write(Buffer.concat([Buffer.from(line.slice("raw:".length), "hex"), Buffer.from("Wine-dbg>")]));
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
      process.exit(0);
    case "crash":
      process.exit(3);
    case "hang":
      return;
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

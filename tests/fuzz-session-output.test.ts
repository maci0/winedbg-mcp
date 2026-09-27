// Goal: fuzz the frame that turns a debugger's output into a tool reply. The
// bytes on that pipe come from the debuggee, not from this project, and the
// framing is a fixed prompt substring: the buffer cap and the dropped-character
// count are where a crafted reply can lose text, carry a prompt into a
// backtrace, or hand the next command a reply nobody asked for.
//
// Method: one real child process (tests/fake-winedbg.js) answers each payload
// with the bytes the generator built, so the code under test does the same
// spawn, stream and decode work it does in production. Payloads are generated
// from a seeded PRNG plus fixed edge cases: empty, whitespace only, NUL bytes,
// lone prompt fragments, prompts at both ends, and the sizes around
// MAX_BUFFER_CHARS, where the cap starts dropping text. The expectations are
// contracts, not a reimplementation: the reply is the payload it was given, a
// payload with no prompt in it never comes back with one, and no payload
// steals text from the next command.

import { describe, expect, test } from "bun:test";
import { MAX_BUFFER_CHARS, WinedbgSession } from "../src/session.js";

const FAKE = new URL("fake-winedbg.js", import.meta.url).pathname;
const PROMPT = "Wine-dbg>";
const SEED = 0x5eed;
const RANDOM_PAYLOADS = 40;
const MAX_SMALL_PAYLOAD_BYTES = 2048;
const COMMAND_TIMEOUT_MS = 20000;

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The pieces a debuggee actually produces, plus the prompt itself so a payload
// can claim to be a reply boundary.
const CHUNKS = ["", " ", "\t", "\n", "\r", "\0", "bt", "0x00400000", "é", "𝕓", "break ", PROMPT, "W", "ine-dbg>"];

function randomPayload(random: () => number, maxBytes: number): Buffer {
  const pieces = Math.floor(random() * 12);
  let text = "";
  for (let i = 0; i < pieces; i++) text += CHUNKS[Math.floor(random() * CHUNKS.length)]!;
  const bytes = Buffer.from(text, "utf8");
  // Random raw bytes on top, including invalid UTF-8 the decoder has to survive.
  const noise = Math.floor(random() * maxBytes);
  const raw = Buffer.alloc(bytes.length + noise);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = random() < 0.5 && i < bytes.length ? bytes[i]! : Math.floor(random() * 256);
  }
  return raw;
}

function hexCommand(payload: Buffer): string {
  return `raw:${payload.toString("hex")}`;
}

type Payload = { label: string; payload: Buffer; expect?: (decoded: string) => string };

/** The reply a payload must produce: its own text, capped and trimmed, with the
 *  fixture's trailing prompt ending the reply rather than joining it. */
function wholeReply(decoded: string): string {
  // The prompt the fixture appends counts against the cap, so what survives the
  // trim is the tail of the payload, and the count is what fell off the front.
  const dropped = decoded.length + PROMPT.length - MAX_BUFFER_CHARS;
  if (dropped <= 0) return decoded.trim();
  return `[${dropped} characters of earlier output dropped: buffer limit]\n${decoded.slice(dropped).trim()}`;
}

// Sizes and shapes with an exact expected reply, including both sides of the
// cap, where the trim starts dropping the front of the output.
const SIZED_PAYLOADS: Payload[] = [
  { label: "empty", payload: Buffer.alloc(0), expect: wholeReply },
  { label: "whitespace only", payload: Buffer.from("  \n\t ", "utf8"), expect: wholeReply },
  { label: "one prompt", payload: Buffer.from(PROMPT, "utf8"), expect: wholeReply },
  { label: "prompt at both ends", payload: Buffer.from(`${PROMPT}middle${PROMPT}`, "utf8"), expect: wholeReply },
  { label: "just below the cap", payload: Buffer.alloc(MAX_BUFFER_CHARS - 1, 0x6e), expect: wholeReply },
  { label: "at the cap", payload: Buffer.alloc(MAX_BUFFER_CHARS, 0x6e), expect: wholeReply },
  { label: "one past the cap", payload: Buffer.alloc(MAX_BUFFER_CHARS + 1, 0x6e), expect: wholeReply },
  { label: "far past the cap", payload: Buffer.alloc(2 * MAX_BUFFER_CHARS, 0x6e), expect: wholeReply },
];

describe("session output framing fuzz", () => {
  test("a crafted reply is framed, capped and never handed to the next command", async () => {
    const session = new WinedbgSession(process.execPath);
    const failures: string[] = [];
    try {
      await session.start([FAKE]);

      const payloads: Payload[] = [...SIZED_PAYLOADS];
      const random = prng(SEED);
      for (let i = 0; i < RANDOM_PAYLOADS; i++) {
        payloads.push({ label: `random ${i}`, payload: randomPayload(random, MAX_SMALL_PAYLOAD_BYTES) });
      }

      for (const { label, payload, expect } of payloads) {
        const decoded = payload.toString("utf8");
        const out = await session.executeCommand(hexCommand(payload), COMMAND_TIMEOUT_MS);
        // A payload with no prompt in it can never come back with one.
        if (!decoded.includes(PROMPT) && out.includes(PROMPT)) {
          failures.push(`${label}: reply leaked a prompt: ${JSON.stringify(out.slice(0, 40))}`);
        }
        // The drop notice is the only reply text that was not in the payload.
        if (out.length > decoded.length + 64) {
          failures.push(`${label}: reply of ${out.length} chars for ${decoded.length} of payload`);
        }
        if (expect) {
          const expected = expect(decoded);
          if (out !== expected) {
            failures.push(
              `${label}: expected ${expected.length} chars ending ${JSON.stringify(expected.slice(-20))}, got ${out.length} chars ending ${JSON.stringify(out.slice(-20))}`
            );
          }
        }
        // Whatever the payload did, the next command still owns its own reply.
        const after = await session.executeCommand("bt", COMMAND_TIMEOUT_MS);
        if (after !== "ran: bt") failures.push(`${label}: next command got ${JSON.stringify(after)}`);
      }
    } finally {
      session.stop();
    }
    expect(failures).toEqual([]);
  }, 120000);
});

# winedbg-mcp

An MCP server for interacting with `winedbg` (the Wine debugger). It wraps the interactive debugger so an LLM can drive it through MCP tools.

## Status

The server is implemented and tested. `src/` holds the MCP entry point, the
winedbg session state machine, the environment parsing, the command-line
parsing and the tool-argument validation; `build/` is the compiled output of
`bun run build`; `tests/` covers all of those, and CI (`.github/workflows/ci.yml`)
runs the install, `bun run check` (Biome, both type-check passes and the
suite), the build and the artifact check. The session tests drive
`WinedbgSession`
against a stand-in that speaks the same `Wine-dbg>` prompt protocol, so the
suite needs no Wine. No test here has been run against a real `winedbg`: the
debugger is the one thing the fixtures replace, so the suite proves the prompt
protocol and the tool argument handling, not Wine itself. See
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) records the attack surface, the
trust boundaries and the mitigations, read off the source rather than off this
README.
[`CHANGELOG.md`](CHANGELOG.md) records what changed in each release.

Source layout, one concern per module:

| Path | Concern |
| --- | --- |
| `src/index.ts` | entrypoint: config load, transport, process lifecycle |
| `src/cli.ts` | the command line: `--help`, `--version`, argument errors |
| `src/tools.ts` | the MCP tool list and the call dispatch |
| `src/validate.ts` | validation of untyped tool arguments |
| `src/session.ts` | the winedbg child process and its prompt protocol |
| `src/runtime.ts` | the process and clock the session reaches the outside world through |
| `src/logger.ts` | the stderr log line format and the level filter |
| `src/config.ts` | reading and validating the environment |
| `src/constants.ts` | defaults and limits shared across the above |
| `src/version.ts` | the version reported to MCP clients, read from `package.json` |
| `scripts/verify-artifact.sh` | asserts the built entry point runs and ships nothing but compiled JavaScript |

## Prerequisites

- [Bun](https://bun.sh/), the package manager, build tool and test runner
- [Wine](https://www.winehq.org/), which includes `winedbg`

Supported platforms are Linux and macOS. `winedbg_stop` signals a process group
rather than a single process, so the debuggee `winedbg` launched is stopped with
it, and that needs POSIX process groups: neither the `detached` child group nor
the negative-pid `kill` exists on Windows, where the same call would leave the
program under debug running. CI runs on Linux only, so macOS is supported by the
code being POSIX and untested; say so if that changes.

Node.js 18 or higher is only needed if you run the built `build/index.js`
with `node` instead of `bun`.

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   bun install
   ```
3. Build the project:
   ```bash
   bun run build
   ```

The build writes `build/index.js`. To run the server straight from source
without a build step, use `bun run dev` (`bun run start` runs the built file).
The build clears `build/` first, so a module deleted from `src/` cannot linger
in the artifact, and the output is byte-identical wherever the checkout sits.

## Configuration

To use this with an MCP client (like Claude Desktop or Gemini), configure the MCP server to point to the built `index.js`.

```json
{
  "mcpServers": {
    "winedbg": {
      "command": "bun",
      "args": ["/path/to/winedbg-mcp/build/index.js"],
      "env": {
        "WINEDBG_MCP_BINARY": "/opt/wine-staging/bin/winedbg",
        "WINEDBG_MCP_READY_TIMEOUT_MS": "60000"
      }
    }
  }
}
```

### Environment variables

All three are optional and read once at startup. There are no secrets and no
config file: the environment is the only place to set these.

That says what this server reads, not what its process holds. `winedbg` is
started with the server's whole environment and working directory inherited, so
anything the launcher put in the environment is visible to `winedbg` and to
whatever program is being debugged. Keep credentials out of the environment a
debugging server is launched from. `docs/THREAT_MODEL.md` records this and the
rest of the attack surface.

| Variable | Default | Valid values |
| --- | --- | --- |
| `WINEDBG_MCP_BINARY` | `winedbg` (found on `PATH`) | A non-empty command name or path, with no NUL byte in it |
| `WINEDBG_MCP_READY_TIMEOUT_MS` | `10000` | Whole milliseconds, 1 to 600000. How long `winedbg_start` waits for the first prompt. Raise it for a cold wineprefix, which takes far longer than a warm one |
| `WINEDBG_MCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Below this level a line is never written |

A value the server cannot use stops it at startup with the variable named,
rather than failing later as a spawn error or a start timeout. That includes a
variable set to the empty string and a misspelled `WINEDBG_MCP_*` name, which
would otherwise be ignored while the deployment ran on defaults. The startup line
on stderr reports the values in effect:

```json
{"time":"2026-09-27T10:00:00.000Z","level":"info","message":"winedbg MCP server running on stdio","version":"1.0.0","config":"WINEDBG_MCP_BINARY=winedbg WINEDBG_MCP_READY_TIMEOUT_MS=10000 WINEDBG_MCP_LOG_LEVEL=info"}
```

### Logging

stdout carries JSON-RPC and nothing else, so every diagnostic goes to stderr as
one JSON object per line: an ISO-8601 `time`, a `level`, a fixed `message` and
flat named fields. A multiline `winedbg` reply therefore cannot break a line
parse, and a log aggregator can filter on a field instead of on a phrase.

The fields an operator pivots on:

| Field | Where | Answers |
| --- | --- | --- |
| `callId` | one tool call | ties the start, the outcome and the duration of a call together, e.g. `call-7` |
| `tool` | one tool call | which of the three tools ran |
| `durationMs` | tool call result | how long the call took, success or failure |
| `error` | a failure | why: the same text the client got back as the tool result |
| `readyMs`, `lifetimeMs`, `pid` | session start and exit | how long the debugger took to answer, and how it ended |
| `command`, `timeoutMs` | a command that timed out | which command, and the bound it hit |
| `droppedChars` | a reply past the 1M buffer limit | that the reply was shortened, and by how much |

A session that ends because the debugger died is logged at `error`; one that
ends because `winedbg_stop`, `SIGTERM` or the client hanging up asked for it is
logged at `info`, so a quiet log holds no shutdown noise. `debug` adds the
command text of each `winedbg_execute`. There are no metrics, traces or alerts
to configure: the server is one process per MCP client with nothing to scrape,
so the log is the whole surface.

## Tools Available

- **`winedbg_start`**: Start or attach to `winedbg`. Use this before running any commands. Optional `args` are passed to `winedbg` unchanged, so anything it accepts works: the program to launch (e.g. `{"args": ["myapp.exe"]}`) or a PID to attach to (`{"args": ["1234"]}`). `args` must be an array of strings; a bare string is rejected rather than split into one argument per character. At most 64 entries, each at most 4096 characters, none carrying a NUL: an argv entry is cut at the first NUL by the C runtime, and an unbounded array is a caller filling the process table rather than a debugging session.
- **`winedbg_execute`**: Execute one command in the active `winedbg` session (e.g., `{"command": "bt"}`).
  Takes an optional `timeout` in milliseconds (default 30000, minimum 1, maximum 600000). The command is at most 4096 characters and carries no line break or NUL, for the reason under command framing below.
- **`winedbg_stop`**: Stop the active `winedbg` session. A start that follows a stop waits for the stopped debugger to be gone, so alternating the two cannot leave one detached process group, each holding a debuggee, per cycle. A stop returns once the signal is sent, since a tool call should not be held open for a grace period; the wait happens where nothing is waiting on it, in the next `winedbg_start` and in the server's own exit on SIGINT, SIGTERM or the end of stdin.

### Audit log

Every tool call is recorded on stderr, which is the operator's log and not the
reply stream, since the program under debug writes to that stream and could
otherwise forge a record of what it did. A start logs its arguments, a command
that is sent logs the command at `debug`, a command that times out logs the
command and its timeout at `error`, a stop shows up as the session's exit, and a
failure logs the tool and the message.

Each line is a JSON object, so a control character in a command is escaped
rather than able to break the one-line parse, and a recorded field is at most as
long as the argument limits above (4096 characters). Nothing bounds how many
records a session writes, and no reply is logged, so the log is a record of what
was asked for and not of what came back.

### Command framing

`winedbg` has no way to label which output belongs to which command; the only
marker in the stream is the `Wine-dbg>` prompt. Two consequences are visible
through the tools:

- One command per `winedbg_execute` call. A command carrying a line terminator is
  rejected, because every one of them draws its own prompt and puts every later reply
  one command behind. The rejected set is `\n`, `\r`, vertical tab, form feed, NEL
  (U+0085), the Unicode line and paragraph separators (U+2028, U+2029), and NUL. A
  stream reader splits on `\n`, `\r` and vertical tab, and readers disagree on the
  rest, so a command is one line only if it is one line under every one of them.
  NUL is not a line break, but it truncates the line for most C readers, which
  desynchronises the reply stream the same way a second line would. The check
  runs both at the tool-argument boundary and in the session, so the rule holds
  for a caller that reaches the session directly.
- After a command times out, further commands are refused until the debugger
  prints its prompt again. A debugger that has not returned to its prompt is not
  reading commands, and whatever it prints next belongs to the command that timed
  out. If it never comes back (a `cont` into a program that does not stop), call
  `winedbg_stop` and start again.

A single reply is buffered up to 1M UTF-16 code units of decoded text, so a
BMP character costs one unit and an astral one costs two, whatever the target
prints. The child's output is decoded as UTF-8, and a byte sequence that is not
valid UTF-8 becomes U+FFFD rather than being passed through. A multi-byte
character split across two reads of the pipe decodes as the one character it
is, not as two replacement characters. Past the cap the oldest output is
dropped to keep the last three quarters, and the reply then opens with
`[N characters of earlier output dropped: buffer limit]`, counting code points
rather than the units the cap is measured in. The cut moves back off the low
half of a surrogate pair, so it never lands inside one and no reply starts
with an unpaired surrogate.

## Usage Example

1. Call `winedbg_start` with `{"args": ["myapp.exe"]}`.
2. Call `winedbg_execute` with `{"command": "break main"}`.
3. Call `winedbg_execute` with `{"command": "run"}`.
4. Call `winedbg_execute` with `{"command": "bt"}` to get a backtrace.
5. Call `winedbg_stop` when finished.

The debugger gets a process group of its own, and stopping signals the whole
group, so the program under debug does not outlive the debugger that owns it. A
`winedbg_stop` asks with `SIGTERM` and escalates to `SIGKILL` two seconds later.
When the server itself is exiting there is no time left to ask, so it signals
`SIGKILL` to the group outright rather than leave a debuggee behind.

## Command line

The server takes no positional arguments and no options other than the two
below. Everything else is the environment, and a flag does not exist to
override it, so a client configuration cannot pass a misspelled flag and have
the server start on the defaults anyway.

```
Usage: winedbg-mcp [OPTION]

Options:
  -h, --help       Print this help and exit
      --version    Print the version and exit
```

| Invocation | Stream | Exit |
| --- | --- | --- |
| `winedbg-mcp` | Serves JSON-RPC on stdin/stdout | 0 on SIGINT, SIGTERM, or end of stdin, after winedbg and the debuggee it started are waited for (up to 4s) |
| `winedbg-mcp --help` | Help on stdout | 0 |
| `winedbg-mcp --version` | The `package.json` version on stdout | 0 |
| `winedbg-mcp --anything-else` | The offending argument and a pointer to `--help`, on stderr | 2 |
| `winedbg-mcp` with an unusable environment value | The reason and the variable, on stderr | 1 |

stdout carries protocol traffic and nothing else, so `winedbg-mcp --help | less`
and `winedbg-mcp --version` both behave, and every diagnostic goes to stderr.
The command line is resolved before the environment, so `--help` and
`--version` still work in a deployment whose `WINEDBG_MCP_*` value the server
would otherwise refuse to start on.

## Tests

`bun run check` is the gate for this tree: Biome, then the two type-check
passes, then the suite. `bun run typecheck` and `bun test` are the pieces it
runs, for iterating on one of them at a time. CI runs the build as well, so a
tree that type-checks but does not emit is red there rather than at release.
The suite runs against `src/`; the compiled layout gets its own check, run by
CI after `bun run build`.

```bash
bun run check          # what CI runs
bun run lint           # Biome, formatting and lint rules
bun run format         # Biome autofix: formatting, imports and every safe rule fix
bun run typecheck      # tsc on src/, then on src/ + tests/
bun run build          # tsc, then the executable build/index.js
bun test
bun run build
scripts/verify-artifact.sh
```

The suite is one `bun test` over `tests/`, so the loop while editing is one file
or one test rather than the lot:

```bash
bun test tests/session.test.ts        # one file
bun test -t "rejects a NUL"           # every test whose name matches, in any file
```

`tests/session.test.ts` drives `WinedbgSession` against `tests/fake-winedbg.js`,
a stand-in that speaks the same `Wine-dbg>` prompt protocol, so the suite runs
without Wine installed. It spawns a real child process and drives its stdio, so
a failure is a real spawn, stream or lifecycle failure rather than a mock
disagreeing, and it waits on real time, which is what covers the parts a
simulator cannot: a pipe the debugger stops reading, a signal with no exit code,
a debuggee that outlives its debugger.

`tests/simulation.test.ts` covers the same state machine with no process and no
host clock. It supplies its own `SessionRuntime` (see `src/runtime.ts`): a
virtual clock and a debugger in memory. One seed chooses every reply delay,
chunking pattern, crash and kill outcome, so a run is reproducible and a failure
prints the seed that produced it:

```bash
WINEDBG_MCP_SIM_SEED=1014 bun test tests/simulation.test.ts
```

`tests/concurrency.test.ts` drives `callTool` the way the server does, with
several tool calls in flight at once on one session: starts racing each other,
two commands racing for the single command slot, a stop racing an in-flight
command, and a burst where every answer names the command that asked for it.
The server hands tool calls in from the event loop without serializing them, so
that is the case worth pinning.

`tests/validate.test.ts` covers the tool-argument boundary and
`tests/config.test.ts` the environment parsing described above.
`tests/cli.test.ts` spawns the entry point to pin the exit codes and which
stream each message lands on.

CI runs the same `bun run check` and `bun run build` on every push and pull
request, so a green local run is a green remote run. `bun run typecheck` covers
`src/` on its own, which is the set that ships as `build/`, and then re-checks it
together with `tests/` so a mistyped test helper fails the build rather than the
suite.

Formatting is Biome's, and the line width is 120 columns, the width the tree was
already written to. `src/index.ts` keeps one scoped `noConsole` suppression:
stdout carries the MCP JSON-RPC stream, so the configuration failure has to go to
stderr. Everything else it writes goes through the logger, which writes to
stderr by construction (`src/logger.ts:55-58`).

## Troubleshooting

Every tool failure comes back as `Error: <message>` with the message the code
produced, so the text names the state to fix:

| Message | Cause |
| --- | --- |
| `winedbg is not running. Please start it first.` | A command ran with no live session, including one whose `winedbg` exited |
| `winedbg is already running. Please stop it first.` | `winedbg_start` was called twice; call `winedbg_stop` first |
| `Another command is already in progress: ...` | One command per call, and the previous one has not answered yet. The message names that command and tells the caller to wait for its reply |
| `Configuration error: ...` on stderr at startup | An environment value the server cannot use, named in the message. The server exits with status 1 instead of starting on defaults |
| `Timeout waiting for <binary> to print its first prompt (Nms)` | No prompt within `WINEDBG_MCP_READY_TIMEOUT_MS`; the child is killed. Raise the variable for a cold wineprefix |
| `winedbg stopped before it was ready`, `winedbg was not started: a newer winedbg_start call replaced this one` | A start that was waiting for the previous debugger to be gone was cancelled, by `winedbg_stop` or by a newer start. Start again |
| `command must be a single line: ...` | The command carried a line break or a NUL. One command per call, one line per command |
| `args[1] contains a NUL byte, which no argument can carry` | An argv entry carried a NUL, which the C runtime cuts at. It names the index so the offending argument can be found |
| `args must have at most 64 entries`, `args entries must be at most 4096 characters`, `command must be at most 4096 characters` | An argument past its bound. Shorten it, or split the work across calls |

## License

ISC, declared in `package.json`. This tree ships no `LICENSE` file, so the full
terms are stated here only.

# winedbg-mcp

An MCP server for interacting with `winedbg` (the Wine debugger). It wraps the interactive debugger so an LLM can drive it through MCP tools.

## Status

The server is implemented and tested. `src/` holds the MCP entry point, the
winedbg session state machine, the environment parsing, the command-line
parsing and the tool-argument validation; `build/` is the compiled output of
`bun run build`; `tests/` covers all of those, and CI (`.github/workflows/ci.yml`)
runs the typecheck and the suite. The session tests drive `WinedbgSession`
against a stand-in that speaks the same `Wine-dbg>` prompt protocol, so the
suite needs no Wine. No test here has been run against a real `winedbg`: the
debugger is the one thing the fixtures replace, so the suite proves the prompt
protocol and the tool argument handling, not Wine itself. See
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), which is still written against
this README as a specification rather than against the source, and says so.
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
| `src/config.ts` | reading and validating the environment |
| `src/constants.ts` | defaults and limits shared across the above |
| `src/version.ts` | the version string reported to MCP clients |

## Prerequisites

- [Bun](https://bun.sh/), the package manager, build tool and test runner
- [Wine](https://www.winehq.org/), which includes `winedbg`

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

Both are optional and read once at startup. There are no secrets and no config
file: the environment is the only place to set these.

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

A value the server cannot use stops it at startup with the variable named,
rather than failing later as a spawn error or a start timeout. That includes a
variable set to the empty string and a misspelled `WINEDBG_MCP_*` name, which
would otherwise be ignored while the deployment ran on defaults. The startup line
on stderr reports the values in effect:

```
winedbg MCP server running on stdio (WINEDBG_MCP_BINARY=winedbg WINEDBG_MCP_READY_TIMEOUT_MS=10000)
```

## Tools Available

- **`winedbg_start`**: Start or attach to `winedbg`. Use this before running any commands. Optional `args` are passed to `winedbg` unchanged, so anything it accepts works: the program to launch (e.g. `{"args": ["myapp.exe"]}`) or a PID to attach to (`{"args": ["1234"]}`). `args` must be an array of strings; a bare string is rejected rather than split into one argument per character.
- **`winedbg_execute`**: Execute one command in the active `winedbg` session (e.g., `{"command": "bt"}`).
  Takes an optional `timeout` in milliseconds (default 30000, minimum 1, maximum 600000).
- **`winedbg_stop`**: Stop the active `winedbg` session.

### Command framing

`winedbg` has no way to label which output belongs to which command; the only
marker in the stream is the `Wine-dbg>` prompt. Two consequences are visible
through the tools:

- One command per `winedbg_execute` call. A command carrying `\n` or `\r` is
  rejected, because each draws its own prompt and puts every later reply
  one command behind. Vertical tab, form feed, NEL (U+0085) and the Unicode line
  and paragraph separators (U+2028, U+2029) are not rejected and are written to
  the debugger as given, so whether one command stays one line depends on how
  `winedbg`'s own reader splits its input.
- After a command times out, further commands are refused until the debugger
  prints its prompt again. A debugger that has not returned to its prompt is not
  reading commands, and whatever it prints next belongs to the command that timed
  out. If it never comes back (a `cont` into a program that does not stop), call
  `winedbg_stop` and start again.

A single reply is buffered up to 1M UTF-16 code units of decoded text, so a
BMP character costs one unit and an astral one costs two, whatever the target
prints. The child's output is decoded as UTF-8, and a byte sequence that is not
valid UTF-8 becomes U+FFFD rather than being passed through. Past the cap the
oldest output is dropped to keep the last three quarters, and the reply then
opens with `[N characters of earlier output dropped: buffer limit]`, counting
in the same code units. Truncation counts code units, so it can cut between the
two halves of an astral character; a reply cut that way starts with an
unpaired surrogate for that character.

## Usage Example

1. Call `winedbg_start` with `{"args": ["myapp.exe"]}`.
2. Call `winedbg_execute` with `{"command": "break main"}`.
3. Call `winedbg_execute` with `{"command": "run"}`.
4. Call `winedbg_execute` with `{"command": "bt"}` to get a backtrace.
5. Call `winedbg_stop` when finished.

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
| `winedbg-mcp` | Serves JSON-RPC on stdin/stdout | 0 on SIGINT, SIGTERM, or end of stdin |
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

`bun run typecheck` and `bun test` are the gate for this tree.

```bash
bun run typecheck
bun test
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

`tests/validate.test.ts` covers the tool-argument boundary and
`tests/config.test.ts` the environment parsing described above.
`tests/cli.test.ts` spawns the entry point to pin the exit codes and which
stream each message lands on.

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

## License

ISC, declared in `package.json`. This tree ships no `LICENSE` file, so the full
terms are stated here only.

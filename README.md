# winedbg-mcp

An MCP server for interacting with `winedbg` (the Wine debugger). It wraps the interactive debugger, allowing LLMs to control it through MCP tools.

## Prerequisites

- [Bun](https://bun.sh/), the package manager, build tool and test runner here (`packageManager` in `package.json` pins the version CI uses)
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

Example for an MCP client configuration:
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

| Variable | Default | Valid values |
| --- | --- | --- |
| `WINEDBG_MCP_BINARY` | `winedbg` (found on `PATH`) | A non-empty command name or path |
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

This server provides the following tools:

- **`winedbg_start`**: Start `winedbg`. Use this before running any commands. Optional `args` are passed to `winedbg` unchanged, so anything it accepts works, such as the program to launch (e.g. `{"args": ["myapp.exe"]}`).
- **`winedbg_execute`**: Execute one command in the active `winedbg` session (e.g., `{"command": "bt"}`).
  Takes an optional `timeout` in milliseconds (default 30000, maximum 600000).
- **`winedbg_stop`**: Stop the active `winedbg` session.

### Command framing

`winedbg` has no way to label which output belongs to which command; the only
marker in the stream is the `Wine-dbg>` prompt. Two consequences are visible
through the tools:

- One command per `winedbg_execute` call. Multi-line input is rejected, because
  each line would draw its own prompt and put every later reply one command behind.
- After a command times out, further commands are refused until the debugger
  prints its prompt again. A debugger that has not returned to its prompt is not
  reading commands, and whatever it prints next belongs to the command that timed
  out. If it never comes back (a `cont` into a program that does not stop), call
  `winedbg_stop` and start again.

A single reply is buffered up to 1M characters. Past that the oldest output is
dropped and the reply says how much went missing rather than returning a silently
short answer.

## Usage Example

1. Call `winedbg_start` with `{"args": ["my_program.exe"]}`.
2. Call `winedbg_execute` with `{"command": "break main"}`.
3. Call `winedbg_execute` with `{"command": "run"}`.
4. Call `winedbg_execute` with `{"command": "bt"}` to get a backtrace.
5. Call `winedbg_stop` when finished.

## Tests

```bash
bun run typecheck
bun test
```

The suite drives `WinedbgSession` against `tests/fake-winedbg.js`, a stand-in that
speaks the same `Wine-dbg>` prompt protocol, so it runs without Wine installed, and
checks the tool-argument validation in `src/validate.ts` and the environment
parsing in `src/config.ts`.

`tests/fuzz-validate.test.ts` and `tests/fuzz-session-output.test.ts` fuzz the two
untrusted-input surfaces: the tool arguments arriving as JSON, and the debugger's
output arriving as bytes. Both run a fixed seed of generated inputs, so a failure
replays from the same inputs, and both assert contracts rather than exit codes.
Raise `SEED` in either file for a different run.

CI (`.github/workflows/ci.yml`) runs both on every pull request and on every
push to `main`.

## License

ISC

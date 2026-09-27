# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version is declared in `package.json` and reported to MCP clients from the
same string; `tests/version.test.ts` fails the build if the two disagree, or if
the newest section dated below is not the version the package declares. A
release renames `## [Unreleased]` to the version it ships; `CONTRIBUTING.md`
section 4 is the order.

## [Unreleased]

### Added

- `docs/THREAT_MODEL.md` rewritten against the source: the entry-point
  inventory, the trust boundaries and a sixth one for the operator's log, the
  assets, the threats per boundary, the controls that exist, and the claims
  the project's own documentation makes, each checked against a file in this
  tree.
- `WINEDBG_MCP_COMMAND_TIMEOUT_MS` (whole milliseconds, 1 to 600000; default
  `30000`). The wait `winedbg_execute` gives a reply when the call names no
  `timeout` of its own was the built-in constant, so a deployment whose commands
  are slower than 30s could only fix it by passing `timeout` on every call. The
  value is validated at startup like the other variables, reported in the
  startup line, and named in the `timeout` description the model reads, so the
  advertised default is the one a call actually gets.
- Structured logging to stderr: one JSON object per line, with a `time`, a
  `level`, a fixed `message` and flat named fields. Every tool call logs its
  start, its outcome and how long it took under one `callId`, and a session logs
  its spawn, the time to its first prompt, its exit (with the code or signal,
  and at `error` only when nothing asked for the stop) and the commands that
  timed out or overflowed the reply buffer.
- `WINEDBG_MCP_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`).
  An unusable value stops the server at startup with the variable named, like
  the other two.
- `.gitattributes` pinning LF line endings, so a checkout on Windows cannot give
  the test fixture a CRLF shebang that fails to exec.
- A statement of the supported platforms (Linux and macOS) in the README.
  `winedbg_stop` needs POSIX process groups and the README claimed no OS.
- A command line: `-h` and `--help` print the usage on stdout, `--version`
  prints the `package.json` version, and an argument the server has no use for
  is refused with exit code 2 and a pointer to `--help`. The command line is
  resolved before the environment, so both flags work in a deployment whose
  `WINEDBG_MCP_*` value the server would otherwise refuse to start on.
- CI type-checks the test suite (`tsc -p tsconfig.test.json`) as well as `src/`,
  next to the Biome check the gate runs locally.
- A fuzz suite over the tool-argument boundary. A case that fails is replayed
  from the `WINEDBG_MCP_SIM_SEED` it was found under, so a report carries a seed
  rather than a transcript.

### Changed

- Declared dependency floors now match the versions the test suite runs
  against: `@modelcontextprotocol/sdk` `^1.30.0`, `@types/node` `^22.20.1`,
  `typescript` `^5.9.3`. A `bun update` can no longer land on a release the
  project never ran a build or a test against. Resolutions in `bun.lock` are
  unchanged.
- The build clears `build/` before compiling, so a module deleted from `src/`
  can no longer be published from a stale object left by an earlier build.
- `tsc` emits LF line endings on every host, so the artifact bytes no longer
  depend on the platform doing the build.
- CI builds the package and runs `scripts/verify-artifact.sh`, which runs the
  compiled entry point under both `node` and `bun` and rejects source or map
  files in `build/`. The suite alone only ever exercised `src/`.
- Tool arguments are bounded and refused at the boundary instead of reaching
  `winedbg`: at most 64 `args` entries, at most 4096 characters per entry and
  per command, and a command carrying a line break (`\n`, `\r`, vertical tab,
  form feed, U+0085, U+2028, U+2029) or a NUL is rejected with the field named.
- `winedbg_start` waits for a debugger a previous stop signalled to be gone
  before spawning its own, so a client alternating the two no longer leaves a
  detached process group per cycle, and a stop arriving during a start cancels
  that start rather than leaving a debugger nobody is waiting on.
- `tests/version.test.ts` fails when the newest dated changelog section is not
  the version the package declares, and when the released versions are repeated
  or listed oldest first. A version bump with no release section, and a dated
  section with no bump, now fail the gate rather than shipping.

### Notes for users

- A `winedbg_execute` command longer than 4096 characters or carrying a line
  break, and a `winedbg_start` with more than 64 arguments, are error results
  now. 1.0.0 passed them to `winedbg`, where each one drew its own prompt and
  put every later reply a command behind. Shorten the command, or send the
  program path in `args` and the debugger command one line at a time.
- A `winedbg_start` can now be answered with "winedbg stopped before it was
  ready" or "winedbg was not started: a newer winedbg_start call replaced this
  one". Both are error results, and both mean the call did not leave a
  debugger behind.
- The stderr log changed shape: 1.0.0 wrote a `[winedbg-mcp] event detail` line
  per event, and each event is now one JSON object on its own line, at the level
  `WINEDBG_MCP_LOG_LEVEL` sets. A log aggregator reading the old line has to
  read the new one.

### Fixed

- Three README claims the code did not implement: that the audit log strips
  control characters and truncates the text it records, that a command logs the
  size of its reply, and that `src/index.ts` carries four `noConsole`
  suppressions and a `noControlCharactersInRegex` one. Each now says what the
  code does. The threat model recorded all three as false before the README was
  corrected.
- The threat model claimed the tool arguments were unbounded and that nothing was
  logged, both of which the code had implemented since the last pass.
- A reply that split a multi-byte character across two pipe reads decoded as two
  replacement characters. The child's output now goes through a per-stream
  `StringDecoder`, so a character the pipe cut in half is the one character it
  is. The README claimed this already; the code did not do it.
- `bun run check` passes on a clean checkout again. Biome reported 18 findings
  and `tsc` reported two errors, so the gate CI runs failed before a
  contributor changed anything: formatting that had drifted from `biome.json`,
  unsorted imports, `fs` imported without the `node:` protocol, an assignment
  in a `while` condition in the test double, and two reads of
  `WINEDBG_MCP_SIM_SEED` that `noPropertyAccessFromIndexSignature` rejects.
- `bun run format` now runs `biome check --write` rather than
  `biome format --write`, so it applies the safe rule fixes (import order, and
  the rest) instead of leaving a contributor with a tree that still fails
  `bun run lint` after formatting.
- `bun publish` runs the build first. `build/` is gitignored but is the whole
  published tarball, so a publish from a clean checkout shipped nothing, and a
  publish from a dirty one shipped whatever `build/` happened to contain.
- The command-line tests inherit a test deadline above their own spawn
  timeout. On a loaded machine a child that had not finished starting was
  abandoned and reported as exit code 143 rather than as the hang it was.
- A spawn or pipe failure inside a tool call reached the client as the bare
  spawn error. The tool now answers with what failed and the path or command
  involved.
- The server signalled the debugger on exit and left immediately, so a debugger
  stopped inside a trap handler, and the program under debug, were still
  running after the server had said goodbye. Shutdown waits for them, within
  the 4s bound the exit code already promised.
- A debugger pipe that broke mid-session took the server down with it. The
  session settles instead, and the server keeps answering later calls.
- A reply cut between the two halves of a surrogate pair produced a broken
  pair, and a cut that a decode boundary moved landed mid-character. The cut
  now falls on a whole character, and an unkillable child is dropped rather
  than left to hold the session open.
- The debugger's pipes are released once the kill escalation has killed it, so
  a stop no longer leaves a session holding descriptors to a dead child.
- CI actions are pinned to a commit and the workflow token is scoped to
  `contents: read`, so a moved tag or a wider token is a diff rather than a
  surprise.
- `src/index.ts` was the one source file no test reached: the suite spawned the
  entry point only for `--help`, `--version` and the startup errors, so the
  stdio transport, the tool list on the wire, the per-call audit log and the
  exit on a client hangup were untested. `tests/server.test.ts` spawns the server
  and speaks JSON-RPC to it over its own stdio, asserting the handshake, a
  start/execute/stop round trip, both kinds of refused call, the `callId` the log
  ties to each outcome, and exit 0 when the client's stdin ends.
- `tests/concurrency.test.ts` resolved the debugger fixture through
  `URL.pathname`, which percent-encodes a path and adds a leading slash on
  Windows, so the file failed to spawn from a checkout whose directory has a
  space or a non-ASCII character in it. The other two files that spawn it
  already went through `fileURLToPath`.
- The start-timeout test asserted only that the wait was shorter than the
  default, which a timeout firing immediately also satisfies. It now pins both
  ends: at least the configured wait, and less than the default.

## [1.0.0] - 2026-09-27

First release. There is no earlier version to upgrade from.

### Added

- `winedbg_start`, `winedbg_execute` and `winedbg_stop` MCP tools over stdio.
  `winedbg_start` passes its optional `args` to `winedbg` unchanged, which
  covers both launching a program and attaching to a PID.
- `WINEDBG_MCP_BINARY` and `WINEDBG_MCP_READY_TIMEOUT_MS` as the deployment
  configuration. Both are optional and read once at startup. An unusable value,
  including a misspelled `WINEDBG_MCP_*` name, stops the server at startup with
  the variable named rather than running on defaults a deployment thinks it
  overrode.
- `winedbg_execute` accepts an optional `timeout` in milliseconds, default
  30000, maximum 600000.

### Notes for users

- One command per `winedbg_execute` call. A command carrying a line break is
  rejected as of the next release, because each line draws its own prompt and
  puts every later reply one command behind. 1.0.0 passed such a command to
  `winedbg`; see the Unreleased notes for the bounds that go with it.
- After a command times out, further commands are refused until the debugger
  prints its prompt again. Call `winedbg_stop` and start again if it never does.
- A single reply is buffered up to 1M code points. Past the cap the oldest
  output is dropped and the reply reports how many code points went missing.

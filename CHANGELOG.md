# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version is declared in `package.json` and reported to MCP clients from the
same string; `tests/version.test.ts` fails the build if the two disagree.

## [Unreleased]

### Added

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

### Fixed

- A reply that split a multi-byte character across two pipe reads decoded as two
  replacement characters. The child's output now goes through a per-stream
  `StringDecoder`, so a character the pipe cut in half is the one character it
  is. The README claimed this already; the code did not do it.
- `bun publish` runs the build first. `build/` is gitignored but is the whole
  published tarball, so a publish from a clean checkout shipped nothing, and a
  publish from a dirty one shipped whatever `build/` happened to contain.
- The command-line tests inherit a test deadline above their own spawn
  timeout. On a loaded machine a child that had not finished starting was
  abandoned and reported as exit code 143 rather than as the hang it was.

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

- One command per `winedbg_execute` call. A command carrying a line terminator
  is rejected, because each line draws its own prompt and puts every later reply
  one command behind.
- After a command times out, further commands are refused until the debugger
  prints its prompt again. Call `winedbg_stop` and start again if it never does.
- A single reply is buffered up to 1M code points. Past the cap the oldest
  output is dropped and the reply reports how many code points went missing.

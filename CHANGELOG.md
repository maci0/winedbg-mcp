# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version is declared in `package.json` and reported to MCP clients from the
same string; `tests/version.test.ts` fails the build if the two disagree.

## [Unreleased]

### Changed

- Declared dependency floors now match the versions the test suite runs
  against: `@modelcontextprotocol/sdk` `^1.30.0`, `@types/node` `^22.20.1`,
  `typescript` `^5.9.3`. A `bun update` can no longer land on a release the
  project never ran a build or a test against. Resolutions in `bun.lock` are
  unchanged.

### Fixed

- `bun publish` runs the build first. `build/` is gitignored but is the whole
  published tarball, so a publish from a clean checkout shipped nothing, and a
  publish from a dirty one shipped whatever `build/` happened to contain.

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

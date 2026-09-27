# Contributing

The README is the reference: [Prerequisites](README.md#prerequisites) and
[Installation](README.md#installation) for the setup,
[Tests](README.md#tests) for the gate, and
[Source layout](README.md#status) for where a change belongs. This file is the
order to do it in.

## 1. Set up

```bash
bun install          # declared dependencies, nothing global
bun run check        # the gate; it passes on a fresh checkout
```

Bun is the only tool needed for the gate. Wine is a prerequisite for driving a
real debugger, not for building or testing: the suite runs against
`tests/fake-winedbg.js`. Node.js 18 or higher is needed only to run the built
`build/index.js` with `node` instead of `bun`, and for
`scripts/verify-artifact.sh`, which runs the artifact under both hosts and is
the one step of CI that needs it.

## 2. While you edit

`bun run format` applies Biome's formatting and its safe rule fixes, and
`bun test tests/<file>.ts` runs one file (`bun test -t "<name>"` runs one test).
`bun run check` is the whole gate and is what CI runs on every push and pull
request, so a green local run is a green remote run.

## 3. Before you open the pull request

- `bun run check` passes.
- `CHANGELOG.md` has an `Unreleased` entry saying what changed, in the
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape the file
  already uses. `package.json` carries the version; bump it only for a release,
  and remember `tests/version.test.ts` pins it against the string the server
  reports and against the newest released section of the changelog.
- `build/` is gitignored and generated. Never commit it; `bun run build`
  regenerates it.

## 4. Releasing

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Nothing in the history said so, so this is where it is written down.

What a consumer depends on, and what therefore decides the bump:

- The three tool names, their argument names, and the descriptions the model
  reads.
- What the tools accept. A call the previous release took and this one refuses
  is a breaking change whatever the reason: the bounds on `args` and `command`
  are in that class, and so is a bound that becomes stricter.
- The `WINEDBG_MCP_*` variable names, their defaults, and the fact that an
  unusable value stops the server at startup.
- The stderr log line an operator or an aggregator parses.
- The command line: `--help`, `--version`, and the exit codes.
- The reply buffer cap and the timeout defaults, where a change to either shows
  up in the text a caller reads.

So: major for a removal, a rename, or a new refusal on a call that used to
succeed; minor for a tool, an argument, a variable, or a log field added
without changing what an existing call does; patch for a fix that leaves every
one of the above as it was. A reply that decoded wrongly is a patch, not a
major, however visible the bug was.

A release is three edits in one commit, and `tests/version.test.ts` fails until
all three are there:

1. Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` in `CHANGELOG.md`,
   carrying the date of the release.
2. Set the same `x.y.z` in `package.json`.
3. Set the same string in `src/version.ts`, which is what the server reports to
   a client.

Tag the commit `x.y.z` and publish. The tag, the manifest, and the changelog
are three places that can disagree, and the test above holds only two of them,
so the tag follows the manifest. A published version is never republished or
retagged: a fix that is wrong in a release goes out as the next one.

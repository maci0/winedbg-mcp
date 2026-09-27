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
`tests/fake-winedbg.js`. Node.js 18 or higher is only needed to run the built
`build/index.js` with `node` instead of `bun`.

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
  reports.
- `build/` is gitignored and generated. Never commit it; `bun run build`
  regenerates it.

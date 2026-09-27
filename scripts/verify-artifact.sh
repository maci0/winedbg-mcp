#!/usr/bin/env bash
# Asserts the build produces the artifact the package ships, not just something
# that compiles. The test suite runs from src/, so nothing else exercises the
# compiled layout: the shebang, the executable bit, the build/ -> package.json
# relative path, and what lands in the published `files` list.
#
# Usage: scripts/verify-artifact.sh   (expects `bun run build` to have run)

set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
	printf 'verify-artifact: %s\n' "$1" >&2
	exit 1
}

[ -f build/index.js ] || fail "build/index.js is missing; run 'bun run build' first"
[ -x build/index.js ] || fail "build/index.js is not executable; the bin entry would fail to launch"

# The artifact is published as a bin that a client may launch under either
# host, so this checks node too, which makes node a prerequisite here that
# `bun run check` does not need. Name it rather than letting the first
# `node -e` fail as a bare "command not found" with no script named.
command -v node >/dev/null ||
	fail "node is not on PATH; it is only needed for this check, which runs the artifact under both bun and node"

# Source and map files belong to the repository, not to the artifact.
leftover=$(find build -type f \( -name '*.ts' -o -name '*.map' \) -print)
[ -z "$leftover" ] || fail "build/ carries non-artifact files: $leftover"

version=$(node -e 'process.stdout.write(require("./package.json").version)')
reported=$(node build/index.js --version)
[ "$reported" = "$version" ] ||
	fail "--version reported '$reported' under node, expected '$version'"

# The bin runs under bun as readily as under node, so both hosts are checked.
reported=$(bun build/index.js --version)
[ "$reported" = "$version" ] ||
	fail "--version reported '$reported' under bun, expected '$version'"

node build/index.js --help >/dev/null || fail "--help failed under node"

printf 'verify-artifact: build/index.js runs under node %s and bun %s\n' \
	"$(node --version)" "$(bun --version)"

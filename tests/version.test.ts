// The version lives in two files on purpose: package.json is what a registry
// and an installer read, src/version.ts is what the server reports to a client
// at runtime. The changelog is the third copy, since a release is a section
// there and a section that names a version the package does not declare is a
// release note for a package nobody can install. Nothing keeps the three equal
// at build time, so this pins them. The format check is a publish-time guard: a
// pre-release or a placeholder belongs in package.json only when the package is
// not meant to be released.

import { describe, expect, test } from "bun:test";
import { SERVER_VERSION } from "../src/version.js";

const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
const changelog = await Bun.file(new URL("../CHANGELOG.md", import.meta.url)).text();

// Every released section, in the order the file lists them, each with the date
// the release carries. An Unreleased section has no version and no date, so it
// never matches.
const RELEASED_SECTION = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm;
const releasedVersions = [...changelog.matchAll(RELEASED_SECTION)].map((match) => match[1] ?? "");

function rank(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

describe("version", () => {
  test("is the version the manifest declares", async () => {
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  test("is a release version, not a pre-release or a build placeholder", () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the newest released changelog section is the version the package declares", () => {
    // A bump without a section leaves the release undocumented, and a section
    // without a bump documents a version that was never published. Either way
    // a consumer reading the two is told a different thing happened.
    expect(releasedVersions[0]).toBe(manifest.version);
  });

  test("every released version is distinct and listed newest first", () => {
    expect(new Set(releasedVersions).size).toBe(releasedVersions.length);
    const ranks = releasedVersions.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});

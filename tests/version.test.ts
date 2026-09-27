// The version lives in two files on purpose: package.json is what a registry
// and an installer read, src/version.ts is what the server reports to a client
// at runtime. Nothing keeps them equal at build time, so this pins them.

import { describe, expect, test } from "bun:test";
import { SERVER_VERSION } from "../src/version.js";

const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();

describe("version", () => {
  test("the server reports the version the package declares", () => {
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  test("is a release version, not a pre-release or a build placeholder", () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
